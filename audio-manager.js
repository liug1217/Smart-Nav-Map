// AudioManager — Priority-based in-car audio management
// Priority: Emergency(5) > Intercom(4) > NavTTS(3) > Radio(2)
(function () {
  'use strict';

  const PRIORITY = { EMERGENCY: 5, INTERCOM: 4, NAV_TTS: 3, RADIO: 2 };

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
      intercomActive: false,
    };
    this.vol = {
      nav:   parseFloat(localStorage.getItem('am_vol_nav')   || '1.0'),
      radio: parseFloat(localStorage.getItem('am_vol_radio') || '1.0'),
    };
    this._radioWasPlaying = false;
    this._intercomStream = null;
    // 對講室 (WebRTC)
    this._peer = null;
    this._roomCode = null;
    this._peerCalls = {};
    this._peerConns = {};
    this._members = {};
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
  // 房間代碼：6 碼英文大寫+數字（去掉容易看錯的 O/0/I/1）。PeerJS ID = 前綴 + 代碼，避免和其他網站撞號。
  // 多人互通：新加入的人先連房主，房主回傳目前成員名單，新成員再自己連其他成員（舊成員只負責接聽，不會重複連線）。
  // 每條連線同時有「語音 call」與「資料 connection」，資料連線用來交換名字/頭像。
  var PTT_PREFIX = 'zxmap-ptt-';
  var PTT_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function _genCode() {
    var c = '';
    for (var i = 0; i < 6; i++) c += PTT_CHARS[Math.floor(Math.random() * PTT_CHARS.length)];
    return c;
  }
  function _normCode(code) {
    var s = String(code || '').trim();
    if (s.indexOf(PTT_PREFIX) === 0) s = s.slice(PTT_PREFIX.length); // QR 碼或貼上完整 ID 也可以
    return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function _codeOf(peerId) { return String(peerId || '').replace(PTT_PREFIX, ''); }

  // 自己的名字/頭像（存在 localStorage，頭像是縮小過的 dataURL）
  AudioManager.prototype.getProfile = function () {
    var p = null;
    try { p = JSON.parse(localStorage.getItem('ptt_profile') || 'null'); } catch (e) {}
    if (!p || !p.name) {
      p = { name: '駕駛' + Math.floor(100 + Math.random() * 900), avatar: '' };
      try { localStorage.setItem('ptt_profile', JSON.stringify(p)); } catch (e) {}
    }
    return p;
  };
  AudioManager.prototype.setProfile = function (p) {
    var cur = this.getProfile();
    var next = { name: String(p.name || cur.name).slice(0, 12), avatar: p.avatar != null ? p.avatar : cur.avatar };
    try { localStorage.setItem('ptt_profile', JSON.stringify(next)); } catch (e) {}
    this._broadcast({ t: 'profile', p: next });
    this._emitMembers();
    return next;
  };

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

  AudioManager.prototype.inRoom = function () { return !!(this._peer && this._roomCode); };
  AudioManager.prototype.getRoomCode = function () { return this._roomCode; };

  // onReady(code)：房間建立完成；onPeerChange(members)：成員變動，members = [{ id, code, name, avatar }]
  AudioManager.prototype.initRoom = function (onReady, onPeerChange) {
    if (onPeerChange) this._onMembers = onPeerChange;
    if (this._peer) {
      if (this._roomCode) {
        if (onReady) onReady(this._roomCode);
      } else if (onReady) {
        this._pendingReady = (this._pendingReady || []).concat(onReady);
      }
      return;
    }
    var self = this;
    this._pendingReady = onReady ? [onReady] : [];
    this._getMic(function (err) {
      if (err) { self._pendingReady = []; alert('無法取得麥克風：' + err.message); return; }
      if (typeof Peer === 'undefined') { self._pendingReady = []; alert('PeerJS 尚未載入，請稍後再試。'); return; }
      self._createPeer(0);
    });
  };

  AudioManager.prototype._createPeer = function (attempt) {
    var self = this;
    var peer = new Peer(PTT_PREFIX + _genCode(), { debug: 0 });
    self._peer = peer;
    peer.on('open', function (id) {
      self._roomCode = _codeOf(id);
      var cbs = self._pendingReady || []; self._pendingReady = [];
      cbs.forEach(function (cb) { cb(self._roomCode); });
      self._emitMembers();
    });
    peer.on('call', function (call) {
      call.answer(self._micStream);
      self._setupCall(call);
    });
    peer.on('connection', function (conn) { self._setupConn(conn, false); });
    peer.on('error', function (err) {
      console.warn('[PTT Room] peer error:', err.type, err);
      if (err.type === 'unavailable-id' && attempt < 3) { // 代碼剛好被別人用了，換一組
        try { peer.destroy(); } catch (e) {}
        self._createPeer(attempt + 1);
        return;
      }
      if (err.type === 'peer-unavailable') {
        var m = /zxmap-ptt-([A-Z0-9]+)/.exec(err.message || '');
        if (m) self._dropPeer(PTT_PREFIX + m[1]);
        alert('找不到代碼' + (m ? ' ' + m[1] + ' ' : '') + '的房間，請確認代碼是否正確。');
        return;
      }
      if (!self._roomCode) {
        try { peer.destroy(); } catch (e) {}
        self._peer = null;
        self._pendingReady = [];
        alert('對講室連線失敗（' + err.type + '），請稍後再試。');
      }
    });
  };

  AudioManager.prototype._setupCall = function (call) {
    var self = this;
    var peerId = call.peer;
    self._peerCalls[peerId] = call;
    call.on('stream', function (remoteStream) {
      var audio = self._remoteAudios[peerId];
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
        document.body.appendChild(audio);
        self._remoteAudios[peerId] = audio;
      }
      audio.srcObject = remoteStream;
      audio.play().catch(function () {});
      self._emitMembers();
    });
    call.on('close', function () { self._dropPeer(peerId); });
    call.on('error', function (err) { console.warn('[PTT Room] call error:', err); });
  };

  // 資料連線：交換名字/頭像與成員名單。initiated = 這條連線是不是我主動連的
  AudioManager.prototype._setupConn = function (conn, initiated) {
    var self = this;
    var peerId = conn.peer;
    self._peerConns[peerId] = conn;
    conn.on('open', function () {
      conn.send({ t: 'hi', p: self.getProfile(), members: Object.keys(self._peerConns).filter(function (id) { return id !== peerId; }) });
      self._emitMembers();
    });
    conn.on('data', function (msg) {
      if (!msg || typeof msg !== 'object') return;
      if ((msg.t === 'hi' || msg.t === 'profile') && msg.p) {
        self._members[peerId] = {
          name: String(msg.p.name || '').slice(0, 12),
          avatar: typeof msg.p.avatar === 'string' && msg.p.avatar.indexOf('data:image/') === 0 ? msg.p.avatar : ''
        };
        self._emitMembers();
      }
      // 💬 聊天訊息：附上對方目前的名字/頭像交給畫面
      if (msg.t === 'chat' && typeof msg.text === 'string' && self.onChat) {
        var m = self._members[peerId] || {};
        self.onChat({ id: peerId, name: m.name || _codeOf(peerId), avatar: m.avatar || '' }, msg.text.slice(0, 200));
      }
      // 我是新加入的一方：對方告訴我房裡還有誰，我主動去連那些人
      if (msg.t === 'hi' && initiated && Array.isArray(msg.members)) {
        msg.members.forEach(function (id) {
          if (typeof id === 'string' && id.indexOf(PTT_PREFIX) === 0 && id !== self._peer.id && !self._peerConns[id]) self._connectTo(id);
        });
      }
    });
    conn.on('close', function () { self._dropPeer(peerId); });
    conn.on('error', function (err) { console.warn('[PTT Room] data error:', err); });
  };

  AudioManager.prototype._connectTo = function (peerId) {
    var call = this._peer.call(peerId, this._micStream);
    if (call) this._setupCall(call);
    var conn = this._peer.connect(peerId, { reliable: true });
    if (conn) this._setupConn(conn, true);
    return conn;
  };

  AudioManager.prototype._dropPeer = function (peerId) {
    if (!this._peerCalls[peerId] && !this._peerConns[peerId] && !this._members[peerId]) return;
    var call = this._peerCalls[peerId]; delete this._peerCalls[peerId];
    var conn = this._peerConns[peerId]; delete this._peerConns[peerId];
    try { if (call) call.close(); } catch (e) {}
    try { if (conn) conn.close(); } catch (e) {}
    var audio = this._remoteAudios[peerId];
    if (audio) { audio.srcObject = null; try { document.body.removeChild(audio); } catch (e) {} delete this._remoteAudios[peerId]; }
    delete this._members[peerId];
    this._emitMembers();
  };

  AudioManager.prototype._broadcast = function (msg) {
    var conns = this._peerConns || {};
    Object.keys(conns).forEach(function (id) { try { if (conns[id].open) conns[id].send(msg); } catch (e) {} });
  };

  // 💬 傳文字訊息給房內所有人
  AudioManager.prototype.sendChat = function (text) {
    this._broadcast({ t: 'chat', text: String(text || '').slice(0, 200), ts: Date.now() });
  };

  // 目前房內其他成員（有語音或資料連線的人），附上名字/頭像
  AudioManager.prototype.getMembers = function () {
    var self = this;
    var ids = {};
    Object.keys(this._peerCalls).concat(Object.keys(this._peerConns)).forEach(function (id) { ids[id] = 1; });
    return Object.keys(ids).map(function (id) {
      var m = self._members[id] || {};
      return { id: id, code: _codeOf(id), name: m.name || _codeOf(id), avatar: m.avatar || '' };
    });
  };
  AudioManager.prototype._emitMembers = function () {
    if (this._onMembers) this._onMembers(this.getMembers());
  };

  // 以對方的 6 碼代碼加入；資料連線打開（真的連上）時呼叫 onJoined()
  AudioManager.prototype.joinRoom = function (code, onPeerChange, onJoined) {
    if (onPeerChange) this._onMembers = onPeerChange;
    if (!this.inRoom()) { alert('請先啟用麥克風'); return; }
    if (!this._micStream) { alert('麥克風尚未準備好'); return; }
    code = _normCode(code);
    if (code.length !== 6) { alert('代碼是 6 碼英文或數字'); return; }
    if (code === this._roomCode) { alert('不能加入自己的房間'); return; }
    var targetId = PTT_PREFIX + code;
    if (this._peerConns[targetId]) { if (onJoined) onJoined(); return; }
    var conn = this._connectTo(targetId);
    if (conn && onJoined) conn.on('open', onJoined);
  };

  AudioManager.prototype.destroyRoom = function () {
    var self = this;
    Object.keys(this._peerCalls).concat(Object.keys(this._peerConns)).forEach(function (id) { self._dropPeer(id); });
    if (this._peer) { try { this._peer.destroy(); } catch (e) {} this._peer = null; }
    if (this._micStream) { this._micStream.getTracks().forEach(function (t) { t.stop(); }); this._micStream = null; }
    this._peerCalls = {};
    this._peerConns = {};
    this._remoteAudios = {};
    this._members = {};
    this._roomCode = null;
    this.state.intercomActive = false;
    _setPttUI(false);
    this._emitMembers();
  };

  // ── UI helpers ────────────────────────────────────────────────────────────
  // 麥克風按鈕在底部卡片（.pttTalkBtn），說話中加上 data-active 讓樣式亮起來
  function _setPttUI(active) {
    var btns = document.querySelectorAll('.pttTalkBtn');
    for (var i = 0; i < btns.length; i++) {
      if (active) btns[i].setAttribute('data-active', '1');
      else btns[i].removeAttribute('data-active');
    }
    document.dispatchEvent(new CustomEvent('ptt-talking', { detail: { active: !!active } }));
  }

  // Export singleton
  window.AudioManager = new AudioManager();
  window.AudioManager.PRIORITY = PRIORITY;
})();
