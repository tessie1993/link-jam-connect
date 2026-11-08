// Live API connector test, pure Node (no Max, no Live, no binaries):
//
//   node tests/live-control.mjs [--config jamconnect.config.json]
//
// 1. m4l/jamconnect-live.js under a mocked Max [js] + LiveAPI with a fake Live Object Model:
//    every LIVE_* request / reply / event, parameter normalisation, observer rate limiting
//    and the observer cap from the config.
// 2. m4l/jamconnect-m4l.js message routing through a fake bridge (real WebSockets):
//    LIVE_* forwarding, Link translation of tempo / start / stop, reply types not looped back.
// 3. Host permissions for WebRTC guests (jamconnect.js over the in-memory PeerJS stand-in).
// 4. Config + app files.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  FakeLive, createLiveContext, startFakeBridge, loadM4lInstance, writeTempConfig, loadConfig,
  ok, near, sleep, waitFor, failureCount, root, LIVE_JS
} from './m4l-harness.mjs';

const require = createRequire(import.meta.url);
const config = loadConfig();
const M = config.m4l;
// Tempo is test data only (a fake Live set always has one); apps never assume a default.
const SET_TEMPO = 123.45;

// ---------------------------------------------------------------- 0. ES5 only (Max [js] engine)
{
  const src = fs.readFileSync(LIVE_JS, 'utf8').replace(/\/\/.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const bad = [/=>/, /\blet\s/, /\bconst\s/, /`/, /\bclass\s/, /\.\.\.[a-zA-Z]/].filter((re) => re.test(src));
  ok(bad.length === 0, 'jamconnect-live.js uses ES5 syntax only', bad.map(String).join(' '));
}

// ---------------------------------------------------------------- 1. LiveAPI side
const cfg = { ...M };
{
  const live = new FakeLive({ tracks: M.maxTracks + 4, scenes: M.maxScenes + 2, returns: 2, tempo: SET_TEMPO });
  const L = createLiveContext({ live });

  // LIVE_GET_SET (backward compatible + extended)
  L.send('LIVE_GET_SET', { requestId: 7 }, cfg);
  const info = L.out.infos[0] || {};
  ok(info.tracks && info.tracks.length === M.maxTracks, 'LIVE_GET_SET caps tracks at m4l.maxTracks', `${(info.tracks || []).length}`);
  ok(info.scenes && info.scenes.length === M.maxScenes && info.scenes[0] === 'Scene 1', 'LIVE_GET_SET caps scenes at m4l.maxScenes, names kept');
  ok(info.tempo === SET_TEMPO && info.requestId === 7, 'LIVE_SET_INFO has tempo and echoes requestId');
  const t0 = (info.tracks || [])[0] || {};
  ok(t0.name === 'Track 1' && Array.isArray(t0.clips) && t0.clips[0] === true && t0.clips[1] === false, 'legacy tracks[].name / clips[] booleans kept');
  ok(t0.slots && t0.slots[0].name === 'Clip 0.0' && t0.slots[0].isPlaying === false, 'slots carry clip name / playing state');
  ok(t0.mixer && near(t0.mixer.volume.value, 0.85) && t0.mixer.sends.length === 2, 'tracks carry mixer volume / sends');
  ok(info.returns && info.returns.length === 2 && info.returns[0].ref === 'r0' && info.master && info.master.ref === 'master', 'return tracks and master track included');
  ok(info.master && info.master.mute === undefined, 'master track has no mute/solo');
  ok(info.song && info.song.signature_numerator === 4 && info.sceneInfo.length === M.maxScenes, 'song properties and scene info included');

  // clips / scenes
  L.send('LIVE_FIRE_CLIP', { track: 1, scene: 2 }, cfg);
  L.send('LIVE_STOP_CLIP', { track: 1, scene: 2 }, cfg);
  L.send('LIVE_STOP_TRACK', { track: 2 }, cfg);
  L.send('LIVE_FIRE_SCENE', { scene: 3 }, cfg);
  L.send('LIVE_STOP_ALL', {}, cfg);
  ok(live.calls.some((c) => c.fn === 'fire' && c.path === 'live_set tracks 1 clip_slots 2'), 'LIVE_FIRE_CLIP -> clip_slots fire');
  ok(live.calls.some((c) => c.fn === 'stop' && c.path === 'live_set tracks 1 clip_slots 2'), 'LIVE_STOP_CLIP -> clip_slots stop');
  ok(live.calls.some((c) => c.fn === 'stop_all_clips' && c.path === 'live_set tracks 2'), 'LIVE_STOP_TRACK -> track stop_all_clips');
  ok(live.calls.some((c) => c.fn === 'fire' && c.path === 'live_set scenes 3'), 'LIVE_FIRE_SCENE -> scene fire');
  ok(live.calls.some((c) => c.fn === 'stop_all_clips' && c.path === 'live_set'), 'LIVE_STOP_ALL -> song stop_all_clips');

  // song
  L.send('LIVE_GET_SONG', { requestId: 'a' }, cfg);
  const song = L.lastReply('LIVE_SONG_INFO');
  ok(song && song.song.tempo === SET_TEMPO && song.song.loop_length === 16 && song.requestId === 'a', 'LIVE_GET_SONG -> LIVE_SONG_INFO');
  L.send('LIVE_SET_SONG', { prop: 'metronome', value: true }, cfg);
  L.send('LIVE_SET_SONG', { prop: 'loop_start', value: 8 }, cfg);
  L.send('LIVE_SET_SONG', { prop: 'groove_amount', value: 0.5 }, cfg);
  ok(live.get('live_set', 'metronome') === 1 && live.get('live_set', 'loop_start') === 8 && live.get('live_set', 'groove_amount') === 0.5, 'LIVE_SET_SONG sets metronome / loop_start / groove_amount');
  L.clear();
  L.send('LIVE_SET_SONG', { prop: 'tempo', value: 140 }, cfg);
  const tempoErr = L.lastReply('LIVE_ERROR');
  ok(tempoErr && /LINK_SET_TEMPO/.test(tempoErr.message) && live.get('live_set', 'tempo') === SET_TEMPO, 'LIVE_SET_SONG tempo refused in LiveAPI (Link owns tempo)');
  L.send('LIVE_SET_SONG', { prop: 'can_undo', value: 1 }, cfg);
  ok(L.out.replies.filter((r) => r.type === 'LIVE_ERROR').length === 2, 'read-only song property refused');

  const actions = [
    ['continue', 'continue_playing'], ['tap_tempo', 'tap_tempo'], ['jump_to_next_cue', 'jump_to_next_cue'],
    ['re_enable_automation', 're_enable_automation'], ['capture_and_insert_scene', 'capture_and_insert_scene']
  ];
  for (const [action, fn] of actions) {
    L.send('LIVE_SONG_ACTION', { action }, cfg);
    ok(live.callsOf(fn).length === 1, `LIVE_SONG_ACTION ${action} -> ${fn}`);
  }
  L.send('LIVE_SONG_ACTION', { action: 'undo' }, cfg);
  ok(live.callsOf('undo').length === 0, 'undo skipped while can_undo = 0');
  live.change('live_set', 'can_undo', 1);
  live.change('live_set', 'can_redo', 1);
  L.send('LIVE_SONG_ACTION', { action: 'undo' }, cfg);
  L.send('LIVE_SONG_ACTION', { action: 'redo' }, cfg);
  ok(live.callsOf('undo').length === 1 && live.callsOf('redo').length === 1, 'undo / redo call Live');
  L.send('LIVE_SONG_ACTION', { action: 'capture_midi', destination: 1 }, cfg);
  ok(live.callsOf('capture_midi')[0].args[0] === 1, 'capture_midi passes destination');
  L.send('LIVE_SONG_ACTION', { action: 'jump_by', beats: -4 }, cfg);
  ok(live.callsOf('jump_by')[0].args[0] === -4, 'jump_by passes beats');
  L.send('LIVE_SONG_ACTION', { action: 'stop_all_clips', quantized: false }, cfg);
  ok(live.calls.filter((c) => c.fn === 'stop_all_clips' && c.path === 'live_set').pop().args[0] === 0, 'stop_all_clips quantized:false -> 0');
  live.change('live_set', 'back_to_arranger', 1);
  L.send('LIVE_SONG_ACTION', { action: 'back_to_arranger' }, cfg);
  ok(live.get('live_set', 'back_to_arranger') === 0, 'back_to_arranger sets the property to 0');
  L.clear();
  L.send('LIVE_SONG_ACTION', { action: 'format_disk' }, cfg);
  ok(!!L.lastReply('LIVE_ERROR'), 'unknown song action -> LIVE_ERROR');

  // tracks / mixer
  L.send('LIVE_GET_TRACKS', {}, cfg);
  const tracks = L.lastReply('LIVE_TRACKS_INFO');
  ok(tracks && tracks.tracks.length === M.maxTracks && tracks.returns.length === 2 && tracks.master.name === 'Master', 'LIVE_GET_TRACKS -> tracks, returns, master');
  ok(tracks && tracks.tracks[0].canBeArmed === true && tracks.tracks[0].playingSlot === -1 && tracks.returns[0].arm === undefined, 'track arm / slot indexes only on normal tracks');
  L.send('LIVE_GET_TRACK', { track: 'r1', requestId: 3 }, cfg);
  const tr = L.lastReply('LIVE_TRACK_INFO');
  ok(tr && tr.track.ref === 'r1' && tr.track.name === 'B-Return' && tr.requestId === 3, 'LIVE_GET_TRACK by return ref');
  L.send('LIVE_SET_TRACK', { track: 0, prop: 'mute', value: true }, cfg);
  L.send('LIVE_SET_TRACK', { track: 0, prop: 'solo', value: 1 }, cfg);
  L.send('LIVE_SET_TRACK', { track: 0, prop: 'arm', value: true }, cfg);
  L.send('LIVE_SET_TRACK', { track: 'r0', prop: 'mute', value: true }, cfg);
  L.send('LIVE_SET_TRACK', { track: 1, prop: 'name', value: 'Bass' }, cfg);
  L.send('LIVE_SET_TRACK', { track: 1, prop: 'color', value: 0x00ff00 }, cfg);
  ok(live.get('live_set tracks 0', 'mute') === 1 && live.get('live_set tracks 0', 'solo') === 1 && live.get('live_set tracks 0', 'arm') === 1, 'LIVE_SET_TRACK mute / solo / arm');
  ok(live.get('live_set return_tracks 0', 'mute') === 1 && live.get('live_set tracks 1', 'name') === 'Bass' && live.get('live_set tracks 1', 'color') === 0x00ff00, 'LIVE_SET_TRACK return mute, name, color');
  L.clear();
  L.send('LIVE_SET_TRACK', { track: 'r0', prop: 'arm', value: true }, cfg);
  L.send('LIVE_SET_TRACK', { track: 'master', prop: 'mute', value: true }, cfg);
  ok(L.out.replies.filter((r) => r.type === 'LIVE_ERROR').length === 2, 'arm on a return / mute on master -> LIVE_ERROR');
  L.send('LIVE_SET_MIXER', { track: 2, param: 'volume', value: 0.5 }, cfg);
  L.send('LIVE_SET_MIXER', { track: 2, param: 'panning', real: -0.25 }, cfg);
  L.send('LIVE_SET_MIXER', { track: 2, param: 'panning', real: -7 }, cfg);
  const panAfterClamp = live.get('live_set tracks 2 mixer_device panning', 'value');
  L.send('LIVE_SET_MIXER', { track: 2, param: 'send', send: 1, normalized: 0.3 }, cfg);
  L.send('LIVE_SET_MIXER', { track: 'master', param: 'volume', value: 1 }, cfg);
  ok(near(live.get('live_set tracks 2 mixer_device volume', 'value'), 0.5), 'LIVE_SET_MIXER volume (normalized)');
  ok(panAfterClamp === -1 && live.sets.some((s) => s.path.endsWith('tracks 2 mixer_device panning') && s.value === -0.25), 'LIVE_SET_MIXER panning real value, clamped to min');
  ok(near(live.get('live_set tracks 2 mixer_device sends 1', 'value'), 0.3) && live.get('live_set master_track mixer_device volume', 'value') === 1, 'LIVE_SET_MIXER send / master volume');

  // devices / parameters
  L.send('LIVE_GET_DEVICES', { track: 0 }, cfg);
  const devs = L.lastReply('LIVE_DEVICES');
  ok(devs && devs.devices.length === 2 && devs.devices[0].className === 'AutoFilter' && devs.devices[0].isActive === true && devs.devices[0].numParams === 4, 'LIVE_GET_DEVICES -> name, class_name, is_active, numParams');
  L.send('LIVE_GET_DEVICES', { track: 'master' }, cfg);
  ok(L.lastReply('LIVE_DEVICES').devices[0].name === 'Limiter', 'LIVE_GET_DEVICES on master track');
  L.send('LIVE_GET_DEVICE', { track: 'r0', device: 0 }, cfg);
  const dev = L.lastReply('LIVE_DEVICE_INFO');
  const pType = dev && dev.parameters[2];
  const pFreq = dev && dev.parameters[1];
  ok(dev && dev.name === 'Reverb' && dev.parameters.length === 4 && dev.truncated === false, 'LIVE_GET_DEVICE on a return track lists every parameter');
  ok(pType && pType.isQuantized && pType.valueItems.join(',') === 'LP,HP,BP,Notch' && pType.defaultValue === undefined, 'quantized parameter has value_items');
  ok(pFreq && !pFreq.isQuantized && pFreq.defaultValue === 20000 && pFreq.min === 20 && pFreq.max === 20000 && pFreq.display === '1000.00 Hz', 'continuous parameter has min/max/default/display');
  ok(pFreq && near(pFreq.normalized, (1000 - 20) / 19980), 'parameter normalized = (value - min) / (max - min)');

  L.send('LIVE_GET_PARAM', { track: 0, device: 0, param: 1, requestId: 9 }, cfg);
  const gp = L.lastReply('LIVE_PARAM_INFO');
  ok(gp && gp.track === 0 && gp.device === 0 && gp.param === 1 && gp.value === 1000 && gp.requestId === 9, 'LIVE_GET_PARAM -> LIVE_PARAM_INFO');
  const fp = 'live_set tracks 0 devices 0 parameters ';
  L.send('LIVE_SET_PARAM', { track: 0, device: 0, param: 1, value: 0.25 }, cfg);
  ok(near(live.get(fp + 1, 'value'), 20 + 0.25 * 19980), 'LIVE_SET_PARAM legacy value is normalized 0..1');
  L.send('LIVE_SET_PARAM', { track: 0, device: 0, param: 1, value: 3 }, cfg);
  ok(live.get(fp + 1, 'value') === 20000, 'normalized value clamped to 1');
  L.send('LIVE_SET_PARAM', { track: 0, device: 0, param: 1, real: 440 }, cfg);
  ok(live.get(fp + 1, 'value') === 440, 'LIVE_SET_PARAM real value');
  L.send('LIVE_SET_PARAM', { track: 0, device: 0, param: 1, real: 1e9 }, cfg);
  ok(live.get(fp + 1, 'value') === 20000, 'real value clamped to max');
  L.send('LIVE_SET_PARAM', { track: 0, device: 0, param: 2, value: 0.4 }, cfg);
  ok(live.get(fp + 2, 'value') === 1, 'quantized normalized 0.4 of 0..3 rounds to 1');
  L.send('LIVE_SET_PARAM', { track: 0, device: 0, param: 2, real: 2.6 }, cfg);
  ok(live.get(fp + 2, 'value') === 3, 'quantized real 2.6 rounds to 3');
  L.send('LIVE_SET_PARAM', { track: 'r1', device: 0, param: 3, normalized: 0.5 }, cfg);
  ok(near(live.get('live_set return_tracks 1 devices 0 parameters 3', 'value'), 0.5), 'LIVE_SET_PARAM on a return track device');
  L.send('LIVE_SET_DEVICE_ACTIVE', { track: 0, device: 1, active: false }, cfg);
  ok(live.get('live_set tracks 0 devices 1 parameters 0', 'value') === 0, 'LIVE_SET_DEVICE_ACTIVE false -> Device On = 0');
  L.clear();
  L.send('LIVE_SET_PARAM', { track: 0, device: 9, param: 0, value: 1 }, cfg);
  ok(L.lastReply('LIVE_ERROR') && /no Live object/.test(L.lastReply('LIVE_ERROR').message), 'missing device -> LIVE_ERROR');

  // math helpers
  ok(L.ctx.normalize(5, 0, 10) === 0.5 && L.ctx.normalize(-1, 0, 10) === 0 && L.ctx.normalize(3, 2, 2) === 0, 'normalize clamps and handles min == max');
  ok(L.ctx.denormalize(0.5, -1, 1, false) === 0 && L.ctx.denormalize(0.5, 0, 3, true) === 2 && L.ctx.denormalize(-2, 20, 200, false) === 20, 'denormalize clamps, quantized rounds');
  ok(L.ctx.mappedNormalized(0.5, { min: 0.2, max: 0.6 }) === 0.4 && near(L.ctx.mappedNormalized(0.25, { min: 1, max: 0 }), 0.75), 'macro range mapping (also inverted)');

  // unknown / bad input
  L.clear();
  L.send('LIVE_DO_SOMETHING', {}, cfg);
  ok(L.lastReply('LIVE_ERROR') && /unknown/.test(L.lastReply('LIVE_ERROR').message), 'unknown LIVE_* -> LIVE_ERROR');
  L.ctx.live('LIVE_GET_SONG', '{not json');
  ok(L.out.errors.length === 1, 'bad JSON -> liveerror');
}

// ---------------------------------------------------------------- observers, rate limit, caps
{
  const interval = M.observerIntervalMs;
  ok(interval > 0, 'm4l.observerIntervalMs configured', String(interval));
  const live = new FakeLive({ tracks: 3, scenes: 2, returns: 2, tempo: SET_TEMPO, bigDeviceParams: 40 });
  const L = createLiveContext({ live });
  L.send('LIVE_OBSERVE', { scope: 'song', requestId: 1 }, cfg);
  const obs = L.lastReply('LIVE_OBSERVING');
  ok(obs && obs.groups.join() === 'song' && obs.observers > 0 && obs.observers === live.observerCount() && obs.requestId === 1, 'LIVE_OBSERVE song -> LIVE_OBSERVING', `${obs && obs.observers} observers`);
  ok(L.out.events.length === 0, 'no events for unchanged values when observation starts');
  L.advance(interval * 2);
  live.change('live_set', 'metronome', 1);
  const e1 = L.out.events.find((e) => e.type === 'LIVE_SONG_CHANGED');
  ok(e1 && e1.prop === 'metronome' && e1.value === 1, 'LIVE_SONG_CHANGED pushed immediately after a quiet period');
  live.change('live_set', 'current_song_time', 12);
  ok(!L.out.events.some((e) => e.prop === 'current_song_time'), 'current_song_time is not observed (poll LIVE_GET_SONG)');

  L.send('LIVE_OBSERVE', { scope: 'device', track: 1, device: 0 }, cfg);
  L.send('LIVE_OBSERVE', { scope: 'track', track: 0 }, cfg);
  L.advance(interval * 2);
  L.clear();
  const p1 = 'live_set tracks 1 devices 0 parameters 1';
  for (let i = 1; i <= 10; i++) { live.change(p1, 'value', 100 * i); L.advance(interval / 10 - 0.001); }
  const burst = L.out.events.filter((e) => e.type === 'LIVE_PARAM_CHANGED');
  ok(burst.length === 1 && burst[0].value === 100, 'burst: only the leading event inside one interval', `${burst.length} event(s)`);
  L.advance(interval);
  const after = L.out.events.filter((e) => e.type === 'LIVE_PARAM_CHANGED');
  ok(after.length === 2 && after[1].value === 1000, 'burst: trailing event carries the newest value', `${after.length}`);
  ok(after[1].track === 1 && after[1].device === 0 && after[1].param === 1 && near(after[1].normalized, (1000 - 20) / 19980) && after[1].display === '1000.00 Hz', 'LIVE_PARAM_CHANGED has track/device/param/normalized/display');
  L.clear();
  live.change('live_set tracks 1 devices 0', 'is_active', 0);
  live.change('live_set tracks 0', 'mute', 1);
  live.change('live_set tracks 0 mixer_device volume', 'value', 0.5);
  live.change('live_set tracks 0 mixer_device sends 1', 'value', 0.25);
  live.change('live_set tracks 0', 'playing_slot_index', 1);
  L.advance(interval);
  const de = L.out.events.find((e) => e.type === 'LIVE_DEVICE_CHANGED');
  ok(de && de.prop === 'is_active' && de.value === 0 && de.device === 0, 'LIVE_DEVICE_CHANGED is_active');
  const tc = L.out.events.filter((e) => e.type === 'LIVE_TRACK_CHANGED');
  ok(tc.some((e) => e.prop === 'mute' && e.value === 1) && tc.some((e) => e.prop === 'volume' && e.normalized === 0.5) &&
    tc.some((e) => e.prop === 'send' && e.send === 1 && e.value === 0.25) && tc.some((e) => e.prop === 'playing_slot_index' && e.value === 1),
  'LIVE_TRACK_CHANGED mute / volume / send / playing_slot_index');
  // per-key coalescing: two keys in the same window both arrive
  L.clear();
  live.change('live_set tracks 0', 'solo', 1);
  live.change('live_set tracks 0', 'solo', 0);
  live.change('live_set tracks 0', 'solo', 1);
  live.change('live_set tracks 0', 'mute', 0);
  L.advance(interval);
  const solo = L.out.events.filter((e) => e.prop === 'solo');
  ok(solo.length <= 2 && solo[solo.length - 1].value === 1 && L.out.events.some((e) => e.prop === 'mute'), 'coalescing is per key, newest value wins');

  // cap and eviction
  const small = { ...cfg, maxObservers: 40 };
  const L2 = createLiveContext({ live: new FakeLive({ tracks: 3, scenes: 2, returns: 1, tempo: SET_TEMPO, bigDeviceParams: 60 }) });
  L2.send('LIVE_OBSERVE', { scope: 'song' }, small);
  const songCount = L2.lastReply('LIVE_OBSERVING').observers;
  L2.send('LIVE_OBSERVE', { scope: 'track', track: 1 }, small);
  L2.send('LIVE_OBSERVE', { scope: 'device', track: 1, device: 1 }, small);
  const before = L2.lastReply('LIVE_OBSERVING');
  L2.send('LIVE_OBSERVE', { scope: 'track', track: 2 }, small);
  const ev = L2.lastReply('LIVE_OBSERVING');
  ok(ev.observers <= 40 && ev.evicted[0] === before.groups[1] && ev.evicted.length > 0 && ev.groups.includes('song') && ev.groups.includes('track:2'), 'observer cap evicts the oldest group, keeps song', `evicted ${ev.evicted} (before ${before.groups})`);
  L2.send('LIVE_OBSERVE', { scope: 'device', track: 0, device: 0 }, small);
  const tr = L2.lastReply('LIVE_OBSERVING');
  ok(tr.truncated === true && tr.observers === 40 && tr.maxObservers === 40, 'a group larger than the cap is truncated at m4l.maxObservers', `${tr.observers} observers, song ${songCount}`);
  L2.send('LIVE_UNOBSERVE', { all: true }, small);
  ok(L2.lastReply('LIVE_OBSERVING').observers === 0, 'LIVE_UNOBSERVE all releases every observer');

  // device params limited by maxParams
  const L3 = createLiveContext({ live: new FakeLive({ tracks: 1, scenes: 1, returns: 0, tempo: SET_TEMPO, bigDeviceParams: 60 }) });
  L3.send('LIVE_GET_DEVICE', { track: 0, device: 0 }, { ...cfg, maxParams: 10 });
  const big = L3.lastReply('LIVE_DEVICE_INFO');
  ok(big.parameters.length === 10 && big.truncated === true && big.numParams === 64, 'LIVE_GET_DEVICE caps parameters at m4l.maxParams');

  // set structure change -> LIVE_SET_CHANGED, index-bound groups dropped
  L.clear();
  live.addTrack();
  L.advance(interval);
  ok(L.out.events.some((e) => e.type === 'LIVE_SET_CHANGED' && e.what === 'tracks'), 'track added -> LIVE_SET_CHANGED {what: tracks}');
  L.send('LIVE_UNOBSERVE', { scope: 'nothing' }, cfg);
  const left = L.lastReply('LIVE_OBSERVING');
  ok(left.groups.join() === 'song' && left.observers === live.observerCount(), 'track/device observers dropped after LIVE_SET_CHANGED, song kept');
  L.send('LIVE_UNOBSERVE', { scope: 'song' }, cfg);
  ok(L.lastReply('LIVE_OBSERVING').observers === 0 && live.observerCount() === 0, 'LIVE_UNOBSERVE song');
}

// ---------------------------------------------------------------- 2. node script routing
{
  const testCfg = JSON.parse(JSON.stringify(config));
  Object.assign(testCfg.m4l, { statusIntervalMs: 200, peerTimeoutMs: 2000, observerIntervalMs: 20, reconnectMs: 0 });
  const bridge = await startFakeBridge();
  const configFile = writeTempConfig(testCfg);
  const live = new FakeLive({ tracks: 2, scenes: 2, returns: 1, tempo: SET_TEMPO });
  const dev = loadM4lInstance({ url: bridge.url, configFile, instance: 'm4l-route', live, thisDevice: 'live_set tracks 0 devices 0',
    macroRange: (i) => testCfg.m4l.macros[i] });
  ok(await waitFor(() => bridge.of('M4L_HELLO').length > 0, 3000), 'device connects to the bridge and announces itself');
  bridge.inject({ type: 'LIVE_GET_SET', requestId: 'r1' });
  const si = await waitFor(() => bridge.of('LIVE_SET_INFO')[0], 3000);
  ok(si && si.instance === 'm4l-route' && si.requestId === 'r1' && si.tracks.length === 2, 'LIVE_GET_SET through the node script -> LIVE_SET_INFO');
  bridge.inject({ type: 'LIVE_SET_SONG', prop: 'tempo', value: 133 });
  bridge.inject({ type: 'LIVE_SONG_ACTION', action: 'start' });
  bridge.inject({ type: 'LIVE_SET_SONG', prop: 'is_playing', value: 0 });
  await waitFor(() => bridge.linkControl.length >= 3, 2000);
  ok(bridge.linkControl.some((m) => m.type === 'LINK_SET_TEMPO' && m.bpm === 133), 'LIVE_SET_SONG tempo -> LINK_SET_TEMPO to the bridge');
  ok(bridge.linkControl.some((m) => m.type === 'LINK_SET_PLAYING' && m.playing === true) && bridge.linkControl.some((m) => m.type === 'LINK_SET_PLAYING' && m.playing === false), 'start / is_playing -> LINK_SET_PLAYING');
  ok(live.get('live_set', 'tempo') === SET_TEMPO && !dev.liveCalls().includes('LIVE_SET_SONG'), 'Link-covered requests never reach the LiveAPI');
  bridge.inject({ type: 'LIVE_SONG_ACTION', action: 'continue' });
  ok(await waitFor(() => live.callsOf('continue_playing').length === 1, 2000), 'continue -> LiveAPI continue_playing (Link has no "continue")');
  bridge.inject({ type: 'LIVE_OBSERVE', scope: 'device', track: 1, device: 0 });
  await waitFor(() => bridge.of('LIVE_OBSERVING').length, 2000);
  live.change('live_set tracks 1 devices 0 parameters 3', 'value', 0.75);
  const pc = await waitFor(() => bridge.of('LIVE_PARAM_CHANGED')[0], 2000);
  ok(pc && pc.value === 0.75 && pc.instance === 'm4l-route', 'observer event reaches the bridge as LIVE_PARAM_CHANGED');
  const callsBefore = dev.liveCalls().length;
  for (const t of ['LIVE_PARAM_CHANGED', 'LIVE_SET_INFO', 'LIVE_DEVICE_INFO', 'LIVE_OBSERVING', 'LIVE_ERROR']) bridge.inject({ type: t });
  await sleep(100);
  ok(dev.liveCalls().length === callsBefore, 'replies / events from other devices are not fed into the LiveAPI');
  bridge.inject({ type: 'MIDI_EVENT', event: { kind: 'noteon', note: 40, velocity: 90, channel: 3 } });
  ok(await waitFor(() => dev.notes().some((n) => n[0] === 40 && n[1] === 90 && n[2] === 3), 1000), 'MIDI_EVENT from an app -> device MIDI out');
  dev.stop();
  bridge.close();
}

// ---------------------------------------------------------------- 3. host permissions for guests
{
  const { FakePeer } = await import('./fake-peerjs.mjs');
  globalThis.Peer = FakePeer;
  globalThis.window = { location: new URL('http://jamconnect.test/apps/live-control/') };
  const { JamConnector, jamRemoteControlPermission: perm } = require(path.join(root, 'JamConnect', 'jamconnect.js'));
  ok(perm({ type: 'LIVE_GET_SET' }) === null && perm({ type: 'LIVE_OBSERVE' }) === null && perm({ type: 'M4L_DISCOVER' }) === null, 'read-only requests need no permission');
  ok(perm({ type: 'LIVE_SET_PARAM' }) === 'syncDeviceParameterChange' && perm({ type: 'M4L_SET_MACRO' }) === 'syncDeviceParameterChange', 'parameter writes need syncDeviceParameterChange');
  ok(perm({ type: 'LIVE_SET_SONG', prop: 'tempo' }) === 'syncMasterSettings' && perm({ type: 'LIVE_SONG_ACTION', action: 'continue' }) === 'syncTransport', 'tempo / transport map to the Link permissions');
  ok(perm({ type: 'M4L_NOTE' }) === 'syncMidi' && perm({ type: 'LIVE_FIRE_CLIP' }) === 'syncLiveControl' && perm({ type: 'MIDI_EVENT' }) === null, 'MIDI and Live control permissions');

  const tone = () => ({ now: () => performance.now() / 1000, context: { lookAhead: 0, currentTime: 0 },
    Transport: { bpm: { value: null }, swing: 0, state: 'stopped', seconds: 0, ticks: 0, PPQ: 192, start() {}, stop() {} } });
  JamConnector.configure(config);
  const host = new JamConnector('host', tone(), { followLink: false, adoptTransportTempo: false });
  const info = await host.createHostSession();
  const guest = new JamConnector('guest', tone(), { followLink: false, adoptTransportTempo: false });
  await guest.joinHost(info.inviteUrl, '', 'guest');
  const atHost = [];
  const atGuest = [];
  host.onRelayMessage = (m) => atHost.push(m.type);
  guest.onRelayMessage = (m) => atGuest.push(m);
  guest.sendRelayMessage({ type: 'LIVE_FIRE_CLIP', track: 0, scene: 0 });
  guest.sendRelayMessage({ type: 'LIVE_SET_PARAM', track: 0, device: 0, param: 1, value: 0.5, requestId: 'p1' });
  guest.sendRelayMessage({ type: 'LIVE_GET_SET' });
  await waitFor(() => atHost.length >= 2 && atGuest.length >= 1, 2000);
  await sleep(150);
  ok(atHost.includes('LIVE_FIRE_CLIP') && atHost.includes('LIVE_GET_SET'), 'host relays guest clip launch and reads (syncLiveControl on by default)');
  ok(!atHost.includes('LIVE_SET_PARAM'), 'host drops guest LIVE_SET_PARAM without syncDeviceParameterChange');
  const denied = atGuest.find((m) => m.type === 'LIVE_ERROR');
  ok(denied && denied.requestId === 'p1' && /syncDeviceParameterChange/.test(denied.message), 'guest gets LIVE_ERROR naming the missing permission');
  host.sendPermissionsUpdate({ syncDeviceParameterChange: true, syncLiveControl: false });
  await waitFor(() => guest.permissions.syncLiveControl === false, 1000);
  atHost.length = 0;
  guest.sendRelayMessage({ type: 'LIVE_SET_PARAM', track: 0, device: 0, param: 1, value: 0.5 });
  guest.sendRelayMessage({ type: 'LIVE_FIRE_SCENE', scene: 0 });
  await sleep(250);
  ok(atHost.includes('LIVE_SET_PARAM') && !atHost.includes('LIVE_FIRE_SCENE'), 'permission changes apply (params allowed, Live control locked)');
  guest.disconnect();
  host.disconnect();
}

// ---------------------------------------------------------------- 4. config + app files
{
  const lc = config.client.liveControl || {};
  ok(lc.paramSendIntervalMs > 0 && lc.mixerSendIntervalMs > 0 && lc.appName, 'client.liveControl configured');
  ok(config.client.bridgeRetryMs > 0, 'client.bridgeRetryMs configured');
  for (const k of ['maxDevices', 'maxParams', 'maxSends', 'maxReturns', 'maxObservers', 'observerIntervalMs']) ok(M[k] > 0, `m4l.${k} configured`, String(M[k]));
  const mount = config.bridge.static.find((s) => /^\/apps=/.test(s));
  ok(!!mount, 'bridge.static mounts apps/ under /apps', mount);
  for (const f of ['index.html', 'app.js', 'style.css']) ok(fs.existsSync(path.join(root, 'apps', 'live-control', f)), `apps/live-control/${f} exists`);
  const html = fs.readFileSync(path.join(root, 'apps', 'live-control', 'index.html'), 'utf8');
  ok(html.includes('../../jamconnect.js') && html.includes('../common/jcapp.js'), 'live-control loads the library and shared code by relative path');
  ok(fs.readFileSync(path.join(root, 'webapp', 'index.html'), 'utf8').includes('apps/live-control/'), 'main web app links to Live Control');
  const appJs = fs.readFileSync(path.join(root, 'apps', 'live-control', 'app.js'), 'utf8');
  ok(!/\b1[0-9]{2}(\.\d+)?\s*(bpm|BPM)/.test(appJs) && !/tempo\s*[:=]\s*\d/.test(appJs), 'no default tempo in the app');
}

console.log(failureCount() ? `\n${failureCount()} check(s) failed` : '\nall checks passed');
process.exit(failureCount() ? 1 : 0);
