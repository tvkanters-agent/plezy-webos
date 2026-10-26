const {test,expect} = require('@playwright/test');
const {readFile} = require('node:fs/promises');
const path = require('node:path');
async function setup(page, extra = {}, version, pendingStops = []) {
  const video = await readFile(path.join(__dirname,'fixtures/test.webm'));
  const calls = [], events = [];
  await page.addInitScript(pendingStops=>localStorage.setItem('plezy.webos',JSON.stringify({deviceId:'device',active:'plex',
    servers:[{id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'fixture'}],
    simkl:{accessToken:'simkl_at_fixture',refreshToken:'simkl_rt_fixture',expiresAt:Date.now()+600000,scope:'media:write',pendingStops}})),pendingStops);
  const item = {ratingKey:'movie',type:'movie',title:'Test Movie',duration:120000,Guid:[{id:'imdb://tt1234567'}],
    Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'part',key:'/video.webm',Stream:[]}]}],...extra};
  await page.route('https://api.simkl.com/**',route=>{
    events.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});
    return route.fulfill({json:{}});
  });
  await page.route('http://plex.test/**',route=>{
    const url = new URL(route.request().url()); calls.push(url);
    if(url.pathname==='/video.webm' || url.pathname.endsWith('/start.m3u8')) {
      const match=/bytes=(\d+)-(\d*)/.exec(route.request().headers().range||'');
      if(match) {const start=+match[1],end=match[2]?+match[2]:video.length-1;
        return route.fulfill({status:206,contentType:'video/webm',headers:{'Content-Range':`bytes ${start}-${end}/${video.length}`,'Accept-Ranges':'bytes'},body:video.subarray(start,end+1)});}
      return route.fulfill({contentType:'video/webm',body:video});
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
  const {events}=await setup(page);
  // Add a real server audio option to the next metadata-independent restart.
  await page.route('http://plex.test/library/parts/part**',route=>route.fulfill({status:500}));
  // The default selector is enough to exercise the track PUT before opening HLS.
  await page.getByRole('button',{name:'Playback settings'}).click();
  await page.getByRole('button',{name:'Subtitles',exact:true}).click();
  await page.getByRole('button',{name:'Subtitles off',exact:true}).click();
  await expect(page.locator('.player-status')).toContainText('HTTP 500');
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
  await expect(page.locator('.player-buttons .transport-icon')).toHaveCount(4);
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
  const audio=page.getByRole('button',{name:'Audio tracks'}).locator('svg');
  await expect(audio.locator('path[fill="currentColor"]')).toHaveCount(1);
  await expect(audio.locator('path[fill="none"][stroke="currentColor"]')).toHaveCount(1);
  const settings=page.getByRole('button',{name:'Playback settings'}).locator('svg');
  await expect(settings.locator('circle')).toHaveCount(3);
  const bounds=await settings.locator('circle').evaluateAll(nodes=>nodes.map(n=>n.getBBox().width));
  expect(new Set(bounds).size).toBe(1);
});

test('transport icons use vector graphics and expose accessible button labels',async({page})=>{
  await setup(page);
  const buttons=page.locator('.player-buttons .transport-icon');
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

test('audio, subtitle and chapter buttons open focused choice sheets',async({page})=>{
  await setup(page,{Chapter:[{title:'Beginning',startTimeOffset:0},{title:'Later',startTimeOffset:45000}]});
  await page.getByRole('button',{name:'Audio tracks'}).click();
  await expect(page.locator('[data-sheet-title]')).toHaveText('Audio tracks');
  await expect(page.getByRole('button',{name:'Default audio'})).toBeVisible();
  await page.getByRole('button',{name:'Close playback settings'}).click();
  await page.getByRole('button',{name:'Chapters',exact:true}).click();
  await expect(page.getByRole('button',{name:/Later/})).toBeVisible();
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
  await page.locator('video').dispatchEvent('waiting');
  await expect(spinner).toBeVisible();
  await expect(page.locator('.player-status')).toBeHidden();
  await page.locator('video').dispatchEvent('playing');
  await expect(spinner).toBeHidden();
  await expect(page.locator('#player')).toBeVisible();
});
