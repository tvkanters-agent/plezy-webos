// SPDX-License-Identifier: GPL-3.0-only
// MKV packets have a fixed Dialogue field order after demuxing. The initial
// libass script loads once; later clusters append events to that same track.
function assMilliseconds(value) {
  const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(value);
  if (!match) throw new Error('Invalid ASS event timestamp.');
  return ((+match[1] * 60 + +match[2]) * 60 + +match[3]) * 1000 + +match[4] * 10;
}

export function parseAssEvent(line, styles, readOrder) {
  const values = line.replace(/^Dialogue:\s*/, '').split(',');
  if (!/^Dialogue:\s*/.test(line) || values.length < 10)
    throw new Error('Invalid ASS dialogue event.');
  const text = values.slice(9).join(',');
  const start = assMilliseconds(values[1]);
  const end = assMilliseconds(values[2]);
  const name = values[3].trim().toLowerCase();
  const fallback = styles.get('default') ?? styles.values().next().value ?? 0;
  return {ReadOrder:readOrder, Layer:Number(values[0].replace(/^Marked=/,'')) || 0,
    Start:start, Duration:Math.max(0, end - start), Style:styles.get(name) ?? fallback,
    Name:values[4], MarginL:Number(values[5]) || 0, MarginR:Number(values[6]) || 0,
    MarginV:Number(values[7]) || 0, Effect:values[8], Text:text};
}

// Subtitles may be delivered out of chronological order, and the same line
// can occur more than once. A multiset (not a prefix/diff) avoids duplicating
// already installed events after each cumulative preview.
export class AssEventAppender {
  constructor(renderer, initialScript) {
    this.renderer = renderer;
    this.counts = new Map();
    this.pending = [];
    this.styles = null;
    this.disposed = false;
    this.readOrder = 1000000;
    this.remember(initialScript, false);
  }

  remember(script, append = true) {
    const counts = new Map();
    let inEvents = false;
    for (const line of script.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) inEvents = /^\s*\[Events\]/i.test(line);
      if (!inEvents || !/^Dialogue:\s*/.test(line)) continue;
      const count = (counts.get(line) || 0) + 1;
      counts.set(line, count);
      if (append && count > (this.counts.get(line) || 0)) this.pending.push(line);
    }
    this.counts = counts;
    if (append) this.flush();
  }

  ready() {
    if (this.disposed) return;
    const receive = styles => {
      if (this.disposed) return;
      this.styles = new Map(styles.map(style => [String(style.Name).toLowerCase(), style._index]));
      this.flush();
    };
    if (!this.renderer.worker.addEventListener) {
      this.renderer.getStyles(receive, () => {});
      return;
    }
    // The stock getStyles helper times out after five seconds. On the C8,
    // the worker may still be compiling legacy JS and loading fonts then.
    // Listen for its eventual result instead of permanently losing batches.
    this.onStyles = event => {
      if (event.data.target !== 'get-styles') return;
      this.renderer.worker.removeEventListener('message', this.onStyles);
      this.onStyles = null;
      receive(event.data.styles);
    };
    this.renderer.worker.addEventListener('message', this.onStyles);
    this.renderer.worker.postMessage({target:'get-styles'});
  }

  flush() {
    if (!this.styles || !this.pending.length || this.disposed || this.flushTimer != null) return;
    // A cached full-season track may contain thousands of vector-heavy
    // events. Yield between worker batches so clock/seek messages can pass
    // through instead of being delayed behind one giant libass allocation.
    const lines = this.pending.splice(0, 128);
    const events = lines.map(line => parseAssEvent(line, this.styles, ++this.readOrder));
    this.renderer.worker.postMessage({target:'create-events', events});
    // Changes to a paused track can leave the previous frame painted: libass
    // does not always report a blend change for a newly empty cue window.
    // Force the redraw *after* the new events are installed in worker order.
    if (this.renderer.video.paused || this.renderer.video.seeking)
      this.renderer.worker.postMessage({target:'plezy-force-frame'});
    if (this.pending.length) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, 8);
    }
    // The worker normally repaints on its own. Force one update for the
    // first newly installed events and the final batch while paused.
    if (!this.pending.length || this.readOrder === 1000000 + lines.length)
      this.renderer.setCurrentTime(this.renderer.video.currentTime + this.renderer.timeOffset);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.length = 0;
    if (this.onStyles) this.renderer.worker.removeEventListener('message', this.onStyles);
    this.onStyles = null;
  }
}
