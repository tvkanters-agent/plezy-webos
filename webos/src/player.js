// SPDX-License-Identifier: GPL-3.0-only
import {clamp, time} from './core.js';
export class Player {
  constructor(root, notify, onClose, tracker = null) {
    this.root = root; this.notify = notify; this.onClose = onClose; this.tracker = tracker;
    this.video = root.querySelector('video');
    this.controls = root.querySelector('.controls');
    this.sheet = root.querySelector('.player-sheet');
    this.status = root.querySelector('.player-status');
    this.buffering = root.querySelector('.player-buffering');
    this.seeking = false;
    this.seekPreview = 0;
    this.hideAfterSeek = false;
    this.generation = 0; this.session = null; this.reporting = Promise.resolve();
    this.video.addEventListener('loadedmetadata', () => this.resume());
    this.video.addEventListener('canplay', () => { this.status.textContent = ''; this.resume(); });
    this.video.addEventListener('timeupdate', () => this.update());
    this.video.addEventListener('playing', () => {
      this.status.textContent = ''; this.showBuffering(false); this.report('playing');
      this.track('start');
      if (this.hideAfterSeek) {this.hideControls();return;}
      this.reveal();
      // Video.load() and decoder buffering may move focus to <body>.
      // Restore the active transport control, but not over user choices.
      if (this.controls.contains(document.activeElement)) return;
      if (this.root.contains(document.activeElement) &&
          document.activeElement !== this.video && document.activeElement !== this.root) return;
      if (!this.controls.classList.contains('hidden-controls'))
        this.root.querySelector('[data-action="pause"]').focus();
    });
    this.video.addEventListener('pause', () => {
      if (this.session && !this.closing) {
        this.report('paused'); this.track('pause');
        if (!this.hideAfterSeek) this.reveal();
      }
    });
    this.video.addEventListener('waiting', () => { if (this.session) this.showBuffering(true); });
    this.video.addEventListener('seeking', () => { if (this.session) this.showBuffering(true); });
    this.video.addEventListener('seeked', () => { if (this.video.readyState >= 3) this.showBuffering(false); });
    this.video.addEventListener('ended', () => this.close(true));
    this.video.addEventListener('error', () => this.failed());
    root.querySelector('[data-action="pause"]').onclick = () => this.toggle();
    root.querySelector('[data-action="backward"]').onclick = () => this.seek(-10);
    root.querySelector('[data-action="forward"]').onclick = () => this.seek(30);
    root.querySelector('[data-action="stop"]').onclick = () => this.close();
    root.querySelector('[data-action="skip"]').onclick = () => { if (this.marker) this.seekTo(this.marker.end); };
    this.seekBar = root.querySelector('[data-action="seek"]');
    this.scrubbing = false;
    this.seekBar.addEventListener('input', () => {
      this.scrubbing = true;
      this.seeking = true;
      this.seekPreview = Number(this.seekBar.value);
      const seconds = Number(this.seekBar.value);
      this.root.querySelector('.elapsed-current').textContent = time(seconds);
      this.root.querySelector('.elapsed-remaining').textContent = '-' + time(Math.max(0, this.timelineDuration() - seconds));
      this.seekBar.setAttribute('aria-valuetext', time(seconds) + ' of ' + time(this.timelineDuration()));
      this.root.querySelector('.timeline-track progress').value = this.timelineDuration() ? seconds / this.timelineDuration() : 0;
      this.reveal();
    });
    this.seekBar.addEventListener('change', () => {
      this.scrubbing = false;
      // Pointer scrubbing commits immediately; remote seeking commits with OK.
      if (!this.remoteSeeking) {
        this.seeking = false;
        this.seekTo(Number(this.seekBar.value));
      }
    });
    root.querySelector('[data-chapter]').onchange = event => {
      if (event.target.value !== '') this.seekTo(Number(event.target.value));
    };
    root.querySelector('[data-action="transcode"]').onclick = () => this.reopen({transcode: true});
    for (const action of ['options','audio-options','subtitle-options','chapter-options']) {
      root.querySelector('[data-action="' + action + '"]').onclick = () => this.openSheet(action);
    }
    root.querySelector('[data-action="close-options"]').onclick = () => this.closeSheet();
    for (const kind of ['audio', 'subtitle']) {
      root.querySelector('[data-track="' + kind + '"]').onchange = event => this.reopen({[kind]: Number(event.target.value), transcode: true});
    }
    root.addEventListener('mousemove', () => this.reveal());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.session) this.video.pause(); });
  }
  get active() { return !this.root.hidden; }
  openSheet(action) {
    const kind = {options:'settings', 'audio-options':'audio',
      'subtitle-options':'subtitle', 'chapter-options':'chapter'}[action];
    this.openSheetAction = action;
    this.sheet.querySelector('[data-sheet-title]').textContent = {
      settings:'Playback settings', audio:'Audio tracks',
      subtitle:'Subtitles', chapter:'Chapters'}[kind];
    const list = this.sheet.querySelector('.player-options-list');
    list.textContent = '';
    if (kind === 'settings') {
      const quality = this.root.querySelector('[data-action="transcode"]');
      const button = document.createElement('button');
      button.textContent = quality.textContent;
      button.onclick = () => {
        this.closeSheet();
        quality.click();
      };
      list.appendChild(button);
    } else {
      const select = this.root.querySelector(kind === 'chapter'
        ? '[data-chapter]' : '[data-track="' + kind + '"]');
      Array.from(select.options).forEach(option => {
        if (option.value === '' && kind === 'chapter') return;
        const button = document.createElement('button');
        button.setAttribute('aria-label', option.textContent);
        const track = this.session && this.session[kind === 'audio' ? 'audio' : 'subtitles']?.find(
          entry => String(entry.id) === option.value);
        if (track && track.secondary) {
          const primary = document.createElement('strong'); primary.textContent = track.primary;
          const secondary = document.createElement('small'); secondary.textContent = track.secondary;
          button.append(primary, secondary);
        } else button.textContent = option.textContent;
        button.setAttribute('aria-pressed', String(select.value === option.value));
        button.onclick = () => {
          this.closeSheet();
          select.value = option.value;
          select.dispatchEvent(new Event('change'));
        };
        list.appendChild(button);
      });
      if (!list.children.length) list.textContent = 'No tracks available.';
    }
    this.sheet.hidden = false;
    this.reveal();
    const first = list.querySelector('button');
    if (first) first.focus();
    else this.sheet.querySelector('[data-action="close-options"]').focus();
  }
  closeSheet() {
    this.sheet.hidden = true;
    this.root.querySelector('[data-action="' + (this.openSheetAction || 'options') + '"]').focus();
    this.reveal();
  }
  async open(api, item, options = {}, preserveTracking = false) {
    const tracking = preserveTracking ? this.playbackTracking : null;
    this.closing = false;
    const cleanup = this.release(false, preserveTracking);
    const generation = this.generation;
    await cleanup;
    if (generation !== this.generation) return;
    this.api = api; this.item = item; this.options = options;
    this.lastPosition = options.start || 0;
    this.playbackTracking = tracking || (this.tracker ? this.tracker.createPlayback(api, item) : null);
    this.root.hidden = false; this.status.textContent = '';
    this.showBuffering(true); this.seeking = false; this.remoteSeeking = false;
    this.hideAfterSeek = false;
    this.scrubbing = false;
    this.sheet.hidden = true;
    this.root.querySelector('[data-chapters]').hidden = true;
    this.root.querySelector('[data-action="skip"]').hidden = true; this.marker = null;
    this.root.querySelector('.player-title').textContent = item.title;
    this.reveal();
    this.root.querySelector('[data-action="pause"]').focus();
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
      const chapters = this.root.querySelector('[data-chapter]'); chapters.textContent = '';
      const heading = document.createElement('option'); heading.value = ''; heading.textContent = 'Jump to chapter'; chapters.append(heading);
      (session.chapters || []).forEach(chapter => {
        const option = document.createElement('option'); option.value = chapter.start;
        option.textContent = time(chapter.start) + ' · ' + chapter.title; chapters.append(option);
      });
      this.root.querySelector('[data-chapters]').hidden = !session.chapters?.length;
    this.root.querySelector('[data-action="chapter-options"]').hidden = !session.chapters?.length;
      this.video.src = session.url;
      this.video.load();
      this.report('start');
      this.interval = setInterval(() => this.report(this.video.paused ? 'paused' : 'playing'), 10000);
      this.startTimeout = setTimeout(() => {
        if (generation === this.generation && this.video.readyState < 2) this.failed();
      }, 30000);
      try { await this.video.play(); } catch (error) {
        if (generation !== this.generation) return;
        if (error.name === 'NotAllowedError') {this.showBuffering(false);this.status.textContent = 'Press Play to start.';}
        // The media error handler owns decoding/network errors and fallback.
        else if (!this.video.error && error.name !== 'AbortError') {this.showBuffering(false);this.status.textContent = 'Press Play, or try compatible playback.';}
      }
    } catch (error) {
      if (generation === this.generation) { this.showBuffering(false);this.status.textContent = error.message; this.reveal(); }
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
    const marker = (this.session?.markers || []).find(m => this.video.currentTime >= m.start && this.video.currentTime < m.end);
    const skip = this.root.querySelector('[data-action="skip"]');
    if (!marker && document.activeElement === skip) this.root.querySelector('[data-action="pause"]').focus();
    skip.hidden = !marker; skip.textContent = marker?.type === 'credits' ? 'Skip credits' : 'Skip intro';
    this.marker = marker;
    const played = this.video.currentTime || 0;
    const total = this.video.duration || (this.item && this.item.duration) || 0;
    this.root.querySelector('.elapsed').textContent = time(played) + ' / ' + time(total);
    this.root.querySelector('.elapsed-current').textContent = time(played);
    this.root.querySelector('.elapsed-remaining').textContent = '-' + time(Math.max(0, total - played));
    const fraction = total > 0 ? clamp(played / total, 0, 1) : 0;
    if (!this.scrubbing) {
      this.seekBar.max = String(Math.max(0, Math.floor(total)));
      this.seekBar.value = String(Math.min(Math.floor(total), Math.floor(played)));
      this.seekBar.setAttribute('aria-valuetext', time(played) + ' of ' + time(total));
    }
    this.root.querySelector('.timeline-track progress').value = fraction;
    const pause = this.root.querySelector('[data-action="pause"]');
    pause.setAttribute('aria-label', this.video.paused ? 'Play' : 'Pause');
    pause.setAttribute('title', this.video.paused ? 'Play' : 'Pause');
    pause.classList.toggle('is-paused', this.video.paused);
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
    const position = this.pendingStart || this.video.currentTime || this.lastPosition || 0;
    const duration = Number.isFinite(this.video.duration) && this.video.duration > 0
      ? this.video.duration : this.item.duration;
    this.playbackTracking.event(action, position, duration, ended);
  }
  async release(ended = false, preserveTracking = false) {
    ++this.generation;
    clearTimeout(this.startTimeout); clearTimeout(this.hideTimer); clearInterval(this.interval);
    const session = this.session, api = this.api;
    this.lastPosition = this.pendingStart || this.video.currentTime || this.lastPosition || 0;
    if (session) this.report('stopped');
    // Tracking belongs to the viewing, not a particular decoder session. A
    // failed/replaced decoder must still finish the started Simkl viewing.
    if (!preserveTracking) { this.track('stop', ended); this.playbackTracking = null; }
    this.session = null; this.pendingStart = 0;
    this.showBuffering(false); this.seeking = false; this.remoteSeeking = false;
    this.hideAfterSeek = false;
    this.scrubbing = false;
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    await this.reporting;
    if (session) await api.stop(session).catch(() => {});
    this.reportWarning = false;
  }
  async close(ended = false) {
    if (this.closing) return;
    this.closing = true;
    this.root.hidden = true;
    const cleanup = this.release(ended);
    const generation = this.generation;
    await cleanup;
    if (generation !== this.generation) return;
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
      this.showBuffering(true);
      await this.reopen({transcode: true});
      this.recovering = false;
    } else {
      this.showBuffering(false);
      this.status.textContent = 'Video could not play. Check server transcoding and TV codec support. Press Stop to return.';
      this.reveal();
    }
  }
  toggle() {
    if (!this.session) return;
    if (this.video.paused) this.video.play().catch(() => this.failed()); else this.video.pause();
    this.reveal();
  }
  showBuffering(show) {
    this.buffering.hidden = !show;
    this.buffering.setAttribute('aria-busy', String(show));
  }
  hideControls() {
    clearTimeout(this.hideTimer);
    this.controls.classList.add('hidden-controls');
    this.root.querySelector('.player-top').classList.add('hidden-controls');
    this.seeking = false; this.remoteSeeking = false; this.scrubbing = false;
    this.video.focus();
  }
  adjustSeek(delta) {
    this.hideAfterSeek = false;
    const total = this.timelineDuration();
    if (!this.session || total <= 0) return;
    const original = this.seeking ? this.seekPreview : (this.pendingStart || this.video.currentTime || 0);
    this.seekPreview = clamp(original + delta, 0, Math.max(0, total - .1));
    this.seeking = true; this.remoteSeeking = true; this.scrubbing = true;
    this.seekBar.max = String(Math.floor(total));
    this.seekBar.value = String(Math.round(this.seekPreview));
    this.seekBar.setAttribute('aria-valuetext', time(this.seekPreview) + ' of ' + time(total));
    this.root.querySelector('.elapsed-current').textContent = time(this.seekPreview);
    this.root.querySelector('.elapsed-remaining').textContent = '-' + time(total - this.seekPreview);
    this.root.querySelector('.timeline-track progress').value = this.seekPreview / total;
    this.reveal();
    this.seekBar.focus();
  }
  commitSeek() {
    if (!this.seeking) return false;
    const point = this.seekPreview;
    this.scrubbing = false; this.remoteSeeking = false; this.seeking = false;
    this.hideAfterSeek = true;
    this.seekTo(point);
    if (this.video.paused) this.video.play().catch(() => this.failed());
    this.hideControls();
    return true;
  }
  timelineDuration() {
    const duration = this.video.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : (this.item?.duration || 0);
  }
  seek(delta) { this.seekTo((this.pendingStart || this.video.currentTime || 0) + delta); }
  seekTo(position) {
    if (!this.session || !Number.isFinite(position)) return;
    const total = this.timelineDuration();
    if (!(total > 0)) return;
    const target = clamp(position, 0, Math.max(0, total - 0.1));
    if (this.video.readyState < 1) this.pendingStart = target;
    else {
      try { this.video.currentTime = target; } catch (_) { this.pendingStart = target; }
    }
    this.seekBar.value = String(Math.round(target));
    this.seekBar.setAttribute('aria-valuetext', time(target) + ' of ' + time(total));
    this.report(this.video.paused ? 'paused' : 'playing');
    this.update(); this.reveal();
  }
  reveal() {
    this.controls.classList.remove('hidden-controls');
    this.root.querySelector('.player-top').classList.remove('hidden-controls');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.session && this.sheet.hidden && !this.video.paused && document.activeElement !== this.seekBar && !['SELECT'].includes(document.activeElement.tagName)) {
        this.hideControls();
      }
    }, 5000);
  }
  key(event) {
    const code = event.keyCode;
    if (!this.sheet.hidden && [461, 27, 413].includes(code)) {
      event.preventDefault(); this.closeSheet(); return true;
    }
    if ([461, 27, 413].includes(code)) {
      event.preventDefault();
      if (!this.controls.classList.contains('hidden-controls')) this.hideControls();
      else this.close();
      return true;
    }
    if ([37, 39].includes(code) && (this.controls.classList.contains('hidden-controls') ||
        this.seeking || event.target === this.seekBar)) {
      event.preventDefault();
      this.adjustSeek(code === 37 ? -10 : 10); return true;
    }
    if (code === 13 && this.seeking) {
      event.preventDefault(); this.commitSeek(); return true;
    }
    if ([415, 19, 10252, 32, 412, 417].includes(code)) {
      event.preventDefault();
      if (code === 412) this.seek(-10);
      else if (code === 417) this.seek(30);
      else if (code === 415) this.video.play().catch(() => this.failed());
      else if (code === 19) this.video.pause();
      else this.toggle();
      return true;
    }
    if (this.controls.classList.contains('hidden-controls') && [13, 38, 40].includes(code)) {
      event.preventDefault();
      if (code === 13) this.toggle();
      this.reveal(); this.root.querySelector('[data-action="pause"]').focus(); return true;
    }
    this.hideAfterSeek = false;
    this.reveal(); return false;
  }
}
