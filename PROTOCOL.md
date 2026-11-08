# JamConnect-Link protocol (JCL/1)

JamConnect-Link layers the JamConnect message protocol on top of an
**unmodified Ableton Link session**. Ableton Live (and any other Link app)
never sees JamConnect traffic: the `jamlink-bridge` process is an ordinary
Link peer built from the Ableton Link sources, so tempo, beat phase and
start/stop stay native Link. JamConnect apps talk JSON to the bridge, either
directly (localhost WebSocket) or through a JamConnect WebRTC host.

```
 Ableton Live ──(Link UDP multicast)── jamlink-bridge ──ws://127.0.0.1:20809── web app / Max for Live / any JamConnect app
                                              │
                                              └── JamConnect WebRTC host (web app, "attach bridge")
                                                        │  PeerJS data channels (connect service)
                                                        ├── remote guest (phone, other JamConnect apps)
                                                        └── remote guest
```

## Transports

| Mode | Upstream of the app | How to connect |
|------|--------------------|----------------|
| **Local** | the bridge itself | `connector.joinLocalBridge('ws://127.0.0.1:20809', token)` |
| **WebRTC host** | the bridge (optional) | `connector.createHostSession()` + `connector.attachLocalBridge(url, token)` |
| **WebRTC guest** | the WebRTC host | `connector.joinHost(inviteUrl)` (unchanged JamConnect flow) |

Every connection carries the same JSON objects (`{ "type": ..., ... }`).
Over WebSocket each message is one text frame. Over WebRTC it is one PeerJS
`json` message.

## Session / auth (unchanged JamConnect)

`AUTH_HELLO {authToken, name, appName}` → `AUTH_OK {sessionId, peerId, permissions, ...}`
or `AUTH_REJECTED {reason}`. The bridge's session id is `LINK-<port>`. When the
bridge runs with `--token`, the token is required. Without one, any local
client is accepted.

`PING`/`PONG`/`CLOCK_SYNC` and `PEER_LIST` work as in JamConnect, so existing
JamConnect apps see the bridge as a normal host.

## Clock synchronisation (Link measurement algorithm)

Each node has a **node clock** in microseconds:

* the bridge: Link's own clock (`link.clock().micros()`), the clock all Link
  timelines refer to.
* a browser / Node / Max client: `performance.now() * 1000`.

A downstream node estimates `offset = upstreamClock - localClock` with the same
exchange Link uses between peers (`ableton/link/Measurement.hpp`):

```
client → LINK_PING { ht: <local µs at send>, pgt: <gt from previous pong or 0> }
server → LINK_PONG { gt: <server µs at receipt>, ht: <echo>, pgt: <echo> }
client on receipt at local time now:
    data += gt - (now + ht) / 2
    if pgt: data += (gt + pgt) / 2 - ht
```

The client sends a ping every `client.linkClock.pingSpacingMs` until it has
`measurePoints` data points. The offset is their **median**. Bursts repeat every
`remeasureMs`. The first estimate is published after `minPoints` points so the UI
can lock on quickly (defaults in `jamconnect.config.json`: 25 ms, 100, 5 s, 6). Any
JamConnect node answers `LINK_PING`, so the same code runs over WebSocket and WebRTC.

Like Link and NTP, the exchange assumes equal delay in both directions. Jitter is
filtered by the median. A *constant* asymmetry between the up and down paths
shows up as an offset error of half the difference. On localhost and LAN this is
negligible. Over the internet it bounds WebRTC guest accuracy.

## Timeline state

`LINK_STATE` is sent by whoever is upstream (the bridge at 10 Hz and on every
Link change; a WebRTC host re-sends what it receives). All times are in the
**sender's node clock**. The receiver converts them with `local = remote - offset`.

```json
{
  "type": "LINK_STATE",
  "tempo": 120.0,          // session tempo (BPM)
  "beat": 1234.567,        // beat at atUs for quantum
  "atUs": 98765432100,     // sender clock
  "quantum": 4,
  "phase": 2.567,          // informative; recompute locally
  "isPlaying": true,
  "playTimeUs": 98760000000, // sender clock: when transport started or stops
  "playBeat": 1220.0,      // beat at playTimeUs ("song position" = beat - playBeat)
  "numPeers": 2,           // Link peers seen by the bridge (Live counts as 1)
  "linkEnabled": true,
  "startStopSync": true,
  "source": "bridge"       // "bridge" | "host" (pure JamConnect session, no Link)
}
```

