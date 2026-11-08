// Max for Live device test (M4L_* protocol), pure Node (no Max, no Live, no binaries):
//
//   node tests/m4l-controller.mjs [--config jamconnect.config.json]
//
// Two device instances (node script + LiveAPI js, mocked max-api / LiveAPI) on different tracks of one
// fake Live set, connected to a fake bridge over real WebSockets. Covers every M4L_* message,
// multi-instance addressing and LIVE_* primary election, macro <-> mapped parameter scaling,
// mapping persistence, macro event throttling, notes / CC into the track and MIDI forwarding.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  FakeLive, createLiveContext, startFakeBridge, loadM4lInstance, writeTempConfig, loadConfig,
  ok, near, sleep, waitFor, failureCount, root
} from './m4l-harness.mjs';

const require = createRequire(import.meta.url);
const config = loadConfig();
const M = config.m4l;
const SET_TEMPO = 98.7; // fake Live set data only

ok(M.macroCount > 0 && M.macros.length >= M.macroCount, 'm4l.macroCount / m4l.macros configured', `${M.macroCount} macros`);
ok(M.macroIntervalMs > 0 && M.statusIntervalMs > 0 && M.peerTimeoutMs > 0 && M.maxMappings > 0 && M.noteMaxDurationMs > 0, 'm4l macro / status / mapping / note limits configured');

const testCfg = JSON.parse(JSON.stringify(config));
Object.assign(testCfg.m4l, { statusIntervalMs: 150, peerTimeoutMs: 1500, macroIntervalMs: 60, reconnectMs: 0, noteMaxDurationMs: 120, noteDurationMs: 40, maxMappings: 4 });
const TM = testCfg.m4l;
const configFile = writeTempConfig(testCfg);
const bridge = await startFakeBridge();
const live = new FakeLive({ tracks: 3, scenes: 2, returns: 1, tempo: SET_TEMPO });
const macroRange = (i) => TM.macros[i];
const A = loadM4lInstance({ url: bridge.url, configFile, instance: 'm4l-aaaa', live, thisDevice: 'live_set tracks 0 devices 0', macroRange });
const B = loadM4lInstance({ url: bridge.url, configFile, instance: 'm4l-bbbb', live, thisDevice: 'live_set tracks 1 devices 1', macroRange });

const fromInst = (type, inst) => bridge.of(type).filter((m) => m.instance === inst);

// ---------------------------------------------------------------- discovery / status
ok(await waitFor(() => fromInst('M4L_HELLO', 'm4l-aaaa').length && fromInst('M4L_HELLO', 'm4l-bbbb').length, 3000), 'both devices announce M4L_HELLO on connect');
await waitFor(() => fromInst('M4L_STATUS', 'm4l-bbbb').some((m) => m.track && m.primary === false) && fromInst('M4L_STATUS', 'm4l-aaaa').some((m) => m.track && m.primary), 3000);
bridge.clear();
bridge.inject({ type: 'M4L_DISCOVER', requestId: 'd1' });
await waitFor(() => bridge.of('M4L_HELLO').length >= 2, 2000);
const hA = fromInst('M4L_HELLO', 'm4l-aaaa')[0] || {};
const hB = fromInst('M4L_HELLO', 'm4l-bbbb')[0] || {};
ok(hA.requestId === 'd1' && hB.requestId === 'd1', 'M4L_DISCOVER -> M4L_HELLO from every device (requestId echoed)');
ok(hA.track && hA.track.index === 0 && hA.track.name === 'Track 1' && hB.track && hB.track.index === 1 && hB.track.name === 'Track 2', 'host track name / index from this_device');
ok(hA.liveVersion === '12.1.5' && hA.deviceName === 'Filter 0' && hB.deviceName === 'Drive 1', 'Live version (live_app) and device name');
ok(hA.connected === true && hA.ready === true && hA.name === TM.name, 'status: connected, ready, configured name');
ok(hA.macros.length === TM.macroCount && hA.macros[0].name === TM.macros[0].name && hA.macros[0].max === TM.macros[0].max, 'status lists macros with names / ranges from config');
ok(hA.limits && hA.limits.maxObservers === TM.maxObservers && hA.limits.macroCount === TM.macroCount, 'status carries config limits');
ok(hA.primary === true && hB.primary === false, 'lowest instance id is primary');
bridge.clear();
bridge.inject({ type: 'M4L_GET_STATUS', target: 'm4l-bbbb', requestId: 's1' });
await waitFor(() => bridge.of('M4L_STATUS').some((m) => m.requestId === 's1'), 2000);
ok(bridge.of('M4L_STATUS').filter((m) => m.requestId === 's1').every((m) => m.instance === 'm4l-bbbb'), 'M4L_GET_STATUS answered only by the target');

