/* PARAMS-PROTOCOL, instrument side (docs/PARAMS-PROTOCOL.md). No DOM, no Web Audio globals: the app
 * injects AudioParams and clocks, the tests inject mocks.
 *
 *  - JAM_PARAMS_DISCOVER -> JAM_PARAMS_ANNOUNCE (manifest; each Param also carries its current `value`)
 *  - JAM_PARAM_SET {target, param, norm, linkBeat?}: immediate, or at that Link beat
 *  - JAM_PARAM_CURVE {target, param, points:[{linkBeat, norm, shape}], mode, source}: scheduled on the
 *    parameter's AudioParam ("absolute": the base value; "offset": the bipolar ".mod" lane, -1..1).
 *    A curve replaces what was scheduled from its first point on; points in the past are dropped and
 *    the value jumps to the interpolated current value.
 *  - JAM_PARAM_TOUCH / RELEASE: while a source owns a param, absolute SET/CURVE from others are
 *    ignored; the local user always wins. Offset curves are modulation and are not blocked by touch.
 *  - JAM_PARAM_CHANGED echo, at most one per param per `echoIntervalMs` (newest value wins).
 *  - JAM_PRESET_LOAD / JAM_PRESET_GET -> JAM_PRESET_STATE, JAM_PRESET_CHANGED (synth additions).
 *
 * Stepped (non-modulatable) params have no AudioParam: they go through setStepped(id, norm, time).
 */
import { quantizeNorm, clamp01, normalize } from './params.js';

export const SHAPES = ['step', 'linear', 'exp', 's'];

/** Value of a curve segment from (v0) to (v1) at fraction x in [0,1]. */
export function shapeValue(shape, v0, v1, x, eps) {
  switch (shape) {
    case 'step': return x >= 1 ? v1 : v0;
    case 'exp': {
      if (Math.abs(v0) > eps && Math.abs(v1) > eps && Math.sign(v0) === Math.sign(v1)) return v0 * Math.pow(v1 / v0, x);
      // through zero / sign change: exponential-like shape (slow start, fast end)
      const k = Math.log(1 / eps);
      return v0 + (v1 - v0) * (Math.exp(k * x) - 1) / (Math.exp(k) - 1);
    }
    case 's': return v0 + (v1 - v0) * x * x * (3 - 2 * x);
    default: return v0 + (v1 - v0) * x;
  }
}

export class InstrumentParams {
  /**
   * @param {object} o
   *  schema: Param[] (buildSchema), instanceId, appName, kind, name,
   *  send(msg): send a relay message,
   *  nowMs(): wall clock (performance.now) for echo rate limiting,
   *  audioNow(): AudioContext time or null when audio is not running,
   *  audioTimeAtBeat(beat): AudioContext time of a Link beat, or null (no Link tempo / no audio),
   *  beatNow(): current Link beat or null,
   *  baseParam(id) / modParam(id): AudioParam or null,
   *  setStepped(id, norm, time|null): apply a param without AudioParam (time = AudioContext time),
   *  onValue(id, norm, origin): model changed (UI update), origin "local"|"remote"|"curve"|"preset",
   *  onPreset(preset, msg): JAM_PRESET_LOAD accepted, getPreset(): current patch for JAM_PRESET_GET,
   *  canAccept(msg, senderId): permission gate (WebRTC guests),
   *  cfg: client.synth.protocol {echoIntervalMs, curveTolerance, curveMaxSubdivisions, expEpsilon}
   */
  constructor(o) {
    this.o = o;
    this.cfg = o.cfg;
    this.instanceId = o.instanceId;
    this.values = new Map();
    this.owner = new Map();
    this.offsetOwner = new Map();
    this.lastEcho = new Map();
    this.pendingEcho = new Map();
    this.curves = new Map();       // id -> {start: {t, v}, points: [{t, v, shape}]} (absolute, model follow)
    this.lastEventTime = new Map(); // `${id}|base` / `${id}|mod` -> last scheduled AudioParam event time
    this.pendingSets = [];          // [{t, id, norm}] model updates at a future audio time
    this.setSchema(o.schema);
    for (const p of o.schema) this.values.set(p.id, this.defaultNorm(p));
  }