`beatAtTime(t) = beat + (t - atUs) * tempo / 60e6`, phase is
`beatAtTime(t) mod quantum`. These are the same formulas as Link's `Timeline`.

## Control (downstream → upstream)

| Message | Effect at the bridge (Link API) |
|---------|--------------------------------|
| `LINK_SET_TEMPO {bpm}` | `sessionState.setTempo(bpm, now)` |
| `LINK_SET_PLAYING {playing, quantum?}` | `setIsPlayingAndRequestBeatAtTime(true, now, 0, q)` or `setIsPlaying(false, now)` |
| `LINK_REQUEST_BEAT {beat, quantum?}` | `requestBeatAtTime(beat, now, q)` (quantized, Link-friendly) |
| `LINK_ENABLE {enabled}` | `link.enable()` |
| `LINK_START_STOP_SYNC {enabled}` | `link.enableStartStopSync()` |
| `LINK_GET_STATE {}` | replies with `LINK_STATE` |

Legacy JamConnect `TRANSPORT_STATE` (`started` / `stopped` / `bpmchanged`) is
mapped onto the same calls. In the other direction, the bridge emits
`TRANSPORT_STATE` whenever Link's tempo or start/stop changes, so apps that only
know Tone.js transport messages follow Ableton too.

A WebRTC host forwards guest control messages to the bridge only if the guest
has the permission: `syncMasterSettings` for tempo and `syncTransport` for
start/stop.

## Musical traffic

All other JamConnect messages (`MIDI_EVENT`, `PAD_PLAY`,
`DEVICE_PARAMETER_CHANGE(S)`, `MASTER_SETTING_UPDATE`, `PATTERN_*`,
`FULL_STATE_SYNC`) are relayed by the bridge to every other client, and by a
WebRTC host between guests and the bridge. This is how a phone on WebRTC can
play an instrument inside Ableton through the Max for Live device.

`MIDI_EVENT.event` = `{ kind: "noteon"|"noteoff"|"cc", note|cc, velocity|value, channel }`.

## Timing rules (Link owns musical timing)

The library adds no musical delays of its own. Every timing comes from Link or
from a measurement:

* **Start / stop / tempo** inside a session always go through the Link timeline
  (`LINK_SET_PLAYING` / `LINK_SET_TEMPO`). With peers present, a start lands on the
  next quantum boundary, like Link's `requestBeatAtStartPlayingTime`. Tone.js
  follows the timeline (`client.followLink`, default `true`). Joining a playing
  session starts phase-aligned at the audio engine's own lookahead.
* **`PAD_PLAY.linkBeat`**: the Link beat the pad sounds on. Receivers schedule it
  at that beat on their own timeline, so every peer plays it at the same Link
  moment. Snapped pads (snap strength > 0) go forward to the next 1/16 grid point
  that the session can still reach, using the **measured** one-way latency (half
  the median RTT from the Link clock measurement). Unsnapped pads and messages
  without `linkBeat` play on arrival. `delayFromSendMs` is still sent for older
  receivers.
* Legacy `TRANSPORT_STATE` / `TRANSPORT_HEARTBEAT` are ignored for timing whenever
  a Link timeline exists. A host without a bridge still emits them for older
  JamConnect builds, with `delaySec` taken from the Link start time.
* The only 500 ms in the system is Link's own `SESSION_EPS` (when two Link sessions
  meet, the older one wins only if it is more than 500 ms older). It belongs to Link
  and is not changed.

## Ableton Live control (Max for Live device)

The Max for Live device "JamConnect Link" (`m4l/`) is an ordinary bridge client. Its Node for Max
script (`jamconnect-m4l.js`) talks JSON to the bridge, its classic Max `[js]` (`jamconnect-live.js`,
ES5) works on the Live Object Model. The bridge needs no special support: every message type it
does not handle itself is relayed to all other clients (`main.cpp`, the final `else` of `onMessage`),
and a WebRTC host relays the same messages between its guests and the bridge.

### Link first, LiveAPI for the rest

Tempo, beat/phase and start/stop are **Link** state. Live is a Link peer, so they travel through the
bridge's Link peer (`LINK_SET_TEMPO`, `LINK_SET_PLAYING`, `LINK_REQUEST_BEAT`, `LINK_STATE`) and never
through the LiveAPI. To make that hard to get wrong, the device's node script translates the
LiveAPI-shaped requests that Link covers before they reach the LiveAPI:

