# JamConnect · Link

Control and sync **Ableton Live** from any **JamConnect** app, over **localhost** or **WebRTC**.

JamConnect's protocol runs *on top of* [Ableton Link](https://github.com/Ableton/link).
`jamlink-bridge` is built from the full Link source tree and joins the Link session
as an ordinary peer, so Live and every other Link app keep working unchanged. JamConnect apps
connect to the bridge and get the Link timeline, Link-grade clock sync, and tempo /
start-stop control. A Max for Live device adds clip, scene and parameter control plus MIDI
in both directions.

```
Ableton Live ──Link── jamlink-bridge ──ws://localhost── web app · Max for Live device · JamConnect apps
                             │
                             └── web app (WebRTC host) ══PeerJS/WebRTC══ phones · remote JamConnect apps
```

| Part | Path | What it does |
|------|------|--------------|
| Bridge | `bridge/` | C++17 Link peer + WebSocket/HTTP server speaking JamConnect (JCL/1) |
| Library | `JamConnect/jamconnect.js` | JamConnect + Link timeline, Link clock sync, local and WebRTC transports |
| Web app | `webapp/` | Connect (Local / WebRTC host / WebRTC join), tempo, play, phase, metronome, pads, Live clip grid |
| Max for Live | `m4l/` | MIDI effect: Live MIDI ↔ JamConnect, LiveAPI control (song, tracks, mixer, clips, devices, params, observers), macros + mappings |
| Live Control | `apps/live-control/` | Browser app: Link header, session grid, mixer, song controls, device/parameter browser, MIDI learn |
| M4L Controller | `apps/m4l-controller/` | Browser app: pick a Max for Live device, macro dials + mapping editor, Link-quantized pads/keyboard, CC faders, MIDI monitor |
| Protocol | `PROTOCOL.md` | Message spec, including the clock sync algorithm |
| Tests | `tests/` | `integration.mjs` (CI, real headless Link peer + bridge), `webrtc-sync.mjs`, `live-control.mjs`, `m4l-controller.mjs` (pure Node) |

## Download

Every push to `main` builds the bridge on Windows, macOS and Linux and runs the integration test
(**Actions → Build & test → Artifacts**). Pushing a tag `v*` attaches zips to a GitHub Release.
Each zip contains `jamlink-bridge`, `linkpeer` (a test peer), the web app and the Max for Live device.

## Use it

1. **In Live:** Preferences → Link, Tempo & MIDI → turn on **Link** and **Start Stop Sync**.
2. **Run the bridge:**
   ```
   jamlink-bridge
   ```
   It reads `jamconnect.config.json` from its own folder (or `--config <file>`). Flags override single
   values: `--port`, `--bind 0.0.0.0` (allow LAN devices), `--token SECRET`, `--quantum`, `--bpm`,
   `--static <dir>`. Live now shows one more Link peer.
3. **Open the web app** at the address the bridge prints (`http://<bind>:<port>/`), or the GitHub Pages copy.
   * **LOCAL:** connect straight to the bridge. Tempo, play/stop and the phase bar now follow Live in both directions.
   * **WEBRTC HOST:** creates a JamConnect session (QR code / invite link) with the bridge attached. Remote
     guests are phase-locked to Live and can change tempo or start/stop if you allow it.
   * **WEBRTC JOIN:** join someone's session from anywhere.
4. **Max for Live (optional):** drop `m4l/JamConnectLink.amxd` on a MIDI track in front of an instrument
   (keep the two `.js` files next to it, then *Freeze Device* to embed them). Pads in the web app now play
   that instrument, the track's MIDI is sent to the other jammers, and the **Ableton Live set** panel can
   fire clips and scenes.
5. **Live Control / M4L Controller:** open `http://<bind>:<port>/apps/live-control/` or
   `http://<bind>:<port>/apps/m4l-controller/` (also linked from the main web app). See below.

## Live Control app

