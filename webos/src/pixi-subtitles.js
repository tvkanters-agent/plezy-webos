// SPDX-License-Identifier: GPL-3.0-only
// PixiJS 4's canvas renderer is used deliberately: it works on webOS 4's
// Chromium 53 without a WebGL context over LG's hardware video plane.
// Only the active SRT/VTT cues become high-resolution text textures; the
// playback clock never rebuilds a texture unless the visible cue changes.
import {subtitleStyle} from './subtitle-style.js';

const clamp=(n,low,high)=>Math.max(low,Math.min(high,n));
const ENTITY={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};

function decodeEntities(value) {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi,(_,name)=>{
    if (name[0]!=='#') return ENTITY[name.toLowerCase()] || _;
    const hex=name[1].toLowerCase()==='x';
    const code=parseInt(name.slice(hex?2:1),hex?16:10);
    return code>0 && code<=0x10ffff && !(code>=0xd800 && code<=0xdfff)
      ? String.fromCodePoint(code) : '\ufffd';
  });
}

// Parse safe text and inline <b>/<i> emphasis without placing untrusted Plex
// subtitle markup in the document. Pixi 4 Text doesn't accept HTML markup.
export function cueRuns(text) {
  const lines=[[]], state={bold:0,italic:0};
  const parts=String(text || '').match(/<[^>]*>|\r?\n|[^<\r\n]+|</g) || [];
  for (const part of parts) {
    if (/^<br\s*\/?\s*>$/i.test(part) || part==='\n' || part==='\r\n') {
      lines.push([]);continue;
    }
    const tag=/^<\s*(\/?)\s*(b|i)(?:\s+[^>]*)?>$/i.exec(part);
    if (tag) {
      const field=tag[2].toLowerCase()==='b'?'bold':'italic';
      state[field]=Math.max(0,state[field]+(tag[1]?-1:1));
    } else if (part[0]!=='<' || part==='<') {
      const value=decodeEntities(part);
      if (value) lines[lines.length-1].push({text:value,bold:!!state.bold,italic:!!state.italic});
    }
  }
  return lines;
}

// Build a prefix of maximum end times so overlapping cues remain visible
// without scanning the whole subtitle track on every video animation frame.
export function cueIndex(track) {
  const cues=[...(track?.cues || [])].sort((a,b)=>a.startTime-b.startTime);
  const ends=[],ids=new Map();
  for (let i=0,max=0;i<cues.length;i++) {
    max=Math.max(max,cues[i].endTime);
    ends.push(max);
    ids.set(cues[i],i);
  }
  return {cues,ends,ids};
}

export function activeCues(index,time) {
  const {cues,ends}=index;
  let lo=0,hi=cues.length;
  while(lo<hi) {
    const mid=(lo+hi)>>1;
    if(cues[mid].startTime<=time) lo=mid+1;
    else hi=mid;
  }
  const visible=[];
  for(let i=lo-1;i>=0 && ends[i]>time;i--)
    if(cues[i].endTime>time) visible.push(cues[i]);
  return visible.reverse();
}

// Layout is in *CSS pixels*. Pixi Text textures are rasterized at 2x for
// antialiased outlines before CanvasRenderer composites them at TV resolution.
export class PixiSrtRenderer {
  constructor(PIXI, element, video, values) {
    this.PIXI=PIXI;this.element=element;this.video=video;
    const doc=element.ownerDocument || document;
    this.canvas=doc.createElement('canvas');
    this.canvas.className='plezy-pixi-subtitles';
    this.canvas.setAttribute('aria-hidden','true');
    this.canvas.style.cssText='position:absolute;top:0;left:0;pointer-events:none;';
    this.accessible=doc.createElement('span');
    this.accessible.className='plezy-srt-cue-text';
    this.accessible.style.display='none';
    element.appendChild(this.canvas);
    element.appendChild(this.accessible);
    this.measure=doc.createElement('canvas').getContext('2d');
    this.stage=new PIXI.Container();
    this.surface=new PIXI.CanvasRenderer({width:1,height:1,view:this.canvas,transparent:true,resolution:1});
    this.index=cueIndex();
    this.current=NaN;this.lastCueKey=null;
    this.width=0;this.height=0;this.paintCount=0;
    this.setStyle(values);
  }

  setStyle(values) {
    this.style=subtitleStyle(values);
    const height=this.video.offsetHeight || this.element.offsetHeight || 720;
    this.fontSize=this.style.subtitleFontSize*height/720;
    this.radius=this.style.subtitleBorderSize*height/720;
    this.lastCueKey=null;
    this.resize();
    this.draw();
  }

  resize() {
    const width=Math.max(1,Math.round(this.element.clientWidth || this.video.offsetWidth || 1));
    const height=Math.max(1,Math.round(this.element.clientHeight || this.video.offsetHeight || 1));
    // MPV's sub-pos >100 allows the baseline to move below the video frame.
    const totalHeight=Math.ceil(height*Math.max(1,this.style.subtitlePosition/100));
    if (width===this.width && height===this.height && this.canvas.height===totalHeight) return;
    this.width=width;this.height=height;
    this.surface.resize(width,totalHeight);
    this.canvas.style.width=width+'px';this.canvas.style.height=totalHeight+'px';
    this.lastCueKey=null;
  }

  changeTrack(track) {
    this.index=cueIndex(track);
    this.lastCueKey=null;
    this.draw();
  }

  set currentTime(value) {
    this.current=Number(value);
    this.draw();
  }

  get currentTime() { return this.current; }

  font(bold,italic) {
    return (italic?'italic ':'')+(bold?'700 ':'400 ')+this.fontSize+'px Arial';
  }