| Request | Sent to the bridge instead |
|---------|---------------------------|
| `LIVE_SET_SONG {prop: "tempo", value}` | `LINK_SET_TEMPO {bpm: value}` |
| `LIVE_SET_SONG {prop: "is_playing", value}` | `LINK_SET_PLAYING {playing}` |
| `LIVE_SONG_ACTION {action: "start" \| "stop", quantum?}` | `LINK_SET_PLAYING {playing, quantum?}` |

The LiveAPI side refuses `tempo` / `is_playing` writes with `LIVE_ERROR` if they arrive some other way.
Everything Link cannot express goes through the LiveAPI: continue from the current position, tap tempo,
record/overdub/metronome/loop, undo/redo, capture MIDI, clips, scenes, mixer, devices, parameters.
`continue` and `tap_tempo` change Live's transport/tempo, and Live then publishes the result on Link.
The song's `tempo` and `is_playing` are still *reported* (`LIVE_SONG_INFO`, `LIVE_SONG_CHANGED`), but
apps should show the Link values as the truth. Turn on **Link** and **Start Stop Sync** in Live's
Preferences > Link, Tempo & MIDI.

### Addressing

* **Track reference** (`track`): a number `N` = `live_set tracks N`, `"rN"` = `live_set return_tracks N`,
  `"master"` = `live_set master_track`. Clip/scene requests (`LIVE_FIRE_CLIP`, `LIVE_STOP_CLIP`) use normal
  track indexes only.
* **`requestId`** (optional, any JSON value): echoed in the reply and in `LIVE_ERROR` / `M4L_ERROR`.
* **`target`** (optional): a device instance id (see M4L below). Several devices can be loaded at once.
  An untargeted `LIVE_*` request is handled by one device only, the **primary**: the connected device with
  the lowest instance id (devices learn about each other from `M4L_HELLO` / `M4L_STATUS` / `M4L_BYE` and
  forget silent ones after `m4l.peerTimeoutMs`). `target: "<id>"` sends a request to that device.
* Replies and events carry `instance` (the device that produced them). The bridge adds `from`.
* Setters do not reply. Their effect comes back as an observer event (if observed) or with the next `GET`.
* Limits come from the `m4l` config section and are sent to the LiveAPI side with every request
  (`cfg`): `maxTracks`, `maxScenes`, `maxReturns`, `maxSends`, `maxDevices`, `maxParams`, `maxObservers`,
  `observerIntervalMs`.

### Requests, LiveAPI paths and replies

`S` = `live_set`, `T` = the track path from the track reference.

| Request | LiveAPI | Reply / effect |
|---------|---------|----------------|
| `LIVE_GET_SET {}` | `S` (tracks, return_tracks, master_track, scenes, clip_slots, clip, mixer_device) | `LIVE_SET_INFO` (below) |
| `LIVE_FIRE_CLIP {track, scene}` | `S tracks T clip_slots S fire` | - |
| `LIVE_STOP_CLIP {track, scene}` | `S tracks T clip_slots S stop` | - |
| `LIVE_STOP_TRACK {track}` | `T stop_all_clips` | - |
| `LIVE_FIRE_SCENE {scene}` | `S scenes N fire` | - |
| `LIVE_STOP_ALL {}` | `S stop_all_clips` | - |
| `LIVE_GET_SONG {}` | `S` properties | `LIVE_SONG_INFO {song: {...}}` |
| `LIVE_SET_SONG {prop, value}` | `S set <prop>` | - (tempo / is_playing go to Link, see above) |
| `LIVE_SONG_ACTION {action, ...}` | `S call <function>` | - |
| `LIVE_GET_TRACKS {}` | `S tracks / return_tracks / master_track` | `LIVE_TRACKS_INFO {tracks, returns, master}` |
| `LIVE_GET_TRACK {track}` | `T` | `LIVE_TRACK_INFO {track}` |
| `LIVE_SET_TRACK {track, prop, value}` | `T set name \| color \| mute \| solo \| arm` | - |
| `LIVE_SET_MIXER {track, param, send?, value \| normalized \| real}` | `T mixer_device volume \| panning \| sends N` → `set value` | - |
| `LIVE_GET_DEVICES {track}` | `T devices N` | `LIVE_DEVICES {track, devices}` |
| `LIVE_GET_DEVICE {track, device}` | `T devices D` + `parameters P` | `LIVE_DEVICE_INFO` |
| `LIVE_GET_PARAM {track, device, param}` | `T devices D parameters P` | `LIVE_PARAM_INFO` |
| `LIVE_SET_PARAM {track, device, param, value \| normalized \| real}` | `T devices D parameters P set value` | - |
| `LIVE_SET_DEVICE_ACTIVE {track, device, active}` | `T devices D parameters 0 set value 0/1` ("Device On"; `is_active` is read-only) | - |
| `LIVE_OBSERVE {scope, track?, device?}` | `new LiveAPI(callback, path)`, `property = <prop>` | `LIVE_OBSERVING` |
| `LIVE_UNOBSERVE {scope, track?, device?}` / `{all: true}` | `property = ""` | `LIVE_OBSERVING` |

