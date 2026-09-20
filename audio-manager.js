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
    // 對講室 (WebRTC)
    this._peer = null;
    this._roomCode = null;
    this._peerCalls = {};
    this._remoteAudios = {};
    this._micStream = null;
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
    if (this._micStream) {
      // WebRTC 模式：開啟麥克風軌道
      this._micStream.getTracks().forEach(function (t) { t.enabled = true; });
      this.state.intercomActive = true;
      _setPttUI(true);
      return;
    }
    // 後備模式（未建立對講室時）
    if (this._intercomStream) return;
    var self = this;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      .then(function (stream) {
        self._intercomStream = stream;
        self.state.intercomActive = true;
        _setPttUI(true);
      })
      .catch(function (err) {
        console.warn('[PTT] 麥克風授權失敗:', err);
        _setPttUI(false);
        alert('請允許麥克風存取權限。');
      });
  };

  AudioManager.prototype.pttStop = function () {
    if (this._micStream) {
      // WebRTC 模式：靜音麥克風軌道（保持串流不中斷）
      this._micStream.getTracks().forEach(function (t) { t.enabled = false; });
      this.state.intercomActive = false;
      _setPttUI(false);
      return;
    }
    if (!this._intercomStream) return;
    this._intercomStream.getTracks().forEach(function (t) { t.stop(); });
    this._intercomStream = null;
    this.state.intercomActive = false;
    _setPttUI(false);
  };

  // ── 對講室 (PeerJS WebRTC) ────────────────────────────────────────────────
  AudioManager.prototype._getMic = function (cb) {
    if (this._micStream) { cb(null, this._micStream); return; }
    var self = this;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      .then(function (stream) {
        stream.getTracks().forEach(function (t) { t.enabled = false; }); // 靜音等待 PTT
        self._micStream = stream;
        cb(null, stream);
      })
      .catch(function (err) { cb(err); });
  };

  AudioManager.prototype.initRoom = function (onReady, onPeerChange) {
    if (this._peer) { if (onReady) onReady(this._roomCode); return; }
    var self = this;
    this._getMic(function (err) {
      if (err) { alert('無法取得麥克風：' + err.message); return; }
      if (typeof Peer === 'undefined') { alert('PeerJS 尚未載入，請稍後再試。'); return; }
      var peer = new Peer({ debug: 0 });
      self._peer = peer;
      self._peerCalls = {};
      self._remoteAudios = {};
      peer.on('open', function (id) {
        self._roomCode = id;
        if (onReady) onReady(id);
      });
      peer.on('call', function (call) {
        call.answer(self._micStream);
        self._setupCall(call, onPeerChange);
      });
      peer.on('error', function (err) { console.warn('[PTT Room] peer error:', err.type, err); });
    });
  };

  AudioManager.prototype._setupCall = function (call, onPeerChange) {
    var self = this;
    var peerId = call.peer;
    self._peerCalls[peerId] = call;
    call.on('stream', function (remoteStream) {
      var audio = self._remoteAudios[peerId];
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        document.body.appendChild(audio);
        self._remoteAudios[peerId] = audio;
      }
      audio.srcObject = remoteStream;
      audio.play().catch(function () {});
      if (onPeerChange) onPeerChange(Object.keys(self._peerCalls));
    });
    call.on('close', function () {
      delete self._peerCalls[peerId];
      var audio = self._remoteAudios[peerId];
      if (audio) { audio.srcObject = null; try { document.body.removeChild(audio); } catch (e) {} delete self._remoteAudios[peerId]; }
      if (onPeerChange) onPeerChange(Object.keys(self._peerCalls));
    });
    call.on('error', function (err) { console.warn('[PTT Room] call error:', err); });
  };

  AudioManager.prototype.joinRoom = function (targetId, onPeerChange) {
    if (!this._peer) { alert('請先開啟對講室'); return; }
    if (!this._micStream) { alert('麥克風尚未準備好'); return; }
    if (targetId === this._roomCode) { alert('不能加入自己的房間'); return; }
    if (this._peerCalls[targetId]) return;
    var call = this._peer.call(targetId, this._micStream);
    this._setupCall(call, onPeerChange);
  };

  AudioManager.prototype.destroyRoom = function () {
    var self = this;
    Object.keys(this._peerCalls || {}).forEach(function (id) { try { self._peerCalls[id].close(); } catch (e) {} });
    Object.keys(this._remoteAudios || {}).forEach(function (id) {
      var a = self._remoteAudios[id];
      try { a.srcObject = null; document.body.removeChild(a); } catch (e) {}
    });
    if (this._peer) { try { this._peer.destroy(); } catch (e) {} this._peer = null; }
    if (this._micStream) { this._micStream.getTracks().forEach(function (t) { t.stop(); }); this._micStream = null; }
    this._peerCalls = {};
    this._remoteAudios = {};
    this._roomCode = null;
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
