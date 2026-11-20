// SPDX-License-Identifier: GPL-3.0-only
// SettingsService subtitle preferences are native MPV's styling inputs.
// PixiJS draws SRT/VTT text; ASS/SSA retains libass's authored styling.
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
  const inset=videoInsets(video,style.subtitleUseMargins,fallbackAspect);
  element.style.top=inset.top+'%';element.style.bottom=inset.top+'%';
  element.style.left=inset.left+'%';element.style.right=inset.left+'%';
  return style;
}

export function resetSrtStyle(element) {
  if (!element.style) return;
  for (const field of ['fontSize','fontWeight','fontStyle','top','right','bottom','left'])
    element.style[field]='';
}
