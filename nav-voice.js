// 智行地圖 播報 3.0 — 導航語音播報核心(不碰畫面、地圖、路線規劃)
// 設計文件：docs/voice-3.0.md
//
// 這個檔案只做「判斷要不要念、念什麼、誰先念」，不直接操作 DOM，所以可以在 node 跑單元測試：
//   1. createSpeedValidator  當前速度驗證(GPS 速度跳點、缺值、過期)
//   2. createTurnAnnouncer   轉彎播報：依道路情境算提醒距離、每個轉彎事件的階段只念一次、GPS 回跳不重念
//   3. classifyEnforcement   測速／執法資料分類(固定、區間、闖紅燈、科技執法、移動式)
//   4. createVoiceQueue      統一語音佇列：優先順序、過期、去重、有限重試、播放結果紀錄
//   5. createChime           提示音(用 <audio> 播 WAV，iPhone 靜音鍵/背景後也聽得到)，只在瀏覽器用
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NavVoice = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 優先順序：數字越小越優先
  var PRI = { CRITICAL: 0, TURN: 1, ENFORCE: 2, INFO: 3 };

  function haversineM(lat1, lon1, lat2, lon2) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. 當前速度驗證
  // 來源：Geolocation coords.speed(公尺/秒) × 3.6 = 公里/小時。
  // 不硬性截斷：不合理的讀數標記為無效(並記錄原因)，不是改成某個上限值。
  //  - 缺值/負數/NaN：用「兩次定位的位移 ÷ 時間」補(兩點都要夠準、間隔 2~6 秒)，補不出來就無效
  //  - 超過 250 公里/小時：無效
  //  - 跟上一筆有效速度相比，每秒變化超過 30 公里/小時(比緊急煞車還猛)：當成跳點；
  //    但連續兩筆都接近這個新數值就接受(真的加速/減速)
  //  - 最後一筆有效速度超過 5 秒沒更新：過期(播報不念速度)
  // ───────────────────────────────────────────────────────────────────────────
  function createSpeedValidator(opts) {
    opts = opts || {};
    var MAX_KMH = opts.maxKmh || 250;
    var MAX_DELTA_PER_S = opts.maxDeltaPerS || 30;
    var STALE_MS = opts.staleMs || 5000;
    var lastFix = null;          // 上一筆可拿來算位移的定位
    var pendingSpike = null;     // 疑似跳點的讀數(等下一筆確認)
    var last = { kmh: 0, valid: false, source: 'none', t: 0, reason: 'no data' };
    var lastRejected = null;

    function update(fix) {
      var t = fix.t, raw = fix.speedMs, acc = fix.acc;
      var rawOk = typeof raw === 'number' && isFinite(raw) && raw >= 0;
      var kmh = null, source = 'none', reason = '';

      if (rawOk) {
        kmh = raw * 3.6; source = 'gps';
        if (kmh > MAX_KMH) { reason = 'GPS 速度 ' + Math.round(kmh) + ' 超過 ' + MAX_KMH; kmh = null; }
      } else {
        reason = 'GPS 沒有速度';
        if (lastFix) {
          var dt = (t - lastFix.t) / 1000;
          var accOk = (acc == null || acc <= 20) && (lastFix.acc == null || lastFix.acc <= 20);
          if (dt >= 2 && dt <= 6 && accOk) {
            var d = haversineM(lastFix.lat, lastFix.lon, fix.lat, fix.lon) / dt * 3.6;
            if (d <= MAX_KMH) { kmh = d; source = 'moved'; reason = ''; }
          }
        }
      }
      // 位移算速度的基準點：間隔夠久才換(太近的兩點雜訊太大)
      if (!lastFix || (t - lastFix.t) >= 2000 || (acc != null && lastFix.acc != null && acc < lastFix.acc)) {
        lastFix = { lat: fix.lat, lon: fix.lon, t: t, acc: acc };
      }

      // 跳點檢查(跟上一筆有效速度比)
      if (kmh != null && last.valid && t > last.t && t - last.t <= 3000) {
        var dts = Math.max(0.5, (t - last.t) / 1000);
        if (Math.abs(kmh - last.kmh) / dts > MAX_DELTA_PER_S) {
          if (pendingSpike && Math.abs(pendingSpike.kmh - kmh) <= 15) {
            pendingSpike = null; // 連續兩筆都是這個數值：真的變快/變慢，接受
          } else {
            pendingSpike = { kmh: kmh, t: t };
            lastRejected = { kmh: kmh, t: t, reason: '速度一秒變化 ' + Math.round(Math.abs(kmh - last.kmh) / dts) + ' 公里/小時，疑似跳點' };
            return get(t); // 先沿用上一筆有效值(還沒過期的話)
          }
        } else pendingSpike = null;
      }

      if (kmh != null) last = { kmh: kmh, valid: true, source: source, t: t, reason: reason };
      else { last = { kmh: 0, valid: false, source: 'none', t: t, reason: reason }; lastRejected = { kmh: rawOk ? raw * 3.6 : null, t: t, reason: reason }; }
      return last;
    }

    function get(now) {
      if (last.valid && now != null && now - last.t > STALE_MS) {
        return { kmh: last.kmh, valid: false, source: last.source, t: last.t, reason: '速度資料已過期' };
      }
      return last;
    }

    function reset() { lastFix = null; pendingSpike = null; last = { kmh: 0, valid: false, source: 'none', t: 0, reason: 'no data' }; }
    return { update: update, get: get, reset: reset, lastRejected: function () { return lastRejected; } };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. 轉彎播報
  // ───────────────────────────────────────────────────────────────────────────
  // 初始測試基準(智行地圖自行設計，不是任何品牌的官方數值)：
  //   far = 遠距離預告、near = 接近提醒(複雜交流道有兩次)、now = 實際指令(請右轉)
  var TURN_BASE = {
    urban:              { far: 300,  near: [100],       now: 25, defKmh: 40 },
    urbanComplex:       { far: 500,  near: [200],       now: 25, defKmh: 40 },
    suburban:           { far: 500,  near: [200],       now: 40, defKmh: 60 },
    exit:               { far: 1000, near: [500],       now: 0,  defKmh: 90 },
    complexInterchange: { far: 2000, near: [1000, 500], now: 0,  defKmh: 90 }
  };
  var FREEWAY_RE = /國道|高速公路|快速道路|快速公路|高架|交流道|系統|Freeway|Expressway|Motorway/i;
  var PLAN_MAX_KMH = 130; // 只用在「算提醒距離」：車速讀數異常大時不要算出好幾公里外的提醒

  function maneuverOf(step) { return (step && step.maneuver) || {}; }
  function modOf(step) { return maneuverOf(step).modifier || ''; }
  function sideOf(step) { return /left/.test(modOf(step)) ? '左' : '右'; }

  // 這一步是不是要念的動作(出發、沿路直走/改路名不念)
  function isSpokenManeuver(step) {
    var m = maneuverOf(step), mod = m.modifier || '';
    if (!step || m.type === 'depart') return false;
    // 「繼續/改路名」只有真的轉彎或迴轉才念；微靠(道路自然彎)不念，跟原本一致，也不會跟「繼續行駛XX路」打架
    if (m.type === 'continue' || m.type === 'new name') return /^(uturn|left|right|sharp left|sharp right)$/.test(mod);
    if (m.type === 'notification') return false;
    return true;
  }

  // 動作的說法(不含「請」)
  function actionText(step) {
    var m = maneuverOf(step), mod = m.modifier || '';
    switch (m.type) {
      case 'arrive': return '到達目的地';
      case 'roundabout': case 'rotary': case 'roundabout turn':
        return m.exit ? '進入圓環，從第' + m.exit + '個出口離開' : '進入圓環';
      case 'merge': return '匯入主線';
      case 'off ramp': return '靠' + sideOf(step) + '下交流道';
      case 'on ramp': return '靠' + sideOf(step) + '上交流道';
      case 'fork': return '靠' + sideOf(step) + '行駛';
      case 'end of road':
        return /left/.test(mod) ? '左轉' : /right/.test(mod) ? '右轉' : '轉彎';
    }
    if (mod === 'uturn') return '迴轉';
    if (mod === 'left' || mod === 'sharp left') return '左轉';
    if (mod === 'right' || mod === 'sharp right') return '右轉';
    if (mod === 'slight left') return '靠左行駛';
    if (mod === 'slight right') return '靠右行駛';
    if (mod === 'straight') return '直行';
    return '繼續前進';
  }

  // 「進入XX路」只在有可靠路名時加；匝道類改成「，XX」
  function withRoad(step, act) {
    var name = (step && step.name) || '';
    if (!name) return act;
    var t = maneuverOf(step).type;
    if (t === 'off ramp' || t === 'on ramp') return act + '，' + name;
    if (t === 'roundabout' || t === 'rotary' || t === 'merge' || t === 'arrive') return act;
    // 「靠右行駛進入XX」→「靠右進入XX」
    return act.replace(/行駛$/, '') + '進入' + name;
  }

  // 距離念法：1 公里以上念 0.5 公里為單位、100 公尺以上念整百、更近念整十(不會念出 150、437 這種數字)
  function distText(m) {
    if (m >= 950) { var km = Math.round(m / 500) / 2; return (km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)) + '公里'; }
    if (m >= 100) return Math.round(m / 100) * 100 + '公尺';
    return Math.max(10, Math.round(m / 10) * 10) + '公尺';
  }

  // 車道：OSRM intersections[].lanes 有 valid 標記，而且建議車道全在左半或右半才念(資料不完整就不念)
  function laneHint(step) {
    var ins = step && step.intersections;
    var lanes = ins && ins.length && ins[0].lanes;
    if (!lanes || lanes.length < 3) return '';
    var valid = [];
    lanes.forEach(function (l, i) { if (l && l.valid === true) valid.push(i); });
    if (!valid.length || valid.length === lanes.length) return '';
    var half = (lanes.length - 1) / 2;
    if (valid.every(function (i) { return i < half; })) return '請走左側車道';
    if (valid.every(function (i) { return i > half; })) return '請走右側車道';
    return '';
  }

  // 道路情境(智行地圖自行設計的判斷，資料不足時保守處理)
  function turnContext(steps, i, speed) {
    var step = steps[i], prev = steps[i - 1], next = steps[i + 1];
    var m = maneuverOf(step), t = m.type;
    var onFreeway = FREEWAY_RE.test((prev && prev.name) || '') || FREEWAY_RE.test((step && step.name) || '');
    var lanes = step && step.intersections && step.intersections[0] && step.intersections[0].lanes;
    var isSplit = t === 'off ramp' || (t === 'fork' && (onFreeway || (speed != null && speed >= 70)));
    if (isSplit) {
      // 分流後 1 公里內又要分流/下匝道 → 複雜交流道
      var nm = maneuverOf(next);
      var multi = next && (nm.type === 'fork' || nm.type === 'off ramp' || nm.type === 'merge') && (step.distance || 0) <= 1000;
      return multi ? 'complexInterchange' : 'exit';
    }
    if (t === 'on ramp') return 'suburban';
    var complex = t === 'roundabout' || t === 'rotary' || modOf(step) === 'uturn' || (lanes && lanes.length >= 4);
    var fast = speed != null ? speed >= 55 : onFreeway;
    if (fast) return 'suburban';
    return complex ? 'urbanComplex' : 'urban';
  }

  // 各階段的觸發距離(公尺)：基準值與「車速 × 反應時間」取大，再設上限，避免異常車速算出超遠的提醒
  function turnThresholds(ctxName, speedKmh, accuracyM) {
    var b = TURN_BASE[ctxName];
    var v = speedKmh != null && isFinite(speedKmh) && speedKmh > 3 ? Math.min(speedKmh, PLAN_MAX_KMH) : b.defKmh;
    var ms = v / 3.6;
    var far = Math.min(b.far * 2, Math.max(b.far, ms * 25));
    var near = b.near.map(function (n) { return Math.min(n * 2, Math.max(n, ms * 9)); });
    // 實際指令：市區 20~30、郊區 30~50 公尺內；交流道在分流點前約 2 秒(至少 50 公尺)
    var now = b.now ? Math.min(b.now === 25 ? 30 : 50, Math.max(b.now === 25 ? 20 : 30, ms * 1.8)) : Math.min(120, Math.max(50, ms * 2));
    // GPS 不準時提早一點念實際指令(最多 +20 公尺)，避免念的時候已經開過頭
    if (accuracyM && accuracyM > 15) now += Math.min(20, (accuracyM - 15) / 2);
    return { far: Math.round(far), near: near.map(Math.round), now: Math.round(now), planKmh: v };
  }

  // 短方向(連續轉彎合併用)
  function shortAction(step) {
    var a = actionText(step);
    return a.replace(/，從第\d+個出口離開$/, '');
  }

  function createTurnAnnouncer(opts) {
    opts = opts || {};
    var events = new Map();   // eventId → { id, routeVersion, stepIndex, done:{}, status, spoken }
    var log = opts.log || function () {};

    function eventId(routeVersion, steps, i) {
      var loc = maneuverOf(steps[i]).location || [];
      return routeVersion + ':' + i + ':' + Number(loc[0] || 0).toFixed(5) + ',' + Number(loc[1] || 0).toFixed(5);
    }
    function getEvent(routeVersion, steps, i) {
      var id = eventId(routeVersion, steps, i);
      var e = events.get(id);
      if (!e) { e = { id: id, routeVersion: routeVersion, stepIndex: i, done: {}, status: 'waiting', spoken: false }; events.set(id, e); }
      return e;
    }

    // 換路線(重新規劃)：舊路線的轉彎事件全部取消
    function setRoute(routeVersion) {
      events.forEach(function (e, id) {
        if (e.routeVersion !== routeVersion) { if (e.status === 'waiting') log({ eventId: id, status: 'cancelled', reason: '路線已重新規劃' }); events.delete(id); }
      });
    }
    function reset() { events.clear(); }

    // 下一個動作離這個轉彎很近：一起念「…，接著左轉」，下一個轉彎的預告就不再念，但到了路口仍念「請左轉」
    function chainText(steps, i, th, e) {
      var next = steps[i + 1];
      if (!next || !isSpokenManeuver(next) || maneuverOf(next).type === 'arrive') return '';
      var gap = steps[i].distance || 0;
      var chainGap = Math.max(100, Math.min(250, th.planKmh / 3.6 * 7));
      if (!(gap > 0 && gap <= chainGap)) return '';
      var n = events.get(eventId(e.routeVersion, steps, i + 1)) || getEvent(e.routeVersion, steps, i + 1);
      n.done.far = true; n.done.near0 = true; n.done.near1 = true; n.chainedFrom = e.id;
      return '，接著' + shortAction(next);
    }

    function phrase(steps, i, phase, meters, th, e) {
      var step = steps[i], t = maneuverOf(step).type;
      var act = actionText(step);
      // 到達：只在接近時預告一次，真正到達由導航完成流程念「已到達目的地」
      if (t === 'arrive') return phase === 'far' || phase === 'now' ? null : '前方' + distText(meters) + '到達目的地。';
      if (modOf(step) === 'straight' && phase === 'far') return null; // 路口直行：只在接近時提醒一次
      if (phase === 'now') {
        // 實際指令：「請右轉」，不加「前方」、不念距離；前面都沒念過才加路名
        var nowTxt = '請' + (e.spoken ? act : withRoad(step, act));
        return nowTxt + chainText(steps, i, th, e) + '。';
      }
      var s = '前方' + distText(meters) + '，請' + withRoad(step, act);
      var lane = (phase !== 'far' || t === 'off ramp' || t === 'fork') ? laneHint(step) : '';
      if (lane) s += '，' + lane;
      if (phase !== 'far') s += chainText(steps, i, th, e);
      return s + '。';
    }

    // 每次 GPS 更新呼叫一次。input：
    //   routeVersion, steps(OSRM steps), index(下一個動作的索引), meters(沿路線到該動作的距離),
    //   passed(已沿路線超過該點), speedKmh(已驗證；無效給 null), accuracy
    // 回傳要念的播報 [{ eventId, phase, text, priority, maxAgeMs }]
    function update(input) {
      var steps = input.steps, i = input.index;
      if (!steps || i == null || i >= steps.length) return [];
      var step = steps[i];
      if (!isSpokenManeuver(step)) return [];
      var e = getEvent(input.routeVersion, steps, i);
      if (e.status !== 'waiting') return [];
      var meters = input.meters;
      if (!(meters >= 0) || !isFinite(meters)) return [];
      // 通過後鎖定：之後 GPS 回跳也不會再念這個轉彎
      if (input.passed) { e.status = 'passed'; log({ eventId: e.id, status: 'passed', reason: e.done.now ? '' : '沒念實際指令就通過(已開過頭不補念)' }); return []; }

      var ctxName = turnContext(steps, i, input.speedKmh);
      var th = turnThresholds(ctxName, input.speedKmh, input.accuracy);
      var ms = th.planKmh / 3.6;
      var out = [];

      // 實際指令(最高優先)
      if (meters <= th.now) {
        if (!e.done.now) {
          e.done.now = true; e.done.far = true; e.done.near0 = true; e.done.near1 = true;
          var tx = phrase(steps, i, 'now', meters, th, e);
          if (tx) { out.push({ eventId: e.id + ':now', phase: 'now', text: tx, priority: PRI.CRITICAL, maxAgeMs: 4000, ctx: ctxName }); e.spoken = true; }
        }
        return out;
      }
      // 接近提醒(複雜交流道有兩次：1 公里、500 公尺)：只念「目前距離所在」的最近一階
      for (var k = th.near.length - 1; k >= 0; k--) {
        var key = 'near' + k;
        if (meters <= th.near[k]) {
          if (!e.done[key]) {
            for (var j = 0; j <= k; j++) e.done['near' + j] = true;
            e.done.far = true;
            // 離實際指令不到 3 秒：接近提醒跟實際指令會連在一起念，直接等實際指令
            if ((meters - th.now) / ms < 3) return out;
            var tn = phrase(steps, i, 'near', meters, th, e);
            if (tn) { out.push({ eventId: e.id + ':' + key, phase: key, text: tn, priority: PRI.TURN, maxAgeMs: 6000, ctx: ctxName }); e.spoken = true; }
          }
          return out;
        }
      }
      // 遠距離預告：離接近提醒不到 5 秒就不念(避免兩句連發)
      if (meters <= th.far && !e.done.far) {
        e.done.far = true;
        if ((meters - th.near[0]) / ms < 5) return out;
        var tf = phrase(steps, i, 'far', meters, th, e);
        if (tf) { out.push({ eventId: e.id + ':far', phase: 'far', text: tf, priority: PRI.TURN, maxAgeMs: 10000, ctx: ctxName }); e.spoken = true; }
      }
      return out;
    }

    // 開始導航/重新規劃時念的第一句：念實際距離，比這個距離遠的階段都算念過
    function intro(input) {
      var steps = input.steps, i = input.index;
      if (!steps || i == null || !isSpokenManeuver(steps[i])) return null;
      var e = getEvent(input.routeVersion, steps, i);
      var ctxName = turnContext(steps, i, input.speedKmh);
      var th = turnThresholds(ctxName, input.speedKmh, input.accuracy);
      var meters = input.meters;
      if (meters <= th.now) return null; // 太近：交給下一次更新念實際指令
      e.done.far = true; // 第一句已經念過方向，遠距離預告不再念
      th.near.forEach(function (n, k) { if (meters <= n) e.done['near' + k] = true; });
      var tx = phrase(steps, i, meters <= th.near[0] ? 'near' : 'far', meters, th, e);
      if (tx) e.spoken = true;
      return tx;
    }

    function state(routeVersion, steps, i) { var e = events.get(eventId(routeVersion, steps, i)); return e ? { status: e.status, done: Object.assign({}, e.done) } : null; }

    // 預先合成用：這個轉彎可能會念的句子(不改變任何狀態)
    function preview(steps, i, speedKmh) {
      if (!steps || !isSpokenManeuver(steps[i])) return [];
      var th = turnThresholds(turnContext(steps, i, speedKmh), speedKmh);
      var tmp = { id: 'preview', routeVersion: 'preview', done: {}, spoken: false };
      var saved = new Map(events);
      var out = [phrase(steps, i, 'far', th.far, th, tmp)];
      th.near.forEach(function (n) { out.push(phrase(steps, i, 'near', n, th, tmp)); });
      tmp.spoken = true;
      out.push(phrase(steps, i, 'now', th.now, th, tmp));
      events = saved; // chainText 可能建立暫時事件，還原
      return out.filter(Boolean);
    }

    return { update: update, intro: intro, setRoute: setRoute, reset: reset, state: state, preview: preview };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. 測速／交通執法分類
  // 專案資料(警政署 測速執法設置點 → speed_camera_data.js)只有 limit / addr / city / dir 四個欄位，沒有類型代碼，
  // 類型只能從文字判斷：
  //   區間測速：dir 或 addr 有「區間」
  //   闖紅燈：dir 或 addr 有「闖紅燈」(資料裡都是「兼闖紅燈」「超速闖紅燈」= 測速兼闖紅燈)
  //   科技執法：addr 或 dir 有「科技執法」(例如雪山隧道科技執法，仍是測速)
  //   移動式：資料沒有。保留 props.kind === 'mobile'(之後常取締地點資料可以接進來)
  // ───────────────────────────────────────────────────────────────────────────
  function validLimit(limit) {
    var n = Number(limit);
    return isFinite(n) && n >= 5 && n <= 130 ? n : null;
  }
  function classifyEnforcement(p) {
    p = p || {};
    var text = String(p.dir || '') + ' ' + String(p.addr || '');
    var section = /區間/.test(text);
    var mobile = p.kind === 'mobile';
    var redLight = /闖紅燈/.test(text);
    var tech = /科技執法/.test(text);
    var kind = mobile ? 'mobile' : section ? 'section' : 'fixed';
    var label = mobile ? '移動式測速' : section ? '區間測速照相' : tech ? '科技執法測速照相' : '固定測速照相';
    if (redLight) label += '兼闖紅燈照相';
    return { kind: kind, label: label, redLight: redLight, tech: tech, limit: validLimit(p.limit), speedEnforced: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. 統一語音佇列
  // 同時只播一段；選下一段時：先丟掉過期的 → 優先順序最高 → 最早排入。
  // 已經在播的不會被一般新事件打斷；只有「實際轉彎指令」(CRITICAL) 可以打斷正在播的測速/一般資訊，
  // 被打斷的那段若還沒過期、還有重試次數，會重新排隊一次。
  // 同一個 eventId 播完就不會再排入(避免同一提醒重播)；同一個 key 的舊排隊會被新的取代(沿用舊行為)。
  // ───────────────────────────────────────────────────────────────────────────
  function createVoiceQueue(cfg) {
    var play = cfg.play;                    // play(item) → Promise<{ ok, reason }>
    var stopCurrent = cfg.stop || function () {};
    var now = cfg.now || function () { return Date.now(); };
    var onBusyCb = cfg.onBusy || function () {};
    var busyState = false;
    function onBusy(b) { if (b !== busyState) { busyState = b; onBusyCb(b); } } // 只在開始/全部播完時通知(壓低/還原音樂)
    var pending = [];
    var current = null;
    var nextId = 1;
    var gen = 0;
    var finished = new Map();               // eventId → 'completed'
    var logs = [];
    var LOG_MAX = 300;

    function log(entry, status, reason) {
      var rec = { t: now(), id: entry ? entry.id : null, eventId: entry ? entry.eventId : null, key: entry ? entry.key : null,
        priority: entry ? entry.priority : null, text: entry ? entry.label : '', status: status, reason: reason || '' };
      logs.push(rec);
      if (logs.length > LOG_MAX) logs.shift();
      if (cfg.onLog) cfg.onLog(rec);
    }
    function labelOf(items) { return items.map(function (x) { return typeof x === 'function' ? '<提示音>' : x; }).filter(Boolean).join(' / '); }
    function expired(e, t) { return e.expiresAt && t > e.expiresAt; }

    function speak(items, opts) {
      if (typeof items === 'string') items = [items];
      if (!Array.isArray(items)) return null;
      items = items.filter(Boolean);
      if (!items.length) return null;
      opts = opts || {};
      var t = now();
      var entry = {
        id: nextId++, items: items, label: labelOf(items), key: opts.key || 'nav',
        priority: opts.priority != null ? opts.priority : PRI.INFO,
        eventId: opts.eventId || null, routeVersion: opts.routeVersion != null ? opts.routeVersion : null,
        ts: t, expiresAt: opts.maxAgeMs ? t + opts.maxAgeMs : 0,
        retries: 0, maxRetries: opts.retries != null ? opts.retries : (opts.priority != null && opts.priority <= PRI.ENFORCE ? 1 : 0)
      };
      if (entry.eventId) {
        if (finished.has(entry.eventId)) { log(entry, 'skipped', '同一事件已播完'); return null; }
        if ((current && current.eventId === entry.eventId) || pending.some(function (e) { return e.eventId === entry.eventId; })) {
          log(entry, 'skipped', '同一事件已在佇列'); return null;
        }
      }
      // 同 key 的舊排隊(還沒播)被新的取代
      pending = pending.filter(function (e) {
        if (e.key === entry.key) { log(e, 'cancelled', '被同類較新的播報取代'); return false; }
        return true;
      });
      pending.push(entry);
      log(entry, 'queued');
      // 實際轉彎指令可以打斷正在播的測速/一般資訊
      if (current && entry.priority === PRI.CRITICAL && current.priority >= PRI.ENFORCE && !current.interrupted) {
        current.interrupted = true;
        log(current, 'interrupted', '讓位給實際轉彎指令');
        try { stopCurrent(); } catch (err) {}
      }
      pump();
      return entry.id;
    }

    function pick() {
      var t = now();
      pending = pending.filter(function (e) { if (expired(e, t)) { log(e, 'expired', '排隊太久，已失去意義'); return false; } return true; });
      if (!pending.length) return null;
      var best = 0;
      for (var i = 1; i < pending.length; i++) {
        var a = pending[i], b = pending[best];
        if (a.priority < b.priority || (a.priority === b.priority && a.ts < b.ts)) best = i;
      }
      return pending.splice(best, 1)[0];
    }

    function pump() {
      if (current) return;
      var entry = pick();
      if (!entry) { onBusy(false); return; }
      current = entry;
      var myGen = gen;
      onBusy(true);
      log(entry, 'playing');
      (async function () {
        var ok = true, reason = '', softFail = '';
        for (var k = 0; k < entry.items.length; k++) {
          if (myGen !== gen || entry.interrupted) { ok = false; reason = entry.interrupted ? 'interrupted' : 'stopped'; break; }
          var r;
          try { r = await play(entry.items[k]); } catch (err) { r = { ok: false, reason: String((err && err.message) || err) }; }
          // 被打斷時播放端通常會回報「結束」，但這段其實沒念完
          if (entry.interrupted) { ok = false; reason = 'interrupted'; break; }
          if (r && r.ok === false) {
            // 提示音(函式)失敗：記錄原因，但後面的語音照念(例如「您已通過」不能因為提示音被擋就不念)
            if (typeof entry.items[k] === 'function') { softFail = '提示音失敗：' + (r.reason || 'failed'); continue; }
            ok = false; reason = r.reason || 'failed'; break;
          }
        }
        current = null;
        if (myGen !== gen) { log(entry, 'cancelled', '導航語音已停止'); }
        else if (ok) { log(entry, 'completed', softFail); if (entry.eventId) finished.set(entry.eventId, 'completed'); }
        else {
          var retry = entry.retries < entry.maxRetries && !expired(entry, now());
          log(entry, entry.interrupted ? 'interrupted-end' : 'failed', reason + (retry ? '，重試一次' : ''));
          if (retry) {
            entry.retries++; entry.interrupted = false; entry.ts = now();
            if (!pending.some(function (e) { return e.key === entry.key; })) pending.push(entry);
          }
        }
        pump();
      })();
    }

    // 取消符合條件的排隊(例如舊路線的轉彎提醒)
    function cancelWhere(pred, reason) {
      pending = pending.filter(function (e) { if (pred(e)) { log(e, 'cancelled', reason); return false; } return true; });
    }
    function stopAll(reason) {
      gen++;
      pending.forEach(function (e) { log(e, 'cancelled', reason || '停止導航語音'); });
      pending = [];
      if (current) { try { stopCurrent(); } catch (e) {} }
      current = null;
      finished.clear();
      onBusy(false);
    }
    return {
      speak: speak, cancelWhere: cancelWhere, stopAll: stopAll,
      isBusy: function () { return !!current; },
      pendingCount: function () { return pending.length; },
      logs: function () { return logs.slice(); }
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5. 提示音(瀏覽器)
  // 舊做法用 Web Audio 振盪器即時合成，在 iPhone 上：AudioContext 一離開前景/鎖螢幕就被暫停(interrupted)，
  // 之後只有使用者觸控才能恢復；而且 Web Audio 會被「靜音鍵」靜音。舊程式不檢查有沒有真的恢復，
  // 照樣排程音符並在 520 毫秒後回報「播完」→ 畫面上看起來有觸發，實際上沒聲音。
  // 新做法：把同一段雙音合成成 WAV，用 <audio> 播(媒體播放不受靜音鍵影響)，第一次觸控時先靜音播一次解鎖；
  // play() 的 Promise、playing/ended/error 事件分別回報「已開始」「播完」「失敗」。<audio> 不能播才退回 Web Audio。
  // ───────────────────────────────────────────────────────────────────────────
  function chimeWav() {
    var rate = 22050, dur = 0.62, n = Math.round(rate * dur);
    var pcm = new Float32Array(n);
    function note(freq, start, len) {
      [[1, 0.42], [2, 0.10], [3, 0.04]].forEach(function (h) {
        var f = freq * h[0], amp = h[1], d = len / h[0];
        var s0 = Math.round(start * rate), s1 = Math.min(n, s0 + Math.round((d + 0.02) * rate));
        for (var s = s0; s < s1; s++) {
          var tt = (s - s0) / rate;
          var env = tt < 0.008 ? tt / 0.008 : Math.exp(-(tt - 0.008) * 6.9 / Math.max(0.05, d));
          pcm[s] += amp * env * Math.sin(2 * Math.PI * f * tt);
        }
      });
    }
    note(784, 0.02, 0.30);   // G5
    note(1046.5, 0.14, 0.34); // C6
    var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i] * 0.9)) * 32767, true);
    return buf;
  }

  function createChime(cfg) {
    cfg = cfg || {};
    var getVolume = cfg.getVolume || function () { return 1; };
    var fallback = cfg.fallback || null;     // 退回用的 Web Audio 版本：() => Promise<{ok, reason}>
    var el = null, unlocked = false, lastResult = null;
    function ensure() {
      if (el || typeof Audio === 'undefined') return el;
      var url = URL.createObjectURL(new Blob([chimeWav()], { type: 'audio/wav' }));
      el = new Audio(url);
      el.preload = 'auto';
      el.setAttribute('playsinline', '');
      return el;
    }
    // 在使用者觸控事件裡呼叫：靜音播一下，之後就能在沒有觸控時播
    function unlock() {
      var a = ensure();
      if (!a || unlocked) return;
      a.muted = true;
      var p = a.play();
      var done = function () { a.pause(); a.currentTime = 0; a.muted = false; };
      if (p && p.then) p.then(function () { unlocked = true; done(); }, function () { a.muted = false; });
      else { unlocked = true; done(); }
    }
    function play() {
      var a = ensure();
      if (!a) return fallback ? fallback() : Promise.resolve({ ok: false, reason: '不支援 <audio>' });
      return new Promise(function (resolve) {
        var started = false, finished = false;
        var timer = null;
        function finish(r) {
          if (finished) return;
          finished = true; clearTimeout(timer);
          a.removeEventListener('playing', onPlaying); a.removeEventListener('ended', onEnded); a.removeEventListener('error', onError);
          lastResult = r; resolve(r);
        }
        function onPlaying() { started = true; clearTimeout(timer); timer = setTimeout(function () { finish({ ok: true, stage: 'completed', reason: 'ended 逾時' }); }, 1500); }
        function onEnded() { finish({ ok: true, stage: 'completed' }); }
        function onError() { finish({ ok: false, stage: 'failed', reason: '音檔錯誤' }); }
        a.addEventListener('playing', onPlaying); a.addEventListener('ended', onEnded); a.addEventListener('error', onError);
        try { a.pause(); a.currentTime = 0; } catch (e) {}
        a.muted = false;
        a.volume = Math.max(0, Math.min(1, getVolume()));
        var p;
        try { p = a.play(); } catch (e) { p = Promise.reject(e); }
        timer = setTimeout(function () { if (!started) finish({ ok: false, stage: 'failed', reason: '2 秒內沒開始播放' }); }, 2000);
        if (p && p.catch) p.catch(function (err) {
          var reason = (err && err.name) || 'play() 被拒絕';
          if (fallback) fallback().then(function (r) { finish(r && r.ok ? { ok: true, stage: 'completed', via: 'webaudio' } : { ok: false, stage: 'failed', reason: reason + '；Web Audio：' + ((r && r.reason) || '失敗') }); });
          else finish({ ok: false, stage: 'failed', reason: reason });
        });
      });
    }
    return { unlock: unlock, play: play, isUnlocked: function () { return unlocked; }, lastResult: function () { return lastResult; } };
  }

  return {
    PRI: PRI,
    createSpeedValidator: createSpeedValidator,
    createTurnAnnouncer: createTurnAnnouncer,
    turnContext: turnContext,
    turnThresholds: turnThresholds,
    TURN_BASE: TURN_BASE,
    distText: distText,
    actionText: actionText,
    classifyEnforcement: classifyEnforcement,
    validLimit: validLimit,
    createVoiceQueue: createVoiceQueue,
    createChime: createChime,
    chimeWav: chimeWav
  };
});
