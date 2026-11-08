/* JamConnect Wavetable Synth: UI shell and JamConnect glue. All audio DSP runs in the Rust/WebAssembly
 * engine (dsp-rs -> engine/synth.wasm) inside an AudioWorklet (worklet/processor.js).
 *
 *  - connection + Link header: apps/common/jcapp.js (same as the other apps)
 *  - PARAMS-PROTOCOL instrument (dsp/protocol.js): announce / SET / CURVE / TOUCH / CHANGED, presets
 *  - notes: on-screen keys, computer keys, Web MIDI, JamConnect MIDI_EVENT (+ optional linkBeat), PAD_PLAY
 *  - every tunable from jamconnect.config.json -> client.synth; musical timing from the Link timeline
 */
import { buildSchema, normalize, denormalize, formatValue, quantizeNorm } from './dsp/params.js';
import { InstrumentParams } from './dsp/protocol.js';
import { WasmSynth, FACTORY_TABLES } from './dsp/engine-wasm.js';
import { LinkClock, NoteScheduler, noteNumber } from './dsp/scheduler.js';
import { validatePreset, presetToNorms, normsToPreset, initNorms } from './dsp/presets.js';
import { parseWav } from './dsp/wav.js';

const $ = (id) => document.getElementById(id);
const app = await JCApp.start({ appKey: 'synth' });
const { connector, config, log, el } = app;
const S = app.appCfg;

function banner(html) {
  const b = $('engine-banner');
  b.innerHTML = html;
  b.classList.toggle('hidden', !html);
}

if (!S || !S.engine || !S.params) {
  banner('<b>client.synth</b> is missing in jamconnect.config.json, so the synth cannot start.');
  throw new Error('client.synth missing');
}

// ------------------------------------------------------------------ instance identity
const store = (k) => `${S.ui.storageKey}.${k}`;
const urlParams = new URLSearchParams(location.search);
const instanceId = urlParams.get('instance') || sessionStorage[store('instance')]
  || (sessionStorage[store('instance')] = generateRandomCode(S.instanceIdLength, config.webrtc.codeAlphabet));
$('instance-id').textContent = instanceId;
$('instance-name').value = sessionStorage[store('name')] || `${$('jc-user-name').value} synth`;