`apps/live-control/` is a plain browser app (HTML/CSS/JS, no build step). The bridge serves it at
`http://<bind>:<port>/apps/live-control/`; the Pages workflow deploys it to `<pages-url>/apps/live-control/`.
It never talks to Live or Max directly: Link state comes from the bridge's Link peer, everything else is
`LIVE_*` traffic the bridge relays to the Max for Live device (see [PROTOCOL.md](PROTOCOL.md)).

* **Connection:** on load it connects to the bridge that served the page (`/jamconnect.config.json`), or the
  configured / overridden bridge URL. If the bridge is unreachable it says so and retries every
  `client.bridgeRetryMs` (with a *Retry now* button). **WEBRTC HOST** creates a session with the bridge attached
  and relays it to remote guests; **WEBRTC JOIN** is for those guests. Guests are limited by the host's
  permissions (Tempo, Play/Stop, MIDI, Params, Live control); locked controls are disabled.
* **Link:** tempo (editable, nudge), play/stop, quantum, phase bar, beat, bar.beat, Link peers, source, clock
  offset and whether the clock measurement is ready.
* **Song:** continue, metronome, arrangement/session record, overdub, automation arm, loop (start/length),
  signature, groove, launch quantization, undo/redo, tap tempo, capture MIDI, back to arrangement, stop clips.
  Play/stop and tempo always go through Link.
* **Session:** clip grid with clip names/colors and playing/triggered state (live via observers), fire clips and
  scenes, stop tracks / slots / all.
