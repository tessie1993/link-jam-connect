// End-to-end test: linkpeer (stand-in for Ableton) <-Link-> jamlink-bridge <-JamConnect-> jamconnect.js
//
//   node tests/integration.mjs --bin <dir with jamlink-bridge[.exe] and linkpeer[.exe]> [--config <file>]
//
// Checks: config loading + runtime config endpoint, auth, Link clock sync + phase alignment
// with a real Link peer, tempo and start/stop control in both directions, legacy
// TRANSPORT_STATE, hub relay of MIDI, the WebRTC host relay (in-memory PeerJS stand-in,
// with jitter) guest -> host -> bridge -> Link, the Max for Live node script (outside Max)
// and static web app serving.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const binDir = path.resolve(argValue('--bin', 'build'));
const configPath = path.resolve(argValue('--config', path.join(root, 'jamconnect.config.json')));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const exe = (name) => {
  const candidates = [name, `${name}.exe`, path.join('Release', name), path.join('Release', `${name}.exe`)];
  for (const c of candidates) {
    const p = path.join(binDir, c);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${name} not found in ${binDir}`);
};

const children = [];
let failures = 0;

function ok(cond, label, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return fn();
}

// A free port chosen by the OS, so the test never depends on a fixed port.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(cmd, argv, onLine) {
  const child = spawn(cmd, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let buf = '';
  const feed = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line && onLine) onLine(line);
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  return child;
}

function cleanup() {
  for (const c of children) { try { c.kill(); } catch (_) {} }
}
process.on('exit', cleanup);

// ---------------------------------------------------------------- tempos
// No fixed BPM anywhere: every run picks distinct random tempos inside the configured range.
const usedTempos = [];
function randomTempo() {
  const lo = Math.max(config.bridge.tempoMin, 60);
  const hi = Math.min(config.bridge.tempoMax, 180);
  let t;
  do { t = Math.round((lo + Math.random() * (hi - lo)) * 100) / 100; }
  while (usedTempos.some((u) => Math.abs(u - t) < 5));
  usedTempos.push(t);
  return t;
}
const PEER_START_TEMPO = randomTempo();      // linkpeer (stand-in for Live) session tempo
const BRIDGE_FALLBACK_TEMPO = randomTempo(); // bridge --bpm, overridden by the session
const CLIENT_SET_TEMPO = randomTempo();      // JamConnect -> Link
const GUEST_SET_TEMPO = randomTempo();       // WebRTC guest -> host -> bridge -> Link
const PEER_SET_TEMPO = randomTempo();        // Link -> JamConnect
console.log(`tempos: peer ${PEER_START_TEMPO}, bridge fallback ${BRIDGE_FALLBACK_TEMPO}, client ${CLIENT_SET_TEMPO}, guest ${GUEST_SET_TEMPO}, peer change ${PEER_SET_TEMPO}`);

// ---------------------------------------------------------------- Node stand-ins for browser APIs
function makeToneStub() {
  return {
    now: () => performance.now() / 1000,
    context: { lookAhead: 0, currentTime: 0 },
    Transport: {
      bpm: { value: null }, swing: 0, state: 'stopped', seconds: 0, ticks: 0, PPQ: 192,
      start() { this.state = 'started'; }, stop() { this.state = 'stopped'; }
    }
  };
}

const { FakePeer } = await import('./fake-peerjs.mjs');
globalThis.Peer = FakePeer;
globalThis.window = { location: new URL('http://jamconnect.test/') };

const { JamConnector } = require(path.join(root, 'JamConnect', 'jamconnect.js'));

function phaseError(beatA, beatB, q) {
  return Math.abs((((beatA - beatB) % q) + q * 1.5) % q - q / 2);
}

async function main() {
  const PORT = await freePort();
  const URL = `ws://127.0.0.1:${PORT}`;
  const quantum = config.bridge.quantum;

  // Library takes everything from the same config file the bridge uses.
  JamConnector.configure({ ...config, client: { ...config.client, bridgeUrl: URL } });

  // 1. Link peer standing in for Ableton Live, started first like a running Live set:
  //    Link keeps the established session's timeline when a new peer joins.
  const peer = [];
  run(exe('linkpeer'), ['--seconds', '75', '--bpm', String(PEER_START_TEMPO),
    '--tempo-at', `34:${PEER_SET_TEMPO}`, '--stop-at', '38'], (l) => {
    if (l.startsWith('{')) { try { peer.push(JSON.parse(l)); } catch (_) {} }
  });
  const lastPeer = () => peer[peer.length - 1];
  ok(await waitFor(() => peer.length >= 2, 5000), 'Link peer running before the bridge');

  // 2. bridge (config file + CLI overrides)
  const bridgeLog = [];
  run(exe('jamlink-bridge'), ['--config', configPath, '--port', String(PORT), '--bpm', String(BRIDGE_FALLBACK_TEMPO), '--quiet'],
    (l) => { bridgeLog.push(l); console.log(`  [bridge] ${l}`); });
  ok(await waitFor(() => bridgeLog.some((l) => l.includes('listening')), 5000), 'bridge starts from config file');

  // 3. static web app + runtime config
  const index = await fetch(`http://127.0.0.1:${PORT}/`).then(async (r) => { const t = await r.text(); return r.status === 200 && t; }).catch(() => '');
  ok(index && index.includes('JamConnect Link'), 'bridge serves web app (static roots from config)');
  const lib = await fetch(`http://127.0.0.1:${PORT}/jamconnect.js`).then(async (r) => { await r.arrayBuffer(); return r.status; }).catch(() => 0);
  ok(lib === 200, 'bridge serves jamconnect.js');
  const runtimeCfg = await fetch(`http://127.0.0.1:${PORT}/jamconnect.config.json`).then((r) => r.json()).catch(() => null);
  ok(runtimeCfg && runtimeCfg.runtime && runtimeCfg.runtime.servedByBridge && runtimeCfg.bridge.port === PORT,
    'bridge serves runtime config with its real port');
  ok(runtimeCfg && !('token' in (runtimeCfg.bridge || {})), 'runtime config does not leak the bridge token');

  // 4. JamConnect client (local mode)
  const a = new JamConnector('ci-a', makeToneStub(), { followLink: false });
  const transportMsgs = [];
  const origRoute = a._routeMessage.bind(a);
  a._routeMessage = (m, s) => { if (m.type === 'TRANSPORT_STATE') transportMsgs.push(m); return origRoute(m, s); };
  await a.joinLocalBridge(undefined, undefined, 'ci-client-a');
  ok(a.isConnectedToHost, 'client A authenticated with bridge (URL from config)');

  const clockReady = await waitFor(() => { const c = a.linkClocks.get('HOST'); return c && c.measurements > 0; }, 5000);
  ok(clockReady, 'Link-style clock measurement completed');

  // 5. Link session with the peer
  ok(await waitFor(() => a.getLinkState().numPeers >= 1 && lastPeer() && lastPeer().peers >= 1, 10000),
    'bridge and linkpeer discovered each other over Link');
  ok(await waitFor(() => Math.abs(a.getLinkState().tempo - PEER_START_TEMPO) < 0.01, 5000),
    'bridge adopts the existing Link session tempo, not its fallback', `tempo ${a.getLinkState().tempo}`);

  // Phase alignment: same machine => same Link host clock in bridge and linkpeer.
  await sleep(1500);
  const clock = a.linkClocks.get('HOST');
  const worst = Math.max(...peer.slice(-6).map((p) =>
    phaseError(a.linkTimeline.beatAtTime(p.clockUs - clock.offsetUs), p.beat, quantum)));
  ok(worst < 0.02, 'JamConnect timeline phase-locked to Link peer', `worst ${(worst * 60000 / a.getLinkState().tempo).toFixed(2)} ms`);

  // 6. tempo control: JamConnect -> Link
  a.setLinkTempo(CLIENT_SET_TEMPO);
  ok(await waitFor(() => lastPeer() && Math.abs(lastPeer().tempo - CLIENT_SET_TEMPO) < 0.01, 3000),
    'LINK_SET_TEMPO reaches Link peer', `peer tempo ${lastPeer() && lastPeer().tempo}`);
  ok(await waitFor(() => transportMsgs.some((m) => m.state === 'bpmchanged' && Math.abs(m.bpm - CLIENT_SET_TEMPO) < 0.01), 2000),
    'legacy TRANSPORT_STATE bpmchanged emitted');

  // 7. start/stop: JamConnect -> Link
  a.setLinkPlaying(true);
  ok(await waitFor(() => lastPeer() && lastPeer().playing, 3000), 'LINK_SET_PLAYING starts Link peer transport');
  ok(await waitFor(() => a.getLinkState().isPlaying, 2000), 'client sees isPlaying');
  ok(transportMsgs.some((m) => m.state === 'started'), 'legacy TRANSPORT_STATE started emitted');

  // 8. hub relay between two JamConnect clients
  const b = new JamConnector('ci-b', makeToneStub(), { followLink: false });
  const midiAtB = [];
  b.onMidiMessage = (app, ev) => midiAtB.push(ev);
  await b.joinLocalBridge(URL, '', 'ci-client-b');
  a.sendMidiEvent({ kind: 'noteon', note: 60, velocity: 100, channel: 1 });
  ok(await waitFor(() => midiAtB.some((e) => e.note === 60), 2000), 'MIDI_EVENT relayed between JamConnect clients');

  // 9. WebRTC mode: host attached to the bridge, remote guest over (simulated) WebRTC
  await webrtcTest({ URL, quantum, lastPeer, peer, localClient: b, midiAtLocal: midiAtB });

  // 10. Link -> JamConnect (peer changes tempo at t=34 s, stops at t=38 s)
  ok(await waitFor(() => Math.abs(a.getLinkState().tempo - PEER_SET_TEMPO) < 0.01, 40000),
    'tempo change in Link peer reaches JamConnect');
  ok(await waitFor(() => !a.getLinkState().isPlaying, 8000), 'stop in Link peer reaches JamConnect');
  ok(transportMsgs.some((m) => m.state === 'stopped'), 'legacy TRANSPORT_STATE stopped emitted');

  a.disconnect();
  b.disconnect();
  await m4lTest(URL);
}

async function webrtcTest({ URL, quantum, lastPeer, peer, localClient, midiAtLocal }) {
  const host = new JamConnector('ci-host', makeToneStub(), { followLink: false });
  const info = await host.createHostSession();
  ok(info.sessionId.startsWith(config.webrtc.sessionPrefix) && info.authToken.length === config.webrtc.tokenLength,
    'WebRTC host session id/token follow config', `${info.sessionId} / ${info.authToken}`);
  await host.attachLocalBridge(URL);
  ok(host.hasBridge, 'WebRTC host attached to bridge');

  const guest = new JamConnector('ci-guest', makeToneStub(), { followLink: false });
  const midiAtGuest = [];
  guest.onMidiMessage = (app, ev) => midiAtGuest.push(ev);
  await guest.joinHost(info.inviteUrl, '', 'ci-webrtc-guest');
  ok(guest.isConnectedToHost, 'guest joined WebRTC session via invite URL');

  ok(await waitFor(() => guest.getLinkState().source === 'bridge', 3000), 'guest receives Link timeline relayed by host');
  ok(await waitFor(() => {
    const c = guest.linkClocks.get('HOST');
    return c && c.measurements > 0;
  }, 6000), 'guest Link clock measurement over WebRTC completed');

  // Same process => same local clock for host and guest; guest must match the host's view.
  await sleep(1000);
  let worstGuest = 0;
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    worstGuest = Math.max(worstGuest, phaseError(guest.linkBeatAtTime(t), host.linkBeatAtTime(t), quantum));
    await sleep(50);
  }
  const tempo = host.getLinkState().tempo;
  ok(worstGuest < 0.02, 'WebRTC guest phase-locked to host (jittered link, 2 hops from Link)',
    `worst ${(worstGuest * 60000 / tempo).toFixed(2)} ms`);

  // Host view vs the actual Link peer.
  const hc = host.linkClocks.get('BRIDGE');
  const worstHost = Math.max(...peer.slice(-6).map((p) =>
    phaseError(host.linkTimeline.beatAtTime(p.clockUs - hc.offsetUs), p.beat, quantum)));
  ok(worstHost < 0.02, 'WebRTC host phase-locked to Link peer', `worst ${(worstHost * 60000 / tempo).toFixed(2)} ms`);

  // Control from the remote guest reaches Link (guest -> host -> bridge -> Link peer).
  guest.setLinkTempo(GUEST_SET_TEMPO);
  ok(await waitFor(() => lastPeer() && Math.abs(lastPeer().tempo - GUEST_SET_TEMPO) < 0.01, 4000),
    'WebRTC guest tempo change reaches Link peer');
  ok(await waitFor(() => Math.abs(guest.getLinkState().tempo - GUEST_SET_TEMPO) < 0.01, 3000),
    'tempo round-trips back to WebRTC guest');

  // Permissions are enforced by the host.
  host.sendPermissionsUpdate({ syncMasterSettings: false });
  await sleep(200);
  const before = lastPeer().tempo;
  guest.setLinkTempo(randomTempo());
  await sleep(1200);
  ok(Math.abs(lastPeer().tempo - before) < 0.01, 'host blocks guest tempo when permission is off');
  host.sendPermissionsUpdate({ syncMasterSettings: true });

  // Musical traffic both ways between a WebRTC guest and a local bridge client.
  guest.sendMidiEvent({ kind: 'noteon', note: 72, velocity: 99, channel: 1 });
  ok(await waitFor(() => midiAtLocal.some((e) => e.note === 72), 3000), 'MIDI from WebRTC guest reaches local bridge client');
  localClient.sendMidiEvent({ kind: 'noteon', note: 48, velocity: 77, channel: 1 });
  ok(await waitFor(() => midiAtGuest.some((e) => e.note === 48), 3000), 'MIDI from local bridge client reaches WebRTC guest');

  // Host without bridge keeps a pure JamConnect timeline for its guests.
  host.detachLocalBridge();
  ok(await waitFor(() => guest.getLinkState().source === 'host', 3000), 'guest falls back to host timeline when bridge detaches');

  guest.disconnect();
  host.disconnect();
}