**Song properties** (`LIVE_SONG_INFO.song`, `LIVE_SET_SONG.prop`): `tempo`*, `is_playing`*, `record_mode`,
`metronome`, `overdub`, `session_record`, `session_automation_record`, `loop`, `loop_start`, `loop_length`,
`current_song_time`, `start_time`, `signature_numerator`, `signature_denominator`, `groove_amount`, `swing_amount`,
`clip_trigger_quantization`, `midi_recording_quantization`, `punch_in`, `punch_out`, `back_to_arranger`, and the
read-only `can_undo`, `can_redo`, `can_capture_midi`, `is_counting_in`, `is_ableton_link_enabled`,
`is_ableton_link_start_stop_sync_enabled` (* = Link).

**Song actions** (`LIVE_SONG_ACTION.action`): `start`*, `stop`*, `continue` (`continue_playing`), `undo` / `redo`
(skipped when `can_undo` / `can_redo` is 0), `tap_tempo`, `capture_midi {destination?: 0 auto, 1 session, 2 arrangement}`,
`back_to_arranger` (sets `back_to_arranger` to 0), `stop_all_clips {quantized?: bool}`, `jump_by {beats}`,
`jump_to_next_cue`, `jump_to_prev_cue`, `re_enable_automation`, `trigger_session_record {length?}`,
`capture_and_insert_scene`, `set_or_delete_cue`.

