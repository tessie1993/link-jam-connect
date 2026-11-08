# JamConnect parameter & modulation protocol (instruments ⇄ modulators)

Shared contract for JamConnect instruments (e.g. the wavetable synth) and modulation
sources (e.g. the modulation device). All messages travel through the normal JamConnect
session: local bridge hub, or a WebRTC host relaying to and from the bridge. Ableton is
reached through the existing `LIVE_*` and `M4L_*` messages (see PROTOCOL.md).

Timing follows the Link timeline: times are **Link beats** (`linkBeat`), which every
peer converts with its own `JamConnector.linkTimeAtBeat()`. Values are **normalized
0..1** on the wire (`norm`). Each instrument maps them to real units with its own
manifest, so a modulator never needs to know units.

## Discovery

| Message | Direction | Fields |
|---|---|---|
| `JAM_PARAMS_DISCOVER` | any → all | `{}` (optional `target`) |
| `JAM_PARAMS_ANNOUNCE` | instrument → all | `{instanceId, appName, kind: "instrument"\|"modulator"\|..., params: [Param]}`. Sent on join, on DISCOVER, and when the manifest changes |
| `JAM_PARAMS_BYE` | instrument → all | `{instanceId}` |

`Param = {id, name, group?, min, max, default, unit?, scale: "lin"|"exp"|"db", steps?: number, valueItems?: [string], modulatable: boolean}`

`instanceId` is unique per running app instance (random, from config alphabet/length).

## Values

| Message | Fields | Semantics |
|---|---|---|
| `JAM_PARAM_SET` | `{target, param, norm, linkBeat?}` | Set a value. With `linkBeat`, apply at that Link beat; otherwise on arrival |
| `JAM_PARAM_CURVE` | `{target, param, points: [{linkBeat, norm, shape?}], mode: "absolute"\|"offset", source?}` | Breakpoints in Link beats. `shape` of the segment ending at that point: `"step"\|"linear"\|"exp"\|"s"`. Receivers schedule these with Web Audio (`setValueAtTime` / `linearRampToValueAtTime` / `setTargetAtTime` / `setValueCurveAtTime`). `mode: "offset"` means bipolar modulation (-1..1 × depth), added to the base value |
| `JAM_PARAM_CHANGED` | `{instanceId, param, norm}` | Instrument echo (rate-limited, interval from config), so UIs and modulators can follow |
| `JAM_PARAM_TOUCH` / `JAM_PARAM_RELEASE` | `{target, param, source}` | Ownership: while touched, the instrument ignores other sources for that param (latest touch wins; a local user always wins) |

Senders decimate curves (error-bounded; tolerance from config) and send points ahead of
time by a lead taken from the measured one-way latency (`JamConnector._sessionOneWayMs()`),
not a constant. Receivers drop points that are already in the past, and on late arrival
jump to the interpolated current value.

## Routing to Ableton

A modulator targeting Ableton converts curves to:
* `M4L_SET_MACRO {target, macro, value}`: device macros, which can be mapped to any Live parameter with `M4L_MAP_MACRO`;
* `LIVE_SET_PARAM {track, device, param, normalized}`: direct Live parameter (rate-limited by the device);
* `M4L_CC {target, cc, value, channel}`: MIDI CC into the instrument after the device.

Each target sends at its own configured rate. Values between updates are taken from the curve.

## Modulator notes (added with the mod device)

Additive clarifications, as implemented by `apps/mod-device`:

* **Offset values.** In `JAM_PARAM_CURVE` with `mode: "offset"`, `norm` carries the bipolar offset (-1..1,
  depth already applied); receivers add it to the base value (normalized) and clamp to 0..1.
* **Replacing scheduled points.** A curve replaces the points already scheduled by the same `source` for the same
  param at or after its first `linkBeat`. A modulator that stops an offset route sends a single point
  `norm: 0` at "now + lead", which cancels its lookahead and returns the parameter to its base.
* **Ownership.** Modulators send `JAM_PARAM_TOUCH` / `RELEASE` for absolute routes (gesture start / end,
  hold latch, panic). Offset routes are additive and do not take ownership (unless
  `client.modulator.touchOffsetRoutes`).
* **Without a Link timeline** a modulator sends `JAM_PARAM_SET` without `linkBeat` (applied on arrival); offset
  routes then send the instrument's last known value (from `JAM_PARAM_CHANGED` or the manifest default) plus the
  offset.
* **Modulators have manifests too** (`kind: "modulator"`): their params (e.g. `lfo1.hz`, `route3.depth`,
  `global.depth`) accept `JAM_PARAM_SET` / `CURVE` / `TOUCH` / `RELEASE` and echo `JAM_PARAM_CHANGED`.
  Choice params carry `valueItems` and `steps`.
* **Guest permissions.** A WebRTC host relays a guest's `JAM_PARAM_SET` / `CURVE` / `TOUCH` / `RELEASE` only
  with `syncDeviceParameterChange` ("Params / macros"); otherwise the guest gets `LIVE_ERROR` naming the
  permission (`jamRemoteControlPermission()` in `jamconnect.js`). Discovery and `JAM_PARAM_CHANGED` need none.
  Only guest-originated writes are gated: messages from the host itself or from the local bridge
  (`BRIDGE_PEER_ID`) are never blocked, and a guest never re-checks what the host relays to it.

## Compatibility

Instruments may also accept the legacy `DEVICE_PARAMETER_CHANGE {appName, param, value}`.
Unknown fields must be ignored. Every message carries `appName` (added by `sendRelayMessage`).

## Additions (wavetable synth, `apps/wavetable-synth/`)

All additive and optional; receivers that do not know them ignore them.

* **Current values in the manifest:** each `Param` in `JAM_PARAMS_ANNOUNCE` also carries `value` (current
  normalized value), so a modulator can start from where the instrument is. `target: "*"` addresses every instance.
* **Offset lane:** a `mode: "offset"` curve's `norm` is the bipolar offset in normalized units of the
  parameter (-1..1, depth already applied by the sender) and is added to the knob value, clamped to 0..1.
  Each modulatable parameter has one offset lane; the newest offset curve replaces the previous one.
  Touch ownership applies to the knob value (`absolute` SET/CURVE), not to the offset lane.
* **Streaming curves:** a curve replaces what was scheduled from its own first point on, so senders can
  stream overlapping chunks. Segment shapes are scheduled as `setValueAtTime` (`step`),
  `linearRampToValueAtTime` (`linear`), `exponentialRampToValueAtTime` (`exp`, same-sign non-zero ends)
  and error-bounded linear subdivisions (`s`, and `exp` through zero), tolerance `client.synth.protocol.curveTolerance`.
* **Permissions:** a WebRTC host relays `JAM_*` traffic without checking it, so the instrument enforces
  `syncDeviceParameterChange` itself for SET / CURVE / TOUCH / RELEASE / PRESET_LOAD coming from guests,
  and guests do not send them while the permission is off.
* **Presets:**

| Message | Direction | Fields |
|---|---|---|
| `JAM_PRESET_LOAD` | any → instrument | `{target, preset, source?}`: load a preset (`{name, category, version, params: {id: value}}`, values in real units, value lists by label). Needs `syncDeviceParameterChange` from guests |
| `JAM_PRESET_GET` | any → instrument | `{target, requestId?}` |
| `JAM_PRESET_STATE` | instrument → all | `{instanceId, preset, requestId?}`: reply to GET |
| `JAM_PRESET_CHANGED` | instrument → all | `{instanceId, name, category, values: {id: norm}}`: sent once after a preset load instead of one `JAM_PARAM_CHANGED` per parameter |
