#!/usr/bin/env node
/**
 * h5p2scorm – đóng gói file .h5p thành gói SCORM 1.2 và/hoặc SCORM 2004 (4th Edition).
 *
 *   node h5p2scorm.js <file.h5p | thư mục> [...] [tuỳ chọn]
 *
 * Chạy `node h5p2scorm.js --help` để xem đầy đủ tuỳ chọn.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const ROOT = __dirname;
const RUNTIME = path.join(ROOT, 'runtime');
const PLAYER_DIST = path.dirname(require.resolve('h5p-standalone/dist/main.bundle.js'));

/* ------------------------------------------------------------------ */
/* Tham số dòng lệnh                                                   */
/* ------------------------------------------------------------------ */
const HELP = `
h5p2scorm – chuyển H5P sang SCORM 1.2 / SCORM 2004

Cách dùng:
  node h5p2scorm.js <file.h5p | thư mục> [...] [tuỳ chọn]

Tuỳ chọn:
  -o, --out <thư mục>       Thư mục xuất (mặc định: ./scorm-out)
  -s, --scorm <phiên bản>   1.2 | 2004 | both (mặc định: both)
  -m, --mastery <0-100>     Ngưỡng đạt (%). Có ngưỡng → báo passed/failed;
                            không có → chỉ báo completed kèm điểm
      --complete-on-open    Đánh dấu hoàn thành ngay khi mở (nội dung không chấm điểm:
                            Accordion, Course Presentation chỉ đọc, video…)
      --score last          Ghi điểm lần làm cuối (mặc định: giữ điểm cao nhất)
      --no-resume           Không lưu/khôi phục tiến độ làm bài
      --max-width <css>     Độ rộng tối đa của khung nội dung (mặc định: 1100px)
      --title <tiêu đề>     Ghi đè tiêu đề (chỉ dùng khi chuyển 1 file)
      --debug               Ghi log chi tiết ra console trình duyệt
  -h, --help                Hiển thị hướng dẫn

Ví dụ:
  node h5p2scorm.js bai-giang/ -o goi-scorm -m 80
  node h5p2scorm.js quiz.h5p --scorm 1.2
`;

function parseArgs(argv) {
  const opt = {
    inputs: [], out: 'scorm-out', scorm: 'both', mastery: null, completeOnOpen: false,
    scorePolicy: 'best', resume: true, maxWidth: '1100px', title: null, debug: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`Thiếu giá trị cho ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      case '-o': case '--out': opt.out = next(); break;
      case '-s': case '--scorm': opt.scorm = next(); break;
      case '-m': case '--mastery': opt.mastery = Number(next()); break;
      case '--complete-on-open': opt.completeOnOpen = true; break;
      case '--score': opt.scorePolicy = next(); break;
      case '--no-resume': opt.resume = false; break;
      case '--max-width': opt.maxWidth = next(); break;
      case '--title': opt.title = next(); break;
      case '--debug': opt.debug = true; break;
      default:
        if (a.startsWith('-')) fail(`Tuỳ chọn không hợp lệ: ${a}`);
        opt.inputs.push(a);
    }
  }
  if (!opt.inputs.length) { console.log(HELP); process.exit(1); }
  if (!['1.2', '12', '2004', 'both'].includes(opt.scorm)) fail('--scorm phải là 1.2, 2004 hoặc both');
  if (opt.scorm === '12') opt.scorm = '1.2';
  if (opt.mastery !== null && !(opt.mastery >= 0 && opt.mastery <= 100)) fail('--mastery phải trong khoảng 0–100');
  if (!['best', 'last'].includes(opt.scorePolicy)) fail('--score phải là best hoặc last');
  if (!/^[0-9.]+(px|%|rem|em|vw)$|^none$/.test(opt.maxWidth)) fail('--max-width không hợp lệ (vd: 1100px, 100%, none)');
  return opt;
}

function fail(msg) { console.error('Lỗi: ' + msg); process.exit(1); }

/* ------------------------------------------------------------------ */
/* Tiện ích                                                            */
/* ------------------------------------------------------------------ */
function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .toLowerCase().slice(0, 60) || 'h5p';
}

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function collectInputs(inputs) {
  const files = [];
  for (const inp of inputs) {
    if (!fs.existsSync(inp)) { console.warn(`! Không tìm thấy: ${inp}`); continue; }
    if (fs.statSync(inp).isDirectory()) {
      for (const f of walk(inp)) if (f.toLowerCase().endsWith('.h5p')) files.push(path.join(inp, f));
    } else files.push(inp);
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* Đọc & kiểm tra gói H5P                                              */
/* ------------------------------------------------------------------ */
function extractH5P(file, dest) {
  let zip;
  try { zip = new AdmZip(file); } catch (e) { throw new Error('không phải file zip/H5P hợp lệ'); }
  const destAbs = path.resolve(dest);
  for (const entry of zip.getEntries()) {
    const target = path.resolve(destAbs, entry.entryName);
    if (target !== destAbs && !target.startsWith(destAbs + path.sep)) {
      throw new Error(`đường dẫn không an toàn trong gói: ${entry.entryName}`);
    }
    if (entry.isDirectory) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
  const h5pJson = path.join(dest, 'h5p.json');
  if (!fs.existsSync(h5pJson)) throw new Error('thiếu h5p.json – có thể không phải file .h5p');
  if (!fs.existsSync(path.join(dest, 'content', 'content.json'))) throw new Error('thiếu content/content.json');
  return JSON.parse(fs.readFileSync(h5pJson, 'utf8'));
}

/** Tìm các thư viện bị thiếu (thường gặp khi tải từ h5p.org). */
function missingLibraries(dir, meta) {
  const missing = new Set(), seen = new Set();
  const folderFor = (d) => {
    const cands = [`${d.machineName}-${d.majorVersion}.${d.minorVersion}`, d.machineName];
    return cands.find((c) => fs.existsSync(path.join(dir, c, 'library.json')));
  };
  const visit = (deps) => {
    for (const d of deps || []) {
      const key = `${d.machineName}-${d.majorVersion}.${d.minorVersion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const folder = folderFor(d);
      if (!folder) { missing.add(key); continue; }
      const lib = JSON.parse(fs.readFileSync(path.join(dir, folder, 'library.json'), 'utf8'));
      visit(lib.preloadedDependencies);
    }
  };
  visit(meta.preloadedDependencies);
  return [...missing];
}

