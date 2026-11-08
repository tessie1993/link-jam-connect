// End-to-end test: linkpeer (stand-in for Ableton) <-Link-> jamlink-bridge <-JamConnect-> jamconnect.js
//
//   node tests/integration.mjs --bin <dir with jamlink-bridge[.exe] and linkpeer[.exe]>
//
// Checks: auth, Link clock sync + phase alignment with a real Link peer, tempo and
// start/stop control in both directions, legacy TRANSPORT_STATE, hub relay of MIDI,
// the Max for Live node script (run outside Max) and static web app serving.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const binDir = path.resolve(args[args.indexOf('--bin') + 1] || 'build');
const exe = (name) => {
  const candidates = [name, `${name}.exe`, path.join('Release', name), path.join('Release', `${name}.exe`)];
  for (const c of candidates) {
    const p = path.join(binDir, c);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${name} not found in ${binDir}`);
};

const PORT = 20900 + Math.floor(Math.random() * 50);
const URL = `ws://127.0.0.1:${PORT}`;
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

// ---------------------------------------------------------------- tone stub for Node
const ToneStub = {
  now: () => performance.now() / 1000,
  context: { lookAhead: 0, currentTime: 0 },
  Transport: {
    bpm: { value: 120 }, swing: 0, state: 'stopped', seconds: 0, ticks: 0, PPQ: 192,
    start() { this.state = 'started'; }, stop() { this.state = 'stopped'; }
  }
};

const { JamConnector } = require(path.join(root, 'JamConnect', 'jamconnect.js'));

async function main() {
  // 1. bridge
  const bridgeLog = [];
  run(exe('jamlink-bridge'), ['--port', String(PORT), '--quiet', '--static', 'webapp', '--static', 'JamConnect'],
    (l) => { bridgeLog.push(l); console.log(`  [bridge] ${l}`); });
  ok(await waitFor(() => bridgeLog.some((l) => l.includes('listening')), 5000), 'bridge starts');

  // 2. Link peer standing in for Ableton Live
  const peer = [];
  run(exe('linkpeer'), ['--seconds', '60', '--bpm', '120', '--tempo-at', '22:97', '--stop-at', '26'], (l) => {
    if (l.startsWith('{')) { try { peer.push(JSON.parse(l)); } catch (_) {} }
  });
  const lastPeer = () => peer[peer.length - 1];

  // 3. static web app
  const index = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.status === 200 && r.text()).catch(() => '');
  ok(index && index.includes('JamConnect Link'), 'bridge serves web app');
  const lib = await fetch(`http://127.0.0.1:${PORT}/jamconnect.js`).then((r) => r.status).catch(() => 0);
  ok(lib === 200, 'bridge serves jamconnect.js');

  // 4. JamConnect client (local mode)
  const a = new JamConnector('ci-a', ToneStub);
  const transportMsgs = [];
  const origRoute = a._routeMessage.bind(a);
  a._routeMessage = (m, s) => { if (m.type === 'TRANSPORT_STATE') transportMsgs.push(m); return origRoute(m, s); };
  await a.joinLocalBridge(URL, '', 'ci-client-a');
  ok(a.isConnectedToHost, 'client A authenticated with bridge');

  const clockReady = await waitFor(() => { const c = a.linkClocks.get('HOST'); return c && c.measurements > 0; }, 5000);
  ok(clockReady, 'Link-style clock measurement completed');

  // 5. Link session with the peer
  ok(await waitFor(() => a.getLinkState().numPeers >= 1 && lastPeer() && lastPeer().peers >= 1, 10000),
    'bridge and linkpeer discovered each other over Link');

  // Phase alignment: same machine => same Link host clock in bridge and linkpeer.
  await sleep(1500);
  const clock = a.linkClocks.get('HOST');
  const samples = peer.slice(-6).map((p) => {
    const localUs = p.clockUs - clock.offsetUs;
    const q = 4;
    const d = (((a.linkTimeline.beatAtTime(localUs) - p.beat) % q) + q * 1.5) % q - q / 2;
    return Math.abs(d);
  });
  const worst = Math.max(...samples);
  const ms = worst * 60000 / a.getLinkState().tempo;
  ok(worst < 0.02, 'JamConnect timeline phase-locked to Link peer', `worst ${ms.toFixed(2)} ms`);

  // 6. tempo control: JamConnect -> Link
  a.setLinkTempo(133.5);
  ok(await waitFor(() => lastPeer() && Math.abs(lastPeer().tempo - 133.5) < 0.01, 3000),
    'LINK_SET_TEMPO reaches Link peer', `peer tempo ${lastPeer() && lastPeer().tempo}`);
  ok(await waitFor(() => transportMsgs.some((m) => m.state === 'bpmchanged' && Math.abs(m.bpm - 133.5) < 0.01), 2000),
    'legacy TRANSPORT_STATE bpmchanged emitted');

  // 7. start/stop: JamConnect -> Link
  a.setLinkPlaying(true);
  ok(await waitFor(() => lastPeer() && lastPeer().playing, 3000), 'LINK_SET_PLAYING starts Link peer transport');
  ok(await waitFor(() => a.getLinkState().isPlaying, 2000), 'client sees isPlaying');
  ok(transportMsgs.some((m) => m.state === 'started'), 'legacy TRANSPORT_STATE started emitted');

  // 8. hub relay between two JamConnect clients
  const b = new JamConnector('ci-b', ToneStub);
  const midiAtB = [];
  b.onMidiMessage = (app, ev) => midiAtB.push(ev);
  await b.joinLocalBridge(URL, '', 'ci-client-b');
  a.sendMidiEvent({ kind: 'noteon', note: 60, velocity: 100, channel: 1 });
  ok(await waitFor(() => midiAtB.some((e) => e.note === 60), 2000), 'MIDI_EVENT relayed between JamConnect clients');

  // 9. Link -> JamConnect (peer changes tempo at t=22 s, stops at t=26 s)
  ok(await waitFor(() => Math.abs(a.getLinkState().tempo - 97) < 0.01, 25000),
    'tempo change in Link peer reaches JamConnect');
  ok(await waitFor(() => !a.getLinkState().isPlaying, 8000), 'stop in Link peer reaches JamConnect');
  ok(transportMsgs.some((m) => m.state === 'stopped'), 'legacy TRANSPORT_STATE stopped emitted');

  a.disconnect();
  b.disconnect();
}

async function m4lTest() {
  // Run the Max for Live node script outside Max (console stub for max-api),
  // pointed at the test bridge port.
  const scriptPath = path.join(root, 'm4l', 'jamconnect-m4l.js');
  const src = fs.readFileSync(scriptPath, 'utf8')
    .replace("url: 'ws://127.0.0.1:20809'", `url: '${URL}'`);
  const tmp = path.join(root, 'tests', '.m4l-under-test.cjs');
  fs.writeFileSync(tmp, src);
  const lines = [];
  run(process.execPath, [tmp], (l) => lines.push(l));
  ok(await waitFor(() => lines.some((l) => l.includes('status') && l.includes('connected LINK')), 5000),
    'M4L node script connects to bridge');
  const c = new JamConnector('ci-c', ToneStub);
  await c.joinLocalBridge(URL, '', 'ci-client-c');
  c.sendMidiEvent({ kind: 'noteon', note: 64, velocity: 90, channel: 1 });
  ok(await waitFor(() => lines.some((l) => /\[outlet\] note 64 90 1/.test(l)), 3000),
    'M4L node script outputs incoming MIDI note');
  c.sendRelayMessage({ type: 'LIVE_FIRE_CLIP', track: 1, scene: 2 });
  ok(await waitFor(() => lines.some((l) => l.includes('[outlet] live LIVE_FIRE_CLIP')), 3000),
    'M4L node script forwards LIVE_* to LiveAPI js');
  c.disconnect();
  fs.unlinkSync(tmp);
}

main()
  .then(m4lTest)
  .catch((err) => { console.error(err); failures++; })
  .finally(() => {
    cleanup();
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
