// SPDX-License-Identifier: GPL-3.0-only
// Report ordering belongs to a decoder session, never to the player globally.
// Keep one request in flight and only the latest unsent progress snapshot.
export class ProgressReporter {
  constructor(api, session, onError = () => {}) {
    this.api = api;
    this.session = session;
    this.onError = onError;
    this.active = null;
    this.pending = null;
    this.closed = false;
  }
  report(state, position, duration) {
    if (this.closed) return;
    this.pending = {state, position, duration};
    this.flush();
  }
  flush() {
    if (this.active || !this.pending) return;
    const {state, position, duration} = this.pending;
    this.pending = null;
    const active = {controller: new AbortController(), stopTimer: null};
    this.active = active;
    Promise.resolve()
      .then(() => this.api.report(this.session, state, position, duration, active.controller.signal))
      .catch(error => {
        if (!active.controller.signal.aborted) this.onError(error);
      })
      .finally(() => {
        clearTimeout(active.stopTimer);
        // A report cancelled during Stop must never revive old heartbeats.
        if (this.active !== active) return;
        this.active = null;
        this.flush();
      });
  }
  stop(position, duration) {
    if (this.closed) return;
    this.closed = true;
    // Retire every unsent heartbeat; keep the final playback position.
    this.pending = {state: 'stopped', position, duration};
    if (!this.active) {
      this.flush();
      return;
    }
    const active = this.active;
    // Fast servers retain strict start/progress -> stopped ordering. A slow or
    // hung request gets a short grace period, then is aborted so the final
    // stopped report can be attempted without waiting for its full timeout.
    active.stopTimer = setTimeout(() => {
      if (this.active !== active) return;
      active.controller.abort();
      this.active = null;
      this.flush();
    }, 250);
  }
}