// ------------------------------------------------------------------ user wavetables (IndexedDB)
const tableDb = {
  open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(store('tables'), 1);
      r.onupgradeneeded = () => r.result.createObjectStore('tables', { keyPath: 'name' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('tables', mode);
      const req = fn(tx.objectStore('tables'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  all() { return this.run('readonly', (s) => s.getAll()).catch(() => []); },
  put(rec) { return this.run('readwrite', (s) => s.put(rec)); },
  remove(name) { return this.run('readwrite', (s) => s.delete(name)); }
};
let userTables = (await tableDb.all()) || [];
const tableNames = () => [...FACTORY_TABLES, ...userTables.map((t) => t.name)];

// ------------------------------------------------------------------ schema, engine module, audio
let schema = buildSchema(S, { tables: tableNames() });
let audio = null;      // {ctx, node, analyser}
let displaySynth = null;
let engineError = '';

const toneShim = {
  // jamconnect.js converts PAD_PLAY Link beats to audio time through connector.Tone: this maps it to our context.
  now: () => (audio ? audio.ctx.currentTime : 0),
  context: { get currentTime() { return audio ? audio.ctx.currentTime : 0; }, lookAhead: 0 },
  getContext: () => ({ rawContext: audio ? audio.ctx : null }),
  Transport: { bpm: { value: null }, swing: 0, state: 'stopped', seconds: 0, ticks: 0, PPQ: 192, start() {}, stop() {} }
};
connector.Tone = toneShim;

const clock = new LinkClock({ connector, getContext: () => (audio ? audio.ctx : null) });
const post = (msg) => { if (audio) audio.node.port.postMessage(msg); };
const sched = new NoteScheduler({ clock, post, audioNow: () => (audio ? audio.ctx.currentTime : null) });

const engineUrl = new URL(S.engineUrl, location.href);
const wasm = (async () => {
  try {
    const res = await fetch(engineUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    return { bytes, module };
  } catch (err) {
    engineError = `Synth engine not built: <code>${engineUrl.pathname}</code> could not be loaded (${app.esc(err.message)}). `
      + 'The engine is Rust compiled to WebAssembly by CI (<code>apps/wavetable-synth/dsp-rs</code>): download the '
      + '<b>synth-wasm</b> artifact of the "Build &amp; test" workflow (or use a release zip / the GitHub Pages copy) and put '
      + '<code>synth.wasm</code> into <code>apps/wavetable-synth/engine/</code>.';
    banner(engineError);
    $('engine-status').textContent = 'engine missing';
    $('audio-start').disabled = true;
    return null;
  }
})();

wasm.then((w) => {
  if (!w) return;
  try {
    displaySynth = new WasmSynth({ module: w.module }, 48000, S, schema, S.engine.renderQuantum);
    userTables.forEach((t, i) => displaySynth.loadTable(FACTORY_TABLES.length + i, t.samples, t.frameSize));
    $('engine-status').textContent = 'engine loaded, press START AUDIO';
    drawTables(true);
  } catch (err) {
    banner(`Synth engine failed to start: ${app.esc(err.message)}`);
  }
});

async function startAudio() {
  if (audio || startAudio.busy) return;
  startAudio.busy = true;
  try {
    const w = await wasm;
    if (!w) return;
    const ctx = new AudioContext({ latencyHint: S.audio.latencyHint, ...(S.audio.sampleRate > 0 ? { sampleRate: S.audio.sampleRate } : {}) });
    await ctx.audioWorklet.addModule(new URL(`${S.workletUrl}?modSlots=${S.modSlots}`, location.href));
    const opts = (extra) => ({ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { config: S, schema, ...extra } });
    let node;
    try {
      node = new AudioWorkletNode(ctx, 'jc-wavetable-synth', opts({ wasmModule: w.module }));
    } catch (_) {
      node = new AudioWorkletNode(ctx, 'jc-wavetable-synth', opts({ wasmBytes: w.bytes.slice(0) })); // Module not cloneable here
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = S.ui.analyserFftSize;
    analyser.minDecibels = S.ui.analyserMinDb;
    analyser.maxDecibels = S.ui.analyserMaxDb;
    node.connect(analyser);
    analyser.connect(ctx.destination);
    node.port.onmessage = (e) => onWorklet(e.data);
    audio = { ctx, node, analyser };
    params.syncAll();
    userTables.forEach((t, i) => post({ type: 'table', slot: FACTORY_TABLES.length + i, samples: t.samples, frameSize: t.frameSize }));
    post(clock.linkMessage());
    await ctx.resume();
    $('audio-start').textContent = 'AUDIO ON';
    $('audio-start').classList.add('playing');
  } catch (err) {
    banner(`Audio failed to start: ${app.esc(err.message)}`);
  } finally {
    startAudio.busy = false;
  }
}
$('audio-start').addEventListener('click', () => (audio ? audio.ctx.resume() : startAudio()));
$('panic').addEventListener('click', () => { post({ type: 'panic' }); held.clear(); renderKeys(); });

function onWorklet(m) {
  switch (m.type) {
    case 'ready':
      $('engine-status').textContent = `wasm engine · ${m.sampleRate} Hz · ${m.tables} tables`;
      break;
    case 'error':
      banner(`Synth engine error: ${app.esc(m.message)}`);
      $('engine-status').textContent = 'engine error';
      break;
    case 'meter':
      for (let k = 0; k < m.ids.length; k++) {
        const c = controls.get(m.ids[k]);
        if (c) c.setMod(m.values[k]);
        effective.set(m.ids[k], m.values[k]);
      }
      $('voice-count').textContent = String(m.voices);
      $('meter-l').style.width = `${Math.min(100, m.peakL * 100)}%`;
      $('meter-r').style.width = `${Math.min(100, m.peakR * 100)}%`;
      break;
    case 'tableLoaded':
      if (m.slot < 0) log(`engine rejected wavetable (error ${m.slot})`);
      break;
    default:
  }
}

// ------------------------------------------------------------------ PARAMS-PROTOCOL instrument
const DEVICE_MSGS = new Set(['JAM_PARAM_SET', 'JAM_PARAM_CURVE', 'JAM_PARAM_TOUCH', 'JAM_PARAM_RELEASE', 'JAM_PRESET_LOAD']);
function needs(msg) {
  if (DEVICE_MSGS.has(msg.type)) return 'syncDeviceParameterChange';
  if (msg.type === 'MIDI_EVENT') return 'syncMidi';
  return null;
}
/** Send through the session; WebRTC guests are limited by the host's permissions. */
function sendMsg(msg) {
  if (!app.connected()) return false;
  const need = needs(msg);
  if (need && app.isGuest() && !connector.permissions[need]) { log(`${msg.type}: locked by the host (${need})`); return false; }
  connector.sendRelayMessage(msg);
  return true;
}
/** Host side: a guest's parameter traffic needs syncDeviceParameterChange (the host relays it regardless). */
function canAccept(msg, senderId) {
  if (connector.isHost && senderId && senderId !== 'BRIDGE' && senderId !== 'HOST') return !!connector.permissions.syncDeviceParameterChange;
  return true;
}

const effective = new Map();
const params = new InstrumentParams({
  schema, instanceId, appName: connector.appName, kind: 'instrument', name: $('instance-name').value,
  send: sendMsg,
  nowMs: () => performance.now(),
  audioNow: () => (audio ? audio.ctx.currentTime : null),
  audioTimeAtBeat: (b) => clock.timeAtBeat(b),
  beatNow: () => clock.beatNow(),
  baseParam: (id) => (audio ? audio.node.parameters.get(id) || null : null),
  modParam: (id) => (audio ? audio.node.parameters.get(`${id}.mod`) || null : null),
  setStepped: (id, norm, time) => post({ type: 'stepped', id, norm, time }),
  onValue: (id, norm, origin) => {
    const c = controls.get(id);
    if (c) c.update(norm, origin);
    if (id === 'osc1.table' || id === 'osc2.table') drawTables(true);
  },
  onPreset: (preset, msg) => { loadPreset(preset); log(`preset "${preset.name}" from ${msg.source || msg.appName || 'remote'}`); },
  getPreset: () => currentPreset(),
  canAccept,
  cfg: S.protocol
});
$('instance-name').addEventListener('change', () => {
  sessionStorage[store('name')] = $('instance-name').value;
  params.o.name = $('instance-name').value;
  params.announce();
});

const remotes = new Map(); // instanceId -> announce
function renderRemotes() {
  const sel = $('share-target');
  const cur = sel.value;
  sel.replaceChildren(new Option(remotes.size ? '— pick a synth —' : 'none found yet', ''),
    ...[...remotes.values()].map((r) => new Option(`${r.name || r.appName || 'synth'} (${r.instanceId})`, r.instanceId)));
  if (remotes.has(cur)) sel.value = cur;
}
let pendingGet = null;
app.onRelay((msg, sender) => {
  if (params.handle(msg, sender)) return;
  switch (msg.type) {
    case 'JAM_PARAMS_ANNOUNCE':
      if (msg.instanceId !== instanceId && msg.kind === 'instrument') { remotes.set(msg.instanceId, msg); renderRemotes(); }
      break;
    case 'JAM_PARAMS_BYE':
      if (remotes.delete(msg.instanceId)) renderRemotes();
      break;
    case 'JAM_PRESET_STATE':
      if (pendingGet && msg.instanceId === pendingGet && msg.preset) { pendingGet = null; loadPreset(msg.preset); log(`copied preset "${msg.preset.name}" from ${msg.instanceId}`); }
      break;
    default:
  }
});
const discover = () => sendMsg({ type: 'JAM_PARAMS_DISCOVER' });
app.onConnection((s) => { if (s === 'connected') { params.announce(); discover(); } });
$('share-target').addEventListener('focus', discover);
$('share-send').addEventListener('click', () => {
  const target = $('share-target').value;
  if (!target) { app.showError('Pick a synth first.'); return; }
  if (sendMsg({ type: 'JAM_PRESET_LOAD', target, preset: currentPreset(), source: instanceId })) log(`preset sent to ${target}`);
});
$('share-get').addEventListener('click', () => {
  const target = $('share-target').value;
  if (!target) { app.showError('Pick a synth first.'); return; }
  pendingGet = target;
  sendMsg({ type: 'JAM_PRESET_GET', target, source: instanceId });
});
setInterval(() => params.tick(), S.protocol.tickMs);
setInterval(() => post(clock.linkMessage()), S.protocol.linkPushMs);
connector.onLinkStateUpdated = () => post(clock.linkMessage());
window.addEventListener('pagehide', () => params.bye());

// ------------------------------------------------------------------ controls
const controls = new Map();
let fine = false;
$('fine-toggle').addEventListener('click', () => { fine = !fine; $('fine-toggle').classList.toggle('on', fine); });

const ARC0 = -135, ARC1 = 135;
function arcPath(r, a0, a1) {
  const p = (a) => { const t = ((a - 90) * Math.PI) / 180; return [24 + r * Math.cos(t), 24 + r * Math.sin(t)]; };
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${a1 > a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const ang = (n) => ARC0 + (ARC1 - ARC0) * n;

function makeKnob(p, label) {
  const wrap = el('div', 'knob');
  wrap.tabIndex = 0;
  wrap.title = `${p.group} · ${p.name}${p.modulatable ? ' (modulatable)' : ''}`;
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  const path = (cls, w) => { const e = document.createElementNS(svgNs, 'path'); e.setAttribute('class', cls); e.setAttribute('fill', 'none'); e.setAttribute('stroke-width', w); e.setAttribute('stroke-linecap', 'round'); svg.appendChild(e); return e; };
  const track = path('track', 4);
  const value = path('value', 4);
  const mod = path('mod', 2.5);
  track.setAttribute('d', arcPath(18, ARC0, ARC1));
  const dot = document.createElementNS(svgNs, 'circle');
  dot.setAttribute('r', '2.6');
  dot.setAttribute('class', 'owner');
  svg.appendChild(dot);
  const val = el('div', 'val');
  wrap.append(svg, el('div', 'name', label || p.name), val);
  let norm = params.get(p.id);
  let modN = null;
  const draw = () => {
    const a = ang(norm);
    const zero = p.min < 0 && p.max > 0 && !p.steps ? ang((0 - p.min) / (p.max - p.min)) : ARC0;
    value.setAttribute('d', Math.abs(a - zero) < 0.5 ? '' : arcPath(18, Math.min(zero, a), Math.max(zero, a)));
    const t = ((a - 90) * Math.PI) / 180;
    dot.setAttribute('cx', (24 + 11 * Math.cos(t)).toFixed(2));
    dot.setAttribute('cy', (24 + 11 * Math.sin(t)).toFixed(2));
    if (modN !== null && Math.abs(modN - norm) > 0.002) mod.setAttribute('d', arcPath(22, Math.min(ang(modN), a), Math.max(ang(modN), a)));
    else mod.setAttribute('d', '');
    val.textContent = formatValue(p, denormalize(p, norm));
  };
  const set = (n) => {
    const q = quantizeNorm(p, Math.max(0, Math.min(1, n)));
    if (q === norm) return;
    norm = q;
    draw();
    params.localSet(p.id, q);
  };
  const reset = () => { params.localTouch(p.id); set(normalize(p, p.default)); params.localRelease(p.id); };
  let lastY = 0, acc = 0, dragging = false, lastTap = 0;
  wrap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    wrap.focus();
    const now = performance.now();
    if (e.pointerType !== 'mouse' && now - lastTap < S.ui.doubleTapMs) { reset(); lastTap = 0; return; }
    lastTap = now;
    dragging = true;
    lastY = e.clientY;
    acc = norm;
    wrap.setPointerCapture(e.pointerId);
    params.localTouch(p.id);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const k = (fine || e.shiftKey ? S.ui.fineDragFactor : 1) / S.ui.knobDragPixels;
    acc = Math.max(0, Math.min(1, acc + (lastY - e.clientY) * k));
    lastY = e.clientY;
    set(acc);
  });
  const end = () => { if (dragging) { dragging = false; params.localRelease(p.id); } };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('dblclick', reset);
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = p.steps > 1 ? 1 / (p.steps - 1) : S.ui.wheelStep * (fine || e.shiftKey ? S.ui.fineDragFactor : 1);
    set(norm - Math.sign(e.deltaY) * step);
  }, { passive: false });
  wrap.addEventListener('keydown', (e) => {
    const step = p.steps > 1 ? 1 / (p.steps - 1) : S.ui.wheelStep;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(norm + step); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(norm - step); e.preventDefault(); }
  });
  draw();
  return {
    el: wrap,
    update(n, origin) {
      if (dragging) return;
      norm = n;
      wrap.classList.toggle('remote', origin === 'remote' || origin === 'curve');
      draw();
    },
    setMod(n) { modN = n; if (!dragging) draw(); }
  };
}

function makeSelect(p, label) {
  const wrap = el('label', 'sel');
  wrap.append(el('span', 'lbl', label || p.name));
  const s = el('select', 'inp');
  p.valueItems.forEach((v, i) => s.add(new Option(v, String(i))));
  wrap.appendChild(s);
  const show = (n) => { s.value = String(Math.round(denormalize(p, n))); };
  s.addEventListener('change', () => params.localSet(p.id, normalize(p, Number(s.value))));
  show(params.get(p.id));
  return { el: wrap, update: (n) => show(n), setMod() {}, select: s };
}

const GROUP_ORDER = ['Osc 1', 'Osc 2', 'Sub / Noise', 'Filter', 'Amp', 'Env 1', 'Env 2', 'Env 3', 'LFO 1', 'LFO 2', 'Voice', 'FX', 'Master'];
function buildUi() {
  controls.clear();
  const root = $('sections');
  root.replaceChildren();
  for (const g of GROUP_ORDER) {
    const ps = schema.filter((p) => p.group === g);
    if (!ps.length) continue;
    const panel = el('div', 'panel');
    panel.append(el('div', 'lbl mb-2', g));
    const grid = el('div', 'section-grid');
    for (const p of ps) {
      const c = p.valueItems ? makeSelect(p) : makeKnob(p);
      controls.set(p.id, c);
      grid.appendChild(c.el);
    }
    panel.appendChild(grid);
    root.appendChild(panel);
  }
  const mx = $('matrix');
  mx.replaceChildren();
  for (let m = 1; m <= S.modSlots; m++) {
    const row = el('div', 'matrix-row box');
    const src = schema.find((p) => p.id === `mod${m}.src`);
    const dst = schema.find((p) => p.id === `mod${m}.dst`);
    const amt = schema.find((p) => p.id === `mod${m}.amt`);
    const cs = makeSelect(src, `${m}: source`), cd = makeSelect(dst, 'destination'), ca = makeKnob(amt, 'amount');
    controls.set(src.id, cs); controls.set(dst.id, cd); controls.set(amt.id, ca);
    row.append(cs.el, cd.el, ca.el);
    mx.appendChild(row);
  }
}
buildUi();

/** Table list changed (WAV import): new schema, same values (table choices kept by index). */
function rebuildSchema() {
  const oldSchema = schema;
  schema = buildSchema(S, { tables: tableNames() });
  for (const id of ['osc1.table', 'osc2.table']) {
    const op = oldSchema.find((p) => p.id === id), np = schema.find((p) => p.id === id);
    const idx = Math.round(denormalize(op, params.get(id)));
    params.values.set(id, normalize(np, idx));
  }
  params.setSchema(schema);
  if (displaySynth) displaySynth.setSchema(schema);
  post({ type: 'schema', schema });
  params.syncAll();
  buildUi();
  params.announce();
}

// ------------------------------------------------------------------ presets
const categories = S.presets.categories;
let factory = [];
try {
  const res = await fetch(new URL(S.presets.factoryUrl, location.href), { cache: 'no-cache' });
  const json = await res.json();
  factory = (json.presets || []).filter((p) => {
    const errs = validatePreset(p, schema, categories);
    if (errs.length) log(`factory preset "${p.name}": ${errs.join('; ')}`);
    return !errs.length;
  });
} catch (err) { log(`factory presets: ${err.message}`); }
const loadUser = () => { try { return JSON.parse(localStorage[S.presets.userStorageKey] || '[]'); } catch (_) { return []; } };
const saveUser = (list) => { localStorage[S.presets.userStorageKey] = JSON.stringify(list); };
let current = { name: 'Init', category: categories[0] };

function allPresets() {
  return [...factory.map((p) => ({ ...p, source: 'factory' })), ...loadUser().map((p) => ({ ...p, source: 'user' }))];
}
function renderPresets() {
  const cat = $('preset-cat').value;
  const list = allPresets().filter((p) => !cat || p.category === cat);
  const sel = $('preset-sel');
  sel.replaceChildren(...list.map((p, i) => new Option(`${p.source === 'user' ? '★ ' : ''}${p.name} · ${p.category}`, String(i))));
  sel._list = list;
  const i = list.findIndex((p) => p.name === current.name);
  if (i >= 0) sel.value = String(i);
}
$('preset-cat').replaceChildren(new Option('all', ''), ...categories.map((c) => new Option(c, c)));
$('preset-cat').addEventListener('change', renderPresets);
$('preset-sel').addEventListener('change', () => { const p = $('preset-sel')._list[Number($('preset-sel').value)]; if (p) loadPreset(p); });
const step = (d) => {
  const sel = $('preset-sel');
  const n = sel._list.length;
  if (!n) return;
  sel.value = String((Number(sel.value || 0) + d + n) % n);
  loadPreset(sel._list[Number(sel.value)]);
};
$('preset-prev').addEventListener('click', () => step(-1));
$('preset-next').addEventListener('click', () => step(1));

function snapshot() { return Object.fromEntries(params.values); }
function currentPreset() { return normsToPreset(snapshot(), schema, current); }
function loadPreset(preset) {
  const errs = validatePreset(preset, schema, null);
  if (errs.length) log(`preset "${preset && preset.name}": ${errs.join('; ')} (loaded what fits)`);
  current = { name: preset.name || 'Untitled', category: categories.includes(preset.category) ? preset.category : categories[0] };
  params.setAll(presetToNorms(preset, schema), 'preset', current);
  $('preset-note').textContent = `${current.name} (${current.category})`;
  renderPresets();
}
$('preset-init').addEventListener('click', () => { current = { name: 'Init', category: categories[0] }; params.setAll(initNorms(schema), 'preset', current); renderPresets(); });
$('preset-save').addEventListener('click', () => {
  const name = prompt('Preset name', current.name === 'Init' ? '' : current.name);
  if (!name) return;
  const category = prompt(`Category (${categories.join(', ')})`, current.category);
  if (!categories.includes(category)) { app.showError(`Category must be one of ${categories.join(', ')}`); return; }
  current = { name, category };
  const list = loadUser().filter((p) => p.name !== name);
  list.push(currentPreset());
  saveUser(list);
  renderPresets();
  log(`saved preset "${name}"`);
});
$('preset-delete').addEventListener('click', () => {
  const p = $('preset-sel')._list[Number($('preset-sel').value)];
  if (!p || p.source !== 'user') { app.showError('Only user presets (★) can be deleted.'); return; }
  saveUser(loadUser().filter((u) => u.name !== p.name));
  renderPresets();
});
$('preset-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(currentPreset(), null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${current.name.replace(/[^\w.-]+/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('preset-import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    const incoming = Array.isArray(json.presets) ? json.presets : [json];
    const list = loadUser();
    for (const p of incoming) {
      const errs = validatePreset(p, schema, categories);
      if (errs.length) { log(`import "${p && p.name}": ${errs.join('; ')}`); continue; }
      const i = list.findIndex((u) => u.name === p.name);
      if (i >= 0) list.splice(i, 1);
      list.push(p);
    }
    saveUser(list);
    if (incoming.length === 1) loadPreset(incoming[0]);
    renderPresets();
  } catch (err) { app.showError(`Import: ${err.message}`); }
});

// A/B compare
const ab = { active: 'A', A: null, B: null };
function abSwitch(to) {
  if (to === ab.active) return;
  ab[ab.active] = { norms: snapshot(), meta: { ...current } };
  ab.active = to;
  const slot = ab[to];
  if (slot) { current = { ...slot.meta }; params.setAll(slot.norms, 'preset', current); }
  $('ab-a').classList.toggle('on', to === 'A');
  $('ab-b').classList.toggle('on', to === 'B');
  $('ab-copy').textContent = to === 'A' ? 'A→B' : 'B→A';
}
$('ab-a').addEventListener('click', () => abSwitch('A'));
$('ab-b').addEventListener('click', () => abSwitch('B'));
$('ab-copy').addEventListener('click', () => { ab[ab.active === 'A' ? 'B' : 'A'] = { norms: snapshot(), meta: { ...current } }; log(`copied ${ab.active} to the other slot`); });
renderPresets();

// ------------------------------------------------------------------ wavetable import + view
for (const fs of S.wavetable.importFrameSizes) $('wt-frame-size').add(new Option(String(fs)));
$('wt-frame-size').value = String(S.wavetable.importFrameSize);
$('wt-import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !displaySynth) { if (!displaySynth) app.showError(engineError ? 'Engine not built.' : 'Engine still loading.'); return; }
  try {
    if (tableNames().length >= S.wavetable.maxTables) throw new Error(`table limit reached (client.synth.wavetable.maxTables = ${S.wavetable.maxTables})`);
    const wav = parseWav(await f.arrayBuffer());
    const frameSize = wav.clmFrameSize || Number($('wt-frame-size').value);
    let name = f.name.replace(/\.wav$/i, '');
    while (tableNames().includes(name)) name += '+';
    const slot = tableNames().length;
    const r = displaySynth.loadTable(slot, wav.samples, frameSize);
    if (r !== slot) throw new Error(`engine rejected the file (error ${r}; needs at least one ${frameSize}-sample frame)`);
    const samples = wav.samples.slice(0, Math.min(wav.samples.length, frameSize * S.wavetable.maxFrames));
    userTables.push({ name, frameSize, samples });
    await tableDb.put({ name, frameSize, samples });
    post({ type: 'table', slot, samples, frameSize });
    rebuildSchema();
    log(`wavetable "${name}": ${Math.floor(samples.length / frameSize)} frames of ${frameSize}`);
  } catch (err) { app.showError(`WAV import: ${err.message}`); }
});

