const {test,expect} = require('@playwright/test');
const {readFile} = require('node:fs/promises');
const path = require('node:path');
const {srtFixture} = require('./fixtures/matroska.cjs');
const plexSubtitlePath = '/subtitles/:/transcode/universal/start';
async function setup(page, extra = {}, version, pendingStops = [], skipSettings = {}, metadataForRequest = null, bifBytes = null, subtitleResponse = null, waitForPlayback = true, mkvFixture = null, entryUrl = '/') {
  const video = await readFile(path.join(__dirname,'fixtures/test.webm'));
  const calls = [], events = [];
  let metadataRequests = 0;
  // Existing renderer/Direct Play regressions explicitly exercise the opt-in
  // path; the compatibility-mode case below switches it off.
  await page.addInitScript(({pendingStops,skipSettings})=>localStorage.setItem('plezy.webos',JSON.stringify({srtPlayback:true,...skipSettings,deviceId:'device',active:'plex',
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
    if (url.pathname === plexSubtitlePath && url.searchParams.get('protocol') !== 'http') {
      return route.fulfill({status:400,body:'Invalid protocol for subtitle-only transcode'});
    }
    if (url.pathname.endsWith('/start.m3u8') && url.searchParams.get('X-Plex-Platform') === 'Chrome' &&
        url.searchParams.get('X-Plex-Client-Profile-Extra')?.includes('add-transcode-target') &&
        url.searchParams.has('hasMDE')) {
      return route.fulfill({status:400,body:'ClientProfileExtra: video transcode target already exists for streaming hls'});
    }
    if ((url.pathname === plexSubtitlePath || url.pathname.endsWith('/start.m3u8') &&
        url.searchParams.get('X-Plex-Platform') !== 'Chrome') && !calls.some(call =>
      call.pathname.endsWith('/transcode/universal/decision') && call.search === url.search)) {
      return route.fulfill({status:400,body:'Transcode session has no playback decision'});
    }
    if (subtitleResponse && (url.pathname === '/subtitles.srt' || url.pathname.startsWith('/library/streams/') ||
        url.pathname === plexSubtitlePath))
      return route.fulfill({contentType:'text/plain',body:await subtitleResponse(url)});
    if (url.pathname === '/library/parts/embedded/file.mkv') {
      const mkv = mkvFixture?.source || await readFile(path.join(__dirname,'fixtures/embedded-subtitles.mkv'));
      const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range || '');
      if (!range) return route.fulfill({status:416,body:''});
      const start = +range[1], end = Math.min(+range[2], mkv.length - 1);
      mkvFixture?.onRange?.(start,end);
      const status = await mkvFixture?.beforeRead?.(start);
      if (status) return route.fulfill({status,body:''});
      return route.fulfill({status:206,contentType:'video/x-matroska',
        headers:{'Content-Range':`bytes ${start}-${end}/${mkv.length}`},
        body:mkv.subarray(start,end + 1)});
    }
    if (url.pathname.endsWith('/transcode/universal/subtitles') || url.pathname === plexSubtitlePath)
      return route.fulfill({status:404,body:''});
    if (url.pathname.endsWith('/indexes/sd'))
      return bifBytes ? route.fulfill({contentType:'application/octet-stream',body:bifBytes})
        : route.fulfill({status:404,body:''});
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
  await page.goto(entryUrl); await page.getByRole('button',{name:'Test Movie',exact:true}).click();
  if (version !== undefined) await page.getByLabel('Media version',{exact:true}).selectOption(String(version));
  await page.locator('#main .detail-play').click();
  if (waitForPlayback) {
    await expect.poll(()=>page.locator('video').evaluate(v=>v.paused)).toBe(false);
    await expect.poll(()=>events.length).toBeGreaterThan(0);
  }
  return {calls,events};
}
test('compatibility mode never activates enhanced subtitle or Direct Play pipelines for MKV SRT/ASS',async({page})=>{
  for (const codec of ['srt','ass']) {
    const {calls}=await setup(page,{Media:[{container:'mkv',videoCodec:'h264',audioCodec:'aac',
      Part:[{id:'part',key:'/video.webm',Stream:[
        {streamType:3,id:32,codec,selected:1}]}]}]},undefined,[],{srtPlayback:false},
        null,null,null,false);
    // Chromium desktop cannot decode HLS; validate the URL and UI without
    // treating a fake video/webm response as a functioning HLS stream.
    await expect.poll(()=>calls.filter(url=>url.pathname.endsWith('/start.m3u8')).length).toBe(1);
    const starts=calls.filter(url=>url.pathname.endsWith('/start.m3u8'));
    expect(starts).toHaveLength(1);
    expect(starts[0].searchParams.get('subtitles')).toBe('burn');
    expect(starts[0].searchParams.get('X-Plex-Platform')).toBe('Chrome');
    expect(starts[0].searchParams.has('hasMDE')).toBe(false);
    expect(calls.some(url=>url.pathname.endsWith('/transcode/universal/decision'))).toBe(false);
    expect(calls.some(url=>url.pathname==='/subtitles/:/transcode/universal/start')).toBe(false);
    expect(calls.some(url=>url.pathname.includes('/library/parts/embedded/file.mkv'))).toBe(false);
    const renderer=await page.evaluate(()=>({
      assScript:!!document.querySelector('script[src^="libass/"]'),
      pixiScript:!!document.querySelector('script[src="pixi.min.js"]'),
      assRuntime:typeof window.SubtitlesOctopus,
      captions:document.querySelector('.player-captions')?.childElementCount || 0
    }));
    expect(renderer).toEqual({assScript:false,pixiScript:false,assRuntime:'undefined',captions:0});
    await page.getByRole('button',{name:'Playback settings'}).click();
    const sync=page.getByRole('button',{name:'Subtitle sync',exact:true});
    await expect(sync).toHaveAttribute('aria-disabled','true');
    await expect(sync).toHaveClass(/is-disabled/);
    await expect(page.locator('.player-settings-sync-value')).toHaveText('Burned in');
    await sync.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#toast')).toHaveText('Cannot offset burned-in subtitles');
    await expect(page.getByRole('slider',{name:'Subtitle sync offset'})).toHaveCount(0);
  }
});
test('enhanced SRT track changes and Off avoid decoder reload; ASS selects Plex burn-in',async({page})=>{
  await page.addInitScript(()=>{
    window.plezyVideoLoads=0;
    const original=HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load=function(){
      window.plezyVideoLoads++;
      return original.apply(this,arguments);
    };
  });
  const {calls}=await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:3,id:31,codec:'srt',languageCode:'eng',selected:1,key:'/subtitles.srt'},
      {streamType:3,id:32,codec:'srt',languageCode:'fra',key:'/subtitles.srt'},
      {streamType:3,id:33,codec:'ass',languageCode:'spa',key:'/subtitles.ass'}
    ]}]}]},undefined,[],{},null,null,async()=>{
    return '1\n00:00:10,000 --> 00:00:11,000\nSRT fast switch\n';
  });
  const loads=await page.evaluate(()=>window.plezyVideoLoads);
  const trackSheet=page.getByRole('button',{name:'Audio & Subtitles'});
  await trackSheet.click();
  await page.locator('.player-track-column').last().getByRole('button',{name:/French/}).click();
  await expect(page.locator('.player-track-column').last().getByRole('button',{name:/French/}))
    .toHaveAttribute('aria-pressed','true');
  expect(await page.evaluate(()=>window.plezyVideoLoads)).toBe(loads);
  await page.locator('.player-track-column').last().getByRole('button',{name:'Off',exact:true}).click();
  expect(await page.evaluate(()=>window.plezyVideoLoads)).toBe(loads);
  await page.locator('.player-track-column').last().getByRole('button',{name:/English/}).click();
  expect(await page.evaluate(()=>window.plezyVideoLoads)).toBe(loads);
  await page.locator('.player-track-column').last().getByRole('button',{name:/Spanish/}).click();
  await expect.poll(()=>calls.some(url=>url.pathname.endsWith('/start.m3u8') &&
    url.searchParams.get('subtitles')==='burn')).toBe(true);
  expect(await page.evaluate(()=>window.plezyVideoLoads)).toBeGreaterThan(loads);
  expect(calls.some(url=>url.pathname==='/library/streams/33.ass')).toBe(false);
  expect(await page.evaluate(()=>typeof window.SubtitlesOctopus)).toBe('undefined');
});

