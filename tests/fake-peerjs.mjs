// In-memory PeerJS replacement for tests: the surface JamConnect uses
// (Peer open/connection/error, DataConnection open/data/close, JSON serialisation)
// over an ordered, reliable channel with jittered latency.

// Heavy jitter, same distribution both ways. A constant up/down asymmetry is invisible
// to any two-way clock sync (Link's included) and would show up as offset bias.
export const LATENCY_MS = { up: [3, 25], down: [3, 25] };

const registry = new Map();
const jitter = ([a, b]) => a + Math.random() * (b - a);

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
  emit(ev, arg) { for (const fn of this._h[ev] || []) fn(arg); }
}

class FakeConn extends Emitter {
  constructor(remoteId, metadata, latency) {
    super();
    this.peer = remoteId;
    this.metadata = metadata;
    this.open = false;
    this.other = null;
    this.latency = latency;
    this._lastDelivery = 0;
  }

  send(obj) {
    if (!this.open) return;
    const data = JSON.parse(JSON.stringify(obj));
    // Ordered, reliable channel: never deliver before the previous message.
    const at = Math.max(performance.now() + jitter(this.latency), this._lastDelivery);
    this._lastDelivery = at;
    setTimeout(() => { if (this.other.open) this.other.emit('data', data); }, at - performance.now());
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.other.open = false;
    setTimeout(() => { this.emit('close'); this.other.emit('close'); }, 0);
  }
}

export class FakePeer extends Emitter {
  constructor(id) {
    super();
    this.id = id;
    this.destroyed = false;
    registry.set(id, this);
    setTimeout(() => this.emit('open', id), 0);
  }

  connect(target, opts = {}) {
    const remote = registry.get(target);
    const mine = new FakeConn(target, opts.metadata, LATENCY_MS.up);
    const theirs = new FakeConn(this.id, opts.metadata, LATENCY_MS.down);
    mine.other = theirs;
    theirs.other = mine;
    setTimeout(() => {
      if (!remote) { this.emit('error', { type: 'peer-unavailable', message: 'peer unavailable' }); return; }
      remote.emit('connection', theirs);
      setTimeout(() => { mine.open = theirs.open = true; theirs.emit('open'); mine.emit('open'); }, jitter(LATENCY_MS.up));
    }, 0);
    return mine;
  }

  reconnect() {}

  destroy() {
    this.destroyed = true;
    registry.delete(this.id);
  }
}
