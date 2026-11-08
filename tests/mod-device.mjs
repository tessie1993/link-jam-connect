// JamConnect Mod Device test, pure Node (no browser, no sensors, no Rust toolchain needed):
//
//   node tests/mod-device.mjs [--config jamconnect.config.json] [--core apps/mod-device/engine/mod-core.wasm | --mock]
//
// The modulation math lives in the Rust core (apps/mod-device/core-rs, `cargo test` covers it natively).
// This test drives the JS shell (apps/mod-device/engine.js) against the real WebAssembly core when it
// is built (CI job mod-wasm), otherwise against tests/mod-core-mock.cjs (same exports):
// 1. ABI / schema consistency, core math through the ABI (LFO phase lock across tempo changes with two
//    peers, envelope stages in beats / ms, and with the real core: physics determinism, bounded chaos,
//    Euclidean triggers, gestures, shake);
// 2. transform chain, decimated curve error bound, lead-time scheduling with a mocked _sessionOneWayMs;
// 3. PARAMS-PROTOCOL modulator behaviour against a mock instrument over a fake bridge (real WebSockets);
// 4. Ableton routing against tests/m4l-harness.mjs (LIVE_SET_PARAM / M4L_SET_MACRO / M4L_CC, rate limits);
// 5. permission gating for WebRTC guests (client side and host side); app files.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  FakeLive, startFakeBridge, loadM4lInstance, writeTempConfig, loadConfig,
  ok, near, sleep, waitFor, failureCount, root
} from './m4l-harness.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const config = loadConfig(args);
const cfg = config.client.modulator;
const S = require(path.join(root, 'apps', 'mod-device', 'schema.js'));
const M = require(path.join(root, 'apps', 'mod-device', 'engine.js'));
const { createMockCore } = require('./mod-core-mock.cjs');

const defaultWasm = path.join(root, 'apps', 'mod-device', 'engine', 'mod-core.wasm');
const wasmPath = args.includes('--mock') ? null : args.includes('--core') ? path.resolve(args[args.indexOf('--core') + 1]) : (fs.existsSync(defaultWasm) ? defaultWasm : null);
if (args.includes('--core') && !fs.existsSync(wasmPath)) { console.log(`FAIL  core not found: ${wasmPath}`); process.exit(1); }
const REAL = !!wasmPath;
const wasmBytes = REAL ? fs.readFileSync(wasmPath) : null;
console.log(REAL ? `core: ${path.relative(root, wasmPath)} (Rust / WebAssembly, ${wasmBytes.length} bytes)` : 'core: tests/mod-core-mock.cjs (JS mock; build the Rust core in CI for the full test)');
const newCore = async () => (REAL ? M.loadCore(wasmBytes) : createMockCore());

// ---------------------------------------------------------------- mocks
class MockTimeline {
  constructor(tempo, quantum, t0 = 0) { this.quantum = quantum; this.seg = [{ atMs: t0, beat: 0, tempo }]; }
  _seg(ms) { let s = this.seg[0]; for (const x of this.seg) if (x.atMs <= ms) s = x; return s; }
  beatAt(ms) { const s = this._seg(ms); return s.beat + (ms - s.atMs) * s.tempo / 60000; }
  timeAt(beat) { let s = this.seg[0]; for (const x of this.seg) if (x.beat <= beat) s = x; return s.atMs + (beat - s.beat) * 60000 / s.tempo; }
  setTempo(atMs, tempo) { this.seg.push({ atMs, beat: this.beatAt(atMs), tempo }); }
  tempoAt(ms) { return this._seg(ms).tempo; }
}
/** Clock of one peer whose local clock is offset from the reference clock by offsetMs. */
function mockClock(tl, { offsetMs = 0, oneWay = { ms: 0 } } = {}) {
  let last = 0;
  return {
    hasTimeline: () => true,
    beatAtTime: (ms) => { last = ms; return tl.beatAt(ms - offsetMs); },
    timeAtBeat: (b) => tl.timeAt(b) + offsetMs,
    oneWayMs: () => oneWay.ms,
    quantum: () => tl.quantum,
    tempo: () => tl.tempoAt(last - offsetMs)
  };
}
const noTimeline = { hasTimeline: () => false, beatAtTime: () => null, timeAtBeat: () => null, oneWayMs: () => 0, quantum: () => 4, tempo: () => null };
function recIo(perms = {}, guest = false) {
  const sent = [];
  return { sent, send: (m) => sent.push(m), connected: () => true, isGuest: () => guest, permissions: () => perms, basePermission: null, of: (t) => sent.filter((m) => m.type === t) };
}
async function newDevice(clock, io = recIo(), extra = {}) {
  return new M.ModDevice({ cfg: { ...cfg, ...extra }, core: await newCore(), clock, io, seed: 1234 });
}
const TEMPO_A = 120.5, TEMPO_B = 87.25; // mocked Link session tempi (test data only)

// ---------------------------------------------------------------- 1. config / ABI
ok(cfg && cfg.maxRoutes > 0 && cfg.send.jamParamIntervalMs > 0 && cfg.send.liveParamIntervalMs > 0 && cfg.send.m4lMacroIntervalMs > 0 && cfg.send.m4lCcIntervalMs > 0, 'client.modulator: route limit and per-target send rates configured');
ok(cfg.curve.tolerance > 0 && cfg.curve.renderStepMs > 0 && cfg.curve.bufferPoints > 0 && cfg.curve.outputPoints > 0 && cfg.curve.maxPointsPerMessage >= 2, 'client.modulator.curve configured');
ok(S.CONFIG_KEYS.every((k) => Number.isFinite(S.cfgPath(cfg, k))), 'every core config key is in client.modulator', `${S.CONFIG_KEYS.length} keys`);
ok(!JSON.stringify(cfg).match(/"(default)?[Tt]empo"/), 'no default tempo in client.modulator');
{
  const core = await newCore();
  ok(M.checkCore(core).length === 0, 'core exports and type tables match schema.js', M.checkCore(core).join('; '));
  const used = [...new Set(fs.readFileSync(path.join(root, 'apps', 'mod-device', 'engine.js'), 'utf8').match(/core_[a-z_]+/g))];
  const missing = used.filter((n) => typeof core[n] !== 'function');
  ok(missing.length === 0, 'every core function the shell calls is exported', missing.join(', ') || `${used.length} functions`);
  if (REAL) ok(core.memory instanceof WebAssembly.Memory && core.core_version() >= 1, 'real WebAssembly core loaded (exports memory, C ABI)');
  if (REAL) {
    const names = (c) => Object.keys(c).filter((k) => k.startsWith('core_') && typeof c[k] === 'function').sort();
    const real = names(core), mock = names(createMockCore());
    const diff = [...real.filter((n) => !mock.includes(n)).map((n) => `mock lacks ${n}`), ...mock.filter((n) => !real.includes(n)).map((n) => `wasm lacks ${n}`)];
    ok(diff.length === 0, 'tests/mod-core-mock.cjs exports exactly the real core_* functions', diff.join(', ') || `${real.length} functions`);
    ok(createMockCore().core_version() === core.core_version(), 'mock and real core report the same core_version');
  }
}

