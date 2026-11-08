/**
 * JamConnect — WebRTC Signaling Session + Token Auth + Real-Time Acid303 Jam Engine
 * Uses PeerJS signaling server (with custom signaling server option) so QR codes and
 * invite links only carry a compact Session ID + Auth Key Token.
 *
 * JamConnect-Link (see PROTOCOL.md): Ableton Link timeline + control on top of the
 * same protocol, either through a local jamlink-bridge (WebSocket) or relayed by a
 * WebRTC host. Clock sync uses Link's measurement algorithm.
 */
//
// Configuration: every tunable lives in jamconnect.config.json (same shape as below).
// Load it with JamConnector.loadConfig() / JamConnector.configure(), or pass
// { config } to the constructor. These fallbacks only keep existing JamConnect apps
// (which pass no config) working exactly as before.
const JAMCONNECT_FALLBACK_CONFIG = {
  bridge: { bind: '127.0.0.1', port: 20809, quantum: 4, tempoMin: 20, tempoMax: 999 },
  client: {
    appName: 'JamConnect',
    bridgeUrl: '',
    bridgeToken: '',
    followLink: true,
    quantum: 4,
    tempoMin: 20,
    tempoMax: 999,
    bridgeConnectTimeoutMs: 6000,
    joinTimeoutMs: 12000,
    guestAuthTimeoutMs: 6000,
    pingIntervalMs: 10000,
    heartbeatIntervalMs: 10000,
    hostStateIntervalMs: 250,
    followIntervalMs: 50,
    followMaxDriftMs: 8,
    paramChangeBufferMs: 30,
    // Original JamConnect (Tone.js transport) timing knobs
    legacy: { rejectCloseDelayMs: 150, clockSamples: 8 },
    // Link measurement: data points per burst, median (ableton/link/Measurement.hpp)
    // ableton/link: Measurement.hpp kNumberDataPoints, kNumberMeasurements, 50 ms ping timer; Sessions.hpp 30 s remeasure
    linkClock: { numberDataPoints: 100, numberMeasurements: 5, pingTimeoutMs: 50, remeasureMs: 30000 }
  },
  webrtc: {
    peerPrefix: 'jam-',
    sessionPrefix: 'JAM-',
    sessionCodeLength: 4,
    guestCodeLength: 5,
    tokenLength: 8,
    codeAlphabet: '23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
    tokenAlphabet: '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz',
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ],
    signal: {}
  },
  runtime: {}
};

function jamIsObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function jamMergeConfig(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = jamIsObject(v) && jamIsObject(base[k]) ? jamMergeConfig(base[k], v) : v;
  }
  return out;
}

let JAMCONNECT_CONFIG = jamMergeConfig(
  JAMCONNECT_FALLBACK_CONFIG,
  (typeof globalThis !== 'undefined' && globalThis.JAMCONNECT_CONFIG) || {}
);

/** Bridge WebSocket URL from config: explicit client.bridgeUrl, the page that served us, or bridge bind/port. */
function jamBridgeUrl(cfg = JAMCONNECT_CONFIG) {
  if (cfg.client && cfg.client.bridgeUrl) return cfg.client.bridgeUrl;
  if (cfg.runtime && cfg.runtime.servedByBridge && typeof location !== 'undefined') {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  }
  const bind = cfg.bridge.bind === '0.0.0.0' || cfg.bridge.bind === '::' ? '127.0.0.1' : cfg.bridge.bind;
  return `ws://${bind}:${cfg.bridge.port}`;
}

const BRIDGE_PEER_ID = 'BRIDGE';
// Messages that are point-to-point and never relayed between hops.
const JAM_LOCAL_MESSAGE_TYPES = new Set([
  'AUTH_HELLO', 'AUTH_OK', 'AUTH_REJECTED', 'PING', 'PONG', 'CLOCK_SYNC',
  'PEER_LIST', 'PERMISSIONS_UPDATE', 'LINK_PING', 'LINK_PONG', 'LINK_STATE'
]);

/**
 * Permission a WebRTC guest needs before the host relays its LIVE_* / M4L_* request
 * to the bridge (null = read-only request, always allowed). See PROTOCOL.md.
 */
function jamRemoteControlPermission(msg) {
  const t = msg && msg.type;
  if (typeof t !== 'string' || !(t.startsWith('LIVE_') || t.startsWith('M4L_'))) return null;
  if (/^LIVE_(GET_|OBSERVE$|UNOBSERVE$)/.test(t) || /^M4L_(DISCOVER|GET_STATUS|LIST_MAPPINGS)$/.test(t)) return null;
  if (t === 'LIVE_SET_SONG' && msg.prop === 'tempo') return 'syncMasterSettings';
  if (t === 'LIVE_SET_SONG' && msg.prop === 'is_playing') return 'syncTransport';
  if (t === 'LIVE_SONG_ACTION' && ['start', 'stop', 'continue'].includes(msg.action)) return 'syncTransport';
  if (['LIVE_SET_PARAM', 'LIVE_SET_DEVICE_ACTIVE', 'M4L_SET_MACRO', 'M4L_MAP_MACRO', 'M4L_UNMAP_MACRO'].includes(t)) return 'syncDeviceParameterChange';
  if (['M4L_NOTE', 'M4L_CC', 'M4L_SET_MIDI_FORWARD'].includes(t)) return 'syncMidi';
  return 'syncLiveControl';
}

function nowUs() {
  return performance.now() * 1000;
}

function linkMedian(values) {
  const v = values.slice().sort((a, b) => a - b);
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

/**
 * Estimates offset = remoteClock - localClock (µs) towards one upstream node,
 * following ableton/link/Measurement.hpp exactly:
 *  - the next ping goes out as soon as a pong arrives (Measurement.hpp:181);
 *  - two data points per pong (lines 185-194), the measurement finishes once there are
 *    more than kNumberDataPoints (line 197), and the result is their median
 *    (MeasurementService.hpp:171);
 *  - if no pong arrives within the ping timeout, a fresh ping (host time only) is sent;
 *    after kNumberMeasurements timeouts the measurement fails (lines 46, 113-135);
 *  - the session is measured again periodically (Sessions.hpp:186).
 * Values come from client.linkClock (shipped with Link's constants).
 */
class JamLinkClock {
  constructor(send, options = JAMCONNECT_CONFIG.client.linkClock) {
    this._send = send;
    this._opts = { ...JAMCONNECT_CONFIG.client.linkClock, ...options };
    this._data = [];
    this._rtts = [];
    this._timer = null;
    this._pingTimer = null;
    this._timeouts = 0;
    this._measuring = false;
    this.offsetUs = 0;
    this.rttUs = 0; // median round trip of the last measurement (used for latency, not for the offset)
    this.ready = false;
    this.measurements = 0;
    this.failures = 0;
    this.onUpdate = null;
  }

  start() {
    this.stop();
    this._measure();
    this._timer = setInterval(() => this._measure(), this._opts.remeasureMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._pingTimer) clearTimeout(this._pingTimer);
    this._timer = null;
    this._pingTimer = null;
    this._measuring = false;
  }

  _measure() {
    if (this._pingTimer) clearTimeout(this._pingTimer);
    this._data = [];
    this._rtts = [];
    this._timeouts = 0;
    this._measuring = true;
    this._send({ type: 'LINK_PING', ht: nowUs(), pgt: 0 });
    this._resetTimer();
  }

  // Measurement.hpp resetTimer(): on timeout send a new ping (host time only) until
  // kNumberMeasurements timeouts, then fail. The count is not reset by pongs, as in Link.
  _resetTimer() {
    if (this._pingTimer) clearTimeout(this._pingTimer);
    this._pingTimer = setTimeout(() => {
      if (!this._measuring) return;
      if (this._timeouts < this._opts.numberMeasurements) {
        this._send({ type: 'LINK_PING', ht: nowUs(), pgt: 0 });
        this._timeouts++;
        this._resetTimer();
      } else {
        this._fail();
      }
    }, this._opts.pingTimeoutMs);
  }

  _fail() {
    this._measuring = false;
    this.failures++;
    // Keep the previous estimate; with none yet, measure again right away
    // (Link drops a failed session's measurement and starts over).
    if (!this.ready) this._measure();
  }

  handlePong(msg) {
    if (!this._measuring) return;
    const hostTime = nowUs();
    const gt = Number(msg.gt) || 0;
    const prevHostTime = Number(msg.ht) || 0;
    const prevGhostTime = Number(msg.pgt) || 0;
    // Next ping right away, carrying the ghost time just received (Measurement.hpp:178-181).
    this._send({ type: 'LINK_PING', ht: hostTime, pgt: gt });
    if (gt && prevHostTime) {
      this._data.push(gt - (hostTime + prevHostTime) / 2);
      this._rtts.push(hostTime - prevHostTime);
      if (prevGhostTime) this._data.push((gt + prevGhostTime) / 2 - prevHostTime);
    }
    if (this._data.length > this._opts.numberDataPoints) {
      this._finish();
    } else {
      this._resetTimer();
    }
  }

  _finish() {
    this._measuring = false;
    if (this._pingTimer) clearTimeout(this._pingTimer);
    this._pingTimer = null;
    this.offsetUs = linkMedian(this._data);
    this.rttUs = linkMedian(this._rtts);
    this.measurements++;
    this.ready = true;
    if (this.onUpdate) this.onUpdate(this.offsetUs);
  }

  toLocalUs(remoteUs) { return remoteUs - this.offsetUs; }
  toRemoteUs(localUs) { return localUs + this.offsetUs; }
}

/**
 * Link timeline in the local clock: beat(t) = beat + (t - atUs) * tempo / 60e6.
 * Mirrors ableton::link::Timeline + StartStopState.
 */
class JamLinkTimeline {
  // No default tempo: it comes from the Link session (bridge), the host, or the app.
  constructor(bpm = null, quantum = JAMCONNECT_CONFIG.client.quantum,
    tempoRange = { min: JAMCONNECT_CONFIG.client.tempoMin, max: JAMCONNECT_CONFIG.client.tempoMax }) {
    this.tempoRange = tempoRange;
    this.tempo = this.validTempo(bpm) ? bpm : null;
    this.beat = 0;
    this.atUs = nowUs();
    this.quantum = quantum;
    this.isPlaying = false;
    this.playTimeUs = this.atUs;
    this.playBeat = 0;
    this.numPeers = 0;
    this.linkEnabled = false;
    this.startStopSync = false;
    this.source = null; // 'bridge' | 'host' | null (no timeline yet)
  }

  get hasTempo() { return this.tempo !== null; }
  validTempo(bpm) { return typeof bpm === 'number' && bpm >= this.tempoRange.min && bpm <= this.tempoRange.max; }
  beatAtTime(us) { return this.hasTempo ? this.beat + (us - this.atUs) * this.tempo / 60e6 : this.beat; }
  phaseAtTime(us, q = this.quantum) {
    const b = this.beatAtTime(us);
    return ((b % q) + q) % q;
  }
  timeAtBeat(beat) { return this.hasTempo ? this.atUs + (beat - this.beat) * 60e6 / this.tempo : this.atUs; }
  songBeatAtTime(us) { return this.beatAtTime(us) - this.playBeat; }

  // ---- authority operations (used when this node owns the timeline) ----
  setTempo(bpm, atUs = nowUs()) {
    if (!this.validTempo(bpm)) return;
    this.beat = this.beatAtTime(atUs);
    this.atUs = atUs;
    this.tempo = bpm;
  }

  setPlaying(playing, atUs = nowUs(), quantum = this.quantum, quantize = false) {
    if (playing === this.isPlaying || !this.hasTempo) return;
    this.isPlaying = playing;
    if (playing) {
      if (quantize) {
        // Link requestBeatAtTime with peers: start at the next quantum boundary.
        const b = this.beatAtTime(atUs);
        const startBeat = Math.ceil(b / quantum) * quantum;
        this.playTimeUs = this.timeAtBeat(startBeat);
        this.playBeat = startBeat;
      } else {
        this.beat = 0;
        this.atUs = atUs;
        this.playTimeUs = atUs;
        this.playBeat = 0;
      }
    } else {
      this.playTimeUs = atUs;
      this.playBeat = this.beatAtTime(atUs);
    }
  }

  // ---- wire format: times expressed in the sender's clock ----
  applyWire(msg, clock) {
    const toLocal = (us) => (clock ? clock.toLocalUs(us) : us);
    const tempo = Number(msg.tempo);
    if (this.validTempo(tempo)) this.tempo = tempo;
    this.beat = Number(msg.beat) || 0;
    this.atUs = toLocal(Number(msg.atUs) || 0);
    this.quantum = Number(msg.quantum) || this.quantum;
    this.isPlaying = !!msg.isPlaying;
    this.playTimeUs = toLocal(Number(msg.playTimeUs) || 0);
    this.playBeat = Number(msg.playBeat) || 0;
    this.numPeers = Number(msg.numPeers) || 0;
    this.linkEnabled = !!msg.linkEnabled;
    this.startStopSync = !!msg.startStopSync;
    this.source = msg.source || 'bridge';
  }

  toWire() {
    const t = nowUs();
    return {
      type: 'LINK_STATE',
      tempo: this.tempo,
      beat: this.beatAtTime(t),
      atUs: t,
      quantum: this.quantum,
      phase: this.phaseAtTime(t),
      isPlaying: this.isPlaying,
      playTimeUs: this.playTimeUs,
      playBeat: this.playBeat,
      numPeers: this.numPeers,
      linkEnabled: this.linkEnabled,
      startStopSync: this.startStopSync,
      source: this.source || 'host'
    };
  }

  snapshot(us = nowUs()) {
    return {
      tempo: this.tempo,
      beat: this.beatAtTime(us),
      phase: this.phaseAtTime(us),
      songBeat: this.songBeatAtTime(us),
      quantum: this.quantum,
      isPlaying: this.isPlaying,
      playTimeUs: this.playTimeUs,
      numPeers: this.numPeers,
      linkEnabled: this.linkEnabled,
      startStopSync: this.startStopSync,
      source: this.source
    };
  }
}

/**
 * WebSocket transport to a jamlink-bridge with the same surface as a PeerJS
 * DataConnection (on/send/close/open), so the guest code path is shared.
 */
class LocalBridgeConnection {
  constructor(url = jamBridgeUrl(), metadata = {}) {
    this.peer = BRIDGE_PEER_ID;
    this.url = url;
    this.metadata = metadata;
    this.open = false;
    this._handlers = {};
    const WS = (typeof WebSocket !== 'undefined') ? WebSocket : null;
    if (!WS) throw new Error('WebSocket is not available in this environment');
    this._ws = new WS(url);
    this._ws.onopen = () => { this.open = true; this._emit('open'); };
    this._ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_) { return; }
      this._emit('data', msg);
    };
    this._ws.onclose = () => {
      const wasOpen = this.open;
      this.open = false;
      this._emit('close', wasOpen);
    };
    this._ws.onerror = () => { this._emit('error', new Error(`Cannot reach JamLink bridge at ${url}`)); };
  }

  on(event, fn) {
    (this._handlers[event] = this._handlers[event] || []).push(fn);
    return this;
  }

  _emit(event, arg) {
    for (const fn of this._handlers[event] || []) {
      try { fn(arg); } catch (err) { console.error('[LocalBridgeConnection]', err); }
    }
  }

  send(obj) {
    if (this.open) this._ws.send(JSON.stringify(obj));
  }

  close() {
    try { this._ws.close(); } catch (_) {}
  }
}

