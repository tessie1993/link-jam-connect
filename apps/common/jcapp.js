/* Shared code for the JamConnect apps in apps/ (plain browser JS, no build step).
 *
 * Every app talks to Ableton only through jamlink-bridge:
 *   - LOCAL (default): joinLocalBridge() to the bridge that served the page (or the configured URL),
 *     retried every client.bridgeRetryMs while it is unreachable;
 *   - WEBRTC HOST: a PeerJS session with the bridge attached (attachLocalBridge), relaying to guests;
 *   - WEBRTC JOIN: a remote guest of such a host (reaches Ableton through the host's bridge).
 * Injects the connection panel (#jc-connection), the Link header (#jc-link) and the status badges
 * (#jc-status), and returns helpers for the app.
 */
(function () {
  const SETTINGS_KEY = 'jclSettings';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /** Keyed leading + trailing throttle: at most one call per key per interval, newest args win. */
  function throttle(intervalMs) {
    const state = new Map();
    return (key, fn) => {
      const s = state.get(key) || { last: -Infinity, timer: null, fn: null };
      state.set(key, s);
      s.fn = fn;
      const wait = s.last + (intervalMs || 0) - performance.now();
      if (wait <= 0 && !s.timer) {
        s.last = performance.now();
        s.fn();
        s.fn = null;
      } else if (!s.timer) {
        s.timer = setTimeout(() => {
          s.timer = null;
          s.last = performance.now();
          if (s.fn) { const f = s.fn; s.fn = null; f(); }
        }, Math.max(0, wait));
      }
    };
  }

  const PANEL_HTML = `
    <div class="flex gap-1 mb-3" role="tablist">
      <button class="tab active" data-tab="local">LOCAL BRIDGE</button>
      <button class="tab" data-tab="host">WEBRTC HOST</button>
      <button class="tab" data-tab="join">WEBRTC JOIN</button>
    </div>
    <div class="tabpane" data-pane="local">
      <p class="hint">Talks to Ableton through <b>jamlink-bridge</b>: Link for tempo / transport, the Max for Live device for the Live API. Connects automatically.</p>
      <label class="lbl">Bridge URL</label>
      <input id="jc-local-url" class="inp" />
      <label class="lbl">Token (if bridge uses --token)</label>
      <input id="jc-local-token" class="inp" placeholder="optional" />
      <button id="jc-local-connect" class="btn-primary mt-3 w-full">CONNECT TO BRIDGE</button>
    </div>
    <div class="tabpane hidden" data-pane="host">
      <p class="hint">Host a session for remote users. This page attaches the local bridge and relays it, so guests reach Ableton only through it.</p>
      <label class="lbl">Bridge URL</label>
      <input id="jc-host-bridge-url" class="inp" />
      <label class="lbl">Bridge token</label>
      <input id="jc-host-bridge-token" class="inp" placeholder="optional" />
      <button id="jc-host-start" class="btn-primary mt-3 w-full">CREATE SESSION</button>
      <div id="jc-host-info" class="hidden mt-3 flex flex-col items-center gap-2">
        <div class="bg-white p-2 rounded-lg"><div id="jc-host-qr"></div></div>
        <div class="grid grid-cols-2 gap-2 w-full">
          <div class="box"><div class="lbl">Session</div><div id="jc-host-session" class="text-emerald-400 font-bold select-all">-</div></div>
          <div class="box"><div class="lbl">Token</div><div id="jc-host-token" class="text-amber-400 font-bold select-all">-</div></div>
        </div>
        <div class="flex gap-1 w-full">
          <input id="jc-host-invite" readonly class="inp flex-1 text-[10px]" />
          <button id="jc-host-copy" class="btn">COPY</button>
        </div>
        <div class="box w-full">
          <div class="lbl mb-1">Guest permissions</div>
          <div class="flex flex-wrap gap-3 text-xs">
            <label><input type="checkbox" data-perm="syncMasterSettings" class="accent-emerald-500"> Tempo</label>
            <label><input type="checkbox" data-perm="syncTransport" class="accent-emerald-500"> Play/Stop</label>
            <label><input type="checkbox" data-perm="syncMidi" class="accent-emerald-500"> MIDI</label>
            <label><input type="checkbox" data-perm="syncDeviceParameterChange" class="accent-emerald-500"> Params / macros</label>
            <label><input type="checkbox" data-perm="syncLiveControl" class="accent-emerald-500"> Live control</label>
          </div>
        </div>
      </div>
    </div>
    <div class="tabpane hidden" data-pane="join">
      <p class="hint">Join a host from anywhere. You reach Ableton through the host's bridge, within the permissions it grants.</p>
      <label class="lbl">Invite link or Session ID</label>
      <input id="jc-join-invite" class="inp" placeholder="JAM-ABCD or paste link" />
      <label class="lbl">Auth token</label>
      <input id="jc-join-token" class="inp" placeholder="auto-filled from link" />
      <button id="jc-join-connect" class="btn-primary mt-3 w-full">JOIN</button>
    </div>
    <div id="jc-retry" class="hidden mt-3 text-xs text-amber-200 bg-amber-950/60 border border-amber-800 rounded px-2 py-1.5">
      <div id="jc-retry-text"></div>
      <button id="jc-retry-now" class="btn mt-1">RETRY NOW</button>
    </div>
    <details class="mt-4 box">
      <summary class="text-[11px] text-slate-400 cursor-pointer">SETTINGS (bridge URL, signaling server, ICE / TURN)</summary>
      <p class="hint mt-2">Defaults come from <code>jamconnect.config.json</code>. Values saved here override it in this browser (shared with the main web app).</p>
      <label class="lbl">Bridge URL override (empty = from config)</label>
      <input id="jc-set-bridge-url" class="inp" placeholder="ws://host:port" />
      <label class="lbl">PeerJS signaling options (JSON)</label>
      <textarea id="jc-set-signal" rows="3" class="inp"></textarea>
      <label class="lbl">ICE servers (JSON array)</label>
      <textarea id="jc-set-ice" rows="3" class="inp"></textarea>
      <div class="flex gap-2 mt-2">
        <button id="jc-settings-save" class="btn">SAVE &amp; RELOAD</button>
        <button id="jc-settings-reset" class="btn">RESET</button>
      </div>
    </details>
    <label class="lbl mt-4">Your name</label>
    <input id="jc-user-name" class="inp" />
    <div id="jc-conn-error" class="hidden mt-3 text-xs text-rose-300 bg-rose-950/60 border border-rose-800 rounded px-2 py-1.5"></div>
    <div id="jc-peer-list" class="mt-3 flex flex-wrap gap-1.5"></div>
    <div class="lbl mt-3">Log</div>
    <div id="jc-log" class="h-28 overflow-y-auto text-[11px] text-slate-400 whitespace-pre-wrap box"></div>`;

  const LINK_HTML = `
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div class="lbl">Link tempo</div>
        <div class="flex items-center gap-2">
          <button class="btn" data-nudge="-1">-</button>
          <input id="jc-tempo" type="number" step="0.01" class="bg-transparent text-4xl font-bold text-amber-400 w-40 outline-none" placeholder="-" />
          <button class="btn" data-nudge="1">+</button>
        </div>
      </div>
      <div class="flex items-end gap-3">
        <div>
          <div class="lbl">Quantum</div>
          <select id="jc-quantum" class="inp w-20"></select>
        </div>
        <button id="jc-play" class="btn-play">PLAY</button>
      </div>
    </div>
    <div id="jc-phase" class="grid gap-1.5 mt-4"></div>
    <div class="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-3 text-xs">
      <div class="box"><div class="lbl">Beat</div><div id="jc-beat" class="text-base">-</div></div>
      <div class="box"><div class="lbl">Bar.Beat</div><div id="jc-songpos" class="text-base">-</div></div>
      <div class="box"><div class="lbl">Phase</div><div id="jc-phase-num" class="text-base">-</div></div>
      <div class="box"><div class="lbl">Link peers</div><div id="jc-link-peers" class="text-base">-</div></div>
      <div class="box"><div class="lbl">Source</div><div id="jc-link-source" class="text-base">-</div></div>
      <div class="box"><div class="lbl">Clock offset</div><div id="jc-clock" class="text-base">-</div></div>
    </div>`;

  const STATUS_HTML = `
    <span id="jc-status-dot" class="w-2.5 h-2.5 rounded-full bg-slate-500"></span>
    <span id="jc-status-text" class="text-xs text-slate-400">OFFLINE</span>
    <span id="jc-bridge-badge" class="px-2 py-0.5 rounded border border-slate-700 text-slate-500 text-xs">BRIDGE -</span>
    <span id="jc-live-badge" class="px-2 py-0.5 rounded border border-slate-700 text-slate-500 text-xs">LIVE DEVICE -</span>
    <span id="jc-peers-badge" class="px-2 py-0.5 rounded border border-slate-700 text-emerald-400 text-xs">0 JAMMERS</span>
    <button id="jc-disconnect" class="hidden px-2.5 py-1 bg-rose-900/80 hover:bg-rose-800 text-rose-100 text-xs font-bold rounded border border-rose-700">DISCONNECT</button>`;

  async function start(opts) {
    const params = new URLSearchParams(location.search);
    // jamconnect.config.json lives at the site root: the bridge publishes it at /jamconnect.config.json
    // (with runtime facts such as the real port), Pages deploys it next to the main app.
    let configError = '';
    try {
      await JamConnector.loadConfig(params.get('config') || '../../jamconnect.config.json');
    } catch (err) {
      configError = `Config not loaded (${err.message}).`;
    }
    const saved = (() => { try { return JSON.parse(localStorage[SETTINGS_KEY] || '{}'); } catch (_) { return {}; } })();
    const config = JamConnector.configure(jamMergeConfig(JamConnector.config, saved));
    const appCfg = (config.client && config.client[opts.appKey]) || {};
    if (!config.client[opts.appKey]) configError += ` client.${opts.appKey} missing in jamconnect.config.json.`;
    const defaultBridge = params.get('bridge') || jamBridgeUrl(config);

    $('jc-connection').innerHTML = PANEL_HTML;
    $('jc-link').innerHTML = LINK_HTML;
    $('jc-status').innerHTML = STATUS_HTML;

    // Tempo always comes from the Link session or the user, never a default.
    const connector = new JamConnector(appCfg.appName || opts.appKey, opts.tone || (typeof Tone !== 'undefined' ? Tone : null),
      { followLink: false, adoptTransportTempo: false });

    const relayHandlers = [];
    const permHandlers = [];
    const connHandlers = [];
    let mode = null;          // 'local' | 'host' | 'join'
    let connecting = false;
    let userStopped = false;
    let retryTimer = null;
    let retryTick = null;

    // ---------------------------------------------------------------- helpers
    function log(line) {
      const box = $('jc-log');
      box.textContent += `[${new Date().toLocaleTimeString()}] ${line}\n`;
      const max = Number(appCfg.logMax) || 0;
      if (max > 0) {
        const lines = box.textContent.split('\n');
        if (lines.length > max) box.textContent = lines.slice(-max).join('\n');
      }
      box.scrollTop = box.scrollHeight;
    }
    function showError(msg) {
      const e = $('jc-conn-error');
      e.textContent = msg || '';
      e.classList.toggle('hidden', !msg);
    }
    function userName() { return $('jc-user-name').value.trim() || opts.appKey; }
    const isGuest = () => connector.transport === 'webrtc' && !connector.isHost && connector.isConnectedToHost;
    const connected = () => connector.isHost ? connector.hasBridge || connector.getConnectedPeersList().length > 0 : connector.isConnectedToHost;

    /** Whether this client may send msg (WebRTC guests are limited by the host's permissions). */
    function can(msg) {
      if (!isGuest()) return true;
      const need = jamRemoteControlPermission(msg);
      return !need || !!connector.permissions[need];
    }

    let reqId = 0;
    function send(msg) {
      if (!connected()) { showError('Not connected to the bridge.'); return false; }
      if (!can(msg)) { log(`${msg.type}: locked by the host`); return false; }
      if (msg.requestId === undefined) msg = { ...msg, requestId: `${opts.appKey}-${++reqId}` };
      connector.sendRelayMessage(msg);
      return msg.requestId;
    }

    function applyPermissionLocks() {
      document.querySelectorAll('[data-needs]').forEach((e) => {
        const locked = isGuest() && !connector.permissions[e.dataset.needs];
        e.disabled = locked;
        e.classList.toggle('locked', locked);
      });
    }

    // ---------------------------------------------------------------- inputs / settings
    $('jc-local-url').value = defaultBridge;
    $('jc-host-bridge-url').value = defaultBridge;
    $('jc-local-token').value = config.client.bridgeToken || '';
    $('jc-host-bridge-token').value = config.client.bridgeToken || '';
    if (config.runtime && config.runtime.tokenRequired) {
      $('jc-local-token').placeholder = 'required by this bridge';
      $('jc-host-bridge-token').placeholder = 'required by this bridge';
    }
    $('jc-set-bridge-url').value = (saved.client && saved.client.bridgeUrl) || '';
    $('jc-set-signal').value = JSON.stringify(config.webrtc.signal || {}, null, 1);
    $('jc-set-ice').value = JSON.stringify(config.webrtc.iceServers || [], null, 1);
    $('jc-settings-save').addEventListener('click', () => {
      try {
        localStorage[SETTINGS_KEY] = JSON.stringify({
          client: { bridgeUrl: $('jc-set-bridge-url').value.trim() },
          webrtc: { signal: JSON.parse($('jc-set-signal').value || '{}'), iceServers: JSON.parse($('jc-set-ice').value || '[]') }
        });
        location.reload();
      } catch (err) { showError(`Settings: ${err.message}`); }
    });
    $('jc-settings-reset').addEventListener('click', () => { delete localStorage[SETTINGS_KEY]; location.reload(); });
    $('jc-user-name').value = localStorage.jclName || `jammer-${Math.floor(Math.random() * 900 + 100)}`;
    $('jc-user-name').addEventListener('change', () => { localStorage.jclName = $('jc-user-name').value; });
    document.querySelectorAll('#jc-connection .tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
    function selectTab(name) {
      document.querySelectorAll('#jc-connection .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      document.querySelectorAll('#jc-connection .tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
    }
    document.querySelectorAll('[data-perm]').forEach((cb) => {
      cb.checked = !!connector.permissions[cb.dataset.perm];
      cb.addEventListener('change', () => connector.sendPermissionsUpdate({ [cb.dataset.perm]: cb.checked }));
    });

    // ---------------------------------------------------------------- bridge retry
    function stopRetry() {
      clearTimeout(retryTimer);
      clearInterval(retryTick);
      retryTimer = retryTick = null;
      $('jc-retry').classList.add('hidden');
    }
    function scheduleRetry(reason, fromEvent) {
      if (fromEvent && retryTimer) return; // a failed attempt already scheduled the next one
      stopRetry();
      if (userStopped || (mode !== 'local' && mode !== 'host')) return;
      const ms = Number(config.client.bridgeRetryMs) || 0;
      const url = mode === 'local' ? $('jc-local-url').value.trim() : $('jc-host-bridge-url').value.trim();
      const at = performance.now() + ms;
      const render = () => {
        const left = Math.max(0, Math.ceil((at - performance.now()) / 1000));
        $('jc-retry-text').textContent = `Bridge unreachable at ${url}: ${reason}.` + (ms > 0 ? ` Retrying in ${left}s.` : ' Automatic retry is off (client.bridgeRetryMs).');
      };
      render();
      $('jc-retry').classList.remove('hidden');
      setBridgeBadge('unreachable');
      if (ms > 0) {
        retryTick = setInterval(render, 250);
        retryTimer = setTimeout(retryNow, ms);
      }
    }
    function retryNow() {
      stopRetry();
      if (mode === 'local') connectLocal();
      else if (mode === 'host') attachBridge();
    }
    $('jc-retry-now').addEventListener('click', retryNow);

    function setBridgeBadge(status) {
      const b = $('jc-bridge-badge');
      b.textContent = `BRIDGE ${String(status).toUpperCase()}`;
      b.className = 'px-2 py-0.5 rounded border text-xs ' + (status === 'connected' ? 'border-emerald-600 text-emerald-400'
        : status === 'unreachable' || status === 'error' ? 'border-rose-700 text-rose-300' : 'border-slate-700 text-slate-500');
    }

    async function connectLocal() {
      stopRetry();
      mode = 'local';
      userStopped = false;
      connecting = true;
      showError('');
      const url = $('jc-local-url').value.trim();
      try {
        await connector.joinLocalBridge(url, $('jc-local-token').value.trim(), userName());
        setBridgeBadge('connected');
        log(`connected to bridge ${url}`);
      } catch (err) {
        log(`bridge ${url}: ${err.message || err}`);
        connecting = false;
        scheduleRetry(err.message || String(err));
        return;
      }
      connecting = false;
      for (const h of connHandlers) h('connected');
    }

    async function attachBridge() {
      stopRetry();
      const url = $('jc-host-bridge-url').value.trim();
      try {
        await connector.attachLocalBridge(url, $('jc-host-bridge-token').value.trim());
        log(`bridge attached: ${url}`);
        for (const h of connHandlers) h('connected');
      } catch (err) {
        log(`bridge ${url}: ${err.message || err}`);
        scheduleRetry(err.message || String(err));
      }
    }

    $('jc-local-connect').addEventListener('click', () => connectLocal());

    $('jc-host-start').addEventListener('click', async (e) => {
      e.target.disabled = true;
      stopRetry();
      showError('');
      try {
        mode = 'host';
        userStopped = false;
        const info = await connector.createHostSession();
        $('jc-host-info').classList.remove('hidden');
        $('jc-host-session').textContent = info.sessionId;
        $('jc-host-token').textContent = info.authToken;
        $('jc-host-invite').value = info.inviteUrl;
        $('jc-host-qr').innerHTML = '';
        if (typeof QRCode !== 'undefined') new QRCode($('jc-host-qr'), { text: info.inviteUrl, width: 160, height: 160 });
        document.querySelectorAll('[data-perm]').forEach((cb) => { cb.checked = !!connector.permissions[cb.dataset.perm]; });
        log(`hosting ${info.sessionId}`);
        await attachBridge();
      } catch (err) {
        showError(err.message || String(err));
      } finally {
        e.target.disabled = false;
      }
    });
    $('jc-host-copy').addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText($('jc-host-invite').value));

    $('jc-join-invite').addEventListener('input', (e) => {
      const parsed = JamConnector.parseInviteInput(e.target.value);
      if (parsed) { $('jc-join-invite').value = parsed.sessionId; $('jc-join-token').value = parsed.authToken; }
    });
    $('jc-join-connect').addEventListener('click', async (e) => {
      e.target.disabled = true;
      stopRetry();
      showError('');
      mode = 'join';
      userStopped = false;
      try {
        await connector.joinHost($('jc-join-invite').value, $('jc-join-token').value, userName());
        log(`joined ${connector.sessionId}`);
        for (const h of connHandlers) h('connected');
      } catch (err) {
        showError(err.message || String(err));
      } finally {
        e.target.disabled = false;
      }
    });

    $('jc-disconnect').addEventListener('click', () => {
      userStopped = true;
      stopRetry();
      connector.disconnect();
      $('jc-host-info').classList.add('hidden');
      setBridgeBadge('-');
      log('disconnected');
    });

    // ---------------------------------------------------------------- connector events
    connector.onConnectionStateChange = (s) => {
      $('jc-status-text').textContent = (s.message || s.status).toUpperCase();
      $('jc-status-dot').className = 'w-2.5 h-2.5 rounded-full ' + ({
        hosting: 'bg-emerald-400 animate-pulse', connected: 'bg-emerald-400 animate-pulse',
        connecting: 'bg-amber-400 animate-ping', error: 'bg-rose-500'
      }[s.status] || 'bg-slate-500');
      $('jc-disconnect').classList.toggle('hidden', !['hosting', 'connected', 'connecting'].includes(s.status));
      renderPeers(s.peers || []);
      if (s.status === 'disconnected' && mode === 'local' && !connecting && !userStopped) {
        setBridgeBadge('disconnected');
        scheduleRetry('connection lost', true);
      }
      if (s.status === 'disconnected' && mode === 'join') showError('Disconnected from the host.');
      applyPermissionLocks();
      for (const h of connHandlers) h(s.status);
    };
    connector.onBridgeStateChange = (s) => {
      setBridgeBadge(s.status);
      if (s.message) log(s.message);
      if (s.status === 'disconnected' && mode === 'host' && !userStopped && connector.isHost) scheduleRetry('connection lost', true);
    };
    connector.onPeerConnected = (_id, peers) => renderPeers(peers);
    connector.onPeerDisconnected = (_id, peers) => renderPeers(peers);
    connector.onPermissionsUpdated = (p) => {
      applyPermissionLocks();
      for (const h of permHandlers) h(p);
    };
    connector.onRelayMessage = (msg, sender) => {
      if (msg.type === 'M4L_HELLO' || msg.type === 'M4L_STATUS') {
        const b = $('jc-live-badge');
        b.textContent = `LIVE DEVICE ${msg.ready === false ? 'LOADING' : 'OK'}`;
        b.className = 'px-2 py-0.5 rounded border text-xs border-emerald-600 text-emerald-400';
      }
      if ((msg.type === 'LIVE_ERROR' || msg.type === 'M4L_ERROR') && msg.message) log(msg.message);
      for (const h of relayHandlers) h(msg, sender);
    };

    function renderPeers(peers) {
      const list = $('jc-peer-list');
      list.replaceChildren(...peers.map((p) => el('span', 'chip', `${p.name}${p.rtt ? ` (${p.rtt}ms)` : ''}`)));
      $('jc-peers-badge').textContent = `${peers.length} JAMMER${peers.length === 1 ? '' : 'S'}`;
    }

    // ---------------------------------------------------------------- Link header
    const quantumSel = $('jc-quantum');
    const quanta = [...new Set([1, 2, 3, 4, 6, 8, 16, config.client.quantum])].sort((a, b) => a - b);
    for (const q of quanta) quantumSel.add(new Option(String(q)));
    quantumSel.value = String(config.client.quantum);
    connector.setLinkQuantum(config.client.quantum);
    $('jc-tempo').min = config.client.tempoMin;
    $('jc-tempo').max = config.client.tempoMax;
    $('jc-play').dataset.needs = 'syncTransport';
    $('jc-tempo').dataset.needs = 'syncMasterSettings';

    function sendTempo(bpm) {
      if (!(bpm >= config.client.tempoMin && bpm <= config.client.tempoMax)) return;
      if (isGuest() && !connector.permissions.syncMasterSettings) { log('tempo: locked by the host'); return; }
      if (!connector.setLinkTempo(bpm)) showError('Connect to the bridge first.');
    }
    $('jc-tempo').addEventListener('change', (e) => sendTempo(parseFloat(e.target.value)));
    $('jc-tempo').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => {
      const t = connector.getLinkState().tempo;
      if (t !== null) sendTempo(Math.round(t) + Number(b.dataset.nudge));
    }));
    $('jc-play').addEventListener('click', () => {
      const st = connector.getLinkState();
      if (isGuest() && !connector.permissions.syncTransport) { log('transport: locked by the host'); return; }
      if (!connector.setLinkPlaying(!st.isPlaying)) showError('Connect to the bridge first.');
    });
    quantumSel.addEventListener('change', () => { connector.setLinkQuantum(Number(quantumSel.value)); buildPhase(); });

    function buildPhase() {
      const q = Math.max(1, Math.round(connector.linkTimeline.quantum));
      const bar = $('jc-phase');
      bar.style.gridTemplateColumns = `repeat(${q}, minmax(0, 1fr))`;
      bar.replaceChildren(...Array.from({ length: q }, (_, i) => el('div', 'phase-cell' + (i === 0 ? ' first' : ''))));
    }
    buildPhase();
    const frameHandlers = [];
    function frame() {
      const st = connector.getLinkState();
      const has = !!st.source && st.tempo !== null;
      if (document.activeElement !== $('jc-tempo')) $('jc-tempo').value = st.tempo !== null ? st.tempo.toFixed(2) : '';
      const cells = $('jc-phase').children;
      if (cells.length !== Math.max(1, Math.round(st.quantum))) buildPhase();
      const ph = Math.floor(st.phase);
      for (let i = 0; i < cells.length; i++) {
        cells[i].classList.toggle('on', has && i === ph);
        cells[i].classList.toggle('past', has && i < ph);
      }
      $('jc-beat').textContent = has ? st.beat.toFixed(2) : '-';
      $('jc-phase-num').textContent = has ? `${st.phase.toFixed(2)} / ${st.quantum}` : '-';
      if (has && st.isPlaying && st.songBeat >= 0) {
        const q = Math.max(1, Math.round(st.quantum));
        const sb = Math.floor(st.songBeat);
        $('jc-songpos').textContent = `${Math.floor(sb / q) + 1}.${(sb % q) + 1}`;
      } else {
        $('jc-songpos').textContent = has && st.isPlaying ? 'count-in' : '-';
      }
      $('jc-link-peers').textContent = st.source === 'bridge' ? String(st.numPeers) : '-';
      $('jc-link-source').textContent = st.source ? (st.source === 'bridge' ? 'Ableton Link' : 'JamConnect host') : '-';
      $('jc-clock').textContent = st.upstream ? `${(st.clockOffsetUs / 1000).toFixed(1)} ms${st.clockReady ? '' : ' (measuring)'}` : (has ? 'master' : '-');
      const pb = $('jc-play');
      pb.textContent = st.isPlaying ? 'STOP' : 'PLAY';
      pb.classList.toggle('playing', st.isPlaying);
      for (const h of frameHandlers) h(st);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    if (configError) showError(configError);

    // Invite links open the join tab; otherwise connect to the bridge right away.
    if (params.get('session') && params.get('token')) {
      selectTab('join');
      $('jc-join-invite').value = params.get('session');
      $('jc-join-token').value = params.get('token');
    } else {
      setTimeout(connectLocal, 0);
    }

    return {
      connector, config, appCfg, log, showError, send, can, esc, el, throttle, isGuest, connected,
      applyPermissionLocks,
      onRelay: (fn) => relayHandlers.push(fn),
      onPermissions: (fn) => permHandlers.push(fn),
      onConnection: (fn) => connHandlers.push(fn),
      onFrame: (fn) => frameHandlers.push(fn)
    };
  }

  window.JCApp = { start, throttle, esc };
})();
