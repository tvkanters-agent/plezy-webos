const {test,expect} = require('@playwright/test');
const {readFile} = require('node:fs/promises');
const path = require('node:path');
async function setup(page, extra = {}, version, pendingStops = [], skipSettings = {}, metadataForRequest = null) {
  const video = await readFile(path.join(__dirname,'fixtures/test.webm'));
  const calls = [], events = [];
  let metadataRequests = 0;
  await page.addInitScript(({pendingStops,skipSettings})=>localStorage.setItem('plezy.webos',JSON.stringify({...skipSettings,deviceId:'device',active:'plex',
    servers:[{id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'fixture'}],
    simkl:{accessToken:'simkl_at_fixture',refreshToken:'simkl_rt_fixture',expiresAt:Date.now()+600000,scope:'media:write',pendingStops}})),{pendingStops,skipSettings});
  const item = {ratingKey:'movie',type:'movie',title:'Test Movie',duration:120000,Guid:[{id:'imdb://tt1234567'}],
    Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'part',key:'/video.webm',Stream:[]}]}],...extra};
  await page.route('https://api.simkl.com/**',route=>{
    events.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});
    return route.fulfill({json:{}});
  });
  await page.route('http://plex.test/**',async route=>{
    const url = new URL(route.request().url()); calls.push(url);
    if(url.pathname==='/video.webm' || url.pathname.endsWith('/start.m3u8')) {
      const match=/bytes=(\d+)-(\d*)/.exec(route.request().headers().range||'');
      if(match) {const start=+match[1],end=match[2]?+match[2]:video.length-1;
        return route.fulfill({status:206,contentType:'video/webm',headers:{'Content-Range':`bytes ${start}-${end}/${video.length}`,'Accept-Ranges':'bytes'},body:video.subarray(start,end+1)});}
      return route.fulfill({contentType:'video/webm',body:video});
    }
    if (url.pathname==='/library/metadata/movie' && metadataForRequest) {
      const metadata=await metadataForRequest(++metadataRequests,item);
      return route.fulfill({json:{MediaContainer:{Metadata:[metadata]}}});
    }
    return route.fulfill({json:url.pathname==='/hubs'?{MediaContainer:{Hub:[{title:'Movies',Metadata:[item]}]}}:{MediaContainer:{Metadata:[item]}}});
  });
  await page.goto('/'); await page.getByRole('button',{name:'Test Movie',exact:true}).click();
  if (version !== undefined) await page.getByLabel('Media version',{exact:true}).selectOption(String(version));
  await page.getByRole('button',{name:'Play',exact:true}).first().click();
  await expect.poll(()=>page.locator('video').evaluate(v=>v.paused)).toBe(false);
  await expect.poll(()=>events.length).toBeGreaterThan(0);
  return {calls,events};
}
async function simulatePlaybackStarvation(page) {
  await page.locator('video').evaluate(video => {
    // A browser normally sends waiting with readyState < HAVE_FUTURE_DATA.
    // Force that state when dispatching a synthetic event on the fixture.
    Object.defineProperty(video, 'readyState', {configurable: true, value: 2});
    video.dispatchEvent(new Event('waiting'));
  });
}
test('closing playback preserves the detail screen and focused action without a blank repaint',async({page})=>{
  await setup(page);
  await page.evaluate(()=>{
    window.detailBeforePlayerClose=document.querySelector('#main .detail');
    window.detailDetachedOnClose=false;
    const original=window.detailBeforePlayerClose;
    new MutationObserver(()=>{
      if (!original.isConnected) window.detailDetachedOnClose=true;
    }).observe(document.querySelector('#main'),{childList:true});
  });
  // A new resume value is fetched after stopping, without replacing the page.
  await page.route('http://plex.test/library/metadata/movie**',route=>route.fulfill({json:{
    MediaContainer:{Metadata:[{
      ratingKey:'movie',type:'movie',title:'Test Movie',duration:120000,
      viewOffset:40000,viewCount:0,
      Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'part',key:'/video.webm'}]}]
    }]}
  }}));
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(page.locator('#player')).toBeHidden();
  const play=page.locator('#main .detail-actions .detail-play');
  await expect(play).toBeFocused();
  await expect(play).toHaveAttribute('aria-label','Resume · 0:40');
  await expect(page.getByRole('button',{name:'Play from beginning'})).toBeVisible();
  expect(await page.evaluate(()=>({
    sameNode:document.querySelector('#main .detail')===window.detailBeforePlayerClose,
    detached:window.detailDetachedOnClose
  }))).toEqual({sameNode:true,detached:false});
});
test('Back during delayed stream cleanup cannot resurrect playback',async({page})=>{
  const {calls,events}=await setup(page);let release;
  await page.route('http://plex.test/**/timeline**',async route=>{
    if(new URL(route.request().url()).searchParams.get('state')==='stopped')await new Promise(resolve=>{release=resolve;});
    await route.fulfill({json:{}});
  });
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.locator('.player-sheet').getByRole('button',{name:'Compatible playback',exact:true}).click();
  await expect.poll(()=>!!release).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.controls')).toBeHidden();
  await page.keyboard.press('Escape'); release();
  await expect(page.locator('#player')).toBeHidden();
  await expect.poll(()=>events.some(e=>e.path==='/scrobble/stop')).toBe(true);
  expect(calls.filter(u=>u.pathname.endsWith('/start.m3u8'))).toHaveLength(0);
  await expect(page.getByRole('heading',{name:'Test Movie'})).toBeVisible();
});
test('failed audio restart still stops the existing Simkl viewing',async({page})=>{
  const {events}=await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[{streamType:3,id:21,languageCode:'eng'}]}]}]});
  // Add a real server audio option to the next metadata-independent restart.
  await page.route('http://plex.test/library/parts/part**',route=>route.fulfill({status:500}));
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await page.locator('.player-track-column').getByRole('button',{name:/English/}).click();
  await expect(page.locator('.player-status')).toContainText('HTTP 500');
  // Track selection now keeps its sheet open even when the restart fails.
  await page.keyboard.press('Escape');await expect(page.locator('.player-sheet')).toBeHidden();
  await page.keyboard.press('Escape');await expect(page.locator('.controls')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect.poll(()=>events.some(e=>e.path==='/scrobble/stop')).toBe(true);
  expect(events.filter(e=>e.path==='/scrobble/start')).toHaveLength(1);
});
test('failed Simkl stop is saved and can be retried from settings',async({page})=>{
  await setup(page);let succeed=false,attempts=0;
  await page.route('https://api.simkl.com/scrobble/stop**',route=>{attempts++;return route.fulfill({status:succeed?200:503,json:{}});});
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect.poll(()=>attempts).toBe(1);
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('plezy.webos')).simkl.pendingStops.length)).toBe(1);
  await page.getByRole('button',{name:'Settings',exact:true}).click();succeed=true;
  await page.getByRole('button',{name:'Retry saved Simkl stops (1)',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('plezy.webos')).simkl.pendingStops.length)).toBe(0);
  expect(attempts).toBe(2);
});