const tableCache = new Map();
let tableKey = '';
function drawTables(force) {
  if (!displaySynth) return;
  const key = ['1', '2'].map((o) => `${params.get(`osc${o}.table`)}:${(effective.get(`osc${o}.pos`) ?? params.get(`osc${o}.pos`)).toFixed(3)}:${params.get(`osc${o}.on`)}`).join('|');
  if (!force && key === tableKey) return;
  tableKey = key;
  for (const o of [1, 2]) {
    const cv = $(`wt-view-${o}`);
    const w = (cv.width = cv.clientWidth * devicePixelRatio), h = (cv.height = cv.clientHeight * devicePixelRatio);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    const tp = schema.find((p) => p.id === `osc${o}.table`);
    const slot = Math.round(denormalize(tp, params.get(tp.id)));
    if (!tableCache.has(slot)) tableCache.set(slot, displaySynth.tableLevel0(slot));
    const t = tableCache.get(slot);
    const on = Math.round(denormalize(schema.find((p) => p.id === `osc${o}.on`), params.get(`osc${o}.on`))) === 1;
    g.fillStyle = '#94a3b8';
    g.font = `${10 * devicePixelRatio}px monospace`;
    g.fillText(`OSC ${o} · ${tp.valueItems[slot] || '?'}${on ? '' : ' (off)'}`, 6, 14 * devicePixelRatio);
    if (!t) continue;
    const pos = effective.get(`osc${o}.pos`) ?? params.get(`osc${o}.pos`);
    const shown = Math.min(t.frames, S.ui.wavetableViewFrames);
    const cur = pos * (t.frames - 1);
    const pts = Math.min(t.size, Math.max(32, Math.floor(w / 3)));
    const line = (f, color, width, depth) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      for (let i = 0; i <= pts; i++) {
        const s = t.data[Math.floor(f) * t.size + (Math.floor((i / pts) * t.size) % t.size)];
        const x = w * 0.06 + (i / pts) * w * 0.7 + depth * w * 0.22;
        const y = h * 0.78 - depth * h * 0.5 - s * h * 0.16;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    };
    for (let k = shown - 1; k >= 0; k--) {
      const f = shown > 1 ? (k / (shown - 1)) * (t.frames - 1) : 0;
      line(f, on ? 'rgba(16,185,129,0.35)' : 'rgba(100,116,139,0.3)', devicePixelRatio, t.frames > 1 ? f / (t.frames - 1) : 0);
    }
    line(Math.round(cur), on ? '#f59e0b' : '#94a3b8', 2 * devicePixelRatio, t.frames > 1 ? Math.round(cur) / (t.frames - 1) : 0);
  }
}

