// SPDX-License-Identifier: GPL-3.0-only
import {CaptionsRenderer, parseText} from 'media-captions';
import {extractMatroskaSubtitle} from './matroska-subtitles.js';

// Positive sync offsets delay subtitles, matching the native text-track editor.
export function subtitleTime(videoTime, offsetMs) {
  return (Number(videoTime) || 0) - (Number(offsetMs) || 0) / 1000;
}

// Plex Web's profile can deliver embedded text in an ASS wrapper even if
// the source track is SRT. Choose the renderer from both source and payload.
function embeddedSubtitleType(content) {
  const text = content.replace(/^\s+/, '');
  if (/^WEBVTT(?:[ \t]|\r?\n)/.test(text)) return 'vtt';
  if (/^\s*\[Events\]/mi.test(text) && /^Dialogue:/mi.test(text)) return 'ssa';
  if (/^\s*\d+:\d{2}:\d{2}[,.]\d+\s+-->\s+\d+:\d{2}:\d{2}[,.]\d+/m.test(text))
    return 'srt';
  throw new Error('Plex did not return a text subtitle file.');
}

async function subtitleRequest(signal, run) {
  const controller = new AbortController();
  let timer;
  let refresh;
  let cancel;
  const deadline = new Promise((_, reject) => {
    cancel = () => {
      const error = new Error('Subtitle request was aborted.');
      error.name = 'AbortError';
      reject(error);
      controller.abort();
    };
    refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        reject(new Error('Subtitle download timed out.'));
        controller.abort();
      }, 30000);
    };
    refresh();
  });
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel);
  try {
    return await Promise.race([run(controller.signal, refresh), deadline]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

async function downloadSubtitle(asset, signal, position, preview) {
  if (asset.partUrl) {
    try {
      return await subtitleRequest(signal, (requestSignal, refresh) =>
        extractMatroskaSubtitle(asset, requestSignal, {position, onRead:refresh, async preview(content) {
          if (!requestSignal.aborted) await preview(content);
        }}));
    } catch (error) {
      if (signal.aborted) throw error;
      console.info('Could not read embedded subtitle from MKV:', error.message);
    }
  }
  return subtitleRequest(signal, async requestSignal => {
    if (asset.decisionUrl) {
      const decision = await fetch(asset.decisionUrl, {signal:requestSignal});
      if (!decision.ok) throw new Error('Plex subtitle decision returned HTTP ' + decision.status);
      await decision.text();
    }
    const response = await fetch(asset.url, {signal:requestSignal});
    if (!response.ok) throw new Error('Subtitle download returned HTTP ' + response.status);
    return response.text();
  });
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
    if (this.abort) this.abort.abort();
    this.abort = null;
    this.releaseRenderer();
  }

  releaseRenderer() {
    this.stopClock();
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

  async load(asset, offsetMs, position = this.video.currentTime) {
    this.clear();
    if (!asset) return;
    const generation = this.generation;
    this.offsetMs = offsetMs;
    const controller = this.abort = new AbortController();
    const render = content => this.render(asset, content, generation);
    try {
      const content = await downloadSubtitle(asset, controller.signal, subtitleTime(position, offsetMs), render);
      await render(content);
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }

  async render(asset, content, generation) {
    if (generation !== this.generation) return;
    const type = asset.embedded ? embeddedSubtitleType(content) : asset.format === 'ass' ? 'ssa' : 'srt';
    if (asset.format === 'srt' || type === 'srt' || type === 'vtt') {
      const track = await parseText(content, {type});
      if (!track.cues.length && content.trim()) throw new Error('Subtitle file contains no readable cues.');
      if (generation !== this.generation) return;
      if (this.kind && this.kind !== 'srt') this.releaseRenderer();
      const renderer = this.renderer || new CaptionsRenderer(this.element);
      this.renderer = renderer;
      this.kind = 'srt';
      renderer.changeTrack(track);
      this.update(this.offsetMs);
      this.startClock();
    } else if (asset.format === 'ass') {
      if (this.kind === 'ass') {
        this.renderer.setTrack(content);
        this.renderer.setCurrentTime(subtitleTime(this.video.currentTime, this.offsetMs));
        return;
      }
      if (typeof window.SubtitlesOctopus !== 'function')
        throw new Error('SubtitlesOctopus is unavailable');
      if (this.kind) this.releaseRenderer();
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