test('Plex intro skip and chapter jump seek without extra Simkl scrobbles',async({page})=>{
 const {events,calls}=await setup(page,{Marker:[{type:'intro',startTimeOffset:0,endTimeOffset:15000}],
 Chapter:[{title:'Beginning',startTimeOffset:0},{title:'Later',startTimeOffset:45000}]});
 await expect(page.getByRole('button',{name:'Skip intro',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Skip intro',exact:true}).click();
 await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThanOrEqual(15);
 await page.getByRole('button',{name:'Playback settings'}).click();
 await page.getByRole('button',{name:'Chapters',exact:true}).click();
 await page.getByRole('button',{name:/45:00|0:45|Later/}).click();
 await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThanOrEqual(45);
 await expect(page.getByRole('button',{name:'Skip intro',exact:true})).toBeHidden();
 expect(events.filter(e=>e.path==='/scrobble/start')).toHaveLength(1);
 expect(calls.find(u=>u.pathname==='/library/metadata/movie').searchParams.get('includeMarkers')).toBe('1');
});

test('Plex chapter named Studio Logos offers Skip intro without a native marker',async({page})=>{
  await setup(page,{Chapter:[
    {tag:'Studio Logos',startTimeOffset:0,endTimeOffset:12000},
    {tag:'Main Feature',startTimeOffset:12000,endTimeOffset:120000}
  ]});
  const skip=page.getByRole('button',{name:'Skip intro'});
  await expect(skip).toBeVisible();
  await skip.click();
  await expect(skip).toBeHidden();
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(12);
});

test('one Skip Intro click bypasses adjacent Logo and Opening chapters',async({page})=>{
  await setup(page,{Chapter:[
    {tag:'Studio Logos',startTimeOffset:0,endTimeOffset:8000},
    {tag:'Opening',startTimeOffset:8000,endTimeOffset:25000},
    {tag:'Main Feature',startTimeOffset:25000,endTimeOffset:120000}
  ]});
  const skip=page.getByRole('button',{name:'Skip intro'});
  await expect(skip).toBeVisible();
  await skip.click();
  await expect(skip).toBeHidden();
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(25);
});

test('intro markers and tagged chapters load from playback metadata, not a thin cached detail',async({page})=>{
  let releaseExtras;
  const delayedExtras = new Promise(resolve=>{releaseExtras=resolve;});
  const {calls}=await setup(page,{},undefined,[],{},async (number,item)=>{
    if (number===1) return item; // Real detail pages often have no Marker or Chapter arrays.
    await delayedExtras; // Playback must already be running while extras load.
    return {...item,Marker:[{type:'intro',startTimeOffset:0,endTimeOffset:15000}],
      Chapter:[{tag:'Opening',startTimeOffset:0,endTimeOffset:15000},
        {tag:'Main feature',startTimeOffset:15000,endTimeOffset:120000}]};
  });
  const skip=page.getByRole('button',{name:'Skip intro'});
  await expect(skip).toBeHidden();
  await expect(page.locator('video')).toBeVisible();
  await page.evaluate(()=>{window.PalmSystem={};}); // Simulate LG focus handling before extras resolve.
  releaseExtras();
  await expect(skip).toBeVisible();
  await expect(skip).toBeFocused();
  await expect(page.getByRole('button',{name:'Chapters',exact:true})).toBeVisible();
  const gap=page.locator('.chapter-gap');
  await expect(gap).toHaveCount(1);
  await expect(gap).toHaveCSS('width','4px');
  expect(calls.filter(url=>url.pathname==='/library/metadata/movie' &&
    url.searchParams.get('includeMarkers')==='1' && url.searchParams.get('includeChapters')==='1').length).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Enter'); // A single TV OK press after auto-focus.
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(15);
});

test('Plezy chapters show current row, timestamps, artwork and timeline gaps',async({page})=>{
  await setup(page,{Chapter:[
    {title:'Opening',startTimeOffset:0,thumb:'/library/metadata/movie/chapter.jpg'},
    {title:'Scene 2',startTimeOffset:10000},
    {title:'Scene 3',startTimeOffset:45000}
  ]});
  await page.route('http://plex.test/library/metadata/movie/chapter.jpg**',route=>route.fulfill({
    contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLdtAAAAABJRU5ErkJggg==','base64')
  }));
  const gaps=page.locator('.chapter-gaps .chapter-gap');
  await expect(gaps).toHaveCount(2);
  await expect(gaps.first()).toHaveAttribute('style',/8\.333/);
  await page.locator('video').evaluate(video=>{video.currentTime=12;video.dispatchEvent(new Event('timeupdate'));});
  await page.getByRole('button',{name:'Chapters',exact:true}).click();
  const rows=page.locator('.player-chapter-option');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toHaveAttribute('aria-current','true');
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1).locator('small')).toHaveText('0:10');
  await expect(rows.first().locator('img')).toHaveAttribute('src',/chapter\.jpg/);
  await rows.nth(2).click();
  await expect(page.locator('.player-sheet')).toBeHidden();
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(45);
});

test('previous and next chapter controls use the same traversal as Plezy',async({page})=>{
  await setup(page,{Chapter:[{title:'First',startTimeOffset:0},
    {title:'Second',startTimeOffset:10000},{title:'Third',startTimeOffset:45000}]});
  await page.locator('video').evaluate(video=>video.pause());
  const prev=page.getByRole('button',{name:'Previous chapter'});
  const next=page.getByRole('button',{name:'Next chapter'});
  await expect(prev).toBeVisible();
  await next.click();
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(10);
  await page.locator('video').evaluate(video=>{video.currentTime=13;video.dispatchEvent(new Event('timeupdate'));});
  await prev.click();
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeLessThan(1);
  await page.locator('video').evaluate(video=>{video.currentTime=14;video.dispatchEvent(new Event('timeupdate'));});
  await prev.click();
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(10);
});

test('selected Plex version survives compatible playback restart',async({page})=>{
 const {calls}=await setup(page,{Media:[
   {container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'first',key:'/wrong.webm'}]},
   {container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'second',key:'/video.webm'}]}
 ]},1);
 expect(calls.some(u=>u.pathname==='/wrong.webm')).toBe(false);
 await page.getByRole('button',{name:'Playback settings'}).click();
 await page.locator('.player-sheet').getByRole('button',{name:'Compatible playback',exact:true}).click();
 await expect.poll(()=>calls.some(u=>u.pathname.endsWith('/start.m3u8') && u.searchParams.get('mediaIndex')==='1')).toBe(true);
 await expect.poll(()=>page.locator('video').evaluate(v=>v.paused)).toBe(false);
 await page.getByRole('button',{name:'Stop',exact:true}).click();
 await expect(page.getByLabel('Media version',{exact:true})).toHaveValue('1');
});

