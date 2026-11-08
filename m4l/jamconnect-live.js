// JamConnect Link - LiveAPI side (classic Max [js], ES5 only).
// Receives "live <TYPE> <json>" from the node.script and works on the Live Object Model.
// Outlet 0 -> node.script:  "livereply <TYPE> <json>", "liveevent <TYPE> <json>",
//                           "liveinfo <json>" (LIVE_SET_INFO), "liveerror <text>", "deviceinfo <json>"
// Outlet 1 -> [pattr] that stores the macro mappings with the Live set ("set <encoded json>")
// Outlet 2 -> macro dials ("<index> <value>"), the dials feed back into macro()
// Every limit and interval comes from jamconnect.config.json ("m4l" section) as msg.cfg.

autowatch = 1;
inlets = 1;
outlets = 3;

var CFG = {};
var deviceIsReady = false;

// ---------------------------------------------------------------- helpers
function cfgNum(key) {
  var v = Number(CFG[key]);
  return isNaN(v) ? 0 : v;
}

// Positive config limit caps a count, a missing one leaves it unchanged.
function limit(count, max) {
  var m = parseInt(max, 10);
  return isNaN(m) || m <= 0 ? count : Math.min(count, m);
}

function obj(path) {
  var a = new LiveAPI(path);
  if (!a || Number(a.id) === 0) throw new Error("no Live object at " + path);
  return a;
}

function list(a, prop) {
  var v = a.get(prop);
  if (v === undefined || v === null) return [];
  return (typeof v === "object" && v.length !== undefined) ? v : [v];
}

function val(a, prop) {
  var v = list(a, prop);
  if (v.length === 0) return null;
  return v.length === 1 ? v[0] : v;
}

function num(a, prop) {
  var v = Number(val(a, prop));
  return isNaN(v) ? null : v;
}

function bool(a, prop) {
  return Number(val(a, prop)) === 1;
}

function str(a, prop) {
  var v = list(a, prop);
  return v.length ? v.join(" ") : "";
}

