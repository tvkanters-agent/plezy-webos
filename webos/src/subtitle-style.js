// SPDX-License-Identifier: GPL-3.0-only
// SettingsService.subtitle* defaults and numericBounds in upstream Plezy.
// The webOS HTML renderer only supports styling SRT/VTT text cues; libass
// keeps ASS/SSA's authored typography and positioning unchanged.
export const SUBTITLE_STYLE_DEFAULTS = Object.freeze({
  subtitleFontSize:38, subtitleTextColor:'#FFFFFF', subtitlePosition:100,
  subtitleUseMargins:true, subtitleBold:false, subtitleItalic:false,
  subtitleBorderSize:3, subtitleBorderColor:'#000000'
});

export const SUBTITLE_STYLE_BOUNDS = Object.freeze({
  subtitleFontSize:[10,80], subtitlePosition:[0,150], subtitleBorderSize:[0,5]
});

export function subtitleStyle(values = {}) {
  const result = {...SUBTITLE_STYLE_DEFAULTS};
  for (const field of Object.keys(SUBTITLE_STYLE_BOUNDS)) {
    const [min,max] = SUBTITLE_STYLE_BOUNDS[field];
    if (Number.isInteger(values[field]) && values[field] >= min && values[field] <= max)
      result[field] = values[field];
  }
  for (const field of ['subtitleTextColor','subtitleBorderColor']) {
    if (typeof values[field] === 'string' && /^#[0-9a-fA-F]{6}$/.test(values[field]))
      result[field] = values[field].toUpperCase();
  }
  for (const field of ['subtitleUseMargins','subtitleBold','subtitleItalic'])
    if (typeof values[field] === 'boolean') result[field] = values[field];
  return result;
}

// MPV's outline is drawn behind the glyph fill with rounded joins. WebKit
// text-stroke is centred over the glyph and has sharp mitres on W/V, which
// makes the text itself black and introduces spikes. Text shadows paint under
// the text. Distribute their offsets around a circle (not a square), with
// enough samples to avoid gaps even on diagonal strokes.
export function subtitleOutline(size, color) {
  if (!(size > 0)) return 'none';
  const samples=Math.min(96,Math.max(12,Math.ceil(2*Math.PI*size/1.2)));
  const shadows=[];
  for (let i=0;i<samples;i++) {
    const angle=2*Math.PI*i/samples;
    shadows.push((size*Math.cos(angle)).toFixed(2)+'px '+
      (size*Math.sin(angle)).toFixed(2)+'px 0 '+color);
  }
  return shadows.join(', ');
}

// object-fit:contain uses the video's decoded aspect ratio; with margins off
// the overlay is clipped to the video frame rather than the letterbox bars.
export function videoInsets(video, useMargins, fallbackAspect) {
  if (useMargins || !(video.offsetWidth > 0 && video.offsetHeight > 0)) return {top:0,left:0};
  const container=video.offsetWidth/video.offsetHeight;
  const aspect=video.videoWidth > 0 && video.videoHeight > 0
    ? video.videoWidth/video.videoHeight : fallbackAspect;
  if (!(aspect > 0 && Number.isFinite(aspect))) return {top:0,left:0};
  if (aspect > container) return {top:(1-container/aspect)*50,left:0};
  return {top:0,left:(1-aspect/container)*50};
}

export function applySrtStyle(element, video, values, fallbackAspect) {
  const style=subtitleStyle(values), height=video.offsetHeight || element.offsetHeight || 720;
  // MPV's sub-font-size and sub-border-size are measured at a 720p height.
  const scale=height/720;
  element.style.fontSize=(style.subtitleFontSize*scale).toFixed(2)+'px';
  element.style.fontWeight=style.subtitleBold?'700':'400';
  element.style.fontStyle=style.subtitleItalic?'italic':'normal';
  element.style.setProperty('--cue-color',style.subtitleTextColor);
  element.style.setProperty('--cue-text-shadow',
    subtitleOutline(style.subtitleBorderSize*scale,style.subtitleBorderColor));
  // Upstream's text settings contain no background, and unstyled SRT should
  // not acquire an artificial opaque box from Media Captions' defaults.
  element.style.setProperty('--cue-bg-color','transparent');
  const inset=videoInsets(video,style.subtitleUseMargins,fallbackAspect);
  element.style.top=inset.top+'%';element.style.bottom=inset.top+'%';
  element.style.left=inset.left+'%';element.style.right=inset.left+'%';
  return style;
}

export function resetSrtStyle(element) {
  if (!element.style) return;
  for (const field of ['fontSize','fontWeight','fontStyle','top','right','bottom','left'])
    element.style[field]='';
  for (const field of ['--cue-color','--cue-text-shadow','--cue-bg-color'])
    element.style.removeProperty(field);
}

// Native sub-pos: 0 = top, 100 = bottom, 101–150 = below the default
// bottom. Only cues lacking authored placement are moved.
export function applySrtPosition(track, position, height = 720, fontSize = 38) {
  const clamped=subtitleStyle({subtitlePosition:position}).subtitlePosition;
  if (clamped===100) return;
  for (const cue of track.cues) {
    if (cue.line!=='auto' || cue.vertical) continue;
    if (clamped<100) {
      // media-captions 0.0.18 has a non-snap cue geometry bug (NaN% when
      // cue.lineAlign='end'). Use integer text rows, which its renderer lays
      // out correctly, while keeping authored VTT cue positions untouched.
      const rowHeight=fontSize*1.2;
      cue.line=Math.max(0,Math.round(height*clamped/100/rowHeight)-1);
    } else {
      // MPV accepts sub-pos through 150: values above bottom move text below
      // the video. Preserve Media Captions' normal bottom placement first.
      cue.style={...cue.style,'--cue-transform':'translateY('+(clamped-100)+'vh)'};
    }
  }
}