function buildBif(image) {
  const count=2, tableEnd=64+(count+1)*8;
  const bytes=Buffer.alloc(tableEnd+2*image.length);
  Buffer.from([0x89,0x42,0x49,0x46,0x0d,0x0a,0x1a,0x0a]).copy(bytes);
  bytes.writeUInt32LE(count,12);bytes.writeUInt32LE(1000,16);
  for(let i=0;i<count;i++) {
    bytes.writeUInt32LE(i*10,64+i*8);
    bytes.writeUInt32LE(tableEnd+i*image.length,64+i*8+4);
    image.copy(bytes,tableEnd+i*image.length);
  }
  bytes.writeUInt32LE(0xffffffff,64+count*8);
  bytes.writeUInt32LE(bytes.length,64+count*8+4);
  return bytes;
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

test('Stop during native HLS resume retires the old decoder and replay displays its resume frame',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>{
    window.PalmSystem = {};
    window.hlsOpens = [];
    // Chromium may inspect an appended source even though load and play are
    // mocked. Its rejection of LG's mediaOption MIME is outside this fixture.
    document.addEventListener('error', event=>{
      if (event.isTrusted && (event.target instanceof HTMLSourceElement ||
          event.target instanceof HTMLVideoElement)) event.stopImmediatePropagation();
    }, true);
    const load = HTMLMediaElement.prototype.load;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.load = function() {
      const source = this.querySelector('source');
      if (!source?.src.includes('/start.m3u8')) return load.call(this);
      window.hlsOpens.push({video:this, url:source.src, type:source.type});
    };
    HTMLMediaElement.prototype.play = function() {
      if (this.querySelector('source')?.src.includes('/start.m3u8')) return new Promise(()=>{});
      return play.call(this);
    };
  });
  await setup(page,{viewOffset:85000,Media:[{container:'mkv',videoCodec:'hevc',audioCodec:'dts',
    Part:[{id:'part',key:'/video.webm',Stream:[{streamType:3,id:32,codec:'ass',selected:1}]}]}]},
    undefined,[],{},null,null,null,false);
  const opened = () => page.evaluate(()=>window.hlsOpens.length);
  await expect.poll(opened).toBe(1);
  let stopRequests = 0, stoppedSession, releaseStop;
  const stopGate = new Promise(resolve=>{releaseStop=resolve;});
  await page.route('http://plex.test/video/:/transcode/universal/stop**',async route=>{
    stopRequests++;
    stoppedSession = new URL(route.request().url()).searchParams.get('session');
    await stopGate;
    return route.fulfill({body:''});
  });
  const player = page.locator('#player');
  const video = player.locator('video');
  try {
    await page.getByRole('button',{name:'Stop',exact:true}).click();
    await expect(player).toBeHidden();
    await expect.poll(()=>stopRequests).toBe(1);
    await page.locator('#main .detail-play').click();
    await page.waitForTimeout(100);
    expect(await opened()).toBe(1);
    await expect(player).toBeHidden();
    releaseStop();
    await expect(player).toBeVisible();
    await expect.poll(opened).toBe(2);
    const replay = await page.evaluate(()=>{
      const [first, next] = window.hlsOpens;
      const session = open => new URL(open.url).searchParams.get('session');
      const option = JSON.parse(decodeURIComponent(next.type.split(';mediaOption=')[1]));
      return {oldSession:session(first),newSession:session(next),target:option.option.transmission.playTime.start,
        oldConnected:first.video.isConnected, sameVideo:first.video===next.video};
    });
    expect(replay.oldSession).toBe(stoppedSession);
    expect(replay.newSession).not.toBe(stoppedSession);
    expect(replay.target).toBe(85000);
    expect(replay.sameVideo).toBe(false);
    expect(replay.oldConnected).toBe(false);

    // Old native callbacks can arrive during replay. The new element owns
    // playback, and its early playing event still has a stale LG clock.
    await video.evaluate(current=>{
      window.hlsOpens[0].video.dispatchEvent(new Event('ended'));
      window.resumeClock = 0;
      Object.defineProperty(current,'readyState',{configurable:true,value:1});
      Object.defineProperty(current,'currentTime',{configurable:true,get:()=>window.resumeClock,
        set:value=>{window.unexpectedSeek=value;}});
      current.dispatchEvent(new Event('playing'));
    });
    await expect(player).toBeVisible();
    await expect(player.locator('.player-status')).toBeEmpty();
    await expect(video).toHaveCSS('visibility','hidden');
    await expect(player.locator('.player-buffering')).toBeVisible();
    await video.evaluate(current=>{
      window.resumeClock = 86.5;
      current.dispatchEvent(new Event('timeupdate'));
    });
    await expect(video).toHaveCSS('visibility','visible');
    await expect(player.locator('.player-buffering')).toBeHidden();
    expect(await page.evaluate(()=>window.unexpectedSeek)).toBeUndefined();
    await page.clock.fastForward(31000);
    await expect(player.locator('.player-status')).toBeEmpty();
    expect(await opened()).toBe(2);
  } finally { releaseStop(); }
});

test('Back during delayed stream cleanup cannot resurrect playback',async({page})=>{
  const {calls,events}=await setup(page), releaseStops=[];
  await page.route('http://plex.test/**/timeline**',async route=>{
    if(new URL(route.request().url()).searchParams.get('state')==='stopped')
      await new Promise(resolve=>{releaseStops.push(resolve);});
    await route.fulfill({json:{}});
  });
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.locator('.player-sheet').getByRole('button',{name:'Compatible playback',exact:true}).click();
  await expect.poll(()=>releaseStops.length).toBeGreaterThan(0);
  // Unlike the old serialized cleanup, a delayed timeline Stop must NOT
  // block the replacement decoder from opening.
  const started=()=>calls.filter(u=>u.pathname.endsWith('/start.m3u8')).length;
  await expect.poll(started).toBeGreaterThan(0);
  const startsBeforeBack=started();
  await page.keyboard.press('Escape');
  await expect(page.locator('.controls')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#player')).toBeHidden();
  await expect.poll(()=>events.some(e=>e.path==='/scrobble/stop')).toBe(true);
  releaseStops.forEach(resolve=>resolve());
  // Neither a released network report nor an old Play promise may re-open
  // playback after the user's explicit Back.
  await page.waitForTimeout(300);
  releaseStops.forEach(resolve=>resolve());
  expect(started()).toBe(startsBeforeBack);
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
  await page.getByRole('button',{name:'Services',exact:true}).click();
  await page.getByRole('button',{name:'Simkl',exact:true}).click();
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

test('player transport discs remain fixed while chapters load asynchronously',async({page})=>{
  let releaseExtras;
  const delayedExtras=new Promise(resolve=>{releaseExtras=resolve;});
  await setup(page,{},undefined,[],{},async(number,item)=>{
    if(number===1)return item;
    await delayedExtras;
    return {...item,Chapter:[{title:'First',startTimeOffset:0},
      {title:'Second',startTimeOffset:10000}]};
  });
  const actions=['backward','pause','forward','stop',
    'options','tracks-options','chapter-options'];
  const chapter=page.getByRole('button',{name:'Chapters',exact:true});
  await expect(chapter).toBeVisible();
  await expect(chapter).toBeDisabled();
  for(const action of actions)
    await expect(page.locator('[data-action="'+action+'"]')).toBeVisible();
  await expect(page.locator('[data-action="previous-chapter"],[data-action="next-chapter"]')).toHaveCount(0);
  const locations=()=>page.evaluate(actions=>actions.map(action=>{
    const rect=document.querySelector('[data-action="'+action+'"]').getBoundingClientRect();
    return {action,left:rect.left,top:rect.top,width:rect.width,height:rect.height};
  }),actions);
  const before=await locations();
  releaseExtras();
  await expect(chapter).toBeEnabled();
  expect(await locations()).toEqual(before);
  for(const action of actions)
    await expect(page.locator('[data-action="'+action+'"]')).toBeVisible();
});

test('chapter and track controls stay visible even when a file has no chapters or alternate tracks',async({page})=>{
  await setup(page);
  const chapter=page.getByRole('button',{name:'Chapters',exact:true});
  await expect(chapter).toBeVisible();
  await expect(chapter).toBeDisabled();
  await expect(page.getByRole('button',{name:'Audio & Subtitles'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Stop',exact:true})).toBeVisible();
  await expect(page.locator('.player-buttons .transport-icon')).toHaveCount(4);
});

test('Programme up/down navigate chapters with Plezy’s three-second restart rule',async({page})=>{
  await setup(page,{Chapter:[{title:'First',startTimeOffset:0},
    {title:'Second',startTimeOffset:10000},{title:'Third',startTimeOffset:45000}]});
  await page.locator('video').evaluate(video=>video.pause());
  const position=()=>page.locator('video').evaluate(video=>video.currentTime);

  // LG's legacy Programme +/- events are PageUp / PageDown (33 / 34).
  await page.keyboard.press('PageUp');
  await expect.poll(position).toBeGreaterThanOrEqual(10);
  await page.keyboard.press('PageUp');
  await expect.poll(position).toBeGreaterThanOrEqual(45);
  await page.keyboard.press('PageUp'); // No wraparound at the last chapter.
  await expect.poll(position).toBeGreaterThanOrEqual(45);

  await page.locator('video').evaluate(video=>{video.currentTime=14;});
  await page.keyboard.press('PageDown'); // >3 s into chapter: restart it.
  await expect.poll(position).toBeGreaterThanOrEqual(10);
  await expect.poll(position).toBeLessThan(11);
  await page.keyboard.press('PageDown'); // At its start: previous chapter.
  await expect.poll(position).toBeLessThan(1);
  await page.keyboard.press('PageDown'); // No wraparound at title start.
  await expect.poll(position).toBeLessThan(1);
});

test('Programme chapter keys preserve an open player sheet',async({page})=>{
  await setup(page,{Chapter:[{title:'First',startTimeOffset:0},
    {title:'Second',startTimeOffset:10000}]});
  await page.getByRole('button',{name:'Chapters',exact:true}).click();
  const focused=page.locator('.player-chapter-option:focus');
  await expect(focused).toHaveCount(1);
  await page.keyboard.press('PageUp');
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(10);
  await expect(page.locator('.player-sheet')).toBeVisible();
  await expect(focused).toHaveCount(1);
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

test('timeline focus uses Plezy knob without a rectangular outline',async({page})=>{
 await setup(page);
 const slider=page.getByRole('slider',{name:'Seek playback'});
 await slider.focus();
 await expect(slider).toHaveCSS('outline-style','none');
 await expect(slider).toHaveCSS('box-shadow','none');
 await expect(slider).toHaveCSS('border-top-width','0px');
});

test('Plex BIF thumbnails appear over the timeline during remote seeking',async({page})=>{
 const image=await readFile(path.join(__dirname,'../public/icon.png'));
 const {calls}=await setup(page,{},undefined,[],{},null,buildBif(image));
 await expect.poll(()=>calls.some(url=>url.pathname.endsWith('/indexes/sd'))).toBe(true);
 await page.keyboard.press('Escape');
 await page.keyboard.press('ArrowRight');
 const preview=page.locator('.seek-preview');
 await expect(preview).toBeVisible();
 await expect(preview.locator('img')).toHaveAttribute('src',/^blob:/);
 await expect.poll(()=>preview.locator('img').evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
 expect((await preview.boundingBox()).width).toBeGreaterThanOrEqual(300);
 await page.keyboard.press('Enter');
 await expect(preview).toBeHidden();
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
  // LG can deliver decoder events and restore the previous button's focus
  // after the first Back. None of these can reopen the chrome.
  await page.evaluate(()=>{
    const video=document.querySelector('#player video');
    video.dispatchEvent(new Event('pause'));
    document.querySelector('[data-action="stop"]').focus();
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:0,clientY:0}));
  });
  await expect(page.locator('.controls')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#player')).toBeHidden();
});
test('LG 461 Back is not undone by delayed pause or focus restoration',async({page})=>{
  await setup(page);
  const lgBack=()=>page.evaluate(()=>{
    const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'keyCode',{value:461});
    window.dispatchEvent(event);
  });
  await lgBack();
  await expect(page.locator('.controls')).toBeHidden();
  await page.evaluate(()=>{
    const video=document.querySelector('#player video');
    video.dispatchEvent(new Event('pause'));
    document.querySelector('[data-action="pause"]').focus();
    video.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:500,clientY:300}));
  });
  await expect(page.locator('.controls')).toBeHidden();
  await lgBack();
  await expect(page.locator('#player')).toBeHidden();
});
test('remote seeks in hidden mode and center commits preview then dismisses controls',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.controls')).toBeHidden();
  await page.locator('video').evaluate(video=>{
    window.decoderSeekTargets=[];
    const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
    Object.defineProperty(video,'currentTime',{
      configurable:true,
      get(){return descriptor.get.call(video);},
      set(value){window.decoderSeekTargets.push(value);descriptor.set.call(video,value);}
    });
    window.decoderSeekEvents=0;
    video.addEventListener('seeking',()=>window.decoderSeekEvents++);
  });
  await page.keyboard.press('ArrowRight');
  const slider=page.getByRole('slider',{name:'Seek playback'});
  await expect(slider).toBeFocused();
  const value=Number(await slider.inputValue());
  expect(value).toBeGreaterThanOrEqual(10);
  await expect(page.locator('video')).toHaveJSProperty('paused',false);
  await page.keyboard.press('ArrowRight');
  const next=Number(await slider.inputValue());
  expect(next).toBeGreaterThan(value);
  expect(await page.evaluate(()=>window.decoderSeekTargets)).toEqual([]);
  expect(await page.evaluate(()=>window.decoderSeekEvents)).toBe(0);
  await expect(page.locator('.player-buffering')).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(page.locator('.controls')).toBeHidden();
  await expect(page.locator('#player')).toBeVisible();
  expect(await page.evaluate(()=>window.decoderSeekTargets)).toHaveLength(1);
  await expect.poll(()=>page.locator('video').evaluate(el=>el.currentTime)).toBeGreaterThanOrEqual(next-2);
});
test('leaving a remote seek cancels preview without seeking or losing transport focus',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  const slider=page.getByRole('slider',{name:'Seek playback'});
  const target=Number(await slider.inputValue());
  await page.locator('video').evaluate(video=>{
    window.seekPlayCalls=0;
    const originalPlay=video.play.bind(video);
    video.play=()=>{window.seekPlayCalls++;return originalPlay();};
  });
  const stop=page.getByRole('button',{name:'Stop',exact:true});
  await stop.focus();
  await expect(page.locator('.seek-preview')).toBeHidden();
  expect(await page.evaluate(()=>window.seekPlayCalls)).toBe(0);
  await expect(page.locator('video')).toHaveJSProperty('paused',false);
  expect(await page.locator('video').evaluate(video=>video.currentTime)).toBeLessThan(target-2);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button',{name:'+30 seconds',exact:true})).toBeFocused();
});
test('Back cancels unconfirmed remote seek and then exits the player',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.seek-preview')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.controls')).toBeHidden();
  await expect(page.locator('.seek-preview')).toBeHidden();
  await expect(page.locator('.player-buffering')).toBeHidden();
  await expect.poll(()=>page.locator('video').evaluate(video=>video.paused)).toBe(false);
  expect(await page.locator('video').evaluate(video=>video.currentTime)).toBeLessThan(10);
  await page.keyboard.press('Escape');
  await expect(page.locator('#player')).toBeHidden();
});
test('a remote seek from paused automatically resumes after committing',async({page})=>{
  await setup(page);
  await page.locator('video').evaluate(video=>video.pause());
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(9);
  await expect.poll(()=>page.locator('video').evaluate(video=>video.paused)).toBe(false);
});

