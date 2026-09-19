// AudioManager — Priority-based in-car audio management
// Priority: Emergency(5) > Intercom(4) > NavTTS(3) > Radio(2) > Music(1)
(function () {
  'use strict';

  const PRIORITY = { EMERGENCY: 5, INTERCOM: 4, NAV_TTS: 3, RADIO: 2, MUSIC: 1 };

  function _rampVolume(getter, setter, targetVol, durationMs) {
    var startVol = getter();
    var startTime = performance.now();
    function step() {
      var t = Math.min((performance.now() - startTime) / durationMs, 1);
      var eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      setter(startVol + (targetVol - startVol) * eased);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function AudioManager() {
    this.state = {
      navigationSpeaking: false,
      radioPlaying: false,
      musicPlaying: false,
      intercomActive: false,
    };
    this.vol = {
      nav:   parseFloat(localStorage.getItem('am_vol_nav')   || '1.0'),
      radio: parseFloat(localStorage.getItem('am_vol_radio') || '1.0'),
      music: parseFloat(localStorage.getItem('am_vol_music') || '0.7'),
    };
    this._radioWasPlaying = false;
    this._musicWasPlaying = false;
    this._intercomStream = null;
  }

  // ── Nav TTS hooks (called by speakQueue) ──────────────────────────────────
  AudioManager.prototype.onNavTTSStart = function () {
    this.state.navigationSpeaking = true;
    window._ttsActive = true;

    var radio = window.radioVjs;
    if (radio && !radio.paused()) {
      this._radioWasPlaying = true;
      var duckTo = this.vol.radio * 0.12;
      _rampVolume(function () { return radio.volume(); }, function (v) { radio.volume(Math.max(0, Math.min(1, v))); }, duckTo, 300);
    } else {
      this._radioWasPlaying = false;
    }

    var music = window._amMusicEl;
    if (music && !music.paused) {
      this._musicWasPlaying = true;
      var duckToM = this.vol.music * 0.12;
      _rampVolume(function () { return music.volume; }, function (v) { music.volume = Math.max(0, Math.min(1, v)); }, duckToM, 300);
    } else {
      this._musicWasPlaying = false;
    }
  };

  AudioManager.prototype.onNavTTSEnd = function () {
    this.state.navigationSpeaking = false;
    window._ttsActive = false;

    var self = this;
    var radio = window.radioVjs;
    if (radio) {
      _rampVolume(function () { return radio.volume(); }, function (v) { radio.volume(Math.max(0, Math.min(1, v))); }, self.vol.radio, 500);
      if (self._radioWasPlaying && radio.paused()) radio.play().catch(function () {});
    }

    var music = window._amMusicEl;
    if (music) {
      _rampVolume(function () { return music.volume; }, function (v) { music.volume = Math.max(0, Math.min(1, v)); }, self.vol.music, 500);
    }
  };

  // ── Volume setters ────────────────────────────────────────────────────────
  AudioManager.prototype.setNavVol = function (v) {
    this.vol.nav = v;
    localStorage.setItem('am_vol_nav', v);
  };

  AudioManager.prototype.setRadioVol = function (v) {
    this.vol.radio = v;
    localStorage.setItem('am_vol_radio', v);
    var radio = window.radioVjs;
    if (radio && !this.state.navigationSpeaking) radio.volume(v);
  };

  AudioManager.prototype.setMusicVol = function (v) {
    this.vol.music = v;
    localStorage.setItem('am_vol_music', v);
    var music = window._amMusicEl;
    if (music && !this.state.navigationSpeaking) music.volume = v;
  };

  // ── Music player ──────────────────────────────────────────────────────────
  AudioManager.prototype.initMusicEl = function () {
    if (window._amMusicEl) return window._amMusicEl;
    var el = document.createElement('audio');
    el.volume = this.vol.music;
    el.addEventListener('play',  function () { window.AudioManager.state.musicPlaying = true;  _updateMusicUI(); });
    el.addEventListener('pause', function () { window.AudioManager.state.musicPlaying = false; _updateMusicUI(); });
    el.addEventListener('ended', function () { window.AudioManager.state.musicPlaying = false; _updateMusicUI(); });
    el.addEventListener('timeupdate', _updateMusicProgress);
    window._amMusicEl = el;
    return el;
  };

  AudioManager.prototype.musicLoad = function (src, title) {
    var el = this.initMusicEl();
    el.src = src;
    el.load();
    var nameEl = document.getElementById('amMusicName');
    if (nameEl) nameEl.textContent = title || src.split('/').pop().replace(/\.[^.]+$/, '') || '音樂';
    _updateMusicUI();
  };

  AudioManager.prototype.musicToggle = function () {
    var el = this.initMusicEl();
    if (!el.src) return;
    if (el.paused) { el.volume = this.vol.music; el.play().catch(function () {}); }
    else el.pause();
  };

  // ── Intercom (PTT) ────────────────────────────────────────────────────────
  AudioManager.prototype.pttStart = function () {
    if (this._intercomStream) return;
    var self = this;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      .then(function (stream) {
        self._intercomStream = stream;
        self.state.intercomActive = true;
        _setPttUI(true);
        // 注意：不把麥克風直接接回喇叭，避免行車環境造成回音/回授。
        // 真實對講需後端 WebRTC 才能讓對方聽到；目前僅顯示視覺回饋。
      })
      .catch(function (err) {
        console.warn('[PTT] 麥克風授權失敗:', err);
        _setPttUI(false);
        alert('請允許麥克風存取權限。\n（真實多方對講需後端 WebRTC 支援）');
      });
  };

  AudioManager.prototype.pttStop = function () {
    if (!this._intercomStream) return;
    this._intercomStream.getTracks().forEach(function (t) { t.stop(); });
    this._intercomStream = null;
    this.state.intercomActive = false;
    _setPttUI(false);
  };

  // ── UI helpers ────────────────────────────────────────────────────────────
  function _updateMusicUI() {
    var el = window._amMusicEl;
    var playBtn = document.getElementById('amMusicPlay');
    if (!playBtn) return;
    var playing = el && !el.paused;
    playBtn.innerHTML = playing
      ? '<span style="display:flex;gap:3px;align-items:center;justify-content:center;"><span style="display:block;width:3px;height:12px;background:#fff;border-radius:2px;"></span><span style="display:block;width:3px;height:12px;background:#fff;border-radius:2px;"></span></span>'
      : '<svg width="11" height="13" viewBox="0 0 11 13"><path d="M1 1L10 6.5L1 12V1Z" fill="#fff"/></svg>';
  }

  function _updateMusicProgress() {
    var el = window._amMusicEl;
    var bar = document.getElementById('amMusicBar');
    var timeEl = document.getElementById('amMusicTime');
    if (!el || !bar) return;
    if (el.duration) bar.value = (el.currentTime / el.duration) * 100;
    if (timeEl) {
      var f = function (s) { return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
      timeEl.textContent = f(el.currentTime) + ' / ' + f(el.duration || 0);
    }
  }

  function _setPttUI(active) {
    var btn = document.getElementById('pttBtn');
    if (!btn) return;
    if (active) {
      btn.style.background = 'rgba(255,59,48,0.9)';
      btn.title = '對講中 — 放開停止';
      btn.setAttribute('data-active', '1');
    } else {
      btn.style.background = '';
      btn.title = '對講 (PTT)';
      btn.removeAttribute('data-active');
    }
  }

  // Export singleton
  window.AudioManager = new AudioManager();
  window.AudioManager.PRIORITY = PRIORITY;
})();
