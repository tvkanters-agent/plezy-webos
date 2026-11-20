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

const SVG_NS='http://www.w3.org/2000/svg';
function svgNode(doc,name,attributes={}) {
  const node=doc.createElementNS(SVG_NS,name);
  for (const field of Object.keys(attributes)) node.setAttribute(field,attributes[field]);
  return node;
}

// Browser text-stroke uses sharp mitres at W/V vertices, while blurring a cue's
// alpha rounds *both* exterior and interior corners and rasterizes the result.
// SVG text with a round stroke join keeps the original glyph's sharp internal
// corners. The unmodified HTML is painted above the stroke, as MPV paints its
// outline behind the text. Copy measured visual runs rather than duplicating
// line wrapping, which Media Captions can adjust for authored VTT cues.
function visualRuns(cue) {
  const doc=cue.ownerDocument, view=doc.defaultView, rect=cue.getBoundingClientRect();
  const walker=doc.createTreeWalker(cue,4,null,false); // NodeFilter.SHOW_TEXT
  const nodes=[];let node;
  while ((node=walker.nextNode())) if (node.textContent) nodes.push(node);
  const runs=[];
  for (const textNode of nodes) {
    const style=view.getComputedStyle(textNode.parentElement);
    if (style.display==='none' || style.visibility==='hidden') continue;
    const range=doc.createRange(), content=textNode.textContent;
    let firstRect=null;
    const fragments=[];
    range.selectNodeContents(textNode);
    const boxes=range.getClientRects();
    if (boxes.length===1 && !/[\r\n]/.test(content)) {
      firstRect=boxes[0];
      fragments.push({start:0,end:content.length,top:firstRect.top});
    } else {
      // Only wrapped or explicit-multiline runs need per-character geometry.
      for (let i=0;i<content.length;i++) {
        if (content[i]==='\n' || content[i]==='\r') continue;
        range.setStart(textNode,i);range.setEnd(textNode,i+1);
        const box=range.getBoundingClientRect();
        if (!box.height) continue;
        if (!firstRect) firstRect=box;
        const last=fragments[fragments.length-1];
        if (last && Math.abs(last.top-box.top)<0.5 && i===last.end) {
          last.end=i+1;
        } else fragments.push({start:i,end:i+1,top:box.top});
      }
    }
    if (!firstRect) continue;
    // An inline-block with zero height sits exactly on the CSS text baseline.
    // It is temporary and has zero advance, so layout/foreground stay intact.
    const marker=doc.createElement('span');
    marker.style.cssText='display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;';
    textNode.parentNode.insertBefore(marker,textNode);
    const baselineOffset=marker.getBoundingClientRect().top-firstRect.top;
    marker.parentNode.removeChild(marker);
    for (const fragment of fragments) {
      range.setStart(textNode,fragment.start);range.setEnd(textNode,fragment.end);
      const box=range.getBoundingClientRect();
      runs.push({text:content.slice(fragment.start,fragment.end),
        x:box.left-rect.left,y:box.top-rect.top+baselineOffset,
        width:box.width,style});
    }
  }
  return runs;
}

function paintCueOutline(cue,radius,color) {
  const doc=cue.ownerDocument;
  if (!cue._plezyOutline) {
    const foreground=doc.createElement('span');
    foreground.className='plezy-srt-foreground';
    while (cue.firstChild) foreground.appendChild(cue.firstChild);
    cue.appendChild(foreground);
    cue._plezyOutline={foreground};
  }
  const {foreground}=cue._plezyOutline;
  const old=cue._plezyOutline.svg;
  if (old) old.parentNode.removeChild(old);
  const runs=visualRuns(foreground);
  const origin=cue.getBoundingClientRect(),front=foreground.getBoundingClientRect();
  const svg=svgNode(doc,'svg',{'aria-hidden':'true',class:'plezy-srt-vector-outline'});
  svg.style.position='absolute';svg.style.left='0';svg.style.top='0';
  svg.style.width='100%';svg.style.height='100%';svg.style.overflow='visible';
  svg.style.pointerEvents='none';
  for (const run of runs) {
    const glyph=svgNode(doc,'text',{
      x:(run.x+front.left-origin.left).toFixed(3),
      y:(run.y+front.top-origin.top).toFixed(3),
      fill:'none',stroke:color,'stroke-width':(2*radius).toFixed(2),
      'stroke-linejoin':'round','stroke-linecap':'round',
      'font-family':run.style.fontFamily,'font-size':run.style.fontSize,
      'font-weight':run.style.fontWeight,'font-style':run.style.fontStyle
    });
    if (run.style.letterSpacing!=='normal') glyph.setAttribute('letter-spacing',run.style.letterSpacing);
    glyph.textContent=run.text;
    svg.appendChild(glyph);
  }
  cue.insertBefore(svg,foreground);
  cue._plezyOutline.svg=svg;
}

function srtOutline(element,radius,color) {
  const state=element._plezyOutlineState;
  if (!(radius>0) || !element.querySelectorAll || typeof MutationObserver==='undefined') {
    if (state) {
      state.observer.disconnect();
      for (const cue of element.querySelectorAll('[part="cue"]')) {
        if (!cue._plezyOutline) continue;
        const {svg,foreground}=cue._plezyOutline;
        if (svg) svg.parentNode.removeChild(svg);
        while (foreground.firstChild) cue.insertBefore(foreground.firstChild,foreground);
        foreground.parentNode.removeChild(foreground);
        delete cue._plezyOutline;
      }
      element._plezyOutlineState=null;
    }
    return;
  }
  const current=state || {observer:null};
  current.radius=radius;current.color=color;
  element._plezyOutlineState=current;
  function draw() {
    if (current.observer) current.observer.disconnect();
    try {
      for (const cue of element.querySelectorAll('[part="cue"]'))
        if (element.contains(cue)) paintCueOutline(cue,current.radius,current.color);
    } finally {
      current.observer.observe(element,{childList:true,subtree:true,characterData:true});
    }
  }
  // Remember the draw function from the latest style pass for future cues.
  current.draw=draw;
  if (current.observer) current.observer.disconnect();
  current.observer=new MutationObserver(()=>current.draw());
  draw();
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
  const radius=style.subtitleBorderSize*scale;
  element.style.setProperty('--cue-border-radius',radius.toFixed(2)+'px');
  element.style.setProperty('--cue-text-shadow','none');
  // Upstream's text settings contain no background, and unstyled SRT should
  // not acquire an artificial opaque box from Media Captions' defaults.
  element.style.setProperty('--cue-bg-color','transparent');
  const inset=videoInsets(video,style.subtitleUseMargins,fallbackAspect);
  element.style.top=inset.top+'%';element.style.bottom=inset.top+'%';
  element.style.left=inset.left+'%';element.style.right=inset.left+'%';
  srtOutline(element,radius,style.subtitleBorderColor);
  return style;
}

export function resetSrtStyle(element) {
  if (!element.style) return;
  srtOutline(element,0,'#000000');
  for (const field of ['fontSize','fontWeight','fontStyle','top','right','bottom','left'])
    element.style[field]='';
  for (const field of ['--cue-color','--cue-text-shadow',
    '--cue-border-radius','--cue-bg-color'])
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
