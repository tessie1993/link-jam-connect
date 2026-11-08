// Test harness for the Max for Live side, pure Node (no Max, no Live, no binaries):
//   * FakeLive: a small Live Object Model (song, tracks, return/master tracks, mixer, clip slots,
//     devices, parameters, this_device, live_app) with observers, call and set logs
//   * createLiveContext(): runs m4l/jamconnect-live.js in a vm with mocked LiveAPI, Task, outlet, post
//   * startFakeBridge(): a JamConnect hub over real WebSockets (auth + relay, records Link control)
//   * loadM4lInstance(): loads m4l/jamconnect-m4l.js with a mocked max-api wired to a live context

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE_JS = path.join(root, 'm4l', 'jamconnect-live.js');
export const M4L_JS = path.join(root, 'm4l', 'jamconnect-m4l.js');

let failures = 0;
export const ok = (cond, label, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
  return !!cond;
};
export const failureCount = () => failures;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, timeoutMs = 2000, stepMs = 10) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(stepMs); }
  return fn();
}
export const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

export function loadConfig(args = process.argv.slice(2)) {
  const i = args.indexOf('--config');
  const file = path.resolve(i >= 0 ? args[i + 1] : path.join(root, 'jamconnect.config.json'));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------- fake Live Object Model
let nextId = 1;

function node(props = {}, children = {}, fns = {}) {
  return { id: nextId++, props, children, fns, observers: new Set() };
}

function param(name, min, max, value, opts = {}) {
  const p = node({
    name, original_name: name, min, max, value, is_quantized: opts.items ? 1 : 0, is_enabled: 1,
    ...(opts.items ? { value_items: opts.items } : { default_value: opts.def !== undefined ? opts.def : min })
  });
  p.fns.str_for_value = (v) => (opts.items ? opts.items[Math.round(v)] : `${Number(v).toFixed(2)}${opts.unit || ''}`);
  return p;
}

function mixer(sends) {
  return node({}, {
    volume: param('Track Volume', 0, 1, 0.85, { unit: ' vol' }),
    panning: param('Track Panning', -1, 1, 0, { unit: ' pan' }),
    sends: Array.from({ length: sends }, (_, i) => param(`Send ${String.fromCharCode(65 + i)}`, 0, 1, 0))
  });
}

function device(name, extraParams = 0) {
  const params = [
    param('Device On', 0, 1, 1, { items: ['Off', 'On'] }),
    param('Filter Freq', 20, 20000, 1000, { unit: ' Hz', def: 20000 }),
    param('Filter Type', 0, 3, 0, { items: ['LP', 'HP', 'BP', 'Notch'] }),
    param('Drive', 0, 1, 0.2, { def: 0 })
  ];
  for (let i = 0; i < extraParams; i++) params.push(param(`Extra ${i}`, 0, 1, 0));
  return node({ name, class_name: 'AutoFilter', class_display_name: 'Auto Filter', type: 2, is_active: 1, can_have_chains: 0 }, { parameters: params });
}

export class FakeLive {
  constructor({ tracks = 3, scenes = 4, returns = 2, sends = returns, tempo, bigDeviceParams = 0 } = {}) {
    this.calls = [];
    this.sets = [];
    this.sendsPerTrack = sends;
    const songFns = {};
    for (const fn of ['start_playing', 'stop_playing', 'continue_playing', 'undo', 'redo', 'tap_tempo', 'capture_midi',
      'stop_all_clips', 'jump_by', 'jump_to_next_cue', 'jump_to_prev_cue', 're_enable_automation',
      'trigger_session_record', 'capture_and_insert_scene', 'set_or_delete_cue']) songFns[fn] = () => undefined;
    this.song = node({
      tempo, is_playing: 0, record_mode: 0, metronome: 0, overdub: 0, session_record: 0, loop: 0, loop_start: 0,
      loop_length: 16, current_song_time: 0, signature_numerator: 4, signature_denominator: 4, groove_amount: 1,
      swing_amount: 0, clip_trigger_quantization: 4, midi_recording_quantization: 0, punch_in: 0, punch_out: 0,
      back_to_arranger: 0, can_undo: 0, can_redo: 0, can_capture_midi: 0, is_counting_in: 0,
      session_automation_record: 0, start_time: 0, is_ableton_link_enabled: 1, is_ableton_link_start_stop_sync_enabled: 1
    }, { tracks: [], return_tracks: [], scenes: [] }, songFns);
    for (let s = 0; s < scenes; s++) this.song.children.scenes.push(node({ name: `Scene ${s + 1}`, color: 0x223344, is_triggered: 0 }, {}, { fire: () => undefined }));
    for (let t = 0; t < tracks; t++) this.song.children.tracks.push(this.makeTrack(t, scenes, bigDeviceParams && t === 0 ? bigDeviceParams : 0));
    for (let r = 0; r < returns; r++) {
      this.song.children.return_tracks.push(node({ name: `${String.fromCharCode(65 + r)}-Return`, color: 0x445566, mute: 0, solo: 0 },
        { mixer_device: mixer(sends), devices: [device('Reverb')] }, { stop_all_clips: () => undefined }));
    }
    this.song.children.master_track = node({ name: 'Master', color: 0x666666 }, { mixer_device: mixer(0), devices: [device('Limiter')] });
    this.app = node({}, {}, { get_major_version: () => 12, get_minor_version: () => 1, get_bugfix_version: () => 5 });
  }

  makeTrack(t, scenes, extraParams) {
    const slots = Array.from({ length: scenes }, (_, s) => {
      const has = (t + s) % 2 === 0;
      return node({ has_clip: has ? 1 : 0, is_triggered: 0 }, has ? {
        clip: node({ name: `Clip ${t}.${s}`, color: 0x10ff20, is_playing: 0, is_triggered: 0, is_recording: 0 })
      } : {}, { fire: () => undefined, stop: () => undefined });
    });
    const devices = [device(`Filter ${t}`, extraParams), device(`Drive ${t}`)];
    return node({
      name: `Track ${t + 1}`, color: 0xff0000 + t, mute: 0, solo: 0, arm: 0, can_be_armed: 1, has_midi_input: 1,
      playing_slot_index: -1, fired_slot_index: -1
    }, { clip_slots: slots, devices, mixer_device: mixer(this.sendsPerTrack) }, { stop_all_clips: () => undefined });
  }

  /** Resolve a LOM path ("live_set tracks 0 devices 1 parameters 2"); returns { node, path } or null. */
  resolve(p, thisDevice) {
    const tokens = String(p || '').replace(/"/g, '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    if (tokens[0] === 'this_device') {
      const r = thisDevice ? this.resolve(thisDevice) : null;
      if (!r) return null;
      const rest = tokens.slice(1).join(' ');
      return rest ? this.resolve(`${r.path} ${rest}`) : r;
    }
    if (tokens[0] === 'live_app') return tokens.length === 1 ? { node: this.app, path: 'live_app' } : null;
    if (tokens[0] !== 'live_set') return null;
    let cur = this.song;
    const canon = ['live_set'];
    for (let i = 1; i < tokens.length; i++) {
      const c = cur.children[tokens[i]];
      if (Array.isArray(c)) {
        const idx = Number(tokens[++i]);
        if (!Number.isInteger(idx) || !c[idx]) return null;
        cur = c[idx];
        canon.push(tokens[i - 1], String(idx));
      } else if (c) {
        cur = c;
        canon.push(tokens[i]);
      } else {
        return null;
      }
    }
    return { node: cur, path: canon.join(' ') };
  }

  /** A change made inside Live (user, automation, clip launch): notifies observers. */
  change(p, prop, value) {
    const r = this.resolve(p);
    if (!r) throw new Error(`fake Live: no object at ${p}`);
    r.node.props[prop] = value;
    for (const api of r.node.observers) api._notify(prop);
  }

  addTrack() {
    const scenes = this.song.children.scenes.length;
    this.song.children.tracks.push(this.makeTrack(this.song.children.tracks.length, scenes, 0));
    for (const api of this.song.observers) api._notify('tracks');
  }

  get(p, prop) {
    return this.resolve(p).node.props[prop];
  }

  observerCount() {
    let n = 0;
    const walk = (nd, seen) => {
      if (seen.has(nd)) return;
      seen.add(nd);
      n += nd.observers.size;
      for (const c of Object.values(nd.children)) (Array.isArray(c) ? c : [c]).forEach((x) => walk(x, seen));
    };
    walk(this.song, new Set());
    return n;
  }

  callsOf(fn) { return this.calls.filter((c) => c.fn === fn); }
}

function makeLiveApiClass(live, thisDevice) {
  return class LiveAPI {
    constructor(a, b) {
      this._cb = typeof a === 'function' ? a : null;
      this._prop = '';
      this.path = typeof a === 'function' ? b : a;
    }

    set path(p) {
      const r = live.resolve(p, thisDevice);
      this._node = r ? r.node : null;
      this._path = r ? r.path : '';
    }

    get path() { return `"${this._path}"`; }
    get unquotedpath() { return this._path; }
    get id() { return this._node ? this._node.id : 0; }

    _value(prop) {
      const n = this._node;
      if (!n) return undefined;
      if (prop in n.props) return n.props[prop];
      const c = n.children[prop];
      if (Array.isArray(c)) return c.flatMap((x) => ['id', x.id]);
      return undefined;
    }

    get(prop) {
      const v = this._value(prop);
      if (v === undefined) return [];
      return Array.isArray(v) ? v.slice() : [v];
    }

    getcount(child) {
      const c = this._node && this._node.children[child];
      return Array.isArray(c) ? c.length : 0;
    }

    set(prop, value) {
      if (!this._node) return;
      live.sets.push({ path: this._path, prop, value });
      this._node.props[prop] = value;
      for (const api of this._node.observers) api._notify(prop);
    }

    call(fn, ...args) {
      if (!this._node) return undefined;
      live.calls.push({ path: this._path, fn, args });
      const f = this._node.fns[fn];
      return f ? f(...args) : undefined;
    }

    set property(p) {
      if (this._node) this._node.observers.delete(this);
      this._prop = p;
      if (p && this._node) {
        this._node.observers.add(this);
        this._notify(p); // Live reports the current value when observation starts
      }
    }

    get property() { return this._prop; }

    _notify(prop) {
      if (prop !== this._prop || !this._cb) return;
      const v = this._value(prop);
      this._cb([prop, ...(Array.isArray(v) ? v : [v])]);
    }
  };
}

// ---------------------------------------------------------------- jamconnect-live.js in a vm
export function createLiveContext({ live, thisDevice = null, fakeClock = true, onOutlet = null } = {}) {
  const out = { events: [], replies: [], infos: [], errors: [], deviceinfos: [], dials: [], pattr: null, all: [] };
  const clock = { now: 1e6, tasks: [] };
  function Task(fn) { this.fn = fn; }
  Task.prototype.schedule = function (ms) {
    if (fakeClock) clock.tasks.push({ at: clock.now + (ms || 0), fn: this.fn });
    else setTimeout(this.fn, ms || 0);
  };
  Task.prototype.cancel = function () {};
  const sandbox = {
    LiveAPI: makeLiveApiClass(live, thisDevice),
    Task,
    post: () => {},
    outlet: (n, ...args) => {
      out.all.push([n, ...args]);
      if (n === 0) {
        const [sel, a, b] = args;
        if (sel === 'liveevent') out.events.push({ type: a, ...JSON.parse(b) });
        else if (sel === 'livereply') out.replies.push({ type: a, ...JSON.parse(b) });
        else if (sel === 'liveinfo') out.infos.push(JSON.parse(a));
        else if (sel === 'liveerror') out.errors.push(args.slice(1).join(' '));
        else if (sel === 'deviceinfo') out.deviceinfos.push(JSON.parse(a));
      } else if (n === 1 && args[0] === 'set') {
        out.pattr = args[1];
      } else if (n === 2) {
        out.dials.push([args[0], args[1]]);
      }
      if (onOutlet) onOutlet(n, args);
    }
  };
  if (fakeClock) sandbox.Date = { now: () => clock.now };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(LIVE_JS, 'utf8'), ctx, { filename: 'jamconnect-live.js' });
  return {
    ctx,
    out,
    clock,
    send(type, msg = {}, cfg) {
      ctx.live(type, JSON.stringify(cfg ? { ...msg, cfg } : msg));
    },
    advance(ms) {
      clock.now += ms;
      for (;;) {
        clock.tasks.sort((a, b) => a.at - b.at);
        if (!clock.tasks.length || clock.tasks[0].at > clock.now) break;
        clock.tasks.shift().fn();
      }
    },
    lastReply(type) { return [...out.replies].reverse().find((r) => r.type === type); },
    clear() { for (const k of ['events', 'replies', 'infos', 'errors', 'deviceinfos', 'dials', 'all']) out[k].length = 0; }
  };
}

