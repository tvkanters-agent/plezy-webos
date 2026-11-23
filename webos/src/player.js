// SPDX-License-Identifier: GPL-3.0-only
import {clamp, nextFocus, time} from './core.js';
import {chapterIndexAtPosition, chapterSeekTarget} from './chapters.js';
import {parseBif, bifFrameAt} from './scrub-preview.js';
import {SubtitleOverlay} from './subtitles.js';
import {SubtitleDiagnostics} from './subtitle-diagnostics.js';
import {catalogScope} from './persistent-catalog.js';
import {ProgressReporter} from './progress-reporter.js';
export class Player {
  constructor(root, notify, onClose, tracker = null, preferences = () => ({}), onTrackChoice = null) {
    this.root = root; this.notify = notify; this.onClose = onClose; this.tracker = tracker;
    this.preferences = preferences;
    this.onTrackChoice = onTrackChoice;
    this.skipButton = root.querySelector('[data-action="skip"]');
    this.chapterBoundaryDuration = null;
    this.marker = null; this.hasFirstFrame = false;
    this.skippedMarker = null;
    this.skipDismissed = false; this.skipTimer = null; this.skipDismissTimer = null;
    this.skipFocusPending = false;
    this.autoSkipProgress = 0; this.skipCountdownStarted = 0;
    this.video = root.querySelector('video');
    this.controls = root.querySelector('.controls');
    this.lastControlFocus = root.querySelector('[data-action="pause"]');
    this.seekTooltip = root.querySelector('.seek-preview');
    this.seekImage = this.seekTooltip.querySelector('img');
    this.seekFrameIndex = -1;
    this.seekFrameUrl = null;
    this.previewFrames = null;
    this.previewAbort = null;
    this.skipControlsHeight = -1;
    this.sheet = root.querySelector('.player-sheet');
    this.subtitleSyncOffsetMs = 0;
    this.subtitleCueTimes = new WeakMap();
    // Compatibility mode must not instantiate a custom subtitle renderer.
    this.subtitleOverlay = null;
    this.subtitleDiagnostics = null;
    this.enhancedPlaybackActive = false;
    this.status = root.querySelector('.player-status');
    this.buffering = root.querySelector('.player-buffering');
    this.seeking = false;
    this.seekPreview = 0;
    this.hideAfterSeek = false;
    this.seekWasPlaying = false;
    this.resumeAfterSeekTarget = null;
    this.controlsDismissedByBack = false;
    this.backHideTime = 0;
    this.lastPointerPosition = null;
    this.initialSeekPending = false;
    this.initialSeekTarget = 0;
    this.generation = 0; this.session = null; this.reporter = null; this.reportWarning = false;
    this.pendingPlayback = null; this.pendingStartupTeardown = null;
    this.pendingOpenGeneration = null;
    this.bindVideoEvents(this.video);
    root.querySelector('[data-action="pause"]').onclick = () => this.toggle();
    root.querySelector('[data-action="backward"]').onclick = () => this.seek(-10);
    root.querySelector('[data-action="forward"]').onclick = () => this.seek(30);
    root.querySelector('[data-action="stop"]').onclick = () => this.close();
    this.skipButton.onclick = () => this.activateSkipMarker();
    root.addEventListener('pointerdown', () => this.cancelAutoSkipFromInteraction());
    this.seekBar = root.querySelector('[data-action="seek"]');
    this.scrubbing = false;
    root.addEventListener('focusin', event => {
      if (!this.active || this.closing || !this.controls.contains(event.target)) return;
      // A decoder/TV focus-restoration event must not undo an explicit Back.
      if (this.controlsDismissedByBack && this.controls.classList.contains('hidden-controls')) return;
      if (event.target !== this.seekBar) {
        // Moving focus is not seek confirmation. OK is the only D-pad commit.
        this.cancelRemoteSeek();
        this.lastControlFocus = event.target;
      }
      this.hideAfterSeek = false;
      this.reveal();
    });
    this.seekBar.addEventListener('input', () => {
      this.scrubbing = true;
      this.seeking = true;
      this.seekPreview = Number(this.seekBar.value);
      const seconds = Number(this.seekBar.value);
      this.root.querySelector('.elapsed-current').textContent = time(seconds);
      this.root.querySelector('.elapsed-remaining').textContent = '-' + time(Math.max(0, this.timelineDuration() - seconds));
      this.seekBar.setAttribute('aria-valuetext', time(seconds) + ' of ' + time(this.timelineDuration()));
      this.root.querySelector('.timeline-track progress').value = this.timelineDuration() ? seconds / this.timelineDuration() : 0;
      this.renderSeekPreview(seconds);
      this.reveal();
    });
    this.seekBar.addEventListener('change', () => {
      this.scrubbing = false;
      // Pointer scrubbing commits immediately; remote seeking commits with OK.
      if (!this.remoteSeeking) {
        this.seeking = false;
        this.seekTo(Number(this.seekBar.value));
        this.hideSeekPreview();
      }
    });
    this.seekBar.addEventListener('pointermove', event => {
      if (!this.session || !this.timelineDuration() || this.remoteSeeking || this.scrubbing) return;
      const bounds = this.seekBar.getBoundingClientRect();
      const fraction = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      this.renderSeekPreview(fraction * this.timelineDuration());
    });
    this.seekBar.addEventListener('pointerleave', () => {
      if (!this.scrubbing) this.hideSeekPreview();
    });
    if (typeof window !== 'undefined') window.addEventListener('resize', () => {
      this.skipControlsHeight = -1;
      if (this.active) { this.updateSubtitleLift(); this.renderSkipMarker(); }
    });
    root.querySelector('[data-chapter]').onchange = event => {
      if (event.target.value !== '') this.seekTo(Number(event.target.value));
    };
    root.querySelector('[data-action="transcode"]').onclick = () => this.reopen({transcode: true});
    for (const action of ['options','tracks-options','chapter-options']) {
      root.querySelector('[data-action="' + action + '"]').onclick = () => this.openSheet(action);
    }
    root.querySelector('[data-action="close-options"]').onclick = () => this.closeSheet();
    root.addEventListener('keyup', event => {
      if (event.keyCode === 13) { this.stopSyncHold(); this.syncHoldFired = false; }
    });
    for (const kind of ['audio', 'subtitle']) {
      root.querySelector('[data-track="' + kind + '"]').onchange = event => {
        const id = Number(event.target.value);
        const track = ((this.session || this.trackCatalog)?.[kind === 'audio' ? 'audio' : 'subtitles'] || [])
          .find(entry => Number(entry.id) === id);
        if (this.onTrackChoice && (track || kind === 'subtitle' && id === -1))
          this.onTrackChoice(this.item, this.options.mediaIndex || 0, kind, track || {id:-1});
        if (kind === 'subtitle' && this.switchLocalSubtitle(id)) return;
        return this.reopen({[kind]:id, burnSubtitles:false, skipMatroskaSubtitles:false,
          transcode:kind === 'audio' || !!this.options.transcode},
          !this.sheet.hidden && this.openSheetAction === 'tracks-options' ? {kind, id} : null);
      };
    }
    // A floating Skip button must not jump away from an approaching pointer:
    // reveal() changes its anchor when chrome was hidden, between hit-test
    // and click on slower TVs. Pointer activity on the prompt leaves it put.
    root.addEventListener('mousemove', event => {
      if (!this.active || this.closing) return;
      const previous = this.lastPointerPosition;
      this.lastPointerPosition = {x:event.clientX, y:event.clientY};
      // Some LG remotes emit a stationary mousemove alongside Back. Genuine
      // pointer movement still reveals the controls after dismissal.
      if (this.controlsDismissedByBack && (Date.now() - this.backHideTime < 400 || !previous ||
          Math.abs(event.clientX - previous.x) + Math.abs(event.clientY - previous.y) < 3)) return;
      if (!this.skipButton.contains(event.target)) this.reveal();
    });
    document.addEventListener('visibilitychange', () => {
      // Negotiation can still be pending: the visible player has no session yet.
      if (document.hidden && this.active && !this.closing) {
        this.openIntentPlaying = false; this.pauseAfterOpen = true;
        this.clearResumeAfterSeek(); this.seekWasPlaying = false;
        this.cancelRemoteSeek(); this.video.pause();
      }
    });
  }
  bindVideoEvents(video) {
    const on = (event, handler, target = video) => target.addEventListener?.(event, () => {
      if (this.video === video && this.session) handler();
    });
    on('loadedmetadata', () => {
      this.resume(); this.startAfterInitialSeek(); this.tryResumeAfterSeek();
    });
    on('canplay', () => {
      this.status.textContent = ''; this.resume();
      if (this.resumeAfterSeekTarget != null) this.resumeAfterSeekSawCanplay = true;
      this.tryResumeAfterSeek();
      if (!this.initialSeekPending && this.video.readyState >= 2 && !this.video.seeking)
        this.showBuffering(false);
      this.startAfterInitialSeek();
      if (!this.initialSeekPending && this.video.readyState >= 2) this.scheduleEmbeddedSubtitle();
    });
    on('loadeddata', () => {
      this.resume();
      if (!this.initialSeekPending) { this.hasFirstFrame = true; this.update(); }
      if (!this.initialSeekPending && this.video.readyState >= 2 && !this.video.seeking)
        this.showBuffering(false);
      this.startAfterInitialSeek();
      this.scheduleEmbeddedSubtitle();
      this.checkStartupProgress();
    });
    on('stalled', () => {
      this.onPlaybackStarved();
    });
    on('timeupdate', () => {
      this.startAfterInitialSeek();
      if (this.atMediaEnd() && !this.initialSeekPending) this.showBuffering(false);
      this.applySubtitleSyncOffset();
      this.update();
      this.checkStartupProgress();
      this.tryResumeAfterSeek();
    });
    if (video.textTracks) on('addtrack', () => this.applySubtitleSyncOffset(), video.textTracks);
    on('loadedmetadata', () => this.applySubtitleSyncOffset());
    on('playing', () => {
      this.status.textContent = '';
      this.resume();
      if (this.resumeAfterSeekTarget != null) this.resumeAfterSeekSawPlaying = true;
      this.tryResumeAfterSeek();
      // HTMLMediaElement.playing guarantees decoder playback; webOS 4.4 can
      // report readyState 1 during real frames. Do not hide a real intro prompt
      // behind an unreliable HAVE_CURRENT_DATA gate.
      this.startAfterInitialSeek(true);
      if (!this.initialSeekPending) this.hasFirstFrame = true;
      // LG's hardware video plane can already be playing while the web view
      // still reports zero dimensions or an unchanged media clock. Give its
      // decoder a short head start, then read nearby MKV subtitles instead of
      // waiting for the later video-dimension/clock confirmation.
      if (this.subtitleDiagnostics) this.subtitleDiagnostics.record('playing', Date.now() - this.subtitleDiagnostics.openedAt);
      this.scheduleEmbeddedSubtitle();
      this.update();
      this.focusSkipMarkerIfReady();
      // Reopening for a track change must retain a deliberately paused title.
      // LG still needs Play to decode its initial/resume frame before pausing.
      if (this.pauseAfterOpen && !this.initialSeekPending) {
        this.pauseAfterOpen = false;
        this.video.pause();
        this.update();
        this.checkStartupProgress();
        return;
      }
      if(!this.initialSeekPending) this.showBuffering(false);
      this.report('playing');
      this.track('start');
      if (this.hideAfterSeek) {this.hideAfterSeek = false; this.hideControls();return;}
      // Decoder resume must not reopen chrome the user explicitly hid.
      if (this.controls.classList.contains('hidden-controls')) return;
      this.reveal();
      // Video.load() and decoder buffering may move focus to <body>.
      // Restore the active transport control, but not over user choices.
      if (this.controls.contains(document.activeElement) || document.activeElement === this.skipButton) return;
      if (this.root.contains(document.activeElement) &&
          document.activeElement !== this.video && document.activeElement !== this.root) return;
      const control = this.lastControlFocus;
      if (control?.isConnected && !control.hidden && control.getClientRects().length)
        control.focus();
      else this.root.querySelector('[data-action="pause"]').focus();
    });
    on('pause', () => {
      this.tryResumeAfterSeek();
      this.checkStartupProgress();
      // Waiting/stalled can outlive a paused decoder (notably near EOF).
      // Keep the first-frame and active seek-preview loading gates intact.
      if (!this.initialSeekPending && !this.seeking && !this.video.seeking)
        this.showBuffering(false);
      if (this.session && !this.closing && !this.remoteSeeking) {
        this.report('paused'); this.track('pause');
        // Decoder pause events can arrive after Back hides the chrome.
        // Only an explicit Pause action should reveal it (toggle does so).
        if (!this.hideAfterSeek && !this.controls.classList.contains('hidden-controls')) this.reveal();
      }
    });
    on('waiting', () => {
      this.onPlaybackStarved();
    });
    on('seeking', () => {
      if (this.session && !this.remoteSeeking && !this.atMediaEnd()) this.showBuffering(true);
    });
    on('seeked', () => {
      this.startAfterInitialSeek();
      if (!this.initialSeekPending &&
          (this.video.readyState >= 2 || this.video.paused || this.atMediaEnd()))
        this.showBuffering(false);
      if (this.resumeAfterSeekTarget != null) this.resumeAfterSeekLanded = true;
      this.tryResumeAfterSeek();
    });
    on('ended', () => this.close(true));
    on('error', () => this.failed());
  }
  get active() { return !this.root.hidden; }
  // An HLS replay can be queued behind teardown while the player is hidden.
  get pendingOpen() { return this.root.hidden && this.pendingOpenGeneration === this.generation; }
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
    this.marker = null; this.skipDismissed = false; this.skipFocusPending = false;
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
    const skipped = this.skippedMarker;
    const found = this.hasFirstFrame && this.session
      ? (this.session.markers || []).find(m => ['intro','credits'].includes(m.type) &&
        this.skipMode(m) !== 'off' && position >= m.start && position < m.end &&
        !(skipped && m.type === skipped.type && m.start === skipped.start && m.end === skipped.end)) : null;
    if (found !== this.marker) {
      this.clearSkipMarker();
      this.marker = found || null;
      if (found) {
        this.skipFocusPending = true;
        this.startAutoSkip(found);
        // The button must enter the visible tree BEFORE requesting focus.
        // Focusing its [hidden] state silently fails in Chromium.
        this.renderSkipMarker();
        this.focusSkipMarkerIfReady();
      }
    }
    this.renderSkipMarker();
  }
  focusSkipMarkerIfReady() {
    // A decoded first frame can precede the playing event. Defer the request
    // until playback starts, then focus only the newly appeared prompt.
    if (!this.skipFocusPending || this.video.paused || this.seeking ||
        !this.hasFirstFrame || this.skipButton.hidden) return;
    this.skipFocusPending = false;
    // Plezy does not steal D-pad focus from a chapter/track sheet.
    if (!this.sheet.hidden) return;
    if (typeof window.PalmSystem !== 'undefined' ||
        /web0s|webos|netcast/i.test(navigator.userAgent)) this.skipButton.focus();
  }
  renderSkipMarker() {
    const marker = this.marker;
    const chromeVisible = !this.controls.classList.contains('hidden-controls');
    const visible = !!marker && (!this.skipDismissed || chromeVisible);
    this.skipButton.hidden = !visible;
    this.skipButton.classList.toggle('with-chrome', chromeVisible);
    if (visible && chromeVisible) {
      if (this.skipControlsHeight < 0) {
        const height = this.controls.offsetHeight;
        if (height > 0) {
          this.skipControlsHeight = height;
          this.skipButton.style.bottom = (height + 16) + 'px';
        }
      }
    } else {
      this.skipButton.style.bottom = '';
      this.skipControlsHeight = -1;
    }
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
    // LG can report the old time throughout the seek/buffer cycle. Prevent
    // syncSkipMarker from recreating this exact prompt after we dismiss it;
    // an explicit user seek restores eligibility if they revisit the intro.
    this.skippedMarker = {type:marker.type, start:marker.start, end:marker.end};
    this.clearSkipMarker();
    const duration = this.timelineDuration();
    // Native Plezy hands end-of-video credits to the completion path rather
    // than seeking to an EOF that may never report another position update.
    // WebOS has no Play Next prompt yet, so complete the current title.
    if (marker.type === 'credits' && duration > 0 && duration - marker.end <= 1) {
      this.video.pause(); this.close(true);
    } else this.seekTo(marker.end, true);
  }
  dismissSkipMarker() {
    if (!this.marker) return;
    this.cancelSkipTimers();
    this.skipDismissed = true;
    this.renderSkipMarker();
  }
  seekChapter(forward) {
    if (!this.session) return;
    const chapters = this.session.chapters || [];
    const target = chapterSeekTarget(this.position(), chapters, forward);
    if (target === null) {
      if (!chapters.length) this.seek(forward ? 30 : -10);
      return;
    }
    this.seekTo(target);
  }
  currentChapterIndex() {
    return chapterIndexAtPosition(this.position(), this.session?.chapters || []);
  }
  updateChapterSheet() {
    if (this.sheet.hidden || this.openSheetAction !== 'chapter-options') return;
    const current = this.currentChapterIndex();
    this.sheet.querySelectorAll('[data-chapter-index]').forEach(button => {
      const active = Number(button.dataset.chapterIndex) === current;
      button.classList.toggle('is-current', active);
      button.setAttribute('aria-current', active ? 'true' : 'false');
      button.querySelector('.chapter-current-icon').hidden = !active;
    });
  }
  renderChapterBoundaries() {
    const duration = this.timelineDuration();
    if (duration === this.chapterBoundaryDuration) return;
    this.chapterBoundaryDuration = duration;
    const layer = this.root.querySelector('.chapter-gaps');
    layer.textContent = '';
    const starts = new Set();
    for (const chapter of this.session?.chapters || []) {
      if (!(chapter.start > 0 && chapter.start < duration) || starts.has(chapter.start)) continue;
      starts.add(chapter.start);
      const gap = document.createElement('span');
      gap.className = 'chapter-gap';
      gap.style.left = (chapter.start / duration * 100) + '%';
      layer.appendChild(gap);
    }
  }
  populateChapterControls(session) {
    const chapters = this.root.querySelector('[data-chapter]');
    chapters.textContent = '';
    const heading = document.createElement('option');
    heading.value = ''; heading.textContent = 'Jump to chapter'; chapters.append(heading);
    (session.chapters || []).forEach(chapter => {
      const option = document.createElement('option'); option.value = chapter.start;
      option.textContent = time(chapter.start) + ' · ' + chapter.title; chapters.append(option);
    });
    const available = !!session.chapters?.length;
    this.root.querySelector('[data-chapters]').hidden = !available;
    // Keep the menu disc in place while chapter metadata is arriving.
    this.root.querySelector('[data-action="chapter-options"]').disabled = !available;
    this.chapterBoundaryDuration = null;
    this.renderChapterBoundaries();
    if (!this.sheet.hidden && this.openSheetAction === 'chapter-options')
      this.openSheet('chapter-options'); // Refresh a chapter sheet opened before extras arrived.
  }
  subtitleSyncStorageKey() {
    const id = this.item?.ratingKey || this.item?.id || this.item?.key;
    return id && this.api?.server
      ? 'plezy.webos.subtitleSync.' + catalogScope(this.api.server) + '.' + String(id) : null;
  }
  loadSubtitleSyncOffset() {
    this.subtitleSyncOffsetMs = 0;
    if (!this.enhancedPlaybackActive) return;
    try {
      const key = this.subtitleSyncStorageKey();
      const value = key && Number(localStorage.getItem(key));
      if (Number.isFinite(value)) this.subtitleSyncOffsetMs = clamp(Math.round(value / 50) * 50, -60000, 60000);
    } catch (_) {}
  }
  setSubtitleSyncOffset(offsetMs) {
    if (!this.enhancedPlaybackActive || !this.session?.subtitleAsset || this.session?.subtitleBurnedIn) return;
    this.subtitleSyncOffsetMs = clamp(Math.round(Number(offsetMs) / 50) * 50, -60000, 60000);
    try {
      const key = this.subtitleSyncStorageKey();
      if (key) {
        if (this.subtitleSyncOffsetMs) localStorage.setItem(key, String(this.subtitleSyncOffsetMs));
        else localStorage.removeItem(key);
      }
    } catch (_) {}
    this.applySubtitleSyncOffset();
    this.updateSubtitleSyncControls();
  }
  formatSubtitleSyncOffset() {
    const offset = this.subtitleSyncOffsetMs;
    // Port upstream formatSyncOffset: signed milliseconds below 10s,
    // signed seconds to one decimal at larger corrections.
    const magnitude = Math.abs(offset);
    return (offset >= 0 ? '+' : '-') +
      (magnitude >= 10000 ? (magnitude / 1000).toFixed(1) + 's' : magnitude + 'ms');
  }
  updateSubtitleSyncControls() {
    const label = this.formatSubtitleSyncOffset();
    const settingsValue = this.sheet.querySelector('.player-settings-sync-value');
    const legacyMode = !this.enhancedPlaybackActive;
    const burnedIn = !!this.session?.subtitleBurnedIn;
    const noLocalTrack = !this.session?.subtitleAsset;
    const disabled = legacyMode || burnedIn || noLocalTrack;
    if (settingsValue) settingsValue.textContent = burnedIn ? 'Burned in' :
      legacyMode ? 'Local subtitles off' : noLocalTrack ? 'No subtitles' : label;
    const settingsRow = this.sheet.querySelector('.player-settings-sync');
    if (settingsRow) {
      settingsRow.classList.toggle('is-active', !disabled && this.subtitleSyncOffsetMs !== 0);
      settingsRow.classList.toggle('is-disabled', disabled);
      // Keep it focusable for remote navigation; selecting it explains why
      // subtitle timing is unavailable in the current playback mode.
      settingsRow.setAttribute('aria-disabled', String(disabled));
    }
    const value = this.sheet.querySelector('.sync-offset-value');
    if (value) value.textContent = label;
    const slider = this.sheet.querySelector('.sync-offset-slider');
    if (slider) {
      slider.setAttribute('aria-valuetext', label);
      const position = clamp(this.subtitleSyncOffsetMs, -10000, 10000);
      slider.value = String(position);
      slider.style.setProperty('--sync-progress', ((position + 10000) / 200) + '%');
    }
    const reset = this.sheet.querySelector('[data-sync="reset"]');
    if (reset) reset.setAttribute('aria-disabled', String(this.subtitleSyncOffsetMs === 0));
  }
  adjustSubtitleSync(direction, step = 50) {
    this.setSubtitleSyncOffset(this.subtitleSyncOffsetMs + direction * step);
  }
  stopSyncHold() {
    clearTimeout(this.syncHoldTimeout);
    clearInterval(this.syncHoldInterval);
    this.syncHoldTimeout = null;
    this.syncHoldInterval = null;
  }
  startSyncHold(direction) {
    this.stopSyncHold();
    if (!this.enhancedPlaybackActive || !this.session?.subtitleAsset || this.session?.subtitleBurnedIn) return;
    this.syncHoldFired = false;
    this.syncHoldTimeout = setTimeout(() => {
      this.syncHoldFired = true;
      this.adjustSubtitleSync(direction, 1000);
      this.syncHoldInterval = setInterval(() => this.adjustSubtitleSync(direction, 1000), 200);
    }, 400);
  }
  openSyncBar() {
    if (this.session?.subtitleBurnedIn) {
      this.notify('Cannot offset burned-in subtitles');
      return;
    }
    if (!this.enhancedPlaybackActive || !this.session?.subtitleAsset) {
      this.notify('Enable enhanced SRT or ASS playback in Settings to adjust subtitle timing');
      return;
    }
    this.stopSyncHold();
    this.openSheetAction = 'options';
    this.sheet.classList.remove('sheet-tracks');
    this.sheet.classList.add('sheet-sync');
    this.sheet.querySelector('[data-sheet-title]').textContent = 'Subtitle sync';
    const list = this.sheet.querySelector('.player-options-list');
    list.classList.remove('player-track-columns');
    list.textContent = '';
    const bar = document.createElement('div');
    bar.className = 'sync-offset-bar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Subtitle sync');
    const icon = document.createElement('span');
    icon.className = 'sync-offset-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 11h5m2 0h5M6 15h12" stroke="currentColor" stroke-width="2"/></svg>';
    const title = document.createElement('span');
    title.className = 'sync-offset-title';
    title.textContent = 'Subtitle sync';
    const stepButton = (action, symbol, label, direction) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sync-offset-button';
      button.dataset.sync = action;
      button.innerHTML = symbol;
      button.setAttribute('aria-label', label);
      if (direction) {
        button.dataset.syncStep = String(direction);
        button.onclick = () => {
          if (this.syncHoldFired) { this.syncHoldFired = false; return; }
          this.adjustSubtitleSync(direction);
        };
        button.addEventListener('pointerdown', event => {
          if (event.button === 0) this.startSyncHold(direction);
        });
        button.addEventListener('pointerup', () => this.stopSyncHold());
        button.addEventListener('pointerleave', () => this.stopSyncHold());
        button.addEventListener('blur', () => this.stopSyncHold());
        button.addEventListener('pointercancel', () => {
          this.stopSyncHold(); this.syncHoldFired = false;
        });
      }
      return button;
    };
    // SVG paths are rendered reliably on LG's old Chromium. Unicode ↺ can
    // fall back to a tofu/checkbox glyph when the TV lacks that font character.
    const svg = path => '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>';
    const minus = stepButton('minus', svg('M5 12h14'), 'Decrease subtitle delay', -1);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'sync-offset-slider';
    slider.tabIndex = 0; // Explicitly focusable in older LG webOS Chromium.
    slider.min = '-10000'; slider.max = '10000'; slider.step = '50';
    slider.setAttribute('aria-label', 'Subtitle sync offset');
    slider.addEventListener('input', () => this.setSubtitleSyncOffset(Number(slider.value)));
    const plus = stepButton('plus', svg('M12 5v14M5 12h14'), 'Increase subtitle delay', 1);
    const value = document.createElement('output');
    value.className = 'sync-offset-value';
    value.setAttribute('aria-live', 'off');
    const reset = stepButton('reset', svg('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5'), 'Reset subtitle sync');
    reset.onclick = () => this.setSubtitleSyncOffset(0);
    const close = stepButton('close', svg('M5 5l14 14M19 5L5 19'), 'Close subtitle sync');
    close.onclick = () => this.closeSheet();
    bar.append(icon, title, minus, slider, plus, value, reset, close);
    list.appendChild(bar);
    this.sheet.hidden = false;
    this.updateSubtitleSyncControls();
    this.reveal();
    slider.focus();
  }
  applySubtitleSyncOffset() {
    if (!this.enhancedPlaybackActive) return;
    this.subtitleOverlay?.update(this.subtitleSyncOffsetMs);
    if (!this.video?.textTracks || !this.subtitleCueTimes) return;
    const offset = this.subtitleSyncOffsetMs / 1000;
    for (const track of Array.from(this.video.textTracks)) {
      let cues;
      try {
        // A decoder exposing an embedded track must not draw a duplicate
        // beside the local overlay. Leave metadata/chapter tracks alone.
        if (this.session?.subtitleAsset?.embedded && ['subtitles','captions'].includes(track.kind)) {
          if (track.mode !== 'disabled') track.mode = 'disabled';
          continue;
        }
        cues = track.cues;
      } catch (_) { continue; }
      if (!cues) continue;
      for (const cue of Array.from(cues)) {
        let original = this.subtitleCueTimes.get(cue);
        if (!original) {
          original = {start: cue.startTime, end: cue.endTime};
          this.subtitleCueTimes.set(cue, original);
        }
        try {
          const start = original.start + offset;
          const end = Math.max(start + 0.001, original.end + offset);
          if (cue.startTime !== start) cue.startTime = start;
          if (cue.endTime !== end) cue.endTime = end;
        } catch (_) {}
      }
    }
  }
  openSheet(action, preferredTrack = null) {
    const kind = {options:'settings', 'tracks-options':'tracks',
      'chapter-options':'chapter'}[action];
    this.stopSyncHold();
    this.sheet.classList.remove('sheet-sync');
    this.openSheetAction = action;
    this.sheet.querySelector('[data-sheet-title]').textContent = {
      settings:'Playback settings', tracks:'Audio & Subtitles', chapter:'Chapters'}[kind];
    const list = this.sheet.querySelector('.player-options-list');
    list.textContent = '';
    list.classList.toggle('player-track-columns', kind === 'tracks');
    this.sheet.classList.toggle('sheet-tracks', kind === 'tracks');
    if (kind === 'settings') {
      // Plezy shows a settings row that opens a compact sync bar at the top,
      // leaving the subtitles visible while the slider is adjusted.
      const button = document.createElement('button');
      button.className = 'player-settings-sync';
      button.setAttribute('aria-label', 'Subtitle sync');
      button.innerHTML = '<span class="player-settings-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 11h5m2 0h5M6 15h12" stroke="currentColor" stroke-width="2"/></svg></span><span class="player-settings-label">Subtitle sync</span><span class="player-settings-sync-value"></span><span class="player-settings-chevron" aria-hidden="true">›</span>';
      button.onclick = () => this.openSyncBar();
      list.appendChild(button);
      this.updateSubtitleSyncControls();
      const quality = this.root.querySelector('[data-action="transcode"]');
      const qualityButton = document.createElement('button');
      qualityButton.textContent = quality.textContent;
      qualityButton.onclick = () => {
        this.closeSheet();
        quality.click();
      };
      list.appendChild(qualityButton);
    } else if (kind === 'tracks') {
      const audio = this.session?.audio || [];
      const subtitles = this.session?.subtitles || [];
      const columns = [
        {kind:'audio', title:'Audio', entries:audio.length > 1 ? audio : [], off:false},
        {kind:'subtitle', title:'Subtitles', entries:subtitles, off:true}
      ];
      columns.forEach(column => {
        if (!column.entries.length) return;
        const select = this.root.querySelector('[data-track="' + column.kind + '"]');
        const wrapper = document.createElement('div');
        wrapper.className = 'player-track-column';
        if (columns.every(value => value.entries.length)) {
          const heading = document.createElement('h4'); heading.textContent = column.title;
          wrapper.appendChild(heading);
        }
        const entries = column.off ? [{id:-1, primary:'Off'}].concat(column.entries) : column.entries;
        entries.forEach(track => {
          const control = document.createElement('button');
          control.setAttribute('aria-label', track.label || track.primary);
          control.setAttribute('aria-pressed', String(select.value === String(track.id)));
          control.dataset.trackKind = column.kind;
          control.dataset.trackId = String(track.id);
          const primary = document.createElement('strong');
          primary.textContent = track.primary || track.label;
          control.appendChild(primary);
          if (track.secondary) {
            const secondary = document.createElement('small'); secondary.textContent = track.secondary;
            control.appendChild(secondary);
          }
          control.onclick = () => {
            if (select.value === String(track.id)) {
              this.onTrackChoice?.(this.item, this.options.mediaIndex || 0, column.kind, track);
              return;
            }
            select.value = String(track.id);
            Array.from(wrapper.querySelectorAll('button')).forEach(option =>
              option.setAttribute('aria-pressed', String(option === control)));
            select.dispatchEvent(new Event('change'));
          };
          wrapper.appendChild(control);
        });
        list.appendChild(wrapper);
      });
    } else {
      (this.session?.chapters || []).forEach((chapter, index) => {
        const control = document.createElement('button');
        control.className = 'player-chapter-option';
        control.dataset.chapterIndex = String(index);
        if (chapter.thumb && this.api?.server?.kind === 'plex' && chapter.thumb.startsWith('/')) {
          const image = document.createElement('img');
          image.className = 'chapter-thumbnail';
          image.alt = '';
          image.src = this.api.url(chapter.thumb);
          image.onerror = () => image.remove();
          control.appendChild(image);
        }
        const labels = document.createElement('span');
        labels.className = 'chapter-labels';
        const title = document.createElement('strong'); title.textContent = chapter.title;
        const timestamp = document.createElement('small'); timestamp.textContent = time(chapter.start);
        labels.append(title, timestamp);
        control.appendChild(labels);
        const currentIcon = document.createElement('span');
        currentIcon.className = 'chapter-current-icon';
        currentIcon.setAttribute('aria-hidden', 'true');
        currentIcon.textContent = '▶';
        currentIcon.hidden = true;
        control.appendChild(currentIcon);
        control.onclick = () => {
          this.seekTo(chapter.start);
          this.closeSheet();
        };
        list.appendChild(control);
      });
    }
    if (!list.querySelector('button')) list.textContent = 'No tracks available.';
    this.sheet.hidden = false;
    if (kind === 'chapter') this.updateChapterSheet();
    this.reveal();
    const restored = preferredTrack && Array.from(list.querySelectorAll('button')).find(button =>
      button.dataset.trackKind === preferredTrack.kind &&
      button.dataset.trackId === String(preferredTrack.id));
    const first = kind === 'chapter'
      ? list.querySelector('[aria-current="true"]') || list.querySelector('button')
      : restored || list.querySelector('button[aria-pressed="true"]') || list.querySelector('button');
    if (first) first.focus();
    else this.sheet.querySelector('[data-action="close-options"]').focus();
  }
  closeSheet() {
    this.stopSyncHold();
    this.syncHoldFired = false;
    this.sheet.hidden = true;
    this.sheet.classList.remove('sheet-sync');
    this.root.querySelector('[data-action="' + (this.openSheetAction || 'options') + '"]').focus();
    this.reveal();
  }
  async open(api, item, options = {}, preserveTracking = false, trackSheetFocus = null, playing = true) {
    this.openIntentPlaying = playing && !document.hidden;
    const tracking = preserveTracking ? this.playbackTracking : null;
    this.closing = false;
    const cleanup = this.release(false, preserveTracking);
    const generation = this.generation;
    this.pendingOpenGeneration = generation;
    await cleanup;
    if (generation !== this.generation) return;
    // A cancelled HLS startup may still be stopping on Plex or finishing
    // playback negotiation. Let that session retire before requesting another.
    // The wait is bounded, and ordinary decoder replacements never use it.
    await this.waitForStartupTeardown();
    if (generation !== this.generation) return;
    this.pendingOpenGeneration = null;
    // A background event during cleanup can precede the player's visibility.
    if (document.hidden) this.openIntentPlaying = false;
    this.api = api; this.item = item; this.options = options;
    const playbackPreferences = this.preferences();
    // The API chooses the route from the *selected* format and its setting.
    // No local renderer, offset or extraction is started before that choice.
    this.enhancedPlaybackActive = false;
    const diagnosticOpenedAt = playbackPreferences?.diagnosticsEnabled === true ? Date.now() : 0;
    this.pauseAfterOpen = !this.openIntentPlaying;
    this.lastControlFocus = this.root.querySelector('[data-action="pause"]');
    this.lastPosition = options.start || 0;
    this.playbackTracking = tracking || (this.tracker ? this.tracker.createPlayback(api, item) : null);
    this.root.hidden = false; this.status.textContent = '';
    this.showBuffering(true); this.seeking = false; this.remoteSeeking = false;
    this.hideAfterSeek = false;
    this.seekWasPlaying = false;
    this.controlsDismissedByBack = false;
    this.lastPointerPosition = null;
    this.initialSeekPending = false;
    this.initialSeekTarget = 0;
    this.startupComplete = false;
    this.subtitleLoadSession = null;
    this.scrubbing = false;
    if (!trackSheetFocus) this.sheet.hidden = true;
    this.root.querySelector('[data-chapters]').hidden = true;
    this.root.querySelector('[data-action="chapter-options"]').disabled = true;
    this.chapterBoundaryDuration = null;
    const gaps = this.root?.querySelector('.chapter-gaps');
    if (gaps) gaps.textContent = '';
    this.clearSkipMarker(); this.hasFirstFrame = false;
    this.skippedMarker = null;
    this.root.querySelector('.player-title').textContent = item.title;
    this.reveal();
    if (!trackSheetFocus) this.root.querySelector('[data-action="pause"]').focus();
    let session;
    try {
      // Include stale-session teardown in the pending promise. Stop can run
      // before the server has returned a session, and its next Play must not
      // overtake that session's eventual stop request.
      const pending = (async () => {
        const opened = await api.playback(item, {...options,
          srtPlayback: playbackPreferences?.srtPlayback === true,
          skipSettings: playbackPreferences});
        if (generation !== this.generation) {
          await api.stop(opened).catch(() => {});
          return null;
        }
        return opened;
      })();
      this.pendingPlayback = pending;
      try { session = await pending; }
      finally { if (this.pendingPlayback === pending) this.pendingPlayback = null; }
      if (!session) return;
      this.enhancedPlaybackActive = session.enhancedPlayback === true;
      if (!this.enhancedPlaybackActive && this.subtitleOverlay) {
        this.subtitleOverlay.dispose();
        this.subtitleOverlay = null;
      }
      this.session = session;
      this.loadSubtitleSyncOffset();
      this.trackCatalog = session;
      if (diagnosticOpenedAt && this.enhancedPlaybackActive &&
          session.subtitleAsset?.partUrl && session.subtitleAsset.format === 'srt')
        this.subtitleDiagnostics = new SubtitleDiagnostics(this.root, diagnosticOpenedAt);
      if (this.enhancedPlaybackActive && session.subtitleAsset && !this.subtitleOverlay)
        this.subtitleOverlay = new SubtitleOverlay(this.video, this.root.querySelector('.player-captions'),this.preferences);
      if (!session.subtitleBurnedIn) this.loadSeekFrames(session, generation);
      if (session.extrasPromise) session.extrasPromise.then(extras => {
        if (generation !== this.generation || this.session !== session || !extras) return;
        session.markers = extras.markers;
        session.chapters = extras.chapters;
        this.populateChapterControls(session);
        this.update();
      });
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
        const chosen = session[kind === 'audio' ? 'audio' : 'subtitles'].find(track => track.selected);
        select.value = options[kind] === undefined ? (chosen ? String(chosen.id) : defaultOption.value)
          : String(options[kind]);
      }
      if (trackSheetFocus) this.openSheet('tracks-options', trackSheetFocus);
      this.populateChapterControls(session);
      // Keep the opening frame invisible until the resume target has been
      // sought and decoded. Loading indicators remain independently visible.
      this.video.style.visibility = this.initialSeekPending ? 'hidden' : 'visible';
      // Arm before load/play: synchronous errors and never-settling Play
      // promises must not leave startup without a recovery deadline.
      this.armStartupTimeout(session, generation);
      this.loadSource(session);
      if (generation !== this.generation || this.session !== session) return;
      // Embedded SRT reads start after decoder startup; standalone SRT
      // can load in parallel with video without an additional decoder reload.
      if (this.enhancedPlaybackActive && session.subtitleAsset &&
          (!session.subtitleAsset.partUrl || this.options.skipMatroskaSubtitles))
        this.loadSubtitleAsset(session, generation);
      this.report('start');
      this.interval = setInterval(() => this.report(this.video.paused ? 'paused' : 'playing'), 10000);
      // On webOS a non-started video often never reaches canplay/seeked.
      // Initialize the decoder, but do not show its frame until the resume
      // seek is ready.
      await this.beginVideoPlayback(generation);
    } catch (error) {
      if (generation === this.generation) { this.showBuffering(false);this.status.textContent = error.message; this.reveal(); }
    }
  }
  async loadSubtitleAsset(session, generation) {
    if (!this.enhancedPlaybackActive || !this.subtitleOverlay ||
        generation !== this.generation || this.session !== session ||
        this.subtitleLoadSession === session) return;
    this.subtitleLoadSession = session;
    clearTimeout(this.embeddedSubtitleTimer);
    this.embeddedSubtitleTimer = null;
    const selection = session.subtitleAsset;
    const asset = this.options.skipMatroskaSubtitles ? {...selection, partUrl:null} : selection;
    const alive = () => generation === this.generation && this.session === session &&
      session.subtitleAsset === selection;
    this.subtitleOverlay.onError = error => {
      if (alive()) this.subtitleFailed(error, session);
    };
    if (asset.partUrl) this.matroskaSubtitleSession = session;
    try {
      const diagnostics = this.subtitleDiagnostics;
      const onTiming = diagnostics ? (event, duration) => {
        if (alive()) diagnostics.record(event, duration);
      } : null;
      if (onTiming) onTiming('source', asset.partUrl ? 'MKV byte ranges' :
        this.options.skipMatroskaSubtitles ? 'Plex sidecar (decoder retry)' : 'Plex sidecar');
      await this.subtitleOverlay.load(asset, this.subtitleSyncOffsetMs,
        this.position(), onTiming);
    } catch (error) {
      if (alive() && error.name !== 'AbortError') this.subtitleFailed(error, session);
    } finally {
      if (this.matroskaSubtitleSession === session) this.matroskaSubtitleSession = null;
    }
  }
  scheduleEmbeddedSubtitle() {
    if (!this.enhancedPlaybackActive || !this.session?.subtitleAsset?.partUrl ||
        this.options?.skipMatroskaSubtitles ||
        this.initialSeekPending || this.pendingStart ||
        this.embeddedSubtitleTimer != null) return;
    if (this.subtitleLoadSession === this.session) return;
    const session=this.session, generation=this.generation;
    this.embeddedSubtitleTimer=setTimeout(() => {
      this.embeddedSubtitleTimer=null;
      if (this.session === session && this.generation === generation &&
          !this.initialSeekPending && !this.pendingStart)
        this.loadSubtitleAsset(session, generation);
    }, 200);
  }
  loadSource(session) {
    this.nativeSource = typeof window.PalmSystem !== 'undefined' ||
      /web0s|webos|netcast/i.test(navigator.userAgent);
    if (this.nativeSource) {
      // LG's equivalent of Plezy's Media(start:): pass milliseconds to the
      // pipeline BEFORE load/play. This was the working one-buffer legacy
      // behavior before the custom playback/subtitle pipeline was introduced.
      const source = document.createElement('source');
      source.setAttribute('src', session.url);
      const mime = session.transcode ? 'application/vnd.apple.mpegurl' : (session.mimeType || 'video/mp4');
      source.setAttribute('type', mime +
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
        clearTimeout(this.startTimeout);
        this.showBuffering(false);this.status.textContent='Press Play to start.';
      } else if (error.name!=='AbortError') {
        // Some native opens reject Play without dispatching a media error.
        this.failed();
      }
    }
  }
  resume() {
    if (this.pendingStart && this.session && this.video.readyState>=1) {
      try {
        const available=Math.max(Number.isFinite(this.video.duration)?this.video.duration:0,
          Number(this.item?.duration)||0);
        // Thin Plex listings can omit duration before the HLS metadata
        // arrives. Unknown duration must not turn a valid resume into 0:00.
        const target=clamp(this.pendingStart,0,available>0?Math.max(0,available-1):this.pendingStart);
        this.video.currentTime=target;
        this.pendingStart=0;
        if(this.initialSeekPending)this.initialSeekTarget=target;
      } catch (_) { /* Retry once the source is seekable. */ }
    }
  }
  startAfterInitialSeek(playing = false) {
    if(!this.initialSeekPending || this.pendingStart || !this.session)return;
    if (playing) this.initialSeekSawPlaying = true;
    const nativeHls = this.nativeSource && this.session.transcode;
    // LG can emit playing before it publishes the clock at the resume point.
    // Keep that frame evidence even if the later clock update has readyState 1.
    const ready = playing || this.video.readyState >= 2 || (nativeHls && this.initialSeekSawPlaying);
    const position = this.video.currentTime;
    if (this.video.seeking || !ready || !Number.isFinite(position) ||
        position < this.initialSeekTarget - 1 || (!nativeHls && position > this.initialSeekTarget + 1)) return;
    this.initialSeekPending = false;
    this.hasFirstFrame = true;
    this.video.style.visibility='visible';
    if (this.skipButton) this.update();
    this.checkStartupProgress();
    // LG needs Play to decode a resume frame. Pause as soon as its seek has
    // landed; the decoder may not dispatch another playing event afterward.
    if (this.pauseAfterOpen) this.video.pause();
    this.showBuffering(false);
    // Native resumed playback may not dispatch another playing event.
    // Start embedded SRT loading once the first frame is confirmed.
    this.scheduleEmbeddedSubtitle();
  }
  armStartupTimeout(session = this.session, generation = this.generation) {
    clearTimeout(this.startTimeout);
    this.startTimeout = setTimeout(() => {
      if (generation !== this.generation || this.session !== session || this.startupComplete) return;
      // The original Plex pipeline completed startup on the first decoded
      // frame, without relying on videoWidth or clock-progress heuristics.
      if (session?.legacyPlexPlayback && this.video.readyState >= 2 && !this.initialSeekPending) return;
      this.failed('startup timed out');
    }, 30000);
  }
  checkStartupProgress() {
    if (!this.session || this.startupComplete || this.initialSeekPending || this.pendingStart) return;
    if (this.session.legacyPlexPlayback) {
      // Restore the pre-renderer gate: LG can show valid HLS frames even
      // without reporting a videoWidth or an advancing clock immediately.
      if (this.hasFirstFrame || this.video.readyState >= 2) {
        this.startupComplete = true;
        clearTimeout(this.startTimeout);
        // Keep the full BIF download off the burn-in startup/resume path.
        if (this.session.subtitleBurnedIn) this.loadSeekFrames(this.session, this.generation);
      }
      return;
    }
    // A hardware video plane may expose decoded frames before its dimensions.
    // An advancing audio clock alone still cannot start MKV extraction.
    if (!(this.hasFirstFrame || this.video.videoWidth > 0 || this.video.webkitDecodedFrameCount > 0)) {
      const quality = this.video.getVideoPlaybackQuality?.();
      if (!(quality && quality.totalVideoFrames > quality.droppedVideoFrames)) return;
    }
    // loadedmetadata/loadeddata/canplay (and even a resolved Play) are not
    // proof the video clock advances. Paused reopens need just one frame.
    if (this.video.currentTime > this.initialSeekTarget + 0.1 ||
        this.openIntentPlaying === false && this.hasFirstFrame) {
      this.startupComplete = true;
      clearTimeout(this.startTimeout);
      if (this.subtitleDiagnostics) this.subtitleDiagnostics.record('video', Date.now() - this.subtitleDiagnostics.openedAt);
      if (this.enhancedPlaybackActive && this.session.subtitleAsset?.partUrl &&
          !this.options.skipMatroskaSubtitles)
        this.scheduleEmbeddedSubtitle();
    }
  }
  position() {
    return (this.initialSeekPending ? this.initialSeekTarget : this.pendingStart) || (this.video.currentTime || 0);
  }
  update() {
    const position=this.position();
    this.syncSkipMarker(position);
    this.renderChapterBoundaries();
    this.updateChapterSheet();
    // Live timeupdate events must not overwrite the unconfirmed seek readout.
    const played = this.remoteSeeking ? this.seekPreview : position;
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
    const session = this.session;
    if (!session) return;
    if (!this.reporter || this.reporter.session !== session) {
      this.reporter = new ProgressReporter(this.api, session, () => {
        if (this.session === session && !this.reportWarning) {
          this.reportWarning = true;
          this.notify('Progress could not be synced to the server.');
        }
      });
    }
    const position = this.position();
    const duration = this.timelineDuration();
    if (state === 'stopped') return this.reporter.stop(position, duration);
    else this.reporter.report(state, position, duration);
  }
  track(action, ended = false) {
    if (!this.playbackTracking || !this.item) return;
    const position = this.position() || this.lastPosition || 0;
    const duration = this.timelineDuration();
    this.playbackTracking.event(action, position, duration, ended);
  }
  queueStartupTeardown(work) {
    const previous = this.pendingStartupTeardown;
    const pending = Promise.all([previous, work].filter(Boolean).map(task =>
      Promise.resolve(task).catch(() => {})));
    this.pendingStartupTeardown = pending;
    void pending.then(() => {
      if (this.pendingStartupTeardown === pending) this.pendingStartupTeardown = null;
    });
  }
  async waitForStartupTeardown() {
    const pending = this.pendingStartupTeardown;
    if (!pending) return;
    let timeout;
    try {
      await Promise.race([pending, new Promise(resolve => {
        // Network timeouts must not make Stop/replay hang indefinitely.
        timeout = setTimeout(resolve, 3000);
      })]);
    } finally { clearTimeout(timeout); }
  }
  async release(ended = false, preserveTracking = false) {
    this.stopSyncHold();
    this.syncHoldFired = false;
    ++this.generation;
    this.pendingOpenGeneration = null;
    clearTimeout(this.embeddedSubtitleTimer);
    this.embeddedSubtitleTimer = null;
    this.subtitleLoadSession = null;
    clearTimeout(this.startTimeout); clearTimeout(this.hideTimer); clearInterval(this.interval);
    this.subtitleOverlay?.clear();
    this.subtitleDiagnostics?.dispose();
    this.subtitleDiagnostics = null;
    this.matroskaSubtitleSession = null;
    this.root?.classList?.remove('subtitle-lift');
    if (this.previewAbort) this.previewAbort.abort();
    this.previewAbort = null;
    this.previewFrames = null;
    this.hideSeekPreview();
    const session = this.session, api = this.api;
    const replaceVideo = this.nativeSource && session?.transcode && !this.startupComplete;
    // An explicit Stop may race Plex's transcode teardown even if LG has
    // already reported startup complete. Track changes remain non-blocking
    // once their old decoder has reached a confirmed first frame.
    const interruptedHls = !!(session?.transcode && (!preserveTracking || !this.startupComplete));
    if (!session && this.pendingPlayback) this.queueStartupTeardown(this.pendingPlayback);
    this.lastPosition = this.position() || this.lastPosition || 0;
    const reportDone = session ? this.report('stopped') : null;
    // Tracking belongs to the viewing, not a particular decoder session. A
    // failed/replaced decoder must still finish the started Simkl viewing.
    if (!preserveTracking) {
      this.track('stop', ended); this.playbackTracking = null; this.trackCatalog = null;
    }
    this.clearSkipMarker(); this.hasFirstFrame = false;
    this.skippedMarker = null;
    this.session = null; this.pendingStart = 0;
    this.chapterBoundaryDuration = null;
    const gaps = this.root?.querySelector('.chapter-gaps');
    if (gaps) gaps.textContent = '';
    this.showBuffering(false); this.seeking = false; this.remoteSeeking = false;
    this.hideAfterSeek = false;
    this.seekWasPlaying = false;
    this.controlsDismissedByBack = false;
    this.clearResumeAfterSeek();
    this.resumeAfterSeekTimer = null;
    this.initialSeekPending = false;
    this.initialSeekTarget = 0;
    this.scrubbing = false;
    this.initialSeekSawPlaying = false;
    this.nativeSource = false;
    const video = this.video;
    video.style.visibility = 'visible';
    video.pause(); video.removeAttribute('src');
    Array.from(video.querySelectorAll('source')).forEach(source => source.remove());
    if (replaceVideo) {
      // Discard the unfinished LG decoder with its DOM element, like Plezy
      // disposes the native player on exit. Late events belong to that element.
      this.subtitleOverlay?.dispose();
      this.subtitleOverlay = null;
      this.video = video.cloneNode(false);
      video.parentNode.replaceChild(this.video, video);
      this.bindVideoEvents(this.video);
    }
    video.load();
    // Never await playback reporting (or server-side transcode teardown) when
    // stopping/reopening the hardware decoder. The per-session reporter owns
    // its final stopped report and cannot feed stale heartbeats into a new one.
    this.reporter = null;
    if (session) {
      const stopping = Promise.resolve().then(() => api.stop(session)).catch(() => {});
      if (interruptedHls) this.queueStartupTeardown(stopping);
    }
    this.reportWarning = false;
    // Return the promise as a property: release must not await reporting.
    return {reportDone};
  }
  async close(ended = false) {
    if (this.closing) return;
    this.closing = true;
    this.root.hidden = true;
    const cleanup = this.release(ended);
    const generation = this.generation;
    const {reportDone} = await cleanup;
    if (generation !== this.generation) return;
    this.closing = false;
    this.onClose(reportDone);
  }
  // An enhanced SRT stream has no subtitle pixels: SRT-to-SRT and SRT-to-Off
  // replace only the overlay. ASS/SSA must reopen for Plex to burn its pixels.
  switchLocalSubtitle(id) {
    const session = this.session;
    if (!session?.enhancedPlayback || !this.subtitleOverlay || this.closing ||
        this.options.burnSubtitles || typeof this.api?.localSubtitleAsset !== 'function') return false;
    const choices = {...this.options, subtitle:id, burnSubtitles:false, skipMatroskaSubtitles:false};
    const prefs = this.preferences();
    const asset = id === -1 ? null : this.api.localSubtitleAsset(this.item, {...choices,
      srtPlayback:prefs?.srtPlayback === true});
    if (id !== -1 && !asset) return false;
    this.options = choices;
    session.options = choices;
    session.subtitleAsset = asset;
    session.subtitleBurnedIn = false;
    session.subtitles.forEach(track => { track.selected = String(track.id) === String(id); });
    clearTimeout(this.embeddedSubtitleTimer);
    this.embeddedSubtitleTimer = null;
    this.subtitleLoadSession = null;
    this.matroskaSubtitleSession = null;
    this.subtitleOverlay.clear();
    this.subtitleDiagnostics?.dispose();
    this.subtitleDiagnostics = prefs?.diagnosticsEnabled === true && asset?.partUrl && asset.format === 'srt'
      ? new SubtitleDiagnostics(this.root, Date.now()) : null;
    this.updateSubtitleSyncControls();
    if (asset) {
      if (asset.partUrl) this.scheduleEmbeddedSubtitle();
      else this.loadSubtitleAsset(session, this.generation);
    }
    return true;
  }
  async reopen(changes, trackSheetFocus = null) {
    if (!this.item || this.closing) return;
    // Decoder fallback can restart playback again after a track change.
    // Preserve the open sheet and the remote's focused track through that
    // secondary restart too, even when the fallback itself chose no track.
    if (!trackSheetFocus && !this.sheet.hidden && this.openSheetAction === 'tracks-options') {
      const focused = document.activeElement;
      if (focused?.dataset?.trackKind)
        trackSheetFocus = {kind:focused.dataset.trackKind, id:focused.dataset.trackId};
      else trackSheetFocus = {kind:'audio', id:this.root.querySelector('[data-track="audio"]').value};
    }
    const playing = this.session ? this.resumeAfterSeekTarget != null ||
      ((this.video.error || this.startupComplete === false) ? this.openIntentPlaying !== false : !this.video.paused)
      : this.openIntentPlaying !== false;
    const position = this.session ? this.position() : this.options.start || this.lastPosition || 0;
    const options = {...this.options, ...changes, start: changes.start ?? position};
    // Empty audio select means the server default, not stream zero.
    if (changes.audio === 0 && this.root.querySelector('[data-track="audio"]').value === '') delete options.audio;
    // Publish the combined choice before cleanup awaits network reporting.
    // Another selection while the sheet stays open must build on this one.
    this.options = options;
    return this.open(this.api, this.item, options, true, trackSheetFocus, playing);
  }
  async subtitleFailed(error, session) {
    if (!this.enhancedPlaybackActive || !this.session || this.session !== session || this.recoveringSession === session ||
        session.subtitleBurnedIn || !session.subtitleAsset) return;
    // Both the Matroska reader and Plex's independent subtitle endpoint can
    // fail. Unlike MPV, LG's HTML player cannot then use an embedded track;
    // restart the same source with Plex rendering the selected track into HLS.
    // No toast during playback: only the disabled sync control explains it.
    console.warn('Local subtitle failed; retrying with Plex burn-in:', error);
    this.recoveringSession = session;
    try { await this.reopen({burnSubtitles:true}); }
    finally { if (this.recoveringSession === session) this.recoveringSession = null; }
  }
  async failed(reason) {
    const session = this.session;
    if (!session || this.closing || this.recoveringSession === session) return;
    clearTimeout(this.startTimeout);
    const retry = this.matroskaSubtitleSession === session ? {skipMatroskaSubtitles:true}
      : !session.transcode ? {transcode:true} : null;
    if (retry) {
      this.recoveringSession = session;
      this.showBuffering(true);
      try { await this.reopen(retry); }
      finally { if (this.recoveringSession === session) this.recoveringSession = null; }
    } else {
      // A replacement HLS decoder can fail before the original reopen's
      // Play promise settles. Its error must never be hidden by that attempt.
      this.clearResumeAfterSeek();
      this.showBuffering(false);
      const code = this.video?.error?.code;
      const detail = reason || (code ? 'decoder error ' + code : 'decoder rejected the stream');
      this.status.textContent = 'Video could not play (HLS, ' + detail + '). Press Stop to return.';
      this.reveal();
    }
  }
  toggle() {
    if (!this.session) return;
    // A Pause command during a seek is an explicit veto, even when the
    // decoder was already paused before the preview started.
    const seekInFlight = this.seeking || this.remoteSeeking ||
      this.resumeAfterSeekTarget != null;
    const pause = seekInFlight || !this.video.paused;
    this.openIntentPlaying = !pause;
    // Some LG decoders deliver a late playing event after pause() cancels
    // an unresolved Play request. Reassert Pause once if that happens.
    this.pauseAfterOpen = pause && seekInFlight;
    this.clearResumeAfterSeek();
    this.seekWasPlaying = false;
    this.cancelRemoteSeek();
    if (pause) {
      clearTimeout(this.startTimeout);
      this.video.pause();
    } else {
      if (this.startupComplete === false) this.armStartupTimeout();
      this.video.play().catch(() => this.failed());
    }
    this.reveal();
  }
  atMediaEnd() {
    const duration = this.video.duration;
    return this.video.ended || (Number.isFinite(duration) && duration > 0 &&
      this.video.currentTime >= duration - 0.15);
  }
  onPlaybackStarved() {
    // HTMLMediaElement.stalled reports *network* inactivity, even when the
    // decoder has enough buffered frames. Only show a spinner if playback
    // actually needs more data to advance; mpv has a separate cache-pause flag.
    if (this.session && !this.seeking && !this.initialSeekPending &&
        !this.video.paused && !this.video.seeking && !this.atMediaEnd() &&
        this.video.readyState < 3) this.showBuffering(true);
  }
  showBuffering(show) {
    if (!this.active) show = false;
    this.buffering.hidden = !show;
    this.buffering.setAttribute('aria-busy', String(show));
    // Older LG Chromium versions are inconsistent about the :hidden rule.
    this.buffering.style.display = show ? 'flex' : 'none';
  }
  async loadSeekFrames(session, generation) {
    if (this.previewAbort || typeof this.api?.scrubPreview !== 'function') return;
    const controller = new AbortController();
    this.previewAbort = controller;
    try {
      const bytes = await this.api.scrubPreview(session, controller.signal);
      if (generation !== this.generation || this.session !== session) return;
      this.previewFrames = parseBif(bytes);
      if (!this.seekTooltip.hidden) this.renderSeekPreview(this.seekTooltipTime ?? this.seekPreview);
    } catch (_) { /* Some Plex servers do not provide BIF indexes. */ }
  }
  renderSeekPreview(seconds) {
    const duration = this.timelineDuration();
    if (!this.session || duration <= 0 || !this.active) return;
    // A user scrub takes priority over waiting for the burn-in startup frame.
    if (this.seeking && this.session.subtitleBurnedIn && !this.previewAbort)
      this.loadSeekFrames(this.session, this.generation);
    const frame = bifFrameAt(this.previewFrames, seconds);
    const hasImage = !!frame;
    this.seekTooltip.classList.toggle('no-image', !hasImage);
    this.seekImage.hidden = !hasImage;
    if (frame && this.seekFrameIndex !== frame.index) {
      this.releaseSeekFrameUrl();
      this.seekFrameIndex = frame.index;
      this.seekFrameUrl = URL.createObjectURL(new Blob([frame.bytes], {type:'image/jpeg'}));
      this.seekImage.src = this.seekFrameUrl;
    }
    const track = this.seekBar.parentElement;
    const width = Math.min(hasImage ? 320 : 64, track.clientWidth);
    this.seekTooltip.style.width = width + 'px';
    this.seekTooltip.style.left = clamp(seconds / duration * track.clientWidth - width / 2,
      0, Math.max(0, track.clientWidth - width)) + 'px';
    this.seekTooltip.querySelector('span').textContent = time(seconds);
    this.seekTooltip.hidden = false;
    this.seekTooltipTime = seconds;
  }
  releaseSeekFrameUrl() {
    if (this.seekFrameUrl) URL.revokeObjectURL(this.seekFrameUrl);
    this.seekFrameUrl = null;
    this.seekFrameIndex = -1;
  }
  hideSeekPreview() {
    if (!this.seekTooltip) return;
    this.seekTooltip.hidden = true;
    this.seekImage.removeAttribute('src');
    this.releaseSeekFrameUrl();
  }
  cancelRemoteSeek() {
    if (!this.remoteSeeking) return;
    const shouldResume = this.seekWasPlaying;
    this.seeking = false; this.remoteSeeking = false; this.scrubbing = false;
    this.seekWasPlaying = false;
    this.hideSeekPreview();
    this.update();
    if (shouldResume && this.session && this.video.paused)
      this.video.play().catch(error => { if (error.name !== 'AbortError') this.failed(); });
  }
  hideControls(byBack = false) {
    clearTimeout(this.hideTimer);
    this.controlsDismissedByBack = byBack;
    if (byBack) this.backHideTime = Date.now();
    this.cancelRemoteSeek();
    this.controls.classList.add('hidden-controls');
    this.root.classList.remove('subtitle-lift');
    this.root.querySelector('.player-top').classList.add('hidden-controls');
    this.seeking = false; this.remoteSeeking = false; this.scrubbing = false;
    this.hideSeekPreview();
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
      // Like Plezy's coalesced timeline preview, keep playback running until
      // OK commits a single decoder seek. Pausing first can deadlock webOS:
      // some LG decoders only complete a seek while the player is running.
    }
    this.scrubbing = true;
    // Native Plezy coalesces timeline movements before a decoder seek.
    // Only the BIF thumbnail and UI change until the viewer confirms with OK.
    this.seekBar.max = String(Math.floor(total));
    this.seekBar.value = String(Math.round(this.seekPreview));
    this.seekBar.setAttribute('aria-valuetext', time(this.seekPreview) + ' of ' + time(total));
    this.root.querySelector('.elapsed-current').textContent = time(this.seekPreview);
    this.root.querySelector('.elapsed-remaining').textContent = '-' + time(total - this.seekPreview);
    this.root.querySelector('.timeline-track progress').value = this.seekPreview / total;
    this.renderSeekPreview(this.seekPreview);
    this.reveal();
    this.seekBar.focus();
  }
  commitSeek() {
    if (!this.seeking) return false;
    const point = this.seekPreview;
    this.scrubbing = false; this.remoteSeeking = false; this.seeking = false;
    this.hideAfterSeek = true;
    this.hideSeekPreview();
    // Confirming a seek is a new Play intent, even if the source was paused.
    this.seekTo(point, false, true);
    this.seekWasPlaying = false;
    this.hideControls();
    return true;
  }
  clearResumeAfterSeek() {
    clearTimeout(this.resumeAfterSeekTimer);
    this.resumeAfterSeekTimer = null;
    this.resumeAfterSeekTarget = null;
    this.resumeAfterSeekPlayPending = false;
    this.resumeAfterSeekPlayRequestedAt = 0;
    this.resumeAfterSeekPlayRequestId = (this.resumeAfterSeekPlayRequestId || 0) + 1;
    this.resumeAfterSeekToken = (this.resumeAfterSeekToken || 0) + 1;
    this.resumeAfterSeekWatchPosition = null;
    this.resumeAfterSeekReadyAt = 0;
    this.resumeAfterSeekWakeAttempts = 0;
    this.resumeAfterSeekLastWakeAt = 0;
    this.resumeAfterSeekSawPlaying = false;
    this.resumeAfterSeekSawCanplay = false;
    this.resumeAfterSeekLanded = false;
  }
  queueResumeAfterSeek(target) {
    this.clearResumeAfterSeek();
    this.resumeAfterSeekTarget = target;
    this.resumeAfterSeekGeneration = this.generation;
    this.resumeAfterSeekQueuedAt = Date.now();
    // Retain the play intent until the video clock actually advances. Neither
    // paused=false nor seeked means an LG hardware decoder is showing frames.
  }
  requestResumeAfterSeek(forceRestart = false) {
    if (this.resumeAfterSeekPlayPending || this.resumeAfterSeekTarget == null) return;
    const token = this.resumeAfterSeekToken;
    const requestId = ++this.resumeAfterSeekPlayRequestId;
    this.resumeAfterSeekPlayPending = true;
    this.resumeAfterSeekPlayRequestedAt = Date.now();
    let request;
    try {
      // On some LG engines paused remains false even though the decoder has
      // stopped advancing after seeking. A single pause/play transition
      // wakes that state; only do it after confirming the clock is frozen.
      if (forceRestart && !this.video.paused) this.video.pause();
      request = this.video.play();
    } catch (error) {
      this.resumeAfterSeekPlayPending = false;
      if (error.name === 'NotAllowedError') {
        this.clearResumeAfterSeek();
        this.status.textContent = 'Press Play to resume.';
      } else if (error.name !== 'AbortError') this.failed();
      return;
    }
    if (!request || typeof request.then !== 'function') {
      this.resumeAfterSeekPlayPending = false;
      return;
    }
    request.then(() => {
      if (this.resumeAfterSeekToken !== token || this.resumeAfterSeekPlayRequestId !== requestId) return;
      this.resumeAfterSeekPlayPending = false;
      this.tryResumeAfterSeek();
    }).catch(error => {
      if (this.resumeAfterSeekToken !== token || this.resumeAfterSeekPlayRequestId !== requestId) return;
      this.resumeAfterSeekPlayPending = false;
      if (error.name === 'NotAllowedError') {
        this.clearResumeAfterSeek();
        this.status.textContent = 'Press Play to resume.';
      } else if (error.name !== 'AbortError') this.failed();
    });
  }
  tryResumeAfterSeek() {
    const target = this.resumeAfterSeekTarget;
    if (target == null) return;
    if (!this.session || this.closing || this.resumeAfterSeekGeneration !== this.generation ||
        this.video.error || (this.atMediaEnd() && target >= this.timelineDuration() - 0.2)) {
      this.clearResumeAfterSeek();
      return;
    }
    const elapsed = Date.now() - this.resumeAfterSeekQueuedAt;
    const position = this.video.currentTime;
    const atTarget = !this.pendingStart && Number.isFinite(position) &&
      Math.abs(position - target) <= 1;
    // seeked confirms landing even when HLS snaps to a nearby keyframe.
    const ready = this.video.readyState >= 1 && (atTarget || this.resumeAfterSeekLanded);
    if (ready && !this.video.seeking && !this.video.paused) {
      if (this.resumeAfterSeekWatchPosition == null) {
        this.resumeAfterSeekWatchPosition = position;
        this.resumeAfterSeekReadyAt = Date.now();
      } else if (position >= this.resumeAfterSeekWatchPosition + 0.2) {
        // Confirm actual clock progression before forgetting automatic resume.
        this.clearResumeAfterSeek();
        return;
      }
    }
    // LG sometimes never resolves the first play() promise while buffering.
    // A pending Promise must not suppress all subsequent recovery attempts.
    if (this.resumeAfterSeekPlayPending &&
        Date.now() - this.resumeAfterSeekPlayRequestedAt > 2200) {
      this.resumeAfterSeekPlayPending = false;
      this.resumeAfterSeekPlayRequestId++;
    }
    const sincePlay = Date.now() - (this.resumeAfterSeekPlayRequestedAt || 0);
    if (ready && !this.video.seeking && !this.video.paused &&
        (this.video.readyState >= 2 || this.resumeAfterSeekSawPlaying ||
         this.resumeAfterSeekSawCanplay) &&
        elapsed >= 3000 && this.resumeAfterSeekReadyAt &&
        Date.now() - this.resumeAfterSeekReadyAt >= 1800 &&
        this.resumeAfterSeekWakeAttempts < 2 &&
        elapsed - this.resumeAfterSeekLastWakeAt >= 3000 &&
        !this.resumeAfterSeekPlayPending) {
      this.resumeAfterSeekWakeAttempts++;
      this.resumeAfterSeekLastWakeAt = elapsed;
      this.requestResumeAfterSeek(true);
    } else if (!this.resumeAfterSeekPlayPending && sincePlay >= 1000) {
      // Play is idempotent. LG can report paused=false AND seeking=true
      // until Play wakes the pipeline. Request it while OK still owns user
      // activation, then retry through buffering without a wall-clock expiry.
      this.requestResumeAfterSeek();
    }
    clearTimeout(this.resumeAfterSeekTimer);
    this.resumeAfterSeekTimer = setTimeout(() => this.tryResumeAfterSeek(), 250);
  }
  timelineDuration() {
    const duration = this.video.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : (this.item?.duration || 0);
  }
  seek(delta) { this.seekTo(this.position() + delta); }
  seekTo(position, fromSkipMarker = false, resumePlayback = null) {
    if (!this.session || !Number.isFinite(position)) return;
    const total = this.timelineDuration();
    if (!(total > 0)) return;
    const target = clamp(position, 0, Math.max(0, total - 0.1));
    // Seeking normally starts playback once the decoder is ready, including
    // seeks started from Pause. Only an explicit pause/override vetoes it.
    const shouldResume = resumePlayback !== false;
    this.clearResumeAfterSeek();
    if (shouldResume) {
      // A new confirmed seek supersedes any earlier explicit Pause latch.
      this.openIntentPlaying = true;
      this.pauseAfterOpen = false;
      this.queueResumeAfterSeek(target);
    }
    if (fromSkipMarker) this.hideAfterSeek = false;
    if (!fromSkipMarker) this.skippedMarker = null;
    if (this.video.readyState < 1) this.pendingStart = target;
    else {
      try { this.video.currentTime = target; }
      catch (_) { this.pendingStart = target; }
    }
    this.seekBar.value = String(Math.round(target));
    this.seekBar.setAttribute('aria-valuetext', time(target) + ' of ' + time(total));
    this.report(this.video.paused ? 'paused' : 'playing');
    this.showBuffering(this.video.seeking || !!this.pendingStart || this.video.readyState < 2);
    this.update(); this.reveal();
    this.tryResumeAfterSeek();
  }
  updateSubtitleLift() {
    const height = this.controls.offsetHeight;
    if (height > 0) this.root.style?.setProperty('--subtitle-lift', -height + 'px');
  }
  reveal() {
    this.controlsDismissedByBack = false;
    this.controls.classList.remove('hidden-controls');
    this.updateSubtitleLift();
    this.root.classList.add('subtitle-lift');
    this.root.querySelector('.player-top').classList.remove('hidden-controls');
    clearTimeout(this.hideTimer);
    this.renderSkipMarker();
    this.hideTimer = setTimeout(() => {
      if (this.session && this.sheet.hidden && !this.video.paused &&
          !this.seeking && !this.remoteSeeking && !this.scrubbing &&
          !['SELECT'].includes(document.activeElement.tagName)) {
        this.hideControls();
      }
    }, 5000);
  }
  key(event) {
    const code = event.keyCode;
    this.cancelAutoSkipFromInteraction();
    // LG's OK key does not always synthesize a DOM click on a button whose
    // focus was assigned while video decoding. Handle Select explicitly.
    if (document.activeElement === this.skipButton && code === 13) {
      event.preventDefault();
      if (!event.repeat) this.activateSkipMarker();
      return true;
    }
    if (!this.sheet.hidden && this.sheet.classList.contains('sheet-sync')) {
      const current = document.activeElement;
      const direction = {37:'left',38:'up',39:'right',40:'down'}[code];
      if (direction) {
        event.preventDefault();
        if (code === 38 || code === 40) {
          // TV UX: Up/Down adjusts the offset and never changes focus.
          this.adjustSubtitleSync(code === 38 ? 1 : -1);
        } else {
          // TV UX: Left/Right is *only* focus traversal, including across
          // the range input. Never rely on a slider endpoint to exit it.
          const controls = Array.from(this.sheet.querySelectorAll(
            '.sync-offset-button, .sync-offset-slider'));
          const index = controls.indexOf(current);
          // Older decoders can steal focus during buffering. Restore the
          // slider first so the D-pad can navigate again without pointer input.
          const target = index < 0
            ? this.sheet.querySelector('.sync-offset-slider')
            : controls[clamp(index + (code === 39 ? 1 : -1), 0, controls.length - 1)];
          if (target) target.focus();
        }
        return true;
      }
      if (code === 13) {
        event.preventDefault();
        if (event.repeat) return true;
        if (current.classList?.contains('sync-offset-slider')) {
          this.sheet.querySelector('[data-sync="close"]').focus();
        } else if (current.dataset?.syncStep) {
          const step = Number(current.dataset.syncStep);
          if (!this.syncHoldTimeout && !this.syncHoldInterval) {
            this.adjustSubtitleSync(step);
            this.startSyncHold(step);
          }
        } else if (current.dataset?.sync === 'reset') {
          this.setSubtitleSyncOffset(0);
        } else if (current.dataset?.sync === 'close') {
          this.closeSheet();
        }
        return true;
      }
    }
    if (!this.sheet.hidden && [37,38,39,40].includes(code)) {
      event.preventDefault();
      const current = document.activeElement;
      const candidates = Array.from(this.sheet.querySelectorAll('button')).filter(node =>
        node !== current && node.getClientRects().length && !node.hidden);
      const direction = {37:'left',38:'up',39:'right',40:'down'}[code];
      const next = nextFocus(current.getBoundingClientRect(),
        candidates.map(value => ({value,rect:value.getBoundingClientRect()})), direction);
      if (next) next.focus();
      return true;
    }
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
      if (!this.controls.classList.contains('hidden-controls')) this.hideControls(true);
      else this.close();
      return true;
    }
    const onTransport = this.controls.contains(document.activeElement) &&
      document.activeElement !== this.seekBar;
    if ([37, 39].includes(code) && !onTransport &&
        (this.controls.classList.contains('hidden-controls') ||
         this.seeking || document.activeElement === this.seekBar)) {
      event.preventDefault();
      this.adjustSeek(code === 37 ? -10 : 10); return true;
    }
    if (code === 13 && this.seeking && !onTransport) {
      event.preventDefault(); this.commitSeek(); return true;
    }
    // Older LG remotes expose Programme +/- as PageUp/PageDown (33/34).
    // Newer webOS versions reserve Channel +/- for the TV itself, so these
    // mappings apply only when the platform actually delivers the key event.
    if ([415, 19, 10252, 32, 412, 417, 33, 34].includes(code)) {
      event.preventDefault();
      if (code === 412 || code === 34) this.seekChapter(false);
      else if (code === 417 || code === 33) this.seekChapter(true);
      else if (code === 415) {
        this.openIntentPlaying = true; this.pauseAfterOpen = false;
        this.clearResumeAfterSeek(); this.cancelRemoteSeek();
        this.video.play().catch(() => this.failed());
      } else if (code === 19) {
        this.openIntentPlaying = false; this.pauseAfterOpen = true;
        this.clearResumeAfterSeek();
        // Cancel preview without replaying its pre-preview play intent.
        this.seekWasPlaying = false; this.cancelRemoteSeek(); this.video.pause();
      }
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