// ---------------------------------------------------------------- 2. core math through the ABI
{
  const tl = new MockTimeline(TEMPO_A, 4);
  const OFF = 12345.678; // peer B's performance.now() origin differs
  const A = await newDevice(mockClock(tl));
  const B = await newDevice(mockClock(tl, { offsetMs: OFF }));
  for (const d of [A, B]) d.addSource({ id: 'l', type: 'lfo', params: { shape: 'sine', sync: 'link', division: '1/4', modifier: 'straight' } });
  const tChange = 1003;
  tl.setTempo(tChange, TEMPO_B);
  let worstPeer = 0, worstShape = 0, worstJump = 0, prev = null;
  for (let t = 0; t <= 2500; t += 7) {
    A.tick(t); B.tick(t + OFF);
    const a = A.value('l.out'), b = B.value('l.out');
    worstPeer = Math.max(worstPeer, Math.abs(a - b));
    worstShape = Math.max(worstShape, Math.abs(a - Math.sin(2 * Math.PI * (tl.beatAt(t) % 1))));
    if (prev !== null) worstJump = Math.max(worstJump, Math.abs(a - prev));
    prev = a;
  }
  ok(worstPeer < 1e-9, 'two peers with different local clocks produce the same LFO value at the same moment', `max diff ${worstPeer.toExponential(2)}`);
  ok(worstShape < 1e-9, 'LFO phase = Link beat / period across a tempo change', `max err ${worstShape.toExponential(2)}`);
  ok(worstJump <= 2 * Math.PI * 7 * TEMPO_A / 60000 + 1e-9, 'no phase jump at the tempo change', worstJump.toFixed(4));
  A.setBase('l.division', '1/8');
  A.setBase('l.modifier', 'triplet');
  const b0 = tl.beatAt(3000);
  A.tick(3000);
  ok(near(A.value('l.out'), Math.sin(2 * Math.PI * ((b0 * 3) % 1)), 1e-9), 'triplet division: 1/8 bar x 2/3 = 1/3 beat');
  A.setBase('l.sync', 'free');
  A.setBase('l.hz', 2);
  A.tick(3125);
  ok(near(A.value('l.out'), Math.sin(2 * Math.PI * ((3125 / 1000 * 2) % 1)), 1e-9), 'free-running LFO in Hz');

  const E = await newDevice(mockClock(tl));
  E.addSource({ id: 'e', type: 'env', params: { mode: 'adsr', unit: 'beats', attack: 1, decay: 1, sustain: 0.5, release: 1, attackCurve: 'lin', decayCurve: 'lin', trigger: 'beat', everyBeats: 4, gateLen: 2 } });
  const at = (beat) => { E.tick(tl.timeAt(beat)); return E.value('e.out'); };
  ok(near(at(8.5), 0.5, 1e-9) && near(at(9.5), 0.75, 1e-9) && near(at(10.5), 0.25, 1e-9) && near(at(11.75), 0, 1e-9), 'beat-triggered envelope: attack / decay / release in Link beats');
  E.addSource({ id: 'p', type: 'pad', params: { physics: 'none' } });
  E.addSource({ id: 'g', type: 'env', params: { mode: 'adsr', unit: 'ms', attack: 100, decay: 100, sustain: 0.5, release: 100, attackCurve: 'lin', decayCurve: 'lin', trigger: 'gate' }, refs: { trigger: 'p.gate' } });
  const T0 = tl.timeAt(20);
  E.tick(T0);
  E.pointer('p', 0, 1, 0.5, 0.5, null, 10, T0 + 10);
  E.tick(T0 + 10);
  E.tick(T0 + 60);
  const att = E.value('g.out');
  E.tick(T0 + 400);
  const sus = E.value('g.out');
  E.pointer('p', 2, 1, 0.5, 0.5, null, 10, T0 + 405);
  E.tick(T0 + 410);
  E.tick(T0 + 460);
  ok(near(att, 0.5, 1e-9) && near(sus, 0.5, 1e-9) && near(E.value('g.out'), 0.25, 1e-9), 'touch-gated envelope in ms (attack, sustain, release)');
  E.addSource({ id: 'm', type: 'motion' });
  E.addSource({ id: 's', type: 'env', params: { mode: 'adsr', unit: 'ms', attack: 0, decay: 0, sustain: 1, release: 0, trigger: 'trigger', gateLen: 50 }, refs: { trigger: 'm.shake' } });
  E.motionAccel('m', { x: cfg.sensors.shakeThreshold * 1.5, y: 0, z: 0 }, null, T0 + 800);
  E.tick(T0 + 805);
  const shook = E.value('s.out');
  E.tick(T0 + 880);
  ok(near(shook, 1) && E.value('s.out') === 0, 'shake detection triggers an envelope with a gate length');

  if (REAL) {
    const D = await newDevice(mockClock(tl));
    for (const t of ['lorenz', 'logistic', 'walk', 'perlin', 'ball', 'well', 'seq', 'euclid']) D.addSource({ id: t, type: t });
    D.setBase('lorenz.speed', 10);
    D.setBase('logistic.r', 4);
    D.setBase('walk.rate', 200);
    D.setBase('walk.sigma', 0.5);
    D.setBase('ball.trigger', 'beat');
    D.setBase('ball.everyBeats', 1);
    let bounded = true, moved = new Set();
    for (let t = 0; t < 20000; t += 16) {
      D.tick(t);
      for (const o of D.allOutputs()) {
        const v = D.value(o.ref);
        if (!Number.isFinite(v) || (o.bipolar ? v < -1 || v > 1 : v < 0 || v > 1)) bounded = false;
        moved.add(`${o.ref}:${v.toFixed(3)}`);
      }
    }
    ok(bounded, 'Rust core: chaos / walk / Perlin / ball / gravity well / seq / Euclid outputs finite and in range');
    ok(moved.size > 300, 'Rust core: those sources move', String(moved.size));
    D.addSource({ id: 'eu', type: 'euclid', params: { steps: 8, pulses: 3, rotate: 0, division: '1/8', gate: 0.5 } });
    const pat = [];
    for (let k = 0; k < 8; k++) { D.tick(tl.timeAt(400 + k * 0.5 + 0.1)); pat.push(D.value('eu.gate') ? 'x' : '.'); }
    ok(pat.join('') === 'x..x..x.', 'Rust core: Euclidean E(3,8) on the Link grid', pat.join(''));
    const run = async (frames) => {
      const P = await newDevice(noTimeline);
      P.addSource({ id: 'xy', type: 'pad', params: { physics: 'bounce', friction: 1.5, restitution: 0.75 } });
      let t = 0;
      P.tick(t);
      P.pointer('xy', 0, 1, 0.9, 0.1, null, 10, 0);
      for (let i = 1; i <= 5; i++) { t = i * 10; P.pointer('xy', 1, 1, 0.9 - i * 0.03, 0.1 + i * 0.02, null, 10, t); P.tick(t); }
      P.pointer('xy', 2, 1, 0.75, 0.2, null, 10, t);
      for (const f of frames) { t += f; P.tick(t); }
      return [P.value('xy.x'), P.value('xy.y')];
    };
    const a = await run(Array.from({ length: 125 }, () => 16));
    const fr = [];
    let left = 2000;
    while (left > 0) { const f = Math.min(left, 3 + (fr.length * 7) % 29); fr.push(f); left -= f; }
    const b = await run(fr);
    ok(a[0] === b[0] && a[1] === b[1] && a[0] >= 0 && a[0] <= 1, 'Rust core: fixed-timestep physics, identical for different frame slicing', `${a[0].toFixed(4)},${a[1].toFixed(4)}`);
    const G = await newDevice(noTimeline);
    G.addSource({ id: 'xy', type: 'pad' });
    G.tick(0);
    G.pointer('xy', 0, 1, 0.1, 0.5, null, 10, 0);
    G.pointer('xy', 0, 2, 0.2, 0.5, null, 10, 0);
    G.pointer('xy', 1, 2, 0.1 + 0.1 * cfg.gestures.pinchRange, 0.5, null, 10, 16);
    G.tick(16);
    ok(near(G.value('xy.pinch'), 1, 1e-9) && near(G.value('xy.fingers'), 2 / cfg.gestures.maxFingers, 1e-12), 'Rust core: pinch gesture and finger count');
  }
}