// ---------------------------------------------------------------- fake bridge (JamConnect hub)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsFrame(text) {
  const body = Buffer.from(text, 'utf8');
  const len = body.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) head = Buffer.from([0x81, 126, len >> 8, len & 0xff]);
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, body]);
}

export async function startFakeBridge() {
  const clients = new Set();
  const bridge = {
    received: [],   // { from, msg } for every message a client sent (after auth)
    toApp: [],      // messages the bridge relayed (devices -> the test "app")
    linkControl: [],
    port: 0,
    clients,
    /** Send a message from the test "app" to every connected device (like a hub relay). */
    inject(msg) { for (const c of clients) if (c.authed) c.send({ ...msg, from: 'test-app' }); },
    of(type) { return this.toApp.filter((m) => m.type === type); },
    clear() { this.received.length = 0; this.toApp.length = 0; this.linkControl.length = 0; },
    close() { for (const c of clients) c.sock.destroy(); server.close(); }
  };
  const server = http.createServer((_, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, sock) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const c = { sock, buf: Buffer.alloc(0), authed: false, name: '', send: (o) => { if (!sock.destroyed) sock.write(wsFrame(JSON.stringify(o))); } };
    clients.add(c);
    sock.on('close', () => clients.delete(c));
    sock.on('error', () => clients.delete(c));
    sock.on('data', (d) => {
      c.buf = Buffer.concat([c.buf, d]);
      while (c.buf.length >= 2) {
        const op = c.buf[0] & 0x0f;
        let len = c.buf[1] & 0x7f, pos = 2;
        if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); pos = 4; }
        else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); pos = 10; }
        const masked = (c.buf[1] & 0x80) !== 0;
        const maskPos = pos;
        if (masked) pos += 4;
        if (c.buf.length < pos + len) return;
        const payload = Buffer.from(c.buf.slice(pos, pos + len));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= c.buf[maskPos + (i % 4)];
        c.buf = c.buf.slice(pos + len);
        if (op === 0x8) { sock.end(); return; }
        if (op !== 0x1) continue;
        const msg = JSON.parse(payload.toString('utf8'));
        if (!c.authed) {
          if (msg.type === 'AUTH_HELLO') {
            c.authed = true;
            c.name = msg.name;
            c.send({ type: 'AUTH_OK', sessionId: 'LINK-TEST', peerId: `bridge-${clients.size}`, permissions: {} });
          }
          continue;
        }
        bridge.received.push({ from: c, msg });
        if (msg.type.startsWith('LINK_')) { bridge.linkControl.push(msg); continue; }
        if (msg.type === 'PONG') continue;
        bridge.toApp.push(msg);
        for (const o of clients) if (o !== c && o.authed) o.send({ ...msg, from: c.name });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  bridge.port = server.address().port;
  bridge.url = `ws://127.0.0.1:${bridge.port}`;
  return bridge;
}