// ---------------------------------------------------------------- LIVE_* addressing
bridge.clear();
bridge.inject({ type: 'LIVE_GET_SONG', requestId: 'g1' });
await waitFor(() => bridge.of('LIVE_SONG_INFO').length, 2000);
await sleep(150);
ok(bridge.of('LIVE_SONG_INFO').length === 1 && bridge.of('LIVE_SONG_INFO')[0].instance === 'm4l-aaaa', 'untargeted LIVE_* answered once, by the primary');
bridge.inject({ type: 'LIVE_GET_SONG', target: 'm4l-bbbb', requestId: 'g2' });
await waitFor(() => bridge.of('LIVE_SONG_INFO').some((m) => m.requestId === 'g2'), 2000);
ok(bridge.of('LIVE_SONG_INFO').find((m) => m.requestId === 'g2').instance === 'm4l-bbbb', 'targeted LIVE_* answered by that instance');

// ---------------------------------------------------------------- macros
const m2 = TM.macros[2];
bridge.clear();
bridge.inject({ type: 'M4L_SET_MACRO', target: 'm4l-aaaa', macro: 2, value: (m2.min + m2.max) / 2 });
const mc = await waitFor(() => bridge.of('M4L_MACRO_CHANGED')[0], 2000);
ok(mc && mc.instance === 'm4l-aaaa' && mc.macro === 2 && near(mc.normalized, 0.5) && near(mc.value, (m2.min + m2.max) / 2), 'M4L_SET_MACRO (real value) -> dial -> M4L_MACRO_CHANGED');
ok(B.lc.out.dials.length === 0, 'other instance ignores a targeted M4L_SET_MACRO');
await sleep(TM.macroIntervalMs * 2);
bridge.clear();
bridge.inject({ type: 'M4L_SET_MACRO', target: 'm4l-aaaa', macro: 2, normalized: 0.25 });
const mc2 = await waitFor(() => bridge.of('M4L_MACRO_CHANGED')[0], 2000);
ok(mc2 && near(mc2.value, m2.min + 0.25 * (m2.max - m2.min)), 'M4L_SET_MACRO normalized -> real value in the macro range');
bridge.inject({ type: 'M4L_SET_MACRO', target: 'm4l-aaaa', macro: 2, value: m2.max * 10 + 1000 });
await sleep(TM.macroIntervalMs * 2);
ok(near(bridge.of('M4L_MACRO_CHANGED').pop().value, Math.max(m2.min, m2.max)), 'macro value clamped to the macro range');
bridge.inject({ type: 'M4L_SET_MACRO', target: 'm4l-aaaa', macro: TM.macroCount, value: 1, requestId: 'e1' });
const err = await waitFor(() => bridge.of('M4L_ERROR').find((m) => m.requestId === 'e1'), 2000);
ok(err && /out of range/.test(err.message) && err.instance === 'm4l-aaaa', 'macro index outside m4l.macroCount -> M4L_ERROR');

// throttling of macro changes coming from Live (automation / dial)
await sleep(TM.macroIntervalMs * 2);
bridge.clear();
const t0 = Date.now();
for (let i = 0; i <= 20; i++) { A.lc.ctx.macro(1, TM.macros[1].min + (i / 20) * (TM.macros[1].max - TM.macros[1].min)); await sleep(5); }
const elapsed = Date.now() - t0;
await sleep(TM.macroIntervalMs * 3);
const thr = bridge.of('M4L_MACRO_CHANGED').filter((m) => m.macro === 1);
const allowed = Math.ceil(elapsed / TM.macroIntervalMs) + 2;
ok(thr.length >= 2 && thr.length <= allowed, 'macro changes throttled by m4l.macroIntervalMs', `${thr.length} events for 21 changes in ${elapsed} ms (max ${allowed})`);
ok(thr.length && near(thr[thr.length - 1].normalized, 1), 'throttled macro events end on the newest value');