  setSchema(schema) {
    this.schema = schema;
    this.byId = new Map(schema.map((p) => [p.id, p]));
  }

  defaultNorm(p) { return normalize(p, p.default); }
  get(id) { return this.values.get(id); }

  // ------------------------------------------------------------------ outgoing

  manifest() {
    return this.schema.map((p) => {
      const e = { id: p.id, name: p.name, group: p.group, min: p.min, max: p.max, default: p.default, unit: p.unit, scale: p.scale, modulatable: p.modulatable, value: this.values.get(p.id) };
      if (p.steps) e.steps = p.steps;
      if (p.valueItems) e.valueItems = p.valueItems;
      return e;
    });
  }

  announce(extra = {}) {
    this.o.send({ type: 'JAM_PARAMS_ANNOUNCE', instanceId: this.instanceId, appName: this.o.appName, kind: this.o.kind || 'instrument', name: this.o.name, params: this.manifest(), ...extra });
  }

  bye() { this.o.send({ type: 'JAM_PARAMS_BYE', instanceId: this.instanceId }); }

  /** Rate-limited JAM_PARAM_CHANGED (leading edge now, trailing edge from flushEchoes). */
  echo(id) {
    const now = this.o.nowMs();
    const last = this.lastEcho.has(id) ? this.lastEcho.get(id) : -Infinity;
    if (now - last >= this.cfg.echoIntervalMs && !this.pendingEcho.has(id)) {
      this.lastEcho.set(id, now);
      this.o.send({ type: 'JAM_PARAM_CHANGED', instanceId: this.instanceId, param: id, norm: this.values.get(id) });
    } else {
      this.pendingEcho.set(id, true);
    }
  }

  flushEchoes() {
    const now = this.o.nowMs();
    for (const id of [...this.pendingEcho.keys()]) {
      const last = this.lastEcho.get(id) ?? -Infinity;
      if (now - last >= this.cfg.echoIntervalMs) {
        this.pendingEcho.delete(id);
        this.lastEcho.set(id, now);
        this.o.send({ type: 'JAM_PARAM_CHANGED', instanceId: this.instanceId, param: id, norm: this.values.get(id) });
      }
    }
  }

  setModel(id, norm, origin, echo = true) {
    const p = this.byId.get(id);
    if (!p) return;
    const n = quantizeNorm(p, norm);
    const changed = this.values.get(id) !== n;
    this.values.set(id, n);
    if (changed) {
      if (this.o.onValue) this.o.onValue(id, n, origin);
      if (echo) this.echo(id);
    }
  }

  // ------------------------------------------------------------------ local user

  /** Local knob move: the local user always wins; cancels remote automation on this param. */
  localSet(id, norm) {
    const p = this.byId.get(id);
    if (!p) return;
    this.curves.delete(id);
    this.applyNow(p, quantizeNorm(p, norm));
    this.setModel(id, norm, 'local');
  }
  localTouch(id) { this.owner.set(id, 'local'); }
  localRelease(id) { if (this.owner.get(id) === 'local') this.owner.delete(id); }

  /** Load a whole patch (norms by id): no per-param echo, one JAM_PRESET_CHANGED instead. */
  setAll(norms, origin = 'preset', meta = {}) {
    for (const [id, norm] of Object.entries(norms)) {
      const p = this.byId.get(id);
      if (!p) continue;
      this.curves.delete(id);
      const n = quantizeNorm(p, norm);
      this.applyNow(p, n);
      this.setModel(id, n, origin, false);
    }
    this.o.send({ type: 'JAM_PRESET_CHANGED', instanceId: this.instanceId, name: meta.name, category: meta.category, values: Object.fromEntries(this.values) });
  }

  /** Push every model value to the audio side (after audio starts or the schema changes). */
  syncAll() {
    for (const p of this.schema) this.applyNow(p, this.values.get(p.id));
  }