test('Pause during buffering after a paused seek prevents late automatic playback',async({page})=>{
  await setup(page);
  await page.locator('video').evaluate(video=>video.pause());
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.locator('video').evaluate(video=>{
    window.seekPlayCalls=0;
    window.seekPauseCalls=0;
    const nativePause=video.pause.bind(video);
    video.pause=()=>{window.seekPauseCalls++;return nativePause();};
    // The LG play request can remain unresolved while waiting for data.
    video.play=()=>{window.seekPlayCalls++;return new Promise(()=>{});};
  });
  await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.seekPlayCalls)).toBe(1);
  await page.keyboard.press('Space');
  await page.locator('video').dispatchEvent('seeked');
  await expect(page.locator('video')).toHaveJSProperty('paused',true);
  const beforeLatePlay=await page.evaluate(()=>window.seekPauseCalls);
  await page.locator('video').dispatchEvent('playing');
  expect(await page.evaluate(()=>window.seekPauseCalls)).toBeGreaterThan(beforeLatePlay);
  await page.waitForTimeout(1300);
  expect(await page.evaluate(()=>window.seekPlayCalls)).toBe(1);
  await expect(page.locator('video')).toHaveJSProperty('paused',true);
});

test('confirming a remote seek wakes a paused decoder without waiting for seeked',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  const slider=page.getByRole('slider',{name:'Seek playback'});
  const target=Number(await slider.inputValue());
  await page.locator('video').evaluate(video=>{
    window.seekPlayCalls=0;
    const originalPlay=video.play.bind(video);
    video.play=()=>{window.seekPlayCalls++;return originalPlay();};
    // Simulate a decoder pausing during seek. The remote preview itself
    // remains playing, so we force the hardware failure before confirming.
    Object.defineProperty(video,'seeking',{configurable:true,get(){return true;}});
    video.pause();
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('#player .controls')).toBeHidden();
  expect(await page.evaluate(()=>window.seekPlayCalls)).toBeGreaterThan(0);
  await page.locator('video').evaluate(video=>{
    Object.defineProperty(video,'seeking',{configurable:true,get(){return false;}});
    video.dispatchEvent(new Event('seeked'));
  });
  await expect.poll(()=>page.evaluate(()=>window.seekPlayCalls)).toBe(1);
  await expect.poll(()=>page.locator('video').evaluate(video=>video.paused)).toBe(false);
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(target-1);
});
test('remote seek recovers when old webOS never emits seeked while paused',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.locator('video').evaluate(video=>{
    window.seekPlayCalls=0;
    const nativePlay=video.play.bind(video);
    video.play=()=>{
      window.seekPlayCalls++;
      // Decoder wakes up when playback is requested; seeked is not emitted
      // beforehand on this mocked LG behavior.
      Object.defineProperty(video,'seeking',{configurable:true,get(){return false;}});
      video.dispatchEvent(new Event('seeked'));
      return nativePlay();
    };
    // Old LG video engines may not resolve seeking until they are playing.
    Object.defineProperty(video,'seeking',{configurable:true,get(){return true;}});
    video.pause();
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.controls')).toBeHidden();
  expect(await page.evaluate(()=>window.seekPlayCalls)).toBeGreaterThan(0);
  await expect.poll(()=>page.evaluate(()=>window.seekPlayCalls),{timeout:3000}).toBeGreaterThan(0);
  await expect.poll(()=>page.locator('video').evaluate(video=>video.paused),{timeout:3000}).toBe(false);
  // Recovery must not reopen chrome.
  await expect(page.locator('.controls')).toBeHidden();
});

test('remote seek resumes even when old webOS reports the stale timestamp until Play',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.locator('video').evaluate(video=>{
    window.seekPlayCalls=0;
    const nativePlay=video.play.bind(video);
    const staleTime=video.currentTime;
    let queuedTarget=staleTime;
    // Reproduce old LG native engines whose currentTime getter stays stale
    // and whose seeking flag never clears until play() wakes the decoder.
    Object.defineProperty(video,'currentTime',{
      configurable:true,get(){return staleTime;},set(next){queuedTarget=next;}
    });
    Object.defineProperty(video,'seeking',{configurable:true,get(){return true;}});
    video.play=()=>{
      window.seekPlayCalls++;
      delete video.currentTime;
      delete video.seeking;
      video.currentTime=queuedTarget;
      video.dispatchEvent(new Event('seeked'));
      return nativePlay();
    };
    video.pause();
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.controls')).toBeHidden();
  expect(await page.evaluate(()=>window.seekPlayCalls)).toBeGreaterThan(0);
  await expect.poll(()=>page.evaluate(()=>window.seekPlayCalls),{timeout:3000}).toBeGreaterThan(0);
  await expect.poll(()=>page.locator('video').evaluate(video=>video.paused),{timeout:3000}).toBe(false);
  await expect(page.locator('.controls')).toBeHidden();
});

test('LG seek recovery wakes an unpaused decoder whose clock never advances',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.locator('video').evaluate(video=>{
    window.seekDecoderKicks=0;
    const nativePlay=video.play.bind(video);
    const nativePause=video.pause.bind(video);
    const timeDescriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
    let seekTarget=null;
    Object.defineProperty(video,'currentTime',{
      configurable:true,
      get(){return seekTarget===null ? timeDescriptor.get.call(video) : seekTarget;},
      set(next){seekTarget=next;timeDescriptor.set.call(video,next);}
    });
    video.pause=()=>{
      window.seekDecoderKicks++;
      return nativePause();
    };
    video.play=()=>{
      if (window.seekDecoderKicks) delete video.currentTime;
      return nativePlay();
    };
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.controls')).toBeHidden();
  // The browser claims playback is running, but the exposed decoder clock is
  // frozen on the exact requested seek timestamp. No OK/Play key is sent.
  await expect.poll(()=>page.evaluate(()=>window.seekDecoderKicks),{timeout:7000}).toBeGreaterThan(0);
  await expect.poll(()=>page.locator('video').evaluate(video=>video.paused)).toBe(false);
  await expect(page.locator('.controls')).toBeHidden();
});
test('LG seek recovery retries a Play promise that never settles',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.locator('video').evaluate(video=>{
    window.seekPlayCalls=0;
    const originalPlay=video.play.bind(video);
    video.pause();
    video.play=()=>{
      window.seekPlayCalls++;
      if (window.seekPlayCalls===1) return new Promise(()=>{});
      return originalPlay();
    };
  });
  await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.seekPlayCalls),{timeout:6500}).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.controls')).toBeHidden();
});