test('player chrome has upstream-style compact transport controls and timeline',async({page})=>{
  await setup(page);
  await expect(page.locator('.timeline-row progress')).toBeVisible();
  await expect(page.getByRole('slider',{name:'Seek playback'})).toBeVisible();
  await expect(page.locator('.player-buttons .transport-icon:visible')).toHaveCount(4);
  await expect(page.getByRole('button',{name:'−10 seconds',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'+30 seconds',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Stop',exact:true})).toBeVisible();
  const metrics=await page.locator('[data-action="pause"]').evaluate(x=>({
    width:x.getBoundingClientRect().width,height:x.getBoundingClientRect().height}));
  expect(metrics.width).toBeLessThanOrEqual(52);
  expect(metrics.height).toBeLessThanOrEqual(52);
});

test('player header and controls hide together during playback inactivity',async({page})=>{
  await setup(page);
  const controls=page.locator('.controls'), header=page.locator('.player-top');
  await expect(header).toBeVisible();
  await expect(controls).toBeVisible();
  await page.evaluate(()=>{
    document.querySelector('.controls').classList.add('hidden-controls');
    document.querySelector('.player-top').classList.add('hidden-controls');
  });
  await expect(header).toBeHidden();
  await expect(controls).toBeHidden();
  await page.locator('video').dispatchEvent('mousemove');
  await expect(header).toBeVisible();
  await expect(controls).toBeVisible();
});

test('compound playback SVGs use legible numerals and correctly scaled individual shapes',async({page})=>{
  await setup(page);
  for(const [action,number] of [['backward','10'],['forward','30']]){
    const svg=page.locator('.player-buttons [data-action="'+action+'"] svg');
    await expect(svg).toHaveAttribute('viewBox','0 0 24 24');
    const numeral=svg.locator('text');
    await expect(numeral).toHaveText(number);
    await expect(numeral).toHaveAttribute('font-size','10');
    const dimensions=await numeral.evaluate(node=>{
      const glyph=node.getBBox();
      const canvas=node.ownerSVGElement.viewBox.baseVal;
      return {width:glyph.width,height:glyph.height,canvasWidth:canvas.width};
    });
    expect(dimensions.height).toBeGreaterThanOrEqual(9);
    expect(dimensions.width).toBeGreaterThan(8);
    expect(dimensions.width).toBeLessThan(dimensions.canvasWidth);
  }
  const tracks=page.locator('#player [data-action="tracks-options"] svg');
  await expect(tracks.locator('rect')).toHaveCount(1);
  await expect(tracks.locator('path')).toHaveCount(1);
  const settings=page.getByRole('button',{name:'Playback settings'}).locator('svg');
  await expect(settings.locator('circle')).toHaveCount(3);
  const bounds=await settings.locator('circle').evaluateAll(nodes=>nodes.map(n=>n.getBBox().width));
  expect(new Set(bounds).size).toBe(1);
});

test('transport icons use vector graphics and expose accessible button labels',async({page})=>{
  await setup(page);
  const buttons=page.locator('.player-buttons .transport-icon:visible');
  await expect(buttons).toHaveCount(4);
  expect(await buttons.locator('svg').count()).toBe(5);
  await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
  await expect(page.locator('.player-buttons button[data-action="pause"] .pause-glyph')).toBeVisible();
});

test('video settings use a Plezy-style side sheet rather than browser dropdown toolbar',async({page})=>{
  await setup(page);
  await expect(page.locator('.player-sheet')).toBeHidden();
  await page.getByRole('button',{name:'Playback settings'}).click();
  await expect(page.locator('.player-sheet')).toBeVisible();
  await expect(page.locator('.player-sheet').getByRole('button',{name:'Compatible playback'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.player-sheet')).toBeHidden();
  await expect(page.locator('#player')).toBeVisible();
});

test('Plezy combined audio/subtitle track sheet shows both columns and selected streams',async({page})=>{
  await setup(page,{Chapter:[{title:'Beginning',startTimeOffset:0},{title:'Later',startTimeOffset:45000}],
    Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:2,id:11,languageCode:'eng',selected:1,codec:'aac'},
      {streamType:2,id:12,languageCode:'fra',codec:'ac3'},
      {streamType:3,id:21,languageCode:'eng',codec:'srt'}
    ]}]}]});
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await expect(page.locator('[data-sheet-title]')).toHaveText('Audio & Subtitles');
  await expect(page.locator('.player-track-column')).toHaveCount(2);
  await expect(page.locator('.player-track-column').first().getByRole('heading',{name:'Audio'})).toBeVisible();
  await expect(page.locator('.player-track-column').last().getByRole('heading',{name:'Subtitles'})).toBeVisible();
  await expect(page.getByRole('button',{name:/English.*AAC/})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'Off'})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:/English.*AAC/})).toBeFocused();
  await page.getByRole('button',{name:'Close playback settings'}).click();
  await page.getByRole('button',{name:'Chapters',exact:true}).click();
  await expect(page.getByRole('button',{name:/Later/})).toBeVisible();
});

