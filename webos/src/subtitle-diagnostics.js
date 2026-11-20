// SPDX-License-Identifier: GPL-3.0-only
// Created only for an explicitly enabled embedded-SRT playback session.
// No element, measurement or callback exists with the setting disabled.
export class SubtitleDiagnostics {
  constructor(root, openedAt) {
    this.openedAt = openedAt;
    this.requests = 0;
    this.requestMs = 0;
    this.longestRequestMs = 0;
    this.element = document.createElement('div');
    this.element.className = 'player-subtitle-diagnostics';
    this.element.setAttribute('aria-label', 'Embedded SRT diagnostics');
    root.appendChild(this.element);
    this.draw();
  }

  record(event, milliseconds) {
    if (event === 'range') {
      ++this.requests;
      this.requestMs += milliseconds;
      this.longestRequestMs = Math.max(this.longestRequestMs, milliseconds);
      // Repainting for every range request would skew the timings being measured.
      if (this.requests % 5 !== 0) return;
    } else if (event === 'video') this.videoMs = milliseconds;
    else if (event === 'index') this.indexMs = milliseconds;
    else if (event === 'first') {
      this.firstMs = milliseconds;
      this.sincePlayMs = Date.now() - this.openedAt;
    } else if (event === 'complete') this.completeMs = milliseconds;
    this.draw();
  }

  draw() {
    const ms = value => value === undefined ? 'waiting' : Math.round(value) + ' ms';
    this.element.textContent = [
      'Embedded SRT diagnostics',
      'Video ready: ' + ms(this.videoMs) + ' from Play',
      'MKV index: ' + ms(this.indexMs) + ' from subtitle request',
      'First render: ' + ms(this.firstMs) + ' from subtitle request',
      'First render: ' + ms(this.sincePlayMs) + ' from Play',
      'All cues: ' + ms(this.completeMs) + ' from subtitle request',
      'Ranges: ' + this.requests + ' · network ' + ms(this.requestMs) +
        ' · slowest ' + ms(this.longestRequestMs)
    ].join('\n');
  }

  dispose() {
    this.element.remove();
  }
}