test('decoder pause arriving after a confirmed seek is recovered automatically',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.locator('video').evaluate(video=>video.pause());
  await expect.poll(()=>page.locator('video').evaluate(video=>video.paused),{timeout:3000}).toBe(false);
  await expect(page.locator('.controls')).toBeHidden();
});

test('refocusing transport during committed-seek buffering cancels deferred chrome hiding',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('#player .controls')).toBeHidden();
  await page.keyboard.press('ArrowUp');
  const stop=page.getByRole('button',{name:'Stop',exact:true});
  await stop.focus();
  await page.locator('video').dispatchEvent('playing');
  await expect(stop).toBeFocused();
  await expect(page.locator('#player .controls')).toBeVisible();
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

test('skip prompt sits above the complete transport chrome, clear of the seekbar',async({page})=>{
  await setup(page,{Marker:[{type:'intro',startTimeOffset:4000,endTimeOffset:15000}]});
  await page.locator('video').evaluate(video=>{
    video.currentTime=5;
    video.dispatchEvent(new Event('timeupdate'));
  });
  const skip=page.getByRole('button',{name:'Skip intro'});
  await expect(skip).toBeVisible();
  const placement=await page.evaluate(()=>({
    skip:document.querySelector('.player-skip').getBoundingClientRect().bottom,
    chrome:document.querySelector('#player .controls').getBoundingClientRect().top,
    timeline:document.querySelector('.timeline-track').getBoundingClientRect().top
  }));
  expect(placement.skip).toBeLessThan(placement.chrome-10);
  expect(placement.skip).toBeLessThan(placement.timeline);
});

test('skip prompt anchor does not alternate on repeated playback updates',async({page})=>{
  await setup(page,{Marker:[{type:'intro',startTimeOffset:4000,endTimeOffset:15000}]});
  await page.locator('video').evaluate(video=>{
    video.currentTime=5;video.dispatchEvent(new Event('timeupdate'));
  });
  const skip=page.getByRole('button',{name:'Skip intro'});
  await expect(skip).toBeVisible();
  const anchors=await page.evaluate(()=>{
    const video=document.querySelector('#player video');
    const button=document.querySelector('.player-skip');
    const positions=[];
    for(let i=0;i<24;i++){
      video.dispatchEvent(new Event('timeupdate'));
      positions.push(button.getBoundingClientRect().bottom);
    }
    return positions;
  });
  expect(new Set(anchors).size).toBe(1);
  const chromeTop=await page.locator('#player .controls').evaluate(node=>node.getBoundingClientRect().top);
  expect(anchors[0]).toBeLessThan(chromeTop-10);
});

test('hidden-chrome skip prompt stays under the pointer through a single click',async({page})=>{
  await setup(page,{Marker:[{type:'intro',startTimeOffset:4000,endTimeOffset:15000}]});
  await page.locator('video').evaluate(video=>{
    video.currentTime=5;video.dispatchEvent(new Event('timeupdate'));
  });
  const skip=page.getByRole('button',{name:'Skip intro'});
  await expect(skip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#player .controls')).toBeHidden();
  const bounds=await skip.boundingBox();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  await expect(page.locator('#player .controls')).toBeHidden();
  await expect(skip).toBeVisible();
  await skip.click();
  await expect(skip).toBeHidden();
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(15);
});

test('transport focus survives decoder buffering but controls still auto-hide',async({page})=>{
  await setup(page,{Marker:[{type:'intro',startTimeOffset:4000,endTimeOffset:15000}]});
  await page.locator('video').evaluate(video=>{
    window.PalmSystem={};video.currentTime=5;
    video.dispatchEvent(new Event('timeupdate'));
  });
  await expect(page.getByRole('button',{name:'Skip intro'})).toBeFocused();
  await page.keyboard.press('Enter');
  const stop=page.getByRole('button',{name:'Stop',exact:true});
  await stop.focus();
  await simulatePlaybackStarvation(page);
  await page.locator('video').dispatchEvent('playing');
  await expect(stop).toBeFocused();
  // Some LG decoders remove DOM focus while seeking. Restore the transport
  // control the user last selected, rather than blindly focusing Pause.
  await page.evaluate(()=>document.activeElement.blur());
  await page.locator('video').dispatchEvent('playing');
  await expect(stop).toBeFocused();
  const before=await page.locator('video').evaluate(video=>video.currentTime);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button',{name:'+30 seconds',exact:true})).toBeFocused();
  expect(await page.locator('video').evaluate(video=>video.currentTime)).toBeLessThan(before+2);
  // Focus restoration is not ongoing activity: chrome must time out normally.
  await page.waitForTimeout(5200);
  await expect(page.locator('#player .controls')).toBeHidden();
  await expect(page.locator('video')).toBeFocused();
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

async function setupWithLocalSrt(page) {
  return setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:3,id:31,codec:'srt',key:'/library/streams/31.srt',selected:1}
    ]}]}]},undefined,[],{},null,null,async()=>
    '1\n00:00:10,000 --> 00:00:11,000\nSubtitle sync fixture\n');
}

test('subtitle sync opens Plezy compact top bar with reachable slider and correct D-pad focus', async ({page}) => {
  await setupWithLocalSrt(page);
  await page.getByRole('button',{name:'Playback settings'}).click();
  const settingsRow=page.getByRole('button',{name:'Subtitle sync',exact:true});
  await expect(settingsRow).toBeFocused();
  await expect(page.getByRole('slider',{name:'Subtitle sync offset'})).toHaveCount(0);
  await page.keyboard.press('Enter');

  const bar=page.locator('.player-sheet.sheet-sync');
  const slider=page.getByRole('slider',{name:'Subtitle sync offset'});
  await expect(bar).toBeVisible();
  await expect(slider).toBeFocused();
  await expect(slider).toHaveAttribute('min','-10000');
  await expect(slider).toHaveAttribute('max','10000');
  const box=await bar.boundingBox();
  expect(box.y).toBeLessThan(120);
  expect(box.width).toBeGreaterThan(500);
  expect(Math.abs(box.x + box.width / 2 - 960)).toBeLessThan(3);

  // Up/Down changes the offset, Left/Right changes focus. Never use a
  // slider endpoint to reach the other buttons.
  await page.keyboard.press('ArrowUp');
  await expect(slider).toBeFocused();
  await expect(page.locator('.sync-offset-value')).toHaveText('+50ms');
  await page.keyboard.press('ArrowDown');
  await expect(slider).toBeFocused();
  await expect(page.locator('.sync-offset-value')).toHaveText('+0ms');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button',{name:'Decrease subtitle delay'})).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button',{name:'Increase subtitle delay'})).toBeFocused();
  await expect(page.locator('.sync-offset-value')).toHaveText('+0ms');
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toBeFocused();

  // OK still offers a shortcut directly to Close.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'Close subtitle sync'})).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button',{name:'Reset subtitle sync'})).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button',{name:'Increase subtitle delay'})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.sync-offset-value')).toHaveText('+50ms');
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toBeFocused();

  // Back dismisses the bar and restores focus to the settings transport disc.
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await expect(page.getByRole('button',{name:'Playback settings'})).toBeFocused();
});

test('sync bar Left/Right traverses every SVG button and Up/Down adjusts without moving focus', async ({page}) => {
  await setupWithLocalSrt(page);
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.getByRole('button',{name:'Subtitle sync',exact:true}).click();
  const slider=page.getByRole('slider',{name:'Subtitle sync offset'});
  const minus=page.getByRole('button',{name:'Decrease subtitle delay'});
  const plus=page.getByRole('button',{name:'Increase subtitle delay'});
  const reset=page.getByRole('button',{name:'Reset subtitle sync'});
  const close=page.getByRole('button',{name:'Close subtitle sync'});
  await expect(slider).toBeFocused();
  await expect(slider).toHaveValue('0');
  // Video decoders sometimes drop focus to the page body while a sheet is
  // open. A direction key must restore a reachable focused control.
  await page.evaluate(()=>document.activeElement.blur());
  await page.keyboard.press('ArrowRight');
  await expect(slider).toBeFocused();

  // Icons must be actual SVGs. The previous ↺ character was a missing glyph
  // (an apparent checkbox) on the target LG's browser/font combination.
  await expect(page.locator('.sync-offset-button svg')).toHaveCount(4);
  await expect(reset.locator('svg path')).toHaveCount(1);
  await expect(reset.locator('svg path')).toHaveAttribute('d',/M3 12a9 9/);
  await expect(reset.locator('svg')).toHaveCSS('position','absolute');
  await expect(reset).toHaveText('');

  await page.keyboard.press('ArrowLeft');
  await expect(minus).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(plus).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(reset).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(close).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(reset).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(plus).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toBeFocused();
  await expect(slider).toHaveValue('0');
  await expect(page.locator('.sync-offset-value')).toHaveText('+0ms');

  // Up/Down always changes the value, never the focused element, including
  // from another button in this one-row control.
  await page.keyboard.press('ArrowUp');
  await expect(slider).toBeFocused();
  await expect(page.locator('.sync-offset-value')).toHaveText('+50ms');
  await page.keyboard.press('ArrowLeft');
  await expect(minus).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(minus).toBeFocused();
  await expect(page.locator('.sync-offset-value')).toHaveText('+0ms');
  await page.keyboard.press('Enter');
  await expect(minus).toBeFocused();
  await expect(page.locator('.sync-offset-value')).toHaveText('-50ms');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(plus).toBeFocused();
  await expect(page.locator('.sync-offset-value')).toHaveText('+0ms');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(reset).toBeFocused();
  await expect(page.locator('.sync-offset-value')).toHaveText('+0ms');
});

