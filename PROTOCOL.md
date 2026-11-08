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

The procedure is Link's, step for step (`client.linkClock` ships Link's constants):

| Step | Link source | Config (value) |
|------|-------------|----------------|
| Next ping right after each pong, carrying the received `gt` as `pgt` | `Measurement.hpp:178-181` | none |
| Finish when there are **more than** N data points; offset = **median** | `Measurement.hpp:45,197`, `MeasurementService.hpp:171` | `numberDataPoints` (100) |
| No pong within the timeout: new ping with host time only | `Measurement.hpp:113-128` | `pingTimeoutMs` (50) |
| Fail after that many timeouts (count not reset by pongs) | `Measurement.hpp:46,122-131` | `numberMeasurements` (5) |
| Measure the session again periodically | `Sessions.hpp:186` | `remeasureMs` (30000) |

Nothing is published until a measurement completes, as in Link. If a measurement
fails before any estimate exists, a new one starts right away. Otherwise the previous
estimate is kept until the next scheduled measurement. Link's 50 ms timeout is meant
for a LAN: over internet WebRTC with round trips above 50 ms, measurements still
complete (pongs to timed-out pings are used too), but they take longer and fail more
often. Any JamConnect node answers `LINK_PING`, so the same code runs over WebSocket
and WebRTC.

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

The Max for Live device "JamConnect Link" is a bridge client. Its LiveAPI side
handles:

| Message | LiveAPI action |
|---------|----------------|
| `LIVE_GET_SET {}` | replies `LIVE_SET_INFO {tracks:[{name, clips:[bool...]}], scenes:[name...], tempo}` |
| `LIVE_FIRE_CLIP {track, scene}` | `live_set tracks T clip_slots S fire` |
| `LIVE_STOP_TRACK {track}` | `live_set tracks T stop_all_clips` |
| `LIVE_FIRE_SCENE {scene}` | `live_set scenes S fire` |
| `LIVE_STOP_ALL {}` | `live_set stop_all_clips` |
| `LIVE_SET_PARAM {track, device, param, value}` | `... devices D parameters P value` (normalized 0..1) |

Tempo and play/stop do not need the device: they travel through Link itself.
Turn on **Link** and **Start Stop Sync** in Live's Preferences > Link, Tempo & MIDI.
