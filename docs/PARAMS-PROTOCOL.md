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

## Compatibility

Instruments may also accept the legacy `DEVICE_PARAMETER_CHANGE {appName, param, value}`.
Unknown fields must be ignored. Every message carries `appName` (added by `sendRelayMessage`).