// ---------------------------------------------------------------- mappings
const P = 'live_set tracks 1 devices 0 parameters ';
const m0 = TM.macros[0];
bridge.clear();
bridge.inject({ type: 'M4L_MAP_MACRO', target: 'm4l-aaaa', macro: 0, track: 1, device: 0, param: 1, min: 0.25, max: 0.75, requestId: 'map1' });
const mp = await waitFor(() => bridge.of('M4L_MAPPINGS').find((m) => m.requestId === 'map1'), 2000);
const map0 = mp && mp.mappings[0];
ok(map0 && map0.paramName === 'Filter Freq' && map0.deviceName === 'Filter 1' && map0.trackName === 'Track 2' && map0.min === 0.25 && map0.max === 0.75, 'M4L_MAP_MACRO -> M4L_MAPPINGS with names and range');
ok(typeof A.lc.out.pattr === 'string' && JSON.parse(decodeURIComponent(A.lc.out.pattr)).length === 1, 'mappings stored in the pattr blob (URI-encoded JSON)');
const setMacro = async (macro, normalized) => {
  bridge.inject({ type: 'M4L_SET_MACRO', target: 'm4l-aaaa', macro, normalized });
  await waitFor(() => A.lc.out.dials.some((d) => d[0] === macro && near(d[1], m0.min + normalized * (m0.max - m0.min))), 2000);
  await sleep(20);
};
await setMacro(0, 1);
ok(near(live.get(P + 1, 'value'), 20 + 0.75 * 19980), 'macro at max -> mapped param at range max (75%)', String(live.get(P + 1, 'value')));
await setMacro(0, 0);
ok(near(live.get(P + 1, 'value'), 20 + 0.25 * 19980), 'macro at min -> mapped param at range min (25%)');
await setMacro(0, 0.5);
ok(near(live.get(P + 1, 'value'), 20 + 0.5 * 19980), 'macro at 50% -> middle of the mapped range');
bridge.inject({ type: 'M4L_MAP_MACRO', target: 'm4l-aaaa', macro: 0, track: 1, device: 0, param: 2, min: 1, max: 0 });
await waitFor(() => bridge.of('M4L_MAPPINGS').some((m) => m.mappings.length === 2), 2000);
await setMacro(0, 0.2);
ok(live.get(P + 2, 'value') === Math.round(0.8 * 3) && near(live.get(P + 1, 'value'), 20 + (0.25 + 0.2 * 0.5) * 19980), 'one macro drives several params; inverted range; quantized param rounds');
bridge.inject({ type: 'M4L_MAP_MACRO', target: 'm4l-aaaa', macro: 0, track: 1, device: 0, param: 1, min: 0, max: 1 });
await waitFor(() => bridge.of('M4L_MAPPINGS').some((m) => m.mappings.some((x) => x.param === 1 && x.max === 1)), 2000);
ok(bridge.of('M4L_MAPPINGS').pop().mappings.length === 2, 're-mapping the same macro/param replaces the old range');
bridge.inject({ type: 'M4L_MAP_MACRO', target: 'm4l-aaaa', macro: 1, track: 'r0', device: 0, param: 3 });
bridge.inject({ type: 'M4L_MAP_MACRO', target: 'm4l-aaaa', macro: 3, track: 'master', device: 0, param: 3 });
bridge.inject({ type: 'M4L_MAP_MACRO', target: 'm4l-aaaa', macro: 4, track: 0, device: 1, param: 3, requestId: 'full' });
const full = await waitFor(() => bridge.of('M4L_ERROR').find((m) => m.requestId === 'full'), 2000);
ok(full && /maxMappings/.test(full.message), 'mapping count capped by m4l.maxMappings');
bridge.inject({ type: 'M4L_MAP_MACRO', target: 'm4l-aaaa', macro: 4, track: 0, device: 9, param: 0, requestId: 'bad' });
ok(await waitFor(() => bridge.of('M4L_ERROR').find((m) => m.requestId === 'bad'), 2000), 'mapping to a missing device -> M4L_ERROR');
bridge.inject({ type: 'M4L_LIST_MAPPINGS', target: 'm4l-aaaa', requestId: 'l1' });
const listed = await waitFor(() => bridge.of('M4L_MAPPINGS').find((m) => m.requestId === 'l1'), 2000);
ok(listed && listed.mappings.length === 4 && listed.maxMappings === 4 && listed.mappings.some((m) => m.track === 'r0') && listed.mappings.some((m) => m.track === 'master'), 'M4L_LIST_MAPPINGS (return / master targets included)');
bridge.inject({ type: 'M4L_LIST_MAPPINGS', target: 'm4l-bbbb', requestId: 'l2' });
const listedB = await waitFor(() => bridge.of('M4L_MAPPINGS').find((m) => m.requestId === 'l2'), 2000);
ok(listedB && listedB.instance === 'm4l-bbbb' && listedB.mappings.length === 0, 'mappings are per device instance');