* **Mixer:** every track, return track and the master: volume, pan, sends, mute/solo/arm, live-updating.
* **Devices & parameters:** pick a track (incl. returns/master), then a device: every parameter as a slider
  (quantized ones as a select with Live's value names), showing Live's display value, updated by observers,
  sent with `client.liveControl.paramSendIntervalMs` throttling. Device on/off, double-click for the default.
* **MIDI learn:** press LEARN on a parameter and move a CC on any JamConnect MIDI source (another app, or a
  Max for Live device forwarding its track MIDI). Mappings are saved in the browser's localStorage.

## M4L Controller app

`apps/m4l-controller/` (served at `/apps/m4l-controller/`, deployed to Pages like the others) controls the
"JamConnect Link" Max for Live device itself with the `M4L_*` messages:

* lists every device loaded in Live (one per track if you like: each has its own instance id, host track and
  Live version) and lets you pick one;
* **macro dials**, bidirectional: `m4l.macroCount` dials in the device are real Live parameters (names and
  ranges from `m4l.macros`), so they can be automated and MIDI-mapped in Live; changes from Live come back
  as `M4L_MACRO_CHANGED`, throttled by `m4l.macroIntervalMs`;
* **mapping editor:** browse track → device → parameter (with `LIVE_*` requests sent to the selected device)
  and map a macro to it with a range; several parameters per macro, inverted ranges allowed. Mappings are
  saved with the Live set (hidden blob parameter in the device);
* **pads and a keyboard** that send `M4L_NOTE` into the device's MIDI out (into the instrument after it),
  quantized to the Link grid (`client.m4lController.quantizeBeats`, or a bar = the Link quantum), with
  velocity, length and channel; **CC faders** (`client.m4lController.ccNumbers`);
* an **incoming MIDI monitor** (track MIDI forwarded by the devices as `MIDI_EVENT`, and other apps), plus the
  per-device forwarding switch (`m4l.forwardTrackMidi` is the default).

Quantized notes are sent at the grid time in the browser's Link-synchronised clock, so they reach Live one
network hop later (localhost: about a millisecond).

## Mod Device app

`apps/mod-device/` (served at `/apps/mod-device/`, deployed to Pages) turns a phone (or desktop) into a
**modulation source** for other JamConnect devices (e.g. the wavetable synth) and for Ableton, or both at once.

**Architecture.** All modulation math is **Rust compiled to WebAssembly** (`apps/mod-device/core-rs`, a
`cdylib` with a plain C ABI, no wasm-bindgen, no crates; fixed buffers allocated at init, no allocation in the
tick, `panic = "abort"`, seeded RNG). JavaScript is only the shell: UI, touch / DeviceMotion / Web MIDI / mic
capture, JamConnect messaging (`engine.js`) and the source-type metadata mirrored from the ABI (`schema.js`).
Every `client.modulator.tickIntervalMs` the shell calls `core_tick(linkBeat, tempo, quantum, now, dt, lead)`
and reads per-route breakpoint batches (Link beats, decimated) from a shared buffer. The core runs on the
**main thread**: touch / sensor events and the connection live there, one tick costs microseconds, and a worker
would only add `postMessage` hops and a second copy of the state.

* **Build.** CI only (job `mod-wasm`: `cargo test`, release build for `wasm32-unknown-unknown`, optional
  `wasm-opt`, then `tests/mod-device.mjs` against the real `.wasm`; artifact `mod-core-wasm`). Release packages
  and Pages include `apps/mod-device/engine/mod-core.wasm`; it is never committed (`.gitignore`). Without it the
  app says "core not built" and where to get it. Locally, `node tests/mod-device.mjs --mock` tests the shell
  with `tests/mod-core-mock.cjs` (same exports).
* **Sources.** Multi-touch XY pads and ribbons (position, pressure, touch radius, speed, finger count, pinch,
  rotate, swipe) with physics (spring back, inertia / throw, bounce, gravity; fixed timestep); device tilt
  (alpha / beta / gamma), acceleration, rotation rate, shake (calibration, inversion, dead zone, range,
  one-euro smoothing; iOS permission behind the MOTION button; desktop tilt simulator); LFOs (sine, tri, saw,
  ramp, square, S&H, smooth random, drawable) synced to the Link grid (1/32..32 bars, dotted / triplet) and
  phase-locked to the Link timeline, or free in Hz, with phase, fade-in and retrigger on bar / trigger;
  envelopes (ADSR / AHDSR / drawable multi-stage, times in beats or ms) triggered by touch, shake, MIDI notes
  (`MIDI_EVENT` or Web MIDI), Link beats or thresholds; step sequencer with glide; Euclidean triggers; Lorenz
  attractor and logistic map; random walk; Perlin noise; sample & hold of any source; mic envelope follower;
  bouncing ball; gravity well XY; MIDI CC / notes; macros (add, sub, multiply, min, max, average, crossfade,
  quantize, slew, curve, invert, scale).
* **Routes.** Up to `client.modulator.maxRoutes`: source → transform (depth, offset, polarity, response curve,
  quantize, slew, invert) → targets: a JamConnect instrument parameter (`JAM_PARAM_CURVE`, absolute or offset,
  also by name pattern), a Live device parameter (`LIVE_SET_PARAM`), an M4L macro (`M4L_SET_MACRO`, optionally
  `M4L_MAP_MACRO`), MIDI CC into the M4L device (`M4L_CC`), or this device's own parameters. **Learn**: wiggle a
  parameter in its own UI (`JAM_PARAM_CHANGED`, `LIVE_PARAM_CHANGED`, `M4L_MACRO_CHANGED`).
* **Sending.** Link-synced sources are rendered ahead (`curve.lookaheadMs`), realtime ones are stamped at
  now + measured one-way latency (`_sessionOneWayMs()`) + send interval + margin; curves are decimated with an
  error bound (`curve.tolerance`). Each target type has its own rate (`client.modulator.send.*`), Ableton
  traffic also shares a budget (`abletonMaxPerSecond`). `JAM_PARAM_TOUCH` on gesture start, `RELEASE` at the end;
  **HOLD** latches pads, **PANIC / FREEZE** releases everything and stops. WebRTC guests need the host's
  "Params / macros" (and "MIDI" for CC) permission.
* **Own manifest.** The device announces itself (`kind: "modulator"`), so LFO rates, depths etc. can be
  modulated or set remotely, and routes can target the device's own parameters.
* **Scenes.** Saved in localStorage, JSON import / export, factory examples (tilt filter sweep, shake to drop,
  Link-synced wobble, XY morph, Euclid pluck, chaos drift).

Sensors and touch need a real phone in a **secure context**: `http://localhost` (the bridge on the same
machine) counts as secure; LAN phones need https, e.g. the Pages deployment joining over WebRTC.

## Configuration

Everything that can be tuned lives in **`jamconnect.config.json`**. No component has its own
port, URL, tempo, timeout or ICE server built in:

| Section | Used by | Contents |
|---------|---------|----------|
| `bridge` | jamlink-bridge | bind, port, token, initial tempo (only used when no Link session exists), quantum, tempo range, start/stop sync, intervals, timeouts, message size limit, static web roots (`"/prefix=dir"` mounts a directory under a URL path, e.g. `/apps=apps`) |
| `client` | jamconnect.js, web apps | app name, bridge URL/token (empty URL = derived), bridge retry interval, follow-Link, quantum, timeouts, follower tuning, Link clock measurement (`linkClock`), `liveControl` and `m4lController` app settings (send throttles, pads, keyboard, CCs, quantize options, discovery interval), `modulator` (mod device: limits, per-target send rates, curve tolerance / lookahead / buffers, sensor, gesture and physics tuning, chaos constants, parameter ranges, UI) |
| `webrtc` | jamconnect.js, web app | PeerJS id prefixes, session/token lengths and alphabets, **ICE/TURN servers**, **PeerJS signaling server** (`signal`: host, port, path, secure, key) |
| `m4l` | Max for Live device | bridge URL/token (empty = from `bridge`), device name, reconnect delay, LiveAPI limits (tracks, scenes, returns, sends, devices, params, observers), observer rate limit, status interval and peer timeout, MIDI forwarding, note lengths, macros (count, names, ranges), mapping limit |

* The bridge requires every `bridge` key and refuses to start if one is missing.
* When the bridge serves the web app, it publishes `/jamconnect.config.json` with the client sections plus
  runtime facts (real port, session id, whether a token is required). The bridge token is never published.
* The web app's **Settings** panel overrides the bridge URL, signaling server and ICE servers per browser.
* `jamconnect.js` keeps fallback values identical to the shipped file, so existing JamConnect apps that
  never load a config keep working. Call `JamConnector.loadConfig()` or `JamConnector.configure(obj)` to
  use your own.
* `client.linkClock` follows Ableton Link's `Measurement.hpp` / `Sessions.hpp` exactly and ships Link's
  constants: 100 data points (median), 50 ms ping timeout, 5 timeouts, re-measure every 30 s.

## Using the library in your own JamConnect app

```js
const jc = new JamConnector('MyApp', Tone, { followLink: true });   // Tone.Transport follows Link

await jc.joinLocalBridge('ws://127.0.0.1:20809');                   // local mode
// or: await jc.createHostSession(); await jc.attachLocalBridge();   // WebRTC host relaying Link
// or: await jc.joinHost(inviteUrl);                                 // WebRTC guest

jc.onLinkStateUpdated = (s) => console.log(s.tempo, s.phase, s.isPlaying);
jc.setLinkTempo(128);
jc.setLinkPlaying(true);
const beat = jc.linkBeatAtTime(performance.now());
jc.sendMidiEvent({ kind: 'noteon', note: 36, velocity: 100, channel: 1 });
jc.sendRelayMessage({ type: 'LIVE_FIRE_SCENE', scene: 0 });
```

Existing JamConnect apps work without changes: the bridge speaks the original
`AUTH_*` / `PING` / `TRANSPORT_STATE` messages, and it emits `TRANSPORT_STATE` whenever Link's
tempo or start/stop changes.

## Build from source

```
git clone --recursive https://github.com/tessie1993/link-jam-connect
cmake -S bridge -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
node tests/webrtc-sync.mjs                                   # no binaries needed
node tests/live-control.mjs                                  # LiveAPI side + routing, mocked Max/Live
node tests/m4l-controller.mjs                                # M4L_* device protocol, mocked Max/Live
node tests/integration.mjs --bin build --config jamconnect.config.json
```

Needs CMake ≥ 3.16 and a C++17 compiler (MSVC, Clang, GCC or MinGW). `link/` is the Ableton Link
repository as a git submodule.

## License

Ableton Link is GPLv2+ (or a proprietary license from Ableton), so `jamlink-bridge` is distributed
under GPLv2+. See `link/LICENSE.md`.
