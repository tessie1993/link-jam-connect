/* JamConnect M4L Controller: drives the "JamConnect Link" Max for Live device(s) through jamlink-bridge.
 * M4L_* messages address one device instance (target) or all ("*"); the mapping editor browses Live
 * with LIVE_* requests sent to the same instance. Notes can be quantized to the Link grid. */
(async () => {
  const $ = (id) => document.getElementById(id);
  const app = await JCApp.start({ appKey: 'm4lController' });
  const { connector, config, appCfg, send, log, el } = app;
  const cfgM4l = config.m4l || {};

  const macroSend = JCApp.throttle(appCfg.macroSendIntervalMs);
  const ccSend = JCApp.throttle(appCfg.ccSendIntervalMs);
  const devices = new Map(); // instance -> status message + lastSeen
  let selected = null;
  let mappings = [];
  const browse = { tracks: [], devices: [], params: [] };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`; // Live: C3 = 60

  const target = () => selected;
  function sendTo(msg) {
    if (!selected) { app.showError('Pick a Max for Live device first.'); return false; }
    return send({ ...msg, target: selected });
  }

  // ---------------------------------------------------------------- discovery
  function discover() { if (app.connected()) send({ type: 'M4L_DISCOVER' }); }
  $('discover').addEventListener('click', discover);
  app.onConnection((s) => { if (s === 'connected') discover(); });
  if (appCfg.discoverIntervalMs > 0) setInterval(discover, appCfg.discoverIntervalMs);
  setInterval(() => {
    const timeout = Number(cfgM4l.peerTimeoutMs) || 0;
    if (!(timeout > 0)) return;
    let changed = false;
    for (const [id, d] of devices) if (performance.now() - d.lastSeen > timeout) { devices.delete(id); changed = true; }
    if (changed) renderDevices();
  }, 1000);

  function renderDevices() {
    if (selected && !devices.has(selected)) selected = null;
    if (!selected && devices.size) { select([...devices.keys()].sort()[0]); return; }
    const root = $('devices');
    root.replaceChildren();
    for (const [id, d] of [...devices].sort((a, b) => a[0].localeCompare(b[0]))) {
      const b = el('button', 'device-card' + (id === selected ? ' on' : ''));
      b.append(el('div', 'font-bold text-slate-100', d.track ? `${d.track.name || 'track'} (${d.track.kind === 'track' ? `#${d.track.index + 1}` : d.track.kind})` : d.name),
        el('div', 'text-[10px] text-slate-400', `${id}${d.primary ? ' · primary' : ''}${d.ready ? '' : ' · loading'}`));
      b.addEventListener('click', () => select(id));
      root.appendChild(b);
    }
    if (!devices.size) root.textContent = 'No device found yet. Load "JamConnect Link" on a track; it announces itself every m4l.statusIntervalMs.';
    renderInfo();
  }

  function renderInfo() {
    const d = devices.get(selected);
    const root = $('device-info');
    root.replaceChildren();
    if (!d) return;
    const cell = (k, v) => { const c = el('div', 'box'); c.append(el('div', 'lbl', k), el('div', 'text-sm', v)); return c; };
    root.append(cell('Device', d.deviceName || d.name), cell('Track', d.track ? d.track.name : '-'), cell('Live', d.liveVersion || '-'),
      cell('Bridge', d.connected ? 'connected' : 'offline'), cell('Mappings', String(d.mappings)), cell('Forward MIDI', d.forwardMidi ? 'on' : 'off'),
      cell('Primary (LIVE_*)', d.primary ? 'yes' : 'no'), cell('Instance', d.instance));
    if (document.activeElement !== $('forward')) $('forward').checked = !!d.forwardMidi;
  }

  function select(id) {
    if (selected === id) return;
    selected = id;
    renderDevices();
    renderMacros();
    sendTo({ type: 'M4L_LIST_MAPPINGS' });
    sendTo({ type: 'LIVE_GET_TRACKS' });
  }

  // ---------------------------------------------------------------- macros
  const knobs = new Map(); // macro index -> knob
  function makeKnob(m) {
    const wrap = el('div', 'flex flex-col items-center gap-1 macro');
    const knob = el('div', 'knob');
    knob.tabIndex = 0;
    knob.dataset.needs = 'syncDeviceParameterChange';
    const ind = el('div', 'knob-ind');
    knob.appendChild(ind);
    const val = el('div', 'text-[11px] text-amber-300', '-');
    wrap.append(knob, el('div', 'text-[11px] text-slate-300', m.name || `Macro ${m.index + 1}`), val);
    const k = { norm: m.normalized === null || m.normalized === undefined ? 0 : m.normalized, dragging: false, m };
    const draw = () => {
      ind.style.transform = `rotate(${-135 + 270 * k.norm}deg)`;
      const v = m.min + k.norm * (m.max - m.min);
      val.textContent = Number.isFinite(v) ? v.toFixed(Math.abs(m.max - m.min) > 10 ? 0 : 2) : '-';
    };
    const set = (n) => {
      if (knob.classList.contains('locked')) return;
      k.norm = Math.max(0, Math.min(1, n));
      draw();
      // Echoes of earlier sends must not pull the knob back: ignore them for one send interval
      // (the trailing send) plus one more (its echo).
      k.localUntil = performance.now() + 2 * (appCfg.macroSendIntervalMs || 0);
      const norm = k.norm;
      macroSend(`${selected}:${m.index}`, () => sendTo({ type: 'M4L_SET_MACRO', macro: m.index, normalized: norm }));
    };
    let startY = 0, startN = 0;
    knob.addEventListener('pointerdown', (e) => { k.dragging = true; startY = e.clientY; startN = k.norm; knob.setPointerCapture(e.pointerId); });
    knob.addEventListener('pointermove', (e) => { if (k.dragging) set(startN + (startY - e.clientY) / 150); });
    knob.addEventListener('pointerup', () => { k.dragging = false; });
    knob.addEventListener('wheel', (e) => { e.preventDefault(); set(k.norm - Math.sign(e.deltaY) * 0.01); });
    knob.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp') set(k.norm + 0.01); if (e.key === 'ArrowDown') set(k.norm - 0.01); });
    k.update = (n) => { if (!k.dragging && !(performance.now() < k.localUntil)) { k.norm = n; draw(); } };
    draw();
    knobs.set(m.index, k);
    return wrap;
  }

  function renderMacros() {
    const root = $('macros');
    root.replaceChildren();
    knobs.clear();
    const d = devices.get(selected);
    const list = (d && d.macros) || [];
    for (const m of list) root.appendChild(makeKnob(m));
    $('macro-note').textContent = d ? `${list.length} macros (m4l.macroCount)` : '';
    const sel = $('map-macro');
    sel.replaceChildren(...list.map((m) => new Option(m.name || `Macro ${m.index + 1}`, String(m.index))));
    app.applyPermissionLocks();
  }

  // ---------------------------------------------------------------- mapping editor (LIVE_* browse)
  const parseRef = (v) => (/^\d+$/.test(v) ? Number(v) : v);
  function fillSelect(sel, items, placeholder) {
    sel.replaceChildren(new Option(placeholder, ''), ...items.map(([v, label]) => new Option(label, String(v))));
  }
  $('map-track').addEventListener('change', (e) => {
    fillSelect($('map-device'), [], '—');
    fillSelect($('map-param'), [], '—');
    if (e.target.value !== '') sendTo({ type: 'LIVE_GET_DEVICES', track: parseRef(e.target.value) });
  });
  $('map-device').addEventListener('change', (e) => {
    fillSelect($('map-param'), [], '—');
    if (e.target.value !== '') sendTo({ type: 'LIVE_GET_DEVICE', track: parseRef($('map-track').value), device: Number(e.target.value) });
  });
  $('map-add').addEventListener('click', () => {
    const track = $('map-track').value, device = $('map-device').value, param = $('map-param').value;
    if (track === '' || device === '' || param === '') { app.showError('Pick track, device and parameter.'); return; }
    const pct = (id) => Math.max(0, Math.min(100, Number($(id).value) || 0)) / 100;
    sendTo({ type: 'M4L_MAP_MACRO', macro: Number($('map-macro').value), track: parseRef(track), device: Number(device), param: Number(param), min: pct('map-min'), max: pct('map-max') });
  });

  function renderMappings() {
    const root = $('mappings');
    const d = devices.get(selected);
    const names = (d && d.macros) || [];
    root.replaceChildren(...mappings.map((m) => {
      const row = el('div', 'box flex justify-between items-center gap-2');
      const macro = names[m.macro] ? names[m.macro].name : `Macro ${m.macro + 1}`;
      row.appendChild(el('span', '', `${macro} → ${m.trackName || m.track} / ${m.deviceName} / ${m.paramName}  [${Math.round(m.min * 100)}% … ${Math.round(m.max * 100)}%]`));
      const del = el('button', 'btn btn-xs', '✕');
      del.dataset.needs = 'syncDeviceParameterChange';
      del.addEventListener('click', () => sendTo({ type: 'M4L_UNMAP_MACRO', macro: m.macro, track: m.track, device: m.device, param: m.param }));
      row.appendChild(del);
      return row;
    }));
    if (!mappings.length) root.textContent = selected ? 'No mappings on this device.' : '';
    app.applyPermissionLocks();
  }

  // ---------------------------------------------------------------- incoming
  app.onRelay((msg) => {
    const fromSelected = msg.instance && msg.instance === selected;
    switch (msg.type) {
      case 'M4L_HELLO':
      case 'M4L_STATUS': {
        const known = devices.get(msg.instance);
        devices.set(msg.instance, { ...msg, lastSeen: performance.now() });
        if (!known) log(`device ${msg.instance} on ${msg.track ? msg.track.name : 'a track'}`);
        renderDevices();
        if (msg.instance === selected && (!known || JSON.stringify(known.macros.map((m) => m.name)) !== JSON.stringify(msg.macros.map((m) => m.name)))) renderMacros();
        break;
      }
      case 'M4L_BYE':
        devices.delete(msg.instance);
        renderDevices();
        break;
      case 'M4L_MACRO_CHANGED': {
        const d = devices.get(msg.instance);
        if (d && d.macros[msg.macro]) Object.assign(d.macros[msg.macro], { value: msg.value, normalized: msg.normalized });
        if (fromSelected && knobs.has(msg.macro)) knobs.get(msg.macro).update(msg.normalized);
        break;
      }
      case 'M4L_MAPPINGS':
        if (fromSelected) { mappings = msg.mappings || []; renderMappings(); }
        break;
      case 'LIVE_TRACKS_INFO':
        if (!fromSelected) break;
        browse.tracks = [...msg.tracks, ...msg.returns, ...(msg.master ? [msg.master] : [])];
        fillSelect($('map-track'), browse.tracks.map((t) => [t.ref, t.kind === 'master' ? 'Master' : t.kind === 'return' ? `${t.name} (return)` : t.name]), '— track —');
        break;
      case 'LIVE_DEVICES':
        if (!fromSelected || String(msg.track) !== $('map-track').value) break;
        fillSelect($('map-device'), msg.devices.map((d) => [d.index, d.name]), '— device —');
        break;
      case 'LIVE_DEVICE_INFO':
        if (!fromSelected || String(msg.track) !== $('map-track').value || String(msg.device) !== $('map-device').value) break;
        fillSelect($('map-param'), msg.parameters.map((p) => [p.index, `${p.name}${p.isQuantized ? ' (stepped)' : ''}`]), '— parameter —');
        break;
      case 'LIVE_SET_CHANGED':
        if (fromSelected) sendTo({ type: 'LIVE_GET_TRACKS' });
        break;
      default:
    }
  });

  // ---------------------------------------------------------------- notes (Link-quantized)
  const quantSel = $('quantize');
  for (const q of appCfg.quantizeOptions || []) quantSel.add(new Option(q === 0 ? 'off' : String(q), String(q)));
  quantSel.add(new Option('bar (quantum)', 'quantum'));
  quantSel.value = String(appCfg.quantizeBeats);
  $('velocity').value = appCfg.noteVelocity;
  $('vel-val').textContent = appCfg.noteVelocity;
  $('velocity').addEventListener('input', (e) => { $('vel-val').textContent = e.target.value; });
  $('duration').value = appCfg.noteDurationMs;
  for (let c = 1; c <= 16; c++) $('channel').add(new Option(String(c)));

  /** ms until the next grid line of `grid` beats on the Link timeline (0 = now). */
  function delayToGrid() {
    const st = connector.getLinkState();
    const grid = quantSel.value === 'quantum' ? st.quantum : Number(quantSel.value);
    if (!(grid > 0) || !st.source || st.tempo === null) return 0;
    const now = performance.now();
    const beat = connector.linkBeatAtTime(now);
    const next = Math.ceil(beat / grid - 1e-9) * grid;
    return Math.max(0, connector.linkTimeAtBeat(next) - now);
  }

  function playNote(note, padEl) {
    const msg = { type: 'M4L_NOTE', note, velocity: Number($('velocity').value), channel: Number($('channel').value), durationMs: Number($('duration').value) };
    const delay = delayToGrid();
    const fire = () => {
      if (sendTo(msg) && padEl) { padEl.classList.add('hit'); setTimeout(() => padEl.classList.remove('hit'), Math.min(msg.durationMs, 300)); }
    };
    if (padEl) padEl.classList.add('armed');
    setTimeout(() => { if (padEl) padEl.classList.remove('armed'); fire(); }, delay);
  }

  const pads = $('pads');
  for (let i = 0; i < appCfg.padCount; i++) {
    const n = appCfg.padBaseNote + i;
    const b = el('button', 'pad', noteName(n));
    b.dataset.needs = 'syncMidi';
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); playNote(n, b); });
    pads.appendChild(b);
  }
  const kb = $('keyboard');
  for (let i = 0; i < appCfg.keyboardKeys; i++) {
    const n = appCfg.keyboardBaseNote + i;
    const black = [1, 3, 6, 8, 10].includes(n % 12);
    const k = el('button', black ? 'key black' : 'key', black ? '' : noteName(n));
    k.dataset.needs = 'syncMidi';
    k.addEventListener('pointerdown', (e) => { e.preventDefault(); playNote(n, k); });
    kb.appendChild(k);
  }

  // ---------------------------------------------------------------- CC faders
  for (const cc of appCfg.ccNumbers || []) {
    const wrap = el('div', 'flex flex-col items-center gap-1');
    const s = el('input', 'vslider');
    s.type = 'range';
    s.min = 0;
    s.max = 127;
    s.value = 0;
    s.dataset.needs = 'syncMidi';
    const v = el('div', 'text-[10px] text-slate-400', '0');
    s.addEventListener('input', () => {
      v.textContent = s.value;
      const value = Number(s.value);
      ccSend(`${selected}:${cc}`, () => sendTo({ type: 'M4L_CC', cc, value, channel: Number($('channel').value) }));
    });
    wrap.append(s, el('div', 'text-[11px] text-slate-300', `CC ${cc}`), v);
    $('ccs').appendChild(wrap);
  }

  // ---------------------------------------------------------------- MIDI monitor
  $('forward').addEventListener('change', (e) => sendTo({ type: 'M4L_SET_MIDI_FORWARD', enabled: e.target.checked }));
  $('mon-clear').addEventListener('click', () => $('monitor').replaceChildren());
  connector.onMidiMessage = (appName, ev, raw) => {
    if (!ev) return;
    const inst = raw && raw.instance;
    if ($('mon-selected').checked && inst !== selected) return;
    const what = ev.kind === 'cc' ? `CC ${ev.cc} = ${ev.value}` : `${ev.kind} ${noteName(Number(ev.note))} (${ev.note}) vel ${ev.velocity}`;
    const row = el('div', 'flex gap-3');
    row.append(el('span', 'text-slate-500', new Date().toLocaleTimeString()), el('span', 'text-emerald-300', inst || (raw && raw.from) || appName || '?'),
      el('span', '', what), el('span', 'text-slate-500', `ch ${ev.channel || 1}`));
    const mon = $('monitor');
    mon.appendChild(row);
    const max = Number(appCfg.midiMonitorMax) || 0;
    while (max > 0 && mon.children.length > max) mon.firstChild.remove();
    mon.scrollTop = mon.scrollHeight;
  };

  app.onPermissions(() => app.applyPermissionLocks());
  app.applyPermissionLocks();
  window.jamConnectM4lController = { app, devices, target };
})();