function generateRandomCode(length, alphabet = JAMCONNECT_CONFIG.webrtc.codeAlphabet) {
  const bytes = new Uint8Array(length);
  const cryptoApi = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoApi && cryptoApi.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

class JamConnector {
  constructor(appName, toneInstance, options = {}) {
    this.appName = appName;
    this.Tone = toneInstance;
    this.isHost = false;
    // Per-instance config = global config (jamconnect.config.json) + options.config overrides.
    this.config = jamMergeConfig(JAMCONNECT_CONFIG, options.config || {});
    // Optional custom PeerJS host/port/path/key (options.signalConfig kept for compatibility)
    this.signalConfig = { ...(this.config.webrtc.signal || {}), ...(options.signalConfig || {}) };
    this.logger = new Logger(this);
    this.enableLogging = options.enableLogging || false;
    this.logger.log("JamConnector: Logging = " + this.enableLogging);
    
    // Session credentials (only thing needed in QR code / URL link)
    this.sessionId = null;
    this.authToken = null;
    this.peer = null;

    // Host state: Map<peerId, { conn, authenticated, name, rtt, timeOffset, samples }>
    this.peers = new Map();

    // Guest state
    this.hostConn = null;
    this.isConnectedToHost = false;
    this.timeOffset = 0; // ms difference: hostClock - localClock
    this.rtt = 0;

    // Sync permissions / flags
    this.permissions = {
      syncTransport: true,
      syncMasterSettings: true,
      syncPattern: false,
      syncDeviceParameterChange: false,
      syncMidi: true,
      syncLiveControl: true   // guest LIVE_* / M4L_* requests (clips, mixer, song, ...)
    };

    this._pingInterval = null;
    this._heartbeatInterval = null;
    this._paramChangeBuffer = [];
    this._lastParamChangeTime = performance.now();
    
    // Event listener callbacks
    this.onSessionCreated = null;      // ({ sessionId, authToken, inviteUrl })
    this.onPeerConnected = null;       // (peerId, peersList)
    this.onPeerDisconnected = null;    // (peerId, peersList)
    this.onConnectionStateChange = null; // (statusObj)
    this.onAuthError = null;           // (reason)
    this.onPadTriggered = null;        // (instrument, note, velocity, scheduledTime, extra)
    this.onPatternUpdated = null;      // (pattern, stepIndex, stepData)
    this.onPatternStepUpdated = null;  
    this.onDeviceParameterChanged = null;   // (paramName, value, rawParams)
    this.onMasterSettingUpdated = null;  // (settingName, value)
    this.onMidiMessage = null;         // (appName, midiEvent, rawMessage)
    this.onPermissionsUpdated = null;  // (permissions)
    this.getFullStateSnapshot = null;  // () => ({ pattern, params, bpm, swing, delayWet, isPlaying, step })
    this.applyFullStateSnapshot = null; // (snapshot) => void

    // JamConnect-Link
    this.transport = 'webrtc';          // 'webrtc' | 'local' (guest of a jamlink-bridge)
    this.bridgeConn = null;             // host-side upstream to a local bridge (attachLocalBridge)
    this.bridgeUrl = null;
    this.linkTimeline = new JamLinkTimeline(options.bpm, options.quantum || this.config.client.quantum,
      { min: this.config.client.tempoMin, max: this.config.client.tempoMax });
    this.linkClocks = new Map();        // upstream peerId -> JamLinkClock
    this.followLink = options.followLink !== undefined ? !!options.followLink : !!this.config.client.followLink; // drive Tone.Transport from the Link timeline
    this.adoptTransportTempo = options.adoptTransportTempo !== false; // host w/o bridge: start from the app's Tone tempo
    this._linkHostTimer = null;
    this._linkFollowTimer = null;
    this.onLinkStateUpdated = null;     // (snapshot) => void
    this.onLinkClockUpdated = null;     // ({ peerId, offsetUs }) => void
    this.onBridgeStateChange = null;    // ({ status, url, message }) => void
    this.onRelayMessage = null;         // (msg, senderId) => void, for app-specific messages (LIVE_*, ...)
  }

  // ==========================================
  // CONFIGURATION
  // ==========================================

  /** Replace the global configuration (affects connectors created afterwards). */
  static configure(config) {
    JAMCONNECT_CONFIG = jamMergeConfig(JAMCONNECT_FALLBACK_CONFIG, config || {});
    return JAMCONNECT_CONFIG;
  }

  /** Fetch jamconnect.config.json (served by the bridge or deployed with the app) and apply it. */
  static async loadConfig(url = 'jamconnect.config.json') {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Cannot load ${url}: HTTP ${res.status}`);
    return JamConnector.configure(await res.json());
  }

  static get config() { return JAMCONNECT_CONFIG; }

  bridgeUrlFromConfig() { return jamBridgeUrl(this.config); }

  // ==========================================
  // SESSION LINK & CREDENTIAL HELPERS
  // ==========================================

  buildInviteUrl(sessionId = this.sessionId, authToken = this.authToken) {
    if (!sessionId || !authToken) return '';
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionId);
    url.searchParams.set('token', authToken);
    url.hash = '';
    return url.toString();
  }

  /**
   * Parses an invite input which can be:
   * 1. A full URL: https://.../?session=303-ABCD&token=XYZ12345
   * 2. Compact string: 303-ABCD:XYZ12345 or 303-ABCD?token=XYZ12345
   * 3. JSON string: {"sessionId":"...","authToken":"..."}
   */
  static parseInviteInput(input, fallbackToken = '') {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();

    // Case 1: URL with searchParams
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.includes('?session=')) {
      try {
        const url = new URL(trimmed, window.location.origin);
        const sessionId = url.searchParams.get('session') || url.searchParams.get('s');
        const authToken = url.searchParams.get('token') || url.searchParams.get('t') || fallbackToken;
        if (sessionId && authToken) {
          return { sessionId: sessionId.trim().toUpperCase(), authToken: authToken.trim() };
        }
      } catch (_) {}
    }

    // Case 2: JSON payload
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj.sessionId && obj.authToken) {
          return { sessionId: String(obj.sessionId).toUpperCase(), authToken: String(obj.authToken) };
        }
      } catch (_) {}
    }

    // Case 3: Compact "SESSION_ID:AUTH_TOKEN" or "SESSION_ID/AUTH_TOKEN"
    const sepMatch = trimmed.match(/^([A-Za-z0-9-]+)[:/|,\s]+([A-Za-z0-9]+)$/);
    if (sepMatch) {
      return {
        sessionId: sepMatch[1].trim().toUpperCase(),
        authToken: sepMatch[2].trim()
      };
    }

    // Case 4: Session ID + separate fallback token
    if (fallbackToken && trimmed.length >= 3) {
      return {
        sessionId: trimmed.toUpperCase(),
        authToken: fallbackToken.trim()
      };
    }

    return null;
  }

  // ==========================================
  // HOST METHODS (SIGNALING SERVER + AUTH TOKEN)
  // ==========================================

  /**
   * Creates a new WebRTC Jam Session registered on the signaling server.
   * Returns { sessionId, authToken, inviteUrl } — tiny payload ideal for QR & links!
   */
  async createHostSession(existingSessionId = null, existingAuthToken = null) {
    this.disconnect();
    this.isHost = true;

    const rtc = this.config.webrtc;
    this.sessionId = existingSessionId || `${rtc.sessionPrefix}${generateRandomCode(rtc.sessionCodeLength, rtc.codeAlphabet)}`;
    this.authToken = existingAuthToken || generateRandomCode(rtc.tokenLength, rtc.tokenAlphabet);
    const fullPeerId = `${rtc.peerPrefix}${this.sessionId}`;

    this._emitConnectionState('connecting', 'Registering session on signaling server...');

    return new Promise((resolve, reject) => {
      const peerOptions = {
        debug: 1,
        config: { iceServers: this.config.webrtc.iceServers },
        ...this.signalConfig
      };

      const peer = new Peer(fullPeerId, peerOptions);
      this.peer = peer;

      let settled = false;

      peer.on('open', () => {
        settled = true;
        const inviteUrl = this.buildInviteUrl(this.sessionId, this.authToken);
        this._startHostTimers();
        if (!this.hasBridge) this._becomeLinkAuthority();
        this._emitConnectionState('hosting', `Session ${this.sessionId} active`);
        if (this.onSessionCreated) {
          this.onSessionCreated({
            sessionId: this.sessionId,
            authToken: this.authToken,
            inviteUrl
          });
        }
        resolve({
          sessionId: this.sessionId,
          authToken: this.authToken,
          inviteUrl
        });
      });

      peer.on('connection', (conn) => {
        this._handleIncomingGuestConnection(conn);
      });

      peer.on('disconnected', () => {
        // Auto-reconnect to signaling server if still hosting
        if (this.isHost && this.peer && !this.peer.destroyed) {
          try {
            this.peer.reconnect();
          } catch (_) {}
        }
      });

      peer.on('error', (err) => {
        this.logger.error('[JamConnector Host Error]', err);
        if (!settled) {
          if (err && err.type === 'unavailable-id') {
            // Session ID collision: retry with a fresh random ID
            peer.destroy();
            this.createHostSession(null, this.authToken).then(resolve).catch(reject);
            return;
          }
          settled = true;
          this._emitConnectionState('error', err.message || 'Signaling error');
          reject(err);
        }
      });
    });
  }

  /**
   * Backward-compatible wrapper returning the short invite URL for QR encoding.
   */
  async prepareGuestInvitation() {
    if (this.isHost && this.peer && !this.peer.destroyed && this.sessionId && this.authToken) {
      return this.buildInviteUrl(this.sessionId, this.authToken);
    }
    const { inviteUrl } = await this.createHostSession();
    return inviteUrl;
  }

  _handleIncomingGuestConnection(conn) {
    const peerId = conn.peer || ('guest_' + generateRandomCode(this.config.webrtc.guestCodeLength, this.config.webrtc.codeAlphabet));
    const metaToken = conn.metadata && conn.metadata.authToken;
    const guestName = (conn.metadata && conn.metadata.name) || `Jammer-${peerId.slice(-4)}`;
    const guestAppName = (conn.metadata && conn.metadata.appName) || 'unknown';
    const peerRecord = {
      id: peerId,
      name: guestName,
      appName: guestAppName,
      conn,
      authenticated: false,
      rtt: 0,
      timeOffset: 0,
      samples: []
    };

    // Verify metadata token immediately if provided
    if (metaToken && metaToken === this.authToken) {
      peerRecord.authenticated = true;
    }

    this.peers.set(peerId, peerRecord);

    // Timeout unauthenticated connections after 6 seconds
    const authTimeout = setTimeout(() => {
      const p = this.peers.get(peerId);
      if (p && !p.authenticated) {
        this._sendTo(conn, { type: 'AUTH_REJECTED', reason: 'Authentication timeout' });
        conn.close();
        this.peers.delete(peerId);
      }
    }, this.config.client.guestAuthTimeoutMs);

    conn.on('open', () => {
      if (peerRecord.authenticated) {
        clearTimeout(authTimeout);
        this._completeGuestAuth(peerRecord);
      }
    });

    conn.on('data', (raw) => {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!peerRecord.authenticated) {
        if (msg && msg.type === 'AUTH_HELLO' && msg.authToken === this.authToken) {
          peerRecord.authenticated = true;
          if (msg.name) peerRecord.name = msg.name;
          clearTimeout(authTimeout);
          this._completeGuestAuth(peerRecord);
        } else {
          clearTimeout(authTimeout);
          this._sendTo(conn, { type: 'AUTH_REJECTED', reason: 'Invalid session auth token' });
          setTimeout(() => conn.close(), this.config.client.legacy.rejectCloseDelayMs);
          this.peers.delete(peerId);
        }
        return;
      }
      this._routeMessage(msg, peerId);
    });

    const cleanup = () => {
      clearTimeout(authTimeout);
      const existed = this.peers.delete(peerId);
      if (existed) {
        this._broadcastPeerList();
        if (this.onPeerDisconnected) {
          this.onPeerDisconnected(peerId, this.getConnectedPeersList());
        }
        this._emitConnectionState('hosting', `Session ${this.sessionId} (${this.getConnectedPeersList().length} joined)`);
      }
    };

    conn.on('close', cleanup);
    conn.on('error', cleanup);
  }

  _completeGuestAuth(peerRecord) {
    const { conn, id } = peerRecord;
    const snapshot = this.getFullStateSnapshot ? this.getFullStateSnapshot() : null;

    this._sendTo(conn, {
      type: 'AUTH_OK',
      sessionId: this.sessionId,
      peerId: id,
      permissions: this.permissions,
      snapshot,
      hostAppName: this.appName,
      hostTime: performance.now(),
      hostAudioTime: this.Tone.now(),
      transportState: this.Tone.Transport.state,
      bpm: this.Tone.Transport.bpm.value,
      swing: this.Tone.Transport.swing,
      ticks: this.Tone.Transport.ticks,
      seconds: this.Tone.Transport.seconds
    });

    this._measureClockOffset(conn);
    if (this.linkTimeline.source && this.linkTimeline.hasTempo) {
      this._sendTo(conn, this.linkTimeline.toWire());
    }
    this._broadcastPeerList();

    if (this.onPeerConnected) {
      this.onPeerConnected(id, this.getConnectedPeersList());
    }
    this._emitConnectionState('hosting', `Session ${this.sessionId} (${this.getConnectedPeersList().length} joined)`);
  }

  // ==========================================
  // GUEST METHODS
  // ==========================================

  /**
   * Connects to a Host session using either an invite URL, "sessionId:token", or (sessionId, authToken).
   */
  async joinHost(inviteInput, explicitToken = '', guestName = '') {
    const parsed = JamConnector.parseInviteInput(inviteInput, explicitToken);
    if (!parsed || !parsed.sessionId || !parsed.authToken) {
      throw new Error('Invalid session link or auth key token.');
    }

    this.disconnect();
    this.isHost = false;
    this.sessionId = parsed.sessionId;
    this.authToken = parsed.authToken;

    const rtc = this.config.webrtc;
    const targetHostPeerId = `${rtc.peerPrefix}${this.sessionId}`;
    const myGuestId = `${rtc.peerPrefix}guest-${generateRandomCode(rtc.guestCodeLength, rtc.codeAlphabet)}`;

    this._emitConnectionState('connecting', `Joining session ${this.sessionId}...`);

    return new Promise((resolve, reject) => {
      const peerOptions = {
        debug: 1,
        config: { iceServers: this.config.webrtc.iceServers },
        ...this.signalConfig
      };

      const peer = new Peer(myGuestId, peerOptions);
      this.peer = peer;
      let settled = false;

      const connectTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.disconnect();
          const err = new Error('Connection timed out. Verify the Session ID is active.');
          this._emitConnectionState('error', err.message);
          reject(err);
        }
      }, this.config.client.joinTimeoutMs);

      peer.on('open', () => {
        const name = guestName || `${this.appName}-${myGuestId.slice(-4)}`;
        const conn = peer.connect(targetHostPeerId, {
          reliable: true,
          serialization: 'json',
          metadata: {
            authToken: this.authToken,
            name,
            appName: this.appName
          }
        });

        this._wireHostConnection(conn, name, {
          resolve: (v) => { if (!settled) { settled = true; clearTimeout(connectTimeout); resolve(v); } },
          reject: (e) => { if (!settled) { settled = true; clearTimeout(connectTimeout); reject(e); } },
          clearTimeout: () => clearTimeout(connectTimeout)
        });
      });

      peer.on('error', (err) => {
        clearTimeout(connectTimeout);
        this.logger.warn('[JamConnector Guest Error]', err);
        const friendlyMsg = err.type === 'peer-unavailable'
          ? `Session "${this.sessionId}" not found or Host is offline.`
          : (err.message || 'Could not connect to session');
        this._emitConnectionState('error', friendlyMsg);
        if (!settled) {
          settled = true;
          reject(new Error(friendlyMsg));
        }
      });
    });
  }

  /**
   * Shared guest-side handling of the connection to our upstream host
   * (a PeerJS DataConnection or a LocalBridgeConnection).
   */
  _wireHostConnection(conn, name, done) {
    this.hostConn = conn;

    conn.on('open', () => {
      this._sendTo(conn, {
        type: 'AUTH_HELLO',
        authToken: this.authToken,
        name,
        appName: this.appName
      });
    });

    conn.on('data', (raw) => {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!msg) return;

      if (msg.type === 'AUTH_REJECTED') {
        const err = new Error(msg.reason || 'Invalid Auth Key Token');
        this._emitConnectionState('error', err.message);
        if (this.onAuthError) this.onAuthError(err.message);
        this.disconnect();
        done.reject(err);
        return;
      }

      if (msg.type === 'AUTH_OK') {
        done.clearTimeout();
        this.isConnectedToHost = true;
        if (msg.sessionId) this.sessionId = msg.sessionId;
        if (msg.permissions) {
          this.permissions = { ...this.permissions, ...msg.permissions };
          if (this.onPermissionsUpdated) this.onPermissionsUpdated(this.permissions);
        }
        if (msg.snapshot && this.applyFullStateSnapshot) {
          this.applyFullStateSnapshot(msg.appName, msg.snapshot);
        }
        this._applyTransportSync(msg);
        this._startLinkClock('HOST', conn);
        if (msg.link) this._handleLinkState(msg.link, 'HOST');
        this._emitConnectionState('connected', `Connected to ${this.sessionId}`);
        if (this.onPeerConnected) {
          this.onPeerConnected('HOST', [{ id: 'HOST', name: msg.hostAppName || 'Host', rtt: this.rtt }]);
        }
        done.resolve({ sessionId: this.sessionId });
        return;
      }

      this._routeMessage(msg, 'HOST');
    });

    const handleDisconnect = () => {
      done.clearTimeout();
      if (this.hostConn !== conn) return;
      const wasConnected = this.isConnectedToHost;
      this.isConnectedToHost = false;
      this.hostConn = null;
      this._stopLinkClock('HOST');
      this._emitConnectionState('disconnected', 'Disconnected from Host');
      if (wasConnected && this.onPeerDisconnected) {
        this.onPeerDisconnected('HOST', []);
      }
      done.reject(new Error('Connection closed by Host'));
    };

    conn.on('close', handleDisconnect);
    conn.on('error', handleDisconnect);
  }

  /**
   * LOCAL mode: join a jamlink-bridge on this machine (or LAN) as a JamConnect guest.
   * The bridge is a real Ableton Link peer; tempo/beat/start-stop come from Link.
   */
  async joinLocalBridge(url = this.bridgeUrlFromConfig(), authToken = this.config.client.bridgeToken, guestName = '') {
    this.disconnect();
    this.isHost = false;
    this.transport = 'local';
    this.bridgeUrl = url;
    this.sessionId = 'LINK';
    this.authToken = authToken || '';
    const name = guestName || `${this.appName}-${generateRandomCode(this.config.webrtc.sessionCodeLength, this.config.webrtc.codeAlphabet)}`;

    this._emitConnectionState('connecting', `Connecting to JamLink bridge ${url}...`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.disconnect();
        const err = new Error(`JamLink bridge at ${url} did not answer`);
        this._emitConnectionState('error', err.message);
        reject(err);
      }, this.config.client.bridgeConnectTimeoutMs);

      let conn;
      try {
        conn = new LocalBridgeConnection(url, { authToken: this.authToken, name, appName: this.appName });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }
      conn.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this._emitConnectionState('error', err.message);
          reject(err);
        }
      });
      this._wireHostConnection(conn, name, {
        resolve: (v) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(v); } },
        reject: (e) => { if (!settled) { settled = true; clearTimeout(timeout); reject(e); } },
        clearTimeout: () => clearTimeout(timeout)
      });
    });
  }

  /**
   * WEBRTC mode (host side): connect this host to a local jamlink-bridge so remote
   * WebRTC guests get the Ableton Link timeline and can control Live.
   * Call after createHostSession() (which resets connections).
   */
  async attachLocalBridge(url = this.bridgeUrlFromConfig(), authToken = this.config.client.bridgeToken) {
    this.detachLocalBridge();
    this.bridgeUrl = url;
    const name = `${this.appName}-host`;
    this._emitBridgeState('connecting', `Connecting to ${url}...`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const conn = new LocalBridgeConnection(url, { authToken, name, appName: this.appName });
      this.bridgeConn = conn;
      const timeout = setTimeout(() => fail(new Error(`JamLink bridge at ${url} did not answer`)), this.config.client.bridgeConnectTimeoutMs);
      const fail = (err) => {
        clearTimeout(timeout);
        if (this.bridgeConn === conn) this.detachLocalBridge();
        this._emitBridgeState('error', err.message);
        if (!settled) { settled = true; reject(err); }
      };

      conn.on('open', () => {
        conn.send({ type: 'AUTH_HELLO', authToken, name, appName: this.appName });
      });
      conn.on('data', (msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === 'AUTH_REJECTED') { fail(new Error(msg.reason || 'Bridge rejected token')); return; }
        if (msg.type === 'AUTH_OK') {
          clearTimeout(timeout);
          this._startLinkClock(BRIDGE_PEER_ID, conn);
          if (msg.link) this._handleLinkState(msg.link, BRIDGE_PEER_ID);
          this._emitBridgeState('connected', `Linked via ${url}`);
          if (!settled) { settled = true; resolve({ url }); }
          return;
        }
        this._routeMessage(msg, BRIDGE_PEER_ID);
      });
      conn.on('error', (err) => fail(err));
      conn.on('close', () => {
        if (this.bridgeConn !== conn) return;
        this.bridgeConn = null;
        this._stopLinkClock(BRIDGE_PEER_ID);
        this._emitBridgeState('disconnected', 'Bridge disconnected');
        if (this.isHost) this._becomeLinkAuthority();
        if (!settled) { settled = true; reject(new Error('Bridge closed the connection')); }
      });
    });
  }

  detachLocalBridge() {
    if (this.bridgeConn) {
      const conn = this.bridgeConn;
      this.bridgeConn = null;
      try { conn.close(); } catch (_) {}
      this._stopLinkClock(BRIDGE_PEER_ID);
      this._emitBridgeState('idle', 'Bridge detached');
      // Keep guests on a timeline: the host takes over (pure JamConnect session).
      if (this.isHost && this.peer) this._becomeLinkAuthority();
    }
  }

  get hasBridge() {
    return !!(this.bridgeConn && this.bridgeConn.open);
  }

  _emitBridgeState(status, message) {
    if (this.onBridgeStateChange) {
      this.onBridgeStateChange({ status, message, url: this.bridgeUrl });
    }
  }

  // ==========================================
  // JAMCONNECT-LINK: TIMELINE, CLOCK, CONTROL
  // ==========================================

  _startLinkClock(peerId, conn) {
    this._stopLinkClock(peerId);
    const clock = new JamLinkClock((m) => this._sendTo(conn, m), this.config.client.linkClock);
    clock.onUpdate = (offsetUs) => {
      if (this.onLinkClockUpdated) this.onLinkClockUpdated({ peerId, offsetUs });
    };
    this.linkClocks.set(peerId, clock);
    clock.start();
    this._startLinkFollow();
  }

  _stopLinkClock(peerId) {
    const c = this.linkClocks.get(peerId);
    if (c) c.stop();
    this.linkClocks.delete(peerId);
  }

  /** The node that owns the timeline we follow: 'BRIDGE', 'HOST' or null (we are the authority). */
  get linkUpstreamId() {
    if (this.hasBridge) return BRIDGE_PEER_ID;
    if (!this.isHost && this.hostConn && this.isConnectedToHost) return 'HOST';
    return null;
  }

  _linkUpstreamConn() {
    const id = this.linkUpstreamId;
    if (id === BRIDGE_PEER_ID) return this.bridgeConn;
    if (id === 'HOST') return this.hostConn;
    return null;
  }

  _connForSender(senderId) {
    if (senderId === BRIDGE_PEER_ID) return this.bridgeConn;
    if (senderId === 'HOST') return this.hostConn;
    const p = this.peers.get(senderId);
    return p ? p.conn : null;
  }

  _handleLinkState(msg, senderId) {
    // Only accept timelines from our upstream.
    if (senderId !== this.linkUpstreamId) return;
    this.linkTimeline.applyWire(msg, this.linkClocks.get(senderId));
    if (this.isHost) this.broadcast(this.linkTimeline.toWire(), BRIDGE_PEER_ID, false);
    this._notifyLinkState();
  }

  _notifyLinkState() {
    if (this.onLinkStateUpdated) this.onLinkStateUpdated(this.getLinkState());
    if (this.followLink) this._followLinkTick();
  }

  /** Pure-JamConnect host without a bridge: the host owns a Link-style timeline. */
  _becomeLinkAuthority() {
    const tl = this.linkTimeline;
    if (tl.source !== 'host') {
      // Adopt the app's own transport tempo if the timeline has none yet.
      if (!tl.hasTempo && this.Tone && this.adoptTransportTempo) tl.setTempo(this.Tone.Transport.bpm.value);
      tl.source = 'host';
      tl.linkEnabled = false;
      tl.numPeers = 0;
    }
    if (this._linkHostTimer) clearInterval(this._linkHostTimer);
    this._linkHostTimer = setInterval(() => {
      if (!this.isHost || this.hasBridge) {
        clearInterval(this._linkHostTimer);
        this._linkHostTimer = null;
        return;
      }
      if (this.linkTimeline.hasTempo) this.broadcast(this.linkTimeline.toWire(), null, false);
    }, this.config.client.hostStateIntervalMs);
    this._startLinkFollow();
    this._notifyLinkState();
  }

  /** Current Link view in the local clock (performance.now based). */
  getLinkState(atMs = performance.now()) {
    return {
      ...this.linkTimeline.snapshot(atMs * 1000),
      upstream: this.linkUpstreamId,
      clockOffsetUs: (this.linkClocks.get(this.linkUpstreamId) || {}).offsetUs || 0,
      clockReady: this.linkUpstreamId ? !!(this.linkClocks.get(this.linkUpstreamId) || {}).ready : true
    };
  }

  linkBeatAtTime(atMs = performance.now()) { return this.linkTimeline.beatAtTime(atMs * 1000); }
  linkPhaseAtTime(atMs = performance.now(), quantum) { return this.linkTimeline.phaseAtTime(atMs * 1000, quantum); }
  linkTimeAtBeat(beat) { return this.linkTimeline.timeAtBeat(beat) / 1000; }

  _sendLinkControl(msg) {
    const up = this._linkUpstreamConn();
    if (up) {
      this._sendTo(up, msg);
      return true;
    }
    if (this.isHost) {
      this._applyLinkControlLocally(msg);
      return true;
    }
    return false;
  }

  _applyLinkControlLocally(msg) {
    const tl = this.linkTimeline;
    if (!tl.source) this._becomeLinkAuthority();
    const guests = this.getConnectedPeersList().length;
    switch (msg.type) {
      case 'LINK_SET_TEMPO': tl.setTempo(Number(msg.bpm)); break;
      case 'LINK_SET_PLAYING': tl.setPlaying(!!msg.playing, nowUs(), Number(msg.quantum) || tl.quantum, guests > 0); break;
      case 'LINK_REQUEST_BEAT': {
        if (guests === 0) { tl.beat = Number(msg.beat) || 0; tl.atUs = nowUs(); }
        break;
      }
      default: return;
    }
    if (!tl.hasTempo) return;
    this.broadcast(tl.toWire(), null, false);
    this._notifyLinkState();
  }

  /** Set the Link session tempo (reaches Ableton through the bridge). */
  setLinkTempo(bpm) {
    return this._sendLinkControl({ type: 'LINK_SET_TEMPO', bpm: Number(bpm) });
  }

  /** Start/stop the Link session transport (needs Start Stop Sync in Live). */
  setLinkPlaying(playing, quantum = this.linkTimeline.quantum) {
    return this._sendLinkControl({ type: 'LINK_SET_PLAYING', playing: !!playing, quantum });
  }

  /** Quantized beat request (Link requestBeatAtTime). */
  requestLinkBeat(beat, quantum = this.linkTimeline.quantum) {
    return this._sendLinkControl({ type: 'LINK_REQUEST_BEAT', beat, quantum });
  }

  setLinkQuantum(quantum) {
    const q = Number(quantum);
    if (q > 0) this.linkTimeline.quantum = q;
    this._notifyLinkState();
  }

  /** Send an app-level message (e.g. LIVE_FIRE_CLIP) through the session to the bridge/devices. */
  sendRelayMessage(msg) {
    this.broadcast({ appName: this.appName, ...msg });
  }

  // ---- Tone.js follower: keep Tone.Transport phase-locked to the Link timeline ----

  _startLinkFollow() {
    if (!this.followLink || this._linkFollowTimer) return;
    this._linkFollowTimer = setInterval(() => this._followLinkTick(), this.config.client.followIntervalMs);
  }

  _stopLinkFollow() {
    if (this._linkFollowTimer) clearInterval(this._linkFollowTimer);
    this._linkFollowTimer = null;
  }

  /** Audio-context time corresponding to a performance.now() timestamp (ms). */
  _audioTimeForPerfMs(perfMs) {
    const Tone = this.Tone;
    const raw = Tone.getContext && Tone.getContext().rawContext;
    if (raw && raw.getOutputTimestamp) {
      const ts = raw.getOutputTimestamp();
      if (ts && ts.performanceTime) {
        return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
      }
    }
    return Tone.context.currentTime + (perfMs - performance.now()) / 1000;
  }

  _followLinkTick() {
    const Tone = this.Tone;
    const tl = this.linkTimeline;
    if (!Tone || !tl.source || !tl.hasTempo || !this.followLink) return;
    const transport = Tone.Transport;
    if (Math.abs(transport.bpm.value - tl.tempo) > 0.001) {
      transport.bpm.value = tl.tempo;
    }
    const ppq = transport.PPQ;
    const lookAheadMs = (Tone.context.lookAhead || 0) * 1000;
    const nowMs = performance.now();

    if (tl.isPlaying) {
      const playMs = tl.playTimeUs / 1000;
      if (transport.state !== 'started') {
        if (playMs > nowMs) {
          transport.ticks = 0;
          transport.start(this._audioTimeForPerfMs(playMs), 0);
        } else {
          // Join phase-aligned at the audio engine's own scheduling horizon.
          const startMs = nowMs + lookAheadMs;
          const startTicks = Math.max(0, tl.songBeatAtTime(startMs * 1000) * ppq);
          transport.start(this._audioTimeForPerfMs(startMs), `${Math.round(startTicks)}i`);
        }
        return;
      }
      // Transport.ticks reports the position at Tone.now() (= now + lookAhead).
      const expected = tl.songBeatAtTime((nowMs + lookAheadMs) * 1000) * ppq;
      const drift = transport.ticks - expected;
      if (expected >= 0 && Math.abs(drift) > ppq * (tl.tempo / 60) * (this.config.client.followMaxDriftMs / 1000)) {
        transport.ticks = Math.round(expected);
      }
    } else if (transport.state === 'started') {
      transport.stop();
    }
  }

  disconnect() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    if (this._linkHostTimer) {
      clearInterval(this._linkHostTimer);
      this._linkHostTimer = null;
    }
    this._stopLinkClock('HOST');
    this.detachLocalBridge();
    this._stopLinkFollow();
    this.transport = 'webrtc';
    this.linkTimeline.source = null;

    for (const peer of this.peers.values()) {
      try { peer.conn.close(); } catch (_) {}
    }
    this.peers.clear();

    if (this.hostConn) {
      try { this.hostConn.close(); } catch (_) {}
      this.hostConn = null;
    }

    if (this.peer) {
      try { this.peer.destroy(); } catch (_) {}
      this.peer = null;
    }

    this.isHost = false;
    this.isConnectedToHost = false;
    this._emitConnectionState('idle', 'Offline');
  }

  getConnectedPeersList() {
    const list = [];
    for (const p of this.peers.values()) {
      if (p.authenticated && p.conn && p.conn.open) {
        list.push({
          id: p.id,
          name: p.name,
          appName: p.appName,
          rtt: Math.round(p.rtt || 0)
        });
      }
    }
    return list;
  }

  // ==========================================
  // CLOCK SYNC & MESSAGE ROUTING
  // ==========================================

  _startHostTimers() {
    if (this._pingInterval) clearInterval(this._pingInterval);
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);

    // Measure RTT and clock offset every 2.5 seconds
    this._pingInterval = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (peer.authenticated && peer.conn && peer.conn.open) {
          this._measureClockOffset(peer.conn);
        }
        else if (peer.authenticated && peer.conn && !peer.conn.open) {
          this.logger.warn("Peer connection closed", peer);
        }
      }
    }, this.config.client.pingIntervalMs);

    /*
      // Send Transport phase/ticks heartbeat every 2 seconds while playing
      this._heartbeatInterval = setInterval(() => {
        this.resync();
      }, this.config.client.heartbeatIntervalMs);
    */
  }

  _measureClockOffset(conn) {
    this._sendTo(conn, {
      type: 'PING',
      hostSendTime: performance.now()
    });
  }

  _broadcastPeerList() {
    const peerList = this.getConnectedPeersList();
    this.broadcast({
      type: 'PEER_LIST',
      peers: peerList
    });
  }

  _routeMessage(msg, senderId) {
    if (!msg || !msg.type) return;
    
    this.logger.log("_routeMessage, msg=" + msg, senderId);
    switch (msg.type) {
      case 'PING': {
        const replyConn = this._connForSender(senderId);
        if (replyConn && replyConn.open) {
          this._sendTo(replyConn, {
            type: 'PONG',
            hostSendTime: msg.hostSendTime,
            guestReceiveTime: performance.now()
          });
        }
        break;
      }

      // ---- JamConnect-Link ----
      case 'LINK_PING': {
        // Any node answers Link measurement pings with its own clock (µs).
        const replyConn = this._connForSender(senderId);
        this._sendTo(replyConn, { type: 'LINK_PONG', gt: nowUs(), ht: msg.ht, pgt: msg.pgt });
        break;
      }

      case 'LINK_PONG': {
        const clock = this.linkClocks.get(senderId);
        if (clock) clock.handlePong(msg);
        break;
      }

      case 'LINK_STATE':
        this._handleLinkState(msg, senderId);
        break;

      case 'LINK_SET_TEMPO':
      case 'LINK_SET_PLAYING':
      case 'LINK_REQUEST_BEAT':
      case 'LINK_ENABLE':
      case 'LINK_START_STOP_SYNC':
      case 'LINK_GET_STATE': {
        if (!this.isHost || senderId === BRIDGE_PEER_ID) return;
        const needs = msg.type === 'LINK_SET_TEMPO' ? 'syncMasterSettings' : 'syncTransport';
        if (msg.type !== 'LINK_GET_STATE' && !this.permissions[needs]) return;
        if (msg.type === 'LINK_GET_STATE') {
          this._sendTo(this._connForSender(senderId), this.linkTimeline.toWire());
        } else if (this.hasBridge) {
          this._sendTo(this.bridgeConn, msg);
        } else {
          this._applyLinkControlLocally(msg);
        }
        break;
      }

      case 'PONG':
        if (this.isHost) {
          const now = performance.now();
          const rtt = Math.max(0, now - msg.hostSendTime);
          const oneWay = rtt / 2;
          const offset = (msg.guestReceiveTime - (msg.hostSendTime + oneWay));

          const peer = this.peers.get(senderId);
          if (peer) {
            peer.rtt = rtt;
            peer.samples.push({ rtt, offset });
            if (peer.samples.length > this.config.client.legacy.clockSamples) peer.samples.shift();
            // Use the sample with minimum RTT for highest clock accuracy
            const bestSample = peer.samples.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
            peer.timeOffset = bestSample.offset;

            this._sendTo(peer.conn, {
              type: 'CLOCK_SYNC',
              rtt: Math.round(rtt),
              timeOffset: bestSample.offset
            });
          }
        }
        break;

      case 'CLOCK_SYNC':
        if (senderId !== 'HOST') return;
        this.rtt = msg.rtt || 0;
        this.timeOffset = msg.timeOffset || 0;
        this._emitConnectionState('connected', `Connected to ${this.sessionId} (${this.rtt}ms)`);
        break;

      case 'PEER_LIST':
        if (senderId !== 'HOST') return;
        if (this.onPeerConnected) {
          this.onPeerConnected('HOST', msg.peers || []);
        }
        break;

      case 'PERMISSIONS_UPDATE':
        this.permissions = { ...this.permissions, ...msg.permissions };
        if (this.onPermissionsUpdated) this.onPermissionsUpdated(this.permissions);
        break;

      case 'FULL_STATE_SYNC':
        if (msg.snapshot && this.applyFullStateSnapshot) {
          this.applyFullStateSnapshot(msg.appName, msg.snapshot);
        }
        if (this.isHost) this.broadcast(msg, senderId);
        break;

      case 'TRANSPORT_STATE':
        if (this.isHost && !this.permissions.syncTransport && senderId !== 'HOST' && senderId !== BRIDGE_PEER_ID) return;
        this._applyTransportSync(msg);
        if (this.isHost && !this.hasBridge && senderId !== BRIDGE_PEER_ID) {
          // Pure JamConnect session: legacy transport drives the host timeline.
          if (msg.state === 'started') this._applyLinkControlLocally({ type: 'LINK_SET_PLAYING', playing: true });
          else if (msg.state === 'stopped') this._applyLinkControlLocally({ type: 'LINK_SET_PLAYING', playing: false });
          if (typeof msg.bpm === 'number' && Math.abs(msg.bpm - this.linkTimeline.tempo) > 0.001) {
            this._applyLinkControlLocally({ type: 'LINK_SET_TEMPO', bpm: msg.bpm });
          }
        }
        if (this.isHost) {
          this.broadcast(msg, senderId);
        }
        break;

      case 'TRANSPORT_HEARTBEAT':
        this._applyTransportHeartbeat(msg);
        break;

      case 'PATTERN_STEP_UPDATE':
        if (!this.permissions.syncPattern) return;
        if (this.onPatternStepUpdated) {
          this.onPatternStepUpdated(msg.appName, msg.instrument, msg.stepIndex, msg.stepData);
        }
        if (this.isHost) {
          this.broadcast(msg, senderId);
        }
        break;
      case 'PATTERN_FULL_UPDATE':
        if (!this.permissions.syncPattern) return;
        if (this.onPatternUpdated) {
          this.onPatternUpdated(msg.appName, msg.instrument, msg.pattern, msg.presetName);
        }
        if (this.isHost) {
          this.broadcast(msg, senderId);
        }
        break;

      case 'DEVICE_PARAMETER_CHANGE':
        if (!this.permissions.syncDeviceParameterChange) return;
        
        if (this.onDeviceParameterChanged) {
          this.logger.log("onDeviceParameterChanged, param=" + msg.param, msg.value);
          this.onDeviceParameterChanged(msg.appName, msg.param, msg.value, msg.normalizedValue);
        }
        if (this.isHost) {
          this.broadcast(msg, senderId);
        }
        break;

      case 'DEVICE_PARAMETER_CHANGES':
        if (!this.permissions.syncDeviceParameterChange) return;
        
        if (this.onDeviceParameterChanged) {
          this.logger.log("onDeviceParametersChanged, changes=" + msg.changes);
          msg.changes.forEach(change => {
            this.onDeviceParameterChanged(msg.appName, change.param, change.value);
          });
        }
        if (this.isHost) {
          this.broadcast(msg, senderId);
        }
        break;

      case 'MASTER_SETTING_UPDATE':
        if (!this.permissions.syncMasterSettings) return;
        if (this.onMasterSettingUpdated) {
          this.onMasterSettingUpdated(msg.appName, msg.setting, msg.value);
        }
        if (this.isHost) {
          this.broadcast(msg, senderId);
        }
        break;

      case 'PAD_PLAY':
        if (!this.permissions.syncMidi) return;
        if (this.onPadTriggered) {
          // Link timing: play at the sender's Link beat (same moment on every peer).
          // Without a Link beat (older senders) play on arrival.
          let playTime = this.Tone.now();
          if (typeof msg.linkBeat === 'number' && this.linkTimeline.source && this.linkTimeline.hasTempo) {
            playTime = Math.max(playTime, this._audioTimeForPerfMs(this.linkTimeAtBeat(msg.linkBeat)));
          }
          this.onPadTriggered(msg.appName, msg.instrument, msg.note, msg.velocity, playTime, msg.extra);
        }
        if (this.isHost) {
          this.broadcast(msg, senderId);
        }
        break;

      case 'MIDI_EVENT':
        if (!this.permissions.syncMidi) return;
        if (this.onMidiMessage) {
          this.onMidiMessage(msg.appName, msg.event, msg);
        }
        if (this.isHost) {
          this.broadcast(msg, senderId);
        }
        break;

      default:
        // App-specific traffic (e.g. LIVE_* from the Max for Live device): deliver and relay.
        if (JAM_LOCAL_MESSAGE_TYPES.has(msg.type)) return;
        if (this.isHost && senderId !== BRIDGE_PEER_ID && senderId !== 'HOST') {
          const needs = jamRemoteControlPermission(msg);
          if (needs && !this.permissions[needs]) {
            const kind = msg.type.startsWith('M4L_') ? 'M4L_ERROR' : 'LIVE_ERROR';
            this._sendTo(this._connForSender(senderId), {
              type: kind, request: msg.type, message: `${msg.type}: not allowed by host (${needs})`,
              ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {})
            });
            return;
          }
        }
        if (this.onRelayMessage) this.onRelayMessage(msg, senderId);
        if (this.isHost) {
          this.broadcast(msg, senderId);
        }
        break;
    }
  }

  _applyTransportSync(msg) {
    // A Link timeline owns the timing; legacy transport messages are informational then.
    if (this.linkTimeline.source) return;
    if (typeof msg.bpm === 'number') {
      this.Tone.Transport.bpm.value = msg.bpm;
    }
    if (typeof msg.swing === 'number') {
      this.Tone.Transport.swing = msg.swing;
    }

    const transitSec = Math.max(0, (this.rtt || 0) / 2) / 1000;

    if (msg.state === 'started' || msg.transportState === 'started') {
      const targetSeconds = (typeof msg.seconds === 'number' ? msg.seconds : 0) + transitSec;
      if (this.Tone.Transport.state !== 'started') {
        this.Tone.Transport.seconds = targetSeconds;
        const startOffset = typeof msg.delaySec === 'number' ? Math.max(0, msg.delaySec - transitSec) : 0;
        this.Tone.Transport.start(`+${startOffset}`);
      } else if (typeof msg.ticks === 'number') {
        this.Tone.Transport.ticks = msg.ticks;
      }
    } else if (msg.state === 'stopped' || msg.transportState === 'stopped') {
      this.Tone.Transport.stop();
      this.Tone.Transport.seconds = 0;
      this.Tone.Transport.ticks = 0;
    }
  }

  _applyTransportHeartbeat(msg) {
    if (this.linkTimeline.source) return;
    if (typeof msg.bpm === 'number' && Math.abs(this.Tone.Transport.bpm.value - msg.bpm) > 0.5) {
      this.Tone.Transport.bpm.value = msg.bpm;
    }
    if (this.Tone.Transport.state !== 'started') {
      this.Tone.Transport.seconds = msg.seconds || 0;
      this.Tone.Transport.start();
      return;
    }
    const transitSec = Math.max(0, (this.rtt || 0) / 2) / 1000;
    const expectedSeconds = (msg.seconds || 0) + transitSec;
    const drift = Math.abs(this.Tone.Transport.seconds - expectedSeconds);
    if (drift > this.config.client.followMaxDriftMs / 1000) {
      this.Tone.Transport.seconds = expectedSeconds;
    }
  }

  _sendTo(conn, obj) {
    if (conn && conn.open) {
      try {
        conn.send(obj);
      } catch (err) {
        this.logger.warn('[JamConnector Send Error]', err);
      }
    }
  }

  broadcast(obj, excludePeerId = null, toBridge = true) {
    if (this.isHost) {
      this.logger.log("broadcast from host, obj, excludePeerId", obj, excludePeerId);
  
      for (const [id, peer] of this.peers.entries()) {
        if (id !== excludePeerId && peer.authenticated && peer.conn && peer.conn.open) {
          this._sendTo(peer.conn, obj);
        }
      }
      // Session traffic also flows up to the attached Link bridge (and its devices).
      if (toBridge && excludePeerId !== BRIDGE_PEER_ID && this.hasBridge && !JAM_LOCAL_MESSAGE_TYPES.has(obj.type)) {
        this._sendTo(this.bridgeConn, obj);
      }
    } else if (this.hostConn && this.hostConn.open) {
      this._sendTo(this.hostConn, obj);
    }
  }

  _emitConnectionState(status, message) {
    if (this.onConnectionStateChange) {
      this.onConnectionStateChange({
        status,
        message,
        isHost: this.isHost,
        isConnected: this.isHost || this.isConnectedToHost,
        sessionId: this.sessionId,
        authToken: this.authToken,
        inviteUrl: this.buildInviteUrl(),
        peers: this.getConnectedPeersList(),
        rtt: Math.round(this.rtt || 0)
      });
    }
  }

  // ==========================================
  // PLAYBACK, PATTERN, SYNTH & MIDI SYNC API
  // ==========================================

  /** In a session, Link owns timing: the start lands on the Link timeline (quantized when peers exist). */
  startTransport(bpm = this.Tone.Transport.bpm.value) {
    if (!this.isHost && this.isConnectedToHost && !this.permissions.syncTransport) return;
    if (this.isHost || this.linkTimeline.source) {
      if (!this.linkTimeline.hasTempo && this.linkTimeline.validTempo(bpm)) this.setLinkTempo(bpm);
      this.setLinkPlaying(true);
      this._broadcastLegacyTransport('started');
      return;
    }
    // Not in a session: plain local transport.
    if (this.linkTimeline.validTempo(bpm)) this.Tone.Transport.bpm.value = bpm;
    this.Tone.Transport.start();
  }

  stopTransport() {
    if (!this.isHost && this.isConnectedToHost && !this.permissions.syncTransport) return;
    if (this.isHost || this.linkTimeline.source) {
      this.setLinkPlaying(false);
      this._broadcastLegacyTransport('stopped');
      return;
    }
    this.Tone.Transport.stop();
    this.Tone.Transport.seconds = 0;
    this.Tone.Transport.ticks = 0;
  }

  /**
   * Host without a bridge: also tell guests running older JamConnect builds (no Link
   * support) via TRANSPORT_STATE. Times are taken from the Link timeline, not constants.
   * With a bridge, the bridge emits TRANSPORT_STATE itself.
   */
  /** Measured one-way latency to the rest of the session (Link clock RTT / legacy ping RTT), ms. */
  _sessionOneWayMs() {
    let rttMs = 0;
    for (const c of this.linkClocks.values()) rttMs = Math.max(rttMs, (c.rttUs || 0) / 1000);
    for (const p of this.peers.values()) rttMs = Math.max(rttMs, p.rtt || 0);
    if (!this.isHost) rttMs = Math.max(rttMs, this.rtt || 0);
    return rttMs / 2;
  }

  _broadcastLegacyTransport(state) {
    if (!this.isHost || this.linkUpstreamId) return;
    const tl = this.linkTimeline;
    if (!tl.hasTempo) return;
    const delaySec = state === 'started' ? Math.max(0, (tl.playTimeUs - nowUs()) / 1e6) : 0;
    this.broadcast({
      type: 'TRANSPORT_STATE', state, bpm: tl.tempo, swing: this.Tone.Transport.swing,
      seconds: 0, ticks: 0, delaySec, hostAudioTime: this.Tone.now() + delaySec
    }, null, false);
  }

  resync() {
    if (!this.isHost || this.Tone.Transport.state !== 'started') return;
    this.broadcast({
      type: 'TRANSPORT_HEARTBEAT',
      bpm: this.Tone.Transport.bpm.value,
      swing: this.Tone.Transport.swing,
      ticks: this.Tone.Transport.ticks,
      seconds: this.Tone.Transport.seconds,
      hostTime: performance.now()
    });
  }

  updateBpm(bpm) {
    if (!this.isHost && this.isConnectedToHost && !this.permissions.syncMasterSettings) return;
    if (this.isHost || this.linkTimeline.source) {
      this.setLinkTempo(bpm);
      this._broadcastLegacyTransport('bpmchanged');
      return;
    }

    this.Tone.Transport.bpm.value = bpm;
    this.broadcast({
      type: 'TRANSPORT_STATE',
      state: 'bpmchanged',
      bpm: this.Tone.Transport.bpm.value,
      seconds: this.Tone.Transport.seconds,
      ticks: this.Tone.Transport.ticks,
      hostAudioTime: this.Tone.now()
    });
  }

  sendPatternStepUpdate(instrument, stepIndex, stepData) {
    this.logger.log("sendPatternStepUpdate, instrument, stepIndex, stepData", instrument, stepIndex, stepData);
    
    this.broadcast({
      type: 'PATTERN_STEP_UPDATE',
      appName: this.appName,
      instrument,
      stepIndex,
      stepData
    });
  }

  sendFullPatternUpdate(instrument, pattern, presetName = null) {
    this.logger.log("sendFullPatternUpdate, instrument=" + instrument, pattern, presetName);
    
    this.broadcast({
      type: 'PATTERN_FULL_UPDATE',
      appName: this.appName,
      instrument,
      pattern,
      presetName
    });
  }

  sendDeviceParameterChange(param, value, normalizedValue = null) {
    
    let delta = performance.now() - this._lastParamChangeTime;
    if (delta < this.config.client.paramChangeBufferMs) {
      this._paramChangeBuffer.push({param: param, value: value});
      setTimeout(() => {
        this.broadcast({
          type: 'DEVICE_PARAMETER_CHANGES',
          appName: this.appName,
          changes: this._paramChangeBuffer
        });
        this.logger.log("sendDeviceParameterChange: sent buffer", this._paramChangeBuffer);
        this._paramChangeBuffer = [];
        
      }, this.config.client.paramChangeBufferMs);
      this.logger.log("sendDeviceParameterChange: buffered change");
    }
    else {
      this.logger.log("sendDeviceParameterChange, param=" + param, value, normalizedValue);
      this.broadcast({
        type: 'DEVICE_PARAMETER_CHANGE',
        appName: this.appName,
        param,
        value,
        normalizedValue
      });
    }
    
    this._lastParamChangeTime = performance.now();
  }

  sendMasterSettingUpdate(setting, value) {
    
    this.logger.log("sendMasterSettingUpdate, setting=" + setting, value);
    
    this.broadcast({
      type: 'MASTER_SETTING_UPDATE',
      appName: this.appName,
      setting,
      value
    });
  }

  sendPermissionsUpdate(permissions) {
    if (!this.isHost) return;
    this.permissions = { ...this.permissions, ...permissions };
    this.broadcast({
      type: 'PERMISSIONS_UPDATE',
      permissions: this.permissions
    });
  }

  sendMidiEvent(event) {
    this.broadcast({
      type: 'MIDI_EVENT',
      appName: this.appName,
      event
    });
  }

  /**
   * Triggers a 303 note or drum pad with optional 16th-note quantization.
   */
  triggerPad(appName, instrument, note = 'C2', velocity = 0.85, snapStrength = 0, extra = {}) {
    const tl = this.linkTimeline;
    if (tl.source && tl.hasTempo) {
      // Link timing: quantized launch on the Link beat grid (16ths), always forward to the
      // next grid point like Live's launch quantization, and send the Link beat itself so
      // every peer plays it at the same Link moment.
      const lookAheadMs = (this.Tone.context.lookAhead || 0) * 1000;
      const nowBeat = this.linkBeatAtTime(performance.now() + lookAheadMs);
      let linkBeat = nowBeat;
      if (tl.isPlaying && snapStrength > 0) {
        const grid = 0.25;
        // Earliest grid point the other peers can still hit: measured one-way latency.
        const reachBeat = this.linkBeatAtTime(performance.now() + lookAheadMs + this._sessionOneWayMs());
        linkBeat = nowBeat + (Math.ceil(reachBeat / grid) * grid - nowBeat) * Math.min(1, snapStrength);
      }
      const scheduledTime = this._audioTimeForPerfMs(this.linkTimeAtBeat(linkBeat));
      if (this.onPadTriggered) this.onPadTriggered(instrument, note, velocity, scheduledTime, extra);
      this.broadcast({
        type: 'PAD_PLAY', appName: this.appName, instrument, note, velocity, linkBeat,
        delayFromSendMs: Math.max(0, Math.round((scheduledTime - this.Tone.now()) * 1000)), extra
      });
      return;
    }
    const now = this.Tone.now();
    const bpm = this.Tone.Transport.bpm.value;
    const sixteenthDuration = (60 / bpm) / 4;

    let scheduledTime = now;
    if (this.Tone.Transport.state === 'started' && snapStrength > 0) {
      const transportSec = this.Tone.Transport.seconds;
      const remainder = transportSec % sixteenthDuration;
      const deltaToGrid = (remainder > sixteenthDuration / 2)
        ? (sixteenthDuration - remainder)
        : -remainder;
      scheduledTime = now + Math.max(0, deltaToGrid * snapStrength);
    }

    const delayFromSendMs = Math.round((scheduledTime - now) * 1000);

    if (this.onPadTriggered) {
      this.onPadTriggered(instrument, note, velocity, scheduledTime, extra);
    }

    this.broadcast({
      type: 'PAD_PLAY',
      appName: this.appName,
      instrument,
      note,
      velocity,
      delayFromSendMs,
      extra
    });
  }
}

class Logger {
  constructor(jamConnector, alwaysLogWarnings = true, alwaysLogErrors = true) {
    this.connector = jamConnector;
  }
  
  log(message, ...args) {
    if (!this.connector.enableLogging)
      return;
    message = `[${this.getTime()}] ${message}`;
    if (args)
      console.log(message, args);
    else
      console.log(message);
  }

  warn(message, ...args) {
    message = `[${this.getTime()}] ${message}`;
    if (args)
      console.warn(message, args);
    else
      console.warn(message);
  }
  
  error(message, ...args) {
    message = `[${this.getTime()}] ${message}`;
    if (args)
      console.error(message, args);
    else
      console.error(message);
  }
  
  getTime() {
    const d = new Date();
    return d.toLocaleTimeString();
  }
}

const JamConnectUserRoles = {
  Host: "Host",
  Guest: "Guest"
};

const JamConnectActions = {
  InviteJamGuest: "InviteJamGuest",
  JoinJamSession: "JoinJamSession",
  StartJamTransport: "StartJamTransport",
  StopJamTransport: "StopJamTransport"
};

class JamConnectClient {
  constructor(appName, parentElement, enableLogging = false) {
    this._tone = Tone;
    this._connector = new JamConnector(appName, this._tone, {enableLogging: enableLogging});
    this._parentElement = parentElement;
    this._userRole = null;
    this._isPlaying = false;
    this._scanner = null;
    this._isScannerRunning = false;
    this.isApplyingRemoteUpdate = false;
    
    this._renderJamUI();
    this._bindInternalEvents();

    Tone.Transport.on("start", () => {
      this._isPlaying = true;
      this.stateChanged();
    });

    Tone.Transport.on("stop", () => {
      this._isPlaying = false;
      this.stateChanged();
    });

    this._actions = [
      new InviteJamGuestAction(this),
      new JoinJamSessionAction(this),
      new StartJamTransportAction(this),
      new StopJamTransportAction(this)
    ];

    this.stateChanged();
  }

  get tone() { return this._tone; }
  get connector() { return this._connector; }
  get userRole() { return this._userRole; }
  get isPlaying() { return this._isPlaying; }
  get bpm() { return Tone.Transport.bpm.value; }
  set bpm(value) {
    if (!this.userRole) {
      Tone.Transport.bpm.value = value;
    } else if (!this.canChangeBpm) {
      return;
    } else {
      this.connector.updateBpm(value);
    }
    this.stateChanged();
  }

  get actions() { return this._actions; }
  get activeActions() { return this.actions.filter(a => a.isRunning); }

  get canInvite() { return this.getAction(JamConnectActions.InviteJamGuest).canStart; }
  get canJoin() { return this.getAction(JamConnectActions.JoinJamSession).canStart; }
  get canStartTransport() { return this.getAction(JamConnectActions.StartJamTransport).canStart; }
  get canStopTransport() { return this.getAction(JamConnectActions.StopJamTransport).canStart; }
  get canChangeBpm() {
    if (this.userRole === JamConnectUserRoles.Guest) {
      return !!this.connector.permissions.syncMasterSettings;
    }
    return true;
  }

  set onStateChanged(callback) { this._onStateChangedCallback = callback; }

  _renderJamUI() {
    if (!this._parentElement) return;
    this._qrCodeDisplayElementId = "jamconnect-qr-code";
    this._qrScannerElementId = "jamconnect-qr-scanner";

    this._parentElement.innerHTML = `
      <div class="w-full flex flex-col gap-3 mt-2 text-slate-100">
        <!-- Session Status Header -->
        <div id="jam-status-bar" class="flex flex-wrap items-center justify-between gap-2 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2">
          <div class="flex items-center gap-2">
            <span id="jam-status-dot" class="w-2.5 h-2.5 rounded-full bg-slate-500"></span>
            <span id="jam-status-text" class="text-xs font-mono font-bold text-slate-300">SESSION OFFLINE</span>
          </div>
          <div class="flex items-center gap-2">
            <span id="jam-peer-count" class="text-[11px] font-mono bg-slate-800 text-emerald-400 px-2 py-0.5 rounded border border-slate-700">0 PEERS</span>
            <button id="jam-disconnect-btn" style="display:none;" class="px-2.5 py-1 bg-rose-900/80 hover:bg-rose-800 text-rose-100 text-[11px] font-mono font-bold rounded border border-rose-700 transition">
              DISCONNECT
            </button>
          </div>
        </div>

        <!-- Host Panel: Compact QR Code + Session ID + Auth Token + Share Link -->
        <div id="jam-host-panel" style="display:none;" class="bg-slate-900 border border-slate-700 rounded-xl p-4 flex flex-col md:flex-row gap-4 items-center">
          <div class="flex flex-col items-center bg-white p-3 rounded-xl shadow-lg shrink-0">
            <div id="jamconnect-qr-code" class="w-[180px] h-[180px] flex items-center justify-center"></div>
            <span class="text-[10px] font-mono font-bold text-slate-700 mt-1.5">SCAN TO JOIN JAM</span>
          </div>

          <div class="flex-1 w-full flex flex-col gap-2.5">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div class="bg-slate-950 border border-slate-800 rounded-lg p-2">
                <div class="text-[10px] font-mono text-slate-400 uppercase">Session ID</div>
                <div id="jam-session-id-display" class="text-base font-mono font-bold text-emerald-400 tracking-wider select-all">---</div>
              </div>
              <div class="bg-slate-950 border border-slate-800 rounded-lg p-2">
                <div class="text-[10px] font-mono text-slate-400 uppercase">Auth Key Token</div>
                <div id="jam-auth-token-display" class="text-base font-mono font-bold text-amber-400 tracking-wider select-all">---</div>
              </div>
            </div>

            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-mono text-slate-400 uppercase">Direct Invite Link (Session + Auth Token)</label>
              <div class="flex gap-1.5">
                <input id="jam-invite-url-input" type="text" readonly class="flex-1 bg-slate-950 text-slate-200 font-mono text-xs px-2.5 py-1.5 rounded border border-slate-700 outline-none" value="" />
                <button id="jam-copy-link-btn" type="button" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-mono font-bold text-xs rounded transition shrink-0">
                  <img src="images/copy.png">
                </button>
                <button id="jam-share-link-btn" type="button" class="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-slate-950 font-mono font-bold text-xs rounded transition shrink-0">
                  <img src="images/share.png">
                </button>
              </div>
            </div>

            <!-- Host Co-op Permissions -->
            <div class="bg-slate-950/80 border border-slate-800 rounded-lg p-2.5 mt-1">
              <div class="text-[10px] font-mono text-slate-400 uppercase mb-1.5">Jam Sync Options</div>
              <div class="flex flex-wrap gap-3 text-xs font-mono text-slate-300">
                <label class="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" id="sync-mastersettings" checked class="accent-emerald-500 rounded" /> Tempo/Play/Delay/Swing
                </label>
                <label class="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" id="sync-pattern" class="accent-emerald-500 rounded" /> Pattern
                </label>
                <label class="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" id="sync-deviceparameterchange" class="accent-emerald-500 rounded" /> Synth Knobs
                </label>
                <label class="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" id="sync-midi" class="accent-emerald-500 rounded" /> Live MIDI/Pads
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Join Panel: Camera QR Scanner + Manual Link / Session ID + Auth Token -->
        <div id="jam-join-panel" style="display:none;" class="bg-slate-900 border border-slate-700 rounded-xl p-4 flex flex-col gap-3">
          <div class="flex justify-between items-center">
            <span class="text-xs font-mono font-bold text-emerald-400 uppercase">Join Host Session</span>
            <button id="jam-cancel-join-btn" type="button" class="text-xs font-mono text-slate-400 hover:text-white px-2 py-0.5 rounded border border-slate-700">
              CLOSE
            </button>
          </div>

          <div id="jamconnect-qr-scanner" style="display:none;" class="w-full max-w-[300px] mx-auto overflow-hidden rounded-lg border border-slate-700"></div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
            <div class="sm:col-span-1">
              <label class="text-[10px] font-mono text-slate-400 uppercase block mb-1">Session ID or Invite Link</label>
              <input id="jam-join-session-input" type="text" placeholder="303-ABCD or paste link" class="w-full bg-slate-950 text-emerald-400 font-mono text-xs px-2.5 py-2 rounded border border-slate-700 outline-none focus:border-emerald-500" />
            </div>
            <div class="sm:col-span-1">
              <label class="text-[10px] font-mono text-slate-400 uppercase block mb-1">Auth Key Token</label>
              <input id="jam-join-token-input" type="text" placeholder="Auto-filled from link" class="w-full bg-slate-950 text-amber-400 font-mono text-xs px-2.5 py-2 rounded border border-slate-700 outline-none focus:border-amber-500" />
            </div>
            <div class="flex gap-1.5">
              <button id="jam-manual-connect-btn" type="button" class="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-mono font-bold text-xs rounded transition">
                CONNECT
              </button>
              <button id="jam-scan-toggle-btn" type="button" class="py-2 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono font-bold text-xs rounded border border-slate-600 transition">
                SCAN QR
              </button>
            </div>
          </div>
          <div id="jam-join-error" style="display:none;" class="text-xs font-mono text-rose-400 bg-rose-950/60 border border-rose-800 rounded px-2.5 py-1.5"></div>
        </div>

        <!-- Connected Peers List -->
        <div id="jam-peers-list" style="display:none;" class="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5 flex flex-wrap gap-2 items-center"></div>
      </div>
    `;
  }

  _bindInternalEvents() {
    const copyBtn = document.getElementById('jam-copy-link-btn');
    const shareBtn = document.getElementById('jam-share-link-btn');
    const disconnectBtn = document.getElementById('jam-disconnect-btn');
    const cancelJoinBtn = document.getElementById('jam-cancel-join-btn');
    const manualConnectBtn = document.getElementById('jam-manual-connect-btn');
    const scanToggleBtn = document.getElementById('jam-scan-toggle-btn');
    const sessionInput = document.getElementById('jam-join-session-input');
    const tokenInput = document.getElementById('jam-join-token-input');

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const url = this.connector.buildInviteUrl();
        if (!url) return;
        try {
          await navigator.clipboard.writeText(url);
          const orig = copyBtn.textContent;
          copyBtn.textContent = 'COPIED!';
          setTimeout(() => { copyBtn.textContent = orig; }, 1500);
        } catch (_) {
          const input = document.getElementById('jam-invite-url-input');
          if (input) {
            input.select();
            document.execCommand('copy');
          }
        }
      });
    }

    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const url = this.connector.buildInviteUrl();
        if (!url) return;
        if (navigator.share) {
          try {
            await navigator.share({
              title: `Join my JAM303 Session (${this.connector.sessionId})`,
              text: `Jam with me on Acid303! Session: ${this.connector.sessionId}`,
              url
            });
          } catch (_) {}
        } else if (copyBtn) {
          copyBtn.click();
        }
      });
    }

    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', async () => {
        await this.stopScanner();
        this.connector.disconnect();
        this._userRole = null;
        document.getElementById('jam-host-panel').style.display = 'none';
        document.getElementById('jam-join-panel').style.display = 'none';
        this.stateChanged();
      });
    }

    if (cancelJoinBtn) {
      cancelJoinBtn.addEventListener('click', async () => {
        await this.stopScanner();
        document.getElementById('jam-join-panel').style.display = 'none';
        this.stateChanged();
      });
    }

    if (sessionInput) {
      sessionInput.addEventListener('input', (e) => {
        const parsed = JamConnector.parseInviteInput(e.target.value);
        if (parsed && parsed.sessionId && parsed.authToken) {
          sessionInput.value = parsed.sessionId;
          if (tokenInput) tokenInput.value = parsed.authToken;
        }
      });
    }

    if (manualConnectBtn) {
      manualConnectBtn.addEventListener('click', async () => {
        const errEl = document.getElementById('jam-join-error');
        if (errEl) errEl.style.display = 'none';
        try {
          manualConnectBtn.disabled = true;
          manualConnectBtn.textContent = 'CONNECTING...';
          await this.stopScanner();
          await this.connector.joinHost(
            sessionInput ? sessionInput.value : '',
            tokenInput ? tokenInput.value : ''
          );
          this._userRole = JamConnectUserRoles.Guest;
          document.getElementById('jam-join-panel').style.display = 'none';
          this.stateChanged();
        } catch (err) {
          if (errEl) {
            errEl.textContent = err.message || 'Failed to join session';
            errEl.style.display = 'block';
          }
        } finally {
          manualConnectBtn.disabled = false;
          manualConnectBtn.textContent = 'CONNECT';
        }
      });
    }

    if (scanToggleBtn) {
      scanToggleBtn.addEventListener('click', async () => {
        if (this._isScannerRunning) {
          await this.stopScanner();
          scanToggleBtn.textContent = 'SCAN QR';
        } else {
          scanToggleBtn.textContent = 'STOP CAM';
          await this.scanQrCode(async (scannedText) => {
            scanToggleBtn.textContent = 'SCAN QR';
            const parsed = JamConnector.parseInviteInput(scannedText);
            if (parsed) {
              if (sessionInput) sessionInput.value = parsed.sessionId;
              if (tokenInput) tokenInput.value = parsed.authToken;
              if (manualConnectBtn) manualConnectBtn.click();
            }
          });
        }
      });
    }

    // Permission checkboxes
    const bindPerm = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        const update = { [key]: el.checked };
        if (key === 'syncMasterSettings') {
          update.syncTransport = el.checked;
        }
        this.connector.sendPermissionsUpdate(update);
      });
    };
    bindPerm('sync-mastersettings', 'syncMasterSettings');
    bindPerm('sync-pattern', 'syncPattern');
    bindPerm('sync-deviceparameterchange', 'syncDeviceParameterChange');
    bindPerm('sync-midi', 'syncMidi');

    this.connector.onConnectionStateChange = (statusObj) => {
      this._updateStatusUI(statusObj);
      this.stateChanged();
    };

    this.connector.onPermissionsUpdated = () => {
      this.stateChanged();
    };
  }

  _updateStatusUI(statusObj) {
    const dot = document.getElementById('jam-status-dot');
    const text = document.getElementById('jam-status-text');
    const countEl = document.getElementById('jam-peer-count');
    const disconnectBtn = document.getElementById('jam-disconnect-btn');
    const peersListEl = document.getElementById('jam-peers-list');

    if (text) text.textContent = (statusObj.message || 'OFFLINE').toUpperCase();

    if (dot) {
      if (statusObj.status === 'hosting' || statusObj.status === 'connected') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400 animate-pulse';
      } else if (statusObj.status === 'connecting') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping';
      } else if (statusObj.status === 'error') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
      } else {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500';
      }
    }

    const peers = statusObj.peers || [];
    if (countEl) {
      countEl.textContent = statusObj.status === 'connected'
        ? `LINKED (${statusObj.rtt || 0}ms)`
        : `${peers.length} PEER${peers.length === 1 ? '' : 'S'}`;
    }

    if (disconnectBtn) {
      disconnectBtn.style.display = (statusObj.status === 'hosting' || statusObj.status === 'connected' || statusObj.status === 'connecting')
        ? 'inline-block'
        : 'none';
    }

    if (peersListEl) {
      if (peers.length > 0) {
        peersListEl.style.display = 'flex';
        peersListEl.innerHTML = `<span class="text-[10px] font-mono text-slate-400 uppercase mr-1">Connected:</span>` +
          peers.map(p => `<span class="text-xs font-mono bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 px-2 py-0.5 rounded">${p.name} (${p.rtt || 0}ms)</span>`).join('');
      } else {
        peersListEl.style.display = 'none';
      }
    }
  }

  stateChanged() {
    if (!this._onStateChangedCallback) return;

    this._onStateChangedCallback({
      userRole: this.userRole,
      canInvite: this.canInvite,
      canJoin: this.canJoin,
      canStart: this.canStartTransport,
      canStop: this.canStopTransport,
      canChangeBpm: this.canChangeBpm,
      isInviting: this.isActionActive(JamConnectActions.InviteJamGuest),
      isJoining: this.isActionActive(JamConnectActions.JoinJamSession),
      isPlaying: this.isPlaying,
      bpm: this.bpm,
      sessionId: this.connector.sessionId,
      authToken: this.connector.authToken,
      inviteUrl: this.connector.buildInviteUrl()
    });
  }

  getAction(name) {
    return this.actions.find(p => p.name == name);
  }

  isActionActive(name) {
    return this.getAction(name).isRunning;
  }

  async invite() {
    const action = this.getAction(JamConnectActions.InviteJamGuest);
    this._userRole = JamConnectUserRoles.Host;
    await action.execute();
    this.stateChanged();
  }

  async join(inviteUrlOrSession = null, token = '') {
    const action = this.getAction(JamConnectActions.JoinJamSession);
    if (inviteUrlOrSession) {
      await this.connector.joinHost(inviteUrlOrSession, token);
      this._userRole = JamConnectUserRoles.Guest;
      this.stateChanged();
      return;
    }
    await action.execute();
  }

  /** Local mode: connect straight to a jamlink-bridge (Ableton Link). */
  async joinLocalBridge(url = this.connector.bridgeUrlFromConfig(), token = this.connector.config.client.bridgeToken) {
    await this.connector.joinLocalBridge(url, token);
    this._userRole = JamConnectUserRoles.Guest;
    this.stateChanged();
  }

  /** WebRTC host: relay the local bridge's Link session to remote guests. */
  async attachLocalBridge(url = this.connector.bridgeUrlFromConfig(), token = this.connector.config.client.bridgeToken) {
    await this.connector.attachLocalBridge(url, token);
    this.stateChanged();
  }

  async startTransport() {
    const action = this.getAction(JamConnectActions.StartJamTransport);
    await action.execute();
  }

  async stopTransport() {
    const action = this.getAction(JamConnectActions.StopJamTransport);
    await action.execute();
  }

  async scanQrCode(qrCodeScannedCallback) {
    await this.stopScanner();
    const qrCodeScannerElement = document.getElementById(this._qrScannerElementId);
    if (!qrCodeScannerElement || typeof Html5Qrcode === 'undefined') return;
    qrCodeScannerElement.style.display = "block";

    const scanner = new Html5Qrcode(this._qrScannerElementId);
    this._scanner = scanner;
    this._isScannerRunning = true;

    const cameraConfig = { facingMode: "environment" };
    const scanConfig = {
      fps: 15,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
        const edge = Math.floor(minEdge * 0.75);
        return { width: edge, height: edge };
      }
    };

    try {
      await scanner.start(
        cameraConfig,
        scanConfig,
        async (inviteMessage) => {
          await this.stopScanner();
          if (qrCodeScannedCallback) {
            await qrCodeScannedCallback(inviteMessage);
          }
        },
        () => {}
      );
    } catch (err) {
      this._isScannerRunning = false;
      qrCodeScannerElement.style.display = "none";
      const errEl = document.getElementById('jam-join-error');
      if (errEl) {
        errEl.textContent = 'Camera unavailable. Paste the Invite Link or Session ID + Token below.';
        errEl.style.display = 'block';
      }
    }
  }

  async stopScanner() {
    if (this._scanner && this._isScannerRunning) {
      try {
        await this._scanner.stop();
        await this._scanner.clear();
      } catch (_) {}
    }
    this._scanner = null;
    this._isScannerRunning = false;
    this.hideQrScanner();
  }

  hideQrScanner() {
    const qrCodeScannerElement = document.getElementById(this._qrScannerElementId);
    if (qrCodeScannerElement) qrCodeScannerElement.style.display = "none";
  }

  displayQrCode(message) {
    const qrCodeDisplayElement = document.getElementById(this._qrCodeDisplayElementId);
    if (!qrCodeDisplayElement || typeof QRCode === 'undefined') return;
    qrCodeDisplayElement.innerHTML = '';
    new QRCode(qrCodeDisplayElement, {
      text: message,
      width: 180,
      height: 180,
      colorDark: "#0f172a",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
    qrCodeDisplayElement.style.display = "flex";
  }

  hideQrCode() {
    const qrCodeDisplayElement = document.getElementById(this._qrCodeDisplayElementId);
    if (qrCodeDisplayElement) {
      qrCodeDisplayElement.style.display = "none";
    }
  }
}

class JamAction {
  constructor(jamConnectClient, name) {
    this._client = jamConnectClient;
    this._name = name;
    this._isRunning = false;
  }

  get client() { return this._client; }
  get name() { return this._name; }
  get canStart() {
    const [canStart] = this.canActionStart();
    return canStart;
  }
  get isRunning() { return this._isRunning; }

  canActionStart() {
    if (this.isRunning)
      return [false, "Action is already running"];

    const startPreventionReason = this._getStartPreventionReason();
    if (startPreventionReason)
      return [false, startPreventionReason];
    return [true, ""];
  }

  async execute() {
    const [canStart, reason] = this.canActionStart();
    if (!canStart) throw new Error(reason);
    this._isRunning = true;
    this.client.stateChanged();
    try {
      await this._executeAction();
    } finally {
      this._isRunning = false;
      this.client.stateChanged();
    }
  }

  _getStartPreventionReason() {}
}

class InviteJamGuestAction extends JamAction {
  constructor(jamConnectClient) {
    super(jamConnectClient, JamConnectActions.InviteJamGuest);
  }

  async _executeAction() {
    await this.client.stopScanner();
    const joinPanel = document.getElementById('jam-join-panel');
    if (joinPanel) joinPanel.style.display = 'none';

    const { sessionId, authToken, inviteUrl } = await this.client.connector.createHostSession();

    const hostPanel = document.getElementById('jam-host-panel');
    if (hostPanel) hostPanel.style.display = 'flex';

    const sessionEl = document.getElementById('jam-session-id-display');
    const tokenEl = document.getElementById('jam-auth-token-display');
    const urlInput = document.getElementById('jam-invite-url-input');

    if (sessionEl) sessionEl.textContent = sessionId;
    if (tokenEl) tokenEl.textContent = authToken;
    if (urlInput) urlInput.value = inviteUrl;

    // QR code now embeds ONLY the short session URL (~70 chars instead of 2500+ chars SDP!)
    this.client.displayQrCode(inviteUrl);
  }

  _getStartPreventionReason() {
    if (this.client.userRole === JamConnectUserRoles.Guest)
      return "Guests cannot host a session while connected";
  }
}

class JoinJamSessionAction extends JamAction {
  constructor(jamConnectClient) {
    super(jamConnectClient, JamConnectActions.JoinJamSession);
  }

  async _executeAction() {
    const hostPanel = document.getElementById('jam-host-panel');
    if (hostPanel) hostPanel.style.display = 'none';

    const joinPanel = document.getElementById('jam-join-panel');
    if (joinPanel) joinPanel.style.display = 'flex';
  }

  _getStartPreventionReason() {
    if (this.client.userRole === JamConnectUserRoles.Host)
      return "Hosts cannot join another session while hosting";
  }
}

class StartJamTransportAction extends JamAction {
  constructor(jamConnectClient) {
    super(jamConnectClient, JamConnectActions.StartJamTransport);
  }

  async _executeAction() {
    if (!this.client.userRole) {
      Tone.Transport.start();
    } else {
      this.client.connector.startTransport(this.client.bpm);
    }
    this.client._isPlaying = true;
  }

  _getStartPreventionReason() {
    if (this.isRunning) return "Already running";
    if (this.client.userRole === JamConnectUserRoles.Guest && !this.client.connector.permissions.syncTransport) {
      return "Host has locked transport control";
    }
  }
}

class StopJamTransportAction extends JamAction {
  constructor(jamConnectClient) {
    super(jamConnectClient, JamConnectActions.StopJamTransport);
  }

  async _executeAction() {
    if (!this.client.userRole) {
      Tone.Transport.stop();
    } else {
      this.client.connector.stopTransport();
    }
    this.client._isPlaying = false;
  }

  _getStartPreventionReason() {
    if (this.client.userRole === JamConnectUserRoles.Guest && !this.client.connector.permissions.syncTransport) {
      return "Host has locked transport control";
    }
    if (!this.client.isPlaying) return "Not running";
  }
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    JamConnector, JamConnectClient, JamLinkClock, JamLinkTimeline, LocalBridgeConnection,
    BRIDGE_PEER_ID, JAMCONNECT_FALLBACK_CONFIG, jamBridgeUrl, jamMergeConfig, jamRemoteControlPermission
  };
}
