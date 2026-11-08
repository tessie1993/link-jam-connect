/* Link timeline <-> AudioContext time, and note scheduling by Link beat.
 *
 * Musical times are Link beats (JamConnector timeline). A beat becomes a performance.now() time
 * (connector.linkTimeAtBeat), then an AudioContext time through ctx.getOutputTimestamp() (the
 * context time whose audio is heard at that moment), so notes sound at the same Link moment on
 * every peer. The worklet turns that time into a sample offset inside its render quantum.
 * No fixed delays: without a Link tempo, events play on arrival.
 */

/** AudioContext time heard at performance.now() time perfMs. */
export function audioTimeForPerfMs(ctx, perfMs, perfNow = performance.now()) {
  if (!ctx) return null;
  if (ctx.getOutputTimestamp) {
    const ts = ctx.getOutputTimestamp();
    if (ts && ts.performanceTime) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
  }
  return ctx.currentTime + (perfMs - perfNow) / 1000;
}

export class LinkClock {
  /** @param {{connector, getContext: () => AudioContext|null, perfNow?: () => number}} o */
  constructor(o) {
    this.connector = o.connector;
    this.getContext = o.getContext;
    this.perfNow = o.perfNow || (() => performance.now());
  }

  state() { return this.connector.getLinkState(this.perfNow()); }
  hasTempo() { const st = this.state(); return !!st.source && st.tempo !== null; }
  tempo() { const st = this.state(); return st.source && st.tempo !== null ? st.tempo : null; }
  beatNow() { return this.hasTempo() ? this.connector.linkBeatAtTime(this.perfNow()) : null; }

  /** AudioContext time of a Link beat (null without Link tempo or audio). */
  timeAtBeat(beat) {
    const ctx = this.getContext();
    if (!ctx || !this.hasTempo() || typeof beat !== 'number' || !Number.isFinite(beat)) return null;
    return audioTimeForPerfMs(ctx, this.connector.linkTimeAtBeat(beat), this.perfNow());
  }

  /** Link beat heard at AudioContext time t (inverse of timeAtBeat). */
  beatAtAudioTime(t) {
    const ctx = this.getContext();
    if (!ctx || !this.hasTempo()) return null;
    const now = this.perfNow();
    const ref = audioTimeForPerfMs(ctx, now, now);
    return this.connector.linkBeatAtTime(now + (t - ref) * 1000);
  }

  /** Next grid line (grid in beats) at or after the beat being heard now. */
  nextGridBeat(grid) {
    const b = this.beatNow();
    if (b === null || !(grid > 0)) return b;
    return Math.ceil(b / grid - 1e-9) * grid;
  }

  /** Message for the worklet: the Link beat at AudioContext time `time`. */
  linkMessage() {
    const ctx = this.getContext();
    const st = this.state();
    if (!ctx || !st.source || st.tempo === null) return { type: 'link', tempo: 0, beat: 0, time: 0, playing: false };
    const now = this.perfNow();
    return { type: 'link', tempo: st.tempo, beat: this.connector.linkBeatAtTime(now), time: audioTimeForPerfMs(ctx, now, now), playing: !!st.isPlaying };
  }
}

/** Turns note / controller events (optionally at a Link beat) into timed worklet messages. */
export class NoteScheduler {
  /** @param {{clock: LinkClock, post: (msg) => void, audioNow: () => number|null}} o */
  constructor(o) {
    this.clock = o.clock;
    this.post = o.post;
    this.audioNow = o.audioNow;
    this.onTime = new Map();
  }

  /** AudioContext time for a Link beat, never in the past; null = as soon as possible. */
  timeFor(linkBeat) {
    const now = this.audioNow();
    if (typeof linkBeat !== 'number') return null;
    const t = this.clock.timeAtBeat(linkBeat);
    if (t === null || now === null) return null;
    return Math.max(t, now);
  }

  noteOn(note, velocity, linkBeat) {
    const time = this.timeFor(linkBeat);
    this.onTime.set(note, time === null ? (this.audioNow() ?? 0) : time);
    this.post({ type: 'note', on: true, note, velocity, time });
    return time;
  }

  noteOff(note, linkBeat) {
    let time = this.timeFor(linkBeat);
    const on = this.onTime.get(note);
    // a note-off never overtakes its (possibly quantized, future) note-on
    if (on !== undefined && on !== null && (time === null || time < on)) time = Math.max(on, this.audioNow() ?? on);
    this.post({ type: 'note', on: false, note, time });
    return time;
  }

  controller(kind, value, linkBeat) {
    const time = this.timeFor(linkBeat);
    this.post({ type: 'ctl', kind, value, time });
    return time;
  }

  /**
   * JamConnect MIDI_EVENT.event -> engine. velocity/value 0..127; pitchbend value -1..1 (or 0..16383);
   * ccMap: {cc: "wheel"|"sustain"|paramId}. Returns {handled, param?, norm?} for CCs mapped to params.
   */
  midiEvent(ev, linkBeat, ccMap = {}) {
    if (!ev || typeof ev.kind !== 'string') return { handled: false };
    switch (ev.kind) {
      case 'noteon': {
        const v = Number(ev.velocity);
        if (!(v > 0)) { this.noteOff(Number(ev.note), linkBeat); return { handled: true }; }
        this.noteOn(Number(ev.note), Math.min(1, v / 127), linkBeat);
        return { handled: true };
      }
      case 'noteoff': this.noteOff(Number(ev.note), linkBeat); return { handled: true };
      case 'pitchbend': {
        const v = Number(ev.value);
        const norm = Math.abs(v) <= 1 ? v : (v - 8192) / 8192;
        this.controller('bend', Math.max(-1, Math.min(1, norm)), linkBeat);
        return { handled: true };
      }
      case 'aftertouch':
      case 'pressure':
        this.controller('aftertouch', Number(ev.value) / 127, linkBeat);
        return { handled: true };
      case 'cc': {
        const target = ccMap[String(ev.cc)];
        const norm = Math.max(0, Math.min(1, Number(ev.value) / 127));
        if (target === 'wheel' || target === 'sustain') { this.controller(target, norm, linkBeat); return { handled: true }; }
        if (target) return { handled: true, param: target, norm };
        return { handled: false };
      }
      default: return { handled: false };
    }
  }
}

/** "C2" / "F#3" / 36 -> MIDI note (Tone.js naming: C4 = 60). */
export function noteNumber(note) {
  if (typeof note === 'number') return Math.round(note);
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(note).trim());
  if (!m) return null;
  const pc = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (Number(m[3]) + 1) * 12 + pc;
}