  widthOf(text,bold,italic) {
    this.measure.font=this.font(bold,italic);
    return this.measure.measureText(text).width;
  }

  // Wrap at word boundaries while keeping text style spans and using the same
  // font metrics for wrapping and final Pixi positioning (no extra left ring).
  layout(cue,maxWidth) {
    const lines=[];
    let line={runs:[],width:0};
    const push=()=>{lines.push(line);line={runs:[],width:0};};
    const add=(value,bold,italic)=>{
      if(!value)return;
      const width=this.widthOf(value,bold,italic);
      const last=line.runs[line.runs.length-1];
      if(last && last.bold===bold && last.italic===italic){last.text+=value;last.width+=width;}
      else line.runs.push({text:value,width,bold,italic});
      line.width+=width;
    };
    const paragraphs=cueRuns(cue.text);
    for(let p=0;p<paragraphs.length;p++) {
      if(p>0)push();
      for(const fragment of paragraphs[p]) {
        const bold=this.style.subtitleBold||fragment.bold;
        const italic=this.style.subtitleItalic||fragment.italic;
        const tokens=fragment.text.match(/\s+|\S+/g)||[];
        for(let token of tokens){
          let width=this.widthOf(token,bold,italic);
          if(line.width>0 && line.width+width>maxWidth) {
            push();token=token.replace(/^\s+/, '');
            width=this.widthOf(token,bold,italic);
          }
          if(!token)continue;
          if(width<=maxWidth) {add(token,bold,italic);continue;}
          // Long unbroken captions and CJK strings still fit the TV viewport.
          for(const character of token) {
            const charWidth=this.widthOf(character,bold,italic);
            if(line.width>0 && line.width+charWidth>maxWidth) push();
            add(character,bold,italic);
          }
        }
      }
    }
    push();
    return lines;
  }

  draw() {
    if(!Number.isFinite(this.current) || !this.surface)return;
    const cues=activeCues(this.index,this.current);
    const key=cues.map(c=>this.index.ids.get(c)).join(',');
    if(key===this.lastCueKey)return;
    this.lastCueKey=key;
    const old=this.stage.removeChildren();
    for(const child of old)child.destroy({texture:true,baseTexture:true});
    this.accessible.textContent=cues.map(c=>cueRuns(c.text).map(line=>line.map(r=>r.text).join('')).join('\n')).join('\n');
    const fontSize=this.fontSize,lineHeight=fontSize*1.2;
    const inset=Math.max(6,this.height*0.01);
    // MPV sub-pos: 0 aligns the top of the block, 100 its bottom. At 50
    // centre the whole block (not its bottom edge); 101–150 continue below.
    // Overlapping cues stack upwards without repositioning the first one.
    let stackShift=0;
    for(let c=cues.length-1;c>=0;c--){
      const cue=cues[c],size=clamp(Number(cue.size)||100,1,100)/100;
      const regionWidth=this.width*size;
      const lines=this.layout(cue,Math.max(1,regionWidth-2*inset));
      const blockHeight=lines.length*lineHeight;
      const position=typeof cue.position==='number'?clamp(cue.position,0,100)/100:0.5;
      const center=this.width*position;
      let regionLeft=center-regionWidth/2;
      if(cue.positionAlign==='line-left')regionLeft=center;
      else if(cue.positionAlign==='line-right')regionLeft=center-regionWidth;
      regionLeft=clamp(regionLeft,0,this.width-regionWidth);
      let top=inset+(this.height-blockHeight-2*inset)*this.style.subtitlePosition/100-stackShift;
      if(cue.line!=='auto' && Number.isFinite(Number(cue.line))) {
        const row=Number(cue.line);
        if(cue.snapToLines)top=row>=0?inset+row*lineHeight:this.height-inset+row*lineHeight;
        else {
          top=this.height*row/100;
          if(cue.lineAlign==='center')top-=blockHeight/2;
          else if(cue.lineAlign==='end')top-=blockHeight;
        }
      }
      for(let l=0;l<lines.length;l++){
        const line=lines[l];
        const align=cue.align==='left'||cue.align==='start'?'left':
          cue.align==='right'||cue.align==='end'?'right':'center';
        let x=regionLeft+(align==='left'?inset:align==='right'?regionWidth-line.width-inset:(regionWidth-line.width)/2);
        const baseline=top+(l+1)*lineHeight-(lineHeight-fontSize)*0.5;
        for(const run of line.runs){
          const fontWeight=run.bold?'700':'400';
          const fontStyle=run.italic?'italic':'normal';
          const textStyle=new this.PIXI.TextStyle({fontFamily:'Arial',fontSize,
            fontWeight,fontStyle,fill:this.style.subtitleTextColor,
            stroke:this.style.subtitleBorderColor,strokeThickness:2*this.radius,
            lineJoin:'round',miterLimit:2,padding:0});
          const label=new this.PIXI.Text(run.text,textStyle);
          label.resolution=2;
          const metrics=this.PIXI.TextMetrics.measureFont(textStyle.toFontString());
          label.x=Math.round(x-this.radius);
          label.y=Math.round(baseline-metrics.ascent-this.radius);
          this.stage.addChild(label);
          x+=run.width;
        }
      }
      stackShift+=blockHeight+lineHeight*0.15;
    }
    this.surface.render(this.stage);
    this.paintCount++;
  }

  destroy() {
    this.stage.destroy({children:true,texture:true,baseTexture:true});
    this.surface.destroy(false);
    this.canvas.remove();this.accessible.remove();
    this.surface=null;
  }
}