// ---------------------------------------------------------------- 3. transforms / decimation / lead time
{
  const D = await newDevice(noTimeline);
  D.addSource({ id: 'p', type: 'pad', params: { physics: 'none' } });
  const r = D.addRoute({ id: 'r', source: 'p.x', mode: 'absolute' });
  D.tick(0);
  D.pointer('p', 0, 1, 0.2, 0.5, null, 10, 0);
  const val = (patch, mode = 'absolute') => { D.updateRoute('r', { mode, transform: { depth: 1, offset: 0, curve: 'lin', steps: 0, invert: false, polarity: 'auto', slewMs: 0, ...patch } }); D.tick(10); return D.routeValue('r'); };
  ok(near(val({}), 0.2) && near(val({ depth: 0.5, offset: 0.25 }), 0.35) && near(val({ invert: true }), 0.8), 'transform: depth, offset, invert');
  ok(near(val({ steps: 3 }), 0) && near(val({ curve: 'exp', curveAmount: 3 }), (Math.exp(0.6) - 1) / (Math.exp(3) - 1)), 'transform: quantize steps and response curve');
  ok(near(val({ depth: -0.8 }, 'offset'), -0.16) && near(val({ polarity: 'bi' }, 'offset'), -0.6), 'transform: offset mode (unipolar source, forced bipolar)');
  D.updateRoute('r', { mode: 'absolute', transform: { depth: 1, offset: 0, curve: 'lin', steps: 0, invert: false, polarity: 'auto', slewMs: 100 } });
  D.tick(20);
  D.pointer('p', 1, 1, 1, 0.5, null, 10, 20);
  D.tick(45);
  ok(near(D.routeValue('r'), 0.45, 1e-9), 'transform: slew limits the rate (full range in slewMs)', D.routeValue('r').toFixed(3));
  ok(r && D.routes.size === 1, 'route created');

  // decimated curves from the core stay within tolerance of the true signal
  const tl = new MockTimeline(TEMPO_A, 4);
  const oneWay = { ms: 20 };
  const io = recIo();
  const L = await newDevice(mockClock(tl, { oneWay }), io);
  L.instruments.set('synth-1', { instanceId: 'synth-1', appName: 'Synth', kind: 'instrument', params: [{ id: 'cutoff', name: 'Cutoff', min: 0, max: 1, default: 0.5, scale: 'lin', modulatable: true }], values: {} });
  L.addSource({ id: 'w', type: 'lfo', params: { shape: 'sine', sync: 'link', division: '1/4' } });
  L.addRoute({ id: 'r', source: 'w.out', mode: 'offset', transform: { depth: 0.5 }, targets: [{ kind: 'jam', instanceId: 'synth-1', param: 'cutoff' }] });
  for (let t = 2000; t <= 3000; t += 10) L.tick(t);
  const pc = io.of('JAM_PARAM_CURVE');
  const pts = pc.flatMap((c) => c.points);
  const exact = (b) => 0.5 * Math.sin(2 * Math.PI * (b % 1));
  ok(pc.length > 0 && pc.every((c) => c.mode === 'offset' && c.target === 'synth-1' && c.param === 'cutoff') && pts.every((p) => Math.abs(p.norm - exact(p.linkBeat)) < 1e-9), 'Link-synced curve points carry exact LFO values at their Link beats', `${pts.length} points`);
  let worst = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    for (let k = 1; k < 10; k++) { const x = a.linkBeat + (b.linkBeat - a.linkBeat) * k / 10; worst = Math.max(worst, Math.abs(a.norm + (b.norm - a.norm) * k / 10 - exact(x))); }
  }
  const h = cfg.curve.renderStepMs * TEMPO_A / 60000;
  const sampling = Math.pow(2 * Math.PI, 2) * 0.5 * h * h / 8;
  ok(worst <= cfg.curve.tolerance + sampling + 1e-9, 'decimated polyline error <= curve.tolerance (+ render-step sampling)', `${worst.toExponential(2)} <= ${(cfg.curve.tolerance + sampling).toExponential(2)}`);
  const rendered = (tl.beatAt(3000) - tl.beatAt(2000)) / h;
  ok(pts.length < rendered * 0.6, 'decimation removes most rendered points', `${pts.length} of ~${Math.round(rendered)}`);
  ok(pts.every((p, i) => !i || p.linkBeat > pts[i - 1].linkBeat), 'curve beats strictly increase across messages');
  const lead = oneWay.ms + cfg.send.jamParamIntervalMs + cfg.curve.leadMarginMs;
  ok(near(pts[0].linkBeat, tl.beatAt(2000 + lead), 1e-9) && pts.at(-1).linkBeat <= tl.beatAt(3000 + lead + cfg.curve.lookaheadMs) + 1e-9, 'predictable sources rendered from now + lead up to the lookahead');
  ok(pc.length <= Math.ceil(1000 / cfg.send.jamParamIntervalMs) + 1 && pc.every((c) => c.points.length <= cfg.curve.maxPointsPerMessage), 'curves sent at jamParamIntervalMs, points per message capped', `${pc.length} msgs`);

  // realtime sources: stamped at now + measured one-way latency + send interval + margin
  const io2 = recIo();
  const P = await newDevice(mockClock(tl, { oneWay }), io2);
  P.instruments = L.instruments;
  P.addSource({ id: 'xy', type: 'pad', params: { physics: 'none' } });
  P.addRoute({ id: 'r', source: 'xy.x', mode: 'absolute', targets: [{ kind: 'jam', instanceId: 'synth-1', param: 'cutoff' }] });
  P.tick(4000);
  P.pointer('xy', 0, 1, 0.3, 0.5, null, 10, 4000);
  for (let t = 4010; t <= 4200; t += 10) { P.pointer('xy', 1, 1, 0.3 + (t - 4000) / 1000, 0.5, null, 10, t); P.tick(t); }
  const rc = io2.of('JAM_PARAM_CURVE');
  ok(rc.length && near(rc[0].points[0].linkBeat, tl.beatAt(4010 + lead), 1e-9), 'realtime points stamped at now + one-way latency + send interval + margin', `lead ${lead} ms`);
  oneWay.ms = 80;
  for (let t = 4210; t <= 4300; t += 10) { P.pointer('xy', 1, 1, 0.5, 0.5, null, 10, t); P.tick(t); }
  const lastP = io2.of('JAM_PARAM_CURVE').at(-1).points.at(-1);
  const lead80 = 80 + cfg.send.jamParamIntervalMs + cfg.curve.leadMarginMs;
  const stamped = [];
  for (let t = 4210; t <= 4300; t += 10) stamped.push(tl.beatAt(t + lead80));
  ok(stamped.some((b) => near(b, lastP.linkBeat, 1e-9)), 'lead follows the measured latency (_sessionOneWayMs)');
  ok(io2.of('JAM_PARAM_TOUCH').length === 1, 'absolute route touches the target on gesture start');
}