test('subtitle sync reaches both full-minute limits, updates live cues, and resets', async ({page}) => {
  await setupWithLocalSrt(page);
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.getByRole('button',{name:'Subtitle sync',exact:true}).click();
  const slider=page.getByRole('slider',{name:'Subtitle sync offset'});
  const plus=page.getByRole('button',{name:'Increase subtitle delay'});
  const minus=page.getByRole('button',{name:'Decrease subtitle delay'});
  await page.evaluate(() => {
    const video=document.querySelector('#player video');
    const track=video.addTextTrack('subtitles','Fixture subtitles','en');
    track.mode='showing';
    const cue=new VTTCue(10,12,'Fixture subtitle');
    track.addCue(cue);
    window.subtitleSyncCue=cue;
  });
  // Buttons continue beyond the fine-control ±10s slider, up to ±60s.
  await plus.evaluate(button => {for(let n=0;n<1200;n++) button.click();});
  await expect(page.locator('.sync-offset-value')).toHaveText('+60.0s');
  await expect(slider).toHaveValue('10000');
  await expect.poll(() => page.evaluate(() => window.subtitleSyncCue.startTime)).toBe(70);
  await slider.evaluate(input => {
    input.value='-10000';
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await minus.evaluate(button => {for(let n=0;n<1000;n++) button.click();});
  await expect(page.locator('.sync-offset-value')).toHaveText('-60.0s');
  await expect.poll(() => page.evaluate(() => window.subtitleSyncCue.startTime)).toBe(-50);
  await page.getByRole('button',{name:'Reset subtitle sync'}).click();
  await expect(page.locator('.sync-offset-value')).toHaveText('+0ms');
  await expect.poll(() => page.evaluate(() => window.subtitleSyncCue.startTime)).toBe(10);
});

test('subtitle sync holding +/- accelerates with Plezy long-press stride', async ({page}) => {
  await setupWithLocalSrt(page);
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.getByRole('button',{name:'Subtitle sync',exact:true}).click();
  await page.getByRole('button',{name:'Increase subtitle delay'}).focus();
  await page.keyboard.down('Enter');
  await page.waitForTimeout(900);
  await page.keyboard.up('Enter');
  const result=Number(await page.getByRole('slider',{name:'Subtitle sync offset'}).inputValue());
  expect(result).toBeGreaterThanOrEqual(2050);
  expect(result).toBeLessThanOrEqual(6050);
  const heldValue=await page.locator('.sync-offset-value').textContent();
  await page.waitForTimeout(500);
  await expect(page.locator('.sync-offset-value')).toHaveText(heldValue);
});


test('stopping playback cancels an active subtitle-sync long press', async ({page}) => {
  await setupWithLocalSrt(page);
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.getByRole('button',{name:'Subtitle sync',exact:true}).click();
  await page.getByRole('button',{name:'Increase subtitle delay'}).focus();
  await page.keyboard.down('Enter');
  await page.waitForTimeout(650);
  await page.locator('#player video').evaluate(video => video.dispatchEvent(new Event('ended')));
  await expect(page.locator('#player')).toBeHidden();
  const storedOffset=() => page.evaluate(() => Object.keys(localStorage)
    .filter(key=>key.startsWith('plezy.webos.subtitleSync.'))
    .map(key=>({key,value:localStorage.getItem(key)})));
  const stored=await storedOffset();
  expect(stored).toHaveLength(1);
  expect(Number(stored[0].value)).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(await storedOffset()).toEqual(stored);
  await page.keyboard.up('Enter');
});


test('all seek entry points recover a decoder pause without another remote Play',async({page})=>{
  await setup(page,{Chapter:[{title:'First',startTimeOffset:0},
    {title:'Second',startTimeOffset:45000}]});
  await page.locator('video').evaluate(video=>{
    const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
    Object.defineProperty(video,'currentTime',{configurable:true,
      get(){return descriptor.get.call(video);},
      set(value){video.pause();descriptor.set.call(video,value);}
    });
  });
  await page.getByRole('button',{name:'Next chapter',exact:true}).click();
  await expect.poll(()=>page.locator('video').evaluate(video=>video.paused)).toBe(false);
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(44);
  await page.locator('[data-action="seek"]').evaluate(slider=>{
    slider.value='20';slider.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await expect.poll(()=>page.locator('video').evaluate(video=>video.paused)).toBe(false);
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(19);
});

test('confirmed seek wakes an unpaused LG decoder with stale time and seeking=true',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.locator('video').evaluate(video=>{
    const before=video.currentTime;
    let queued=before;
    const nativePlay=video.play.bind(video);
    window.unpausedSeekPlayCalls=0;
    Object.defineProperty(video,'currentTime',{configurable:true,
      get(){return before;},set(value){queued=value;}});
    Object.defineProperty(video,'seeking',{configurable:true,get(){return true;}});
    video.play=()=>{
      window.unpausedSeekPlayCalls++;
      delete video.currentTime;delete video.seeking;
      video.currentTime=queued;
      return nativePlay();
    };
  });
  await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.unpausedSeekPlayCalls)).toBeGreaterThan(0);
  await expect(page.locator('.controls')).toBeHidden();
});

test('explicit Pause during preview is not overridden by confirming or cancelling it',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{keyCode:19,bubbles:true})));
  await expect(page.locator('video')).toHaveJSProperty('paused',true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1100);
  await expect(page.locator('video')).toHaveJSProperty('paused',true);
});

test('SRT uses the latest sync adjustment after a delayed subtitle download',async({page})=>{
  let finishDownload;
  const download=new Promise(resolve=>{finishDownload=resolve;});
  await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:3,id:31,codec:'srt',key:'/subtitles.srt',selected:1}
    ]}]}]},undefined,[],{},null,null,async()=>{
      await download;
      return '1\n00:00:00,000 --> 00:00:01,000\nFIRST CUE\n\n2\n00:00:10,000 --> 00:00:11,000\nOFFSET CUE\n';
    });
  await page.locator('[data-action="pause"]').click();
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.getByRole('button',{name:'Subtitle sync',exact:true}).click();
  await page.locator('.sync-offset-slider').evaluate(input=>{
    input.value='2000';input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await page.locator('video').evaluate(video=>{video.currentTime=10.5;});
  finishDownload();
  await expect(page.locator('.player-captions')).not.toContainText('OFFSET CUE');
  await page.locator('video').evaluate(video=>{video.currentTime=12.5;});
  await expect(page.locator('.player-captions')).toContainText('OFFSET CUE');
  await page.locator('video').evaluate(video=>{video.currentTime=0.5;});
  await expect(page.locator('.player-captions')).not.toContainText('FIRST CUE');
});

test('subtitle lift clears the measured controls at different viewport sizes',async({page})=>{
  await setup(page);
  for (const height of [720,1080]) {
    await page.setViewportSize({width:1920,height});
    await page.locator('#player').dispatchEvent('mousemove',{clientX:100,clientY:100});
    const geometry=await page.locator('#player').evaluate(root=>({
      lift:parseFloat(getComputedStyle(root).getPropertyValue('--subtitle-lift')),
      controls:root.querySelector('.controls').offsetHeight
    }));
    expect(geometry.lift).toBe(-geometry.controls);
  }
});

test('track changes while paused keep the selected position and paused state',async({page})=>{
  await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:2,id:11,languageCode:'eng',selected:1,codec:'aac'},
      {streamType:2,id:12,languageCode:'fra',codec:'aac'}
    ]}]}]});
  await page.locator('video').evaluate(video=>{video.currentTime=22;});
  await page.locator('[data-action="pause"]').click();
  await expect(page.locator('video')).toHaveJSProperty('paused',true);
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await page.locator('.player-track-column').getByRole('button',{name:/French/}).click();
  await expect(page.locator('.player-track-column button[aria-pressed="true"]')).toHaveAttribute('data-track-id','12');
  await expect.poll(()=>page.locator('video').evaluate(video=>video.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.locator('video')).toHaveJSProperty('paused',true);
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(21);
});

test('rapid audio and subtitle changes during cleanup retain both choices and resume position',async({page})=>{
  const {calls}=await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:2,id:11,languageCode:'eng',selected:1,codec:'aac'},
      {streamType:2,id:12,languageCode:'fra',codec:'aac'},
      {streamType:3,id:31,languageCode:'eng',codec:'srt'},
      {streamType:3,id:32,languageCode:'spa',codec:'srt'}
    ]}]}]});
  await page.locator('video').evaluate(video=>{video.currentTime=22;});
  await expect.poll(()=>page.locator('video').evaluate(video=>video.seeking)).toBe(false);
  let finishCleanup,cleanupRequested=false;
  const cleanup=new Promise(resolve=>{finishCleanup=resolve;});
  await page.route('http://plex.test/**/timeline**',async route=>{
    if (new URL(route.request().url()).searchParams.get('state')==='stopped') {
      cleanupRequested=true;await cleanup;
    }
    await route.fulfill({json:{}});
  });
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await page.locator('.player-track-column').first().getByRole('button',{name:/French/}).click();
  await expect.poll(()=>cleanupRequested).toBe(true);
  await page.locator('.player-track-column').last().getByRole('button',{name:/Spanish/}).click();
  finishCleanup();
  await expect.poll(()=>calls.some(url=>url.pathname==='/library/parts/part' &&
    url.searchParams.get('audioStreamID')==='12' &&
    url.searchParams.get('subtitleStreamID')==='32')).toBe(true);
  await expect.poll(()=>page.locator('video').evaluate(video=>video.currentTime)).toBeGreaterThanOrEqual(21);
  await expect(page.locator('.player-track-column').first().getByRole('button',{name:/French/}))
    .toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.player-track-column').last().getByRole('button',{name:/Spanish/}))
    .toHaveAttribute('aria-pressed','true');
});