async function m4lTest(URL) {
  // Run the Max for Live node script outside Max (console stub for max-api).
  const lines = [];
  run(process.execPath, [path.join(root, 'm4l', 'jamconnect-m4l.js'), '--config', configPath, '--url', URL],
    (l) => lines.push(l));
  ok(await waitFor(() => lines.some((l) => l.includes('status') && l.includes(`connected ${config.bridge.sessionPrefix}`)), 5000),
    'M4L node script connects to bridge');
  const c = new JamConnector('ci-c', makeToneStub(), { followLink: false });
  await c.joinLocalBridge(URL, '', 'ci-client-c');
  c.sendMidiEvent({ kind: 'noteon', note: 64, velocity: 90, channel: 1 });
  ok(await waitFor(() => lines.some((l) => /\[outlet\] note 64 90 1/.test(l)), 3000),
    'M4L node script outputs incoming MIDI note');
  c.sendRelayMessage({ type: 'LIVE_FIRE_CLIP', track: 1, scene: 2 });
  ok(await waitFor(() => lines.some((l) => l.includes('[outlet] live LIVE_FIRE_CLIP')
    && l.includes(`"maxTracks":${config.m4l.maxTracks}`)), 3000),
    'M4L node script forwards LIVE_* (with configured limits) to LiveAPI js');
  c.disconnect();
}

main()
  .catch((err) => { console.error(err); failures++; })
  .finally(() => {
    cleanup();
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