// ------------------------------------------------------------------ scope / spectrum
let timeBuf = null, freqBuf = null;
function drawScope() {
  const cv = $('scope');
  const w = (cv.width = cv.clientWidth * devicePixelRatio), h = (cv.height = cv.clientHeight * devicePixelRatio);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!audio) return;
  const an = audio.analyser;
  if (!timeBuf || timeBuf.length !== an.fftSize) { timeBuf = new Float32Array(an.fftSize); freqBuf = new Float32Array(an.frequencyBinCount); }
  an.getFloatTimeDomainData(timeBuf);
  an.getFloatFrequencyData(freqBuf);
  let start = 0; // trigger on a rising zero crossing
  for (let i = 1; i < timeBuf.length / 2; i++) if (timeBuf[i - 1] < 0 && timeBuf[i] >= 0) { start = i; break; }
  const span = Math.floor(timeBuf.length / 2);
  g.strokeStyle = '#10b981';
  g.lineWidth = devicePixelRatio;
  g.beginPath();
  for (let i = 0; i < span; i++) {
    const x = (i / span) * w, y = h * 0.27 - timeBuf[start + i] * h * 0.25;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.stroke();
  g.fillStyle = 'rgba(245,158,11,0.7)';
  const nyq = audio.ctx.sampleRate / 2, fmin = 20;
  const range = an.maxDecibels - an.minDecibels;
  for (let i = 1; i < freqBuf.length; i++) {
    const f = (i * nyq) / freqBuf.length;
    if (f < fmin) continue;
    const x = (Math.log(f / fmin) / Math.log(nyq / fmin)) * w;
    const v = Math.max(0, Math.min(1, (freqBuf[i] - an.minDecibels) / range));
    g.fillRect(x, h - v * h * 0.45, Math.max(1, devicePixelRatio), v * h * 0.45);
  }
}
app.onFrame(() => { drawScope(); drawTables(false); });

