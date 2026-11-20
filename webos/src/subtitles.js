// SPDX-License-Identifier: GPL-3.0-only
import {CaptionsRenderer, parseText} from 'media-captions';
import {extractMatroskaSubtitle} from './matroska-subtitles.js';
import {applySrtStyle, resetSrtStyle} from './subtitle-style.js';
import {PixiSrtRenderer} from './pixi-subtitles.js';

let pixiScript;
function ensurePixi() {
  if (window.PIXI?.CanvasRenderer && window.PIXI?.Text) return Promise.resolve(window.PIXI);
  if (!pixiScript) pixiScript=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='pixi.min.js';
    script.onload=()=>window.PIXI?.CanvasRenderer && window.PIXI?.Text
      ? resolve(window.PIXI) : reject(new Error('PixiJS 4 did not initialize.'));
    script.onerror=()=>reject(new Error('Could not load PixiJS subtitle renderer.'));
    document.head.appendChild(script);
  }).catch(error=>{pixiScript=null;throw error;});
  return pixiScript;
}

function loadAssScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'libass/' + src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(script);
  });
}

let assRendererScript;
async function ensureAssRenderer() {
  if (typeof window.SubtitlesOctopus === 'function') return window.plezyAssAssets;
  if (!assRendererScript) {
    assRendererScript = (async () => {
      let wasm = false;
      try {
        wasm = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0]));
      } catch (_) { /* Chromium 53 uses the JavaScript worker. */ }
      if (!window.plezyAssAssets) await loadAssScript('subtitles-octopus-worker' + (wasm ? '' : '-legacy') + '-assets.js');
      await loadAssScript('subtitles-octopus.js');
      if (!window.plezyAssAssets || typeof window.SubtitlesOctopus !== 'function')
        throw new Error('SubtitlesOctopus did not initialize.');
      return window.plezyAssAssets;
    })().catch(error => { assRendererScript = null; throw error; });
  }
  return assRendererScript;
}

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

