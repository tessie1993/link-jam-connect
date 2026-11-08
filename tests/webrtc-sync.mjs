// WebRTC session + Link clock sync test without native binaries.
//
//   node tests/webrtc-sync.mjs [--config jamconnect.config.json] [--runs N]
//
// A JamConnect host (timeline authority) and a guest talk over an in-memory PeerJS
// stand-in with heavy symmetric jitter on an ordered channel. Checks session setup,
// guest control, and that the guest stays phase-locked to the host. Also reports pure
// Link filtering (bestRttFraction = 1) next to the configured filter.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const config = JSON.parse(fs.readFileSync(path.resolve(argValue('--config', path.join(root, 'jamconnect.config.json'))), 'utf8'));
const runs = Number(argValue('--runs', 5));

const { FakePeer } = await import('./fake-peerjs.mjs');
globalThis.Peer = FakePeer;
globalThis.window = { location: new URL('http://jamconnect.test/') };
const { JamConnector, jamMergeConfig } = require(path.join(root, 'JamConnect', 'jamconnect.js'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(stepMs); }
  return fn();
}
// Tone stand-in with Tone's clock relations: now() = context.currentTime + lookAhead.
const TONE_LOOKAHEAD_SEC = 0.1; // Tone.js default context lookAhead
const tone = () => ({
  context: { lookAhead: TONE_LOOKAHEAD_SEC, get currentTime() { return performance.now() / 1000; } },
  now() { return this.context.currentTime + this.context.lookAhead; },
  Transport: { bpm: { value: null }, swing: 0, state: 'stopped', seconds: 0, ticks: 0, PPQ: 192,
    start() { this.state = 'started'; }, stop() { this.state = 'stopped'; } }
});

const tempoHi = Math.min(config.client.tempoMax, 200);
const tempoLo = Math.max(config.client.tempoMin, 60);
// Allowed phase error: 1/50 beat at the fastest tempo we test.
const limitMs = (0.02 * 60000) / tempoHi;

async function measure(bestRttFraction) {
  JamConnector.configure(jamMergeConfig(config, { client: { linkClock: { bestRttFraction } } }));
  const errors = [];
  for (let i = 0; i < runs; i++) {
    const host = new JamConnector('host', tone(), { followLink: false });
    const info = await host.createHostSession();
    const guest = new JamConnector('guest', tone(), { followLink: false });
    await guest.joinHost(info.inviteUrl, '', 'guest');
    host.setLinkTempo(tempoHi);
    await waitFor(() => (guest.linkClocks.get('HOST') || {}).measurements > 0, 10000);
    await sleep(300);
    let worst = 0;
    for (let k = 0; k < 10; k++) {
      const t = performance.now();
      const d = Math.abs(host.linkBeatAtTime(t) - guest.linkBeatAtTime(t));
      worst = Math.max(worst, (d * 60000) / tempoHi);
      await sleep(20);
    }
    errors.push(worst);
    guest.disconnect();
    host.disconnect();
  }
  return errors;
}

// ---- session + control
JamConnector.configure(config);
const host = new JamConnector('host', tone(), { followLink: false });
const info = await host.createHostSession();
ok(info.sessionId.startsWith(config.webrtc.sessionPrefix), 'session id uses configured prefix', info.sessionId);
ok(info.authToken.length === config.webrtc.tokenLength, 'token uses configured length');
const guest = new JamConnector('guest', tone(), { followLink: false });
await guest.joinHost(info.inviteUrl, '', 'guest');
ok(guest.isConnectedToHost, 'guest joins via invite URL');
const t1 = Math.round((tempoLo + Math.random() * (tempoHi - tempoLo)) * 100) / 100;
host.setLinkTempo(t1);
ok(await waitFor(() => guest.getLinkState().tempo === t1, 2000), 'host tempo reaches guest', String(t1));
guest.setLinkPlaying(true);
ok(await waitFor(() => host.getLinkState().isPlaying && guest.getLinkState().isPlaying, 2000), 'guest starts host transport');
const t2 = Math.round((tempoLo + Math.random() * (tempoHi - tempoLo)) * 100) / 100;
guest.setLinkTempo(t2);
ok(await waitFor(() => host.getLinkState().tempo === t2, 2000), 'guest tempo reaches host', String(t2));
host.sendPermissionsUpdate({ syncTransport: false });
await sleep(150);
guest.setLinkPlaying(false);
await sleep(400);
ok(host.getLinkState().isPlaying, 'host ignores guest stop without syncTransport permission');

// ---- Link-timed pads: a snapped pad sounds at the same Link moment on every peer
await waitFor(() => (guest.linkClocks.get('HOST') || {}).measurements > 0, 10000);
host.sendPermissionsUpdate({ syncTransport: true });
await sleep(150);
if (!host.getLinkState().isPlaying) host.setLinkPlaying(true);
await sleep(300);
let padWorst = 0, padsSeen = 0;
for (let i = 0; i < 12; i++) {
  let hostAt = null, guestAt = null;
  host.onPadTriggered = (app, inst, note, vel, t) => { hostAt = t; };
  guest.onPadTriggered = (inst, note, vel, t) => { guestAt = t; };
  guest.triggerPad('guest', 'drum', 'C2', 0.9, 1);
  await waitFor(() => hostAt !== null, 2000);
  if (hostAt !== null && guestAt !== null) { padsSeen++; padWorst = Math.max(padWorst, Math.abs(hostAt - guestAt) * 1000); }
  await sleep(150 + Math.random() * 150);
}
ok(padsSeen === 12, 'PAD_PLAY carries linkBeat and reaches host');
ok(padWorst < limitMs, 'snapped pads sound at the same Link moment on guest and host', `worst ${padWorst.toFixed(2)} ms`);
guest.disconnect();
host.disconnect();

// ---- clock sync accuracy
const configured = config.client.linkClock.bestRttFraction;
const pure = await measure(1);
const filtered = configured < 1 ? await measure(configured) : pure;
const fmt = (e) => e.map((x) => x.toFixed(2)).join(', ');
console.log(`pure Link median (bestRttFraction 1): worst ${Math.max(...pure).toFixed(2)} ms  [${fmt(pure)}]`);
if (configured < 1) console.log(`configured (bestRttFraction ${configured}): worst ${Math.max(...filtered).toFixed(2)} ms  [${fmt(filtered)}]`);
ok(Math.max(...filtered) < limitMs, `guest phase-locked within 1/50 beat at ${tempoHi} BPM`, `limit ${limitMs.toFixed(2)} ms`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