test('pointer hover cannot replace the displayed D-pad seek target',async({page})=>{
  await setup(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  const slider=page.locator('[data-action="seek"]');
  const expected=Number(await slider.inputValue());
  await slider.evaluate(input=>{
    const bounds=input.getBoundingClientRect();
    input.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,
      clientX:bounds.left+1,clientY:bounds.top+1}));
  });
  await expect(slider).toHaveValue(String(expected));
  await page.locator('video').evaluate(video=>{
    const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
    Object.defineProperty(video,'currentTime',{configurable:true,
      get(){return descriptor.get.call(video);},
      set(value){window.confirmedRemoteSeek=value;descriptor.set.call(video,value);}
    });
  });
  await page.keyboard.press('Enter');
  expect(Math.abs(await page.evaluate(()=>window.confirmedRemoteSeek)-expected)).toBeLessThanOrEqual(1);
});

test('metadata-only native open with an unresolved Play promise falls back and plays HLS',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>{
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){
      if(this.src.includes('/video.webm')) return new Promise(()=>{});
      return play.call(this);
    };
  });
  const {calls}=await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:3,id:31,codec:'srt',key:'/library/streams/31.srt',selected:1}
    ]}]}]},undefined,[],{},null,null,async()=>
    '1\n00:00:10,000 --> 00:00:11,000\nSubtitle fixture\n',false);
  await expect.poll(()=>page.locator('#player video').evaluate(v=>v.readyState)).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#player video')).toHaveJSProperty('currentTime',0);
  await page.clock.fastForward(31000);
  await expect.poll(()=>calls.some(u=>u.pathname.endsWith('/start.m3u8'))).toBe(true);
  await expect.poll(()=>page.locator('#player video').evaluate(v=>v.paused)).toBe(false);
  await expect.poll(()=>page.locator('#player video').evaluate(v=>v.currentTime)).toBeGreaterThan(.25);
  await expect(page.locator('.player-status')).toBeEmpty();
});
test('failed replacement HLS reports an error while the original Play promise stays unresolved',async({page})=>{
  await page.addInitScript(()=>{
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){
      if(this.src.includes('/video.webm')) return new Promise(()=>{});
      return play.call(this);
    };
  });
  const {calls}=await setup(page,{},undefined,[],{},null,null,null,false);
  let fallbackOpens=0;
  await page.route('http://plex.test/video/:/transcode/universal/start.m3u8**',
    route=>{fallbackOpens++;return route.fulfill({status:500,body:'decoder failure'});});
  await expect(page.locator('#player video')).toHaveAttribute('src',/video.webm/);
  await page.locator('#player video').evaluate(v=>v.dispatchEvent(new Event('error')));
  await expect(page.locator('.player-status')).toContainText('Video could not play');
  expect(fallbackOpens).toBe(1);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(page.locator('#player')).toBeHidden();
});

test('the sync slider retimes rendered SRT on Chromium 53 without a seek or burn-in fallback',async({page})=>{
  await page.addInitScript(()=>{
    Object.values=undefined; Object.entries=undefined; window.ResizeObserver=undefined;
  });
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const {calls}=await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:3,id:31,codec:'srt',key:'/library/streams/31',selected:1}
    ]}]}]},undefined,[],{},null,null,async url=>{
      // A real Plex key has no suffix. Reject the old unsuffixed request.
      if(url.pathname!=='/library/streams/31.srt') return '<html>Not Found</html>';
      return '1\n00:00:10,000 --> 00:00:11,000\n<i>OFFSET CUE</i>\n';
    });
  await page.locator('[data-action="pause"]').click();
  await page.locator('video').evaluate(video=>{video.currentTime=10.025;});
  const captions=page.locator('.player-captions');
  await expect(captions).toContainText('OFFSET CUE');
  await expect(captions.locator('canvas.plezy-pixi-subtitles')).toBeVisible();
  expect(await page.evaluate(()=>window.PIXI?.VERSION)).toBe('4.8.9');
  expect(calls.some(url=>url.pathname==='/library/streams/31.srt' &&
    url.searchParams.get('encoding')==='utf-8')).toBe(true);
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.getByRole('button',{name:'Subtitle sync',exact:true}).click();
  const slider=page.getByRole('slider',{name:'Subtitle sync offset'});
  // Up/Down must immediately change actual displayed cues at a fixed clock.
  await page.keyboard.press('ArrowUp');
  await expect(slider).toHaveValue('50');
  await expect(captions).not.toContainText('OFFSET CUE');
  await page.keyboard.press('ArrowDown');
  await expect(captions).toContainText('OFFSET CUE');
  await slider.evaluate(input=>{
    input.value='2000';input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await expect(captions).not.toContainText('OFFSET CUE');
  await page.getByRole('button',{name:'Reset subtitle sync'}).click();
  await expect(captions).toContainText('OFFSET CUE');
  await slider.evaluate(input=>{
    input.value='-2000';input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await expect(captions).not.toContainText('OFFSET CUE');
  await page.locator('video').evaluate(video=>{video.currentTime=8.5;});
  await expect(captions).toContainText('OFFSET CUE');
  expect(calls.filter(url=>url.pathname.endsWith('/start.m3u8'))).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('embedded SRT uses the selected track and changes visible cues while clean HLS plays',async({page})=>{
  let finishDownload;
  const download=new Promise(resolve=>{finishDownload=resolve;});
  const {calls}=await setup(page,{Media:[{container:'mkv',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:3,id:31,codec:'ass'},
      {streamType:3,id:32,codec:'srt',selected:1}
    ]}]}]},undefined,[],{},null,null,async url=>{
      await download;
      if(url.pathname!==plexSubtitlePath || url.searchParams.get('subtitles')!=='sidecar' ||
          url.searchParams.get('subtitleStreamID')!=='32') return '<html>Not Found</html>';
      // Plex's Web profile offers ASS as a transport even for a source SRT.
      return '[Script Info]\nScriptType: v4.00+\n'+
        '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'+
        'Dialogue: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,SELECTED SRT\n';
    });
  const starts=()=>calls.filter(url=>url.pathname.endsWith('/start.m3u8'));
  expect(starts()[0].searchParams.get('subtitles')).toBe('none');
  await page.locator('[data-action="pause"]').click();
  await page.locator('video').evaluate(video=>{
    video.currentTime=10.5;
    video.addTextTrack('subtitles','Decoder duplicate','en').mode='showing';
  });
  finishDownload();
  const captions=page.locator('.player-captions');
  await expect(captions).toContainText('SELECTED SRT');
  await expect.poll(()=>page.locator('video').evaluate(video=>video.textTracks[0].mode)).toBe('disabled');
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.getByRole('button',{name:'Subtitle sync',exact:true}).click();
  await page.getByRole('slider',{name:'Subtitle sync offset'}).evaluate(input=>{
    input.value='2000';input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await expect(captions).not.toContainText('SELECTED SRT');
  await page.getByRole('button',{name:'Reset subtitle sync'}).click();
  await expect(captions).toContainText('SELECTED SRT');
  expect(starts().every(url=>url.searchParams.get('subtitles')==='none')).toBe(true);
});

test('SRT playback applies saved Plezy text and border styling, including letterbox margin fallback',async({page},testInfo)=>{
  // LG's hardware decoder often reports zero dimensions despite presenting
  // a wide video. Aspect ratio from Plex must still constrain the overlay.
  await page.addInitScript(()=>{
    for(const property of ['videoWidth','videoHeight'])
      Object.defineProperty(HTMLVideoElement.prototype,property,{get:()=>0});
  });
  await setup(page,{Media:[{aspectRatio:2.4,container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:3,id:31,codec:'srt',key:'/subtitles.srt',selected:1}
    ]}]}]},undefined,[],{
    subtitleFontSize:40,subtitleTextColor:'#AA3311',subtitleBorderSize:2,
    subtitleBorderColor:'#00FF00',subtitlePosition:50,
    subtitleUseMargins:false,subtitleBold:true,subtitleItalic:true
  },null,null,async()=>'1\n00:00:10,000 --> 00:00:11,000\nSTYLE CUE WAVY V\nSECOND LINE\n');
  await page.locator('video').evaluate(video=>{video.pause();video.currentTime=10.5;});
  const captions=page.locator('.player-captions');
  await expect(captions).toContainText('STYLE CUE');
  await page.screenshot({path:testInfo.outputPath('srt-pixi-border.png')});
  await expect(captions.locator('canvas.plezy-pixi-subtitles')).toBeVisible();
  const style=await captions.evaluate(node=>{
    const canvas=node.querySelector('canvas.plezy-pixi-subtitles');
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let red=0,green=0,minY=canvas.height,maxY=0,minX=canvas.width,maxX=0;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
      const i=(y*canvas.width+x)*4;
      if(pixels[i]>100&&pixels[i+1]<100&&pixels[i+2]<70){red++;}
      if(pixels[i+1]>130&&pixels[i]<100&&pixels[i+2]<100){green++;}
      if(pixels[i+3]){minY=Math.min(y,minY);maxY=Math.max(y,maxY);minX=Math.min(x,minX);maxX=Math.max(x,maxX);}
    }
    return {fontSize:node.style.fontSize,weight:node.style.fontWeight,italic:node.style.fontStyle,
      top:parseFloat(node.style.top),width:canvas.width,height:canvas.height,
      cueTopFraction:minY/canvas.height,bottomFraction:maxY/canvas.height,
      leftFraction:minX/canvas.width,rightFraction:maxX/canvas.width,red,green};
  });
  expect(parseFloat(style.fontSize)).toBeGreaterThan(40);
  expect(style.weight).toBe('700');
  expect(style.italic).toBe('italic');
  expect(style.top).toBeGreaterThan(12);
  expect(style.cueTopFraction).toBeGreaterThan(0.35);
  expect(style.cueTopFraction).toBeLessThan(0.65);
  expect(style.red).toBeGreaterThan(200);
  expect(style.green).toBeGreaterThan(100);
  // The complete glyph and its outline must stay inside the texture; no
  // asymmetrically cut-off or excessively extended left-hand border.
  expect(style.leftFraction).toBeGreaterThan(0.1);
  expect(style.rightFraction).toBeLessThan(0.9);
  expect(style.bottomFraction).toBeLessThan(0.8);
  await page.locator('[data-action="stop"]').click();
  await expect(page.locator('canvas.plezy-pixi-subtitles')).toHaveCount(0);
});

