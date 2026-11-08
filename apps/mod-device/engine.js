/* JamConnect Mod Device shell: drives the Rust/WebAssembly modulation core (core-rs, plain C ABI)
 * and turns its output into JamConnect messages. No modulation math here: the core computes sources,
 * transforms, routes and decimated curves; this file keeps the editable model (sources, routes,
 * targets, scenes), feeds inputs and the Link state into the core, and does the IO:
 *   - PARAMS-PROTOCOL (docs/PARAMS-PROTOCOL.md): discovery, own manifest (kind "modulator"),
 *     JAM_PARAM_CURVE / SET / TOUCH / RELEASE, following JAM_PARAM_CHANGED, learn;
 *   - Ableton: LIVE_SET_PARAM / M4L_SET_MACRO / M4L_CC with per-target rates and a shared budget;
 *   - WebRTC guest permissions.
 * Runs in the browser (window.JamModDevice) and in Node (require) with the real .wasm or a mock core. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./schema.js') : root.JamModSchema);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.JamModDevice = api;
})(typeof window !== 'undefined' ? window : null, function (S) {
  'use strict';

  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const REQUIRED_EXPORTS = ['memory', 'core_version', 'core_alloc', 'core_init', 'core_set_config', 'core_tick', 'core_source_create', 'core_route_flush', 'core_out_ptr'];

  /** Instantiate the core from a URL (browser), bytes (Node) or an exports object (mock). */
  async function loadCore(source) {
    if (source && typeof source === 'object' && source.core_tick) return source;
    let bytes = source;
    if (typeof source === 'string') {
      const res = await fetch(source, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`core not built (${source}: HTTP ${res.status})`);
      bytes = await res.arrayBuffer();
    }
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance.exports;
  }

  /** Check the core against the schema (indexes are ABI). Returns a list of problems. */
  function checkCore(core) {
    const errs = [];
    for (const k of REQUIRED_EXPORTS) if (!(k in core)) errs.push(`missing export ${k}`);
    if (errs.length) return errs;
    if (core.core_config_count() !== S.CONFIG_KEYS.length) errs.push(`config keys: core ${core.core_config_count()} vs schema ${S.CONFIG_KEYS.length}`);
    for (const [name, T] of Object.entries(S.TYPES)) {
      if (core.core_type_param_count(T.code) !== T.params.length) errs.push(`${name}: params core ${core.core_type_param_count(T.code)} vs schema ${T.params.length}`);
      if (core.core_type_output_count(T.code) !== T.outputs.length) errs.push(`${name}: outputs core ${core.core_type_output_count(T.code)} vs schema ${T.outputs.length}`);
      if (core.core_type_ref_count(T.code) !== T.refs.length) errs.push(`${name}: refs core ${core.core_type_ref_count(T.code)} vs schema ${T.refs.length}`);
      T.outputs.forEach((o, i) => { if (!!core.core_type_output_bipolar(T.code, i) !== T.bipolar.includes(o)) errs.push(`${name}.${o}: polarity differs`); });
    }
    return errs;
  }

  /** Permission a WebRTC guest needs to send msg (JAM_PARAM_* writes count as parameter changes). */
  function permissionFor(msg, base) {
    const t = msg && msg.type;
    if (/^JAM_PARAM_(SET|CURVE|TOUCH|RELEASE)$/.test(t)) return 'syncDeviceParameterChange';
    return typeof base === 'function' ? base(msg) : null;
  }

  function randomId(prefix, length, alphabet) {
    let s = '';
    for (let i = 0; i < length; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return `${prefix}${s}`;
  }

  /** Clock adapter over a JamConnector (Link timeline in the local performance.now() clock). */
  function connectorClock(connector) {
    return {
      hasTimeline: () => !!connector.linkTimeline.source && !!connector.linkTimeline.hasTempo,
      beatAtTime: (ms) => connector.linkBeatAtTime(ms),
      timeAtBeat: (b) => connector.linkTimeAtBeat(b),
      oneWayMs: () => connector._sessionOneWayMs(),
      quantum: () => connector.linkTimeline.quantum,
      tempo: () => (connector.linkTimeline.hasTempo ? connector.linkTimeline.tempo : null)
    };
  }

  // ------------------------------------------------------------------ target senders
  class TargetSender {
    constructor(dev, route, target) {
      this.dev = dev;
      this.route = route;
      this.t = target;
      this.status = 'idle';
      this.sent = 0;
      this.lastFlush = -Infinity;
      this.lastSentValue = null;
      this.touched = null;
      this.base = null;
    }
    get kind() { return this.t.kind; }
    intervalMs() {
      const s = this.dev.cfg.send;
      return { jam: s.jamParamIntervalMs, live: s.liveParamIntervalMs, macro: s.m4lMacroIntervalMs, cc: s.m4lCcIntervalMs }[this.kind] || 0;
    }
    resolved() { return this.dev.resolveTarget(this.t); }
    mark(ok) { this.status = ok ? 'ok' : (this.dev.lastSendBlocked ? 'blocked' : 'offline'); if (ok) this.sent++; }
    start() {
      this.lastSentValue = null;
      this.lastFlush = -Infinity;
      if (this.kind !== 'jam') return;
      const r = this.resolved();
      this.base = r ? this.dev.instrumentValue(r.instanceId, r.param) : null;
      if (r && (this.route.mode === 'absolute' || this.dev.cfg.touchOffsetRoutes)) {
        if (this.dev.send({ type: 'JAM_PARAM_TOUCH', target: r.instanceId, param: r.param, source: this.dev.instanceId })) this.touched = r;
      }
    }
    release() {
      if (!this.touched) return;
      this.dev.send({ type: 'JAM_PARAM_RELEASE', target: this.touched.instanceId, param: this.touched.param, source: this.dev.instanceId });
      this.touched = null;
    }
    /** Curve batch (decimated by the core) to a JamConnect instrument. */
    sendCurve(points, stepped) {
      const r = this.resolved();
      if (!r) { this.status = 'unresolved'; return; }
      const max = Math.max(2, this.dev.cfg.curve.maxPointsPerMessage);
      for (let i = 0; i < points.length; i += max) {
        const ok = this.dev.send({
          type: 'JAM_PARAM_CURVE', target: r.instanceId, param: r.param, mode: this.route.mode, source: this.dev.instanceId,
          points: points.slice(i, i + max).map((p) => ({ linkBeat: p.beat, norm: p.value, shape: stepped ? 'step' : 'linear' }))
        });
        this.mark(ok);
        if (!ok) break;
      }
    }
    /** No Link timeline: plain values applied on arrival (offset mode around the instrument's last value). */
    sendValue(nowMs, value, force) {
      if (!force && nowMs - this.lastFlush < this.intervalMs()) return;
      const r = this.resolved();
      if (!r) { this.status = 'unresolved'; return; }
      this.lastFlush = nowMs;
      let v = value;
      if (this.route.mode === 'offset') v = clampN((isNum(this.base) ? this.base : this.dev.cfg.offsetBaseDefault) + v, 0, 1);
      if (!force && this.lastSentValue !== null && Math.abs(v - this.lastSentValue) < this.dev.cfg.send.valueEpsilon) return;
      const ok = this.dev.send({ type: 'JAM_PARAM_SET', target: r.instanceId, param: r.param, norm: v });
      this.mark(ok);
      if (ok) this.lastSentValue = v;
    }
    /** Ableton targets: one value per interval, deduplicated, inside the shared LiveAPI budget. */
    sendAbleton(nowMs, value, force) {
      const d = this.dev;
      if (!force && nowMs - this.lastFlush < this.intervalMs()) return;
      const r = this.resolved();
      if (!r) { this.status = 'unresolved'; return; }
      let v = value;
      if (this.route.mode === 'offset') v = clampN((isNum(this.t.base) ? this.t.base : d.cfg.offsetBaseDefault) + v, 0, 1);
      let msg;
      if (this.kind === 'cc') {
        const cc = Math.round(clampN(v, 0, 1) * 127);
        if (!force && this.lastSentValue === cc) { this.lastFlush = nowMs; return; }
        msg = { type: 'M4L_CC', cc: Number(this.t.cc), value: cc, channel: Number(this.t.channel) || 1 };
        v = cc;
      } else {
        if (!force && this.lastSentValue !== null && Math.abs(v - this.lastSentValue) < d.cfg.send.valueEpsilon) { this.lastFlush = nowMs; return; }
        msg = this.kind === 'live'
          ? { type: 'LIVE_SET_PARAM', track: this.t.track, device: Number(this.t.device), param: Number(this.t.param), normalized: v }
          : { type: 'M4L_SET_MACRO', macro: Number(this.t.macro), normalized: v };
      }
      if (r.instance) msg.target = r.instance;
      if (!d.abletonBudget(nowMs) && !force) return; // shared LiveAPI budget used up: retry next tick
      this.lastFlush = nowMs;
      const ok = d.send(msg);
      this.mark(ok);
      if (ok) this.lastSentValue = v;
    }
  }

  // ------------------------------------------------------------------ device
  class ModDevice {
    /**
     * opts: { cfg (client.modulator), core (exports), clock, io: {send, connected, isGuest, permissions, basePermission},
     *         seed?, instanceId?, appName?, alphabet? }
     */
    constructor(opts) {
      this.cfg = opts.cfg;
      this.core = opts.core;
      this.clock = opts.clock;
      this.io = opts.io;
      this.appName = opts.appName || this.cfg.appName;
      this.instanceId = opts.instanceId || randomId(this.cfg.instanceIdPrefix, this.cfg.instanceIdLength, opts.alphabet || '23456789ABCDEFGHJKLMNPQRSTUVWXYZ');
      const errs = checkCore(this.core);
      if (errs.length) throw new Error(`modulation core does not match schema.js: ${errs.join('; ')}`);
      const C = this.core;
      const seed = isNum(opts.seed) ? opts.seed >>> 0 : (Math.random() * 4294967296) >>> 0;
      C.core_init(seed, this.cfg.maxSources, this.cfg.maxRoutes, this.cfg.curve.bufferPoints, this.cfg.curve.outputPoints * 2);
      S.CONFIG_KEYS.forEach((k, i) => {
        const v = S.cfgPath(this.cfg, k);
        if (!isNum(v)) throw new Error(`client.modulator.${k} missing in jamconnect.config.json`);
        C.core_set_config(i, v);
      });
      const G = this.cfg.ranges.global.depth;
      this.globalDepth = G[2];
      C.core_global(this.globalDepth, G[0], G[1]);
      this.sources = new Map();
      this.routes = new Map();
      this.instruments = new Map();
      this.m4l = new Map();
      this.frozen = false;
      this.hold = false;
      this.remote = new Map();     // `${key}|${src}` -> { key, src, mode, points }
      this.remoteKeys = new Set();
      this.pending = [];
      this.touches = new Map();    // own param key -> remote owner
      this.changed = new Map();
      this.learn = null;
      this.lastTick = null;
      this.lastBeat = null;
      this.lastSendBlocked = false;
      this.listeners = {};
      this._budget = { tokens: this.cfg.send.abletonMaxPerSecond, at: null };
      this._announceAt = null;
      this._idSeq = 0;
      this._scratch = { ptr: 0, len: 0 };
      this._pd = null;
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
    emit(ev, arg) { for (const f of this.listeners[ev] || []) { try { f(arg); } catch (_) { /* UI errors must not stop modulation */ } } }

    // ---- core memory helpers
    _f64(ptr, n) { return new Float64Array(this.core.memory.buffer, ptr, n); }
    _scratchFor(n) {
      if (n > this._scratch.len) {
        if (this._scratch.ptr) this.core.core_dealloc(this._scratch.ptr, this._scratch.len);
        const len = Math.max(n, 64);
        this._scratch = { ptr: this.core.core_alloc(len), len };
      }
      return this._scratch.ptr;
    }
    _write(arr) {
      const ptr = this._scratchFor(arr.length);
      this._f64(ptr, arr.length).set(arr);
      return ptr;
    }

    // ---- sending
    send(msg) {
      this.lastSendBlocked = false;
      if (!this.io.connected()) return false;
      const need = permissionFor(msg, this.io.basePermission);
      if (need && this.io.isGuest() && !this.io.permissions()[need]) { this.lastSendBlocked = true; return false; }
      this.io.send(msg);
      return true;
    }
    abletonBudget(nowMs) {
      const max = this.cfg.send.abletonMaxPerSecond;
      if (!(max > 0)) return true;
      const b = this._budget;
      if (b.at !== null) b.tokens = Math.min(max, b.tokens + (nowMs - b.at) * max / 1000);
      b.at = nowMs;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    }

    // ---- model: sources
    nextId(prefix) {
      let id;
      do { id = `${prefix}${++this._idSeq}`; } while (this.sources.has(id) || this.routes.has(id));
      return id;
    }
    _freeSlot(map, max) {
      const used = new Set([...map.values()].map((x) => x.slot));
      for (let i = 0; i < max; i++) if (!used.has(i)) return i;
      return -1;
    }
    defsOf(src) { return S.paramDefs(src.type, src.params, this.cfg); }
    outputsOf(src) { return S.TYPES[src.type].outputs; }
    addSource(spec) {
      const T = S.TYPES[spec.type];
      if (!T) throw new Error(`unknown source type ${spec.type}`);
      const slot = this._freeSlot(this.sources, this.cfg.maxSources);
      if (slot < 0 || this.sources.size >= this.cfg.maxSources) return null;
      const id = spec.id && !this.sources.has(spec.id) && !this.routes.has(spec.id) ? spec.id : this.nextId(spec.type);
      const src = { id, type: spec.type, name: spec.name || id, slot, params: {}, refs: { ...(spec.refs || {}) }, data: clone(spec.data) || this._defaultData(spec.type), invert: { ...(spec.invert || {}) } };
      const given = spec.params || {};
      for (let pass = 0; pass < 2; pass++) for (const d of this.defsOf(src)) src.params[d.id] = given[d.id] !== undefined ? S.coerce(d, given[d.id]) : d.default;
      this.sources.set(id, src);
      this.core.core_source_create(slot, T.code);
      this._pushParams(src);
      this._pushData(src);
      this.core.core_source_init(slot);
      this._pushInvert(src);
      this._pushAllRefs();
      this._structure();
      return src;
    }
    _defaultData(type) {
      if (type === 'lfo') return { points: [{ x: 0, y: -1 }, { x: 0.5, y: 1 }, { x: 0.75, y: -0.2 }] };
      if (type === 'seq') { const d = this.cfg.seq.defaultValues; return { values: Array.from({ length: this.cfg.seq.maxSteps }, (_, i) => d[i % d.length]) }; }
      if (type === 'env') return { stages: [{ dur: 0.25, level: 1, curve: 'log' }, { dur: 0.5, level: 0.4, curve: 'exp' }, { dur: 1, level: 0.7, curve: 'lin' }, { dur: 1, level: 0, curve: 'exp' }], sustain: 2 };
      return {};
    }
    removeSource(id) {
      const src = this.sources.get(id);
      if (!src) return;
      this.sources.delete(id);
      this.core.core_source_remove(src.slot);
      this._pushAllRefs();
      for (const r of this.routes.values()) this._pushRoute(r);
      this._structure();
    }
    renameSource(id, name) { const s = this.sources.get(id); if (s) { s.name = name; this._structure(); } }
    _pushParams(src) {
      const C = this.core;
      this.defsOf(src).forEach((d, i) => {
        C.core_source_param_def(src.slot, i, d.choice ? 0 : d.min, d.choice ? 0 : d.max, d.scale === 'exp' ? 1 : 0, d.steps || 0);
        C.core_source_set_param(src.slot, i, S.toCore(d, src.params[d.id]));
      });
    }
    _pushData(src) {
      const kind = S.TYPES[src.type].data;
      let arr = null;
      if (kind === 'points') arr = (src.data.points || []).filter((p) => isNum(p.x) && isNum(p.y)).sort((a, b) => a.x - b.x).flatMap((p) => [p.x, p.y]);
      else if (kind === 'values') arr = (src.data.values || []).map(Number);
      else if (kind === 'stages') arr = [Number.isInteger(src.data.sustain) ? src.data.sustain : -1, ...(src.data.stages || []).flatMap((s) => [Number(s.dur) || 0, Number(s.level) || 0, Math.max(0, S.CURVES.indexOf(s.curve))])];
      if (!arr) return;
      this.core.core_source_set_data(src.slot, arr.length ? this._write(arr) : 0, arr.length);
    }
    setData(id, data) { const s = this.sources.get(id); if (s) { s.data = clone(data); this._pushData(s); } }
    _pushInvert(src) {
      if (src.type !== 'motion') return;
      S.MOTION_OUTPUTS.forEach((o, i) => { if (i < 10) this.core.core_motion_invert(src.slot, i, src.invert[o] ? 1 : 0); });
    }
    setInvert(id, out, on) { const s = this.sources.get(id); if (s) { s.invert[out] = !!on; this._pushInvert(s); } }
    /** "srcId.output" -> { src, out (index), name, bipolar } */
    resolveRef(ref) {
      if (!ref) return null;
      const i = String(ref).lastIndexOf('.');
      const src = this.sources.get(i < 0 ? ref : ref.slice(0, i));
      if (!src) return null;
      const outs = this.outputsOf(src);
      const name = i < 0 ? outs[0] : ref.slice(i + 1);
      const out = outs.indexOf(name);
      if (out < 0) return null;
      return { src, out, name, bipolar: !!this.core.core_source_bipolar(src.slot, out) };
    }
    _pushAllRefs() {
      for (const src of this.sources.values()) {
        S.TYPES[src.type].refs.forEach((rd, k) => {
          const r = this.resolveRef(src.refs[rd.id]);
          this.core.core_source_set_ref(src.slot, k, r ? r.src.slot : -1, r ? r.out : 0);
        });
      }
    }
    setRef(id, refId, ref) { const s = this.sources.get(id); if (s) { s.refs[refId] = ref || ''; this._pushAllRefs(); for (const r of this.routes.values()) this._pushRoute(r); } }
    allOutputs() {
      const out = [];
      for (const s of this.sources.values()) this.outputsOf(s).forEach((o, i) => out.push({ ref: `${s.id}.${o}`, label: `${s.name} · ${o}`, bipolar: !!this.core.core_source_bipolar(s.slot, i), source: s }));
      return out;
    }

    // ---- model: routes
    addRoute(spec = {}) {
      if (this.routes.size >= this.cfg.maxRoutes) return null;
      const slot = this._freeSlot(this.routes, this.cfg.maxRoutes);
      if (slot < 0) return null;
      const T = this.cfg.ranges.transform;
      const tf = spec.transform || {};
      const num = (v, r) => (isNum(v) ? clampN(v, r[0], r[1]) : r[2]);
      const route = {
        id: spec.id && !this.routes.has(spec.id) && !this.sources.has(spec.id) ? spec.id : this.nextId('route'),
        slot, name: spec.name || '', enabled: spec.enabled !== false, source: spec.source || '', mode: spec.mode === 'offset' ? 'offset' : 'absolute',
        transform: { depth: num(tf.depth, T.depth), offset: num(tf.offset, T.offset), curve: S.CURVES.includes(tf.curve) ? tf.curve : 'lin', curveAmount: num(tf.curveAmount, T.curveAmount),
          slewMs: num(tf.slewMs, T.slewMs), steps: Math.round(num(tf.steps, T.steps)), invert: !!tf.invert, polarity: tf.polarity === 'uni' || tf.polarity === 'bi' ? tf.polarity : 'auto' },
        senders: [], active: false, lastJamFlush: -Infinity
      };
      if (!route.name) route.name = route.id;
      this.routes.set(route.id, route);
      this.core.core_route_create(slot);
      const D = S.transformDefs(this.cfg);
      this.core.core_route_param_def(slot, 0, D.depth.min, D.depth.max);
      this.core.core_route_param_def(slot, 1, D.offset.min, D.offset.max);
      for (const t of (spec.targets || []).slice(0, this.cfg.maxTargetsPerRoute)) this._addSender(route, t);
      this._pushRoute(route);
      this._structure();
      return route;
    }
    _addSender(route, t) {
      if (!t || !S.TARGET_KINDS.includes(t.kind) || route.senders.length >= this.cfg.maxTargetsPerRoute) return null;
      const s = new TargetSender(this, route, clone(t));
      route.senders.push(s);
      return s;
    }
    addTarget(routeId, t) {
      const r = this.routes.get(routeId);
      if (!r) return null;
      const s = this._addSender(r, t);
      if (s && r.active) s.start();
      this._pushRoute(r);
      this._structure();
      return s;
    }
    removeTarget(routeId, i) {
      const r = this.routes.get(routeId);
      if (!r || !r.senders[i]) return;
      const s = r.senders[i];
      if (r.active) this._stopSender(r, s, this.lastCtx());
      r.senders.splice(i, 1);
      this._pushRoute(r);
      this._structure();
    }
    removeRoute(id) {
      const r = this.routes.get(id);
      if (!r) return;
      if (r.active) this._stopRoute(r, this.lastCtx());
      this.routes.delete(id);
      this.core.core_route_remove(r.slot);
      this._structure();
    }
    /** Update route fields ({name, enabled, source, mode, transform}) and push them to the core. */
    updateRoute(id, patch) {
      const r = this.routes.get(id);
      if (!r) return;
      const modeChange = patch.mode && patch.mode !== r.mode;
      const srcChange = patch.source !== undefined && patch.source !== r.source;
      if ((modeChange || srcChange) && r.active) { this._stopRoute(r, this.lastCtx()); r.active = false; }
      if (patch.name !== undefined) r.name = patch.name;
      if (patch.enabled !== undefined) r.enabled = !!patch.enabled;
      if (patch.source !== undefined) r.source = patch.source;
      if (patch.mode) r.mode = patch.mode === 'offset' ? 'offset' : 'absolute';
      if (patch.transform) Object.assign(r.transform, patch.transform);
      this._pushRoute(r);
      if (patch.name !== undefined || modeChange) this._structure();
    }
    _pushRoute(r) {
      const C = this.core;
      const ref = this.resolveRef(r.source);
      const curveOn = r.senders.some((s) => s.kind === 'jam') ? 1 : 0;
      C.core_route_set(r.slot, ref ? ref.src.slot : -1, ref ? ref.out : 0, r.mode === 'offset' ? 1 : 0, r.enabled ? 1 : 0, curveOn);
      const tf = r.transform;
      C.core_route_tf(r.slot, tf.depth, tf.offset, Math.max(0, S.CURVES.indexOf(tf.curve)), tf.curveAmount, tf.slewMs, tf.steps, tf.invert ? 1 : 0, ['auto', 'uni', 'bi'].indexOf(tf.polarity));
      C.core_route_self_clear(r.slot);
      for (const s of r.senders) {
        if (s.kind !== 'self') continue;
        const loc = this._paramLocation(s.t.param);
        if (loc) C.core_route_self_add(r.slot, loc.kind, loc.slot, loc.idx);
      }
    }

    // ---- own parameters (manifest kind "modulator")
    paramDefs() {
      if (this._pd) return this._pd;
      const out = [];
      const G = this.cfg.ranges.global.depth;
      out.push({ key: 'global.depth', def: { id: 'depth', name: 'Global depth', min: G[0], max: G[1], default: G[2], scale: 'lin', modulatable: true }, group: 'Global', kind: 2 });
      for (const s of this.sources.values()) this.defsOf(s).forEach((d, i) => out.push({ key: `${s.id}.${d.id}`, def: d, group: s.name, owner: s, pid: d.id, kind: 0, idx: i, name: `${s.name} ${d.name}` }));
      const D = S.transformDefs(this.cfg);
      for (const r of this.routes.values()) ['depth', 'offset'].forEach((k, i) => out.push({ key: `${r.id}.${k}`, def: D[k], group: 'Routes', owner: r, pid: k, kind: 1, idx: i, name: `${r.name} ${D[k].name.toLowerCase()}` }));
      this._pd = out;
      this._pdMap = new Map(out.map((p) => [p.key, p]));
      return out;
    }
    paramDef(key) { this.paramDefs(); return this._pdMap.get(key) || null; }
    _paramLocation(key) {
      const pd = this.paramDef(key);
      if (!pd || pd.def.choice) return null;
      return { kind: pd.kind, slot: pd.kind === 2 ? 0 : pd.owner.slot, idx: pd.kind === 2 ? 0 : pd.idx };
    }
    manifest() {
      return this.paramDefs().map(({ key, def, group, name }) => {
        const p = { id: key, name: name || def.name, group, min: def.min, max: def.max, default: def.default, scale: def.scale, modulatable: !!def.modulatable };
        if (def.unit) p.unit = def.unit;
        if (def.steps) p.steps = def.steps;
        if (def.valueItems) p.valueItems = def.valueItems;
        return p;
      });
    }
    getBase(key) {
      const pd = this.paramDef(key);
      if (!pd) return undefined;
      if (pd.kind === 2) return this.globalDepth;
      return pd.kind === 1 ? pd.owner.transform[pd.pid] : pd.owner.params[pd.pid];
    }
    /** Set a parameter base value (real units / choice item). Local changes always win. */
    setBase(key, real, origin = 'local') {
      const pd = this.paramDef(key);
      if (!pd) return false;
      const v = S.coerce(pd.def, real);
      if (pd.kind === 2) {
        const G = this.cfg.ranges.global.depth;
        this.globalDepth = v;
        this.core.core_global(v, G[0], G[1]);
      } else if (pd.kind === 1) {
        pd.owner.transform[pd.pid] = v;
        this._pushRoute(pd.owner);
      } else if (pd.def.choice) {
        // a choice can change other ranges (envelope unit): those reset to their new defaults
        const src = pd.owner;
        const before = this.defsOf(src);
        src.params[pd.pid] = v;
        for (const d of this.defsOf(src)) {
          const b = before.find((x) => x.id === d.id);
          if (!b || b.min !== d.min || b.max !== d.max) src.params[d.id] = d.default;
        }
        this._pushParams(src);
        this.manifestChanged();
      } else {
        pd.owner.params[pd.pid] = v;
        this.core.core_source_set_param(pd.owner.slot, pd.idx, S.toCore(pd.def, v));
      }
      const c = this.changed.get(key) || { at: -Infinity };
      c.dirty = true;
      this.changed.set(key, c);
      this.emit('param', { key, value: v, origin });
      return true;
    }
    /** Effective (modulated) value of a numeric parameter, read from the core. */
    effective(key) {
      const loc = this._paramLocation(key);
      if (!loc) return this.getBase(key);
      if (loc.kind === 2) return this.core.core_global_effective();
      return loc.kind === 1 ? this.core.core_route_effective(loc.slot, loc.idx) : this.core.core_source_effective(loc.slot, loc.idx);
    }

    // ---- inputs from the UI / sensors (forwarded to the core)
    pointer(id, phase, pointerId, x, y, pressure, radius, t) { const s = this.sources.get(id); if (s) this.core.core_pointer(s.slot, phase, pointerId, x, y, isNum(pressure) ? pressure : NaN, isNum(radius) ? radius : 0, t); }
    motionOrientation(id, a, b, g, t) { const s = this.sources.get(id); if (s) this.core.core_motion_orientation(s.slot, num(a), num(b), num(g), t); }
    motionAccel(id, lin, withG, t) {
      const s = this.sources.get(id);
      if (!s) return;
      const v = (o, k) => (o && isNum(o[k]) ? o[k] : NaN);
      this.core.core_motion_accel(s.slot, v(lin, 'x'), v(lin, 'y'), v(lin, 'z'), v(withG, 'x'), v(withG, 'y'), v(withG, 'z'), t);
    }
    motionRotation(id, r, t) { const s = this.sources.get(id); if (s && r) this.core.core_motion_rotation(s.slot, num(r.alpha), num(r.beta), num(r.gamma), t); }
    calibrate(id) { const s = this.sources.get(id); if (s) this.core.core_motion_calibrate(s.slot); }
    trigger(id, on) { const s = this.sources.get(id); if (s) this.core.core_trigger(s.slot, on ? 1 : 0); }
    midi(ev) {
      if (!ev) return;
      const kind = ev.kind === 'noteon' ? 0 : ev.kind === 'noteoff' ? 1 : ev.kind === 'cc' ? 2 : -1;
      if (kind < 0) return;
      this.core.core_midi(kind, Number(kind === 2 ? ev.cc : ev.note) | 0, Number(kind === 2 ? ev.value : ev.velocity) | 0, Number(ev.channel || 1) | 0);
    }
    audioBlock(id, samples, t) {
      const s = this.sources.get(id);
      if (!s || !samples || !samples.length) return;
      const ptr = this._scratchFor(Math.ceil(samples.length / 2));
      new Float32Array(this.core.memory.buffer, ptr, samples.length).set(samples);
      this.core.core_audio_block(s.slot, ptr, samples.length, t);
    }
    value(ref) { const r = this.resolveRef(ref); return r ? this.core.core_source_value(r.src.slot, r.out) : 0; }
    sourceActive(id) { const s = this.sources.get(id); return s ? !!this.core.core_source_active(s.slot) : false; }
    sourceInfo(id, what) { const s = this.sources.get(id); return s ? this.core.core_source_info(s.slot, what) : -1; }
    routeValue(id) { const r = this.routes.get(id); return r ? this.core.core_route_value(r.slot) : 0; }
    routeInput(id) { const r = this.routes.get(id); return r ? this.core.core_route_input(r.slot) : 0; }

    // ---- targets
    resolveTarget(t) {
      switch (t.kind) {
        case 'jam': {
          if (t.instanceId && t.instanceId !== '*' && t.param) return this.instruments.has(t.instanceId) || t.instanceId === this.instanceId ? { instanceId: t.instanceId, param: t.param } : null;
          if (!t.match) return null;
          let re;
          try { re = new RegExp(t.match, 'i'); } catch (_) { return null; }
          for (const inst of [...this.instruments.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId))) {
            if (inst.kind && inst.kind !== 'instrument') continue;
            const p = (inst.params || []).find((q) => q.modulatable !== false && (re.test(q.id) || re.test(q.name || '')));
            if (p) return { instanceId: inst.instanceId, param: p.id };
          }
          return null;
        }
        case 'live': return t.track !== undefined && t.device !== undefined && t.param !== undefined ? { instance: this.resolveM4l(t.instance) } : null;
        case 'macro':
        case 'cc': {
          if (t.instance === '*first') { const i = this.resolveM4l('*first'); return i ? { instance: i } : null; }
          return { instance: t.instance || null };
        }
        case 'self': return this._paramLocation(t.param) ? { param: t.param } : null;
        default: return null;
      }
    }
    resolveM4l(instance) {
      if (instance !== '*first') return instance || null;
      const ids = [...this.m4l.keys()].sort();
      return ids.length ? ids[0] : null;
    }
    instrumentValue(instanceId, param) {
      const inst = this.instruments.get(instanceId);
      if (!inst) return null;
      if (inst.values && isNum(inst.values[param])) return inst.values[param];
      const p = (inst.params || []).find((q) => q.id === param);
      return p && !p.valueItems ? S.realToNorm(p, p.default) : null;
    }
    targetLabel(t) {
      switch (t.kind) {
        case 'jam': {
          const r = this.resolveTarget(t);
          if (!r) return t.match ? `JamConnect /${t.match}/ (waiting)` : 'JamConnect (unresolved)';
          const inst = this.instruments.get(r.instanceId);
          const p = inst && (inst.params || []).find((q) => q.id === r.param);
          return `${inst ? inst.appName : r.instanceId} · ${p ? p.name : r.param}`;
        }
        case 'live': return `Live · ${t.trackName || `track ${t.track}`} / ${t.deviceName || `device ${t.device}`} / ${t.paramName || `param ${t.param}`}`;
        case 'macro': return `M4L macro ${Number(t.macro) + 1}${t.instance ? ` @ ${t.instance === '*first' ? 'first device' : t.instance}` : ''}`;
        case 'cc': return `M4L CC ${t.cc} ch ${t.channel || 1}${t.instance ? ` @ ${t.instance === '*first' ? 'first device' : t.instance}` : ''}`;
        case 'self': { const d = this.paramDef(t.param); return `This device · ${d ? d.name || d.def.name : t.param}`; }
        default: return '?';
      }
    }

    // ---- protocol
    announce() {
      this._announceAt = null;
      return this.send({ type: 'JAM_PARAMS_ANNOUNCE', instanceId: this.instanceId, appName: this.appName, kind: 'modulator', params: this.manifest() });
    }
    discover() { return this.send({ type: 'JAM_PARAMS_DISCOVER' }); }
    bye() { return this.send({ type: 'JAM_PARAMS_BYE', instanceId: this.instanceId }); }
    manifestChanged() {
      this._pd = null;
      if (this._announceAt === null) this._announceAt = (this.lastTick || 0) + this.cfg.announceDebounceMs;
    }
    _structure() { this.manifestChanged(); this.emit('structure'); }

    handleMessage(msg) {
      if (!msg || typeof msg.type !== 'string') return;
      const forMe = msg.target === this.instanceId;
      switch (msg.type) {
        case 'JAM_PARAMS_DISCOVER':
          if (!msg.target || forMe) this.announce();
          break;
        case 'JAM_PARAMS_ANNOUNCE':
          if (!msg.instanceId || msg.instanceId === this.instanceId) break;
          this.instruments.set(msg.instanceId, { ...(this.instruments.get(msg.instanceId) || { values: {} }), instanceId: msg.instanceId, appName: msg.appName || msg.instanceId, kind: msg.kind || 'instrument', params: Array.isArray(msg.params) ? msg.params : [] });
          this.emit('instruments');
          break;
        case 'JAM_PARAMS_BYE':
          if (this.instruments.delete(msg.instanceId)) this.emit('instruments');
          break;
        case 'JAM_PARAM_CHANGED': {
          const inst = this.instruments.get(msg.instanceId);
          if (inst) { inst.values = inst.values || {}; inst.values[msg.param] = msg.norm; }
          this.emit('instrumentValue', msg);
          if (this.learn && inst && !this._isTargeted({ kind: 'jam', instanceId: msg.instanceId, param: msg.param })) {
            const p = (inst.params || []).find((q) => q.id === msg.param);
            if (!p || p.modulatable !== false) this._learned({ kind: 'jam', instanceId: msg.instanceId, param: msg.param });
          }
          break;
        }
        case 'JAM_PARAM_SET':
        case 'JAM_PARAM_CURVE':
        case 'JAM_PARAM_TOUCH':
        case 'JAM_PARAM_RELEASE':
          if (forMe) this._handleOwnParam(msg);
          break;
        case 'LIVE_PARAM_CHANGED':
          if (this.learn && !this._isTargeted({ kind: 'live', track: msg.track, device: msg.device, param: msg.param })) {
            this._learned({ kind: 'live', track: msg.track, device: msg.device, param: msg.param, base: msg.normalized, instance: msg.instance });
          }
          break;
        case 'M4L_HELLO':
        case 'M4L_STATUS':
          if (msg.instance) { this.m4l.set(msg.instance, msg); this.emit('m4l'); }
          break;
        case 'M4L_BYE':
          if (this.m4l.delete(msg.instance)) this.emit('m4l');
          break;
        case 'M4L_MACRO_CHANGED': {
          const d = this.m4l.get(msg.instance);
          if (d && d.macros && d.macros[msg.macro]) d.macros[msg.macro].normalized = msg.normalized;
          if (this.learn && !this._isTargeted({ kind: 'macro', instance: msg.instance, macro: msg.macro })) this._learned({ kind: 'macro', instance: msg.instance, macro: msg.macro, base: msg.normalized });
          break;
        }
        default:
      }
    }
    _isTargeted(t) {
      for (const r of this.routes.values()) {
        for (const s of r.senders) {
          if (s.kind !== t.kind) continue;
          if (t.kind === 'jam') { const x = s.resolved(); if (x && x.instanceId === t.instanceId && x.param === t.param) return true; }
          if (t.kind === 'live' && String(s.t.track) === String(t.track) && Number(s.t.device) === Number(t.device) && Number(s.t.param) === Number(t.param)) return true;
          if (t.kind === 'macro' && Number(s.t.macro) === Number(t.macro) && (this.resolveM4l(s.t.instance) || null) === (t.instance || null)) return true;
        }
      }
      return false;
    }
    _handleOwnParam(msg) {
      const key = msg.param;
      const pd = this.paramDef(key);
      if (!pd) return;
      const src = `remote:${msg.source || msg.appName || 'anon'}`;
      const owner = this.touches.get(key);
      if (msg.type === 'JAM_PARAM_TOUCH') { this.touches.set(key, src); return; }
      if (msg.type === 'JAM_PARAM_RELEASE') {
        if (owner === src) this.touches.delete(key);
        const c = this.remote.get(`${key}|${src}`);
        this.remote.delete(`${key}|${src}`);
        if (c && c.mode === 'absolute' && isNum(c.last)) this.setBase(key, S.normToReal(pd.def, c.last), 'remote');
        return;
      }
      if (owner !== undefined && owner !== src) return; // touched by another source
      if (msg.type === 'JAM_PARAM_SET') {
        if (!isNum(msg.norm)) return;
        if (isNum(msg.linkBeat) && this.clock.hasTimeline() && msg.linkBeat > this.clock.beatAtTime(this.lastTick || 0)) this.pending.push({ key, norm: msg.norm, linkBeat: msg.linkBeat });
        else this.setBase(key, S.normToReal(pd.def, msg.norm), 'remote');
        return;
      }
      // JAM_PARAM_CURVE: new points replace scheduled ones from the same source at/after the first new beat
      const pts = (msg.points || []).filter((p) => isNum(p.linkBeat) && isNum(p.norm)).sort((a, b) => a.linkBeat - b.linkBeat);
      if (!pts.length) return;
      const id = `${key}|${src}`;
      const mode = msg.mode === 'offset' ? 'offset' : 'absolute';
      const cur = this.remote.get(id);
      const keep = cur && cur.mode === mode ? cur.points.filter((p) => p.linkBeat < pts[0].linkBeat) : [];
      this.remote.set(id, { key, src, mode, points: keep.concat(pts), last: cur ? cur.last : null });
    }
    /** Evaluate received curves for own parameters (interpolation done by the core) and hand them to the core. */
    _applyRemote(beat) {
      if (this.pending.length && beat !== null) {
        const due = this.pending.filter((p) => p.linkBeat <= beat);
        this.pending = this.pending.filter((p) => p.linkBeat > beat);
        for (const p of due) { const pd = this.paramDef(p.key); if (pd) this.setBase(p.key, S.normToReal(pd.def, p.norm), 'remote'); }
      }
      const agg = new Map();
      const SHAPES = { linear: 0, step: 1, exp: 2, s: 3 };
      for (const [id, c] of this.remote) {
        const loc = this._paramLocation(c.key);
        if (!loc) { this.remote.delete(id); continue; }
        if (beat !== null && c.points.length > 1) {
          let i = 0;
          while (i < c.points.length - 1 && c.points[i + 1].linkBeat <= beat) i++;
          if (i > 0) c.points = c.points.slice(i);
        }
        let v;
        if (beat === null) v = c.points[c.points.length - 1].norm;
        else {
          const arr = c.points.flatMap((p) => [p.linkBeat, p.norm, SHAPES[p.shape] || 0]);
          v = this.core.core_curve_value_at(this._write(arr), c.points.length, beat);
        }
        if (!isNum(v)) continue;
        c.last = v;
        const a = agg.get(c.key) || { abs: NaN, off: 0, loc };
        const touch = this.touches.get(c.key);
        if (c.mode === 'offset') { if (touch === undefined || touch === c.src) a.off += v; }
        else if (touch === undefined || touch === c.src) a.abs = v;
        agg.set(c.key, a);
      }
      const keys = new Set(agg.keys());
      for (const k of this.remoteKeys) if (!keys.has(k)) { const loc = this._paramLocation(k); if (loc) this._setRemote(loc, NaN, 0); }
      for (const [, a] of agg) this._setRemote(a.loc, a.abs, a.off);
      this.remoteKeys = keys;
    }
    _setRemote(loc, abs, off) {
      if (loc.kind === 0) this.core.core_source_remote(loc.slot, loc.idx, abs, off);
      else if (loc.kind === 1) this.core.core_route_remote(loc.slot, loc.idx, abs, off);
      else this.core.core_global_remote(abs, off);
    }
    _echoChanged(nowMs) {
      const iv = this.cfg.paramChangedIntervalMs;
      for (const [key, c] of this.changed) {
        if (!c.dirty || nowMs - c.at < iv) continue;
        const pd = this.paramDef(key);
        c.dirty = false;
        c.at = nowMs;
        if (pd) this.send({ type: 'JAM_PARAM_CHANGED', instanceId: this.instanceId, param: key, norm: S.realToNorm(pd.def, this.getBase(key)) });
      }
    }

    // ---- learn
    startLearn(routeId, nowMs) { this.learn = { routeId, until: nowMs + this.cfg.learnTimeoutMs }; this.emit('learn', this.learn); }
    stopLearn() { if (this.learn) { this.learn = null; this.emit('learn', null); } }
    _learned(t) {
      const id = this.learn.routeId;
      this.learn = null;
      this.addTarget(id, t);
      this.emit('learn', null);
      this.emit('learned', { route: this.routes.get(id), target: t });
    }

    // ---- global controls
    lastCtx() { return this._ctx || null; }
    panic() {
      const ctx = this.lastCtx();
      for (const r of this.routes.values()) if (r.active) { this._stopRoute(r, ctx); r.active = false; }
      this.frozen = true;
      this.core.core_set_frozen(1);
      this.emit('frozen', true);
    }
    setFrozen(f) { if (f) this.panic(); else { this.frozen = false; this.core.core_set_frozen(0); this.emit('frozen', false); } }
    setHold(h) { this.hold = !!h; this.core.core_set_hold(this.hold ? 1 : 0); this.emit('hold', this.hold); }

    // ---- scenes
    toScene() {
      return {
        format: 'jamconnect-mod-scene', version: 1, global: { depth: this.globalDepth },
        sources: [...this.sources.values()].map((s) => ({ id: s.id, type: s.type, name: s.name, params: clone(s.params), refs: clone(s.refs), data: clone(s.data), invert: clone(s.invert) })),
        routes: [...this.routes.values()].map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, source: r.source, mode: r.mode, transform: clone(r.transform), targets: r.senders.map((s) => clone(s.t)) }))
      };
    }
    loadScene(scene) {
      if (!scene || !Array.isArray(scene.sources) || !Array.isArray(scene.routes)) throw new Error('not a mod device scene');
      const wasFrozen = this.frozen;
      this.panic();
      for (const id of [...this.routes.keys()]) this.removeRoute(id);
      for (const id of [...this.sources.keys()]) this.removeSource(id);
      this.remote.clear();
      this.touches.clear();
      if (scene.global && isNum(scene.global.depth)) this.setBase('global.depth', scene.global.depth);
      for (const s of scene.sources.slice(0, this.cfg.maxSources)) if (S.TYPES[s.type]) this.addSource(s);
      this._pushAllRefs();
      for (const r of scene.routes.slice(0, this.cfg.maxRoutes)) this.addRoute(r);
      if (!wasFrozen) this.setFrozen(false);
      this._structure();
    }

    // ---- route activity / output
    _stopSender(r, s, ctx) {
      if (s.kind === 'jam') {
        if (r.mode === 'offset') s.sendValue(ctx ? ctx.nowMs : 0, 0, true);
        s.release();
      } else if (s.kind !== 'self') {
        s.sendAbleton(ctx ? ctx.nowMs : 0, r.mode === 'offset' ? 0 : this.core.core_route_value(r.slot), true);
      }
    }
    _stopRoute(r, ctx) {
      const C = this.core;
      const jam = r.senders.filter((s) => s.kind === 'jam');
      if (jam.length && ctx && ctx.beat !== null) {
        if (r.mode === 'offset') {
          // offset modulation returns to the base value: drop the unsent lookahead and end with a 0 point
          // (it replaces already scheduled points of this source from that beat on)
          C.core_route_reset(r.slot);
          C.core_route_push(r.slot, this.clock.beatAtTime(ctx.nowMs + ctx.leadMs), 0);
        }
        this._flushJam(r, jam, true);
      } else if (jam.length && r.mode === 'offset') {
        for (const s of jam) s.sendValue(ctx ? ctx.nowMs : 0, 0, true);
      }
      for (const s of jam) s.release();
      for (const s of r.senders) if (s.kind !== 'jam' && s.kind !== 'self') s.sendAbleton(ctx ? ctx.nowMs : 0, r.mode === 'offset' ? 0 : C.core_route_value(r.slot), true);
      C.core_route_reset(r.slot);
    }
    _flushJam(r, jam, force) {
      const n = this.core.core_route_flush(r.slot);
      if (!n && !force) return;
      if (!n) return;
      const buf = this._f64(this.core.core_out_ptr(), n * 2);
      const pts = [];
      for (let i = 0; i < n; i++) pts.push({ beat: buf[2 * i], value: buf[2 * i + 1] });
      const stepped = r.transform.steps >= 2;
      for (const s of jam) s.sendCurve(pts, stepped);
    }

    // ---- main loop
    tick(nowMs) {
      const C = this.core;
      const dt = this.lastTick === null ? 0 : Math.max(0, nowMs - this.lastTick);
      this.lastTick = nowMs;
      const has = this.clock.hasTimeline();
      const beat = has ? this.clock.beatAtTime(nowMs) : null;
      const tempo = has ? this.clock.tempo() : null;
      const oneWay = this.clock.oneWayMs();
      const leadMs = oneWay + this.cfg.send.jamParamIntervalMs + this.cfg.curve.leadMarginMs;
      const ctx = { nowMs, beat, tempo, leadMs, oneWay };
      this._ctx = ctx;
      this._applyRemote(beat);
      C.core_tick(beat === null ? NaN : beat, tempo || 0, this.clock.quantum(), nowMs, dt, leadMs);
      for (const r of this.routes.values()) {
        const active = !!C.core_route_active(r.slot);
        if (active !== r.active) {
          r.active = active;
          if (active) { r.lastJamFlush = -Infinity; for (const s of r.senders) s.start(); }
          else this._stopRoute(r, ctx);
        }
        if (!active) continue;
        const jam = r.senders.filter((s) => s.kind === 'jam');
        if (jam.length) {
          if (beat === null) { const v = C.core_route_value(r.slot); for (const s of jam) s.sendValue(nowMs, v, false); }
          else if (nowMs - r.lastJamFlush >= this.cfg.send.jamParamIntervalMs) { r.lastJamFlush = nowMs; this._flushJam(r, jam, false); }
        }
        const abl = r.senders.filter((s) => s.kind === 'live' || s.kind === 'macro' || s.kind === 'cc');
        if (abl.length) {
          // Ableton applies values on arrival: take the route value at now + one-way latency
          const at = nowMs + oneWay;
          const v = C.core_route_peek(r.slot, beat === null ? NaN : this.clock.beatAtTime(at), at);
          for (const s of abl) s.sendAbleton(nowMs, isNum(v) ? v : C.core_route_value(r.slot), false);
        }
      }
      this._echoChanged(nowMs);
      if (this.learn && nowMs > this.learn.until) this.stopLearn();
      if (this._announceAt !== null && nowMs >= this._announceAt && this.io.connected()) this.announce();
      this.lastBeat = beat;
      return ctx;
    }
  }
  const num = (v) => (isNum(v) ? v : NaN);

  return { ModDevice, TargetSender, loadCore, checkCore, permissionFor, connectorClock, randomId, REQUIRED_EXPORTS };
});