test('changing the player audio stream applies the selected Plex ID at the current position',async({page})=>{
  const {calls}=await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:2,id:11,languageCode:'eng',selected:1},
      {streamType:2,id:12,languageCode:'fra',codec:'ac3'},
      {streamType:3,id:21,languageCode:'eng'}
    ]}]}]});
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await page.locator('.player-track-column').first().getByRole('button',{name:'French'}).click();
  await expect(page.locator('.player-sheet')).toBeVisible();
  await expect(page.locator('.player-track-column').first().getByRole('button',{name:'French'}))
    .toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.player-track-column').first().getByRole('button',{name:'French'}))
    .toBeFocused();
  await expect.poll(()=>calls.some(url=>url.pathname==='/library/parts/part' &&
    url.searchParams.get('audioStreamID')==='12' && url.searchParams.get('allParts')==='1')).toBe(true);
  await expect.poll(()=>calls.some(url=>url.pathname.endsWith('/start.m3u8') &&
    url.searchParams.get('mediaIndex')==='0')).toBe(true);
  await page.locator('.player-track-column').last().getByRole('button',{name:'English'}).click();
  await expect(page.locator('.player-sheet')).toBeVisible();
  await expect(page.locator('.player-track-column').last().getByRole('button',{name:'English'}))
    .toHaveAttribute('aria-pressed','true');
});