// ---------------------------------------------------------------- 4. PARAMS-PROTOCOL against a mock instrument
const { FakePeer } = await import('./fake-peerjs.mjs');
globalThis.Peer = FakePeer;
globalThis.window = { location: new URL('http://jamconnect.test/apps/mod-device/') };
const { JamConnector, jamRemoteControlPermission } = require(path.join(root, 'JamConnect', 'jamconnect.js'));
const tone = () => ({ now: () => performance.now() / 1000, context: { lookAhead: 0, currentTime: 0 },
  Transport: { bpm: { value: null }, swing: 0, state: 'stopped', seconds: 0, ticks: 0, PPQ: 192, start() {}, stop() {} } });
JamConnector.configure(config);
const connIo = (c, guest = false) => ({
  send: (m) => c.sendRelayMessage(m), connected: () => c.isHost || c.isConnectedToHost, isGuest: () => guest && c.transport === 'webrtc' && !c.isHost && c.isConnectedToHost,
  permissions: () => c.permissions, basePermission: jamRemoteControlPermission
});
const runDevice = (dev) => { const t = setInterval(() => dev.tick(performance.now()), cfg.tickIntervalMs); return () => clearInterval(t); };
{
  const bridge = await startFakeBridge();
  const tl = new MockTimeline(TEMPO_A, 4, performance.now());
  const mod = new JamConnector('mod', tone(), { followLink: false, adoptTransportTempo: false });
  const inst = new JamConnector('synth', tone(), { followLink: false, adoptTransportTempo: false });
  await mod.joinLocalBridge(bridge.url, '', 'mod');
  await inst.joinLocalBridge(bridge.url, '', 'synth');
  const atInst = [];
  const SYNTH = 'wt-TEST1';
  const manifest = [
    { id: 'cutoff', name: 'Filter Cutoff', group: 'Filter', min: 20, max: 20000, default: 1000, unit: 'Hz', scale: 'exp', modulatable: true },
    { id: 'wtpos', name: 'Wavetable Position', group: 'Osc', min: 0, max: 1, default: 0, scale: 'lin', modulatable: true }
  ];
  inst.onRelayMessage = (m) => {
    atInst.push({ ...m, at: performance.now() });
    if (m.type === 'JAM_PARAMS_DISCOVER' && (!m.target || m.target === SYNTH)) inst.sendRelayMessage({ type: 'JAM_PARAMS_ANNOUNCE', instanceId: SYNTH, appName: 'Wavetable Synth', kind: 'instrument', params: manifest });
  };
  const dev = new M.ModDevice({ cfg, core: await newCore(), clock: mockClock(tl), io: connIo(mod), appName: 'mod', seed: 9 });
  mod.onRelayMessage = (m) => dev.handleMessage(m);
  const stop = runDevice(dev);
  const of = (t) => atInst.filter((m) => m.type === t);

  dev.discover();
  ok(await waitFor(() => dev.instruments.has(SYNTH), 2000), 'JAM_PARAMS_DISCOVER -> instrument JAM_PARAMS_ANNOUNCE registered');
  dev.addSource({ id: 'lfo1', type: 'lfo', params: { shape: 'sine', sync: 'link', division: '1/4' } });
  dev.addRoute({ id: 'wob', name: 'Wobble', source: 'lfo1.out', mode: 'offset', transform: { depth: 0.5 }, targets: [{ kind: 'jam', instanceId: '*', match: 'cutoff' }] });
  ok(await waitFor(() => of('JAM_PARAMS_ANNOUNCE').some((m) => m.instanceId === dev.instanceId && m.params.some((p) => p.id === 'lfo1.hz')), 2000), 'modulator announces its own manifest');
  const man = of('JAM_PARAMS_ANNOUNCE').filter((m) => m.instanceId === dev.instanceId).pop();
  const rate = man.params.find((p) => p.id === 'lfo1.hz');
  ok(man.kind === 'modulator' && rate.modulatable && rate.min === cfg.ranges.lfo.hz[0] && rate.scale === 'exp' && man.params.some((p) => p.id === 'wob.depth') && man.params.some((p) => p.id === 'lfo1.shape' && p.valueItems), 'manifest: kind "modulator", LFO rate (exp), route depth, choices with valueItems');
  await waitFor(() => of('JAM_PARAM_CURVE').length >= 5, 2000);
  const curves = of('JAM_PARAM_CURVE');
  ok(curves.length >= 5 && curves.every((c) => c.target === SYNTH && c.param === 'cutoff' && c.mode === 'offset' && c.source === dev.instanceId), 'JAM_PARAM_CURVE to the instrument param found by name, offset mode, source = modulator');
  const pts = curves.flatMap((c) => c.points);
  ok(pts.every((p) => Math.abs(p.norm - 0.5 * Math.sin(2 * Math.PI * (p.linkBeat % 1))) < 1e-9 && p.shape === 'linear'), 'breakpoints are LFO values at their Link beats', `${pts.length} points`);
  ok(curves.every((c) => c.points[0].linkBeat >= tl.beatAt(c.at) - 1e-6), 'breakpoints arrive ahead of their Link beat');
  ok(!of('JAM_PARAM_TOUCH').length, 'offset routes do not take ownership (touchOffsetRoutes false)');
  dev.removeRoute('wob');
  await sleep(100);
  ok(of('JAM_PARAM_CURVE').at(-1).points.at(-1).norm === 0, 'stopping an offset route returns the modulation to 0');

  atInst.length = 0;
  dev.addSource({ id: 'xy', type: 'pad', params: { physics: 'none' } });
  dev.addRoute({ id: 'xr', source: 'xy.x', mode: 'absolute', targets: [{ kind: 'jam', instanceId: SYNTH, param: 'wtpos' }] });
  await sleep(50);
  ok(!of('JAM_PARAM_TOUCH').length && !of('JAM_PARAM_CURVE').length, 'an untouched pad sends nothing');
  dev.pointer('xy', 0, 7, 0.2, 0.5, null, 10, performance.now());
  for (let i = 1; i <= 15; i++) { await sleep(10); dev.pointer('xy', 1, 7, 0.2 + i * 0.04, 0.5, null, 10, performance.now()); }
  await sleep(30);
  dev.pointer('xy', 2, 7, 0.8, 0.5, null, 10, performance.now());
  await waitFor(() => of('JAM_PARAM_RELEASE').length, 2000);
  const seq = atInst.filter((m) => /^JAM_PARAM_(TOUCH|CURVE|RELEASE)$/.test(m.type)).map((m) => m.type.replace('JAM_PARAM_', ''));
  ok(seq[0] === 'TOUCH' && seq.at(-1) === 'RELEASE' && seq.filter((t) => t === 'CURVE').length >= 2, 'TOUCH on gesture start, curves, RELEASE on gesture end', seq.join(' '));
  const tc = of('JAM_PARAM_TOUCH')[0];
  ok(tc.target === SYNTH && tc.param === 'wtpos' && tc.source === dev.instanceId && of('JAM_PARAM_RELEASE')[0].source === dev.instanceId, 'touch / release carry target, param and source');
  const absPts = of('JAM_PARAM_CURVE').flatMap((c) => c.points);
  ok(of('JAM_PARAM_CURVE').every((c) => c.mode === 'absolute') && absPts.every((p) => p.norm >= 0 && p.norm <= 1) && near(absPts.at(-1).norm, 0.8, 1e-9), 'absolute curve follows the finger', absPts.at(-1).norm.toFixed(3));

  atInst.length = 0;
  dev.setHold(true);
  dev.pointer('xy', 0, 8, 0.5, 0.5, null, 10, performance.now());
  await sleep(60);
  dev.pointer('xy', 2, 8, 0.5, 0.5, null, 10, performance.now());
  await sleep(120);
  ok(of('JAM_PARAM_TOUCH').length === 1 && !of('JAM_PARAM_RELEASE').length, 'hold latch: no RELEASE after the finger lifts');
  dev.setHold(false);
  ok(await waitFor(() => of('JAM_PARAM_RELEASE').length === 1, 1000), 'releasing the latch sends RELEASE');

  atInst.length = 0;
  dev.pointer('xy', 0, 9, 0.5, 0.5, null, 10, performance.now());
  await waitFor(() => of('JAM_PARAM_CURVE').length, 1000);
  dev.panic();
  await sleep(30);
  const nC = of('JAM_PARAM_CURVE').length;
  await sleep(120);
  ok(of('JAM_PARAM_RELEASE').length === 1 && of('JAM_PARAM_CURVE').length === nC, 'panic / freeze sends RELEASE and stops modulation');
  dev.pointer('xy', 2, 9, 0.5, 0.5, null, 10, performance.now());
  dev.setFrozen(false);

  dev.addRoute({ id: 'lr', source: 'lfo1.out', mode: 'offset', enabled: false });
  dev.startLearn('lr', performance.now());
  inst.sendRelayMessage({ type: 'JAM_PARAM_CHANGED', instanceId: SYNTH, param: 'wtpos', norm: 0.5 }); // already targeted -> ignored
  inst.sendRelayMessage({ type: 'JAM_PARAM_CHANGED', instanceId: SYNTH, param: 'cutoff', norm: 0.3 });
  await waitFor(() => dev.routes.get('lr').senders.length, 1000);
  const lt = dev.routes.get('lr').senders.map((s) => s.t);
  ok(lt.length === 1 && lt[0].kind === 'jam' && lt[0].param === 'cutoff' && dev.learn === null, 'learn mode picks the wiggled instrument parameter (JAM_PARAM_CHANGED)');
  ok(dev.instrumentValue(SYNTH, 'cutoff') === 0.3, 'JAM_PARAM_CHANGED followed');

  atInst.length = 0;
  const hzDef = dev.paramDef('lfo1.hz').def;
  inst.sendRelayMessage({ type: 'JAM_PARAM_SET', target: dev.instanceId, param: 'lfo1.hz', norm: 1 });
  ok(await waitFor(() => near(dev.sources.get('lfo1').params.hz, hzDef.max, 1e-9), 1000), 'JAM_PARAM_SET on the modulator\'s own manifest (LFO rate)');
  ok(await waitFor(() => of('JAM_PARAM_CHANGED').some((m) => m.instanceId === dev.instanceId && m.param === 'lfo1.hz' && Math.abs(m.norm - 1) < 1e-9), 1000), 'own parameter change echoed as JAM_PARAM_CHANGED');
  inst.sendRelayMessage({ type: 'JAM_PARAM_TOUCH', target: dev.instanceId, param: 'xr.depth', source: 'ctl-A' });
  const nb = tl.beatAt(performance.now());
  inst.sendRelayMessage({ type: 'JAM_PARAM_CURVE', target: dev.instanceId, param: 'xr.depth', mode: 'absolute', source: 'ctl-A', points: [{ linkBeat: nb - 1, norm: 0.75 }, { linkBeat: nb + 1000, norm: 0.75 }] });
  ok(await waitFor(() => near(dev.effective('xr.depth'), 0.5, 1e-9), 1000), 'JAM_PARAM_CURVE modulates an own parameter (route depth) in the core', String(dev.effective('xr.depth')));
  inst.sendRelayMessage({ type: 'JAM_PARAM_SET', target: dev.instanceId, param: 'xr.depth', norm: 0, source: 'ctl-B' });
  await sleep(100);
  ok(near(dev.effective('xr.depth'), 0.5, 1e-9) && dev.routes.get('xr').transform.depth === 1, 'touched own parameter ignores other sources');
  inst.sendRelayMessage({ type: 'JAM_PARAM_RELEASE', target: dev.instanceId, param: 'xr.depth', source: 'ctl-A' });
  ok(await waitFor(() => near(dev.routes.get('xr').transform.depth, 0.5, 1e-9) && !dev.touches.has('xr.depth'), 1000), 'RELEASE commits the value and frees the parameter');
  dev.addSource({ id: 'hold', type: 'pad', params: { physics: 'none' } });
  dev.addRoute({ id: 'self', source: 'hold.x', mode: 'absolute', targets: [{ kind: 'self', param: 'lfo1.phase' }] });
  dev.pointer('hold', 0, 3, 0.3, 0.5, null, 10, performance.now());
  ok(await waitFor(() => near(dev.effective('lfo1.phase'), 0.3, 1e-9), 1000), 'routes modulate the device\'s own parameters (in the core)', String(dev.effective('lfo1.phase')));
  dev.pointer('hold', 2, 3, 0.3, 0.5, null, 10, performance.now());
  atInst.length = 0;
  inst.sendRelayMessage({ type: 'JAM_PARAMS_DISCOVER', target: dev.instanceId });
  ok(await waitFor(() => of('JAM_PARAMS_ANNOUNCE').some((m) => m.instanceId === dev.instanceId), 1000), 'targeted DISCOVER answered with ANNOUNCE');
  inst.sendRelayMessage({ type: 'JAM_PARAMS_BYE', instanceId: SYNTH });
  ok(await waitFor(() => !dev.instruments.has(SYNTH), 1000), 'JAM_PARAMS_BYE forgets the instrument');

  const scene = dev.toScene();
  const D2 = await newDevice(mockClock(tl));
  D2.loadScene(JSON.parse(JSON.stringify(scene)));
  ok(JSON.stringify(D2.toScene().routes) === JSON.stringify(scene.routes) && D2.sources.size === dev.sources.size, 'scene export / import round-trips sources and routes');
  for (const f of S.factoryScenes()) { const D3 = await newDevice(mockClock(tl)); D3.loadScene(f.scene); D3.tick(performance.now()); ok(D3.routes.size >= 1 && D3.sources.size >= 1, `factory scene "${f.name}" loads`); }
  const big = await newDevice(noTimeline);
  for (let i = 0; i < cfg.maxRoutes + 3; i++) big.addRoute({});
  ok(big.routes.size === cfg.maxRoutes, 'route count capped by client.modulator.maxRoutes');
  stop();
  mod.disconnect();
  inst.disconnect();
  bridge.close();
}

