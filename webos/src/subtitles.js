// SPDX-License-Identifier: GPL-3.0-only
import {parseText} from 'media-captions';
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

// Read embedded SRT from the source MKV when possible. Plex can return an
// ASS-formatted sidecar for an original SRT track; parse that text in Pixi,
// without loading or instantiating an ASS renderer.
async function downloadSubtitle(asset, signal, position, preview, onTiming) {
  if (asset.partUrl) {
    try {
      return await subtitleRequest(signal, (requestSignal, refresh) =>
        extractMatroskaSubtitle(asset, requestSignal, {position, onRead:refresh, onTiming,
          async preview(content) {
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
    this.listeners = [];
    const listen = (type, handler) => {
      video.addEventListener?.(type, handler);
      this.listeners.push({type,handler});
    };
    listen('playing', () => this.startClock());
    for (const event of ['pause','ended','seeking','waiting']) {
      listen(event, () => { this.stopClock(); this.update(this.offsetMs); });
    }
    listen('seeked', () => { this.update(this.offsetMs); this.startClock(); });
    listen('timeupdate', () => this.update(this.offsetMs));
    listen('ratechange', () => this.update(this.offsetMs));
    listen('loadedmetadata', () => this.refreshStyle());
    this.resizeStyle = () => this.refreshStyle();
    if (typeof window !== 'undefined') window.addEventListener?.('resize',this.resizeStyle);
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
    const renderer=this.renderer;
    this.renderer=null;
    this.kind=null;
    this.aspectRatio=null;
    if (renderer) {
      try { renderer.destroy(); }
      catch (error) { console.warn('Subtitle renderer cleanup failed:',error); }
    }
    resetSrtStyle(this.element);
    this.element.textContent='';
  }

  async load(asset, offsetMs, position = this.video.currentTime, onTiming = null) {
    this.clear();
    if (!asset) return;
    if (asset.format !== 'srt' && asset.format !== 'vtt')
      throw new Error('Only enhanced SRT/VTT subtitles are supported.');
    const generation=this.generation;
    this.offsetMs=offsetMs;
    const controller=this.abort=new AbortController();
    const startedAt=onTiming ? Date.now() : 0;
    let firstRendered=false;
    const render=async content => {
      await this.render(asset,content,generation);
      if (onTiming && !firstRendered && generation === this.generation && this.kind === 'srt') {
        firstRendered=true;
        onTiming('first',Date.now()-startedAt);
      }
    };
    // Warm Pixi in parallel with the subtitle download or MKV byte ranges.
    ensurePixi().catch(()=>{});
    try {
      const content=await downloadSubtitle(asset,controller.signal,
        subtitleTime(position,offsetMs),render,onTiming);
      await render(content);
    } finally {
      if (this.abort === controller) this.abort=null;
    }
  }

  async render(asset, content, generation) {
    if (generation !== this.generation) return;
    const type=asset.embedded ? embeddedSubtitleType(content) :
      asset.format === 'vtt' ? 'vtt' : 'srt';
    const track=await parseText(content,{type});
    if (!track.cues.length) throw new Error('Subtitle file contains no readable cues.');
    if (generation !== this.generation) return;
    this.aspectRatio=asset.aspectRatio;
    const style=applySrtStyle(this.element,this.video,this.preferences(),this.aspectRatio);
    const PIXI=await ensurePixi();
    if (generation !== this.generation) return;
    const renderer=this.renderer || new PixiSrtRenderer(PIXI,this.element,this.video,style);
    this.renderer=renderer;
    this.kind='srt';
    renderer.setStyle(style);
    renderer.changeTrack(track);
    this.update(this.offsetMs);
    this.startClock();
  }

  update(offsetMs) {
    this.offsetMs=offsetMs;
    if (this.kind === 'srt' && this.renderer)
      this.renderer.currentTime=subtitleTime(this.video.currentTime,offsetMs);
  }
}