function intArg(msg, key) {
  var v = parseInt(msg[key], 10);
  if (isNaN(v) || v < 0) throw new Error("missing " + key);
  return v;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------- parameter math
// normalized = (value - min) / (max - min), clamped to 0..1.
function normalize(value, min, max) {
  if (!(max > min)) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

// value = min + n * (max - min); quantized parameters snap to whole steps.
function denormalize(n, min, max, quantized) {
  var v = min + clamp(Number(n), 0, 1) * (max - min);
  return quantized ? Math.round(v) : v;
}

function clampReal(v, min, max, quantized) {
  var r = clamp(Number(v), min, max);
  return quantized ? Math.round(r) : r;
}

function strFor(p, value) {
  try {
    var s = p.call("str_for_value", value);
    if (s === undefined || s === null) return "";
    return (typeof s === "object" && s.length !== undefined) ? s.join(" ") : String(s);
  } catch (e) {
    return "";
  }
}

function paramInfo(p, index) {
  var min = num(p, "min"), max = num(p, "max"), value = num(p, "value");
  var q = bool(p, "is_quantized");
  var info = {
    index: index,
    name: str(p, "name"),
    originalName: str(p, "original_name"),
    value: value,
    min: min,
    max: max,
    normalized: normalize(value, min, max),
    isQuantized: q,
    isEnabled: bool(p, "is_enabled"),
    display: strFor(p, value)
  };
  if (q) {
    var items = list(p, "value_items"), out = [];
    for (var i = 0; i < items.length; i++) out.push(String(items[i]));
    info.valueItems = out;
  } else {
    info.defaultValue = num(p, "default_value");
  }
  return info;
}

// Set a DeviceParameter from msg.real (real value) or msg.value (normalized 0..1).
function applyParam(p, msg) {
  var min = num(p, "min"), max = num(p, "max"), q = bool(p, "is_quantized");
  var target;
  if (typeof msg.real === "number") target = clampReal(msg.real, min, max, q);
  else if (typeof msg.normalized === "number") target = denormalize(msg.normalized, min, max, q);
  else target = denormalize(Number(msg.value), min, max, q);
  if (isNaN(target)) throw new Error("bad value");
  p.set("value", target);
  return target;
}

// ---------------------------------------------------------------- object paths
// Track reference: number N = live_set tracks N, "rN" = return track N, "master" = master track.
function trackKind(ref) {
  if (ref === "master") return "master";
  if (typeof ref === "string" && /^r\d+$/.test(ref)) return "return";
  return "track";
}

function trackPath(ref) {
  var kind = trackKind(ref);
  if (kind === "master") return "live_set master_track";
  if (kind === "return") return "live_set return_tracks " + ref.substring(1);
  var n = parseInt(ref, 10);
  if (isNaN(n) || n < 0) throw new Error("bad track " + ref);
  return "live_set tracks " + n;
}

function normRef(ref) {
  return trackKind(ref) === "track" ? parseInt(ref, 10) : ref;
}

function devicePath(msg) {
  return trackPath(msg.track) + " devices " + intArg(msg, "device");
}

function paramPath(msg) {
  return devicePath(msg) + " parameters " + intArg(msg, "param");
}

function mixerParamPath(ref, which, send) {
  var base = trackPath(ref) + " mixer_device ";
  if (which === "volume" || which === "panning") return base + which;
  if (which === "send") return base + "sends " + parseInt(send, 10);
  throw new Error("bad mixer param " + which);
}

// ---------------------------------------------------------------- song
var SONG_PROPS = ["tempo", "is_playing", "record_mode", "metronome", "overdub", "session_record",
  "loop", "loop_start", "loop_length", "current_song_time", "signature_numerator",
  "signature_denominator", "groove_amount", "swing_amount", "clip_trigger_quantization",
  "midi_recording_quantization", "punch_in", "punch_out", "back_to_arranger", "can_undo",
  "can_redo", "can_capture_midi", "is_counting_in", "session_automation_record", "start_time",
  "is_ableton_link_enabled", "is_ableton_link_start_stop_sync_enabled"];
// Tempo and play state belong to Link (LINK_SET_TEMPO / LINK_SET_PLAYING through the bridge).
var SONG_LINK_PROPS = { tempo: "LINK_SET_TEMPO", is_playing: "LINK_SET_PLAYING" };
var SONG_READ_ONLY = { can_undo: 1, can_redo: 1, can_capture_midi: 1, is_counting_in: 1,
  is_ableton_link_enabled: 1, is_ableton_link_start_stop_sync_enabled: 1 };
// current_song_time changes continuously while playing; poll it with LIVE_GET_SONG instead.
var SONG_NOT_OBSERVED = { can_undo: 1, can_redo: 1, current_song_time: 1 };
var SONG_ACTIONS = {
  start: "start_playing", stop: "stop_playing", "continue": "continue_playing",
  undo: "undo", redo: "redo", tap_tempo: "tap_tempo", capture_midi: "capture_midi",
  stop_all_clips: "stop_all_clips", jump_by: "jump_by", jump_to_next_cue: "jump_to_next_cue",
  jump_to_prev_cue: "jump_to_prev_cue", re_enable_automation: "re_enable_automation",
  trigger_session_record: "trigger_session_record", capture_and_insert_scene: "capture_and_insert_scene",
  set_or_delete_cue: "set_or_delete_cue"
};

function songInfo() {
  var s = obj("live_set"), out = {};
  for (var i = 0; i < SONG_PROPS.length; i++) {
    var v = val(s, SONG_PROPS[i]);
    out[SONG_PROPS[i]] = (v === null || isNaN(Number(v))) ? v : Number(v);
  }
  return out;
}

function setSong(msg) {
  var prop = String(msg.prop || "");
  if (SONG_LINK_PROPS[prop]) throw new Error(prop + " is Link state: use " + SONG_LINK_PROPS[prop]);
  var known = false;
  for (var i = 0; i < SONG_PROPS.length; i++) if (SONG_PROPS[i] === prop) known = true;
  if (!known || SONG_READ_ONLY[prop]) throw new Error("song property not settable: " + prop);
  var v = typeof msg.value === "boolean" ? (msg.value ? 1 : 0) : Number(msg.value);
  if (isNaN(v)) throw new Error("bad value for " + prop);
  obj("live_set").set(prop, v);
}

function songAction(msg) {
  var action = String(msg.action || "");
  var s = obj("live_set");
  if (action === "back_to_arranger") { s.set("back_to_arranger", 0); return; }
  var fn = SONG_ACTIONS[action];
  if (!fn) throw new Error("unknown song action " + action);
  if (action === "undo" && !bool(s, "can_undo")) return;
  if (action === "redo" && !bool(s, "can_redo")) return;
  if (action === "capture_midi") {
    if (msg.destination !== undefined) s.call(fn, parseInt(msg.destination, 10));
    else s.call(fn);
  } else if (action === "stop_all_clips") {
    s.call(fn, msg.quantized === false ? 0 : 1);
  } else if (action === "jump_by") {
    s.call(fn, Number(msg.beats) || 0);
  } else if (action === "trigger_session_record" && typeof msg.length === "number") {
    s.call(fn, msg.length);
  } else {
    s.call(fn);
  }
}

// ---------------------------------------------------------------- tracks / mixer / clips
function mixerInfo(path) {
  var m = obj(path + " mixer_device");
  var info = {
    volume: paramInfo(obj(path + " mixer_device volume"), 0),
    panning: paramInfo(obj(path + " mixer_device panning"), 1),
    sends: []
  };
  var n = limit(m.getcount("sends"), CFG.maxSends);
  for (var i = 0; i < n; i++) info.sends.push(paramInfo(obj(path + " mixer_device sends " + i), i));
  return info;
}

function deviceSummary(path, index) {
  var d = obj(path + " devices " + index);
  return {
    index: index,
    name: str(d, "name"),
    className: str(d, "class_name"),
    classDisplayName: str(d, "class_display_name"),
    deviceType: num(d, "type"),
    isActive: bool(d, "is_active"),
    canHaveChains: bool(d, "can_have_chains"),
    numParams: d.getcount("parameters")
  };
}

function deviceList(ref) {
  var path = trackPath(ref), t = obj(path), out = [];
  var n = limit(t.getcount("devices"), CFG.maxDevices);
  for (var i = 0; i < n; i++) out.push(deviceSummary(path, i));
  return out;
}

function trackInfo(ref, withMixer) {
  var path = trackPath(ref), t = obj(path), kind = trackKind(ref);
  var info = { ref: normRef(ref), kind: kind, name: str(t, "name"), color: num(t, "color") };
  if (kind !== "master") {
    info.mute = bool(t, "mute");
    info.solo = bool(t, "solo");
  }
  if (kind === "track") {
    info.canBeArmed = bool(t, "can_be_armed");
    if (info.canBeArmed) info.arm = bool(t, "arm");
    info.hasMidiInput = bool(t, "has_midi_input");
    info.playingSlot = num(t, "playing_slot_index");
    info.firedSlot = num(t, "fired_slot_index");
  }
  if (withMixer) info.mixer = mixerInfo(path);
  var devs = [], n = limit(t.getcount("devices"), CFG.maxDevices);
  for (var i = 0; i < n; i++) devs.push(str(obj(path + " devices " + i), "name"));
  info.devices = devs;
  return info;
}

function slotInfo(path) {
  var cs = obj(path), out = { hasClip: bool(cs, "has_clip") };
  if (out.hasClip) {
    var c = obj(path + " clip");
    out.name = str(c, "name");
    out.color = num(c, "color");
    out.isPlaying = bool(c, "is_playing");
    out.isTriggered = bool(c, "is_triggered");
    out.isRecording = bool(c, "is_recording");
  } else {
    out.isTriggered = bool(cs, "is_triggered");
  }
  return out;
}

function allTracks(withMixer) {
  var set = obj("live_set"), res = { tracks: [], returns: [], master: null };
  var nT = limit(set.getcount("tracks"), CFG.maxTracks);
  var nR = limit(set.getcount("return_tracks"), CFG.maxReturns);
  for (var t = 0; t < nT; t++) res.tracks.push(trackInfo(t, withMixer));
  for (var r = 0; r < nR; r++) res.returns.push(trackInfo("r" + r, withMixer));
  res.master = trackInfo("master", withMixer);
  return res;
}

// LIVE_SET_INFO keeps the original fields (tracks[].name/clips, scenes[], tempo) and adds the rest.
function setInfo() {
  var set = obj("live_set");
  var nScenes = limit(set.getcount("scenes"), CFG.maxScenes);
  var all = allTracks(true);
  var info = { tracks: all.tracks, returns: all.returns, master: all.master, scenes: [], sceneInfo: [],
    tempo: num(set, "tempo"), song: songInfo() };
  for (var s = 0; s < nScenes; s++) {
    var sc = obj("live_set scenes " + s);
    info.scenes.push(str(sc, "name"));
    info.sceneInfo.push({ name: str(sc, "name"), color: num(sc, "color"), isTriggered: bool(sc, "is_triggered") });
  }
  for (var t = 0; t < info.tracks.length; t++) {
    var tr = info.tracks[t];
    tr.clips = [];
    tr.slots = [];
    if (!tr.name) tr.name = "Track " + (t + 1);
    for (var c = 0; c < nScenes; c++) {
      var si = slotInfo("live_set tracks " + t + " clip_slots " + c);
      tr.clips.push(si.hasClip);
      tr.slots.push(si);
    }
  }
  return info;
}

function setTrack(msg) {
  var ref = msg.track, kind = trackKind(ref), t = obj(trackPath(ref)), prop = String(msg.prop || "");
  if (prop === "name") { t.set("name", String(msg.value)); return; }
  if (prop === "color") { t.set("color", parseInt(msg.value, 10)); return; }
  if (prop === "mute" || prop === "solo") {
    if (kind === "master") throw new Error("master track has no " + prop);
    t.set(prop, msg.value ? 1 : 0);
    return;
  }
  if (prop === "arm") {
    if (kind !== "track" || !bool(t, "can_be_armed")) throw new Error("track cannot be armed");
    t.set("arm", msg.value ? 1 : 0);
    return;
  }
  throw new Error("track property not settable: " + prop);
}

// ---------------------------------------------------------------- outgoing messages
var currentRequestId;

function reply(type, payload) {
  if (currentRequestId !== undefined && payload.requestId === undefined) payload.requestId = currentRequestId;
  outlet(0, "livereply", type, JSON.stringify(payload));
}

function fail(type, message) {
  var payload = { message: type + ": " + message, request: type };
  if (currentRequestId !== undefined) payload.requestId = currentRequestId;
  outlet(0, "livereply", type.indexOf("M4L_") === 0 ? "M4L_ERROR" : "LIVE_ERROR", JSON.stringify(payload));
}

// Coalescing rate limiter: at most one message per key per interval; the newest value wins.
function Limiter(intervalKey) {
  this.intervalKey = intervalKey;
  this.pending = {};
  this.order = [];
  this.last = -1e15;
  this.scheduled = false;
  var self = this;
  this.task = new Task(function () { self.flush(); }, this);
}

Limiter.prototype.push = function (key, type, payload) {
  if (!this.pending.hasOwnProperty(key)) this.order.push(key);
  this.pending[key] = { type: type, payload: payload };
  if (this.scheduled) return;
  var wait = this.last + cfgNum(this.intervalKey) - Date.now();
  if (wait <= 0) {
    this.flush();
  } else {
    this.scheduled = true;
    this.task.schedule(wait);
  }
};

Limiter.prototype.flush = function () {
  this.scheduled = false;
  this.last = Date.now();
  var order = this.order, pending = this.pending;
  this.order = [];
  this.pending = {};
  for (var i = 0; i < order.length; i++) {
    var e = pending[order[i]];
    outlet(0, "liveevent", e.type, JSON.stringify(e.payload));
  }
};

var events = new Limiter("observerIntervalMs");
var macroEvents = new Limiter("macroIntervalMs");

// ---------------------------------------------------------------- observers
// Groups: "song", "track:<ref>", "device:<ref>:<index>". Index-bound groups are dropped when
// Live's track/scene lists change (LIVE_SET_CHANGED): clients re-fetch and re-observe.
var groups = [];
var observerCount = 0;
var clearTask = new Task(function () { clearGroups(true); }, this);

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function makeObserver(spec) {
  var last = null;
  var api = new LiveAPI(function (args) {
    if (!args || args[0] !== spec.prop) return;
    var v = args.length > 2 ? Array.prototype.slice.call(args, 1) : args[1];
    if (sameValue(v, last)) return;
    last = v;
    spec.emit(v);
  }, spec.path);
  if (Number(api.id) === 0) return null;
  last = val(api, spec.prop);
  api.property = spec.prop;
  return api;
}

function songSpecs() {
  var specs = [];
  for (var i = 0; i < SONG_PROPS.length; i++) {
    if (SONG_NOT_OBSERVED[SONG_PROPS[i]]) continue;
    (function (prop) {
      specs.push({ path: "live_set", prop: prop, emit: function (v) {
        events.push("song:" + prop, "LIVE_SONG_CHANGED", { prop: prop, value: Number(v) });
      } });
    })(SONG_PROPS[i]);
  }
  var children = ["tracks", "return_tracks", "scenes"];
  for (var c = 0; c < children.length; c++) {
    (function (what) {
      specs.push({ path: "live_set", prop: what, emit: function () {
        events.push("set:" + what, "LIVE_SET_CHANGED", { what: what });
        clearTask.schedule(0);
      } });
    })(children[c]);
  }
  return specs;
}

function paramSpec(path, key, type, base) {
  var p = obj(path), min = num(p, "min"), max = num(p, "max");
  return { path: path, prop: "value", emit: function (v) {
    var payload = {};
    for (var k in base) if (base.hasOwnProperty(k)) payload[k] = base[k];
    var value = Number(v);
    payload.value = value;
    payload.normalized = normalize(value, min, max);
    payload.display = strFor(p, value);
    events.push(key, type, payload);
  } };
}

function trackSpecs(ref) {
  var path = trackPath(ref), kind = trackKind(ref), t = obj(path), specs = [];
  var ev = String(ref);
  var props = ["name", "color"];
  if (kind !== "master") props.push("mute", "solo");
  if (kind === "track") {
    if (bool(t, "can_be_armed")) props.push("arm");
    props.push("playing_slot_index", "fired_slot_index");
  }
  for (var i = 0; i < props.length; i++) {
    (function (prop) {
      specs.push({ path: path, prop: prop, emit: function (v) {
        var value = prop === "name" ? (typeof v === "object" && v.length !== undefined ? v.join(" ") : String(v)) : Number(v);
        events.push("track:" + ev + ":" + prop, "LIVE_TRACK_CHANGED", { track: normRef(ref), prop: prop, value: value });
      } });
    })(props[i]);
  }
  specs.push(paramSpec(path + " mixer_device volume", "track:" + ev + ":volume", "LIVE_TRACK_CHANGED", { track: normRef(ref), prop: "volume" }));
  specs.push(paramSpec(path + " mixer_device panning", "track:" + ev + ":panning", "LIVE_TRACK_CHANGED", { track: normRef(ref), prop: "panning" }));
  var nS = limit(obj(path + " mixer_device").getcount("sends"), CFG.maxSends);
  for (var s = 0; s < nS; s++) {
    specs.push(paramSpec(path + " mixer_device sends " + s, "track:" + ev + ":send:" + s, "LIVE_TRACK_CHANGED", { track: normRef(ref), prop: "send", send: s }));
  }
  return specs;
}

function deviceSpecs(ref, d) {
  var path = trackPath(ref) + " devices " + d, dev = obj(path), specs = [];
  var ev = String(ref) + ":" + d;
  var props = ["is_active", "name"];
  for (var i = 0; i < props.length; i++) {
    (function (prop) {
      specs.push({ path: path, prop: prop, emit: function (v) {
        var value = prop === "name" ? (typeof v === "object" && v.length !== undefined ? v.join(" ") : String(v)) : Number(v);
        events.push("device:" + ev + ":" + prop, "LIVE_DEVICE_CHANGED", { track: normRef(ref), device: d, prop: prop, value: value });
      } });
    })(props[i]);
  }
  var n = limit(dev.getcount("parameters"), CFG.maxParams);
  for (var p = 0; p < n; p++) {
    specs.push(paramSpec(path + " parameters " + p, "param:" + ev + ":" + p, "LIVE_PARAM_CHANGED", { track: normRef(ref), device: d, param: p }));
  }
  return specs;
}

function removeGroup(g) {
  for (var i = 0; i < g.observers.length; i++) {
    try { g.observers[i].property = ""; } catch (e) {}
  }
  observerCount -= g.observers.length;
  g.observers = [];
}

function findGroup(key) {
  for (var i = 0; i < groups.length; i++) if (groups[i].key === key) return i;
  return -1;
}

function clearGroups(indexBoundOnly) {
  var keep = [];
  for (var i = 0; i < groups.length; i++) {
    if (indexBoundOnly && groups[i].key === "song") keep.push(groups[i]);
    else removeGroup(groups[i]);
  }
  groups = keep;
}

// Adds (or refreshes) a group within m4l.maxObservers, evicting the oldest groups first.
function addGroup(key, specs, evicted) {
  var idx = findGroup(key);
  if (idx >= 0) {
    removeGroup(groups[idx]);
    groups.splice(idx, 1);
  }
  var max = parseInt(CFG.maxObservers, 10);
  var truncated = false;
  if (max > 0) {
    while (observerCount + specs.length > max && groups.length) {
      var victim = -1;
      for (var i = 0; i < groups.length; i++) if (groups[i].key !== "song") { victim = i; break; }
      if (victim < 0) break;
      evicted.push(groups[victim].key);
      removeGroup(groups[victim]);
      groups.splice(victim, 1);
    }
    if (observerCount + specs.length > max) {
      specs = specs.slice(0, Math.max(0, max - observerCount));
      truncated = true;
    }
  }
  var g = { key: key, observers: [] };
  for (var s = 0; s < specs.length; s++) {
    var api = makeObserver(specs[s]);
    if (api) g.observers.push(api);
  }
  observerCount += g.observers.length;
  groups.push(g);
  return truncated;
}

function observingReply(evicted, truncated) {
  var keys = [];
  for (var i = 0; i < groups.length; i++) keys.push(groups[i].key);
  reply("LIVE_OBSERVING", { groups: keys, observers: observerCount, maxObservers: parseInt(CFG.maxObservers, 10) || 0,
    evicted: evicted, truncated: truncated });
}

function observe(msg) {
  var scope = String(msg.scope || ""), evicted = [], truncated = false;
  if (scope === "song") {
    truncated = addGroup("song", songSpecs(), evicted);
  } else if (scope === "track") {
    truncated = addGroup("track:" + normRef(msg.track), trackSpecs(msg.track), evicted);
  } else if (scope === "tracks") {
    var set = obj("live_set");
    var refs = [], nT = limit(set.getcount("tracks"), CFG.maxTracks), nR = limit(set.getcount("return_tracks"), CFG.maxReturns);
    for (var t = 0; t < nT; t++) refs.push(t);
    for (var r = 0; r < nR; r++) refs.push("r" + r);
    refs.push("master");
    for (var i = 0; i < refs.length; i++) truncated = addGroup("track:" + refs[i], trackSpecs(refs[i]), evicted) || truncated;
  } else if (scope === "device") {
    var d = intArg(msg, "device");
    truncated = addGroup("device:" + normRef(msg.track) + ":" + d, deviceSpecs(msg.track, d), evicted);
  } else {
    throw new Error("unknown observe scope " + scope);
  }
  observingReply(evicted, truncated);
}

function unobserve(msg) {
  if (msg.all) {
    clearGroups(false);
  } else {
    var scope = String(msg.scope || ""), key = scope;
    if (scope === "track") key = "track:" + normRef(msg.track);
    else if (scope === "device") key = "device:" + normRef(msg.track) + ":" + intArg(msg, "device");
    var keep = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (g.key === key || (scope === "tracks" && g.key.indexOf("track:") === 0)) removeGroup(g);
      else keep.push(g);
    }
    groups = keep;
  }
  observingReply([], false);
}

// ---------------------------------------------------------------- Max for Live device: macros + mappings
var macroValues = [];
var mappings = [];

function macroConfig(i) {
  var list = CFG.macros || [];
  var m = list[i] || {};
  return { name: m.name, min: Number(m.min), max: Number(m.max) };
}

function macroCount() {
  return parseInt(CFG.macroCount, 10) || 0;
}

function macroIndex(msg) {
  var i = intArg(msg, "macro");
  if (i >= macroCount()) throw new Error("macro " + i + " out of range");
  return i;
}

// Target normalized = map.min + macroNormalized * (map.max - map.min) (map.min > map.max inverts).
function mappedNormalized(macroNorm, map) {
  return clamp(map.min + macroNorm * (map.max - map.min), 0, 1);
}

function applyMappings(i) {
  var mc = macroConfig(i), v = macroValues[i];
  if (v === undefined || !deviceIsReady) return;
  var n = normalize(v, mc.min, mc.max);
  for (var k = 0; k < mappings.length; k++) {
    var m = mappings[k];
    if (m.macro !== i) continue;
    try {
      var p = obj(paramPath(m));
      p.set("value", denormalize(mappedNormalized(n, m), num(p, "min"), num(p, "max"), bool(p, "is_quantized")));
    } catch (e) {
      post("jamconnect: mapping " + i + " -> " + m.track + "/" + m.device + "/" + m.param + ": " + e.message + "\n");
    }
  }
}

// From the macro dials (UI, automation, or M4L_SET_MACRO via outlet 2).
function macro(i, v) {
  i = parseInt(i, 10);
  v = Number(v);
  if (isNaN(i) || isNaN(v)) return;
  macroValues[i] = v;
  applyMappings(i);
  var mc = macroConfig(i);
  macroEvents.push("macro:" + i, "M4L_MACRO_CHANGED", { macro: i, value: v, normalized: normalize(v, mc.min, mc.max) });
}

function setMacro(msg) {
  var i = macroIndex(msg), mc = macroConfig(i);
  var v = typeof msg.normalized === "number" ? denormalize(msg.normalized, mc.min, mc.max, false)
    : clamp(Number(msg.value), Math.min(mc.min, mc.max), Math.max(mc.min, mc.max));
  if (isNaN(v)) throw new Error("bad macro value");
  outlet(2, i, v);
}

function saveMappings() {
  outlet(1, "set", encodeURIComponent(JSON.stringify(mappings)));
}

// From the [pattr] when the Live set (or device preset) loads.
function restoremappings(s) {
  try {
    var parsed = JSON.parse(decodeURIComponent(String(s || "")));
    if (parsed && parsed.length !== undefined) mappings = parsed;
  } catch (e) {
    post("jamconnect: cannot restore mappings: " + e.message + "\n");
  }
}

function mappingsReply() {
  reply("M4L_MAPPINGS", { mappings: mappings, maxMappings: parseInt(CFG.maxMappings, 10) || 0 });
}

function mapMacro(msg) {
  var i = macroIndex(msg);
  var p = obj(paramPath(msg));
  var d = obj(devicePath(msg));
  var m = {
    macro: i, track: normRef(msg.track), device: intArg(msg, "device"), param: intArg(msg, "param"),
    min: typeof msg.min === "number" ? clamp(msg.min, 0, 1) : 0,
    max: typeof msg.max === "number" ? clamp(msg.max, 0, 1) : 1,
    paramName: str(p, "name"), deviceName: str(d, "name"), trackName: str(obj(trackPath(msg.track)), "name")
  };
  var next = [];
  for (var k = 0; k < mappings.length; k++) {
    var o = mappings[k];
    if (!(o.macro === m.macro && String(o.track) === String(m.track) && o.device === m.device && o.param === m.param)) next.push(o);
  }
  var max = parseInt(CFG.maxMappings, 10);
  if (max > 0 && next.length >= max) throw new Error("too many mappings (m4l.maxMappings " + max + ")");
  next.push(m);
  mappings = next;
  saveMappings();
  applyMappings(i);
  mappingsReply();
}

function unmapMacro(msg) {
  var i = macroIndex(msg), hasTarget = msg.track !== undefined, next = [];
  for (var k = 0; k < mappings.length; k++) {
    var o = mappings[k];
    var match = o.macro === i && (!hasTarget ||
      (String(o.track) === String(normRef(msg.track)) && o.device === parseInt(msg.device, 10) && o.param === parseInt(msg.param, 10)));
    if (!match) next.push(o);
  }
  mappings = next;
  saveMappings();
  mappingsReply();
}

function deviceInfo() {
  var info = { ready: deviceIsReady, macros: [], mappings: mappings.length };
  var n = macroCount();
  for (var i = 0; i < n; i++) {
    var mc = macroConfig(i), v = macroValues[i];
    info.macros.push({ index: i, name: mc.name, min: mc.min, max: mc.max,
      value: v === undefined ? null : v, normalized: v === undefined ? null : normalize(v, mc.min, mc.max) });
  }
  if (deviceIsReady) {
    try {
      var dev = obj("this_device");
      info.deviceName = str(dev, "name");
      var path = String(dev.unquotedpath || dev.path || "").replace(/"/g, "");
      info.devicePath = path;
      var m = /^live_set (tracks|return_tracks) (\d+)/.exec(path);
      var ref = m ? (m[1] === "tracks" ? parseInt(m[2], 10) : "r" + m[2]) : (/^live_set master_track/.test(path) ? "master" : null);
      if (ref !== null) info.track = { ref: ref, kind: trackKind(ref), index: m ? parseInt(m[2], 10) : null, name: str(obj(trackPath(ref)), "name") };
      var app = obj("live_app");
      info.liveVersion = [app.call("get_major_version"), app.call("get_minor_version"), app.call("get_bugfix_version")].join(".");
    } catch (e) {
      info.error = e.message;
    }
  }
  outlet(0, "deviceinfo", JSON.stringify(info));
}

// [live.thisdevice] bangs once the LiveAPI is usable.
function deviceready() {
  deviceIsReady = true;
  for (var i = 0; i < macroValues.length; i++) applyMappings(i);
}

// ---------------------------------------------------------------- dispatcher
function live(type, json) {
  var msg = {};
  try {
    msg = json ? JSON.parse(json) : {};
  } catch (e) {
    outlet(0, "liveerror", "bad json for " + type);
    return;
  }
  if (msg.cfg) CFG = msg.cfg;
  currentRequestId = msg.requestId;
  try {
    switch (type) {
      case "LIVE_GET_SET":
        outlet(0, "liveinfo", JSON.stringify(withRequestId(setInfo())));
        break;
      case "LIVE_FIRE_CLIP":
        obj("live_set tracks " + intArg(msg, "track") + " clip_slots " + intArg(msg, "scene")).call("fire");
        break;
      case "LIVE_STOP_CLIP":
        obj("live_set tracks " + intArg(msg, "track") + " clip_slots " + intArg(msg, "scene")).call("stop");
        break;
      case "LIVE_STOP_TRACK":
        obj(trackPath(msg.track)).call("stop_all_clips");
        break;
      case "LIVE_FIRE_SCENE":
        obj("live_set scenes " + intArg(msg, "scene")).call("fire");
        break;
      case "LIVE_STOP_ALL":
        obj("live_set").call("stop_all_clips");
        break;
      case "LIVE_GET_SONG":
        reply("LIVE_SONG_INFO", { song: songInfo() });
        break;
      case "LIVE_SET_SONG":
        setSong(msg);
        break;
      case "LIVE_SONG_ACTION":
        songAction(msg);
        break;
      case "LIVE_GET_TRACKS":
        reply("LIVE_TRACKS_INFO", allTracks(true));
        break;
      case "LIVE_GET_TRACK":
        reply("LIVE_TRACK_INFO", { track: trackInfo(msg.track, true) });
        break;
      case "LIVE_SET_TRACK":
        setTrack(msg);
        break;
      case "LIVE_SET_MIXER":
        applyParam(obj(mixerParamPath(msg.track, msg.param, msg.send)), msg);
        break;
      case "LIVE_GET_DEVICES":
        reply("LIVE_DEVICES", { track: normRef(msg.track), devices: deviceList(msg.track) });
        break;
      case "LIVE_GET_DEVICE": {
        var dPath = devicePath(msg), dev = obj(dPath), info = deviceSummary(trackPath(msg.track), intArg(msg, "device"));
        var total = dev.getcount("parameters"), n = limit(total, CFG.maxParams);
        info.track = normRef(msg.track);
        info.device = info.index;
        info.parameters = [];
        info.truncated = n < total;
        for (var p = 0; p < n; p++) info.parameters.push(paramInfo(obj(dPath + " parameters " + p), p));
        reply("LIVE_DEVICE_INFO", info);
        break;
      }
      case "LIVE_GET_PARAM": {
        var pi = paramInfo(obj(paramPath(msg)), intArg(msg, "param"));
        pi.track = normRef(msg.track);
        pi.device = intArg(msg, "device");
        pi.param = pi.index;
        reply("LIVE_PARAM_INFO", pi);
        break;
      }
      case "LIVE_SET_PARAM":
        applyParam(obj(paramPath(msg)), msg);
        break;
      case "LIVE_SET_DEVICE_ACTIVE":
        // Parameter 0 of every Live device is "Device On"; is_active itself is read-only.
        obj(devicePath(msg) + " parameters 0").set("value", msg.active ? 1 : 0);
        break;
      case "LIVE_OBSERVE":
        observe(msg);
        break;
      case "LIVE_UNOBSERVE":
        unobserve(msg);
        break;
      case "M4L_DEVICE_INFO":
        deviceInfo();
        break;
      case "M4L_SET_MACRO":
        setMacro(msg);
        break;
      case "M4L_MAP_MACRO":
        mapMacro(msg);
        break;
      case "M4L_UNMAP_MACRO":
        unmapMacro(msg);
        break;
      case "M4L_LIST_MAPPINGS":
        mappingsReply();
        break;
      default:
        fail(type, "unknown request");
    }
  } catch (err) {
    fail(type, err.message);
  }
  currentRequestId = undefined;
}

function withRequestId(payload) {
  if (currentRequestId !== undefined) payload.requestId = currentRequestId;
  return payload;
}