test('remote focus can scrub player timeline independently of playback controls',async({page})=>{
 await setup(page);
 const slider=page.getByRole('slider',{name:'Seek playback'});
 await expect(slider).toBeVisible();
 await slider.focus();
 await page.keyboard.press('ArrowRight');
 await expect(slider).toBeFocused();
 await expect(slider).toHaveAttribute('aria-valuetext',/of/);
 await expect(page.locator('#player')).toBeVisible();
});

test('upgrade clears a title-only saved stop and sends ID-only current playback',async({page})=>{
  const {events,calls}=await setup(page,{},undefined,[{id:'legacy',body:{
    movie:{ids:{},title:'Previously rejected film',year:2024},progress:85}}]);
  await expect.poll(()=>events.some(e=>e.path==='/scrobble/start')).toBe(true);
  expect(events.find(e=>e.path==='/scrobble/start').body.movie).toEqual({ids:{imdb:'tt1234567'}});
  expect(events.some(e=>e.body?.movie && Object.keys(e.body.movie.ids).length===0)).toBe(false);
  expect(calls.some(u=>u.pathname==='/library/metadata/movie' &&
    u.searchParams.get('includeGuids')==='1' && !u.searchParams.has('includeMarkers'))).toBe(true);
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('plezy.webos')).simkl.pendingStops.length)).toBe(0);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect.poll(()=>events.some(e=>e.path==='/scrobble/stop')).toBe(true);
});