// persistence: a fresh js context (Live set reloaded) restores from the pattr value
const stored = A.lc.out.pattr;
const R = createLiveContext({ live, thisDevice: 'live_set tracks 0 devices 0' });
R.ctx.restoremappings(stored);
R.send('M4L_LIST_MAPPINGS', {}, TM);
ok(R.lastReply('M4L_MAPPINGS').mappings.length === 4, 'mappings restored from the stored pattr value');
R.ctx.deviceready();
R.ctx.macro(1, TM.macros[1].max);
ok(near(live.get('live_set return_tracks 0 devices 0 parameters 3', 'value'), 1), 'restored mapping drives its parameter after deviceready');

bridge.inject({ type: 'M4L_UNMAP_MACRO', target: 'm4l-aaaa', macro: 0, track: 1, device: 0, param: 2, requestId: 'u1' });
const un1 = await waitFor(() => bridge.of('M4L_MAPPINGS').find((m) => m.requestId === 'u1'), 2000);
ok(un1 && un1.mappings.length === 3 && !un1.mappings.some((m) => m.param === 2), 'M4L_UNMAP_MACRO removes one mapping');
bridge.inject({ type: 'M4L_UNMAP_MACRO', target: 'm4l-aaaa', macro: 0, requestId: 'u2' });
const un2 = await waitFor(() => bridge.of('M4L_MAPPINGS').find((m) => m.requestId === 'u2'), 2000);
ok(un2 && un2.mappings.every((m) => m.macro !== 0) && un2.mappings.length === 2, 'M4L_UNMAP_MACRO without a target clears the macro');
const before = live.get(P + 1, 'value');
await setMacro(0, 0.9);
ok(live.get(P + 1, 'value') === before, 'unmapped macro no longer moves the parameter');

// ---------------------------------------------------------------- notes / CC into the device
bridge.inject({ type: 'M4L_NOTE', target: 'm4l-bbbb', note: 60, velocity: 100, channel: 2, durationMs: 30 });
ok(await waitFor(() => B.notes().some((n) => n.join() === '60,100,2'), 1000), 'M4L_NOTE -> note on at the target device MIDI out');
ok(await waitFor(() => B.notes().some((n) => n.join() === '60,0,2'), 1000), 'note off after durationMs');
ok(!A.notes().some((n) => n[0] === 60), 'non-target device plays nothing');
const tLong = Date.now();
bridge.inject({ type: 'M4L_NOTE', target: 'm4l-bbbb', note: 61, velocity: 90, durationMs: 60000 });
await waitFor(() => B.notes().some((n) => n.join() === '61,0,1'), 2000);
ok(Date.now() - tLong < TM.noteMaxDurationMs + 400, 'note length capped by m4l.noteMaxDurationMs', `${Date.now() - tLong} ms`);
bridge.inject({ type: 'M4L_NOTE', target: 'm4l-bbbb', note: 62, velocity: 80 });
ok(await waitFor(() => B.notes().some((n) => n.join() === '62,0,1'), 1000), 'default length from m4l.noteDurationMs');
bridge.inject({ type: 'M4L_NOTE', target: '*', note: 64, velocity: 70, channel: 1 });
ok(await waitFor(() => A.notes().some((n) => n[0] === 64) && B.notes().some((n) => n[0] === 64), 1000), 'target "*" reaches every device');
bridge.inject({ type: 'M4L_NOTE', target: 'm4l-aaaa', note: 65, velocity: 0, channel: 1 });
ok(await waitFor(() => A.notes().some((n) => n.join() === '65,0,1'), 1000), 'velocity 0 -> note off');
bridge.inject({ type: 'M4L_CC', target: 'm4l-aaaa', cc: 74, value: 200, channel: 5 });
ok(await waitFor(() => A.ccs().some((c) => c.join() === '74,127,5'), 1000), 'M4L_CC -> cc out (value clamped to 127)');

