// NavTTS — 導航語音引擎(可替換)
// 導航播報只呼叫 NavTTS.speak(text)，實際用哪個引擎念由這裡決定：
//   piper  : 開源 Piper TTS，在手機/電腦本機用 WASM 合成(Web Worker)，不需要 API Key、不按次計費，模型下載一次後離線可用
//   system : 瀏覽器內建 speechSynthesis(原本的做法)，Piper 還在下載/載入失敗時自動改用它，確保不會沒聲音
// 要換成別的引擎：NavTTS.registerEngine('名稱', { isReady, speak, stop, init?, preload? }) 再 NavTTS.setEngine('名稱')
// 主控台：NavTTS.status()、NavTTS.setEngine('system' | 'piper')、NavTTS.speak('測試')
(function () {
  'use strict';

  var scriptSrc = (document.currentScript && document.currentScript.src) || location.href;
  var BASE = new URL('.', scriptSrc).href; // …/tts/

  // Piper 中文語音(phoneme_type = pinyin 的模型)。預設 chaowen：CC0 授權，可商用
  var PIPER_VOICES = {
    'zh_CN-chaowen-medium': 'zh/zh_CN/chaowen/medium/', // 男聲，CC0
    'zh_CN-xiao_ya-medium': 'zh/zh_CN/xiao_ya/medium/'  // 女聲，僅限非商業用途
  };
  var PIPER_DEFAULT_VOICE = 'zh_CN-chaowen-medium';
  var PIPER_HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
  var PIPER_LIBS = {
    ortUrl: 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/ort.wasm.min.js',
    ortWasmBase: 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/',
    pinyinUrl: 'https://cdn.jsdelivr.net/npm/pinyin-pro@3.29.4/dist/index.js'
  };
  // 手機上 Piper 合成速度大約和語音長度差不多(WASM 單執行緒)，所以常用語句都先在背景合成好。
  // 沒預先合成到的句子：依實測速度估計來不及在 WAIT_BUDGET_MS 內合成完，就直接用系統語音念，不讓播報延遲
  var WAIT_BUDGET_MS = 1500;
  var BUFFER_CACHE_MAX = 80;

  function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // 由頁面提供：共用的 AudioContext、導航音量、語速、系統語音的 utterance 設定
  var hooks = {
    getAudioContext: function () { return null; },
    getVolume: function () { return 1; },
    getRate: function () { return 1; },
    makeUtterance: function (text) { var u = new SpeechSynthesisUtterance(text); u.lang = 'zh-TW'; return u; }
  };

  // ── system：瀏覽器內建語音(與原本行為相同，8 秒保險逾時) ─────────────────
  var SystemEngine = {
    isReady: function () { return 'speechSynthesis' in window; },
    speak: function (text) {
      return new Promise(function (resolve) {
        if (!('speechSynthesis' in window)) { resolve(); return; }
        var u = hooks.makeUtterance(text);
        var t = setTimeout(done, 8000);
        function done() { clearTimeout(t); resolve(); }
        u.onend = done; u.onerror = done;
        window.speechSynthesis.speak(u);
      });
    },
    stop: function () { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }
  };

  // ── piper：本機 WASM 合成，播放走頁面共用的 AudioContext ─────────────────
  var PiperEngine = (function () {
    var worker = null, state = 'idle', errorMsg = '', progress = null, sampleRate = 22050;
    var nextId = 1, jobs = {};             // id → { resolve, reject, len }
    var msPerChar = 0;                     // 實測每個字的合成時間(移動平均)，用來估計來不及時直接改用系統語音
    var buffers = new Map();               // `${rate}|${text}` → AudioBuffer(常用語句先合成好，播報零延遲)
    var inflight = new Map();              // 同一句同時只合成一次
    var pendingPreload = [];
    var current = null;                    // 正在播的 { src, finish }

    function voiceId() {
      var v = lsGet('navPiperVoice', PIPER_DEFAULT_VOICE);
      return PIPER_VOICES[v] ? v : PIPER_DEFAULT_VOICE;
    }
    function rate() { return Math.round((hooks.getRate() || 1) * 100) / 100; }

    function init() {
      if (state !== 'idle' && state !== 'error') return;
      if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') { state = 'error'; errorMsg = '瀏覽器不支援 Worker/WASM'; return; }
      var v = voiceId();
      var file = v + '.onnx';
      state = 'loading';
      try {
        worker = new Worker(BASE + 'piper-worker.js');
      } catch (e) { state = 'error'; errorMsg = String(e.message || e); return; }
      worker.onmessage = onMessage;
      worker.onerror = function (e) { fail(e.message || 'worker error'); };
      worker.postMessage({ type: 'init', config: {
        // 先找網站自己的 tts/piper/ 資料夾(自架模型)，沒有才從 Hugging Face 下載
        modelUrls: [BASE + 'piper/' + file, PIPER_HF_BASE + PIPER_VOICES[v] + file],
        configUrls: [BASE + 'piper/' + file + '.json', PIPER_HF_BASE + PIPER_VOICES[v] + file + '.json'],
        cacheName: 'piper-voices-v1',
        ortUrl: PIPER_LIBS.ortUrl, ortWasmBase: PIPER_LIBS.ortWasmBase, pinyinUrl: PIPER_LIBS.pinyinUrl,
        phonemizerUrl: BASE + 'piper-zh.js?v=1'
      } });
    }

    function fail(msg) {
      state = 'error'; errorMsg = msg;
      console.warn('[NavTTS] Piper 無法使用，改用系統語音：', msg);
      Object.keys(jobs).forEach(function (id) { jobs[id].reject(new Error(msg)); });
      jobs = {};
      if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    }

    function onMessage(ev) {
      var m = ev.data || {};
      if (m.type === 'progress') { progress = m; return; }
      if (m.type === 'ready') {
        state = 'ready'; sampleRate = m.sampleRate; progress = null;
        console.log('[NavTTS] Piper 語音已就緒(' + voiceId() + ')');
        var list = pendingPreload; pendingPreload = [];
        preload(list);
        return;
      }
      if (m.type === 'init-error') { fail(m.message); return; }
      var job = jobs[m.id];
      if (!job) return;
      delete jobs[m.id];
      if (m.type === 'audio') {
        if (m.ms && job.len) msPerChar = msPerChar ? msPerChar * 0.7 + (m.ms / job.len) * 0.3 : m.ms / job.len;
        job.resolve(m.pcm);
      }
      else job.reject(new Error(m.message));
    }

    function toBuffer(pcm) {
      var ctx = hooks.getAudioContext();
      if (!ctx) throw new Error('no AudioContext');
      var buf = ctx.createBuffer(1, Math.max(1, pcm.length), sampleRate);
      if (pcm.length) buf.getChannelData(0).set(pcm);
      return buf;
    }

    function synth(text, priority) {
      var key = rate() + '|' + text;
      if (buffers.has(key)) return Promise.resolve(buffers.get(key));
      if (inflight.has(key)) return inflight.get(key);
      var p = new Promise(function (resolve, reject) {
        var id = nextId++;
        jobs[id] = { resolve: resolve, reject: reject, len: text.length };
        worker.postMessage({ type: 'synth', id: id, text: text, rate: rate(), priority: priority });
      }).then(function (pcm) {
        var buf = toBuffer(pcm);
        buffers.set(key, buf);
        if (buffers.size > BUFFER_CACHE_MAX) buffers.delete(buffers.keys().next().value);
        return buf;
      });
      inflight.set(key, p);
      p.then(function () { inflight.delete(key); }, function () { inflight.delete(key); });
      return p;
    }

    function play(buf) {
      return new Promise(function (resolve) {
        var ctx = hooks.getAudioContext();
        if (!ctx) { resolve(); return; }
        if (ctx.state === 'suspended') ctx.resume().catch(function () {});
        var src = ctx.createBufferSource();
        var gain = ctx.createGain();
        gain.gain.value = Math.max(0, Math.min(1, hooks.getVolume()));
        src.buffer = buf;
        src.connect(gain); gain.connect(ctx.destination);
        var t = setTimeout(finish, buf.duration * 1000 + 1500); // onended 沒觸發時的保險
        function finish() {
          clearTimeout(t);
          if (current && current.src === src) current = null;
          resolve();
        }
        src.onended = finish;
        current = { src: src, finish: finish };
        src.start();
      });
    }

    // opts.replace：先丟掉還沒開始的一般預先合成(例如已經開過的路口)，只留這一批
    // opts.priority = 'high'：插隊且不會被 replace 丟掉(例如測速照相首次提醒，一定會念到)
    function preload(texts, opts) {
      opts = opts || {};
      var priority = opts.priority === 'high' ? 'high' : 'low';
      if (opts.replace) {
        pendingPreload = [];
        if (worker && state === 'ready') worker.postMessage({ type: 'clear-low' });
      }
      (texts || []).forEach(function (t) {
        if (!t) return;
        if (state === 'ready') synth(t, priority).catch(function () {});
        else if (state === 'idle' || state === 'loading') { if (pendingPreload.indexOf(t) < 0) pendingPreload.push(t); }
      });
    }

    return {
      init: init,
      preload: preload,
      isReady: function () { return state === 'ready'; },
      // 來不及合成就丟出錯誤，由 NavTTS 改用系統語音念這一句(合成結果仍會留著下次用)
      speak: function (text, isCancelled) {
        var key = rate() + '|' + text;
        if (!buffers.has(key) && msPerChar * text.length > WAIT_BUDGET_MS) {
          synth(text, 'low').catch(function () {});
          return Promise.reject(new Error('piper too slow for this sentence (not preloaded)'));
        }
        var timer;
        var timeout = new Promise(function (_, reject) {
          timer = setTimeout(function () { reject(new Error('piper synth timeout')); }, WAIT_BUDGET_MS + 500);
        });
        return Promise.race([synth(text, 'high'), timeout]).then(function (buf) {
          clearTimeout(timer);
          if (isCancelled()) return;
          return play(buf);
        }, function (e) { clearTimeout(timer); throw e; });
      },
      stop: function () {
        if (current) {
          var c = current; current = null;
          try { c.src.stop(); } catch (e) {}
          c.finish();
        }
      },
      status: function () {
        return { state: state, voice: voiceId(), error: errorMsg || undefined, progress: progress, cached: buffers.size, msPerChar: Math.round(msPerChar) };
      }
    };
  })();

  // ── 對外介面 ───────────────────────────────────────────────────────────────
  var engines = { system: SystemEngine, piper: PiperEngine };
  var gen = 0; // stop() 時 +1，讓還在合成中的語句不要再播出來

  function preferred() {
    var name = lsGet('navTtsEngine', 'piper');
    return engines[name] ? name : 'system';
  }

  var NavTTS = {
    configure: function (h) { Object.keys(h || {}).forEach(function (k) { if (typeof h[k] === 'function') hooks[k] = h[k]; }); },
    registerEngine: function (name, engine) { engines[name] = engine; },
    setEngine: function (name) {
      if (!engines[name]) return false;
      lsSet('navTtsEngine', name);
      if (engines[name].init) engines[name].init();
      return true;
    },
    getEngine: preferred,
    init: function () { var e = engines[preferred()]; if (e.init) e.init(); },
    // 常用語句先在背景合成，真正播報時直接播(系統語音引擎不需要)
    preload: function (texts, opts) { var e = engines[preferred()]; if (e.preload) e.preload(texts, opts); },
    // 念完才 resolve；偏好的引擎還沒好或失敗時，改用系統語音
    speak: function (text) {
      if (!text) return Promise.resolve();
      var myGen = gen;
      var isCancelled = function () { return myGen !== gen; };
      var e = engines[preferred()];
      if (e !== SystemEngine && e.isReady()) {
        return e.speak(text, isCancelled).catch(function (err) {
          console.warn('[NavTTS] ' + preferred() + ' 播放失敗，改用系統語音：', err && err.message);
          if (!isCancelled()) return SystemEngine.speak(text);
        });
      }
      return SystemEngine.speak(text);
    },
    stop: function () {
      gen++;
      Object.keys(engines).forEach(function (k) { try { engines[k].stop(); } catch (e) {} });
    },
    status: function () { return { engine: preferred(), piper: PiperEngine.status() }; }
  };

  window.NavTTS = NavTTS;
})();
