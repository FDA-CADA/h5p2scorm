/*!
 * h5p2scorm – cầu nối H5P (xAPI) → SCORM 1.2 / SCORM 2004
 * Tìm API của LMS, ghi điểm, trạng thái hoàn thành, thời gian học
 * và lưu/khôi phục tiến độ (suspend_data).
 */
(function (global) {
  'use strict';

  var CFG = global.H5P2SCORM_CONFIG || {};
  var LOG = function () {
    if (CFG.debug && global.console) console.log.apply(console, ['[h5p2scorm]'].concat([].slice.call(arguments)));
  };

  /* ---------- Tìm API của LMS ---------- */
  function scan(win, name) {
    var tries = 0;
    while (win && tries < 500) {
      try { if (win[name]) return win[name]; } catch (e) { /* khác origin */ }
      var parent;
      try { parent = win.parent; } catch (e) { parent = null; }
      if (!parent || parent === win) break;
      win = parent;
      tries++;
    }
    return null;
  }
  function locate(name) {
    var api = scan(global, name);
    if (!api) { try { if (global.opener) api = scan(global.opener, name); } catch (e) {} }
    if (!api) { try { if (global.top && global.top.opener) api = scan(global.top.opener, name); } catch (e) {} }
    return api;
  }

  /* ---------- Adapter cho từng phiên bản ---------- */
  function adapter12(api) {
    return {
      version: '1.2',
      init: function () { return String(api.LMSInitialize('')) === 'true'; },
      get: function (k) { return api.LMSGetValue(k); },
      set: function (k, v) { return String(api.LMSSetValue(k, String(v))) === 'true'; },
      commit: function () { return api.LMSCommit(''); },
      finish: function () { return api.LMSFinish(''); },
      lastError: function () { return api.LMSGetLastError(); },
      K: {
        status: 'cmi.core.lesson_status', entry: 'cmi.core.entry', exit: 'cmi.core.exit',
        raw: 'cmi.core.score.raw', min: 'cmi.core.score.min', max: 'cmi.core.score.max',
        session: 'cmi.core.session_time', suspend: 'cmi.suspend_data',
        name: 'cmi.core.student_name', mastery: 'cmi.student_data.mastery_score'
      },
      suspendLimit: 4096
    };
  }
  function adapter2004(api) {
    return {
      version: '2004',
      init: function () { return String(api.Initialize('')) === 'true'; },
      get: function (k) { return api.GetValue(k); },
      set: function (k, v) { return String(api.SetValue(k, String(v))) === 'true'; },
      commit: function () { return api.Commit(''); },
      finish: function () { return api.Terminate(''); },
      lastError: function () { return api.GetLastError(); },
      K: {
        completion: 'cmi.completion_status', success: 'cmi.success_status',
        entry: 'cmi.entry', exit: 'cmi.exit',
        raw: 'cmi.score.raw', min: 'cmi.score.min', max: 'cmi.score.max', scaled: 'cmi.score.scaled',
        session: 'cmi.session_time', suspend: 'cmi.suspend_data',
        name: 'cmi.learner_name', mastery: 'cmi.scaled_passing_score'
      },
      suspendLimit: 64000
    };
  }

  function connect() {
    var order = CFG.version === '1.2' ? ['1.2', '2004'] : ['2004', '1.2'];
    for (var i = 0; i < order.length; i++) {
      if (order[i] === '1.2') { var a = locate('API'); if (a) return adapter12(a); }
      else { var b = locate('API_1484_11'); if (b) return adapter2004(b); }
    }
    return null;
  }

  /* ---------- Định dạng thời gian ---------- */
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function time12(ms) {
    var cs = Math.round(ms / 10), h = Math.floor(cs / 360000); cs -= h * 360000;
    var m = Math.floor(cs / 6000); cs -= m * 6000;
    var s = Math.floor(cs / 100); cs -= s * 100;
    return pad(Math.min(h, 9999), 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + '.' + pad(cs, 2);
  }
  function time2004(ms) {
    var total = Math.round(ms / 10) / 100, h = Math.floor(total / 3600); total -= h * 3600;
    var m = Math.floor(total / 60), s = Math.round((total - m * 60) * 100) / 100;
    return 'PT' + h + 'H' + m + 'M' + s + 'S';
  }

  /* ---------- Trạng thái phiên ---------- */
  var lms = null, started = 0, finished = false, completed = false;
  var best = null; // {raw, max}
  var stateGetter = null;

  function commit() { try { lms.commit(); } catch (e) {} }

  function masteryPercent() {
    var v = null;
    try {
      var raw = lms.get(lms.K.mastery);
      if (raw !== '' && raw != null && !isNaN(parseFloat(raw))) {
        v = parseFloat(raw);
        if (lms.version === '2004') v = v * 100;
      }
    } catch (e) {}
    if (v == null && typeof CFG.mastery === 'number') v = CFG.mastery;
    return v;
  }

  function markCompleted() {
    completed = true;
    if (lms.version === '1.2') {
      var st = lms.get(lms.K.status);
      if (st !== 'passed' && st !== 'failed') lms.set(lms.K.status, 'completed');
    } else {
      lms.set(lms.K.completion, 'completed');
    }
  }

  function reportScore(raw, max) {
    if (!(max > 0)) return;
    raw = Math.max(0, Math.min(raw, max));
    if (CFG.scorePolicy !== 'last' && best && raw / max <= best.raw / best.max) {
      LOG('Bỏ qua điểm thấp hơn điểm cao nhất', raw, max);
      markCompleted(); commit();
      return;
    }
    best = { raw: raw, max: max };
    var pct = Math.round((raw / max) * 10000) / 100;
    var mastery = masteryPercent();
    // Quy điểm về thang 100 để LMS hiển thị thống nhất
    lms.set(lms.K.min, 0);
    lms.set(lms.K.max, 100);
    lms.set(lms.K.raw, pct);
    completed = true;
    if (lms.version === '1.2') {
      lms.set(lms.K.status, mastery == null ? 'completed' : (pct >= mastery ? 'passed' : 'failed'));
    } else {
      lms.set(lms.K.scaled, Math.round((raw / max) * 10000) / 10000);
      lms.set(lms.K.completion, 'completed');
      if (mastery != null) lms.set(lms.K.success, pct >= mastery ? 'passed' : 'failed');
    }
    LOG('Ghi điểm', pct + '%', 'ngưỡng đạt', mastery);
    commit();
  }

  function isTopLevel(st) {
    var ca = st.context && st.context.contextActivities;
    return !(ca && ca.parent && ca.parent.length);
  }

  function onXAPI(event) {
    if (!lms || finished) return;
    var st = event && event.data && event.data.statement;
    if (!st || !st.verb || !isTopLevel(st)) return;
    var verb = String(st.verb.id || '').split('/').pop();
    var res = st.result || {};
    LOG('xAPI', verb, res);
    if (res.score && typeof res.score.raw === 'number' && res.score.max > 0 &&
        ['answered', 'completed', 'passed', 'failed', 'scored'].indexOf(verb) !== -1) {
      reportScore(res.score.raw, res.score.max);
    } else if (verb === 'completed' || res.completion === true) {
      markCompleted(); commit();
    }
    saveState();
  }

  function saveState() {
    if (!lms || CFG.resume === false || !stateGetter) return;
    try {
      var s = stateGetter();
      if (s == null) return;
      if (s.length > lms.suspendLimit) {
        LOG('Tiến độ quá lớn để lưu (' + s.length + ' ký tự > ' + lms.suspendLimit + ')');
        return;
      }
      lms.set(lms.K.suspend, s);
    } catch (e) { LOG('Lỗi lưu tiến độ', e); }
  }

  function finish() {
    if (!lms || finished) return;
    saveState();
    lms.set(lms.K.session, (lms.version === '1.2' ? time12 : time2004)(Date.now() - started));
    if (lms.version === '1.2') lms.set(lms.K.exit, completed ? '' : 'suspend');
    else lms.set(lms.K.exit, completed ? 'normal' : 'suspend');
    commit();
    try { lms.finish(); } catch (e) {}
    finished = true;
  }

  /* ---------- API công khai ---------- */
  global.H5P2SCORM = {
    /** Khởi tạo phiên SCORM, trả về trạng thái đã lưu (chuỗi JSON) nếu có. */
    start: function () {
      lms = connect();
      started = Date.now();
      if (!lms) { LOG('Không tìm thấy SCORM API – chạy chế độ xem trước'); return { previousState: null, connected: false }; }
      if (!lms.init()) LOG('Khởi tạo thất bại, mã lỗi', lms.lastError());
      LOG('Đã kết nối SCORM', lms.version);

      var prevState = null;
      if (lms.version === '1.2') {
        var st = lms.get(lms.K.status);
        if (st === 'passed' || st === 'completed' || st === 'failed') completed = true;
        else lms.set(lms.K.status, 'incomplete');
      } else {
        var cs = lms.get(lms.K.completion);
        if (cs === 'completed') completed = true;
        else lms.set(lms.K.completion, 'incomplete');
      }
      var oldRaw = parseFloat(lms.get(lms.K.raw));
      if (!isNaN(oldRaw)) best = { raw: oldRaw, max: 100 };

      if (CFG.resume !== false && lms.get(lms.K.entry) === 'resume') {
        var sd = lms.get(lms.K.suspend);
        if (sd) prevState = sd;
      }
      if (CFG.completeOnOpen) markCompleted();
      commit();

      global.addEventListener('pagehide', finish);
      global.addEventListener('beforeunload', finish);
      global.addEventListener('unload', finish);
      setInterval(function () { saveState(); commit(); }, 30000);
      return { previousState: prevState, connected: true, version: lms.version };
    },
    /** Gắn bộ lắng nghe xAPI và hàm lấy trạng thái H5P. */
    attach: function (dispatcher, getState) {
      stateGetter = getState;
      if (dispatcher && dispatcher.on) dispatcher.on('xAPI', onXAPI);
    },
    finish: finish,
    _onXAPI: onXAPI
  };
})(window);
