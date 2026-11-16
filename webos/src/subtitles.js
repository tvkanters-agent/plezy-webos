// SPDX-License-Identifier: GPL-3.0-only
import {CaptionsRenderer, parseText} from 'media-captions';

// Positive sync offsets delay subtitles, matching the native text-track editor.
export function subtitleTime(videoTime, offsetMs) {
  return (Number(videoTime) || 0) - (Number(offsetMs) || 0) / 1000;
}

export function subtitleFormat(codec) {
  const format = String(codec || '').toLowerCase();
  if (format === 'srt' || format === 'subrip') return 'srt';
  if (format === 'ass' || format === 'ssa') return 'ass';
  return null;
}

export class SubtitleOverlay {
  constructor(video, element) {
    this.video = video;
    this.element = element;
    this.generation = 0;
    this.renderer = null;
    this.kind = null;
    this.offsetMs = 0;
    this.abort = null;
    this.frame = null;
    // timeupdate may arrive only four times a second. Keep SRT cue boundaries
    // aligned to the visible playback clock, including short cues.
    video.addEventListener?.('playing', () => this.startClock());
    for (const event of ['pause', 'ended', 'seeking']) {
      video.addEventListener?.(event, () => { this.stopClock(); this.update(this.offsetMs); });
    }
    video.addEventListener?.('seeked', () => {
      this.update(this.offsetMs); this.startClock();
    });
  }

  stopClock() {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  startClock() {
    this.stopClock();
    if (this.kind !== 'srt' || this.video.paused || this.video.ended || this.video.seeking ||
        typeof requestAnimationFrame !== 'function') return;
    const tick = () => {
      this.frame = null;
      if (this.kind !== 'srt') return;
      this.update(this.offsetMs);
      if (!this.video.paused && !this.video.ended && !this.video.seeking)
        this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  clear() {
    ++this.generation;
    this.stopClock();
    if (this.abort) this.abort.abort();
    this.abort = null;
    const renderer = this.renderer;
    this.renderer = null;
    this.kind = null;
    if (renderer) {
      try {
        if (typeof renderer.destroy === 'function') renderer.destroy();
        else if (typeof renderer.dispose === 'function') renderer.dispose();
      } catch (error) { console.warn('Subtitle renderer cleanup failed:', error); }
    }
    this.element.textContent = '';
  }

  async load(asset, offsetMs) {
    this.clear();
    if (!asset) return;
    const generation = this.generation;
    this.offsetMs = offsetMs;
    this.abort = new AbortController();
    const response = await fetch(asset.url, {signal:this.abort.signal});
    if (!response.ok) throw new Error('Subtitle download returned HTTP ' + response.status);
    const content = await response.text();
    if (generation !== this.generation) return;
    if (asset.format === 'srt') {
      const track = await parseText(content, {type:'srt'});
      if (generation !== this.generation) return;
      const renderer = new CaptionsRenderer(this.element);
      this.renderer = renderer;
      this.kind = 'srt';
      renderer.changeTrack(track);
      this.update(this.offsetMs);
      this.startClock();
    } else if (asset.format === 'ass') {
      if (typeof window.SubtitlesOctopus !== 'function')
        throw new Error('SubtitlesOctopus is unavailable');
      // The worker is loaded only for ASS/SSA; webOS 4.x uses its non-WASM build.
      const renderer = new window.SubtitlesOctopus({
        video: this.video, subContent: content, debug:true,
        // Debug mode avoids an uncaught global throw after a handled worker
        // failure; the player retries using Plex burn-in through onError.
        workerUrl: 'libass/subtitles-octopus-worker.js',
        legacyWorkerUrl: 'libass/subtitles-octopus-worker-legacy.js',
        timeOffset: -this.offsetMs / 1000,
        onReady: () => {
          if (generation === this.generation && this.renderer === renderer)
            renderer.setCurrentTime(subtitleTime(this.video.currentTime, this.offsetMs));
        },
        onError: error => {
          if (generation === this.generation && this.onError) this.onError(error);
        }
      });
      if (generation !== this.generation) { renderer.dispose(); return; }
      this.renderer = renderer;
      this.kind = 'ass';
    } else {
      throw new Error('Unsupported external subtitle format.');
    }
    this.abort = null;
  }

  update(offsetMs) {
    const changed = this.offsetMs !== offsetMs;
    this.offsetMs = offsetMs;
    if (!this.renderer) return;
    const currentTime = subtitleTime(this.video.currentTime, offsetMs);
    if (this.kind === 'srt') this.renderer.currentTime = currentTime;
    if (this.kind === 'ass' && changed) {
      this.renderer.timeOffset = -offsetMs / 1000;
      this.renderer.setCurrentTime(currentTime);
    }
  }
}
