/* JamConnect Live Control: Link state + the whole Live set through jamlink-bridge.
 * Link (tempo, play/stop, phase) comes from the bridge's Link peer. Everything else is
 * LIVE_* traffic that the bridge relays to the Max for Live device (see PROTOCOL.md). */
(async () => {
  const $ = (id) => document.getElementById(id);
  const MIDIMAP_KEY = 'jclLiveControlMidiMap';
  const app = await JCApp.start({ appKey: 'liveControl' });
  const { connector, appCfg, send, log, el } = app;

  const paramSend = JCApp.throttle(appCfg.paramSendIntervalMs);
  const mixerSend = JCApp.throttle(appCfg.mixerSendIntervalMs);
  const S = { set: null, song: {}, devices: [], devTrack: null, device: null, deviceInfo: null, observing: null };
  let active = null; // control being dragged: incoming events don't move it
  let learnTarget = null;
  let midiMap = (() => { try { return JSON.parse(localStorage[MIDIMAP_KEY] || '[]'); } catch (_) { return []; } })();

  const colorOf = (c) => (typeof c === 'number' && c >= 0 ? `#${c.toString(16).padStart(6, '0')}` : '');
  const refKey = (r) => String(r);
  const trackLabel = (t) => (t.kind === 'return' ? `${t.name} (return)` : t.kind === 'master' ? 'Master' : t.name);

  function allTracks() {
    if (!S.set) return [];
    return [...(S.set.tracks || []), ...(S.set.returns || []), ...(S.set.master ? [S.set.master] : [])];
  }
  const findTrack = (ref) => allTracks().find((t) => refKey(t.ref) === refKey(ref));

  function trackDragging(input) {
    input.addEventListener('pointerdown', () => { active = input; });
    input.addEventListener('pointerup', () => { if (active === input) active = null; });
    input.addEventListener('blur', () => { if (active === input) active = null; });
  }

  // ---------------------------------------------------------------- refresh / observe
  let refreshTimer = null;
  function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (!app.connected()) return;
      send({ type: 'LIVE_GET_SET' });
      send({ type: 'LIVE_OBSERVE', scope: 'song' });
      send({ type: 'LIVE_OBSERVE', scope: 'tracks' });
      if (S.devTrack !== null) send({ type: 'LIVE_GET_DEVICES', track: S.devTrack });
      if (S.device !== null) selectDevice(S.device);
    }, appCfg.refreshDebounceMs || 0);
  }
  $('refresh').addEventListener('click', () => { refresh(); send({ type: 'LIVE_GET_SONG' }); });
  app.onConnection((status) => { if (status === 'connected') refresh(); });

  // ---------------------------------------------------------------- incoming
  app.onRelay((msg) => {
    switch (msg.type) {
      case 'LIVE_SET_INFO':
        S.set = msg;
        if (msg.song) S.song = msg.song;
        renderGrid();
        renderMixer();
        renderTrackSelect();
        renderSong();
        break;
      case 'LIVE_SONG_INFO':
        S.song = msg.song || {};
        renderSong();
        break;
      case 'LIVE_SONG_CHANGED':
        S.song[msg.prop] = msg.value;
        renderSong();
        break;
      case 'LIVE_TRACK_CHANGED':
        onTrackChanged(msg);
        break;
      case 'LIVE_SET_CHANGED':
        log(`Live set changed (${msg.what}), refreshing`);
        refresh();
        break;
      case 'LIVE_DEVICES':
        if (refKey(msg.track) === refKey(S.devTrack)) { S.devices = msg.devices || []; renderDeviceList(); }
        break;
      case 'LIVE_DEVICE_INFO':
        if (refKey(msg.track) === refKey(S.devTrack) && msg.device === S.device) { S.deviceInfo = msg; renderParams(); }
        break;
      case 'LIVE_PARAM_CHANGED':
        onParamChanged(msg);
        break;
      case 'LIVE_DEVICE_CHANGED':
        onDeviceChanged(msg);
        break;
      case 'LIVE_OBSERVING':
        S.observing = msg;
        $('observer-info').textContent = `observers ${msg.observers}/${msg.maxObservers || '∞'}${msg.truncated ? ' (truncated)' : ''}`;
        if (msg.evicted && msg.evicted.length) log(`observers evicted (m4l.maxObservers): ${msg.evicted.join(', ')}`);
        break;
      case 'M4L_HELLO':
        refresh();
        break;
      default:
    }
  });

  // ---------------------------------------------------------------- song
  document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => {
    send({ type: 'LIVE_SONG_ACTION', action: b.dataset.action });
  }));
  document.querySelectorAll('[data-song]').forEach((b) => b.addEventListener('click', () => {
    send({ type: 'LIVE_SET_SONG', prop: b.dataset.song, value: S.song[b.dataset.song] ? 0 : 1 });
  }));
  for (const id of ['loop_start', 'loop_length', 'signature_numerator', 'signature_denominator', 'clip_trigger_quantization']) {
    $(id).addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v)) send({ type: 'LIVE_SET_SONG', prop: id, value: v });
    });
  }
  trackDragging($('groove_amount'));
  $('groove_amount').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('groove-val').textContent = `${Math.round(v * 100)}%`;
    mixerSend('groove', () => send({ type: 'LIVE_SET_SONG', prop: 'groove_amount', value: v }));
  });

  function renderSong() {
    const s = S.song || {};
    document.querySelectorAll('[data-song]').forEach((b) => b.classList.toggle('on', !!s[b.dataset.song]));
    for (const id of ['loop_start', 'loop_length', 'signature_numerator', 'signature_denominator', 'clip_trigger_quantization']) {
      if (document.activeElement !== $(id) && s[id] !== undefined && s[id] !== null) $(id).value = s[id];
    }
    if (active !== $('groove_amount') && typeof s.groove_amount === 'number') {
      $('groove_amount').value = s.groove_amount;
      $('groove-val').textContent = `${Math.round(s.groove_amount * 100)}%`;
    }
    $('song-time').textContent = typeof s.current_song_time === 'number' ? s.current_song_time.toFixed(2) : '-';
    // Live's own view, for comparison with the Link header (Link is the source of truth).
    $('live-tempo').textContent = typeof s.tempo === 'number' ? `${s.tempo.toFixed(2)} / ${s.is_playing ? 'playing' : 'stopped'}` : '-';
    document.querySelector('[data-action="undo"]').classList.toggle('on', !!s.can_undo);
    document.querySelector('[data-action="redo"]').classList.toggle('on', !!s.can_redo);
    document.querySelector('[data-action="back_to_arranger"]').classList.toggle('on', !!s.back_to_arranger);
    document.querySelector('[data-action="capture_midi"]').classList.toggle('on', !!s.can_capture_midi);
  }

  // ---------------------------------------------------------------- session grid
  $('stop-all').addEventListener('click', () => send({ type: 'LIVE_STOP_ALL' }));

  function renderGrid() {
    const root = $('grid');
    root.replaceChildren();
    const tracks = (S.set && S.set.tracks) || [];
    const scenes = (S.set && S.set.scenes) || [];
    const table = el('table', 'border-separate border-spacing-1');
    const head = el('tr');
    head.appendChild(el('th'));
    tracks.forEach((t, ti) => {
      const th = el('th', 'text-left font-normal');
      const b = el('button', 'clip track-head', t.name);
      b.style.borderTopColor = colorOf(t.color);
      b.title = 'Stop track clips';
      b.dataset.needs = 'syncLiveControl';
      b.addEventListener('click', () => send({ type: 'LIVE_STOP_TRACK', track: ti }));
      th.appendChild(b);
      head.appendChild(th);
    });
    table.appendChild(head);
    scenes.forEach((name, si) => {
      const tr = el('tr');
      const td0 = el('td');
      const sb = el('button', 'clip scene', `▶ ${name || si + 1}`);
      sb.dataset.needs = 'syncLiveControl';
      sb.addEventListener('click', () => send({ type: 'LIVE_FIRE_SCENE', scene: si }));
      td0.appendChild(sb);
      tr.appendChild(td0);
      tracks.forEach((t, ti) => {
        const td = el('td');
        const slot = (t.slots && t.slots[si]) || { hasClip: !!(t.clips && t.clips[si]) };
        const b = el('button', 'clip' + (slot.hasClip ? ' has' : ''), slot.hasClip ? (slot.name || '▶') : '■');
        b.id = `slot-${ti}-${si}`;
        if (slot.hasClip && slot.color !== undefined) b.style.background = colorOf(slot.color) + '55';
        b.dataset.needs = 'syncLiveControl';
        b.title = slot.hasClip ? 'Fire clip (shift: stop slot)' : 'Stop track (empty slot)';
        b.addEventListener('click', (e) => send(e.shiftKey ? { type: 'LIVE_STOP_CLIP', track: ti, scene: si } : { type: 'LIVE_FIRE_CLIP', track: ti, scene: si }));
        td.appendChild(b);
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    root.appendChild(table);
    tracks.forEach((t, ti) => markPlaying(ti));
    app.applyPermissionLocks();
  }

  function markPlaying(ti) {
    const t = S.set && S.set.tracks[ti];
    if (!t) return;
    const n = (S.set.scenes || []).length;
    for (let si = 0; si < n; si++) {
      const b = $(`slot-${ti}-${si}`);
      if (!b) continue;
      b.classList.toggle('playing', t.playingSlot === si);
      b.classList.toggle('fired', t.firedSlot === si && t.playingSlot !== si);
    }
  }

  // ---------------------------------------------------------------- mixer
  function slider(param, onInput, vertical) {
    const wrap = el('div', 'flex flex-col items-center gap-0.5');
    const input = el('input', vertical ? 'vslider' : 'w-full');
    input.type = 'range';
    input.min = 0;
    input.max = 1;
    input.step = 0.001;
    input.value = param ? param.normalized : 0;
    input.dataset.needs = 'syncLiveControl';
    const disp = el('div', 'text-[10px] text-slate-400', param ? param.display || param.value.toFixed(2) : '-');
    trackDragging(input);
    input.addEventListener('input', () => onInput(Number(input.value)));
    wrap.append(input, disp);
    return { wrap, input, disp };
  }

  const mixerEls = new Map(); // ref -> { volume, panning, sends[], mute, solo, arm, name }
  function renderMixer() {
    const root = $('mixer');
    root.replaceChildren();
    mixerEls.clear();
    for (const t of allTracks()) {
      if (!t.mixer) continue;
      const strip = el('div', 'strip');
      const name = el('div', 'strip-name', trackLabel(t));
      name.style.borderTopColor = colorOf(t.color);
      strip.appendChild(name);
      const els = { name, sends: [] };
      t.mixer.sends.forEach((sp, i) => {
        strip.appendChild(el('div', 'lbl', `Send ${String.fromCharCode(65 + i)}`));
        const s = slider(sp, (v) => mixerSend(`${t.ref}:send:${i}`, () => send({ type: 'LIVE_SET_MIXER', track: t.ref, param: 'send', send: i, normalized: v })));
        strip.appendChild(s.wrap);
        els.sends.push(s);
      });
      strip.appendChild(el('div', 'lbl', 'Pan'));
      els.panning = slider(t.mixer.panning, (v) => mixerSend(`${t.ref}:pan`, () => send({ type: 'LIVE_SET_MIXER', track: t.ref, param: 'panning', normalized: v })));
      strip.appendChild(els.panning.wrap);
      els.volume = slider(t.mixer.volume, (v) => mixerSend(`${t.ref}:vol`, () => send({ type: 'LIVE_SET_MIXER', track: t.ref, param: 'volume', normalized: v })), true);
      strip.appendChild(els.volume.wrap);
      const btns = el('div', 'flex gap-1 mt-1');
      for (const prop of ['mute', 'solo', 'arm']) {
        if (t[prop] === undefined) continue;
        const b = el('button', 'btn btn-xs' + (prop === 'arm' ? ' rec' : ''), prop === 'mute' ? 'M' : prop === 'solo' ? 'S' : '●');
        b.dataset.needs = 'syncLiveControl';
        b.classList.toggle('on', prop === 'mute' ? !t.mute : !!t[prop]);
        b.title = prop === 'mute' ? 'Track activator (lit = audible)' : prop;
        b.addEventListener('click', () => {
          const cur = findTrack(t.ref);
          send({ type: 'LIVE_SET_TRACK', track: t.ref, prop, value: !(cur && cur[prop]) });
        });
        btns.appendChild(b);
        els[prop] = b;
      }
      strip.appendChild(btns);
      mixerEls.set(refKey(t.ref), els);
      root.appendChild(strip);
    }
    if (!root.children.length) root.textContent = '-';
    app.applyPermissionLocks();
  }

  function setSlider(s, msg) {
    if (!s || active === s.input) return;
    s.input.value = msg.normalized;
    s.disp.textContent = msg.display || Number(msg.value).toFixed(2);
  }

  function onTrackChanged(msg) {
    const t = findTrack(msg.track);
    if (!t) return;
    const els = mixerEls.get(refKey(msg.track));
    switch (msg.prop) {
      case 'playing_slot_index': t.playingSlot = msg.value; markPlaying(msg.track); break;
      case 'fired_slot_index': t.firedSlot = msg.value; markPlaying(msg.track); break;
      case 'volume': if (t.mixer) Object.assign(t.mixer.volume, msg); setSlider(els && els.volume, msg); break;
      case 'panning': if (t.mixer) Object.assign(t.mixer.panning, msg); setSlider(els && els.panning, msg); break;
      case 'send': setSlider(els && els.sends[msg.send], msg); break;
      case 'mute': case 'solo': case 'arm':
        t[msg.prop] = !!msg.value;
        if (els && els[msg.prop]) els[msg.prop].classList.toggle('on', msg.prop === 'mute' ? !msg.value : !!msg.value);
        break;
      case 'name': case 'color':
        t[msg.prop] = msg.value;
        renderGrid();
        renderMixer();
        renderTrackSelect();
        break;
      default:
    }
  }

  // ---------------------------------------------------------------- devices / parameters
  function renderTrackSelect() {
    const sel = $('dev-track');
    const prev = sel.value;
    sel.replaceChildren(new Option('— pick a track —', ''));
    for (const t of allTracks()) sel.add(new Option(trackLabel(t), refKey(t.ref)));
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '';
  }
  const parseRef = (v) => (/^\d+$/.test(v) ? Number(v) : v);
  $('dev-track').addEventListener('change', (e) => {
    if (S.device !== null && S.devTrack !== null) send({ type: 'LIVE_UNOBSERVE', scope: 'device', track: S.devTrack, device: S.device });
    S.devTrack = e.target.value === '' ? null : parseRef(e.target.value);
    S.device = null;
    S.deviceInfo = null;
    S.devices = [];
    renderDeviceList();
    renderParams();
    if (S.devTrack !== null) send({ type: 'LIVE_GET_DEVICES', track: S.devTrack });
  });

  function renderDeviceList() {
    const root = $('dev-list');
    root.replaceChildren(...S.devices.map((d) => {
      const g = el('div', 'flex');
      const b = el('button', 'btn' + (d.index === S.device ? ' on' : ''), `${d.name}`);
      b.title = `${d.classDisplayName || d.className} · ${d.numParams} parameters`;
      b.addEventListener('click', () => selectDevice(d.index));
      const pwr = el('button', 'btn btn-xs' + (d.isActive ? ' on' : ''), '⏻');
      pwr.title = 'Device on/off';
      pwr.dataset.needs = 'syncDeviceParameterChange';
      pwr.addEventListener('click', () => send({ type: 'LIVE_SET_DEVICE_ACTIVE', track: S.devTrack, device: d.index, active: !d.isActive }));
      g.append(b, pwr);
      return g;
    }));
    if (S.devTrack !== null && !S.devices.length) root.textContent = 'No devices on this track.';
    app.applyPermissionLocks();
  }

  function selectDevice(index) {
    if (S.device !== null && S.device !== index) send({ type: 'LIVE_UNOBSERVE', scope: 'device', track: S.devTrack, device: S.device });
    S.device = index;
    renderDeviceList();
    send({ type: 'LIVE_GET_DEVICE', track: S.devTrack, device: index });
    send({ type: 'LIVE_OBSERVE', scope: 'device', track: S.devTrack, device: index });
  }

  const paramEls = new Map(); // param index -> { input, disp, p }
  function renderParams() {
    const root = $('params');
    root.replaceChildren();
    paramEls.clear();
    const d = S.deviceInfo;
    $('dev-head').textContent = d ? `${d.name} · ${d.classDisplayName || d.className} · ${d.parameters.length} parameters${d.truncated ? ' (capped by m4l.maxParams)' : ''}` : '';
    if (!d) return;
    for (const p of d.parameters) {
      const card = el('div', 'box param' + (p.isEnabled === false ? ' opacity-50' : ''));
      const top = el('div', 'flex justify-between items-center gap-1');
      top.appendChild(el('div', 'text-[11px] text-slate-200 truncate', p.name));
      const learn = el('button', 'learn', 'LEARN');
      learn.addEventListener('click', () => startLearn(p));
      top.appendChild(learn);
      card.appendChild(top);
      let input;
      if (p.isQuantized && p.valueItems && p.valueItems.length) {
        input = el('select', 'inp');
        p.valueItems.forEach((item, i) => input.add(new Option(item, String(p.min + i))));
        input.value = String(Math.round(p.value));
        input.addEventListener('change', () => send({ type: 'LIVE_SET_PARAM', track: d.track, device: d.device, param: p.index, real: Number(input.value) }));
      } else {
        input = el('input', 'w-full');
        input.type = 'range';
        input.min = 0;
        input.max = 1;
        input.step = p.isQuantized ? 1 / Math.max(1, p.max - p.min) : 0.001;
        input.value = p.normalized;
        trackDragging(input);
        input.addEventListener('input', () => {
          const v = Number(input.value);
          paramSend(`${d.track}:${d.device}:${p.index}`, () => send({ type: 'LIVE_SET_PARAM', track: d.track, device: d.device, param: p.index, value: v }));
        });
        input.addEventListener('dblclick', () => {
          if (typeof p.defaultValue === 'number') send({ type: 'LIVE_SET_PARAM', track: d.track, device: d.device, param: p.index, real: p.defaultValue });
        });
        input.title = 'Double-click: default value';
      }
      input.dataset.needs = 'syncDeviceParameterChange';
      const disp = el('div', 'text-[10px] text-slate-400 flex justify-between');
      disp.append(el('span', '', p.display || String(p.value)), el('span', 'text-slate-600', `${p.min}…${p.max}`));
      card.append(input, disp);
      root.appendChild(card);
      paramEls.set(p.index, { input, disp: disp.firstChild, p });
    }
    app.applyPermissionLocks();
  }

  function onParamChanged(msg) {
    if (!S.deviceInfo || refKey(msg.track) !== refKey(S.deviceInfo.track) || msg.device !== S.deviceInfo.device) return;
    const pe = paramEls.get(msg.param);
    if (!pe) return;
    Object.assign(pe.p, { value: msg.value, normalized: msg.normalized, display: msg.display });
    pe.disp.textContent = msg.display || String(msg.value);
    if (active === pe.input) return;
    if (pe.input.tagName === 'SELECT') pe.input.value = String(Math.round(msg.value));
    else pe.input.value = msg.normalized;
  }

  function onDeviceChanged(msg) {
    if (refKey(msg.track) !== refKey(S.devTrack)) return;
    const d = S.devices.find((x) => x.index === msg.device);
    if (!d) return;
    if (msg.prop === 'is_active') d.isActive = !!msg.value;
    if (msg.prop === 'name') d.name = msg.value;
    renderDeviceList();
  }

  // ---------------------------------------------------------------- MIDI learn (CC -> parameter)
  function saveMidiMap() {
    localStorage[MIDIMAP_KEY] = JSON.stringify(midiMap);
    renderMidiMap();
  }
  function startLearn(p) {
    const d = S.deviceInfo;
    learnTarget = { track: d.track, device: d.device, param: p.index, label: `${trackLabel(findTrack(d.track) || { name: String(d.track) })} / ${d.name} / ${p.name}` };
    $('learn-status').textContent = `Learning: move a CC for ${learnTarget.label}`;
    $('learn-cancel').classList.remove('hidden');
  }
  $('learn-cancel').addEventListener('click', () => {
    learnTarget = null;
    $('learn-status').textContent = '';
    $('learn-cancel').classList.add('hidden');
  });
  function renderMidiMap() {
    const root = $('midimap');
    root.replaceChildren(...midiMap.map((m, i) => {
      const row = el('div', 'box flex justify-between items-center gap-2');
      row.appendChild(el('span', '', `CC ${m.cc} ch ${m.channel} → ${m.label}`));
      const del = el('button', 'btn btn-xs', '✕');
      del.addEventListener('click', () => { midiMap.splice(i, 1); saveMidiMap(); });
      row.appendChild(del);
      return row;
    }));
    if (!midiMap.length) root.textContent = 'No mappings.';
  }
  renderMidiMap();

  connector.onMidiMessage = (_appName, ev) => {
    if (!ev || ev.kind !== 'cc') return;
    const channel = Number(ev.channel) || 1;
    if (learnTarget) {
      midiMap = midiMap.filter((m) => !(m.cc === ev.cc && m.channel === channel));
      midiMap.push({ cc: ev.cc, channel, ...learnTarget });
      log(`learned CC ${ev.cc} ch ${channel} → ${learnTarget.label}`);
      learnTarget = null;
      $('learn-status').textContent = '';
      $('learn-cancel').classList.add('hidden');
      saveMidiMap();
      return;
    }
    for (const m of midiMap) {
      if (m.cc !== ev.cc || m.channel !== channel) continue;
      const v = Math.max(0, Math.min(127, Number(ev.value) || 0)) / 127;
      paramSend(`${m.track}:${m.device}:${m.param}`, () => send({ type: 'LIVE_SET_PARAM', track: m.track, device: m.device, param: m.param, value: v }));
    }
  };

  window.jamConnectLiveControl = { app, state: S };
})();
