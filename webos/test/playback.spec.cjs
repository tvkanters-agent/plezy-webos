const {test,expect} = require('@playwright/test');
const {readFile} = require('node:fs/promises');
const path = require('node:path');
async function setup(page, extra = {}, version) {
  const video = await readFile(path.join(__dirname,'fixtures/test.webm'));
  const calls = [], events = [];
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({deviceId:'device',active:'plex',
    servers:[{id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'fixture'}],
    simkl:{accessToken:'simkl_at_fixture',refreshToken:'simkl_rt_fixture',expiresAt:Date.now()+600000,scope:'media:write'}})));
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
  await page.getByRole('button',{name:'Compatible playback',exact:true}).last().click();
  await expect.poll(()=>!!release).toBe(true);
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
  await page.getByLabel('Subtitle track').selectOption('-1');
  await expect(page.locator('.player-status')).toContainText('HTTP 500');
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
  await page.getByRole('button',{name:'Servers & settings',exact:true}).click();succeed=true;
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
 await page.getByLabel('Chapter',{exact:true}).selectOption('45');
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
 await page.getByRole('button',{name:'Compatible playback',exact:true}).last().click();
 await expect.poll(()=>calls.some(u=>u.pathname.endsWith('/start.m3u8') && u.searchParams.get('mediaIndex')==='1')).toBe(true);
 await expect.poll(()=>page.locator('video').evaluate(v=>v.paused)).toBe(false);
 await page.getByRole('button',{name:'Stop',exact:true}).click();
 await expect(page.getByLabel('Media version',{exact:true})).toHaveValue('1');
});

test('player chrome has upstream-style compact transport controls and timeline',async({page})=>{
  await setup(page);
  await expect(page.locator('.timeline-row progress')).toBeVisible();
  await expect(page.locator('.transport-icon')).toHaveCount(4);
  await expect(page.getByRole('button',{name:'−10 seconds',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'+30 seconds',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Stop',exact:true})).toBeVisible();
  const metrics=await page.locator('[data-action="pause"]').evaluate(x=>({
    width:x.getBoundingClientRect().width,height:x.getBoundingClientRect().height}));
  expect(metrics.width).toBeLessThanOrEqual(52);
  expect(metrics.height).toBeLessThanOrEqual(52);
});
