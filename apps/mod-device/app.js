/* JamConnect Mod Device UI: touch surfaces, sensors (incl. the iOS permission flow), Web MIDI, mic,
 * scopes, the route / target / scene editors and the connection panel. The modulation math runs in the
 * Rust/WebAssembly core (engine/mod-core.wasm, built by CI) through engine.js.
 *
 * The core runs on the main thread, ticked every client.modulator.tickIntervalMs: touch and sensor
 * events and the JamConnect connection live there too, so a worker would only add postMessage hops
 * (latency) and a second copy of the state, while one tick costs microseconds. */
(async () => {
  const $ = (id) => document.getElementById(id);
  const app = await JCApp.start({ appKey: 'modulator' });
  const { connector, config, log, el } = app;
  const cfg = app.appCfg;
  const S = window.JamModSchema;
  const { ModDevice, loadCore, connectorClock } = window.JamModDevice;
  const UI = cfg.ui || {};

  // ---------------------------------------------------------------- tabs
  function showTab(name) {
    document.querySelectorAll('[data-main]').forEach((t) => t.classList.toggle('active', t.dataset.main === name));
    document.querySelectorAll('.main-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
    sizeSurfaces();
  }
  document.querySelectorAll('[data-main]').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.main)));

  // ---------------------------------------------------------------- core
  if (!window.isSecureContext) {
    $('secure-note').textContent = 'Not a secure context: motion sensors and the mic need https or localhost. Open the Pages version (https) and connect with WebRTC, or use the bridge on this machine (http://localhost counts as secure).';
    $('secure-note').classList.remove('hidden');
  }
  let core;
  try {
    core = await loadCore(new URL('engine/mod-core.wasm', location.href).href);
  } catch (err) {
    $('core-error').innerHTML = '<b>Modulation core not built.</b> The math runs in Rust compiled to WebAssembly (<code>apps/mod-device/engine/mod-core.wasm</code>), which is built only by CI. '
      + 'Download the <b>mod-core-wasm</b> artifact of the "Build &amp; test" workflow into <code>apps/mod-device/engine/</code>, use a release package, or open the GitHub Pages deployment. '
      + `<span class="text-rose-300/70">(${app.esc(err.message || err)})</span>`;
    $('core-error').classList.remove('hidden');
    log(`core not built: ${err.message || err}`);
    showTab('connection');
    return;
  }
  const io = {
    send: (m) => connector.sendRelayMessage(m),
    connected: () => app.connected(),
    isGuest: () => app.isGuest(),
    permissions: () => connector.permissions,
    basePermission: typeof jamRemoteControlPermission === 'function' ? jamRemoteControlPermission : null
  };
  let dev;
  try {
    dev = new ModDevice({ cfg, core, clock: connectorClock(connector), io, appName: cfg.appName, alphabet: config.webrtc.codeAlphabet });
  } catch (err) {
    $('core-error').textContent = `Modulation core rejected: ${err.message}`;
    $('core-error').classList.remove('hidden');
    return;
  }
  log(`modulation core v${core.core_version()} loaded, instance ${dev.instanceId}`);

  // ---------------------------------------------------------------- persistence
  const store = (() => { try { return JSON.parse(localStorage[cfg.storageKey] || '{}'); } catch (_) { return {}; } })();
  store.scenes = store.scenes || {};
  const persist = JCApp.throttle(UI.saveDebounceMs);
  function save() { persist('save', () => { store.current = dev.toScene(); localStorage[cfg.storageKey] = JSON.stringify(store); }); }
  const factory = S.factoryScenes();
  try {
    if (store.current) dev.loadScene(store.current);
    else dev.loadScene((factory.find((f) => f.name === UI.startScene) || factory[0]).scene);
  } catch (err) { log(`scene: ${err.message}`); }

  // ---------------------------------------------------------------- engine loop + IO
  setInterval(() => dev.tick(performance.now()), cfg.tickIntervalMs);
  app.onRelay((msg) => { dev.handleMessage(msg); onRelayUi(msg); });
  connector.onMidiMessage = (_app, ev) => dev.midi(ev);
  app.onConnection((s) => {
    if (s !== 'connected' && s !== 'hosting') return;
    dev.discover();
    dev.announce();
    app.send({ type: 'M4L_DISCOVER' });
    app.send({ type: 'LIVE_GET_TRACKS' });
  });
  if (cfg.discoverIntervalMs > 0) setInterval(() => { if (app.connected()) dev.discover(); }, cfg.discoverIntervalMs);
  window.addEventListener('pagehide', () => { dev.panic(); dev.bye(); });
  dev.on('structure', () => { renderAll(); save(); });
  dev.on('param', () => save());
  dev.on('instruments', () => { renderInstruments(); renderRoutes(); });
  dev.on('m4l', () => renderM4l());
  dev.on('learn', (l) => {
    $('learn-chip').classList.toggle('hidden', !l);
    $('learn').classList.toggle('learning', !!l);
    if (l) observeForLearn(); else unobserveLearn();
  });
  dev.on('learned', ({ target }) => log(`learned ${dev.targetLabel(target)}`));
  dev.on('frozen', (f) => $('panic').classList.toggle('on', f));
  dev.on('hold', (h) => $('hold').classList.toggle('on', h));

  // ---------------------------------------------------------------- toolbar
  $('panic').addEventListener('click', () => dev.setFrozen(!dev.frozen));
  $('hold').addEventListener('click', () => dev.setHold(!dev.hold));

  // motion sensors (iOS needs a permission request from a user gesture)
  let motionOn = false;
  const motionSources = () => [...dev.sources.values()].filter((s) => s.type === 'motion');
  function onOrientation(e) { for (const s of motionSources()) dev.motionOrientation(s.id, e.alpha, e.beta, e.gamma, e.timeStamp || performance.now()); }
  function onMotion(e) {
    const t = e.timeStamp || performance.now();
    for (const s of motionSources()) { dev.motionAccel(s.id, e.acceleration, e.accelerationIncludingGravity, t); dev.motionRotation(s.id, e.rotationRate, t); }
  }
  $('motion-enable').addEventListener('click', async () => {
    if (motionOn) return;
    if (!window.isSecureContext) { app.showError('Motion sensors need a secure context (https or localhost).'); return; }
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        if (await DeviceMotionEvent.requestPermission() !== 'granted') throw new Error('motion permission denied');
      }
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') throw new Error('orientation permission denied');
      }
      window.addEventListener('deviceorientation', onOrientation);
      window.addEventListener('devicemotion', onMotion);
      motionOn = true;
      $('motion-enable').classList.add('on');
      if (!motionSources().length) dev.addSource({ type: 'motion' });
      log('motion sensors on (no events on desktop: use the tilt simulator)');
    } catch (err) { app.showError(`Motion: ${err.message || err}`); }
  });

  // microphone envelope follower: AnalyserNode blocks handed to the core
  let mic = null;
  $('mic-enable').addEventListener('click', async () => {
    if (mic) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser();
      an.fftSize = cfg.mic.fftSize;
      ctx.createMediaStreamSource(stream).connect(an);
      mic = { ctx, an, buf: new Float32Array(an.fftSize) };
      $('mic-enable').classList.add('on');
      if (![...dev.sources.values()].some((s) => s.type === 'mic')) dev.addSource({ type: 'mic' });
      log('mic on');
    } catch (err) { app.showError(`Mic: ${err.message || err}`); }
  });

  // Web MIDI input
  $('midi-enable').addEventListener('click', async () => {
    if (!navigator.requestMIDIAccess) { app.showError('Web MIDI is not available in this browser.'); return; }
    try {
      const access = await navigator.requestMIDIAccess();
      const bind = () => access.inputs.forEach((inp) => { inp.onmidimessage = (e) => onWebMidi(e.data); });
      bind();
      access.onstatechange = bind;
      $('midi-enable').classList.add('on');
      log(`Web MIDI: ${access.inputs.size} input(s)`);
    } catch (err) { app.showError(`MIDI: ${err.message || err}`); }
  });
  function onWebMidi(d) {
    const st = d[0] & 0xf0, ch = (d[0] & 0x0f) + 1;
    if (st === 0x90) dev.midi({ kind: d[2] > 0 ? 'noteon' : 'noteoff', note: d[1], velocity: d[2], channel: ch });
    else if (st === 0x80) dev.midi({ kind: 'noteoff', note: d[1], velocity: 0, channel: ch });
    else if (st === 0xb0) dev.midi({ kind: 'cc', cc: d[1], value: d[2], channel: ch });
  }

  // ---------------------------------------------------------------- helpers: param controls
  function numControl(def, value, onChange) {
    const wrap = el('label');
    const head = el('span', 'lbl', def.name + (def.unit ? ` (${def.unit})` : ''));
    const val = el('span', 'val');
    head.appendChild(val);
    wrap.appendChild(head);
    if (def.choice) {
      const sel = el('select', 'inp');
      for (const it of def.valueItems) sel.add(new Option(it, it));
      sel.value = value;
      sel.addEventListener('change', () => onChange(sel.value));
      wrap.appendChild(sel);
      return wrap;
    }
    const inp = el('input', 'w-full');
    inp.type = 'range';
    inp.min = 0; inp.max = 1;
    inp.step = def.steps > 1 ? 1 / (def.steps - 1) : 0.001;
    inp.value = S.realToNorm(def, value);
    const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(def.steps > 1 ? 0 : 3));
    val.textContent = fmt(Number(value));
    inp.addEventListener('input', () => { const v = S.normToReal(def, Number(inp.value)); val.textContent = fmt(v); onChange(v); });
    wrap.appendChild(inp);
    return wrap;
  }
  function refSelect(current, exclude, onChange, allowEmpty = true) {
    const sel = el('select', 'inp');
    if (allowEmpty) sel.add(new Option('— none —', ''));
    for (const o of dev.allOutputs()) if (!exclude || o.source.id !== exclude) sel.add(new Option(o.label, o.ref));
    sel.value = current || '';
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  // ---------------------------------------------------------------- scopes
  const scopeLen = Math.max(2, Math.round(cfg.scopes.historyMs * cfg.scopes.fps / 1000));
  const history = new Map(); // ref / route:id -> Float32Array ring
  let histPos = 0;
  function sampleScopes() {
    histPos = (histPos + 1) % scopeLen;
    for (const o of dev.allOutputs()) {
      let h = history.get(o.ref);
      if (!h) { h = new Float32Array(scopeLen); history.set(o.ref, h); }
      h[histPos] = o.bipolar ? (dev.value(o.ref) + 1) / 2 : dev.value(o.ref);
    }
    for (const r of dev.routes.values()) {
      const k = `route:${r.id}`;
      let h = history.get(k);
      if (!h) { h = new Float32Array(scopeLen); history.set(k, h); }
      const v = dev.routeValue(r.id);
      h[histPos] = r.mode === 'offset' ? (v + 1) / 2 : v;
    }
  }
  const COLORS = ['#34d399', '#fbbf24', '#f472b6', '#60a5fa', '#a78bfa', '#f87171', '#22d3ee', '#facc15', '#4ade80', '#fb923c', '#e879f9', '#94a3b8'];
  function drawScope(cv, keys) {
    const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#1e293b';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    keys.forEach((k, ki) => {
      const hist = history.get(k);
      if (!hist) return;
      g.strokeStyle = COLORS[ki % COLORS.length];
      g.lineWidth = devicePixelRatio;
      g.beginPath();
      for (let i = 0; i < scopeLen; i++) {
        const v = hist[(histPos + 1 + i) % scopeLen];
        const x = i / (scopeLen - 1) * w, y = (1 - v) * (h - 2) + 1;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    });
  }

  // ---------------------------------------------------------------- PLAY: surfaces
  const surfaceEls = new Map(); // source id -> {wrap, cv, pointers, trail}
  function renderSurfaces() {
    const root = $('surfaces');
    root.replaceChildren();
    surfaceEls.clear();
    for (const s of dev.sources.values()) {
      if (s.type !== 'pad') continue;
      const ribbon = s.params.layout !== 'xy';
      const wrap = el('div', `surface${ribbon ? ' ribbon' : ''}`);
      wrap.style.height = ribbon ? (s.params.layout === 'ribbon-v' ? `${UI.padHeightVh}vh` : `${UI.ribbonHeightPx}px`) : `${UI.padHeightVh}vh`;
      if (s.params.layout === 'ribbon-v') wrap.style.width = `${UI.ribbonHeightPx}px`;
      const cv = el('canvas');
      wrap.append(cv, el('div', 'tag', `${s.name} · ${s.params.physics}`));
      const st = { wrap, cv, pointers: new Map(), trail: [] };
      const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]; };
      const press = (e) => (e.pointerType === 'pen' || (e.pressure > 0 && e.pressure !== 0.5) ? e.pressure : null);
      const radius = (e) => ((e.width || 0) + (e.height || 0)) / 4;
      cv.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        cv.setPointerCapture(e.pointerId);
        const [x, y] = pos(e);
        st.pointers.set(e.pointerId, [x, y]);
        dev.pointer(s.id, 0, e.pointerId, x, y, press(e), radius(e), e.timeStamp);
      });
      cv.addEventListener('pointermove', (e) => {
        if (!st.pointers.has(e.pointerId)) return;
        const [x, y] = pos(e);
        st.pointers.set(e.pointerId, [x, y]);
        dev.pointer(s.id, 1, e.pointerId, x, y, press(e), radius(e), e.timeStamp);
      });
      const up = (e) => {
        if (!st.pointers.has(e.pointerId)) return;
        const [x, y] = pos(e);
        st.pointers.delete(e.pointerId);
        dev.pointer(s.id, 2, e.pointerId, x, y, press(e), radius(e), e.timeStamp);
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('contextmenu', (e) => e.preventDefault());
      root.appendChild(wrap);
      surfaceEls.set(s.id, st);
    }
    if (!surfaceEls.size) root.appendChild(el('div', 'hint panel', 'No touch surface. Add a "Touch XY pad / ribbon" source.'));
    sizeSurfaces();
  }
  function sizeSurfaces() {
    for (const st of surfaceEls.values()) { st.cv.width = st.cv.clientWidth * devicePixelRatio; st.cv.height = st.cv.clientHeight * devicePixelRatio; }
  }
  window.addEventListener('resize', sizeSurfaces);
  function drawSurfaces() {
    for (const [id, st] of surfaceEls) {
      const s = dev.sources.get(id);
      if (!s) continue;
      const g = st.cv.getContext('2d');
      const w = st.cv.width, h = st.cv.height, dpr = devicePixelRatio;
      g.clearRect(0, 0, w, h);
      g.strokeStyle = '#1e293b';
      for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(w * i / 4, 0); g.lineTo(w * i / 4, h); g.moveTo(0, h * i / 4); g.lineTo(w, h * i / 4); g.stroke(); }
      const x = dev.value(`${id}.x`), y = dev.value(`${id}.y`);
      const vx = s.params.layout === 'ribbon-v' ? 0.5 : x, vy = s.params.layout === 'ribbon-h' ? 0.5 : y;
      st.trail.push([vx, vy]);
      if (st.trail.length > UI.trailPoints) st.trail.shift();
      st.trail.forEach(([tx, ty], i) => { g.fillStyle = `rgba(52,211,153,${(i + 1) / st.trail.length * 0.35})`; g.beginPath(); g.arc(tx * w, (1 - ty) * h, 6 * dpr, 0, 6.2832); g.fill(); });
      for (const [px, py] of st.pointers.values()) { g.strokeStyle = '#f0abfc'; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(px * w, (1 - py) * h, 26 * dpr, 0, 6.2832); g.stroke(); }
      const pr = dev.value(`${id}.pressure`);
      g.fillStyle = dev.value(`${id}.gate`) ? '#f472b6' : '#34d399';
      g.beginPath(); g.arc(vx * w, (1 - vy) * h, (12 + 14 * pr) * dpr, 0, 6.2832); g.fill();
      for (const ws of dev.sources.values()) {
        if (ws.type !== 'well' || String(ws.refs.pad || '').split('.')[0] !== id) continue;
        g.fillStyle = '#60a5fa';
        g.beginPath(); g.arc(dev.value(`${ws.id}.x`) * w, (1 - dev.value(`${ws.id}.y`)) * h, 8 * dpr, 0, 6.2832); g.fill();
      }
    }
  }

  // ---------------------------------------------------------------- PLAY: motion cards (incl. desktop tilt simulator)
  function renderMotion() {
    const root = $('motion-cards');
    root.replaceChildren();
    for (const s of motionSources()) {
      const card = el('div', 'panel');
      const head = el('div', 'card-head');
      head.appendChild(el('div', 'lbl', `${s.name} · tilt / motion`));
      const btns = el('div', 'flex gap-1');
      const cal = el('button', 'btn btn-xs', 'CALIBRATE (ZERO)');
      cal.addEventListener('click', () => dev.calibrate(s.id));
      const shake = el('button', 'btn btn-xs', 'SIMULATE SHAKE');
      shake.addEventListener('click', () => dev.trigger(s.id, true));
      btns.append(cal, shake);
      head.appendChild(btns);
      card.appendChild(head);
      const bars = el('div', 'grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]');
      for (const o of ['alpha', 'beta', 'gamma', 'accMag', 'rotA', 'rotB', 'rotG', 'shake']) {
        const b = el('div');
        const lab = el('label', 'flex justify-between');
        lab.append(el('span', '', o));
        if (S.MOTION_OUTPUTS.indexOf(o) < 10 && o !== 'accMag') {
          const inv = el('input');
          inv.type = 'checkbox';
          inv.title = 'invert';
          inv.checked = !!s.invert[o];
          inv.addEventListener('change', () => { dev.setInvert(s.id, o, inv.checked); save(); });
          const il = el('span', 'text-slate-500');
          il.append(inv, ' inv');
          lab.append(il);
        }
        const m = el('div', 'meter');
        m.dataset.ref = `${s.id}.${o}`;
        m.append(el('i'));
        b.append(lab, m);
        bars.appendChild(b);
      }
      card.appendChild(bars);
      const sim = el('div', 'tilt-sim mt-2', 'tilt simulator (desktop): drag here');
      const simMove = (e) => {
        const r = sim.getBoundingClientRect();
        const nx = ((e.clientX - r.left) / r.width) * 2 - 1, ny = ((e.clientY - r.top) / r.height) * 2 - 1;
        const deg = cfg.sensors.simulateTiltDeg;
        dev.motionOrientation(s.id, 0, ny * deg, nx * deg, e.timeStamp || performance.now());
      };
      sim.addEventListener('pointerdown', (e) => { sim.setPointerCapture(e.pointerId); simMove(e); });
      sim.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') simMove(e); });
      card.appendChild(sim);
      root.appendChild(card);
    }
  }

  // ---------------------------------------------------------------- PLAY: triggers + route meters
  function renderTriggers() {
    const root = $('trigger-buttons');
    root.replaceChildren();
    for (const s of dev.sources.values()) {
      const label = { env: 'GATE', lfo: 'RETRIG', ball: 'DROP', sh: 'SAMPLE' }[s.type];
      if (!label) continue;
      const b = el('button', 'btn trig', `${label}\n${s.name}`);
      b.style.whiteSpace = 'pre-line';
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('down'); dev.trigger(s.id, true); });
      const off = () => { if (b.classList.contains('down')) { b.classList.remove('down'); dev.trigger(s.id, false); } };
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      root.appendChild(b);
    }
    if (!root.children.length) root.appendChild(el('span', 'hint', 'Envelopes, LFOs, balls and sample & holds get a trigger button here.'));
  }
  function renderPlayRoutes() {
    const root = $('play-routes');
    root.replaceChildren();
    for (const r of dev.routes.values()) {
      const row = el('div', 'grid grid-cols-[1fr_2fr] gap-2 items-center text-[11px]');
      const name = el('label', 'flex items-center gap-1 truncate');
      const en = el('input');
      en.type = 'checkbox';
      en.checked = r.enabled;
      en.addEventListener('change', () => { dev.updateRoute(r.id, { enabled: en.checked }); save(); });
      name.append(en, el('span', 'truncate', r.name));
      const m = el('div', 'meter');
      m.dataset.route = r.id;
      m.append(el('i'), el('b'));
      row.append(name, m);
      root.appendChild(row);
    }
    if (!dev.routes.size) root.appendChild(el('span', 'hint', 'No routes yet (ROUTES tab, or load a scene).'));
  }
  function updateMeters() {
    document.querySelectorAll('.meter[data-ref]').forEach((m) => {
      const r = dev.resolveRef(m.dataset.ref);
      if (!r) return;
      const v = dev.value(m.dataset.ref);
      const i = m.firstChild;
      if (r.bipolar) { i.style.left = `${Math.min(50, (v + 1) * 50)}%`; i.style.width = `${Math.abs(v) * 50}%`; } else { i.style.left = '0'; i.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`; }
    });
    document.querySelectorAll('.meter[data-route]').forEach((m) => {
      const r = dev.routes.get(m.dataset.route);
      if (!r) return;
      const v = dev.routeValue(r.id);
      const i = m.firstChild, b = m.lastChild;
      if (r.mode === 'offset') { i.style.left = `${Math.min(50, (v + 1) * 50)}%`; i.style.width = `${Math.abs(v) * 50}%`; } else { i.style.left = '0'; i.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`; }
      i.style.background = r.active ? '#10b981' : '#475569';
      const inp = dev.routeInput(r.id);
      const ref = dev.resolveRef(r.source);
      b.style.left = `${(ref && ref.bipolar ? (inp + 1) / 2 : Math.max(0, Math.min(1, inp))) * 100}%`;
    });
  }

  // ---------------------------------------------------------------- SOURCES
  const addSel = $('add-source-type');
  for (const [k, t] of Object.entries(S.TYPES)) addSel.add(new Option(t.label, k));
  $('add-source').addEventListener('click', () => { if (!dev.addSource({ type: addSel.value })) app.showError(`Source limit reached (client.modulator.maxSources = ${cfg.maxSources}).`); });
  const scopeCanvases = [];
  function renderSources() {
    const root = $('source-list');
    root.replaceChildren();
    scopeCanvases.length = 0;
    for (const s of dev.sources.values()) root.appendChild(sourceCard(s));
  }
  function sourceCard(s) {
    const card = el('div', 'panel');
    const head = el('div', 'card-head');
    const name = el('input', 'inp w-40');
    name.value = s.name;
    name.addEventListener('change', () => dev.renameSource(s.id, name.value));
    const del = el('button', 'btn btn-xs', '✕');
    del.addEventListener('click', () => dev.removeSource(s.id));
    const left = el('div', 'flex items-center gap-2');
    left.append(name, el('span', 'text-[10px] text-slate-500', `${S.TYPES[s.type].label} · ${s.id}`));
    head.append(left, del);
    card.appendChild(head);
    const cv = el('canvas', 'scope');
    cv.style.height = `${UI.scopeHeightPx}px`;
    const outs = S.TYPES[s.type].outputs;
    scopeCanvases.push({ cv, keys: outs.map((o) => `${s.id}.${o}`) });
    card.appendChild(cv);
    const legend = el('div', 'flex flex-wrap gap-2 text-[10px] mt-1');
    outs.forEach((o, i) => { const sp = el('span', '', o); sp.style.color = COLORS[i % COLORS.length]; legend.appendChild(sp); });
    card.appendChild(legend);
    const grid = el('div', 'pgrid mt-2');
    for (const d of dev.defsOf(s)) {
      grid.appendChild(numControl(d, s.params[d.id], (v) => {
        dev.setBase(`${s.id}.${d.id}`, v);
        if (d.choice) { card.replaceWith(sourceCard(s)); if (s.type === 'pad' && d.id === 'layout') renderSurfaces(); }
      }));
    }
    S.TYPES[s.type].refs.forEach((rd) => {
      const lab = el('label');
      lab.append(el('span', 'lbl', rd.name), refSelect(s.refs[rd.id], s.id, (v) => { dev.setRef(s.id, rd.id, v); save(); }));
      grid.appendChild(lab);
    });
    card.appendChild(grid);
    const dk = S.TYPES[s.type].data;
    if (dk === 'points') card.appendChild(pointsEditor(s));
    if (dk === 'values') card.appendChild(valuesEditor(s));
    if (dk === 'stages') card.appendChild(stagesEditor(s));
    return card;
  }
  function pointsEditor(s) {
    const box = el('div', 'mt-2');
    box.appendChild(el('div', 'lbl', 'Custom shape (shape = custom): tap to add, drag to move, double-tap to remove'));
    const cv = el('canvas', 'editor');
    const draw = () => {
      cv.width = cv.clientWidth * devicePixelRatio; cv.height = cv.clientHeight * devicePixelRatio;
      const g = cv.getContext('2d'), w = cv.width, h = cv.height;
      const pts = [...s.data.points].sort((a, b) => a.x - b.x);
      g.clearRect(0, 0, w, h);
      g.strokeStyle = '#a78bfa'; g.lineWidth = 2;
      g.beginPath();
      pts.forEach((p, i) => { const X = p.x * w, Y = (1 - (p.y + 1) / 2) * h; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); });
      g.stroke();
      g.fillStyle = '#fbbf24';
      for (const p of pts) { g.beginPath(); g.arc(p.x * w, (1 - (p.y + 1) / 2) * h, 5 * devicePixelRatio, 0, 6.2832); g.fill(); }
    };
    let drag = null;
    const at = (e) => { const r = cv.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(-1, Math.min(1, (1 - (e.clientY - r.top) / r.height) * 2 - 1)) }; };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const p = at(e);
      drag = s.data.points.find((q) => Math.abs(q.x - p.x) < 0.04 && Math.abs(q.y - p.y) < 0.15);
      if (!drag) { drag = p; s.data.points.push(p); }
      dev.setData(s.id, s.data); draw();
    });
    cv.addEventListener('pointermove', (e) => { if (!drag) return; Object.assign(drag, at(e)); dev.setData(s.id, s.data); draw(); });
    cv.addEventListener('pointerup', () => { drag = null; save(); });
    cv.addEventListener('dblclick', (e) => { const p = at(e); s.data.points = s.data.points.filter((q) => !(Math.abs(q.x - p.x) < 0.04 && Math.abs(q.y - p.y) < 0.15)); dev.setData(s.id, s.data); draw(); save(); });
    box.appendChild(cv);
    requestAnimationFrame(draw);
    return box;
  }
  function valuesEditor(s) {
    const box = el('div', 'mt-2');
    box.appendChild(el('div', 'lbl', 'Steps (drag to draw)'));
    const cv = el('canvas', 'editor');
    const n = () => Math.max(1, Math.round(s.params.steps));
    const draw = () => {
      cv.width = cv.clientWidth * devicePixelRatio; cv.height = cv.clientHeight * devicePixelRatio;
      const g = cv.getContext('2d'), w = cv.width, h = cv.height, k = n();
      const cur = dev.sourceInfo(s.id, 0);
      g.clearRect(0, 0, w, h);
      for (let i = 0; i < k; i++) {
        const v = s.data.values[i] || 0;
        g.fillStyle = i === cur ? '#f472b6' : '#34d399';
        g.fillRect(i * w / k + 1, (1 - v) * h, w / k - 2, v * h);
      }
    };
    const set = (e) => {
      const r = cv.getBoundingClientRect();
      const i = Math.floor((e.clientX - r.left) / r.width * n());
      if (i < 0 || i >= n()) return;
      s.data.values[i] = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      dev.setData(s.id, s.data);
    };
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); set(e); });
    cv.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') set(e); });
    cv.addEventListener('pointerup', () => save());
    box.appendChild(cv);
    liveEditors.push(draw);
    return box;
  }
  function stagesEditor(s) {
    const box = el('div', 'mt-2');
    box.appendChild(el('div', 'lbl', 'Multi-stage (shape = multi): duration (time unit), level, curve; sustain holds a stage while the gate is on'));
    const tbl = el('div', 'grid gap-1 text-[11px]');
    const render = () => {
      tbl.replaceChildren();
      s.data.stages.forEach((st, i) => {
        const row = el('div', 'grid grid-cols-[auto_1fr_1fr_1fr_auto] gap-1 items-center');
        const sus = el('input');
        sus.type = 'radio'; sus.name = `sus-${s.id}`; sus.checked = s.data.sustain === i; sus.title = 'sustain';
        sus.addEventListener('change', () => { s.data.sustain = i; dev.setData(s.id, s.data); save(); });
        const mk = (k, step) => { const x = el('input', 'inp'); x.type = 'number'; x.step = step; x.value = st[k]; x.addEventListener('change', () => { st[k] = Number(x.value) || 0; dev.setData(s.id, s.data); save(); }); return x; };
        const cur = el('select', 'inp');
        for (const c of S.CURVES) cur.add(new Option(c, c));
        cur.value = st.curve;
        cur.addEventListener('change', () => { st.curve = cur.value; dev.setData(s.id, s.data); save(); });
        const rm = el('button', 'btn btn-xs', '✕');
        rm.addEventListener('click', () => { s.data.stages.splice(i, 1); if (s.data.sustain >= s.data.stages.length) s.data.sustain = -1; dev.setData(s.id, s.data); render(); save(); });
        row.append(sus, mk('dur', 'any'), mk('level', '0.01'), cur, rm);
        tbl.appendChild(row);
      });
      const add = el('button', 'btn btn-xs', '+ STAGE');
      add.addEventListener('click', () => { s.data.stages.push({ dur: 1, level: 0, curve: 'lin' }); dev.setData(s.id, s.data); render(); save(); });
      const one = el('button', 'btn btn-xs', 'ONE-SHOT (no sustain)');
      one.addEventListener('click', () => { s.data.sustain = -1; dev.setData(s.id, s.data); render(); save(); });
      const bar = el('div', 'flex gap-1');
      bar.append(add, one);
      tbl.appendChild(bar);
    };
    render();
    box.appendChild(tbl);
    return box;
  }
  const liveEditors = [];

  // ---------------------------------------------------------------- ROUTES
  $('add-route').addEventListener('click', () => {
    const first = dev.allOutputs()[0];
    if (!dev.addRoute({ source: first ? first.ref : '' })) app.showError(`Route limit reached (client.modulator.maxRoutes = ${cfg.maxRoutes}).`);
  });
  const routeScopes = [];
  function renderRoutes() {
    const root = $('route-list');
    root.replaceChildren();
    routeScopes.length = 0;
    $('route-count').textContent = `${dev.routes.size} / ${cfg.maxRoutes}`;
    const T = cfg.ranges.transform;
    for (const r of dev.routes.values()) {
      const card = el('div', 'panel');
      const head = el('div', 'card-head');
      const left = el('div', 'flex items-center gap-2 flex-wrap');
      const en = el('input');
      en.type = 'checkbox';
      en.checked = r.enabled;
      en.addEventListener('change', () => { dev.updateRoute(r.id, { enabled: en.checked }); save(); });
      const name = el('input', 'inp w-40');
      name.value = r.name;
      name.addEventListener('change', () => { dev.updateRoute(r.id, { name: name.value }); save(); });
      left.append(en, name, refSelect(r.source, null, (v) => { dev.updateRoute(r.id, { source: v }); save(); }, false));
      const mode = el('select', 'inp w-28');
      mode.add(new Option('absolute', 'absolute'));
      mode.add(new Option('offset (±)', 'offset'));
      mode.value = r.mode;
      mode.addEventListener('change', () => { dev.updateRoute(r.id, { mode: mode.value }); save(); });
      left.append(mode);
      const right = el('div', 'flex gap-1');
      const learn = el('button', 'btn btn-xs', 'LEARN');
      learn.addEventListener('click', () => { $('assign-route').value = r.id; dev.learn ? dev.stopLearn() : dev.startLearn(r.id, performance.now()); });
      const add = el('button', 'btn btn-xs', '+ TARGET');
      add.addEventListener('click', () => { renderAssign(); $('assign-route').value = r.id; showTab('targets'); });
      const del = el('button', 'btn btn-xs', '✕');
      del.addEventListener('click', () => dev.removeRoute(r.id));
      right.append(learn, add, del);
      head.append(left, right);
      card.appendChild(head);
      const cv = el('canvas', 'scope');
      cv.style.height = `${UI.scopeHeightPx}px`;
      const ref = dev.resolveRef(r.source);
      routeScopes.push({ cv, keys: [r.source, `route:${r.id}`].filter((k) => k && (k.startsWith('route:') || ref)) });
      card.appendChild(cv);
      const grid = el('div', 'pgrid mt-2');
      const tf = r.transform;
      const upd = (patch) => { dev.updateRoute(r.id, { transform: patch }); save(); };
      const D = S.transformDefs(cfg);
      grid.appendChild(numControl(D.depth, tf.depth, (v) => upd({ depth: v })));
      grid.appendChild(numControl(D.offset, tf.offset, (v) => upd({ offset: v })));
      grid.appendChild(numControl({ name: 'Polarity', choice: true, valueItems: ['auto', 'uni', 'bi'] }, tf.polarity, (v) => upd({ polarity: v })));
      grid.appendChild(numControl({ name: 'Response curve', choice: true, valueItems: S.CURVES }, tf.curve, (v) => upd({ curve: v })));
      grid.appendChild(numControl({ name: 'Curve amount', min: T.curveAmount[0], max: T.curveAmount[1], scale: 'lin' }, tf.curveAmount, (v) => upd({ curveAmount: v })));
      grid.appendChild(numControl({ name: 'Slew', unit: 'ms', min: T.slewMs[0], max: T.slewMs[1], scale: 'lin' }, tf.slewMs, (v) => upd({ slewMs: v })));
      grid.appendChild(numControl({ name: 'Quantize steps (0 off)', min: T.steps[0], max: T.steps[1], steps: T.steps[1] - T.steps[0] + 1, scale: 'lin' }, tf.steps, (v) => upd({ steps: Math.round(v) })));
      const inv = el('label', 'flex items-center gap-1 text-[11px] mt-4');
      const ic = el('input');
      ic.type = 'checkbox';
      ic.checked = tf.invert;
      ic.addEventListener('change', () => upd({ invert: ic.checked }));
      inv.append(ic, 'invert');
      grid.appendChild(inv);
      card.appendChild(grid);
      const tl = el('div', 'grid gap-1 mt-2');
      r.senders.forEach((s, i) => {
        const row = el('div', 'target-row');
        row.dataset.status = `${r.id}:${i}`;
        const lab = el('span', 'truncate', dev.targetLabel(s.t));
        const stv = el('span', `status-${s.status}`, s.status);
        const base = (s.kind === 'live' || s.kind === 'macro' || s.kind === 'cc') && r.mode === 'offset' ? el('input', 'inp w-16') : null;
        if (base) { base.type = 'number'; base.step = '0.01'; base.min = 0; base.max = 1; base.title = 'base value for offset mode'; base.value = Number.isFinite(s.t.base) ? s.t.base : cfg.offsetBaseDefault; base.addEventListener('change', () => { s.t.base = Math.max(0, Math.min(1, Number(base.value))); save(); }); }
        const rm = el('button', 'btn btn-xs', '✕');
        rm.addEventListener('click', () => dev.removeTarget(r.id, i));
        row.append(lab, ...(base ? [base] : []), stv, rm);
        tl.appendChild(row);
      });
      if (!r.senders.length) tl.appendChild(el('div', 'hint', 'No target yet: + TARGET or LEARN.'));
      card.appendChild(tl);
      root.appendChild(card);
    }
    renderPlayRoutes();
    renderAssign();
  }
  function updateTargetStatus() {
    document.querySelectorAll('.target-row[data-status]').forEach((row) => {
      const [rid, i] = row.dataset.status.split(':');
      const r = dev.routes.get(rid);
      const s = r && r.senders[Number(i)];
      if (!s) return;
      const sp = row.children[row.children.length - 2];
      if (sp.textContent !== s.status) { sp.textContent = s.status; sp.className = `status-${s.status}`; }
    });
  }

  // ---------------------------------------------------------------- TARGETS
  function renderAssign() {
    const sel = $('assign-route');
    const cur = sel.value;
    sel.replaceChildren(...[...dev.routes.values()].map((r) => new Option(r.name, r.id)));
    if (dev.routes.has(cur)) sel.value = cur;
  }
  const assignTo = () => {
    const id = $('assign-route').value;
    if (!dev.routes.has(id)) { app.showError('Create a route first (ROUTES tab).'); return null; }
    return id;
  };
  function addTarget(t) {
    const id = assignTo();
    if (!id) return;
    if (!dev.addTarget(id, t)) app.showError(`Target limit per route reached (client.modulator.maxTargetsPerRoute = ${cfg.maxTargetsPerRoute}).`);
    else log(`target → ${dev.targetLabel(t)}`);
  }
  $('learn').addEventListener('click', () => { const id = assignTo(); if (id) { if (dev.learn) dev.stopLearn(); else dev.startLearn(id, performance.now()); } });
  $('discover').addEventListener('click', () => dev.discover());
  $('add-match').addEventListener('click', () => { const m = $('match-pattern').value.trim(); if (m) addTarget({ kind: 'jam', instanceId: '*', match: m }); });
  function renderInstruments() {
    const root = $('instruments');
    root.replaceChildren();
    for (const inst of dev.instruments.values()) {
      const box = el('div', 'box');
      box.appendChild(el('div', 'font-bold text-slate-200 mb-1', `${inst.appName} · ${inst.kind}`));
      const list = el('div', 'flex flex-wrap gap-1');
      for (const p of inst.params || []) {
        if (p.modulatable === false) continue;
        const b = el('button', 'btn btn-xs', p.name || p.id);
        b.title = `${p.id} ${p.min}..${p.max}${p.unit ? ` ${p.unit}` : ''}`;
        b.addEventListener('click', () => addTarget({ kind: 'jam', instanceId: inst.instanceId, param: p.id }));
        list.appendChild(b);
      }
      box.appendChild(list);
      root.appendChild(box);
    }
    if (!dev.instruments.size) root.appendChild(el('div', 'hint', 'No JamConnect instrument announced yet. Open one (e.g. the wavetable synth) in the same session.'));
  }
  // Ableton browsing (same LIVE_* requests as Live Control / M4L Controller)
  const browse = { tracks: [], devices: [], params: [] };
  const parseRef = (v) => (/^\d+$/.test(v) ? Number(v) : v);
  const fill = (sel, items, ph) => sel.replaceChildren(new Option(ph, ''), ...items.map(([v, l]) => new Option(l, String(v))));
  $('m4l-discover').addEventListener('click', () => { app.send({ type: 'M4L_DISCOVER' }); app.send({ type: 'LIVE_GET_TRACKS' }); });
  $('lv-track').addEventListener('change', (e) => { fill($('lv-device'), [], '—'); fill($('lv-param'), [], '—'); if (e.target.value !== '') app.send({ type: 'LIVE_GET_DEVICES', track: parseRef(e.target.value) }); });
  $('lv-device').addEventListener('change', (e) => { fill($('lv-param'), [], '—'); if (e.target.value !== '') app.send({ type: 'LIVE_GET_DEVICE', track: parseRef($('lv-track').value), device: Number(e.target.value) }); });
  function selectedLive() {
    const t = $('lv-track').value, d = $('lv-device').value, p = $('lv-param').value;
    if (t === '' || d === '' || p === '') return null;
    const tr = browse.tracks.find((x) => String(x.ref) === t), dv = browse.devices.find((x) => String(x.index) === d), pa = browse.params.find((x) => String(x.index) === p);
    return { track: parseRef(t), device: Number(d), param: Number(p), trackName: tr && tr.name, deviceName: dv && dv.name, paramName: pa && pa.name, base: pa ? pa.normalized : undefined };
  }
  $('add-live').addEventListener('click', () => { const s = selectedLive(); if (!s) { app.showError('Pick track, device and parameter.'); return; } addTarget({ kind: 'live', ...s }); });
  $('add-macro').addEventListener('click', () => {
    const inst = selectedM4l || '*first';
    const macro = Number($('macro-index').value) || 0;
    const d = dev.m4l.get(inst === '*first' ? dev.resolveM4l('*first') : inst);
    const base = d && d.macros && d.macros[macro] ? d.macros[macro].normalized : undefined;
    addTarget({ kind: 'macro', instance: inst, macro, base });
    const s = selectedLive();
    if ($('macro-map').checked && s) app.send({ type: 'M4L_MAP_MACRO', target: inst === '*first' ? dev.resolveM4l('*first') : inst, macro, track: s.track, device: s.device, param: s.param });
  });
  $('cc-number').value = 1;
  $('cc-channel').value = 1;
  $('add-cc').addEventListener('click', () => addTarget({ kind: 'cc', instance: selectedM4l || '*first', cc: Math.max(0, Math.min(127, Number($('cc-number').value) || 0)), channel: Math.max(1, Math.min(16, Number($('cc-channel').value) || 1)) }));
  let selectedM4l = null;
  function renderM4l() {
    const root = $('m4l-devices');
    root.replaceChildren();
    const first = el('button', `btn btn-xs${selectedM4l === null ? ' on' : ''}`, 'first device');
    first.addEventListener('click', () => { selectedM4l = null; renderM4l(); });
    root.appendChild(first);
    for (const [id, d] of [...dev.m4l].sort((a, b) => a[0].localeCompare(b[0]))) {
      const b = el('button', `btn btn-xs${selectedM4l === id ? ' on' : ''}`, `${d.track ? d.track.name : id}`);
      b.title = id;
      b.addEventListener('click', () => { selectedM4l = id; renderM4l(); });
      root.appendChild(b);
    }
    const d = dev.m4l.get(selectedM4l || dev.resolveM4l('*first'));
    const macros = (d && d.macros) || [];
    $('macro-index').replaceChildren(...(macros.length ? macros.map((m) => new Option(m.name, String(m.index))) : (config.m4l.macros || []).map((m, i) => new Option(m.name, String(i)))));
  }
  function onRelayUi(msg) {
    switch (msg.type) {
      case 'LIVE_TRACKS_INFO':
        browse.tracks = [...(msg.tracks || []), ...(msg.returns || []), ...(msg.master ? [msg.master] : [])];
        fill($('lv-track'), browse.tracks.map((t) => [t.ref, t.kind === 'master' ? 'Master' : t.kind === 'return' ? `${t.name} (return)` : t.name]), '— track —');
        break;
      case 'LIVE_DEVICES':
        if (String(msg.track) !== $('lv-track').value) break;
        browse.devices = msg.devices || [];
        fill($('lv-device'), browse.devices.map((d) => [d.index, d.name]), '— device —');
        if (dev.learn) observeForLearn();
        break;
      case 'LIVE_DEVICE_INFO':
        if (String(msg.track) !== $('lv-track').value || String(msg.device) !== $('lv-device').value) break;
        browse.params = msg.parameters || [];
        fill($('lv-param'), browse.params.map((p) => [p.index, `${p.name}${p.isQuantized ? ' (stepped)' : ''}`]), '— parameter —');
        break;
      case 'LIVE_SET_CHANGED':
        app.send({ type: 'LIVE_GET_TRACKS' });
        break;
      default:
    }
  }
  // learn from Live: observe the devices of the browsed track while learning
  let learnObserved = [];
  function observeForLearn() {
    unobserveLearn();
    const t = $('lv-track').value;
    if (t === '') return;
    learnObserved = browse.devices.slice(0, cfg.learnMaxObservedDevices).map((d) => ({ track: parseRef(t), device: d.index }));
    for (const o of learnObserved) app.send({ type: 'LIVE_OBSERVE', scope: 'device', ...o });
  }
  function unobserveLearn() {
    for (const o of learnObserved) app.send({ type: 'LIVE_UNOBSERVE', scope: 'device', ...o });
    learnObserved = [];
  }
  function renderSelfParams() {
    const root = $('self-params');
    root.replaceChildren();
    for (const p of dev.paramDefs()) {
      if (!p.def.modulatable) continue;
      const b = el('button', 'btn btn-xs', p.name || p.def.name);
      b.addEventListener('click', () => addTarget({ kind: 'self', param: p.key }));
      root.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- SCENES
  function renderScenes() {
    const f = $('factory-scenes');
    f.replaceChildren(...factory.map((sc) => { const b = el('button', 'btn text-left', sc.name); b.addEventListener('click', () => loadScene(sc.scene, sc.name)); return b; }));
    const sv = $('saved-scenes');
    sv.replaceChildren();
    for (const name of Object.keys(store.scenes).sort()) {
      const row = el('div', 'flex gap-1');
      const b = el('button', 'btn flex-1 text-left', name);
      b.addEventListener('click', () => loadScene(store.scenes[name], name));
      const rm = el('button', 'btn btn-xs', '✕');
      rm.addEventListener('click', () => { delete store.scenes[name]; localStorage[cfg.storageKey] = JSON.stringify(store); renderScenes(); });
      row.append(b, rm);
      sv.appendChild(row);
    }
    if (!sv.children.length) sv.appendChild(el('div', 'hint', 'Nothing saved yet.'));
  }
  function loadScene(scene, name) {
    try { dev.loadScene(JSON.parse(JSON.stringify(scene))); log(`scene loaded: ${name}`); } catch (err) { app.showError(`Scene: ${err.message}`); }
  }
  $('scene-save').addEventListener('click', () => {
    const name = $('scene-name').value.trim();
    if (!name) { app.showError('Give the scene a name.'); return; }
    store.scenes[name] = dev.toScene();
    localStorage[cfg.storageKey] = JSON.stringify(store);
    renderScenes();
  });
  $('scene-export').addEventListener('click', () => { $('scene-json').value = JSON.stringify(dev.toScene(), null, 1); });
  $('scene-download').addEventListener('click', () => {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(dev.toScene(), null, 1)], { type: 'application/json' }));
    a.download = 'jamconnect-mod-scene.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('scene-import').addEventListener('click', () => { try { loadScene(JSON.parse($('scene-json').value), 'imported'); } catch (err) { app.showError(`Import: ${err.message}`); } });
  $('scene-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { const txt = await f.text(); $('scene-json').value = txt; loadScene(JSON.parse(txt), f.name); } catch (err) { app.showError(`Import: ${err.message}`); }
  });

  // ---------------------------------------------------------------- render + frame loop
  function renderAll() {
    renderSurfaces();
    renderMotion();
    renderTriggers();
    liveEditors.length = 0;
    renderSources();
    renderRoutes();
    renderInstruments();
    renderM4l();
    renderSelfParams();
    renderScenes();
    app.applyPermissionLocks();
  }
  renderAll();
  let lastScope = 0;
  app.onFrame((st) => {
    const now = performance.now();
    if (mic) {
      mic.an.getFloatTimeDomainData(mic.buf);
      for (const s of dev.sources.values()) if (s.type === 'mic') dev.audioBlock(s.id, mic.buf, now);
    }
    drawSurfaces();
    updateMeters();
    if (now - lastScope >= 1000 / cfg.scopes.fps) {
      lastScope = now;
      sampleScopes();
      const pane = document.querySelector('.main-pane:not(.hidden)');
      if (pane && pane.dataset.pane === 'sources') { for (const s of scopeCanvases) drawScope(s.cv, s.keys); for (const d of liveEditors) d(); }
      if (pane && pane.dataset.pane === 'routes') { for (const s of routeScopes) drawScope(s.cv, s.keys); updateTargetStatus(); }
    }
    const has = !!st.source && st.tempo !== null;
    $('link-chip').textContent = has ? `LINK ${st.tempo.toFixed(1)} BPM · ${st.phase.toFixed(1)}/${st.quantum}` : 'NO LINK: synced sources wait';
  });
  window.jamConnectModDevice = { app, dev };
})();
