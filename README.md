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
| Max for Live | `m4l/` | MIDI effect: Live MIDI ↔ JamConnect, LiveAPI control (clips, scenes, params) |
| Protocol | `PROTOCOL.md` | Message spec, including the clock sync algorithm |
| Tests | `tests/integration.mjs` | CI end-to-end test against a real headless Link peer |

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

## Configuration

Everything that can be tuned lives in **`jamconnect.config.json`**. No component has its own
port, URL, tempo, timeout or ICE server built in:

| Section | Used by | Contents |
|---------|---------|----------|
| `bridge` | jamlink-bridge | bind, port, token, initial tempo (only used when no Link session exists), quantum, tempo range, start/stop sync, intervals, timeouts, message size limit, static web roots |
| `client` | jamconnect.js, web app | app name, bridge URL/token (empty URL = derived), follow-Link, quantum, timeouts, follower tuning, Link clock measurement (`linkClock`) |
| `webrtc` | jamconnect.js, web app | PeerJS id prefixes, session/token lengths and alphabets, **ICE/TURN servers**, **PeerJS signaling server** (`signal`: host, port, path, secure, key) |
| `m4l` | Max for Live device | bridge URL/token (empty = from `bridge`), device name, reconnect delay, LiveAPI limits, pad note length |

* The bridge requires every `bridge` key and refuses to start if one is missing.
* When the bridge serves the web app, it publishes `/jamconnect.config.json` with the client sections plus
  runtime facts (real port, session id, whether a token is required). The bridge token is never published.
* The web app's **Settings** panel overrides the bridge URL, signaling server and ICE servers per browser.
* `jamconnect.js` keeps fallback values identical to the shipped file, so existing JamConnect apps that
  never load a config keep working. Call `JamConnector.loadConfig()` or `JamConnector.configure(obj)` to
  use your own.
* `client.linkClock.pingSpacingMs: 0` and `bestRttFraction: 1` are exactly Link's measurement. A spacing above
  0 drops Link's second data point, and a fraction below 1 keeps only the fastest exchanges before the median.

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
node tests/integration.mjs --bin build --config jamconnect.config.json
```

Needs CMake ≥ 3.16 and a C++17 compiler (MSVC, Clang, GCC or MinGW). `link/` is the Ableton Link
repository as a git submodule.

## License

Ableton Link is GPLv2+ (or a proprietary license from Ableton), so `jamlink-bridge` is distributed
under GPLv2+. See `link/LICENSE.md`.