// ------------------------------------------------------------------ playing
const M = S.midi;
let octave = 0;
const held = new Map(); // note -> {linkBeat}
const quantSel = $('quantize');
for (const q of M.quantizeOptions) quantSel.add(new Option(q === 0 ? 'off' : String(q), String(q)));
quantSel.add(new Option('bar (quantum)', 'quantum'));
quantSel.value = String(M.quantizeBeats);
$('velocity').value = M.defaultVelocity;
$('vel-val').textContent = M.defaultVelocity;
$('velocity').addEventListener('input', (e) => { $('vel-val').textContent = e.target.value; });
$('midi-source').value = M.inputSource;
$('midi-channel').add(new Option('omni', '0'));
for (let c = 1; c <= 16; c++) $('midi-channel').add(new Option(String(c), String(c)));
$('midi-channel').value = String(M.inputChannel);
$('send-midi').checked = !!M.sendMidi;
$('play-pads').checked = !!M.padsPlaySynth;
$('keymap-hint').textContent = M.computerKeys;

function grid() {
  if (quantSel.value === 'quantum') return connector.getLinkState().quantum;
  return Number(quantSel.value);
}

function sendMidi(kind, note, velocity, linkBeat) {
  if (!$('send-midi').checked) return;
  sendMsg({ type: 'MIDI_EVENT', event: { kind, note, velocity, channel: M.sendChannel }, ...(linkBeat !== null ? { linkBeat } : {}), from: instanceId, source: 'wavetable-synth' });
}