test('Back hides player controls first and a second Back exits',async({page})=>{
  await setup(page);
  await expect(page.locator('.controls')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.controls')).toBeHidden();
  await expect(page.locator('#player')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#player')).toBeHidden();
});
test('remote seeks in hidden mode and center commits preview then dismisses controls',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.controls')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  const slider=page.getByRole('slider',{name:'Seek playback'});
  await expect(slider).toBeFocused();
  const value=Number(await slider.inputValue());
  expect(value).toBeGreaterThanOrEqual(10);
  await expect.poll(()=>page.locator('video').evaluate(el=>el.currentTime))
    .toBeGreaterThanOrEqual(value-1);
  await expect(page.locator('video')).toHaveJSProperty('paused',true);
  await page.keyboard.press('ArrowRight');
  const next=Number(await slider.inputValue());
  expect(next).toBeGreaterThan(value);
  await page.keyboard.press('Enter');
  await expect(page.locator('.controls')).toBeHidden();
  await expect(page.locator('#player')).toBeVisible();
  await expect.poll(()=>page.locator('video').evaluate(el=>el.currentTime)).toBeGreaterThanOrEqual(next-2);
});
test('buffering spinner takes over for waiting and clears on playback',async({page})=>{
  await setup(page);
  const spinner=page.locator('.player-buffering');
  await simulatePlaybackStarvation(page);
  await expect(spinner).toBeVisible();
  await expect(page.locator('.player-status')).toBeHidden();
  await page.locator('video').dispatchEvent('playing');
  await expect(spinner).toBeHidden();
  await expect(page.locator('#player')).toBeVisible();
});

test('focus is restored to playback controls when buffering finishes',async({page})=>{
 await setup(page);
 const pause=page.getByRole('button',{name:/^(Pause|Play)$/}).filter({has:page.locator('svg')}).first();
 await page.evaluate(()=>document.activeElement.blur());
 await simulatePlaybackStarvation(page);
 await expect(page.locator('.player-buffering')).toBeVisible();
 await page.locator('video').dispatchEvent('playing');
 await expect(page.locator('.player-buffering')).toBeHidden();
 await expect(page.locator('[data-action="pause"]')).toBeFocused();
});

test('spinner remains available after committing a remote seek with controls hidden',async({page})=>{
 await setup(page);
 await page.keyboard.press('Escape');
 await page.keyboard.press('ArrowRight');
 await page.keyboard.press('Enter');
 await expect(page.locator('.controls')).toBeHidden();
 await simulatePlaybackStarvation(page);
 await expect(page.locator('.player-buffering')).toBeVisible();
 await page.locator('video').dispatchEvent('playing');
 await expect(page.locator('.player-buffering')).toBeHidden();
});

test('buffered network stalls and late EOF events do not show a false spinner',async({page})=>{
 await setup(page);
 const spinner=page.locator('.player-buffering');
 await expect(spinner).toBeHidden();
 await page.locator('video').dispatchEvent('stalled');
 await page.locator('video').dispatchEvent('waiting');
 await expect(spinner).toBeHidden();
 await page.locator('video').evaluate(video => {
   Object.defineProperty(video, 'readyState', {configurable:true, value:1});
   Object.defineProperty(video, 'ended', {configurable:true, value:true});
   video.dispatchEvent(new Event('stalled'));
   video.dispatchEvent(new Event('waiting'));
 });
 await expect(spinner).toBeHidden();
});

test('pausing after a seek clears buffering even if the decoder stays starved',async({page})=>{
 await setup(page);
 await simulatePlaybackStarvation(page);
 await expect(page.locator('.player-buffering')).toBeVisible();
 await page.locator('[data-action="pause"]').click();
 await expect(page.locator('video')).toHaveJSProperty('paused',true);
 await expect(page.locator('.player-buffering')).toBeHidden();
 await page.locator('video').dispatchEvent('waiting');
 await page.locator('video').dispatchEvent('stalled');
 await expect(page.locator('.player-buffering')).toBeHidden();
});

test('subtitle descriptions occupy a distinct line under primary track labels',async({page})=>{
 await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
   Part:[{id:'part',key:'/video.webm',Stream:[
     {id:31,streamType:3,languageCode:'eng',title:'English SDH',displayTitle:'English (SDH)'}]}]}]});
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
 const row=page.locator('.player-options-list button').filter({hasText:'SDH'}).first();
 await expect(row.locator('strong')).toBeVisible();
 await expect(row.locator('small')).toBeVisible();
 const positions=await row.evaluate(el=>{
   const title=el.querySelector('strong').getBoundingClientRect();
   const description=el.querySelector('small').getBoundingClientRect();
   return {titleBottom:title.bottom,subtitleTop:description.top};
 });
 expect(positions.subtitleTop).toBeGreaterThanOrEqual(positions.titleBottom-1);
});