// ---------------------------------------------------------------- 5. Ableton routing against the M4L harness
{
  const testCfg = JSON.parse(JSON.stringify(config));
  Object.assign(testCfg.m4l, { statusIntervalMs: 200, reconnectMs: 0 });
  const configFile = writeTempConfig(testCfg);
  const bridge = await startFakeBridge();
  const live = new FakeLive({ tracks: 2, scenes: 1, returns: 1 });
  const m4l = loadM4lInstance({ url: bridge.url, configFile, instance: 'm4l-aaaa', live, thisDevice: 'live_set tracks 0 devices 0', macroRange: (i) => testCfg.m4l.macros[i] });
  const mod = new JamConnector('mod', tone(), { followLink: false, adoptTransportTempo: false });
  await mod.joinLocalBridge(bridge.url, '', 'mod');
  const dev = new M.ModDevice({ cfg, core: await newCore(), clock: noTimeline, io: connIo(mod), seed: 3 });
  mod.onRelayMessage = (m) => dev.handleMessage(m);
  mod.sendRelayMessage({ type: 'M4L_DISCOVER' });
  ok(await waitFor(() => dev.m4l.has('m4l-aaaa'), 3000), 'M4L devices discovered (M4L_HELLO)');
  dev.addSource({ id: 'l', type: 'lfo', params: { shape: 'saw', sync: 'free', hz: 4 } });
  dev.addRoute({ id: 'lv', source: 'l.out', targets: [{ kind: 'live', track: 1, device: 0, param: 3 }] });
  dev.addRoute({ id: 'mc', source: 'l.out', targets: [{ kind: 'macro', instance: '*first', macro: 2 }, { kind: 'cc', instance: '*first', cc: 74, channel: 3 }] });
  bridge.clear();
  const t0 = performance.now();
  const stop = runDevice(dev);
  await sleep(700);
  stop();
  const elapsed = performance.now() - t0;
  const fromMod = (t) => bridge.received.filter((r) => r.msg.type === t && r.msg.appName === 'mod').map((r) => r.msg);
  const lp = fromMod('LIVE_SET_PARAM'), mm = fromMod('M4L_SET_MACRO'), cc = fromMod('M4L_CC');
  ok(lp.length > 3 && lp.every((m) => m.track === 1 && m.device === 0 && m.param === 3 && m.normalized >= 0 && m.normalized <= 1 && m.target === undefined), 'LIVE_SET_PARAM {track, device, param, normalized} to the primary device', `${lp.length} msgs`);
  ok(mm.length > 3 && mm.every((m) => m.target === 'm4l-aaaa' && m.macro === 2), 'M4L_SET_MACRO to the first discovered device ("*first")', `${mm.length} msgs`);
  ok(cc.length > 3 && cc.every((m) => m.cc === 74 && m.channel === 3 && Number.isInteger(m.value) && m.value >= 0 && m.value <= 127), 'M4L_CC with integer values 0..127', `${cc.length} msgs`);
  const allow = (iv) => Math.ceil(elapsed / iv) + 1;
  ok(lp.length <= allow(cfg.send.liveParamIntervalMs) && mm.length <= allow(cfg.send.m4lMacroIntervalMs) && cc.length <= allow(cfg.send.m4lCcIntervalMs), 'each Ableton target sends at its configured rate', `${lp.length}/${allow(cfg.send.liveParamIntervalMs)} ${mm.length}/${allow(cfg.send.m4lMacroIntervalMs)} ${cc.length}/${allow(cfg.send.m4lCcIntervalMs)}`);
  const total = lp.length + mm.length + cc.length;
  ok(total <= cfg.send.abletonMaxPerSecond * elapsed / 1000 + cfg.send.abletonMaxPerSecond, 'total Ableton traffic within abletonMaxPerSecond', `${total} msgs`);
  // Wait for the last message to travel bridge -> M4L node script -> LiveAPI js (slow CI runners).
  ok(await waitFor(() => near(live.get('live_set tracks 1 devices 0 parameters 3', 'value'), lp.at(-1).normalized, 1e-9), 3000), 'the Live parameter follows the modulation (fake LOM)');
  ok(m4l.lc.out.dials.some((d) => d[0] === 2) && m4l.ccs().some((c) => c[0] === 74 && c[2] === 3), 'the device moves its macro dial and sends the CC');
  const tight = new M.ModDevice({ cfg: { ...cfg, send: { ...cfg.send, abletonMaxPerSecond: 10 } }, core: await newCore(), clock: noTimeline, io: connIo(mod), seed: 4 });
  tight.addSource({ id: 'l', type: 'lfo', params: { shape: 'saw', sync: 'free', hz: 4 } });
  for (let i = 0; i < 4; i++) tight.addRoute({ source: 'l.out', targets: [{ kind: 'live', track: 0, device: 1, param: i }] });
  bridge.clear();
  const t1 = performance.now();
  const stop2 = runDevice(tight);
  await sleep(600);
  stop2();
  const n2 = bridge.received.filter((r) => r.msg.type === 'LIVE_SET_PARAM').length;
  ok(n2 <= 10 * (performance.now() - t1) / 1000 + 10 + 1, 'shared LiveAPI budget caps several routes together', `${n2} msgs with budget 10/s`);
  const e3 = await newDevice(noTimeline);
  e3.addSource({ id: 'l', type: 'lfo', params: { shape: 'square', sync: 'free', hz: 1 } });
  e3.addRoute({ id: 'o', source: 'l.out', mode: 'offset', transform: { depth: 0.25 }, targets: [{ kind: 'live', track: 0, device: 0, param: 1, base: 0.5 }] });
  e3.tick(0); e3.tick(100);
  ok(near(e3.io.of('LIVE_SET_PARAM').at(-1).normalized, 0.75), 'offset mode on Ableton targets = base + modulation');
  e3.addRoute({ id: 'learn' });
  e3.startLearn('learn', 0);
  e3.handleMessage({ type: 'LIVE_PARAM_CHANGED', track: 0, device: 0, param: 1, normalized: 0.4 });
  e3.handleMessage({ type: 'LIVE_PARAM_CHANGED', track: 1, device: 0, param: 2, normalized: 0.4, instance: 'm4l-aaaa' });
  const lt = e3.routes.get('learn').senders[0];
  ok(lt && lt.t.kind === 'live' && lt.t.track === 1 && lt.t.param === 2 && lt.t.base === 0.4, 'learn picks a Live parameter moved in Live (LIVE_PARAM_CHANGED)');
  e3.startLearn('learn', 0);
  e3.handleMessage({ type: 'M4L_MACRO_CHANGED', instance: 'm4l-aaaa', macro: 5, normalized: 0.1 });
  ok(e3.routes.get('learn').senders[1] && e3.routes.get('learn').senders[1].t.macro === 5, 'learn picks an M4L macro (M4L_MACRO_CHANGED)');
  m4l.stop();
  mod.disconnect();
  bridge.close();
}

