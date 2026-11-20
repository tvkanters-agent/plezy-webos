// SPDX-License-Identifier: GPL-3.0-only
import {CaptionsRenderer, parseText} from 'media-captions';
import {attachAssColorComparison} from './ass-color-diagnostics.js';
import {AssEventAppender} from './ass-events.js';
import {assStartupPreview} from './ass-startup.js';
import {assFontCache} from './ass-font-cache.js';
import {assTrackCache} from './ass-track-cache.js';
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
    script.onload = () => { script.remove(); resolve(); };
    script.onerror = () => { script.remove(); reject(new Error('Could not load ' + src)); };
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
      if (!window.plezyAssAssets) {
        const prefix = 'subtitles-octopus-worker' + (wasm ? '' : '-legacy');
        await loadAssScript(prefix + '-assets.js');
        window.plezyAssParts = [];
        try {
          for (let i = 0; i < window.plezyAssPartCount; i++) await loadAssScript(prefix + '-' + i + '.js');
          const blob = new Blob(window.plezyAssParts, {type:'text/javascript'});
          window.plezyAssAssets = {workerUrl:URL.createObjectURL(blob)};
        } finally {
          delete window.plezyAssParts;
          delete window.plezyAssPartCount;
        }
      }
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

function sameFonts(left, right) {
  if (left.length !== right.length) return false;
  return left.every((font,i) => font.name === right[i].name &&
    font.bytes === right[i].bytes);
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

async function downloadSubtitle(asset, signal, position, preview, onTiming, parked) {
  if (asset.partUrl) {
    try {
      if (asset.format === 'ass' && asset.partCacheKey) {
        const saved = await assTrackCache.get(asset.partCacheKey);
        if (signal.aborted) throw Object.assign(new Error('Aborted'), {name:'AbortError'});
        if (saved) {
          const fonts = await Promise.all(saved.fonts.map(async font => {
            const bytes = await assFontCache.get(asset.fontScope,font.name,font.length,font.crc);
            return bytes && {name:font.name,bytes};
          }));
          if (fonts.every(Boolean)) {
            asset.fonts = fonts;
            // The full cached script may contain megabytes of vector signs.
            // Render the currently relevant events first instead of making
            // libass parse every sign before the first visible subtitle.
            // A warm worker already holding this complete track can display
            // it immediately. Never replace its track with a partial preview.
            const alreadyLoaded = parked?._plezyTrackContent === saved.script &&
              sameFonts(parked.fonts, fonts);
            const opening = alreadyLoaded ? null : assStartupPreview(saved.script, position);
            if (opening && !signal.aborted) await preview(opening);
            return saved.script;
          }
        }
      }
      const script = await subtitleRequest(signal, (requestSignal, refresh) =>
        extractMatroskaSubtitle(asset, requestSignal, {position, onRead:refresh, onTiming,
          onFonts:asset.format === 'ass' ? fonts => { asset.fonts = fonts; } : undefined,
          async preview(content) {
            if (!requestSignal.aborted) await preview(content);
          }}));
      if (asset.format === 'ass' && asset.partCacheKey && asset.fonts)
        assTrackCache.put(asset.partCacheKey,script,asset.fonts.map(font =>
          ({name:font.name,length:font.bytes.byteLength,crc:font.crc})));
      return script;
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
    this.assWaiting = false;
    this.assClockTimer = null;
    // timeupdate may arrive only four times a second. Keep SRT cue boundaries
    // aligned to the visible playback clock, including short cues.
    this.listeners = [];
    const listen = (type, handler) => {
      video.addEventListener?.(type, handler);
      this.listeners.push({type,handler});
    };
    listen('playing', () => { this.assWaiting = false; this.syncAssClock(); this.startAssClock(); this.startClock(); });
    for (const event of ['pause', 'ended', 'seeking']) {
      listen(event, () => {
        // While the decoder jumps to a different timestamp, the old ASS
        // canvas is no longer valid. Clear it immediately rather than
        // leaving the last subtitle visible if libass has no new cue to
        // paint (especially during a paused seek).
        if (event === 'seeking' && this.kind === 'ass' && this.renderer?.ctx && this.renderer.canvas)
          this.renderer.ctx.clearRect(0,0,this.renderer.canvas.width,this.renderer.canvas.height);
        this.stopClock(); this.update(this.offsetMs); this.syncAssClock();
        if (event === 'ended') this.stopAssClock();
        else this.startAssClock();
      });
    }
    listen('waiting', () => {
      this.assWaiting = true; this.assWaitingPosition = this.video.currentTime;
      this.stopClock(); this.update(this.offsetMs); this.syncAssClock(); this.startAssClock();
    });
    listen('seeked', () => {
      // Some LG decoders do not emit a second `playing` after a buffered seek.
      // A prior waiting event must not freeze libass indefinitely.
      this.assWaiting = false;
      this.update(this.offsetMs); this.syncAssClock(true); this.startAssClock(); this.startClock();
    });
    listen('timeupdate', () => {
      if (this.assWaiting && Math.abs(this.video.currentTime - this.assWaitingPosition) > 0.03)
        this.assWaiting = false;
      if (this.kind === 'ass') { this.syncAssClock(); this.startAssClock(); }
    });
    listen('ratechange', () => this.syncAssClock());
    listen('loadedmetadata', () => this.refreshStyle());
    this.resizeStyle = () => this.refreshStyle();
    if (typeof window !== 'undefined') window.addEventListener?.('resize', this.resizeStyle);
  }

  dispose() {
    this.clear();
    this.parkedAssRenderer?.dispose?.();
    this.parkedAssRenderer = null;
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

  stopAssClock() {
    clearInterval(this.assClockTimer);
    this.assClockTimer = null;
  }

  startAssClock() {
    if (this.assClockTimer || this.kind !== 'ass' || this.video.ended) return;
    // Unlike requestAnimationFrame, this reads the actual decoded video clock.
    // Native LG timeupdate/seeked events can be sparse or absent. Check paused
    // seeks too: libass must repaint the new frame even without `playing`.
    this.assClockLast = subtitleTime(this.video.currentTime,this.offsetMs);
    this.assClockTimer = setInterval(() => {
      if (this.kind !== 'ass') { this.stopAssClock(); return; }
      const current = subtitleTime(this.video.currentTime,this.offsetMs);
      const moved = Math.abs(current - this.assClockLast) > 0.03;
      this.assClockLast = current;
      if (this.assWaiting && Math.abs(this.video.currentTime - this.assWaitingPosition) > 0.03)
        this.assWaiting = false;
      if (this.renderer?.worker && !this.renderer._plezyFullyReady) return;
      if (!this.video.paused || moved)
        this.syncAssClock(moved && (this.video.paused || this.video.seeking || this.assWaiting));
    }, 100);
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
    this.assWaiting = false;
    this.assContent = null;
    this.assUnavailable = this.assPainted = false;
  }

  releaseRenderer() {
    this.stopAssClock();
    const eventsInstalled = !this.assAppender ||
      !!this.assAppender.styles && this.assAppender.pending.length === 0;
    if (this.assFrameWorker && this.assFrameHandler)
      this.assFrameWorker.removeEventListener('message',this.assFrameHandler);
    this.assFrameWorker = this.assFrameHandler = null;
    this.assAppender?.dispose();
    this.assAppender = null;
    this.removeAssComparison?.();
    this.removeAssComparison = null;
    clearTimeout(this.readyTimer);
    clearTimeout(this.dialogueTimer);
    this.dialogueTimer = this.readyTimer = null;
    this.stopClock();
    const renderer = this.renderer;
    const parkAss = this.kind === 'ass' && renderer?.worker &&
      eventsInstalled && renderer._plezyFullyReady &&
      typeof renderer.plezySuspendVideo === 'function' && !this.assUnavailable;
    this.renderer = null;
    this.kind = null;
    this.aspectRatio = null;
    if (renderer && parkAss) {
      // Reserved for the next playback. No animation or font processing runs
      // while parked, but the expensive 4.7 MB legacy libass worker survives.
      this.parkedAssRenderer?.dispose();
      renderer.setIsPaused(true,subtitleTime(this.video.currentTime,this.offsetMs));
      renderer.plezySuspendVideo();
      if (renderer.canvasParent) renderer.canvasParent.style.display = 'none';
      this.parkedAssRenderer = renderer;
    } else if (renderer) {
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
    if (asset.format === 'ass') ensureAssRenderer().catch(()=>{});
    try {
      const content = await downloadSubtitle(asset, controller.signal, subtitleTime(position, offsetMs), render, onTiming, this.parkedAssRenderer);
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
      if (this.assUnavailable || this.dialogue) await this.prepareDialogue(content, generation);
      else if (!this.assPainted && this.dialogueTimer == null) {
        // Give styled output the first frame. Only pay for a second parser
        // when the worker has failed or still has not painted after startup.
        this.dialogueTimer = setTimeout(() => {
          if (generation === this.generation && !this.assPainted && !this.assUnavailable)
            this.prepareDialogue(this.assContent, generation);
        }, 8000);
      }
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
    this.assAppender?.dispose();
    this.assAppender = null;
    this.removeAssComparison?.();
    this.removeAssComparison = null;
    clearTimeout(this.dialogueTimer);
    this.assPainted = false;
    clearTimeout(this.readyTimer);
    if (!this.dialogue) await this.prepareDialogue(this.assContent, generation);
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
      if (this.assAppender) this.assAppender.remember(content);
      else this.renderer.setTrack(content);
      this.renderer._plezyTrackContent = content;
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
      const time = subtitleTime(this.video.currentTime, this.offsetMs);
      renderer.setIsPaused(!!(this.video.paused || this.video.seeking || this.video.ended || this.assWaiting), time);
      renderer.setRate(this.video.playbackRate || 1);
    };
    const onError = error => {
      if (renderer) renderer.debug = true;
      Promise.resolve().then(() => {
        if (this.renderer === renderer) this.assFailure(error, generation);
      });
    };
    const parked = this.parkedAssRenderer;
    this.parkedAssRenderer = null;
    if (parked && sameFonts(parked.fonts, asset.fonts || [])) {
      // Retain compiled asm.js/WASM and registered glyphs for repeat plays
      // and sibling episodes. Only parse changed dialogue on a new episode.
      renderer = parked;
      renderer.onErrorEvent = onError;
      renderer.debug = this.preferences()?.diagnosticsEnabled === true;
      renderer.timeOffset = -this.offsetMs / 1000;
      // A warm libass worker retains the last painted canvas. It is NOT the
      // new episode's first frame. Keep that canvas hidden until libass has
      // rendered a nonempty cue for this session, otherwise a stale frame can
      // masquerade as successful startup and remain visible after a paused seek.
      if (renderer.canvasParent) renderer.canvasParent.style.display = 'none';
      if (renderer.ctx && renderer.canvas)
        renderer.ctx.clearRect(0,0,renderer.canvas.width,renderer.canvas.height);
      renderer.plezyResumeVideo();
      renderer.setIsPaused(true,subtitleTime(this.video.currentTime,this.offsetMs));
      if (renderer._plezyTrackContent !== content) renderer.setTrack(content);
      ready = true;
    } else {
      parked?.dispose();
      renderer = new window.SubtitlesOctopus({
        video: this.video, subContent: content, fonts:asset.fonts || [],
        debug:this.preferences()?.diagnosticsEnabled === true,
        // Let the player recover from worker errors without a global throw.
        workerUrl: resources?.workerUrl, legacyWorkerUrl: resources?.workerUrl,
        timeOffset: -this.offsetMs / 1000,
        onError
      });
      const onRuntimeReady = event => {
        // Upstream emits 'ready' immediately after releasing the worker-init
        // dependency, *before* libass has finished initializing. Requesting
        // its styles guarantees that the track and font registration exist.
        if (event.data.target === 'ready') {
          renderer.worker?.postMessage({target:'get-styles'});
          return;
        }
        if (event.data.target !== 'get-styles') return;
        renderer.worker?.removeEventListener('message',onRuntimeReady);
        renderer._plezyFullyReady = true;
        ready = true;
        showReady();
      };
      renderer.worker?.addEventListener('message',onRuntimeReady);
    }
    if (generation !== this.generation) { renderer.dispose(); return; }
    // The bundled libass worker normally timestamps video events only when
    // it receives them. Under load that means a stale seek clock can appear
    // current. Attach the source clock and playback state to every update.
    if (renderer.worker) {
      renderer._plezyClockHandlesRate = true;
      renderer.setCurrentTime = time => renderer.worker.postMessage({target:'video',
        currentTime:time, senderTime:Date.now(),
        isPaused:!!(this.video.paused || this.video.seeking || this.video.ended || this.assWaiting),
        rate:this.video.playbackRate || 1});
      renderer.setIsPaused = (paused,time) => renderer.worker.postMessage({target:'video',
        currentTime:time, senderTime:Date.now(), isPaused:paused,
        rate:this.video.playbackRate || 1});
    }
    // libass divides videoWidth by videoHeight. On the LG hardware plane
    // both can be zero even after decoding starts, leaving its canvas hidden.
    renderer._plezyAspectRatio = asset.aspectRatio;
    if (this.video.videoWidth === 0 || this.video.videoHeight === 0) {
      if (!renderer._plezyNativePosition) {
        const nativePosition = renderer._plezyNativePosition = renderer.getVideoPosition;
        renderer.getVideoPosition = () => {
          const video = this.video;
          if (video.videoWidth > 0 && video.videoHeight > 0) return nativePosition();
          const width = video.offsetWidth, height = video.offsetHeight;
          const aspect = renderer._plezyAspectRatio;
          if (!aspect) return {width, height, x:0, y:0};
          const w = Math.min(width, Math.round(height * aspect));
          const h = Math.min(height, Math.round(width / aspect));
          return {width:w, height:h, x:(width - w) / 2, y:(height - h) / 2};
        };
      }
      renderer.resize();
    }
    this.renderer = renderer;
    this.kind = 'ass';
    renderer._plezyTrackContent = content;
    this.startAssClock();
    if (asset.partUrl && renderer.worker && renderer.getStyles)
      this.assAppender = new AssEventAppender(renderer, content);
    if (renderer.worker && this.preferences()?.diagnosticsEnabled === true)
      this.removeAssComparison = attachAssColorComparison(this.video, renderer);
    // Octopus calls onReady on its first worker message, including logs.
    // Retire the dialogue only after the canvas contains painted pixels.
    const onFrame = event => {
      if (event.data.target !== 'canvas' || !event.data.canvases?.length) return;
      requestAnimationFrame(() => {
        if (generation !== this.generation || this.assPainted || this.assUnavailable || this.renderer !== renderer) return;
        if (renderer.canvas.style.visibility === 'hidden') renderer.canvas.style.visibility = 'visible';
        const probe = document.createElement('canvas');
        probe.width = 160; probe.height = 90;
        const ctx = probe.getContext('2d');
        ctx.drawImage(renderer.canvas, 0, 0, probe.width, probe.height);
        const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
        for (let i = 3; i < pixels.length; i += 4) {
          if (!pixels[i]) continue;
          this.assPainted = true;
          if (renderer.canvasParent) renderer.canvasParent.style.display = '';
          clearTimeout(this.dialogueTimer);
          renderer.worker.removeEventListener('message', onFrame);
          if (this.assFrameHandler === onFrame) this.assFrameWorker = this.assFrameHandler = null;
          this.dialogue?.destroy();
          this.dialogue = null;
          this.stopClock();
          break;
        }
      });
    };
    renderer.worker?.addEventListener('message', onFrame);
    this.assFrameWorker = renderer.worker;
    this.assFrameHandler = onFrame;
    // A worker may neither become ready nor report an error on the LG
    // browser. Treat that as a render failure instead of invisible captions.
    if (ready) showReady();
    else this.readyTimer = setTimeout(() => {
      if (generation === this.generation && this.renderer === renderer)
        this.assFailure(new Error('ASS subtitle renderer did not become ready.'), generation);
    }, 20000);
    this.assAppender?.ready();
  }

  syncAssClock(force = false) {
    if (this.kind !== 'ass' || !this.renderer) return;
    const current = subtitleTime(this.video.currentTime, this.offsetMs);
    if (this.renderer.worker && !this.renderer._plezyFullyReady) return;
    this.renderer.setIsPaused(!!(this.video.paused || this.video.seeking || this.video.ended || this.assWaiting),current);
    // The webOS clock message already carries the playback rate; posting
    // another message every 100ms needlessly queues work on the LG worker.
    if (!this.renderer._plezyClockHandlesRate)
      this.renderer.setRate(this.video.playbackRate || 1);
    if (force && this.renderer._plezyFullyReady)
      this.renderer.worker?.postMessage({target:'plezy-force-frame'});
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
      this.syncAssClock();
    }
  }
}