/* ------------------------------------------------------------------ */
/* imsmanifest.xml                                                     */
/* ------------------------------------------------------------------ */
function fileList(files, indent) {
  return files.map((f) => `${indent}<file href="${xml(encodeURI(f))}"/>`).join('\n');
}

function manifest12({ id, title, files, mastery }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${id}" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG-${id}">
    <organization identifier="ORG-${id}">
      <title>${xml(title)}</title>
      <item identifier="ITEM-${id}" identifierref="RES-${id}" isvisible="true">
        <title>${xml(title)}</title>${mastery != null ? `
        <adlcp:masteryscore>${Math.round(mastery)}</adlcp:masteryscore>` : ''}
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-${id}" type="webcontent" adlcp:scormtype="sco" href="index.html">
${fileList(files, '      ')}
    </resource>
  </resources>
</manifest>
`;
}

function manifest2004({ id, title, files, mastery }) {
  const seq = mastery != null ? `
        <imsss:sequencing>
          <imsss:objectives>
            <imsss:primaryObjective objectiveID="PRIMARYOBJ" satisfiedByMeasure="true">
              <imsss:minNormalizedMeasure>${(mastery / 100).toFixed(4)}</imsss:minNormalizedMeasure>
            </imsss:primaryObjective>
          </imsss:objectives>
        </imsss:sequencing>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${id}" version="1"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"
  xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3"
  xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3"
  xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd http://www.adlnet.org/xsd/adlnav_v1p3 adlnav_v1p3.xsd http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
  </metadata>
  <organizations default="ORG-${id}">
    <organization identifier="ORG-${id}">
      <title>${xml(title)}</title>
      <item identifier="ITEM-${id}" identifierref="RES-${id}">
        <title>${xml(title)}</title>${seq}
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-${id}" type="webcontent" adlcp:scormType="sco" href="index.html">
${fileList(files, '      ')}
    </resource>
  </resources>
</manifest>
`;
}

/* ------------------------------------------------------------------ */
/* Đóng gói                                                            */
/* ------------------------------------------------------------------ */
function buildPackage({ srcDir, meta, version, opt, outFile, id, title }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'h5p2scorm-pkg-'));
  try {
    copyDir(srcDir, path.join(stage, 'h5p'));
    for (const f of ['main.bundle.js', 'frame.bundle.js']) {
      fs.mkdirSync(path.join(stage, 'player'), { recursive: true });
      fs.copyFileSync(path.join(PLAYER_DIST, f), path.join(stage, 'player', f));
    }
    for (const d of ['styles', 'fonts', 'images']) {
      if (fs.existsSync(path.join(PLAYER_DIST, d))) copyDir(path.join(PLAYER_DIST, d), path.join(stage, 'player', d));
    }
    fs.copyFileSync(path.join(RUNTIME, 'scorm-bridge.js'), path.join(stage, 'scorm-bridge.js'));

    const config = {
      version, mastery: opt.mastery, completeOnOpen: opt.completeOnOpen,
      scorePolicy: opt.scorePolicy, resume: opt.resume, debug: opt.debug,
      objectIRI: `urn:h5p2scorm:${id}`, mainLibrary: meta.mainLibrary
    };
    fs.writeFileSync(path.join(stage, 'config.js'),
      `window.H5P2SCORM_CONFIG = ${JSON.stringify(config, null, 2)};\n`);

    const lang = /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(meta.language || '') && meta.language !== 'und' ? meta.language : 'vi';
    const html = fs.readFileSync(path.join(RUNTIME, 'index.html'), 'utf8')
      .replace(/{{TITLE}}/g, xml(title)).replace(/{{LANG}}/g, lang)
      .replace(/{{MAX_WIDTH}}/g, opt.maxWidth);
    fs.writeFileSync(path.join(stage, 'index.html'), html);

    const files = walk(stage).sort();
    const man = version === '1.2'
      ? manifest12({ id, title, files, mastery: opt.mastery })
      : manifest2004({ id, title, files, mastery: opt.mastery });
    fs.writeFileSync(path.join(stage, 'imsmanifest.xml'), man);

    const zip = new AdmZip();
    zip.addLocalFolder(stage);
    zip.writeZip(outFile);
    return files.length + 1;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function convert(file, opt) {
  const base = path.basename(file).replace(/\.h5p$/i, '');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'h5p2scorm-src-'));
  try {
    const meta = extractH5P(file, work);
    const title = opt.title || meta.title || base;
    const hash = crypto.createHash('md5').update(path.resolve(file)).digest('hex').slice(0, 8);
    const id = `h5p-${slug(base)}-${hash}`;

    const missing = missingLibraries(work, meta);
    if (missing.length) {
      console.warn(`  ! Thiếu thư viện: ${missing.join(', ')}`);
      console.warn('    Hãy mở file bằng Lumi/Moodle rồi xuất lại (file tải từ h5p.org thường không kèm đủ thư viện).');
    }

    const versions = opt.scorm === 'both' ? ['1.2', '2004'] : [opt.scorm];
    const outputs = [];
    for (const v of versions) {
      const outFile = path.join(opt.out, `${base}_scorm${v === '1.2' ? '12' : '2004'}.zip`);
      buildPackage({ srcDir: work, meta, version: v, opt, outFile, id, title });
      outputs.push(outFile);
    }
    return { title, mainLibrary: meta.mainLibrary, outputs, missing };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
function main() {
  const opt = parseArgs(process.argv.slice(2));
  const files = collectInputs(opt.inputs);
  if (!files.length) fail('Không có file .h5p nào để chuyển.');
  if (opt.title && files.length > 1) fail('--title chỉ dùng khi chuyển 1 file.');
  fs.mkdirSync(opt.out, { recursive: true });

  console.log(`Chuyển ${files.length} file sang SCORM ${opt.scorm === 'both' ? '1.2 + 2004' : opt.scorm}…\n`);
  let ok = 0, warn = 0, bad = 0;
  for (const f of files) {
    process.stdout.write(`• ${path.basename(f)}\n`);
    try {
      const r = convert(f, opt);
      console.log(`  ${r.title}  [${r.mainLibrary}]`);
      for (const o of r.outputs) console.log(`  → ${o}  (${(fs.statSync(o).size / 1048576).toFixed(2)} MB)`);
      if (r.missing.length) warn++; else ok++;
    } catch (e) {
      console.error(`  ✗ Lỗi: ${e.message}`);
      bad++;
    }
  }
  console.log(`\nXong: ${ok} thành công, ${warn} có cảnh báo, ${bad} lỗi. Thư mục xuất: ${path.resolve(opt.out)}`);
  if (bad) process.exitCode = 1;
}

main();