test('Pixi SRT black border and white glyphs render opaque sharp pixels without a subtitle box',async({page},testInfo)=>{
  await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[
      {streamType:3,id:31,codec:'srt',key:'/subtitles.srt',selected:1}
    ]}]}]},undefined,[],{
    subtitleFontSize:44,subtitleBorderSize:4,subtitleBorderColor:'#000000',subtitleTextColor:'#FFFFFF',
    subtitlePosition:100,subtitleBold:false,subtitleItalic:false
  },null,null,async()=>'1\n00:00:10,000 --> 00:00:11,000\nWAVY VISION\n');
  await page.locator('video').evaluate(video=>{video.pause();video.currentTime=10.5;});
  await expect(page.locator('.player-captions')).toContainText('WAVY VISION');
  const counts=await page.locator('canvas.plezy-pixi-subtitles').evaluate(canvas=>{
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let black=0,white=0,transparent=0,partial=0;
    for(let i=0;i<pixels.length;i+=4){
      const alpha=pixels[i+3];
      if(alpha===0){transparent++;continue;}
      if(alpha<255){partial++;continue;}
      if(pixels[i]<25&&pixels[i+1]<25&&pixels[i+2]<25)black++;
      if(pixels[i]>230&&pixels[i+1]>230&&pixels[i+2]>230)white++;
    }
    return {black,white,transparent,partial};
  });
  expect(counts.black).toBeGreaterThan(1000);
  expect(counts.white).toBeGreaterThan(1000);
  expect(counts.partial).toBeGreaterThan(100);
  expect(counts.transparent).toBeGreaterThan(500000,'background must be fully transparent');
  await page.locator('#player').evaluate(player=>{
    player.style.backgroundColor='#777777';
    player.querySelector('video').style.opacity='0';
  });
  await page.screenshot({path:testInfo.outputPath('srt-pixi-black-border.png')});
});

test('Plex extraction failure silently falls back once and disables burned-in subtitle sync',async({page})=>{
  const {calls}=await setup(page,{Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'part',key:'/video.webm',Stream:[{streamType:3,id:32,codec:'srt',selected:1}]}]}]},
    undefined,[],{},null,null,async()=>'<html>Server cannot extract this track</html>');
  const burned=()=>calls.filter(url=>url.pathname.endsWith('/start.m3u8') && url.searchParams.get('subtitles')==='burn');
  await expect.poll(()=>burned().length).toBe(1);
  await expect(page.locator('#toast')).not.toBeVisible();
  await page.getByRole('button',{name:'Playback settings'}).click();
  await expect(page.locator('.player-settings-sync-value')).toHaveText('Burned in');
  const sync=page.getByRole('button',{name:'Subtitle sync',exact:true});
  await expect(sync).toHaveAttribute('aria-disabled','true');
  await expect(sync).toHaveClass(/is-disabled/);
  await expect(sync).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toHaveText('Cannot offset burned-in subtitles');
  await expect(page.getByRole('slider',{name:'Subtitle sync offset'})).toHaveCount(0);
  expect(burned()).toHaveLength(1);
});

test('failed MKV byte ranges and Plex extraction silently retry HLS with burned subtitles',async({page})=>{
  const {calls}=await setup(page,{Media:[{container:'mkv',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'embedded',key:'/library/parts/embedded/file.mkv',Stream:[
      {streamType:3,id:32,codec:'srt',index:2,selected:1}
    ]}]}]},undefined,[],{},null,null,null,true,{beforeRead:()=>416});
  const starts=()=>calls.filter(url=>url.pathname.endsWith('/start.m3u8'));
  await expect.poll(()=>starts().length).toBe(2);
  expect(starts().map(url=>url.searchParams.get('subtitles'))).toEqual(['none','burn']);
  expect(starts()[1].searchParams.get('subtitleStreamID')).toBe(null);
  const selected=()=>calls.findIndex(url=>url.pathname==='/library/parts/embedded' &&
    url.searchParams.get('subtitleStreamID')==='32');
  const burnedStart=()=>calls.findIndex(url=>url.pathname.endsWith('/start.m3u8') &&
    url.searchParams.get('subtitles')==='burn');
  expect(selected()).toBeGreaterThanOrEqual(0);
  expect(selected()).toBeLessThan(burnedStart(), 'Plex must select the MKV track before asking it to burn');
  expect(calls.some(url=>url.pathname==='/video/:/transcode/universal/decision' &&
    url.searchParams.get('subtitles')==='burn')).toBe(false,'compatibility burn-in needs no separate decision');
  expect(calls.some(url=>url.pathname===plexSubtitlePath)).toBe(true);
  expect(calls.some(url=>url.pathname==='/library/parts/embedded/file.mkv')).toBe(true);
  await expect(page.locator('#toast')).not.toBeVisible();
  await page.getByRole('button',{name:'Playback settings'}).click();
  const sync=page.getByRole('button',{name:'Subtitle sync',exact:true});
  await expect(sync).toHaveAttribute('aria-disabled','true');
  await expect(page.locator('.player-settings-sync-value')).toHaveText('Burned in');
  await expect(sync).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toHaveText('Cannot offset burned-in subtitles');
  expect(starts()).toHaveLength(2);
});

test('embedded MKV SRT sync works when the decoder omits dimensions and Plex extraction is unavailable',async({page})=>{
  await page.addInitScript(()=>{
    window.WebAssembly=undefined;
    for(const key of ['videoWidth','videoHeight'])
      Object.defineProperty(HTMLVideoElement.prototype,key,{get:()=>0});
    Object.values=undefined;Object.entries=undefined;window.ResizeObserver=undefined;
  });
  const {calls}=await setup(page,{Media:[{aspectRatio:2.4,container:'mkv',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'embedded',key:'/library/parts/embedded/file.mkv',Stream:[
      {streamType:3,id:31,codec:'srt',index:2,selected:1},
      {streamType:3,id:32,codec:'ass',index:3}
    ]}]}]});
  await page.locator('[data-action="pause"]').click();
  await page.locator('video').evaluate(video=>{video.currentTime=2.5;});
  const captions=page.locator('.player-captions');
  await expect(captions).toContainText('Embedded SRT',{timeout:10000});
  await expect(captions.locator('canvas.plezy-pixi-subtitles')).toBeVisible();
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.getByRole('button',{name:'Subtitle sync',exact:true}).click();
  const slider=page.getByRole('slider',{name:'Subtitle sync offset'});
  await slider.evaluate(input=>{
    input.value='3000';input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await expect(captions).not.toContainText('Embedded SRT');
  await page.getByRole('button',{name:'Reset subtitle sync'}).click();
  await expect(captions).toContainText('Embedded SRT');
  expect(calls.some(url=>url.pathname==='/library/parts/embedded/file.mkv')).toBe(true);
  expect(calls.some(url=>url.pathname===plexSubtitlePath)).toBe(false);
  expect(calls.filter(url=>url.pathname.endsWith('/start.m3u8'))
    .map(url=>url.searchParams.get('subtitles'))).toEqual(['none']);
});

for (const enabled of [false,true]) {
  test('embedded SRT diagnostics ' + (enabled ? 'show on the TV when opted in' : 'do not exist when off'),
    async({page})=>{
      await setup(page,{Media:[{container:'mkv',videoCodec:'h264',audioCodec:'aac',
        Part:[{id:'embedded',key:'/library/parts/embedded/file.mkv',Stream:[
          {streamType:3,id:31,codec:'srt',index:2,selected:1}
        ]}]}]},undefined,[],{diagnosticsEnabled:enabled});
      const panel=page.locator('.player-subtitle-diagnostics');
      if (!enabled) await expect(panel).toHaveCount(0);
      await page.locator('[data-action="pause"]').click();
      await page.locator('video').evaluate(video=>{video.currentTime=2.5;});
      await expect(page.locator('.player-captions')).toContainText('Embedded SRT');
      if (!enabled) {
        await expect(panel).toHaveCount(0);
      } else {
        await expect(panel).toContainText(/MKV index: \d+ ms/);
        await expect(panel).toContainText(/Decoder playing: \d+ ms from Play/);
        await expect(panel).toContainText(/First render: \d+ ms from subtitle request/);
        await expect(panel).toContainText(/Ranges: \d+ · network/);
        await expect(panel).toBeVisible();
        await expect(panel).toHaveCSS('pointer-events','none');
      }
    });
}

test('embedded MKV SRT displays the first cue while later cluster reads are blocked', async ({page}) => {
  const fixture = srtFixture(6000);
  let releaseNext;
  const next = new Promise(resolve => { releaseNext = resolve; });
  const {calls} = await setup(page, {Media:[{container:'mkv',videoCodec:'h264',audioCodec:'aac',
    Part:[{id:'embedded',key:'/library/parts/embedded/file.mkv',size:fixture.source.length,Stream:[
      {streamType:3,id:31,codec:'srt',index:0,selected:1}
    ]}]}]}, undefined, [], {}, null, null, null, true, {
    source:fixture.source, beforeRead:start => start === fixture.secondCluster ? next : undefined
  });
  try {
    await page.locator('[data-action="pause"]').click();
    await page.locator('video').evaluate(element => { element.currentTime = 0.5; });
    await expect(page.locator('.player-captions')).toContainText('Subtitle 0', {timeout:5000});
    expect(calls.some(url => url.pathname === plexSubtitlePath)).toBe(false);
  } finally {
    releaseNext();
  }
  await page.locator('video').evaluate(element => { element.currentTime = 6.5; });
  await expect(page.locator('.player-captions')).toContainText('Subtitle 1');
});

const embeddedMkv = {Media:[{container:'mkv',videoCodec:'h264',audioCodec:'aac',
  Part:[{id:'embedded',key:'/library/parts/embedded/file.mkv',Stream:[
    {streamType:3,id:31,codec:'srt',index:2,selected:1}
  ]}]}]};