**Values.** Every parameter write accepts one of `real` (the parameter's own unit, clamped to `min..max`),
`normalized` (0..1), or `value`. For backward compatibility `value` in `LIVE_SET_PARAM` / `LIVE_SET_MIXER` is
**normalized** 0..1, as in the original protocol.

```
normalized = clamp((value - min) / (max - min), 0, 1)          (0 when max == min)
value      = min + clamp(normalized, 0, 1) * (max - min)       (rounded when is_quantized)
real       = clamp(real, min, max)                             (rounded when is_quantized)
```

**Parameter info** (`LIVE_DEVICE_INFO.parameters[]`, `LIVE_PARAM_INFO`, mixer params):
`{index, name, originalName, value, min, max, normalized, isQuantized, isEnabled, display, valueItems? | defaultValue?}`.
`display` is `str_for_value(value)` (e.g. "-6.0 dB"). Quantized parameters carry `valueItems` (their entries
correspond to `min`, `min+1`, ...), continuous ones `defaultValue`.

**Device info** (`LIVE_DEVICES.devices[]`, `LIVE_DEVICE_INFO`): `{index, name, className, classDisplayName,
deviceType, isActive, canHaveChains, numParams}`; `LIVE_DEVICE_INFO` adds `track`, `device`, `parameters`
(at most `m4l.maxParams`) and `truncated`.

**Track info** (`LIVE_TRACKS_INFO`, `LIVE_TRACK_INFO`, `LIVE_SET_INFO`): `{ref, kind: "track"|"return"|"master",
name, color, mute?, solo?, canBeArmed?, arm?, hasMidiInput?, playingSlot?, firedSlot?, mixer: {volume, panning,
sends[]}, devices: [names]}`. Master has no mute/solo; only normal tracks have arm and slot indexes.

**`LIVE_SET_INFO`** keeps the original fields, `tracks: [{name, clips: [bool]}]`, `scenes: [name]` and `tempo`,
and adds per track the track info above plus `slots: [{hasClip, name?, color?, isPlaying?, isTriggered,
isRecording?}]`, and `returns`, `master`, `sceneInfo: [{name, color, isTriggered}]`, `song`.

### Observers and events

`LIVE_OBSERVE` scopes and what they observe:

| Scope | Group key | Observed (LiveAPI path, property) | Event |
|-------|-----------|-----------------------------------|-------|
| `song` | `song` | `S` song properties except `current_song_time` (poll it), `can_undo`, `can_redo` | `LIVE_SONG_CHANGED {prop, value}` |
| | | `S` children `tracks`, `return_tracks`, `scenes` | `LIVE_SET_CHANGED {what}` |
| `track {track}` | `track:<ref>` | `T` `name`, `color`, `mute`, `solo`, `arm`, `playing_slot_index`, `fired_slot_index`; `T mixer_device volume / panning / sends N` `value` | `LIVE_TRACK_CHANGED {track, prop, value, normalized?, display?, send?}` |
| `tracks` | one `track:<ref>` group per track, return and master | as `track` | as `track` |
| `device {track, device}` | `device:<ref>:<index>` | `T devices D` `is_active`, `name` | `LIVE_DEVICE_CHANGED {track, device, prop, value}` |
| | | `T devices D parameters P` `value` | `LIVE_PARAM_CHANGED {track, device, param, value, normalized, display}` |

* Events fire only when a value really changes (the initial notification is suppressed).
* **Rate limit:** at most one event per key (e.g. one parameter) per `m4l.observerIntervalMs`. The first change
  after a quiet period is sent at once, later ones in the same window are coalesced and the newest value is
  sent at the end of the window.
* **Cap:** at most `m4l.maxObservers` LiveAPI observers in total. Adding a group that does not fit evicts the
  oldest groups first (never `song`). A single group larger than the cap is cut (`truncated: true`).
  Re-observing a group refreshes it.
* `LIVE_OBSERVING {groups: [key], observers, maxObservers, evicted: [key], truncated}` answers both
  `LIVE_OBSERVE` and `LIVE_UNOBSERVE`.
* When tracks, return tracks or scenes are added/removed, index-based groups would point at the wrong
  objects, so the device sends `LIVE_SET_CHANGED {what}` and drops every `track:` / `device:` group
  (`song` stays). Clients re-fetch and re-observe.
* Observers are shared by all clients of the device; any client can drop a group another client uses.

Errors: `LIVE_ERROR {message, request?, requestId?, instance}`.

## Max for Live device (M4L_*)

Every device instance has an **instance id** (`m4l-<8 hex>`, new each time the device loads). `M4L_*`
requests carry `target` (an instance id) or omit it / use `"*"` to reach every device. Replies carry
`instance` and echo `requestId`.

| Message | Direction | Meaning |
|---------|-----------|---------|
| `M4L_DISCOVER {}` | app → devices | every device answers `M4L_HELLO` |
| `M4L_HELLO {...status}` | device → all | on connect and on `M4L_DISCOVER` |
| `M4L_STATUS {...status}` | device → all | every `m4l.statusIntervalMs`, and on `M4L_GET_STATUS` / `M4L_SET_MIDI_FORWARD` |
| `M4L_GET_STATUS {target?}` | app → device | → `M4L_STATUS` |
| `M4L_BYE {instance}` | device → all | the device disconnects |
| `M4L_SET_MACRO {target?, macro, value \| normalized}` | app → device | sets the macro dial (a real Live parameter, so it can be automated); `value` is in the macro's range |
| `M4L_MACRO_CHANGED {instance, macro, value, normalized}` | device → all | any macro change (controller, mouse, automation, MIDI map), at most one per macro per `m4l.macroIntervalMs` (newest value wins) |
| `M4L_MAP_MACRO {target?, macro, track, device, param, min?, max?}` | app → device | maps the macro to a Live parameter; `min`/`max` = normalized range of the target (default 0..1, `min > max` inverts) → `M4L_MAPPINGS` |
| `M4L_UNMAP_MACRO {target?, macro, track?, device?, param?}` | app → device | removes one mapping, or every mapping of the macro when no target is given → `M4L_MAPPINGS` |
| `M4L_LIST_MAPPINGS {target?}` | app → device | → `M4L_MAPPINGS` |
| `M4L_MAPPINGS {instance, mappings: [{macro, track, device, param, min, max, trackName, deviceName, paramName}], maxMappings}` | device → all | |
| `M4L_NOTE {target?, note, velocity, channel?, durationMs?, off?}` | app → device | note into the device's MIDI out (the instrument after it). `durationMs` defaults to `m4l.noteDurationMs`, capped at `m4l.noteMaxDurationMs`; `durationMs: 0` holds the note until a `velocity: 0` / `off` message |
| `M4L_CC {target?, cc, value, channel?}` | app → device | CC into the device's MIDI out |
| `M4L_SET_MIDI_FORWARD {target?, enabled}` | app → device | switch forwarding of the track's MIDI as `MIDI_EVENT` (default `m4l.forwardTrackMidi`) |
| `M4L_ERROR {instance, message, request?, requestId?}` | device → all | |

**Status** (`M4L_HELLO` / `M4L_STATUS`): `{instance, name, appName, connected, primary, ready, forwardMidi,
deviceName, track: {ref, kind, index, name}, liveVersion, macros: [{index, name, min, max, value, normalized}],
mappings, limits}`. `track` comes from `this_device`'s canonical path (the device may sit inside a rack),
`liveVersion` from `live_app` `get_major/minor/bugfix_version`, `ready` is true once `[live.thisdevice]` has
fired (the LiveAPI can be used). `limits` repeats the device's `m4l` config limits.

**Macros.** `m4l.macroCount` `live.dial` objects generated by `build_device.py`; names, short names and ranges
come from `m4l.macros[i] = {name, shortName, min, max, initial?}`. Mapping math, with `n` the macro's normalized
value: `target = clamp(map.min + n * (map.max - map.min), 0, 1)`, then the parameter is set to
`min + target * (max - min)` (rounded when quantized).

**Mapping persistence.** Mappings are stored in a hidden `pattr` (`jc_mappings`) with parameter mode on and
type *blob* (`parameter_type 3`, `parameter_invisible 1`). Live saves blob parameters with the Live set (and
device presets), so mappings survive reloads per device instance, unlike a `dict @embed` (saved into the
device file, shared by every instance) or a JSON file next to the device (shared, and lost when frozen).
The value is URI-encoded JSON so no Max atom parsing (commas, spaces) can split it. At most `m4l.maxMappings`.

**Track MIDI.** Notes and CCs played on the device's track are sent as `MIDI_EVENT` with `instance` while
forwarding is on. Notes/CCs from `MIDI_EVENT` (any app) and `M4L_NOTE` / `M4L_CC` go to the device's MIDI out.

## Permissions for WebRTC guests

A WebRTC host relays a guest's `LIVE_*` / `M4L_*` request to the bridge only if the guest has the needed
permission (`jamRemoteControlPermission()` in `jamconnect.js`). Otherwise the guest gets `LIVE_ERROR` /
`M4L_ERROR` naming the permission. Local bridge clients have every permission.

| Requests | Permission |
|----------|-----------|
| `LIVE_GET_*`, `LIVE_OBSERVE`, `LIVE_UNOBSERVE`, `M4L_DISCOVER`, `M4L_GET_STATUS`, `M4L_LIST_MAPPINGS` | none (read-only) |
| `LIVE_SET_SONG` tempo | `syncMasterSettings` |
| `LIVE_SET_SONG` is_playing, `LIVE_SONG_ACTION` start / stop / continue | `syncTransport` |
| `LIVE_SET_PARAM`, `LIVE_SET_DEVICE_ACTIVE`, `M4L_SET_MACRO`, `M4L_MAP_MACRO`, `M4L_UNMAP_MACRO` | `syncDeviceParameterChange` |
| `M4L_NOTE`, `M4L_CC`, `M4L_SET_MIDI_FORWARD` | `syncMidi` |
| every other `LIVE_*` / `M4L_*` (clips, scenes, mixer, tracks, song settings and actions) | `syncLiveControl` (on by default, so existing guests can still launch clips) |

## Web apps served by the bridge

`bridge.static` lists static roots relative to the config file. An entry `"/prefix=dir"` serves `dir` under the
URL path `/prefix/`. The shipped config serves `webapp/` and `JamConnect/` at `/` and `apps/` at `/apps/`:
`/apps/live-control/` and `/apps/m4l-controller/`. A URL ending in `/` serves that directory's
`index.html`; a URL whose last segment has no `.` is redirected (301) to the same URL with a trailing `/`.
