/* JamConnect Link web app: JamConnect sessions on top of Ableton Link. */
(async () => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const SETTINGS_KEY = 'jclSettings';

  // ---------------------------------------------------------------- configuration
  // jamconnect.config.json is served by the bridge (with runtime info such as the real
  // port) or deployed next to the app. ?config=<url> points at another file.
  let configError = '';
  try {
    await JamConnector.loadConfig(params.get('config') || 'jamconnect.config.json');
  } catch (err) {
    configError = `Config not loaded (${err.message}); using library fallbacks.`;
  }
  // User overrides from the settings panel (signaling server, ICE/TURN servers, bridge URL).
  const savedSettings = (() => { try { return JSON.parse(localStorage[SETTINGS_KEY] || '{}'); } catch (_) { return {}; } })();
  const config = JamConnector.configure(jamMergeConfig(JamConnector.config, savedSettings));
  const defaultBridge = params.get('bridge') || jamBridgeUrl(config);

  // Tempo always comes from the Link session or the user, never from a default.
  const connector = new JamConnector(config.client.appName, Tone, { adoptTransportTempo: false });
  let liveSet = null;

  // ---------------------------------------------------------------- audio
  const click = new Tone.MembraneSynth({ pitchDecay: 0.008, octaves: 2, envelope: { attack: 0.001, decay: 0.08, sustain: 0 } }).toDestination();
  click.volume.value = -8;
  const padSynth = new Tone.PolySynth(Tone.Synth, { envelope: { attack: 0.005, decay: 0.15, sustain: 0.3, release: 0.4 } }).toDestination();
  padSynth.volume.value = -10;

  Tone.Transport.scheduleRepeat((time) => {
    if (!$('metro').checked) return;
    const beat = Math.round(Tone.Transport.getTicksAtTime(time) / Tone.Transport.PPQ);
    const q = connector.linkTimeline.quantum;
    click.triggerAttackRelease(beat % q === 0 ? 'C5' : 'G4', '32n', time);
  }, '4n', 0);

  $('audio-overlay').addEventListener('click', async () => {
    await Tone.start();
    $('audio-overlay').remove();
  });
  document.addEventListener('pointerdown', () => { if (Tone.context.state !== 'running') Tone.start(); }, { once: true });

  // ---------------------------------------------------------------- helpers
  function log(line) {
    const el = $('log');
    el.textContent += `[${new Date().toLocaleTimeString()}] ${line}\n`;
    el.scrollTop = el.scrollHeight;
  }
  function showError(msg) {
    const el = $('conn-error');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }
  function userName() { return $('user-name').value.trim() || 'web-jammer'; }
  async function guarded(btn, fn) {
    showError('');
    btn.disabled = true;
    try { await fn(); } catch (err) { showError(err.message || String(err)); log(`error: ${err.message || err}`); }
    finally { btn.disabled = false; }
  }

  // ---------------------------------------------------------------- inputs
  $('local-url').value = defaultBridge;
  $('host-bridge-url').value = defaultBridge;
  $('local-token').value = config.client.bridgeToken || '';
  $('host-bridge-token').value = config.client.bridgeToken || '';
  if (config.runtime && config.runtime.tokenRequired) {
    $('local-token').placeholder = 'required by this bridge';
    $('host-bridge-token').placeholder = 'required by this bridge';
  }
  $('tempo').min = config.client.tempoMin;
  $('tempo').max = config.client.tempoMax;
  const quantumSel = $('quantum');
  if (![...quantumSel.options].some((o) => Number(o.value) === config.client.quantum)) {
    quantumSel.add(new Option(String(config.client.quantum)));
  }
  quantumSel.value = String(config.client.quantum);
  if (configError) showError(configError);

  // ---------------------------------------------------------------- settings panel
  $('set-bridge-url').value = savedSettings.client && savedSettings.client.bridgeUrl || '';
  $('set-signal').value = JSON.stringify(config.webrtc.signal || {}, null, 1);
  $('set-ice').value = JSON.stringify(config.webrtc.iceServers || [], null, 1);
  $('settings-save').addEventListener('click', () => {
    try {
      const next = {
        client: { bridgeUrl: $('set-bridge-url').value.trim() },
        webrtc: { signal: JSON.parse($('set-signal').value || '{}'), iceServers: JSON.parse($('set-ice').value || '[]') }
      };
      localStorage[SETTINGS_KEY] = JSON.stringify(next);
      location.reload();
    } catch (err) {
      showError(`Settings: ${err.message}`);
    }
  });
  $('settings-reset').addEventListener('click', () => { delete localStorage[SETTINGS_KEY]; location.reload(); });
  $('user-name').value = localStorage.jclName || `jammer-${Math.floor(Math.random() * 900 + 100)}`;
  $('user-name').addEventListener('change', () => { localStorage.jclName = $('user-name').value; });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  function selectTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  }

  // ---------------------------------------------------------------- connect
  $('local-connect').addEventListener('click', (e) => guarded(e.target, async () => {
    const url = $('local-url').value.trim();
    await connector.joinLocalBridge(url, $('local-token').value.trim(), userName());
    log(`joined Link bridge ${url}`);
  }));

  $('host-start').addEventListener('click', (e) => guarded(e.target, async () => {
    const info = await connector.createHostSession();
    $('host-info').classList.remove('hidden');
    $('host-session').textContent = info.sessionId;
    $('host-token').textContent = info.authToken;
    $('host-invite').value = info.inviteUrl;
    $('host-qr').innerHTML = '';
    if (typeof QRCode !== 'undefined') new QRCode($('host-qr'), { text: info.inviteUrl, width: 160, height: 160 });
    log(`hosting ${info.sessionId}`);
    if ($('host-attach').checked) {
      const url = $('host-bridge-url').value.trim();
      await connector.attachLocalBridge(url, $('host-bridge-token').value.trim());
      log(`bridge attached: ${url}`);
    }
  }));

  $('host-copy').addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText($('host-invite').value));

  document.querySelectorAll('[data-perm]').forEach((el) => el.addEventListener('change', () => {
    connector.sendPermissionsUpdate({ [el.dataset.perm]: el.checked });
  }));

  $('join-invite').addEventListener('input', (e) => {
    const parsed = JamConnector.parseInviteInput(e.target.value);
    if (parsed) { $('join-invite').value = parsed.sessionId; $('join-token').value = parsed.authToken; }
  });

  $('join-connect').addEventListener('click', (e) => guarded(e.target, async () => {
    await connector.joinHost($('join-invite').value, $('join-token').value, userName());
    log(`joined ${connector.sessionId}`);
  }));

  $('disconnect-btn').addEventListener('click', () => {
    connector.disconnect();
    $('host-info').classList.add('hidden');
    log('disconnected');
  });

  // Invite links open the join tab and join the host right away.
  if (params.get('session') && params.get('token')) {
    selectTab('join');
    $('join-invite').value = params.get('session');
    $('join-token').value = params.get('token');
    setTimeout(() => $('join-connect').click(), 0);
  }

  // ---------------------------------------------------------------- connector events
  connector.onConnectionStateChange = (s) => {
    $('status-text').textContent = (s.message || s.status).toUpperCase();
    const dot = $('status-dot');
    dot.className = 'w-2.5 h-2.5 rounded-full ' + ({
      hosting: 'bg-emerald-400 animate-pulse', connected: 'bg-emerald-400 animate-pulse',
      connecting: 'bg-amber-400 animate-ping', error: 'bg-rose-500'
    }[s.status] || 'bg-slate-500');
    $('disconnect-btn').classList.toggle('hidden', !['hosting', 'connected', 'connecting'].includes(s.status));
    renderPeers(s.peers || []);
  };

  connector.onPeerConnected = (_id, peers) => renderPeers(peers);
  connector.onPeerDisconnected = (_id, peers) => renderPeers(peers);

  connector.onBridgeStateChange = (s) => {
    const b = $('bridge-badge');
    b.textContent = `BRIDGE ${s.status.toUpperCase()}`;
    b.className = 'px-2 py-0.5 rounded border ' + (s.status === 'connected' ? 'border-emerald-600 text-emerald-400' : 'border-slate-700 text-slate-500');
    log(s.message);
  };

  function renderPeers(peers) {
    const list = $('peer-list');
    list.replaceChildren();
    for (const p of peers) {
      const chip = document.createElement('span');
      chip.className = 'text-[11px] bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 px-2 py-0.5 rounded';
      chip.textContent = `${p.name}${p.rtt ? ` (${p.rtt}ms)` : ''}`;
      list.appendChild(chip);
    }
    $('peers-badge').textContent = `${peers.length} JAMMER${peers.length === 1 ? '' : 'S'}`;
  }

  // ---------------------------------------------------------------- Link controls
  $('play-btn').addEventListener('click', async () => {
    await Tone.start();
    const st = connector.getLinkState();
    if (st.tempo === null && !st.upstream) { showError('Enter a tempo first.'); return; }
    if (!connector.setLinkPlaying(!st.isPlaying)) showError('Connect to a bridge or session first.');
  });

  function sendTempo(bpm) {
    if (!(bpm >= config.client.tempoMin && bpm <= config.client.tempoMax)) return;
    if (!connector.setLinkTempo(bpm)) showError('Connect to a bridge or session first.');
  }
  $('tempo').addEventListener('change', (e) => sendTempo(parseFloat(e.target.value)));
  $('tempo').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
    const current = connector.getLinkState().tempo;
    if (current === null) return;
    sendTempo(Math.round(current) + Number(b.dataset.nudge));
  }));
  $('quantum').addEventListener('change', (e) => { connector.setLinkQuantum(Number(e.target.value)); buildPhaseBar(); });

  function buildPhaseBar() {
    const q = Math.max(1, Math.round(connector.linkTimeline.quantum));
    const bar = $('phase-bar');
    bar.style.gridTemplateColumns = `repeat(${q}, minmax(0, 1fr))`;
    bar.replaceChildren(...Array.from({ length: q }, (_, i) => {
      const c = document.createElement('div');
      c.className = 'phase-cell' + (i === 0 ? ' first' : '');
      return c;
    }));
  }
  buildPhaseBar();

  function frame() {
    const st = connector.getLinkState();
    const has = !!st.source && st.tempo !== null;
    if (document.activeElement !== $('tempo')) $('tempo').value = st.tempo !== null ? st.tempo.toFixed(2) : '';
    const cells = $('phase-bar').children;
    const ph = Math.floor(st.phase);
    for (let i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('on', has && i === ph);
      cells[i].classList.toggle('past', has && i < ph);
    }
    $('beat').textContent = has ? st.beat.toFixed(2) : '—';
    if (has && st.isPlaying && st.songBeat >= 0) {
      const q = Math.max(1, Math.round(st.quantum));
      const sb = Math.floor(st.songBeat);
      $('songpos').textContent = `${Math.floor(sb / q) + 1}.${(sb % q) + 1}`;
    } else {
      $('songpos').textContent = has && st.isPlaying ? 'count-in' : '—';
    }
    $('link-peers').textContent = st.source === 'bridge' ? String(st.numPeers) : '—';
    $('link-source').textContent = st.source ? (st.source === 'bridge' ? 'Ableton Link' : 'JamConnect') : '—';
    $('clock-offset').textContent = st.upstream ? `${(st.clockOffsetUs / 1000).toFixed(1)} ms${st.clockReady ? '' : '…'}` : (has ? 'master' : '—');
    const pb = $('play-btn');
    pb.textContent = st.isPlaying ? '■ STOP' : '▶ PLAY';
    pb.classList.toggle('playing', st.isPlaying);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  let lastSource = null, lastPlaying = null;
  connector.onLinkStateUpdated = (st) => {
    if (st.source !== lastSource) { log(`timeline source: ${st.source || 'none'}`); lastSource = st.source; }
    if (st.isPlaying !== lastPlaying) { log(st.isPlaying ? 'Link transport PLAY' : 'Link transport STOP'); lastPlaying = st.isPlaying; }
    if (Math.round(st.quantum) !== $('phase-bar').children.length) buildPhaseBar();
  };

  // ---------------------------------------------------------------- pads / MIDI
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`;
  const padEls = [];
  function buildPads() {
    const base = Number($('pad-octave').value);
    const pads = $('pads');
    pads.replaceChildren();
    padEls.length = 0;
    for (let i = 0; i < 16; i++) {
      const note = base + i;
      const el = document.createElement('button');
      el.className = 'pad';
      el.textContent = noteName(note);
      el.dataset.note = note;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); padOn(note, el); });
      el.addEventListener('pointerup', () => padOff(note, el));
      el.addEventListener('pointerleave', () => { if (el.classList.contains('hit')) padOff(note, el); });
      pads.appendChild(el);
      padEls.push(el);
    }
  }
  $('pad-octave').addEventListener('change', buildPads);
  buildPads();

  function padOn(note, el) {
    Tone.start();
    el.classList.add('hit');
    padSynth.triggerAttack(Tone.Frequency(note, 'midi').toFrequency());
    connector.sendMidiEvent({ kind: 'noteon', note, velocity: 100, channel: 1 });
  }
  function padOff(note, el) {
    el.classList.remove('hit');
    padSynth.triggerRelease(Tone.Frequency(note, 'midi').toFrequency());
    connector.sendMidiEvent({ kind: 'noteoff', note, velocity: 0, channel: 1 });
  }

  connector.onMidiMessage = (appName, ev) => {
    if (!ev || typeof ev.note !== 'number') return;
    const el = padEls.find((p) => Number(p.dataset.note) === ev.note);
    const freq = Tone.Frequency(ev.note, 'midi').toFrequency();
    if (ev.kind === 'noteon' && ev.velocity > 0) {
      if (el) el.classList.add('remote');
      if ($('hear-remote').checked) padSynth.triggerAttack(freq, undefined, ev.velocity / 127);
    } else if (ev.kind === 'noteoff' || ev.velocity === 0) {
      if (el) el.classList.remove('remote');
      padSynth.triggerRelease(freq);
    }
  };

  // ---------------------------------------------------------------- Ableton Live control (M4L)
  $('live-refresh').addEventListener('click', () => connector.sendRelayMessage({ type: 'LIVE_GET_SET' }));
  $('live-stop-all').addEventListener('click', () => connector.sendRelayMessage({ type: 'LIVE_STOP_ALL' }));

  connector.onRelayMessage = (msg) => {
    if (msg.type === 'LIVE_SET_INFO') {
      liveSet = msg;
      renderLiveSet();
      log(`Live set: ${(msg.tracks || []).length} tracks, ${(msg.scenes || []).length} scenes`);
    } else if (msg.type === 'LIVE_ERROR') {
      log(`Live: ${msg.message}`);
    }
  };

  function renderLiveSet() {
    const root = $('live-set');
    root.replaceChildren();
    if (!liveSet) return;
    const tracks = liveSet.tracks || [];
    const scenes = liveSet.scenes || [];
    const wrap = document.createElement('div');
    wrap.className = 'overflow-x-auto';
    const table = document.createElement('table');
    table.className = 'border-separate border-spacing-1';

    const head = document.createElement('tr');
    head.appendChild(document.createElement('th'));
    tracks.forEach((t, ti) => {
      const th = document.createElement('th');
      th.className = 'text-[10px] text-slate-300 font-normal text-left';
      const stop = document.createElement('button');
      stop.className = 'clip';
      stop.textContent = `■ ${t.name}`;
      stop.title = 'Stop track';
      stop.addEventListener('click', () => connector.sendRelayMessage({ type: 'LIVE_STOP_TRACK', track: ti }));
      th.appendChild(stop);
      head.appendChild(th);
    });
    table.appendChild(head);

    scenes.forEach((s, si) => {
      const tr = document.createElement('tr');
      const sceneBtn = document.createElement('button');
      sceneBtn.className = 'clip has';
      sceneBtn.textContent = `▶ ${s || si + 1}`;
      sceneBtn.addEventListener('click', () => connector.sendRelayMessage({ type: 'LIVE_FIRE_SCENE', scene: si }));
      const td0 = document.createElement('td');
      td0.appendChild(sceneBtn);
      tr.appendChild(td0);
      tracks.forEach((t, ti) => {
        const td = document.createElement('td');
        const b = document.createElement('button');
        const hasClip = !!(t.clips && t.clips[si]);
        b.className = 'clip' + (hasClip ? ' has' : '');
        b.textContent = hasClip ? '▶' : '·';
        b.addEventListener('click', () => connector.sendRelayMessage({ type: 'LIVE_FIRE_CLIP', track: ti, scene: si }));
        td.appendChild(b);
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    root.appendChild(wrap);
  }

  window.jamConnectLink = { connector };
  log('ready');
})();
