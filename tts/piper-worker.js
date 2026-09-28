// Piper TTS Web Worker：在背景執行緒把文字合成成 PCM，不卡地圖/車輛動畫。
// 完全在手機/電腦本機執行(onnxruntime-web WASM)，不需要 API Key、不按次計費。
// 模型第一次下載後存進 Cache Storage，之後離線也能用。
//
// 主執行緒 → worker：
//   { type:'init', config:{ modelUrls:[...], configUrls:[...], ortUrl, ortWasmBase, pinyinUrl, phonemizerUrl, cacheName } }
//   { type:'synth', id, text, rate, priority:'high'|'low' } / { type:'clear-low' }(丟掉還沒開始的預先合成)
// worker → 主執行緒：
//   { type:'progress', loaded, total } / { type:'ready', sampleRate } / { type:'init-error', message }
//   { type:'audio', id, pcm(Float32Array, transfer), sampleRate, ms(合成花的時間) } / { type:'error', id, message }
'use strict';

var session = null;
var modelConfig = null;
var ready = false;
var queue = { high: [], low: [] };
var working = false;

// 先找本機(和網頁同一個網站)的模型，找不到才去 Hugging Face 下載；下載成功就存進 Cache Storage
async function fetchCached(urls, cacheName, onProgress) {
  var cache = null;
  try { cache = await caches.open(cacheName); } catch (e) { /* 不支援 Cache Storage 就每次重抓 */ }
  if (cache) {
    for (var i = 0; i < urls.length; i++) {
      var hit = await cache.match(urls[i]);
      if (hit) return hit.arrayBuffer();
    }
  }
  var lastErr = null;
  for (var j = 0; j < urls.length; j++) {
    try {
      var res = await fetch(urls[j]);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + urls[j]);
      var total = +(res.headers.get('Content-Length') || 0);
      var buf;
      if (onProgress && res.body && res.body.getReader) {
        var reader = res.body.getReader(), chunks = [], loaded = 0;
        for (;;) {
          var r = await reader.read();
          if (r.done) break;
          chunks.push(r.value); loaded += r.value.length;
          onProgress(loaded, total);
        }
        var out = new Uint8Array(loaded), off = 0;
        chunks.forEach(function (c) { out.set(c, off); off += c.length; });
        buf = out.buffer;
      } else {
        buf = await res.arrayBuffer();
      }
      if (cache) {
        try { await cache.put(urls[j], new Response(buf.slice(0))); } catch (e) { /* 空間不足就算了，下次再下載 */ }
      }
      return buf;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('model not found');
}

async function init(config) {
  importScripts(config.ortUrl, config.pinyinUrl, config.phonemizerUrl);
  ort.env.wasm.wasmPaths = config.ortWasmBase;
  ort.env.wasm.numThreads = 1; // GitHub Pages 沒有 cross-origin isolation，多執行緒 WASM 不能用
  var cfgBuf = await fetchCached(config.configUrls, config.cacheName);
  modelConfig = JSON.parse(new TextDecoder().decode(cfgBuf));
  if (modelConfig.phoneme_type !== 'pinyin') {
    throw new Error('目前只支援 phoneme_type = pinyin 的中文 Piper 模型(例如 zh_CN-chaowen-medium)');
  }
  var modelBuf = await fetchCached(config.modelUrls, config.cacheName, function (loaded, total) {
    postMessage({ type: 'progress', loaded: loaded, total: total });
  });
  session = await ort.InferenceSession.create(modelBuf, { executionProviders: ['wasm'] });
  ready = true;
}

async function synthSentence(phonemes, lengthScale) {
  var ids = PiperZh.phonemesToIds(phonemes, modelConfig.phoneme_id_map);
  var inf = modelConfig.inference || {};
  var feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([
      inf.noise_scale != null ? inf.noise_scale : 0.667,
      lengthScale,
      inf.noise_w != null ? inf.noise_w : 0.8
    ]), [3])
  };
  if ((modelConfig.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  var out = await session.run(feeds);
  return out.output.data;
}

async function synth(text, rate) {
  var sentences = PiperZh.phonemize(text, pinyinPro.pinyin);
  if (!sentences.length) return new Float32Array(0);
  var baseScale = (modelConfig.inference && modelConfig.inference.length_scale) || 1;
  var lengthScale = baseScale / Math.max(0.5, Math.min(2, rate || 1)); // 語速設定 0.95× → 念慢一點
  var sr = modelConfig.audio.sample_rate;
  var gap = Math.round(sr * 0.2); // 句與句之間停 0.2 秒
  var parts = [];
  for (var i = 0; i < sentences.length; i++) {
    if (i > 0) parts.push(new Float32Array(gap));
    parts.push(await synthSentence(sentences[i], lengthScale));
  }
  var len = parts.reduce(function (s, p) { return s + p.length; }, 0);
  var pcm = new Float32Array(len), off = 0;
  parts.forEach(function (p) { pcm.set(p, off); off += p.length; });
  return pcm;
}

// 語音請求(high)優先，預先合成(low)只在空檔處理
async function pump() {
  if (working || !ready) return;
  working = true;
  try {
    for (;;) {
      var job = queue.high.shift() || queue.low.shift();
      if (!job) break;
      try {
        var t0 = Date.now();
        var pcm = await synth(job.text, job.rate);
        postMessage({ type: 'audio', id: job.id, pcm: pcm, sampleRate: modelConfig.audio.sample_rate, ms: Date.now() - t0 }, [pcm.buffer]);
      } catch (e) {
        postMessage({ type: 'error', id: job.id, message: String(e && e.message || e) });
      }
    }
  } finally {
    working = false;
  }
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.type === 'init') {
    init(msg.config).then(function () {
      postMessage({ type: 'ready', sampleRate: modelConfig.audio.sample_rate });
      pump();
    }, function (e) {
      postMessage({ type: 'init-error', message: String(e && e.message || e) });
    });
  } else if (msg.type === 'clear-low') {
    queue.low.forEach(function (job) { postMessage({ type: 'error', id: job.id, message: 'cancelled' }); });
    queue.low = [];
  } else if (msg.type === 'synth') {
    (msg.priority === 'low' ? queue.low : queue.high).push(msg);
    pump();
  }
};