// ---------------------------------------------------------------- MIDI forwarding
bridge.clear();
A.maxApi.handlers.note(48, 99, 1);
A.maxApi.handlers.cc(1, 64, 1);
await waitFor(() => bridge.of('MIDI_EVENT').length >= 2, 1000);
const fw = bridge.of('MIDI_EVENT');
ok(fw.some((m) => m.instance === 'm4l-aaaa' && m.event.kind === 'noteon' && m.event.note === 48) && fw.some((m) => m.event.kind === 'cc' && m.event.value === 64), 'track MIDI -> MIDI_EVENT with instance (m4l.forwardTrackMidi)');
bridge.inject({ type: 'M4L_SET_MIDI_FORWARD', target: 'm4l-aaaa', enabled: false, requestId: 'f1' });
const fs1 = await waitFor(() => bridge.of('M4L_STATUS').find((m) => m.requestId === 'f1'), 1000);
ok(fs1 && fs1.forwardMidi === false, 'M4L_SET_MIDI_FORWARD -> M4L_STATUS forwardMidi false');
bridge.clear();
A.maxApi.handlers.note(50, 99, 1);
await sleep(150);
ok(bridge.of('MIDI_EVENT').length === 0, 'forwarding off: track MIDI stays local');
bridge.inject({ type: 'M4L_SET_MIDI_FORWARD', target: 'm4l-aaaa', enabled: true });
bridge.inject({ type: 'M4L_FLY', target: 'm4l-aaaa', requestId: 'x1' });
ok(await waitFor(() => bridge.of('M4L_ERROR').find((m) => m.requestId === 'x1'), 1000), 'unknown M4L_* request -> M4L_ERROR');

// ---------------------------------------------------------------- bye / failover
bridge.clear();
A.stop();
ok(await waitFor(() => bridge.of('M4L_BYE').some((m) => m.instance === 'm4l-aaaa'), 1000), 'disconnect sends M4L_BYE');
await sleep(100);
bridge.inject({ type: 'LIVE_GET_SONG', requestId: 'g3' });
const g3 = await waitFor(() => bridge.of('LIVE_SONG_INFO').find((m) => m.requestId === 'g3'), 2000);
ok(g3 && g3.instance === 'm4l-bbbb', 'after M4L_BYE the remaining device becomes primary');
ok(await waitFor(() => bridge.of('M4L_STATUS').some((m) => m.instance === 'm4l-bbbb' && m.primary), 2000), 'its status reports primary');

// ---------------------------------------------------------------- permissions + app files
globalThis.window = { location: new URL('http://jamconnect.test/apps/m4l-controller/') };
const { jamRemoteControlPermission: perm } = require(path.join(root, 'JamConnect', 'jamconnect.js'));
ok(perm({ type: 'M4L_DISCOVER' }) === null && perm({ type: 'M4L_GET_STATUS' }) === null && perm({ type: 'M4L_LIST_MAPPINGS' }) === null, 'guest: M4L discovery / status / list need no permission');
ok(['M4L_SET_MACRO', 'M4L_MAP_MACRO', 'M4L_UNMAP_MACRO'].every((t) => perm({ type: t }) === 'syncDeviceParameterChange'), 'guest: macros / mappings need syncDeviceParameterChange');
ok(['M4L_NOTE', 'M4L_CC', 'M4L_SET_MIDI_FORWARD'].every((t) => perm({ type: t }) === 'syncMidi'), 'guest: notes / CC / forwarding need syncMidi');
const mc4 = config.client.m4lController || {};
ok(mc4.quantizeOptions && mc4.quantizeOptions.includes(mc4.quantizeBeats) && mc4.noteDurationMs > 0 && mc4.ccNumbers.length && mc4.discoverIntervalMs > 0, 'client.m4lController configured');
for (const f of ['index.html', 'app.js', 'style.css']) ok(fs.existsSync(path.join(root, 'apps', 'm4l-controller', f)), `apps/m4l-controller/${f} exists`);
ok(fs.readFileSync(path.join(root, 'webapp', 'index.html'), 'utf8').includes('apps/m4l-controller/'), 'main web app links to the M4L controller');

B.stop();
bridge.close();
console.log(failureCount() ? `\n${failureCount()} check(s) failed` : '\nall checks passed');
process.exit(failureCount() ? 1 : 0);