async function downloadSubtitle(asset, signal, position, preview, onTiming) {
  if (asset.partUrl) {
    try {
      return await subtitleRequest(signal, (requestSignal, refresh) =>
        extractMatroskaSubtitle(asset, requestSignal, {position, onRead:refresh, onTiming, async preview(content) {
          if (!requestSignal.aborted) await preview(content);
        }}));
    } catch (error) {
      if (signal.aborted) throw error;
      if (onTiming) onTiming('fallback', error.message);
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
  constructor(video, element, preferences = () => ({})) {
    this.video = video;
    this.element = element;
    this.preferences = preferences;
    this.generation = 0;
    this.renderer = null;
    this.kind = null;
    this.offsetMs = 0;
    this.abort = null;
    this.frame = null;
    this.readyTimer = null;
    // timeupdate may arrive only four times a second. Keep SRT cue boundaries
    // aligned to the visible playback clock, including short cues.
    this.listeners = [];
    const listen = (type, handler) => {
      video.addEventListener?.(type, handler);
      this.listeners.push({type,handler});
    };
    listen('playing', () => this.startClock());
    for (const event of ['pause', 'ended', 'seeking']) {
      listen(event, () => { this.stopClock(); this.update(this.offsetMs); });
    }
    listen('seeked', () => {
      this.update(this.offsetMs); this.startClock();
    });
    listen('loadedmetadata', () => this.refreshStyle());
    this.resizeStyle = () => this.refreshStyle();
    if (typeof window !== 'undefined') window.addEventListener?.('resize', this.resizeStyle);
  }

  dispose() {
    this.clear();
    for (const {type,handler} of this.listeners) this.video.removeEventListener?.(type, handler);
    this.listeners = [];
    if (typeof window !== 'undefined') window.removeEventListener?.('resize',this.resizeStyle);
  }

  refreshStyle() {
    if (this.kind !== 'srt') return;
    const style=applySrtStyle(this.element,this.video,this.preferences(),this.aspectRatio);
    this.renderer?.setStyle(style);
  }

  stopClock() {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  startClock() {
    this.stopClock();
    if ((this.kind !== 'srt' && !this.dialogue) || this.video.paused || this.video.ended || this.video.seeking ||
        typeof requestAnimationFrame !== 'function') return;
    const tick = () => {
      this.frame = null;
      if (this.kind !== 'srt' && !this.dialogue) return;
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
    this.assContent = null;
    this.assUnavailable = this.assPainted = false;
  }

  releaseRenderer() {
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.stopClock();
    const renderer = this.renderer;
    this.renderer = null;
    this.kind = null;
    this.aspectRatio = null;
    if (renderer) {
      try {
        if (typeof renderer.destroy === 'function') renderer.destroy();
        else if (typeof renderer.dispose === 'function') renderer.dispose();
      } catch (error) { console.warn('Subtitle renderer cleanup failed:', error); }
    }
    this.dialogue?.destroy();
    this.dialogue = null;
    // ASS may fall back to plain dialogue text in this same element. Remove
    // only the local SRT overrides so ASS retains its original presentation.
    resetSrtStyle(this.element);
    this.element.textContent = '';
  }

  async load(asset, offsetMs, position = this.video.currentTime, onTiming = null) {
    this.clear();
    if (!asset) return;
    const generation = this.generation;
    this.offsetMs = offsetMs;
    const controller = this.abort = new AbortController();
    const startedAt = onTiming ? Date.now() : 0;
    let firstRendered = false;
    const render = async content => {
      await this.render(asset, content, generation);
      if (onTiming && !firstRendered && generation === this.generation && this.kind === 'srt') {
        firstRendered = true;
        onTiming('first', Date.now() - startedAt);
      }
    };
    // Start the on-device Pixi script in parallel with Plex/Matroska reads.
    // The initial visible SRT cue should not wait for a separate script load.
    if (asset.format === 'srt' || asset.format === 'vtt') ensurePixi().catch(()=>{});
    try {
      const content = await downloadSubtitle(asset, controller.signal, subtitleTime(position, offsetMs), render, onTiming);
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
      if (!track.cues.length) throw new Error('Subtitle file contains no readable cues.');
      if (generation !== this.generation) return;
      if (this.dialogue || this.kind && this.kind !== 'srt') this.releaseRenderer();
      this.aspectRatio = asset.aspectRatio;
      const style=applySrtStyle(this.element,this.video,this.preferences(),this.aspectRatio);
      const PIXI=await ensurePixi();
      if (generation !== this.generation) return;
      const renderer=this.renderer || new PixiSrtRenderer(PIXI,this.element,this.video,style);
      this.renderer = renderer;
      this.kind = 'srt';
      this.aspectRatio = asset.aspectRatio;
      renderer.setStyle(style);
      renderer.changeTrack(track);
      this.update(this.offsetMs);
      this.startClock();
    } else if (asset.format === 'ass') {
      if (!/\[Events\]/i.test(content) || !/^Dialogue:/mi.test(content))
        throw new Error('ASS subtitle file contains no readable dialogue.');
      if (this.kind && this.kind !== 'ass') this.releaseRenderer();
      this.assContent = content;
      if (!this.assPainted) await this.prepareDialogue(content, generation);
      if (generation !== this.generation || this.assUnavailable) return;
      try {
        await this.renderStyledAss(asset, content, generation);
      } catch (error) {
        await this.assFailure(error, generation);
      }
    } else {
      throw new Error('Unsupported external subtitle format.');
    }
  }

  async prepareDialogue(content, generation) {
    try {
      const track = await parseText(content + '\n', {type:'ssa'});
      if (generation !== this.generation || this.assContent !== content || this.assPainted || !track.cues.length) return;
      // The fallback shares the known-working SRT layout and clock. Leave
      // typesetting to libass when its canvas actually has visible content.
      for (const cue of track.cues) cue.style = undefined;
      const renderer = this.dialogue || new CaptionsRenderer(this.element);
      renderer.changeTrack(track);
      this.dialogue = renderer;
      this.update(this.offsetMs);
      this.startClock();
    } catch (error) {
      console.info('ASS dialogue fallback unavailable:', error.message);
    }
  }

  async assFailure(error, generation) {
    if (generation !== this.generation || this.assUnavailable) return;
    this.assUnavailable = true;
    const wasPainted = this.assPainted;
    this.assPainted = false;
    clearTimeout(this.readyTimer);
    if (wasPainted) await this.prepareDialogue(this.assContent, generation);
    if (generation !== this.generation) return;
    if (!this.dialogue) { this.onError?.(error); return; }
    const renderer = this.renderer;
    this.renderer = null;
    this.kind = null;
    if (renderer?.canvas) renderer.canvas.style.visibility = 'hidden';
    try { renderer?.dispose(); }
    catch (cleanupError) { console.warn('ASS renderer cleanup failed:', cleanupError); }
    console.info('Using timed ASS dialogue:', error.message || error);
  }

  async renderStyledAss(asset, content, generation) {
    if (this.kind === 'ass') {
      this.renderer.setTrack(content);
      this.renderer.setCurrentTime(subtitleTime(this.video.currentTime, this.offsetMs));
      return;
    }
    const resources = await ensureAssRenderer();
    if (generation !== this.generation) return;
    let renderer;
    let ready = false;
    const showReady = () => {
      if (generation !== this.generation || this.renderer !== renderer) return;
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
      renderer.setCurrentTime(subtitleTime(this.video.currentTime, this.offsetMs));
    };
    renderer = new window.SubtitlesOctopus({
      video: this.video, subContent: content, debug:true,
      // Let the player recover from worker errors without a global throw.
      workerUrl: resources?.workerUrl, legacyWorkerUrl: resources?.workerUrl,
      timeOffset: -this.offsetMs / 1000,
      onReady: () => {
        ready = true;
        showReady();
      },
      onError: error => {
        Promise.resolve().then(() => {
          if (this.renderer === renderer) this.assFailure(error, generation);
        });
      }
    });
    if (generation !== this.generation) { renderer.dispose(); return; }
    // libass divides videoWidth by videoHeight. On the LG hardware plane
    // both can be zero even after decoding starts, leaving its canvas hidden.
    if (this.video.videoWidth === 0 || this.video.videoHeight === 0) {
      const nativePosition = renderer.getVideoPosition;
      renderer.getVideoPosition = () => {
        const video = this.video;
        if (video.videoWidth > 0 && video.videoHeight > 0) return nativePosition();
        const width = video.offsetWidth, height = video.offsetHeight;
        const aspect = asset.aspectRatio;
        if (!aspect) return {width, height, x:0, y:0};
        const w = Math.min(width, Math.round(height * aspect));
        const h = Math.min(height, Math.round(width / aspect));
        return {width:w, height:h, x:(width - w) / 2, y:(height - h) / 2};
      };
      renderer.resize();
    }
    this.renderer = renderer;
    this.kind = 'ass';
    // Octopus calls onReady on its first worker message, including logs.
    // Retire the dialogue only after the canvas contains painted pixels.
    const onFrame = event => {
      if (event.data.target !== 'canvas' || !event.data.canvases?.length) return;
      requestAnimationFrame(() => {
        if (generation !== this.generation || this.assPainted || this.assUnavailable || this.renderer !== renderer) return;
        const probe = document.createElement('canvas');
        probe.width = 160; probe.height = 90;
        const ctx = probe.getContext('2d');
        ctx.drawImage(renderer.canvas, 0, 0, probe.width, probe.height);
        const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
        for (let i = 3; i < pixels.length; i += 4) {
          if (!pixels[i]) continue;
          this.assPainted = true;
          renderer.worker.removeEventListener('message', onFrame);
          this.dialogue?.destroy();
          this.dialogue = null;
          this.stopClock();
          break;
        }
      });
    };
    renderer.worker?.addEventListener('message', onFrame);
    // A worker may neither become ready nor report an error on the LG
    // browser. Treat that as a render failure instead of invisible captions.
    if (ready) showReady();
    else this.readyTimer = setTimeout(() => {
      if (generation === this.generation && this.renderer === renderer)
        this.assFailure(new Error('ASS subtitle renderer did not become ready.'), generation);
    }, 20000);
  }

  update(offsetMs) {
    const changed = this.offsetMs !== offsetMs;
    this.offsetMs = offsetMs;
    const currentTime = subtitleTime(this.video.currentTime, offsetMs);
    if (this.dialogue) this.dialogue.currentTime = currentTime;
    if (!this.renderer) return;
    if (this.kind === 'srt') this.renderer.currentTime = currentTime;
    if (this.kind === 'ass' && changed) {
      this.renderer.timeOffset = -offsetMs / 1000;
      this.renderer.setCurrentTime(currentTime);
    }
  }
}
