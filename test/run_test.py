"""Kiểm thử gói SCORM sinh ra bằng LMS giả lập + Chromium headless.

Kịch bản (cho cả SCORM 1.2 và 2004):
  1. Mở mới → chọn sai (True) → Check  → điểm 0, failed
  2. Retry → chọn đúng (False) → Check → điểm 100, passed
  3. Đóng SCO → session_time, exit, finish
  4. Lần mở mới khác: chọn đáp án nhưng chưa Check → đóng → exit=suspend + suspend_data
  5. Mở lại với entry=resume → đáp án đã chọn được khôi phục
"""
import json, os, shutil, subprocess, sys, time, zipfile, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
WWW = os.path.join(HERE, 'www')
OUT = os.path.join(HERE, '..', 'out')
PORT = 8765

def prepare():
    shutil.rmtree(WWW, ignore_errors=True)
    os.makedirs(WWW)
    shutil.copy(os.path.join(HERE, 'mock-lms.html'), WWW)
    for z in os.listdir(OUT):
        v = '12' if z.endswith('_scorm12.zip') else '2004'
        zipfile.ZipFile(os.path.join(OUT, z)).extractall(os.path.join(WWW, 'pkg' + v))

def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    handler = functools.partial(Quiet, directory=WWW)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

def h5p_frame(page, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        for f in page.frames:
            try:
                if f.query_selector('.h5p-true-false-answer'):
                    return f
            except Exception:
                pass
        time.sleep(0.2)
    raise RuntimeError('Không thấy nội dung H5P được render')

def click_answer(f, text):
    f.locator('.h5p-true-false-answer', has_text=text).first.click()

def launch(ctx, v, store):
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type == 'error' else None)
    page.add_init_script(f'window.__STORE = {json.dumps(store)};')
    page.goto(f'http://127.0.0.1:{PORT}/mock-lms.html?v={v}&pkg=pkg{v}')
    return page, errors

def close_sco(page):
    page.evaluate('unloadSco()')
    page.wait_for_function('getLmsState() === "done"', timeout=5000)
    return page.evaluate('getStore()')

def check(cond, msg, results):
    results.append((bool(cond), msg))
    print(('  ✓ ' if cond else '  ✗ ') + msg)

def run_version(pw, v):
    print(f'\n=== SCORM {"1.2" if v == "12" else "2004"} ===')
    R = []
    browser = pw.chromium.launch()
    ctx = browser.new_context()
    K = {
        '12': dict(status='cmi.core.lesson_status', raw='cmi.core.score.raw', session='cmi.core.session_time',
                   exit='cmi.core.exit', entry='cmi.core.entry'),
        '2004': dict(completion='cmi.completion_status', success='cmi.success_status', raw='cmi.score.raw',
                     scaled='cmi.score.scaled', session='cmi.session_time', exit='cmi.exit', entry='cmi.entry'),
    }[v]

    # --- Lần 1: sai rồi đúng
    store = {'cmi.student_data.mastery_score': '80'} if v == '12' else {'cmi.scaled_passing_score': '0.8'}
    page, errors = launch(ctx, v, store)
    f = h5p_frame(page)
    s = page.evaluate('getStore()')
    if v == '12': check(s.get(K['status']) == 'incomplete', 'Khi mở: lesson_status = incomplete', R)
    else: check(s.get(K['completion']) == 'incomplete', 'Khi mở: completion_status = incomplete', R)

    click_answer(f, 'True')
    f.locator('.h5p-question-check-answer').click()
    page.wait_for_timeout(800)
    s = page.evaluate('getStore()')
    check(s.get(K['raw']) == '0', f'Trả lời sai: điểm = {s.get(K["raw"])}', R)
    if v == '12': check(s.get(K['status']) == 'failed', f'Trả lời sai: status = {s.get(K["status"])}', R)
    else: check(s.get(K['success']) == 'failed' and s.get(K['completion']) == 'completed',
                f'Trả lời sai: completion={s.get(K["completion"])}, success={s.get(K["success"])}', R)

    f.locator('.h5p-question-try-again').click()
    page.wait_for_timeout(300)
    click_answer(f, 'False')
    f.locator('.h5p-question-check-answer').click()
    page.wait_for_timeout(800)
    s = page.evaluate('getStore()')
    check(s.get(K['raw']) == '100', f'Làm lại đúng: điểm = {s.get(K["raw"])}', R)
    if v == '12': check(s.get(K['status']) == 'passed', f'Làm lại đúng: status = {s.get(K["status"])}', R)
    else: check(s.get(K['success']) == 'passed' and s.get(K['scaled']) == '1',
                f'Làm lại đúng: success={s.get(K["success"])}, scaled={s.get(K["scaled"])}', R)

    # Câu đúng tuyệt đối thì H5P ẩn nút Retry → giả lập một lần làm điểm thấp hơn
    # để kiểm tra chính sách "best" giữ điểm cao nhất
    page.frame_locator('#sco').locator('body').evaluate("""() => H5P2SCORM._onXAPI({data:{statement:{
        verb:{id:'http://adlnet.gov/expapi/verbs/answered'}, result:{score:{raw:0,max:1}}}}})""")
    page.wait_for_timeout(200)
    s = page.evaluate('getStore()')
    check(s.get(K['raw']) == '100', 'Làm lại sai lần 3: vẫn giữ điểm cao nhất 100', R)

    s = close_sco(page)
    check(bool(s.get(K['session'])), f'Đóng: session_time = {s.get(K["session"])}', R)
    check(s.get(K['exit']) == ('' if v == '12' else 'normal'), f'Đóng: exit = "{s.get(K["exit"])}"', R)
    calls = page.evaluate('lmsCalls.map(c => c[0])')
    check(calls.count('init') == 1 and calls.count('finish') == 1, 'Initialize/Finish đúng 1 lần', R)
    check(not errors, 'Không có lỗi JavaScript' + ('' if not errors else f': {errors[:3]}'), R)
    page.close()

    # --- Lần 2: lưu tiến độ & khôi phục
    page, errors = launch(ctx, v, {})
    f = h5p_frame(page)
    click_answer(f, 'False')
    page.wait_for_timeout(300)
    s = close_sco(page)
    sd = s.get('cmi.suspend_data')
    check(s.get(K['exit']) == 'suspend', f'Chưa làm xong: exit = {s.get(K["exit"])}', R)
    check(bool(sd), f'suspend_data đã lưu: {sd}', R)
    page.close()

    s[K['entry']] = 'resume'
    page, errors = launch(ctx, v, s)
    f = h5p_frame(page)
    page.wait_for_timeout(500)
    sel = f.evaluate("""() => [...document.querySelectorAll('.h5p-true-false-answer')]
                          .filter(e => e.getAttribute('aria-checked') === 'true' || e.classList.contains('selected'))
                          .map(e => e.textContent.trim())""")
    check(sel == ['False'], f'Mở lại: đáp án được khôi phục = {sel}', R)
    check(not errors, 'Không có lỗi JavaScript' + ('' if not errors else f': {errors[:3]}'), R)
    page.close()
    browser.close()
    return R

if __name__ == '__main__':
    prepare()
    httpd = serve()
    allr = []
    with sync_playwright() as pw:
        for v in ['12', '2004']:
            allr += run_version(pw, v)
    httpd.shutdown()
    bad = [m for ok, m in allr if not ok]
    print(f'\nKết quả: {len(allr) - len(bad)}/{len(allr)} kiểm tra đạt')
    sys.exit(1 if bad else 0)