async function noteOnLocal(note, vel) {
  if (!audio) await startAudio();
  if (note < 0 || note > 127 || held.has(note)) return;
  const q = grid();
  let linkBeat = null;
  if (clock.hasTempo()) linkBeat = q > 0 ? clock.nextGridBeat(q) : clock.beatNow();
  sched.noteOn(note, vel, q > 0 ? linkBeat : undefined);
  held.set(note, { linkBeat });
  sendMidi('noteon', note, Math.max(1, Math.round(vel * 127)), linkBeat);
  renderKeys();
}
function noteOffLocal(note) {
  const h = held.get(note);
  if (!h) return;
  held.delete(note);
  sched.noteOff(note, undefined);
  let linkBeat = clock.hasTempo() ? clock.beatNow() : null;
  if (linkBeat !== null && h.linkBeat !== null) linkBeat = Math.max(linkBeat, h.linkBeat);
  sendMidi('noteoff', note, 0, linkBeat);
  renderKeys();
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`;
const remoteHeld = new Set();
function buildKeys() {
  const kb = $('keyboard');
  kb.replaceChildren();
  const base = M.keyboardBaseNote + octave * 12;
  for (let i = 0; i < M.keyboardKeys; i++) {
    const n = base + i;
    const black = [1, 3, 6, 8, 10].includes(n % 12);
    const k = el('div', black ? 'key black' : 'key', black ? '' : noteName(n));
    k.dataset.note = String(n);
    const vel = (e) => {
      if (!M.velocityFromPosition) return Number($('velocity').value) / 127;
      const r = k.getBoundingClientRect();
      return Math.max(1 / 127, Math.min(1, (e.clientY - r.top) / r.height));
    };
    k.addEventListener('pointerdown', (e) => { e.preventDefault(); k.setPointerCapture(e.pointerId); noteOnLocal(n, vel(e)); });
    const up = () => noteOffLocal(n);
    k.addEventListener('pointerup', up);
    k.addEventListener('pointercancel', up);
    kb.appendChild(k);
  }
  $('oct-val').textContent = String(octave);
  renderKeys();
}
function renderKeys() {
  for (const k of $('keyboard').children) {
    const n = Number(k.dataset.note);
    k.classList.toggle('on', held.has(n) || remoteHeld.has(n));
  }
}
const setOctave = (d) => { octave = Math.max(-M.octaveRange, Math.min(M.octaveRange, octave + d)); buildKeys(); };
$('oct-down').addEventListener('click', () => setOctave(-1));
$('oct-up').addEventListener('click', () => setOctave(1));
buildKeys();

const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
document.addEventListener('keydown', (e) => {
  if (typing(e) || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { setOctave(-1); return; }
  if (k === 'x') { setOctave(1); return; }
  const i = M.computerKeys.indexOf(k);
  if (i >= 0) { e.preventDefault(); noteOnLocal(M.computerKeyBaseNote + octave * 12 + i, Number($('velocity').value) / 127); }
});
document.addEventListener('keyup', (e) => {
  const i = M.computerKeys.indexOf(e.key.toLowerCase());
  if (i >= 0) noteOffLocal(M.computerKeyBaseNote + octave * 12 + i);
});

/** CC mapped to a parameter: local hardware acts like the user, remote MIDI like a remote SET. */
function ccToParam(r, linkBeat, remote) {
  if (!r.param) return;
  if (!remote) { params.localSet(r.param, r.norm); return; }
  params.handle({ type: 'JAM_PARAM_SET', target: instanceId, param: r.param, norm: r.norm, source: 'midi-cc', ...(typeof linkBeat === 'number' ? { linkBeat } : {}) }, 'midi');
}

// JamConnect MIDI_EVENT (Ableton via the M4L device, other apps). linkBeat (optional) = when to play it.
connector.onMidiMessage = (_appName, ev, raw = {}) => {
  if (!ev || !audio) return;
  if (raw.from === instanceId || (raw.target && raw.target !== instanceId)) return;
  const src = $('midi-source').value;
  if (src === 'off' || (src === 'ableton' && !raw.instance)) return;
  const ch = Number($('midi-channel').value);
  if (ch && Number(ev.channel || 1) !== ch) return;
  const linkBeat = typeof raw.linkBeat === 'number' ? raw.linkBeat : undefined;
  const r = sched.midiEvent(ev, linkBeat, M.ccMap);
  ccToParam(r, linkBeat, true);
  if (ev.kind === 'noteon' && ev.velocity > 0) remoteHeld.add(Number(ev.note));
  if (ev.kind === 'noteoff' || (ev.kind === 'noteon' && !(ev.velocity > 0))) remoteHeld.delete(Number(ev.note));
  renderKeys();
};

// PAD_PLAY: jamconnect.js already turned its linkBeat into our AudioContext time (connector.Tone shim).
connector.onPadTriggered = (_appName, _instrument, note, velocity, playTime) => {
  if (!audio || !$('play-pads').checked) return;
  const n = noteNumber(note);
  if (n === null || n < 0 || n > 127) return;
  const t = Math.max(audio.ctx.currentTime, Number(playTime) || 0);
  const tempo = clock.tempo();
  const len = tempo ? (M.padNoteBeats * 60) / tempo : M.padNoteMs / 1000;
  post({ type: 'note', on: true, note: n, velocity: Math.max(0, Math.min(1, Number(velocity) || 0)), time: t });
  post({ type: 'note', on: false, note: n, time: t + len });
};

// Web MIDI input (local hardware)
let midiAccess = null;
async function enableWebMidi() {
  if (midiAccess || !navigator.requestMIDIAccess) { if (!navigator.requestMIDIAccess) app.showError('Web MIDI is not available in this browser.'); return; }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    const fill = () => {
      const sel = $('webmidi');
      const cur = sel.value;
      sel.replaceChildren(new Option('all inputs', '*'), new Option('none', ''), ...[...midiAccess.inputs.values()].map((i) => new Option(i.name, i.id)));
      sel.value = cur && [...sel.options].some((o) => o.value === cur) ? cur : '*';
    };
    fill();
    midiAccess.onstatechange = fill;
    for (const input of midiAccess.inputs.values()) input.onmidimessage = (e) => onWebMidi(input, e.data);
    midiAccess.addEventListener('statechange', () => { for (const input of midiAccess.inputs.values()) input.onmidimessage = (e) => onWebMidi(input, e.data); });
  } catch (err) { app.showError(`Web MIDI: ${err.message}`); }
}
$('webmidi').addEventListener('pointerdown', enableWebMidi);
$('webmidi').addEventListener('focus', enableWebMidi);
function onWebMidi(input, d) {
  const sel = $('webmidi').value;
  if (!sel || (sel !== '*' && sel !== input.id)) return;
  const status = d[0] & 0xf0, ch = (d[0] & 0x0f) + 1;
  const want = Number($('midi-channel').value);
  if (want && want !== ch) return;
  if (status === 0x90 && d[2] > 0) noteOnLocal(d[1], d[2] / 127);
  else if (status === 0x80 || status === 0x90) noteOffLocal(d[1]);
  else if (audio) {
    const ev = status === 0xb0 ? { kind: 'cc', cc: d[1], value: d[2] }
      : status === 0xe0 ? { kind: 'pitchbend', value: (((d[2] << 7) | d[1]) - 8192) / 8192 }
        : status === 0xd0 ? { kind: 'aftertouch', value: d[1] } : null;
    if (ev) ccToParam(sched.midiEvent(ev, undefined, M.ccMap), undefined, false);
  }
}

app.onPermissions(() => app.applyPermissionLocks());
app.applyPermissionLocks();
window.jamConnectSynth = { app, params, instanceId, get audio() { return audio; }, get schema() { return schema; } };
