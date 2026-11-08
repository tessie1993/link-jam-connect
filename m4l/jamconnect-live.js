// JamConnect Link — LiveAPI side (classic Max [js], ES5).
// Receives "live <TYPE> <json>" from the node.script and controls the Live set.
// Replies with "liveinfo <json>" / "liveerror <text>" back to the node.script.

autowatch = 1;
inlets = 1;
outlets = 1;

function api(path) {
  return new LiveAPI(path);
}

function first(v) {
  return (v && v.length !== undefined) ? v[0] : v;
}

// Limits come from jamconnect.config.json (m4l.maxTracks / maxScenes) via the node script.
function limit(count, max) {
  var m = parseInt(max, 10);
  return isNaN(m) || m <= 0 ? count : Math.min(count, m);
}

function getSetInfo(msg) {
  var set = api("live_set");
  var nTracks = limit(set.getcount("tracks"), msg.maxTracks);
  var nScenes = limit(set.getcount("scenes"), msg.maxScenes);
  var info = { tracks: [], scenes: [], tempo: Number(first(set.get("tempo"))) };

  for (var s = 0; s < nScenes; s++) {
    info.scenes.push(String(first(api("live_set scenes " + s).get("name")) || ""));
  }
  for (var t = 0; t < nTracks; t++) {
    var track = api("live_set tracks " + t);
    var clips = [];
    for (var c = 0; c < nScenes; c++) {
      clips.push(Number(first(api("live_set tracks " + t + " clip_slots " + c).get("has_clip"))) === 1);
    }
    info.tracks.push({ name: String(first(track.get("name")) || ("Track " + (t + 1))), clips: clips });
  }
  outlet(0, "liveinfo", JSON.stringify(info));
}

function intArg(msg, key) {
  var v = parseInt(msg[key], 10);
  if (isNaN(v) || v < 0) throw new Error("missing " + key);
  return v;
}

function live(type, json) {
  var msg = {};
  try {
    msg = json ? JSON.parse(json) : {};
  } catch (e) {
    outlet(0, "liveerror", "bad json for " + type);
    return;
  }
  try {
    switch (type) {
      case "LIVE_GET_SET":
        getSetInfo(msg);
        break;
      case "LIVE_FIRE_CLIP":
        api("live_set tracks " + intArg(msg, "track") + " clip_slots " + intArg(msg, "scene")).call("fire");
        break;
      case "LIVE_STOP_TRACK":
        api("live_set tracks " + intArg(msg, "track")).call("stop_all_clips");
        break;
      case "LIVE_FIRE_SCENE":
        api("live_set scenes " + intArg(msg, "scene")).call("fire");
        break;
      case "LIVE_STOP_ALL":
        api("live_set").call("stop_all_clips");
        break;
      case "LIVE_SET_PARAM": {
        var p = api("live_set tracks " + intArg(msg, "track") + " devices " + intArg(msg, "device") +
          " parameters " + intArg(msg, "param"));
        var lo = Number(first(p.get("min")));
        var hi = Number(first(p.get("max")));
        var v = Math.max(0, Math.min(1, Number(msg.value)));
        p.set("value", lo + v * (hi - lo));
        break;
      }
      default:
        outlet(0, "liveerror", "unknown " + type);
    }
  } catch (err) {
    outlet(0, "liveerror", type + ": " + err.message);
  }
}