// ---------------------------------------------------------------- jamconnect-m4l.js with a mocked max-api
let currentMaxApi = null;
let hooked = false;
function hookMaxApi() {
  if (hooked) return;
  hooked = true;
  const Module = require('node:module');
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'max-api') return currentMaxApi;
    return orig.call(this, request, ...rest);
  };
}

/** Write a config file with overrides (the M4L script reads it like jamconnect.config.json). */
export function writeTempConfig(config, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-m4l-'));
  const file = path.join(dir, name || 'jamconnect.config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/**
 * Load one device instance: node script + LiveAPI js, wired like the generated patch
 * (node "live" outlet -> js, js outlet 0 -> node handlers, js outlet 2 -> macro dial -> js macro()).
 */
export function loadM4lInstance({ url, configFile, instance, live, thisDevice, macroRange }) {
  hookMaxApi();
  const maxApi = {
    outlets: [],
    handlers: {},
    posts: [],
    outlet(...a) {
      this.outlets.push(a);
      if (a[0] === 'live') queueMicrotask(() => lc.ctx.live(a[1], a[2]));
    },
    post(...a) { this.posts.push(a.join(' ')); },
    addHandler(n, f) { this.handlers[n] = f; },
    addHandlers(h) { Object.assign(this.handlers, h); },
    MESSAGE_TYPES: { ALL: 'all' }
  };
  const lc = createLiveContext({
    live, thisDevice, fakeClock: false,
    onOutlet: (n, args) => {
      if (n === 0) {
        const f = maxApi.handlers[args[0]];
        if (f) f(...args.slice(1));
      } else if (n === 2) {
        // live.dial: clamps to its range and outputs the value back into the js
        const [i, v] = args;
        const r = macroRange(i);
        lc.ctx.macro(i, Math.max(r.min, Math.min(r.max, v)));
      }
    }
  });
  currentMaxApi = maxApi;
  const savedArgv = process.argv;
  process.argv = [savedArgv[0], M4L_JS, '--url', url, '--config', configFile, '--instance', instance];
  delete require.cache[require.resolve(M4L_JS)];
  const mod = require(M4L_JS);
  process.argv = savedArgv;
  lc.ctx.deviceready(); // [live.thisdevice]
  return {
    instance, maxApi, lc, mod,
    notes() { return maxApi.outlets.filter((o) => o[0] === 'note').map((o) => o.slice(1)); },
    ccs() { return maxApi.outlets.filter((o) => o[0] === 'cc').map((o) => o.slice(1)); },
    liveCalls() { return maxApi.outlets.filter((o) => o[0] === 'live').map((o) => o[1]); },
    stop() { maxApi.handlers.disconnect(); }
  };
}
