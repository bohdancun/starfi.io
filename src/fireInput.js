// Fire input state for the client: a clean "held" state from all sources (mouse button, Space), plus
// guarantees that even the shortest tap fires once. Pure logic (no DOM) so it can be tested headless.
//
//  - held:     any source is currently down.
//  - latched:  a press happened since the last outgoing input message; that message reports
//              shoot = true even if the press was already released (taps shorter than a frame).
//  - pressSeq: counts presses. The server fires at least once for every new value, so a press can't
//              be lost even if its "shoot: true" message is overwritten by a release in the same tick.
//  - dirty:    the state changed; the caller should send an input message right away.

export class FireInput {
  constructor() {
    this.sources = new Set();
    this.latched = false;
    this.pressSeq = 0;
    this.dirty = false;
  }

  get held() { return this.sources.size > 0; }

  // Returns true if the state changed (send an input message now).
  press(source) {
    if (this.sources.has(source)) return false; // auto-repeat / duplicate down
    this.sources.add(source);
    this.latched = true;
    this.pressSeq++;
    this.dirty = true;
    return true;
  }

  release(source) {
    if (!this.sources.delete(source)) return false;
    this.dirty = true;
    return true;
  }

  // Blur, tab hidden, pointer cancel: nothing can stay pressed.
  releaseAll() {
    if (!this.sources.size) return false;
    this.sources.clear();
    this.dirty = true;
    return true;
  }

  // Fields for an outgoing input message. Consumes the tap latch.
  snapshot() {
    const shoot = this.held || this.latched;
    this.latched = false;
    this.dirty = false;
    return { shoot, fs: this.pressSeq };
  }
}