test('chapter fallback supplies skip intro when Plex returns no native markers', async ({page}) => {
  await setup(page, {Chapter:[
    {title:'Introduction',startTimeOffset:0,endTimeOffset:15000},
    {title:'Story',startTimeOffset:15000,endTimeOffset:110000},
    {title:'Credits',startTimeOffset:110000,endTimeOffset:120000}]});
  await expect(page.getByRole('button',{name:'Skip intro'})).toBeVisible();
  await page.getByRole('button',{name:'Skip intro'}).click();
  await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThanOrEqual(15);
  await page.locator('video').evaluate(v=>{v.currentTime=112;});
  await expect(page.getByRole('button',{name:'Skip credits'})).toBeVisible();
});
test('independent intro and credits modes respect the off setting', async ({page}) => {
  await setup(page, {Marker:[
    {type:'intro',startTimeOffset:0,endTimeOffset:15000},
    {type:'credits',startTimeOffset:100000,endTimeOffset:110000}]
  }, undefined, [], {skipIntroMode:'off'});
  await expect(page.getByRole('button',{name:'Skip intro'})).toBeHidden();
  await page.locator('video').evaluate(v=>{v.currentTime=102;});
  await expect(page.getByRole('button',{name:'Skip credits'})).toBeVisible();
});
test('auto skip counts down and seeks to the actual marker end', async ({page}) => {
  await setup(page, {Marker:[{type:'intro',startTimeOffset:0,endTimeOffset:15000}]},
    undefined, [], {skipIntroMode:'auto',autoSkipDelay:1});
  await expect(page.getByRole('button',{name:'Skip intro'})).toContainText('Skip intro');
  await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime),{timeout:3500}).toBeGreaterThanOrEqual(15);
  await expect(page.getByRole('button',{name:'Skip intro'})).toBeHidden();
});
test('pressing a remote key cancels automatic skip, without seeking', async ({page}) => {
  await setup(page, {Marker:[{type:'intro',startTimeOffset:0,endTimeOffset:15000}]},
    undefined, [], {skipIntroMode:'auto',autoSkipDelay:2});
  await expect(page.getByRole('button',{name:'Skip intro'})).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(2500);
  expect(await page.locator('video').evaluate(v=>v.currentTime)).toBeLessThan(15);
});

