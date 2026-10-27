// SPDX-License-Identifier: GPL-3.0-only
import {clamp, time} from './core.js';
export class Player {
  constructor(root, notify, onClose, tracker = null, preferences = () => ({})) {
    this.root = root; this.notify = notify; this.onClose = onClose; this.tracker = tracker;
    this.preferences = preferences;
    this.skipButton = root.querySelector('[data-action="skip"]');
    this.marker = null; this.hasFirstFrame = false;
    this.skipDismissed = false; this.skipTimer = null; this.skipDismissTimer = null;
    this.autoSkipProgress = 0; this.skipCountdownStarted = 0;
    this.video = root.querySelector('video');
    this.controls = root.querySelector('.controls');
    this.sheet = root.querySelector('.player-sheet');
    this.status = root.querySelector('.player-status');
    this.buffering = root.querySelector('.player-buffering');
    this.seeking = false;
    this.seekPreview = 0;
    this.hideAfterSeek = false;
    this.seekWasPlaying = false;
    this.initialSeekPending = false;
    this.initialSeekTarget = 0;
    this.generation = 0; this.session = null; this.reporting = Promise.resolve();
    this.video.addEventListener('loadedmetadata', () => { this.resume(); this.startAfterInitialSeek(); });
    this.video.addEventListener('canplay', () => {
      this.status.textContent = ''; this.resume();
      if (!this.initialSeekPending && this.video.readyState >= 2 && !this.video.seeking)
        this.showBuffering(false);
      this.startAfterInitialSeek();
    });
    this.video.addEventListener('loadeddata', () => {
      if (!this.initialSeekPending) { this.hasFirstFrame = true; this.update(); }
      if (!this.initialSeekPending && this.video.readyState >= 2 && !this.video.seeking)
        this.showBuffering(false);
      this.startAfterInitialSeek();
    });
    this.video.addEventListener('stalled', () => {
      if (this.session && !this.seeking) this.showBuffering(true);
    });
    this.video.addEventListener('timeupdate', () => this.update());
    this.video.addEventListener('playing', () => {
      this.status.textContent = '';
      this.resume();
      this.startAfterInitialSeek();
      if (!this.initialSeekPending && this.video.readyState >= 2) this.hasFirstFrame = true;
      this.update();
      if(!this.initialSeekPending) this.showBuffering(false);
      this.report('playing');
      this.track('start');
      if (this.hideAfterSeek) {this.hideControls();return;}
      this.reveal();
      // Video.load() and decoder buffering may move focus to <body>.
      // Restore the active transport control, but not over user choices.
      if (this.controls.contains(document.activeElement) || document.activeElement === this.skipButton) return;
      if (this.root.contains(document.activeElement) &&
          document.activeElement !== this.video && document.activeElement !== this.root) return;
      if (!this.controls.classList.contains('hidden-controls'))
        this.root.querySelector('[data-action="pause"]').focus();
    });
    this.video.addEventListener('pause', () => {
      if (this.session && !this.closing && !this.remoteSeeking) {
        this.report('paused'); this.track('pause');
        if (!this.hideAfterSeek) this.reveal();
      }
    });
    this.video.addEventListener('waiting', () => {
      if (this.session && !this.seeking) this.showBuffering(true);
    });
    this.video.addEventListener('seeking', () => {
      if (this.session) this.showBuffering(true);
    });
    this.video.addEventListener('seeked', () => {
      this.startAfterInitialSeek();
      if (this.video.readyState >= 2 && !this.initialSeekPending) this.showBuffering(false);
    });
    this.video.addEventListener('ended', () => this.close(true));
    this.video.addEventListener('error', () => this.failed());
    root.querySelector('[data-action="pause"]').onclick = () => this.toggle();
    root.querySelector('[data-action="backward"]').onclick = () => this.seek(-10);
    root.querySelector('[data-action="forward"]').onclick = () => this.seek(30);
    root.querySelector('[data-action="stop"]').onclick = () => this.close();
    this.skipButton.onclick = () => this.activateSkipMarker();
    root.addEventListener('pointerdown', () => this.cancelAutoSkipFromInteraction());
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
  skipMode(marker) {
    const prefs = this.preferences();
    return marker?.type === 'credits' ? prefs.skipCreditsMode || 'button'
      : prefs.skipIntroMode || 'button';
  }
  cancelSkipTimers() {
    clearInterval(this.skipTimer); clearTimeout(this.skipDismissTimer);
    this.skipTimer = null; this.skipDismissTimer = null;
    this.autoSkipProgress = 0;
  }
  clearSkipMarker() {
    this.cancelSkipTimers();
    this.marker = null; this.skipDismissed = false;
    // Legacy LG-resume tests construct only the decoder portion of Player.
    if (!this.skipButton) return;
    if (typeof document !== 'undefined' && document.activeElement === this.skipButton)
      (this.controls.classList.contains('hidden-controls') ? this.video :
        this.root.querySelector('[data-action="pause"]')).focus();
    this.skipButton.hidden = true;
  }
  startSkipDismissTimer() {
    clearTimeout(this.skipDismissTimer);
    this.skipDismissTimer = setTimeout(() => {
      if (!this.marker || !this.active) return;
      this.skipDismissed = true;
      this.renderSkipMarker();
    }, 7000);
  }
  cancelAutoSkipFromInteraction() {
    if (!this.skipTimer) return false;
    clearInterval(this.skipTimer); this.skipTimer = null;
    this.autoSkipProgress = 0;
    if (this.marker && !this.skipDismissed) this.startSkipDismissTimer();
    this.renderSkipMarker();
    return true;
  }
  startAutoSkip(marker) {
    const delay = Number(this.preferences().autoSkipDelay) || 5;
    if (this.skipMode(marker) !== 'auto' || delay <= 0) {
      this.startSkipDismissTimer(); return;
    }
    this.skipCountdownStarted = Date.now();
    this.skipTimer = setInterval(() => {
      if (!this.active || this.marker !== marker) { this.cancelSkipTimers(); return; }
      this.autoSkipProgress = clamp((Date.now() - this.skipCountdownStarted) / (delay * 1000), 0, 1);
      if (this.autoSkipProgress >= 1) {
        clearInterval(this.skipTimer); this.skipTimer = null;
        this.activateSkipMarker(true);
      } else this.renderSkipMarker();
    }, 200);
  }
  syncSkipMarker(position) {
    const found = this.hasFirstFrame && this.session
      ? (this.session.markers || []).find(m => ['intro','credits'].includes(m.type) &&
        this.skipMode(m) !== 'off' && position >= m.start && position < m.end) : null;
    if (found !== this.marker) {
      this.clearSkipMarker();
      this.marker = found || null;
      if (found) {
        this.startAutoSkip(found);
        // The button must enter the visible tree BEFORE requesting focus.
        // Focusing its [hidden] state silently fails in Chromium.
        this.renderSkipMarker();
        // Native Plezy assigns focus on TV only when no sheet or higher
        // overlay owns the remote. Desktop preview retains current focus.
        if (this.sheet.hidden && (typeof window.PalmSystem !== 'undefined' ||
          /web0s|webos|netcast/i.test(navigator.userAgent))) this.skipButton.focus();
      }
    }
    this.renderSkipMarker();
  }
  renderSkipMarker() {
    const marker = this.marker;
    const chromeVisible = !this.controls.classList.contains('hidden-controls');
    const visible = !!marker && (!this.skipDismissed || chromeVisible);
    this.skipButton.hidden = !visible;
    this.skipButton.classList.toggle('with-chrome', chromeVisible);
    if (!visible && document.activeElement === this.skipButton)
      (chromeVisible ? this.root.querySelector('[data-action="pause"]') : this.video).focus();
    if (!marker) return;
    const base = marker.type === 'credits' ? 'Skip credits' : 'Skip intro';
    const delay = Number(this.preferences().autoSkipDelay) || 5;
    const remaining = this.skipTimer ? Math.max(0, Math.ceil(delay * (1 - this.autoSkipProgress))) : 0;
    this.skipButton.querySelector('.skip-label').textContent = remaining ? base + ' (' + remaining + ')' : base;
    this.skipButton.setAttribute('aria-label', base);
    this.skipButton.querySelector('.skip-progress').style.width =
      this.skipTimer ? Math.round(this.autoSkipProgress * 100) + '%' : '0%';
  }
  activateSkipMarker(auto = false) {
    if (!this.marker || !this.session || !this.hasFirstFrame) return;
    const marker = this.marker;
    this.clearSkipMarker();
    const duration = this.timelineDuration();
    // Native Plezy hands end-of-video credits to the completion path rather
    // than seeking to an EOF that may never report another position update.
    // WebOS has no Play Next prompt yet, so complete the current title.
    if (marker.type === 'credits' && duration > 0 && duration - marker.end <= 1) {
      this.video.pause(); this.close(true);
    } else this.seekTo(marker.end);
  }
  dismissSkipMarker() {
    if (!this.marker) return;
    this.cancelSkipTimers();
    this.skipDismissed = true;
    this.renderSkipMarker();
  }
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
    this.seekWasPlaying = false;
    this.initialSeekPending = false;
    this.initialSeekTarget = 0;
    this.scrubbing = false;
    this.sheet.hidden = true;
    this.root.querySelector('[data-chapters]').hidden = true;
    this.clearSkipMarker(); this.hasFirstFrame = false;
    this.root.querySelector('.player-title').textContent = item.title;
    this.reveal();
    this.root.querySelector('[data-action="pause"]').focus();
    let session;
    try {
      session = await api.playback(item, {...options, skipSettings: this.preferences()});
      if (generation !== this.generation) { await api.stop(session).catch(() => {}); return; }
      this.session = session;
      if (session.markerPromise) session.markerPromise.then(markers => {
        if (generation !== this.generation || this.session !== session || !markers) return;
        session.markers = markers;
        this.update();
      });
      this.pendingStart = session.start;
      this.initialSeekTarget = Number(session.start) || 0;
      // Keep the spinner until a frame at the requested position is ready.
      this.initialSeekPending = this.initialSeekTarget > 0;
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
      // Keep the opening frame invisible until the resume target has been
      // sought and decoded. Loading indicators remain independently visible.
      this.video.style.visibility = this.initialSeekPending ? 'hidden' : 'visible';
      this.loadSource(session);
      this.report('start');
      this.interval = setInterval(() => this.report(this.video.paused ? 'paused' : 'playing'), 10000);
      this.startTimeout = setTimeout(() => {
        if (generation === this.generation && (this.video.readyState < 2 || this.initialSeekPending)) this.failed();
      }, 30000);
      // On webOS a non-started video often never reaches canplay/seeked.
      // Initialize the decoder, but do not show its frame until the resume
      // seek is ready.
      await this.beginVideoPlayback(generation);
    } catch (error) {
      if (generation === this.generation) { this.showBuffering(false);this.status.textContent = error.message; this.reveal(); }
    }
  }
  loadSource(session) {
    const nativeResume = typeof window.PalmSystem !== 'undefined' ||
      /web0s|webos|netcast/i.test(navigator.userAgent);
    if (nativeResume) {
      // LG's equivalent of Plezy's Media(start:): pass milliseconds to the
      // pipeline BEFORE load/play. A later currentTime assignment buffers twice.
      const source = document.createElement('source');
      source.setAttribute('src', session.url);
      source.setAttribute('type', (session.transcode ? 'application/vnd.apple.mpegurl' : 'video/mp4') +
        ';mediaOption=' + encodeURIComponent(JSON.stringify({option: {
          transmission: {playTime: {start: this.initialSeekTarget * 1000}}
        }})));
      const generation = this.generation;
      source.addEventListener('error', () => {
        if (generation === this.generation && this.session === session) this.failed();
      });
      this.video.appendChild(source);
      // Native startup owns the seek; metadata/canplay must not seek again.
      this.pendingStart = 0;
    } else {
      // Desktop preview has no LG pipeline; retain the HTML media seek path.
      this.video.src = session.url;
    }
    this.video.load();
  }
  async beginVideoPlayback(generation=this.generation) {
    if (generation!==this.generation || !this.session) return;
    try { await this.video.play(); }
    catch(error) {
      if (generation!==this.generation) return;
      if (error.name==='NotAllowedError') {
        this.showBuffering(false);this.status.textContent='Press Play to start.';
      } else if (!this.video.error && error.name!=='AbortError') {
        this.showBuffering(false);
        this.status.textContent='Press Play, or try compatible playback.';
      }
    }
  }
  resume() {
    if (this.pendingStart && this.session && this.video.readyState>=1) {
      try {
        const available=Math.max(Number.isFinite(this.video.duration)?this.video.duration:0,
          Number(this.item?.duration)||0);
        const target=clamp(this.pendingStart,0,Math.max(0,available-1));
        this.video.currentTime=target;
        this.pendingStart=0;
        if(this.initialSeekPending)this.initialSeekTarget=target;
      } catch (_) { /* Retry once the source is seekable. */ }
    }
    if (!this.pendingStart && !this.initialSeekPending)
      clearTimeout(this.startTimeout);
  }
  startAfterInitialSeek() {
    if(!this.initialSeekPending || this.pendingStart || !this.session)return;
    if(this.video.seeking || this.video.readyState<2 ||
       Math.abs(this.video.currentTime-this.initialSeekTarget)>1)return;
    this.initialSeekPending=false;
    this.hasFirstFrame = this.video.readyState >= 2;
    this.video.style.visibility='visible';
    if (this.skipButton) this.update();
    clearTimeout(this.startTimeout);
    this.showBuffering(false);
  }
  position() {
    return (this.initialSeekPending ? this.initialSeekTarget : this.pendingStart) || (this.video.currentTime || 0);
  }
  update() {
    const position=this.position();
    this.syncSkipMarker(position);
    const played = position;
    const total = this.timelineDuration();
    this.root.querySelector('.elapsed').textContent = time(played) + ' / ' + time(total);
    this.root.querySelector('.elapsed-current').textContent = time(played);
    this.root.querySelector('.elapsed-remaining').textContent = '-' + time(Math.max(0, total - played));
    const fraction = total > 0 ? clamp(played / total, 0, 1) : 0;
    if (!this.scrubbing) {
      this.seekBar.max = String(Math.max(0, Math.floor(total)));
      this.seekBar.value = String(Math.min(Math.floor(total), Math.floor(played)));
      this.seekBar.setAttribute('aria-valuetext', time(played) + ' of ' + time(total));
    }
    this.root.querySelector('.timeline-track progress').value =
      this.scrubbing && total ? this.seekPreview / total : fraction;
    const pause = this.root.querySelector('[data-action="pause"]');
    pause.setAttribute('aria-label', this.video.paused ? 'Play' : 'Pause');
    pause.setAttribute('title', this.video.paused ? 'Play' : 'Pause');
    pause.classList.toggle('is-paused', this.video.paused);
  }
  report(state) {
    if (!this.session) return;
    const api = this.api, session = this.session;
    const position = this.position();
    const duration = this.timelineDuration();
    // Serialize start/progress/stop so a delayed heartbeat cannot overwrite stop.
    this.reporting = this.reporting.then(() => api.report(session, state, position, duration)).catch(() => {
      if (!this.reportWarning) { this.reportWarning = true; this.notify('Progress could not be synced to the server.'); }
    });
  }
  track(action, ended = false) {
    if (!this.playbackTracking || !this.item) return;
    const position = this.position() || this.lastPosition || 0;
    const duration = this.timelineDuration();
    this.playbackTracking.event(action, position, duration, ended);
  }
  async release(ended = false, preserveTracking = false) {
    ++this.generation;
    clearTimeout(this.startTimeout); clearTimeout(this.hideTimer); clearInterval(this.interval);
    const session = this.session, api = this.api;
    this.lastPosition = this.position() || this.lastPosition || 0;
    if (session) this.report('stopped');
    // Tracking belongs to the viewing, not a particular decoder session. A
    // failed/replaced decoder must still finish the started Simkl viewing.
    if (!preserveTracking) { this.track('stop', ended); this.playbackTracking = null; }
    this.clearSkipMarker(); this.hasFirstFrame = false;
    this.session = null; this.pendingStart = 0;
    this.showBuffering(false); this.seeking = false; this.remoteSeeking = false;
    this.hideAfterSeek = false;
    this.seekWasPlaying = false;
    this.initialSeekPending = false;
    this.initialSeekTarget = 0;
    this.scrubbing = false;
    this.video.style.visibility='visible';
    this.video.pause(); this.video.removeAttribute('src');
    Array.from(this.video.querySelectorAll('source')).forEach(source => source.remove());
    this.video.load();
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
    const options = {...this.options, ...changes, start: changes.start ?? this.position()};
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
    if (!this.active) show = false;
    this.buffering.hidden = !show;
    this.buffering.setAttribute('aria-busy', String(show));
    // Older LG Chromium versions are inconsistent about the :hidden rule.
    this.buffering.style.display = show ? 'flex' : 'none';
  }
  hideControls() {
    clearTimeout(this.hideTimer);
    this.controls.classList.add('hidden-controls');
    this.root.querySelector('.player-top').classList.add('hidden-controls');
    this.seeking = false; this.remoteSeeking = false; this.scrubbing = false;
    this.renderSkipMarker();
    if (document.activeElement !== this.skipButton || this.skipButton.hidden) this.video.focus();
  }
  adjustSeek(delta) {
    this.hideAfterSeek = false;
    const total = this.timelineDuration();
    if (!this.session || total <= 0) return;
    const original = this.seeking ? this.seekPreview : this.position();
    this.seekPreview = clamp(original + delta, 0, Math.max(0, total - .1));
    if (!this.seeking) {
      this.seekWasPlaying = !this.video.paused;
      this.seeking = true;
      this.remoteSeeking = true;
      this.video.pause();
    }
    this.scrubbing = true;
    // Plezy previews an actual video frame at every D-pad seek step.
    // Changing only the range input moved a number but never the picture.
    try {
      if (this.video.readyState >= 1)
        this.video.currentTime = Math.max(0,this.seekPreview);
      else this.pendingStart = this.seekPreview;
    } catch (_) { this.pendingStart = this.seekPreview; }
    this.showBuffering(this.video.readyState < 2 || this.video.seeking);
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
    this.showBuffering(true);
    // OK confirms the preview and resumes playback from that frame.
    this.video.play().catch(() => this.failed());
    this.seekWasPlaying = false;
    this.hideControls();
    return true;
  }
  timelineDuration() {
    const duration = this.video.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : (this.item?.duration || 0);
  }
  seek(delta) { this.seekTo(this.position() + delta); }
  seekTo(position) {
    if (!this.session || !Number.isFinite(position)) return;
    const total = this.timelineDuration();
    if (!(total > 0)) return;
    const target = clamp(position, 0, Math.max(0, total - 0.1));
    if (this.video.readyState < 1) this.pendingStart = target;
    else {
      try { this.video.currentTime = target; }
      catch (_) { this.pendingStart = target; }
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
    this.renderSkipMarker();
    this.hideTimer = setTimeout(() => {
      if (this.session && this.sheet.hidden && !this.video.paused && document.activeElement !== this.seekBar && !['SELECT'].includes(document.activeElement.tagName)) {
        this.hideControls();
      }
    }, 5000);
  }
  key(event) {
    const code = event.keyCode;
    this.cancelAutoSkipFromInteraction();
    if (document.activeElement === this.skipButton && code === 40) {
      event.preventDefault(); this.reveal();
      this.root.querySelector('[data-action="pause"]').focus(); return true;
    }
    if (document.activeElement === this.skipButton && [461, 27, 413].includes(code)) {
      event.preventDefault(); this.dismissSkipMarker(); return true;
    }
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
