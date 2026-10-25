// SPDX-License-Identifier: GPL-3.0-only
import {clamp, time} from './core.js';
export class Player {
  constructor(root, notify, onClose, tracker = null) {
    this.root = root; this.notify = notify; this.onClose = onClose; this.tracker = tracker;
    this.video = root.querySelector('video');
    this.controls = root.querySelector('.controls');
    this.status = root.querySelector('.player-status');
    this.generation = 0; this.session = null; this.reporting = Promise.resolve();
    this.video.addEventListener('loadedmetadata', () => this.resume());
    this.video.addEventListener('canplay', () => { this.status.textContent = ''; this.resume(); });
    this.video.addEventListener('timeupdate', () => this.update());
    this.video.addEventListener('playing', () => {
      this.status.textContent = ''; this.report('playing');
      this.track('start'); this.reveal();
    });
    this.video.addEventListener('pause', () => {
      if (this.session && !this.closing) { this.report('paused'); this.track('pause'); this.reveal(); }
    });
    this.video.addEventListener('waiting', () => { if (this.session) this.status.textContent = 'Buffering…'; });
    this.video.addEventListener('ended', () => this.close(true));
    this.video.addEventListener('error', () => this.failed());
    root.querySelector('[data-action="pause"]').onclick = () => this.toggle();
    root.querySelector('[data-action="backward"]').onclick = () => this.seek(-10);
    root.querySelector('[data-action="forward"]').onclick = () => this.seek(30);
    root.querySelector('[data-action="stop"]').onclick = () => this.close();
    root.querySelector('[data-action="transcode"]').onclick = () => this.reopen({transcode: true});
    for (const kind of ['audio', 'subtitle']) {
      root.querySelector('[data-track="' + kind + '"]').onchange = event => this.reopen({[kind]: Number(event.target.value), transcode: true});
    }
    root.addEventListener('mousemove', () => this.reveal());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.session) this.video.pause(); });
  }
  get active() { return !this.root.hidden; }
  async open(api, item, options = {}, preserveTracking = false) {
    const tracking = preserveTracking ? this.playbackTracking : null;
    await this.release(false, preserveTracking);
    const generation = ++this.generation;
    this.api = api; this.item = item; this.options = options;
    this.playbackTracking = tracking || (this.tracker ? this.tracker.createPlayback(api, item) : null);
    this.root.hidden = false; this.status.textContent = 'Preparing video…';
    this.root.querySelector('.player-title').textContent = item.title;
    this.reveal();
    this.root.querySelector('[data-action="stop"]').focus();
    let session;
    try {
      session = await api.playback(item, options);
      if (generation !== this.generation) { await api.stop(session).catch(() => {}); return; }
      this.session = session;
      this.pendingStart = session.start;
      this.root.querySelector('.play-method').textContent = session.transcode ? 'HLS · H.264 / AAC' : 'Direct play';
      for (const kind of ['audio', 'subtitle']) {
        const select = this.root.querySelector('[data-track="' + kind + '"]');
        select.textContent = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = kind === 'audio' ? '' : '-1'; defaultOption.textContent = kind === 'audio' ? 'Default audio' : 'Subtitles off';
        select.appendChild(defaultOption);
        session[kind === 'audio' ? 'audio' : 'subtitles'].forEach(track => {
          const option = document.createElement('option'); option.value = track.id; option.textContent = track.label; select.appendChild(option);
        });
        select.value = options[kind] === undefined ? defaultOption.value : String(options[kind]);
      }
      this.video.src = session.url;
      this.video.load();
      this.report('start');
      this.interval = setInterval(() => this.report(this.video.paused ? 'paused' : 'playing'), 10000);
      this.startTimeout = setTimeout(() => {
        if (generation === this.generation && this.video.readyState < 2) this.failed();
      }, 30000);
      try { await this.video.play(); } catch (error) {
        if (generation !== this.generation) return;
        if (error.name === 'NotAllowedError') this.status.textContent = 'Press Play to start.';
        // The media error handler owns decoding/network errors and fallback.
        else if (!this.video.error && error.name !== 'AbortError') this.status.textContent = 'Press Play, or try compatible playback.';
      }
    } catch (error) {
      if (generation === this.generation) { this.status.textContent = error.message; this.reveal(); }
    }
  }
  resume() {
    if (this.pendingStart && this.session) {
      try { this.video.currentTime = clamp(this.pendingStart, 0, Math.max(0, (this.video.duration || this.item.duration) - 1)); this.pendingStart = 0; }
      catch (_) { /* Retry at canplay if the timeline is not available yet. */ }
    }
    clearTimeout(this.startTimeout);
  }
  update() {
    this.root.querySelector('.elapsed').textContent = time(this.video.currentTime) + ' / ' + time(this.video.duration || (this.item && this.item.duration));
    const fraction = this.video.duration ? clamp(this.video.currentTime / this.video.duration, 0, 1) : 0;
    this.root.querySelector('progress').value = fraction;
    this.root.querySelector('[data-action="pause"]').textContent = this.video.paused ? 'Play' : 'Pause';
  }
  report(state) {
    if (!this.session) return;
    const api = this.api, session = this.session;
    const position = this.pendingStart || this.video.currentTime || 0;
    const duration = Number.isFinite(this.video.duration) ? this.video.duration : this.item.duration;
    // Serialize start/progress/stop so a delayed heartbeat cannot overwrite stop.
    this.reporting = this.reporting.then(() => api.report(session, state, position, duration)).catch(() => {
      if (!this.reportWarning) { this.reportWarning = true; this.notify('Progress could not be synced to the server.'); }
    });
  }
  track(action, ended = false) {
    if (!this.playbackTracking || !this.item) return;
    const position = this.pendingStart || this.video.currentTime || 0;
    const duration = Number.isFinite(this.video.duration) && this.video.duration > 0
      ? this.video.duration : this.item.duration;
    this.playbackTracking.event(action, position, duration, ended);
  }
  async release(ended = false, preserveTracking = false) {
    ++this.generation;
    clearTimeout(this.startTimeout); clearTimeout(this.hideTimer); clearInterval(this.interval);
    const session = this.session, api = this.api;
    if (session) {
      this.report('stopped');
      if (!preserveTracking) this.track('stop', ended);
    }
    this.playbackTracking = null;
    this.session = null; this.pendingStart = 0;
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    await this.reporting;
    if (session) await api.stop(session).catch(() => {});
    this.reportWarning = false;
  }
  async close(ended = false) {
    if (this.closing) return;
    this.closing = true;
    this.root.hidden = true;
    await this.release(ended);
    this.closing = false;
    this.onClose();
  }
  async reopen(changes) {
    if (!this.item || this.closing) return;
    const options = {...this.options, ...changes, start: this.pendingStart || this.video.currentTime || 0};
    // Empty audio select means the server default, not stream zero.
    if (changes.audio === 0 && this.root.querySelector('[data-track="audio"]').value === '') delete options.audio;
    return this.open(this.api, this.item, options, true);
  }
  async failed() {
    if (!this.session || this.recovering) return;
    if (!this.session.transcode) {
      this.recovering = true;
      this.notify('Direct playback failed; trying H.264/AAC transcoding.');
      await this.reopen({transcode: true});
      this.recovering = false;
    } else {
      this.status.textContent = 'Video could not play. Check server transcoding and TV codec support. Press Back to return.';
      this.reveal();
    }
  }
  toggle() {
    if (!this.session) return;
    if (this.video.paused) this.video.play().catch(() => this.failed()); else this.video.pause();
    this.reveal();
  }
  seek(delta) {
    if (!this.session || this.video.readyState < 1) return;
    const duration = Number.isFinite(this.video.duration) ? this.video.duration : this.item.duration;
    this.video.currentTime = clamp(this.video.currentTime + delta, 0, Math.max(0, duration - 1));
    this.report(this.video.paused ? 'paused' : 'playing'); this.reveal();
  }
  reveal() {
    this.controls.classList.remove('hidden-controls');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.session && !this.video.paused && !['SELECT'].includes(document.activeElement.tagName)) {
        this.controls.classList.add('hidden-controls'); this.video.focus();
      }
    }, 5000);
  }
  key(event) {
    const code = event.keyCode;
    if ([461, 27, 413].includes(code)) { event.preventDefault(); this.close(); return true; }
    if ([415, 19, 10252, 32, 412, 417].includes(code)) {
      event.preventDefault();
      if (code === 412) this.seek(-10);
      else if (code === 417) this.seek(30);
      else if (code === 415) this.video.play().catch(() => this.failed());
      else if (code === 19) this.video.pause();
      else this.toggle();
      return true;
    }
    if (this.controls.classList.contains('hidden-controls') && [13, 37, 38, 39, 40].includes(code)) {
      event.preventDefault();
      if (code === 37) this.seek(-10); else if (code === 39) this.seek(30);
      else if (code === 13) this.toggle();
      this.reveal(); this.root.querySelector('[data-action="pause"]').focus(); return true;
    }
    this.reveal(); return false;
  }
}