// ---------------------------------------------------------------- 6. permissions for WebRTC guests
{
  ok(M.permissionFor({ type: 'JAM_PARAM_CURVE' }, jamRemoteControlPermission) === 'syncDeviceParameterChange' && M.permissionFor({ type: 'JAM_PARAMS_ANNOUNCE' }, jamRemoteControlPermission) === null && M.permissionFor({ type: 'M4L_CC' }, jamRemoteControlPermission) === 'syncMidi', 'permission map: JAM_PARAM_* writes and Ableton writes');
  ok(jamRemoteControlPermission({ type: 'JAM_PARAM_SET' }) === 'syncDeviceParameterChange' && jamRemoteControlPermission({ type: 'JAM_PARAM_CHANGED' }) === null, 'jamconnect.js: hosts gate guest JAM_PARAM_* writes');
  {
    const { BRIDGE_PEER_ID } = require(path.join(root, 'JamConnect', 'jamconnect.js'));
    const h = new JamConnector('gate', tone(), { followLink: false, adoptTransportTempo: false });
    h.isHost = true;
    h.permissions = { ...h.permissions, syncDeviceParameterChange: false };
    const relayed = [], errors = [];
    h.onRelayMessage = (m, from) => relayed.push(from);
    h.broadcast = () => {};
    h._connForSender = (id) => id;
    h._sendTo = (_c, m) => errors.push(m);
    const set = { type: 'JAM_PARAM_SET', instrument: 'x', param: 'p', value: 0.5 };
    h._routeMessage({ ...set }, 'guest-1');
    h._routeMessage({ ...set }, BRIDGE_PEER_ID);
    h._routeMessage({ ...set }, 'HOST');
    h._routeMessage({ type: 'JAM_PARAM_CHANGED', instrument: 'x', param: 'p', value: 0.5 }, 'guest-1');
    ok(errors.length === 1 && errors[0].type === 'LIVE_ERROR' && /syncDeviceParameterChange/.test(errors[0].message), 'host refuses a guest JAM_PARAM_SET without syncDeviceParameterChange');
    ok(relayed.join() === [BRIDGE_PEER_ID, 'HOST', 'guest-1'].join(), 'bridge- and host-originated JAM_PARAM_SET pass the gate; JAM_PARAM_CHANGED is ungated');
  }
  const host = new JamConnector('host', tone(), { followLink: false, adoptTransportTempo: false });
  const info = await host.createHostSession();
  const guest = new JamConnector('guest', tone(), { followLink: false, adoptTransportTempo: false });
  await guest.joinHost(info.inviteUrl, '', 'guest');
  const atHost = [], atGuest = [];
  host.onRelayMessage = (m) => atHost.push(m);
  const tl = new MockTimeline(TEMPO_A, 4, performance.now());
  const dev = new M.ModDevice({ cfg, core: await newCore(), clock: mockClock(tl), io: connIo(guest, true), seed: 5 });
  guest.onRelayMessage = (m) => { atGuest.push(m); dev.handleMessage(m); };
  host.sendRelayMessage({ type: 'JAM_PARAMS_ANNOUNCE', instanceId: 'host-synth', appName: 'Synth', kind: 'instrument', params: [{ id: 'cutoff', name: 'Cutoff', min: 0, max: 1, default: 0.5, modulatable: true }] });
  ok(await waitFor(() => dev.instruments.has('host-synth'), 2000), 'guest modulator discovers the host instrument');
  dev.addSource({ id: 'l', type: 'lfo', params: { shape: 'sine', sync: 'link', division: '1/4' } });
  const r = dev.addRoute({ source: 'l.out', mode: 'offset', targets: [{ kind: 'jam', instanceId: 'host-synth', param: 'cutoff' }, { kind: 'cc', cc: 1 }] });
  const stop = runDevice(dev);
  await sleep(300);
  ok(!atHost.some((m) => m.type === 'JAM_PARAM_CURVE') && r.senders[0].status === 'blocked', 'guest without "Params / macros" permission sends no curves (shown as blocked)');
  ok(atHost.some((m) => m.type === 'M4L_CC'), 'guest with MIDI permission still sends M4L_CC');
  host.sendPermissionsUpdate({ syncDeviceParameterChange: true });
  ok(await waitFor(() => atHost.some((m) => m.type === 'JAM_PARAM_CURVE'), 2000), 'granting the permission lets the curves through');
  host.sendPermissionsUpdate({ syncDeviceParameterChange: false, syncMidi: false });
  await sleep(200);
  atHost.length = 0;
  await sleep(250);
  ok(!atHost.some((m) => m.type === 'JAM_PARAM_CURVE' || m.type === 'M4L_CC'), 'revoking permissions stops the traffic again');
  stop();
  guest.sendRelayMessage({ type: 'JAM_PARAM_SET', target: 'host-synth', param: 'cutoff', norm: 1, requestId: 'x1' });
  await sleep(200);
  ok(!atHost.some((m) => m.type === 'JAM_PARAM_SET') && atGuest.some((m) => m.type === 'LIVE_ERROR' && m.requestId === 'x1' && /syncDeviceParameterChange/.test(m.message)), 'host drops a guest JAM_PARAM_SET without permission (host-side enforcement)');
  guest.disconnect();
  host.disconnect();
}