  applyNow(p, norm) {
    const now = this.o.audioNow();
    const ap = p.modulatable ? this.o.baseParam(p.id) : null;
    if (ap && now !== null) {
      ap.cancelScheduledValues(now);
      ap.setValueAtTime(norm, now);
      this.lastEventTime.set(`${p.id}|base`, now);
    } else if (!p.modulatable) {
      this.o.setStepped(p.id, norm, null);
    }
  }

  // ------------------------------------------------------------------ incoming

  addressed(msg) {
    return msg.target === this.instanceId || msg.target === '*';
  }

  sourceOf(msg, senderId) { return msg.source || msg.appName || senderId || 'remote'; }

  /** Handle one relay message. Returns true if it was for us. */
  handle(msg, senderId) {
    if (!msg || typeof msg.type !== 'string') return false;
    switch (msg.type) {
      case 'JAM_PARAMS_DISCOVER':
        if (msg.target && msg.target !== this.instanceId && msg.target !== '*') return false;
        this.announce();
        return true;
      case 'JAM_PARAM_SET':
      case 'JAM_PARAM_CURVE':
      case 'JAM_PARAM_TOUCH':
      case 'JAM_PARAM_RELEASE':
      case 'JAM_PRESET_LOAD':
      case 'JAM_PRESET_GET':
        if (!this.addressed(msg)) return false;
        if (this.o.canAccept && !this.o.canAccept(msg, senderId)) return true;
        break;
      case 'DEVICE_PARAMETER_CHANGE':
        return this.legacyChange(msg);
      default:
        return false;
    }
    const src = this.sourceOf(msg, senderId);
    switch (msg.type) {
      case 'JAM_PARAM_TOUCH': {
        if (!this.byId.has(msg.param)) return true;
        if (this.owner.get(msg.param) !== 'local') this.owner.set(msg.param, src);
        return true;
      }
      case 'JAM_PARAM_RELEASE':
        if (this.owner.get(msg.param) === src) this.owner.delete(msg.param);
        return true;
      case 'JAM_PARAM_SET': return this.remoteSet(msg, src);
      case 'JAM_PARAM_CURVE': return this.remoteCurve(msg, src);
      case 'JAM_PRESET_LOAD':
        if (msg.preset && this.o.onPreset) this.o.onPreset(msg.preset, msg);
        return true;
      case 'JAM_PRESET_GET':
        if (this.o.getPreset) this.o.send({ type: 'JAM_PRESET_STATE', instanceId: this.instanceId, preset: this.o.getPreset(), ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}) });
        return true;
      default: return true;
    }
  }

  blocked(id, src) {
    const o = this.owner.get(id);
    return o !== undefined && o !== src;
  }

  legacyChange(msg) {
    const p = this.byId.get(msg.param);
    if (!p || (msg.target && !this.addressed(msg))) return false;
    if (this.blocked(p.id, this.sourceOf(msg))) return true;
    const norm = typeof msg.normalizedValue === 'number' ? msg.normalizedValue
      : typeof msg.value === 'number' ? normalize(p, msg.value) : null;
    if (norm === null) return true;
    this.curves.delete(p.id);
    this.applyNow(p, quantizeNorm(p, clamp01(norm)));
    this.setModel(p.id, clamp01(norm), 'remote');
    return true;
  }

  remoteSet(msg, src) {
    const p = this.byId.get(msg.param);
    if (!p || typeof msg.norm !== 'number' || !Number.isFinite(msg.norm)) return true;
    if (this.blocked(p.id, src)) return true;
    const norm = quantizeNorm(p, clamp01(msg.norm));
    const now = this.o.audioNow();
    const t = typeof msg.linkBeat === 'number' ? this.o.audioTimeAtBeat(msg.linkBeat) : null;
    if (t !== null && now !== null && t > now) {
      const ap = p.modulatable ? this.o.baseParam(p.id) : null;
      if (ap) {
        ap.cancelScheduledValues(t);
        ap.setValueAtTime(norm, t);
        this.lastEventTime.set(`${p.id}|base`, Math.max(t, this.lastEventTime.get(`${p.id}|base`) ?? -Infinity));
      } else {
        this.o.setStepped(p.id, norm, t);
      }
      this.pendingSets.push({ t, id: p.id, norm });
      return true;
    }
    this.curves.delete(p.id);
    this.applyNow(p, norm);
    this.setModel(p.id, norm, 'remote');
    return true;
  }

  remoteCurve(msg, src) {
    const p = this.byId.get(msg.param);
    if (!p || !Array.isArray(msg.points) || !msg.points.length) return true;
    const offset = msg.mode === 'offset';
    if (offset) {
      if (!p.modulatable) return true;
      this.offsetOwner.set(p.id, src);
    } else if (this.blocked(p.id, src)) {
      return true;
    }
    const lo = offset ? -1 : 0;
    const pts = [];
    for (const q of msg.points) {
      if (typeof q.linkBeat !== 'number' || typeof q.norm !== 'number' || !Number.isFinite(q.norm)) continue;
      const t = this.o.audioTimeAtBeat(q.linkBeat);
      if (t === null) return true; // no Link timeline: beats cannot be placed
      pts.push({ t, v: Math.max(lo, Math.min(1, q.norm)), shape: SHAPES.includes(q.shape) ? q.shape : 'linear' });
    }
    if (!pts.length) return true;
    pts.sort((a, b) => a.t - b.t);
    const now = this.o.audioNow();

    if (!p.modulatable || now === null) {
      // no AudioParam (stepped param, or audio not running): follow the curve in the model only
      if (!offset) this.curves.set(p.id, { start: { t: -Infinity, v: this.values.get(p.id) }, points: pts, stepped: true });
      return true;
    }
    const ap = offset ? this.o.modParam(p.id) : this.o.baseParam(p.id);
    if (!ap) return true;
    const key = `${p.id}|${offset ? 'mod' : 'base'}`;
    const past = pts.filter((q) => q.t <= now);
    const future = pts.filter((q) => q.t > now);
    const curValue = offset ? (this.offsetValue(p.id, now)) : this.modelValueAt(p.id, now);
    let prev;
    if (!future.length) {
      const last = pts[pts.length - 1];
      ap.cancelScheduledValues(now);
      ap.setValueAtTime(last.v, now);
      this.lastEventTime.set(key, now);
      if (offset) this.offsets.set(p.id, { start: { t: now, v: last.v }, points: [] });
      else { this.curves.delete(p.id); this.setModel(p.id, last.v, 'curve'); }
      return true;
    }
    if (past.length) {
      const a = past[past.length - 1], b = future[0];
      const v = shapeValue(b.shape, a.v, b.v, (now - a.t) / (b.t - a.t), this.cfg.expEpsilon);
      ap.cancelScheduledValues(now);
      ap.setValueAtTime(v, now);
      prev = { t: now, v };
    } else if ((this.lastEventTime.get(key) ?? -Infinity) > now) {
      // streaming: the previous curve is still running; replace it from our first point on
      ap.cancelScheduledValues(future[0].t);
      prev = { t: this.lastEventTime.get(key), v: this.scheduledValueAt(p.id, offset, future[0].t) };
      if (prev.t >= future[0].t) prev = { t: now, v: curValue };
    } else {
      ap.cancelScheduledValues(now);
      ap.setValueAtTime(curValue, now);
      prev = { t: now, v: curValue };
    }
    const start = { ...prev };
    for (const q of future) {
      this.scheduleSegment(ap, prev, q);
      prev = q;
    }
    this.lastEventTime.set(key, future[future.length - 1].t);
    const record = { start, points: future };
    if (offset) this.offsets.set(p.id, record);
    else this.curves.set(p.id, record);
    return true;
  }

  /** One segment on an AudioParam, ending at q (exp / s are error-bounded linear subdivisions). */
  scheduleSegment(ap, prev, q) {
    const { curveTolerance, curveMaxSubdivisions, expEpsilon } = this.cfg;
    switch (q.shape) {
      case 'step': ap.setValueAtTime(q.v, q.t); return;
      case 'linear': ap.linearRampToValueAtTime(q.v, q.t); return;
      case 'exp':
        if (Math.abs(prev.v) > expEpsilon && Math.abs(q.v) > expEpsilon && Math.sign(prev.v) === Math.sign(q.v)) {
          ap.exponentialRampToValueAtTime(q.v, q.t);
          return;
        }
        break;
      default:
    }
    // max error of K linear pieces ~ |dv| * max|f''| / (8 K^2); smoothstep f'' <= 6, exp-like <= k^2
    const dv = Math.abs(q.v - prev.v);
    const curv = q.shape === 's' ? 6 : Math.log(1 / expEpsilon) ** 2;
    const K = Math.max(1, Math.min(curveMaxSubdivisions, Math.ceil(Math.sqrt((dv * curv) / (8 * curveTolerance)))));
    for (let i = 1; i <= K; i++) {
      const x = i / K;
      ap.linearRampToValueAtTime(shapeValue(q.shape, prev.v, q.v, x, expEpsilon), prev.t + (q.t - prev.t) * x);
    }
  }

  get offsets() {
    if (!this._offsets) this._offsets = new Map();
    return this._offsets;
  }

  static curveAt(rec, t, eps) {
    let prev = rec.start;
    if (t <= prev.t) return prev.v;
    for (const q of rec.points) {
      if (t <= q.t) return shapeValue(q.shape, prev.v, q.v, q.t > prev.t ? (t - prev.t) / (q.t - prev.t) : 1, eps);
      prev = q;
    }
    return prev.v;
  }

  modelValueAt(id, t) {
    const rec = this.curves.get(id);
    return rec ? InstrumentParams.curveAt(rec, t, this.cfg.expEpsilon) : this.values.get(id);
  }

  offsetValue(id, t) {
    const rec = this.offsets.get(id);
    return rec ? InstrumentParams.curveAt(rec, t, this.cfg.expEpsilon) : 0;
  }

  scheduledValueAt(id, offset, t) { return offset ? this.offsetValue(id, t) : this.modelValueAt(id, t); }

  /** Periodic work: follow running curves / due SETs in the model, flush rate-limited echoes. */
  tick() {
    const now = this.o.audioNow();
    const nowOrInf = now === null ? Infinity : now;
    if (this.pendingSets.length) {
      const due = this.pendingSets.filter((s) => s.t <= nowOrInf);
      this.pendingSets = this.pendingSets.filter((s) => s.t > nowOrInf);
      for (const s of due) { this.curves.delete(s.id); this.setModel(s.id, s.norm, 'remote'); }
    }
    for (const [id, rec] of [...this.curves]) {
      const p = this.byId.get(id);
      const t = now === null ? this.beatClockTime(rec) : now;
      const v = InstrumentParams.curveAt(rec, t, this.cfg.expEpsilon);
      const last = rec.points[rec.points.length - 1];
      if (rec.stepped && p && !p.modulatable) {
        const n = quantizeNorm(p, v);
        if (n !== this.values.get(id)) this.o.setStepped(id, n, null);
      }
      this.setModel(id, v, 'curve');
      if (t >= last.t) this.curves.delete(id);
    }
    for (const [id, rec] of [...this.offsets]) {
      if (now !== null && (!rec.points.length || now >= rec.points[rec.points.length - 1].t) && rec.points.length) {
        // keep the final offset as a held value
        this.offsets.set(id, { start: { t: now, v: rec.points[rec.points.length - 1].v }, points: [] });
      }
    }
    this.flushEchoes();
  }

  /** Without audio, curve times are still AudioContext-like seconds from audioTimeAtBeat (if Link gives them). */
  beatClockTime(rec) { return rec.points.length ? (this.o.audioNow() ?? -Infinity) : -Infinity; }

  /** Effective offset currently scheduled for the UI ring (-1..1). */
  offsetNow(id) {
    const now = this.o.audioNow();
    return now === null ? 0 : this.offsetValue(id, now);
  }
}