test('TV skip marker gains focus only once its floating button is visible', async ({page}) => {
  await setup(page, {Marker:[{type:'intro',startTimeOffset:4000,endTimeOffset:15000}]});
  await page.evaluate(() => {
    // Simulate TV input mode after desktop playback has already opened.
    window.PalmSystem = {};
    const video = document.querySelector('#player video');
    video.currentTime = 5;
    video.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.getByRole('button',{name:'Skip intro'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Skip intro'})).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeFocused();
  await expect(page.locator('#player .controls')).toBeVisible();
});

test('LG OK skips the newly focused intro without opening player chrome',async({page})=>{
  await setup(page,{Marker:[{type:'intro',startTimeOffset:4000,endTimeOffset:15000}]});
  await page.evaluate(()=>{
    window.PalmSystem={};
    const video=document.querySelector('#player video');
    video.currentTime=5;
    video.dispatchEvent(new Event('timeupdate'));
  });
  const skip=page.getByRole('button',{name:'Skip intro'});
  await expect(skip).toBeVisible();
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(15);
  await expect(skip).toBeHidden();
});

test('focused skip prompt has no square outline and stays hidden during a delayed seek',async({page})=>{
  await setup(page,{Marker:[{type:'intro',startTimeOffset:4000,endTimeOffset:15000},
    {type:'credits',startTimeOffset:30000,endTimeOffset:40000}]});
  await page.evaluate(()=>{
    window.PalmSystem={};
    const video=document.querySelector('#player video');
    video.currentTime=5;
    video.dispatchEvent(new Event('timeupdate'));
  });
  const skip=page.getByRole('button',{name:'Skip intro'});
  await expect(skip).toBeVisible();
  await expect(skip).toBeFocused();
  await expect(skip).toHaveCSS('outline-style','none');
  await expect(skip).toHaveCSS('border-radius','8px');
  await page.locator('video').evaluate(video=>{
    // LG can keep reporting the pre-seek timestamp during buffering. Emulate
    // that window by holding the media clock after currentTime is assigned.
    const before=video.currentTime;
    Object.defineProperty(video,'currentTime',{
      configurable:true,get(){return before;},set(value){window.skipSeekTarget=value;}
    });
  });
  await page.keyboard.press('Enter');
  await expect(skip).toBeHidden();
  expect(await page.evaluate(()=>window.skipSeekTarget)).toBeGreaterThanOrEqual(15);
  await page.locator('video').dispatchEvent('timeupdate');
  await page.locator('video').dispatchEvent('playing');
  await expect(skip).toBeHidden();
  // Suppressing one activated marker must not suppress a later, distinct one.
  await page.locator('video').evaluate(video=>{
    delete video.currentTime;
    video.currentTime=32;
    video.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.getByRole('button',{name:'Skip credits'})).toBeVisible();
  // An explicit rewind is a new user choice and should offer Skip Intro again.
  await page.locator('video').evaluate(video=>{
    const slider=document.querySelector('[data-action="seek"]');
    slider.value='5';
    slider.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await expect(skip).toBeVisible();
});

test('an intro appearing behind the chapter sheet does not steal remote focus',async({page})=>{
  await setup(page,{Chapter:[{title:'Opening',startTimeOffset:0}],
    Marker:[{type:'intro',startTimeOffset:4000,endTimeOffset:15000}]});
  await page.getByRole('button',{name:'Chapters',exact:true}).click();
  const chapter=page.locator('.player-chapter-option').first();
  await expect(chapter).toBeFocused();
  await page.evaluate(()=>{
    window.PalmSystem={};
    const video=document.querySelector('#player video');
    video.currentTime=5;
    video.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.getByRole('button',{name:'Skip intro'})).toBeVisible();
  await expect(chapter).toBeFocused();
});