// ---------------------------------------------------------------- 7. app files
{
  const dir = path.join(root, 'apps', 'mod-device');
  for (const f of ['index.html', 'app.js', 'engine.js', 'schema.js', 'style.css', 'core-rs/Cargo.toml', 'core-rs/src/lib.rs']) ok(fs.existsSync(path.join(dir, f)), `apps/mod-device/${f} exists`);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  ok(['../../jamconnect.js', '../common/jcapp.js', 'schema.js', 'engine.js', 'app.js'].every((s) => html.includes(s)), 'mod device loads the library, shared code, schema and shell by relative path');
  ok(fs.readFileSync(path.join(root, 'webapp', 'index.html'), 'utf8').includes('apps/mod-device/'), 'main web app links to the mod device');
  const shipped = ['app.js', 'engine.js', 'schema.js'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  ok(!/Math\.(sin|cos|exp|atan2)\(/.test(shipped) && !/function (decimate|bjorklund|envLevel|lfoShape|lorenzStep|perlin)/.test(shipped) && !/class (OneEuro|PadPhysics|MotionProcessor)/.test(shipped), 'no modulation math in the shipped JS (it lives in the Rust core)');
  ok(/engine\/mod-core\.wasm/.test(shipped) && /core not built/i.test(shipped), 'app loads engine/mod-core.wasm and explains a missing build');
  ok(!/\b1[0-9]{2}(\.\d+)?\s*(bpm|BPM)/.test(shipped) && !/tempo\s*[:=]\s*\d/.test(shipped), 'no default tempo in the app');
  ok(/requestPermission/.test(shipped) && /isSecureContext/.test(shipped), 'iOS motion permission request and secure-context check present');
  ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('apps/mod-device/engine/*.wasm'), '.gitignore excludes the built wasm');
}

console.log(failureCount() ? `\n${failureCount()} check(s) failed` : `\nall checks passed (${REAL ? 'Rust/WebAssembly core' : 'mock core'})`);
process.exit(failureCount() ? 1 : 0);