test('embedded SRT reads start after playing even when LG never reports video-ready dimensions or clock', async ({page}) => {
  await page.addInitScript(() => {
    const original=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
    Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{
      configurable:true,get(){return 0;},set(value){original.set.call(this,value);}
    });
    for (const key of ['videoWidth','videoHeight'])
      Object.defineProperty(HTMLVideoElement.prototype,key,{get:()=>0});
    window.playingSeen=false;
    window.earlyRange=false;
    document.addEventListener('playing',()=>{window.playingSeen=true;},true);
    const fetch=window.fetch;
    window.fetch=(url,options)=>{
      if (options?.headers?.Range && String(url).includes('/file.mkv') && !window.playingSeen)
        window.earlyRange=true;
      return fetch(url,options);
    };
  });
  const {calls}=await setup(page,embeddedMkv,undefined,[],{diagnosticsEnabled:true});
  const panel=page.locator('.player-subtitle-diagnostics');
  await expect(panel).toContainText(/Decoder playing: \d+ ms from Play/);
  await expect(panel).toContainText(/MKV index: \d+ ms from subtitle request/);
  await expect(panel).toContainText(/First render: \d+ ms from subtitle request/);
  await expect(panel).toContainText('Video ready: waiting');
  expect(await page.evaluate(()=>window.earlyRange)).toBe(false);
  expect(calls.some(url=>url.pathname==='/library/parts/embedded/file.mkv')).toBe(true);
});

test('MKV range requests wait for playback and failed extraction silently restarts with burn-in', async ({page}) => {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.rangeStartTimes = [];
    window.fetch = (url, options) => {
      if (options?.headers?.Range && String(url).includes('/file.mkv')) {
        const video = document.querySelector('video');
        window.rangeStartTimes.push(video.currentTime);
      }
      return fetch(url, options);
    };
  });
  const {calls} = await setup(page, embeddedMkv, undefined, [], {}, null, null, null, true,
    {beforeRead:() => 200});
  const startsWith = () => calls.filter(url => url.pathname.endsWith('/start.m3u8'))
    .map(url => url.searchParams.get('subtitles'));
  await expect.poll(startsWith).toEqual(['none','burn']);
  await expect(page.locator('#toast')).not.toBeVisible();
  const starts = await page.evaluate(() => window.rangeStartTimes);
  expect(starts).toHaveLength(1);
  expect(starts[0]).toBeGreaterThan(0.1);
  const video = page.locator('video');
  const position = await video.evaluate(element => element.currentTime);
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(position);
  await page.getByRole('button',{name:'Playback settings'}).click();
  await expect(page.locator('.player-settings-sync-value')).toHaveText('Burned in');
  await expect(page.locator('.player-status')).toBeEmpty();
  expect(startsWith()).toEqual(['none','burn']);
});

test('an HLS decoder error during an MKV range read retries video once using Plex subtitles', async ({page}) => {
  let releaseRange;
  const range = new Promise(resolve => { releaseRange = resolve; });
  const {calls} = await setup(page, embeddedMkv, undefined, [], {}, null, null,
    async () => '1\n00:00:00,000 --> 00:00:12,000\nPLEX SUBTITLE\n', true,
    {beforeRead:() => range});
  const video = page.locator('video');
  const ranges = () => calls.filter(url => url.pathname.endsWith('/file.mkv'));
  const starts = () => calls.filter(url => url.pathname.endsWith('/start.m3u8'));
  try {
    await expect.poll(() => ranges().length).toBe(1);
    await video.evaluate(element => element.dispatchEvent(new Event('error')));
    await expect.poll(() => starts().length).toBe(2);
    await expect(page.locator('.player-captions')).toContainText('PLEX SUBTITLE');
    await expect(page.locator('.player-status')).toBeEmpty();
    expect(starts().map(url => url.searchParams.get('subtitles'))).toEqual(['none', 'none']);
    expect(ranges()).toHaveLength(1);
  } finally {
    releaseRange();
  }
});

test('a stalled decoder retry requests Plex subtitles before video-ready', async ({page}) => {
  let releaseRange;
  const range = new Promise(resolve => { releaseRange = resolve; });
  const {calls} = await setup(page, embeddedMkv, undefined, [], {diagnosticsEnabled:true}, null, null,
    async () => '1\n00:00:00,000 --> 00:00:12,000\nEARLY SIDECAR\n', true,
    {beforeRead:() => range});
  try {
    await expect.poll(() => calls.filter(url => url.pathname.endsWith('/file.mkv')).length).toBe(1);
    await page.locator('video').evaluate(video => {
      // The new decoder has not yet advanced its clock. The sidecar must
      // download anyway; it does not share the expensive MKV range reader.
      Object.defineProperty(video, 'currentTime', {configurable:true,get:() => 0});
      video.dispatchEvent(new Event('error'));
    });
    await expect(page.locator('.player-captions')).toContainText('EARLY SIDECAR', {timeout:5000});
    await expect(page.locator('.player-subtitle-diagnostics'))
      .toContainText('Source: Plex sidecar (decoder retry)');
    await expect(page.locator('.player-subtitle-diagnostics')).toContainText('Video ready: waiting');
  } finally {
    releaseRange();
  }
});

test('diagnostics reveal why the MKV reader used the Plex subtitle endpoint', async ({page}) => {
  await setup(page, embeddedMkv, undefined, [], {diagnosticsEnabled:true}, null, null,
    async () => '1\n00:00:00,000 --> 00:00:12,000\nFALLBACK SRT\n', true,
    {beforeRead:() => 200});
  await expect(page.locator('.player-captions')).toContainText('FALLBACK SRT');
  const panel=page.locator('.player-subtitle-diagnostics');
  await expect(panel).toContainText('Source: Plex sidecar (MKV failed)');
  await expect(panel).toContainText('MKV failed: MKV subtitles: Plex did not serve a byte range (HTTP 200)');
});

test('Stop waits for the final Plex timeline before refreshing mounted and saved Resume', async ({page}) => {
  let savedOffsetMs = 0, detailReads = 0, stopRequested = false, releaseStop;
  const pendingStop = new Promise(resolve => { releaseStop = resolve; });
  await setup(page, {}, undefined, [], {}, async (request, item) => {
    detailReads++;
    return {...item, viewOffset: savedOffsetMs};
  });
  const play = page.locator('#main .detail-play');
  await expect(play).toHaveAttribute('aria-label', 'Play');
  await page.locator('video').evaluate(video => { video.currentTime = 1.151; });
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(1);
  await page.route('http://plex.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/:/timeline') return route.fallback();
    if (url.searchParams.get('state') === 'stopped') {
      stopRequested = true;
      await pendingStop;
      savedOffsetMs = Number(url.searchParams.get('time'));
    }
    return route.fulfill({contentType:'application/xml', body:'<MediaContainer />'});
  });

  const originalDetail = await page.locator('#main .detail').elementHandle();
  const readsBeforeStop = detailReads;
  await page.getByRole('button', {name:'Stop', exact:true}).click();
  await expect(page.locator('#player')).toBeHidden();
  await expect.poll(() => stopRequested).toBe(true);
  expect(detailReads).toBe(readsBeforeStop, 'metadata must not race the final report');
  await expect(play).toHaveAttribute('aria-label', 'Play');
  releaseStop();

  await expect(play).toHaveAttribute('aria-label', /^Resume · /);
  expect(await originalDetail.evaluate(element => element.isConnected)).toBe(true);
  await expect.poll(async () => page.evaluate(() => new Promise(resolve => {
    const open = indexedDB.open('plezy-catalog-v1', 1);
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const rows = open.result.transaction('pages', 'readonly').objectStore('pages').getAll();
      rows.onerror = () => resolve(null);
      rows.onsuccess = () => resolve(rows.result.find(row =>
        row.key.includes(':detail:') && row.data?.item?.id === 'movie')?.data?.item?.resume ?? null);
    };
  }))).toBeGreaterThan(0);
});

test('Back during hidden queued HLS replay leaves Home without opening the old title',async({page})=>{
  await page.addInitScript(()=>{
    window.PalmSystem={};
    window.hlsOpens=[];
    document.addEventListener('error',event=>{
      if(event.isTrusted && (event.target instanceof HTMLSourceElement ||
          event.target instanceof HTMLVideoElement))event.stopImmediatePropagation();
    },true);
    const load=HTMLMediaElement.prototype.load;
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.load=function(){
      const source=this.querySelector('source');
      if(!source?.src.includes('/start.m3u8'))return load.call(this);
      window.hlsOpens.push(source.src);
    };
    HTMLMediaElement.prototype.play=function(){
      if(this.querySelector('source')?.src.includes('/start.m3u8'))return new Promise(()=>{});
      return play.call(this);
    };
  });
  await setup(page,{viewOffset:85000,Media:[{container:'mkv',videoCodec:'hevc',audioCodec:'dts',
    Part:[{id:'part',key:'/video.webm',Stream:[{streamType:3,id:32,codec:'ass',selected:1}]}]}]},
    undefined,[],{},null,null,null,false);
  const opened=()=>page.evaluate(()=>window.hlsOpens.length);
  await expect.poll(opened).toBe(1);
  let stopRequests=0,releaseStop;
  const gate=new Promise(resolve=>{releaseStop=resolve;});
  await page.route('http://plex.test/video/:/transcode/universal/stop**',async route=>{
    stopRequests++;
    await gate;
    return route.fulfill({body:''});
  });
  try {
    await page.getByRole('button',{name:'Stop',exact:true}).click();
    await expect.poll(()=>stopRequests).toBe(1);
    await expect(page.locator('#player')).toBeHidden();
    await page.locator('#main .detail-play').click();
    await expect(page.locator('#player')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#main .detail')).toHaveCount(0);
    releaseStop();
    await page.waitForTimeout(200);
    expect(await opened()).toBe(1);
    await expect(page.locator('#player')).toBeHidden();
    await expect(page.getByRole('button',{name:'Test Movie',exact:true}).first()).toBeVisible();
  } finally {releaseStop();}
});
