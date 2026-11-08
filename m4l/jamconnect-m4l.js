// JamConnect Link — Node for Max side of the Max for Live device.
// Connects to jamlink-bridge (JamConnect protocol over WebSocket) and relays:
//   Live track MIDI  <->  MIDI_EVENT   (other JamConnect apps play / hear Live)
//   LIVE_* messages  <->  [js jamconnect-live.js] (LiveAPI: clips, scenes, params)
//   tempo / play     ->   LINK_SET_TEMPO / LINK_SET_PLAYING (Live follows via Link)
// No npm dependencies (includes a minimal RFC 6455 client) so the device can be frozen.

const net = require('net');
const crypto = require('crypto');

let maxApi;
try {
  maxApi = require('max-api');
} catch (_) {
  // Allow running outside Max for testing: node jamconnect-m4l.js
  maxApi = {
    outlet: (...a) => console.log('[outlet]', ...a),
    post: (...a) => console.log('[post]', ...a),
    addHandler: () => {},
    addHandlers: () => {},
    MESSAGE_TYPES: { ALL: 'all' }
  };
}

// ---------------------------------------------------------------- minimal WebSocket client
class MiniWebSocket {
  constructor(url) {
    const m = /^ws:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) throw new Error(`unsupported URL ${url} (ws:// only)`);
    this.host = m[1];
    this.port = Number(m[2] || 80);
    this.path = m[3] || '/';
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.readyState = 0;
    this._buf = Buffer.alloc(0);
    this._handshakeDone = false;
    this._fragments = [];
    this._key = crypto.randomBytes(16).toString('base64');
    this._sock = net.connect(this.port, this.host, () => {
      this._sock.setNoDelay(true);
      this._sock.write(
        `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${this._key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    this._sock.on('data', (d) => this._onData(d));
    this._sock.on('error', (e) => { if (this.onerror) this.onerror(e); });
    this._sock.on('close', () => {
      const was = this.readyState;
      this.readyState = 3;
      if (was !== 3 && this.onclose) this.onclose();
    });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    if (!this._handshakeDone) {
      const end = this._buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this._buf.slice(0, end).toString();
      this._buf = this._buf.slice(end + 4);
      const accept = crypto.createHash('sha1')
        .update(this._key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (!/^HTTP\/1\.1 101/.test(head) || head.indexOf(accept) < 0) {
        if (this.onerror) this.onerror(new Error('WebSocket handshake failed'));
        this._sock.destroy();
        return;
      }
      this._handshakeDone = true;
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }
    this._parseFrames();
  }

  _parseFrames() {
    while (this._buf.length >= 2) {
      const b0 = this._buf[0], b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f;
      let len = b1 & 0x7f, pos = 2;
      if (len === 126) { if (this._buf.length < 4) return; len = this._buf.readUInt16BE(2); pos = 4; }
      else if (len === 127) { if (this._buf.length < 10) return; len = Number(this._buf.readBigUInt64BE(2)); pos = 10; }
      const masked = (b1 & 0x80) !== 0;
      const maskPos = pos;
      if (masked) pos += 4;
      if (this._buf.length < pos + len) return;
      let payload = this._buf.slice(pos, pos + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= this._buf[maskPos + (i % 4)];
      }
      this._buf = this._buf.slice(pos + len);
      if (op === 0x1 || op === 0x0) {
        this._fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this._fragments).toString('utf8');
          this._fragments = [];
          if (this.onmessage) this.onmessage({ data: text });
        }
      } else if (op === 0x8) {
        this._frame(0x8, Buffer.alloc(0));
        this._sock.end();
      } else if (op === 0x9) {
        this._frame(0xA, payload);
      }
    }
  }

  _frame(op, payload) {
    const len = payload.length;
    const header = len < 126 ? Buffer.from([0x80 | op, 0x80 | len])
      : len < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, len >> 8, len & 0xff])
        : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    this._sock.write(Buffer.concat([header, mask, body]));
  }

  send(text) {
    if (this.readyState === 1) this._frame(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    if (this.readyState === 1) this._frame(0x8, Buffer.from([0x03, 0xe8]));
    this.readyState = 3;
    this._sock.end();
  }
}

// ---------------------------------------------------------------- JamConnect client
const state = {
  url: 'ws://127.0.0.1:20809',
  token: '',
  name: 'Ableton Live (M4L)',
  want: true,
  ws: null,
  authed: false,
  retry: null,
  lastLink: ''
};

function status(s) { maxApi.outlet('status', s); }

function send(obj) {
  if (state.ws && state.authed) state.ws.send(JSON.stringify(obj));
}

function connect() {
  clearTimeout(state.retry);
  if (state.ws) { try { state.ws.close(); } catch (_) {} }
  state.authed = false;
  status(`connecting ${state.url}`);
  let ws;
  try {
    ws = new MiniWebSocket(state.url);
  } catch (e) {
    status(`error ${e.message}`);
    return;
  }
  state.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'AUTH_HELLO', authToken: state.token, name: state.name, appName: 'JamConnect M4L' }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (ws === state.ws) handle(msg);
  };
  ws.onerror = (e) => status(`error ${e.message}`);
  ws.onclose = () => {
    if (ws !== state.ws) return;
    state.authed = false;
    status('disconnected');
    if (state.want) state.retry = setTimeout(connect, 2000);
  };
}

function handle(msg) {
  switch (msg.type) {
    case 'AUTH_OK':
      state.authed = true;
      status(`connected ${msg.sessionId || ''}`);
      break;
    case 'AUTH_REJECTED':
      state.want = false;
      status(`rejected ${msg.reason || ''}`);
      break;
    case 'PING':
      send({ type: 'PONG', hostSendTime: msg.hostSendTime, guestReceiveTime: performance.now() });
      break;
    case 'LINK_STATE': {
      const line = `${Number(msg.tempo).toFixed(2)} ${msg.isPlaying ? 1 : 0} ${msg.numPeers}`;
      if (line !== state.lastLink) {
        state.lastLink = line;
        maxApi.outlet('link', Number(msg.tempo), msg.isPlaying ? 1 : 0, Number(msg.numPeers) || 0);
      }
      break;
    }
    case 'PEER_LIST':
      maxApi.outlet('peers', (msg.peers || []).length);
      break;
    case 'MIDI_EVENT': {
      const e = msg.event || {};
      const ch = Number(e.channel) || 1;
      if (e.kind === 'noteon' || e.kind === 'noteoff') {
        const vel = e.kind === 'noteoff' ? 0 : Math.max(1, Math.min(127, Math.round(Number(e.velocity) || 100)));
        maxApi.outlet('note', Number(e.note) | 0, vel, ch);
      } else if (e.kind === 'cc') {
        maxApi.outlet('cc', Number(e.cc) | 0, Number(e.value) | 0, ch);
      }
      break;
    }
    case 'PAD_PLAY': {
      // Acid303-style pads: map note names like "C2" to MIDI if possible.
      const n = typeof msg.note === 'number' ? msg.note : noteNameToMidi(msg.note);
      if (n !== null) {
        const vel = Math.round((Number(msg.velocity) || 0.8) * 127);
        maxApi.outlet('note', n, vel, 1);
        setTimeout(() => maxApi.outlet('note', n, 0, 1), 150);
      }
      break;
    }
    case 'DEVICE_PARAMETER_CHANGE':
      maxApi.outlet('param', String(msg.appName || ''), String(msg.param), Number(msg.value));
      break;
    default:
      if (typeof msg.type === 'string' && msg.type.startsWith('LIVE_') && msg.type !== 'LIVE_SET_INFO' && msg.type !== 'LIVE_ERROR') {
        maxApi.outlet('live', msg.type, JSON.stringify(msg));
      }
  }
}

function noteNameToMidi(name) {
  const m = /^([A-Ga-g])(#|b)?(-?\d+)$/.exec(String(name || ''));
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 2) * 12 + base + acc; // Live convention: C3 = 60
}

// ---------------------------------------------------------------- Max inlet messages
maxApi.addHandlers({
  connect: (url, token) => {
    if (url) state.url = String(url);
    if (token !== undefined) state.token = String(token);
    state.want = true;
    connect();
  },
  disconnect: () => {
    state.want = false;
    clearTimeout(state.retry);
    if (state.ws) state.ws.close();
    status('disconnected');
  },
  name: (...parts) => { state.name = parts.join(' '); },
  token: (t) => { state.token = String(t || ''); },
  note: (pitch, vel, ch) => {
    const v = Number(vel) | 0;
    send({ type: 'MIDI_EVENT', appName: 'Ableton Live', event: { kind: v > 0 ? 'noteon' : 'noteoff', note: Number(pitch) | 0, velocity: v, channel: Number(ch) || 1 } });
  },
  cc: (num, val, ch) => {
    send({ type: 'MIDI_EVENT', appName: 'Ableton Live', event: { kind: 'cc', cc: Number(num) | 0, value: Number(val) | 0, channel: Number(ch) || 1 } });
  },
  param: (name, value) => {
    send({ type: 'DEVICE_PARAMETER_CHANGE', appName: 'Ableton Live', param: String(name), value: Number(value) });
  },
  tempo: (bpm) => send({ type: 'LINK_SET_TEMPO', bpm: Number(bpm) }),
  play: (on) => send({ type: 'LINK_SET_PLAYING', playing: Number(on) !== 0 }),
  // Replies from [js jamconnect-live.js]
  liveinfo: (json) => {
    try { send({ type: 'LIVE_SET_INFO', ...JSON.parse(String(json)) }); } catch (e) { maxApi.post(`bad liveinfo: ${e.message}`); }
  },
  liveerror: (...parts) => send({ type: 'LIVE_ERROR', message: parts.join(' ') })
});

connect();
