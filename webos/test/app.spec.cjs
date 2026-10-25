const {test,expect} = require('@playwright/test');
const item={Id:'movie',Name:'The Test Film',Type:'Movie',Overview:'A test library title.',RunTimeTicks:1200000000,ImageTags:{Primary:'poster'},UserData:{PlaybackPositionTicks:200000000}};
async function serveVideo(route, movie) {
  const range = route.request().headers()['range'];
  const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
  if (match) {
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : movie.length - 1;
    await route.fulfill({status:206,contentType:'video/webm',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${movie.length}`},body:movie.subarray(start,end+1)});
  } else await route.fulfill({contentType:'video/webm',headers:{'Accept-Ranges':'bytes'},body:movie});
}
async function mockServer(page,{saved=true,failed=false}={}){
  const calls=[];
  if(saved)await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({deviceId:'device',active:'server',quality:'auto',servers:[{id:'server',kind:'jellyfin',name:'Test cinema',url:'http://media.test',token:'test-token',userId:'user'}]})));
  await page.route('http://media.test/**',async route=>{
    const request=route.request(),url=new URL(request.url());calls.push({path:url.pathname,method:request.method(),body:request.postDataJSON()});
    if(url.pathname.includes('/Images/')){await route.fulfill({status:404});return;}
    if(failed){await route.fulfill({status:401,json:{}});return;}
    let data={};
    if(url.pathname==='/System/Info/Public')data={Id:'server',ServerName:'Cinema'};
    else if(url.pathname==='/Users/AuthenticateByName')data={AccessToken:'test-token',User:{Id:'user',Name:'Viewer'}};
    else if(url.pathname.endsWith('/Items/Resume'))data={Items:[item]};
    else if(url.pathname.endsWith('/Items/Latest'))data=[item];
    else if(url.pathname==='/Shows/NextUp')data={Items:[]};
    else if(url.pathname.endsWith('/Views'))data={Items:[{Id:'movies',Name:'Movies',CollectionType:'movies'}]};
    else if(url.pathname.endsWith('/Items/movie'))data=item;
    else if(url.pathname.endsWith('/Items'))data={Items:[item],TotalRecordCount:1};
    else if(url.pathname.endsWith('/PlaybackInfo'))data={PlaySessionId:'session',MediaSources:[{Id:'source',SupportsDirectPlay:true,MediaStreams:[]}]};
    else if(url.pathname.includes('/Videos/')){await route.abort();return;}
    await route.fulfill({json:data});
  });return calls;
}
test('welcome and remote-only navigation into sign-in',async({page},testInfo)=>{
  await page.goto('/');await expect(page.getByRole('heading',{name:'Welcome to Plezy'})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('welcome.png')});
  await expect(page.getByRole('button',{name:'Sign in with Plex',exact:true})).toBeFocused();
  await page.keyboard.press('ArrowRight');await expect(page.getByRole('button',{name:'Add Jellyfin',exact:true})).toBeFocused();
  await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'Connect Jellyfin'})).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('heading',{name:'Welcome to Plezy'})).toBeVisible();
});
test('sign-in saves token but clears password',async({page})=>{
  await mockServer(page,{saved:false});await page.goto('/');await page.getByRole('button',{name:'Add Jellyfin',exact:true}).click();
  await page.getByLabel('Server URL').fill('http://media.test');await page.getByLabel('Username',{exact:true}).fill('Viewer');await page.getByLabel('Password',{exact:true}).fill('never-save-me');
  await page.getByRole('button',{name:'Connect',exact:true}).click();await expect(page.getByRole('heading',{name:'Your next watch'})).toBeVisible();
  const saved=await page.evaluate(()=>localStorage.getItem('plezy.webos'));expect(saved).not.toContain('never-save-me');expect(saved).toContain('test-token');
});
test('libraries, details, watch-state and back restore focus',async({page})=>{
  const calls=await mockServer(page);await page.goto('/');await page.getByRole('button',{name:'Libraries',exact:true}).click();
  await page.getByRole('button',{name:'Movies',exact:true}).click();await page.getByRole('button',{name:'The Test Film',exact:true}).click();
  await expect(page.getByRole('heading',{name:'The Test Film'})).toBeVisible();
  await page.getByRole('button',{name:'Mark watched',exact:true}).click();await expect.poll(()=>calls.some(x=>x.path==='/Users/user/PlayedItems/movie'&&x.method==='POST')).toBe(true);
  await page.keyboard.press('Escape');await expect(page.getByRole('heading',{name:'Movies',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'The Test Film',exact:true})).toBeFocused();
});
test('search renders results and focuses the first match',async({page})=>{
  await mockServer(page);await page.goto('/');await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('film');
  await page.locator('form').getByRole('button',{name:'Search',exact:true}).click();await expect(page.getByRole('heading',{name:'1 results'})).toBeVisible();
  await expect(page.getByRole('button',{name:'The Test Film',exact:true})).toBeFocused();
});
test('expired credentials leave a reachable settings action',async({page})=>{
  await mockServer(page,{failed:true});await page.goto('/');await expect(page.getByText(/Sign-in was rejected/)).toBeVisible();
  await page.locator('main').getByRole('button',{name:'Servers & settings',exact:true}).click();await expect(page.getByRole('button',{name:'Remove from this TV'})).toBeVisible();
});
test('removing a server removes its token',async({page})=>{
  await mockServer(page);await page.goto('/');await page.getByRole('button',{name:'Servers & settings',exact:true}).click();await page.getByRole('button',{name:'Remove from this TV'}).click();
  expect(await page.evaluate(()=>localStorage.getItem('plezy.webos'))).not.toContain('test-token');
});
test('Back 461 opens an exit confirmation and traps navigation inside it',async({page})=>{
  await page.goto('/');await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{keyCode:461,bubbles:true})));
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('button',{name:'Keep watching'})).toBeFocused();
  await page.keyboard.press('ArrowRight');await expect(page.getByRole('button',{name:'Exit',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeHidden();
});
test('cancelling Plex linking prevents subsequent polling',async({page})=>{
  let polls=0;await page.route('https://plex.tv/**',async route=>{
    if(new URL(route.request().url()).pathname==='/api/v2/pins')await route.fulfill({json:{id:1,code:'ABCD',expiresIn:300}});
    else {polls++;await route.fulfill({json:{}});}
  });await page.goto('/');await page.getByRole('button',{name:'Sign in with Plex',exact:true}).click();await expect(page.getByText('ABCD',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForTimeout(2800);expect(polls).toBe(0);
});
test('stop during playback negotiation cleans the late session without reopening the player',async({page})=>{
  const calls=await mockServer(page);let reply;
  await page.route('http://media.test/Items/movie/PlaybackInfo**',async route=>{await new Promise(resolve=>{reply=resolve;});await route.fulfill({json:{PlaySessionId:'late',MediaSources:[{Id:'source',SupportsDirectPlay:false,TranscodingUrl:'/Videos/movie/master.m3u8'}]}});});
  await page.goto('/');await page.getByRole('button',{name:'The Test Film',exact:true}).first().click();await page.getByRole('button',{name:'Play from beginning',exact:true}).click();
  await expect(page.locator('#player')).toBeVisible();await expect.poll(()=>!!reply).toBe(true);await page.keyboard.press('Escape');reply();
  await expect(page.locator('#player')).toBeHidden();await expect.poll(()=>calls.some(x=>x.path==='/Videos/ActiveEncodings'&&x.method==='DELETE')).toBe(true);
});
test('no uncaught exceptions during normal browsing',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await mockServer(page);await page.goto('/');await page.getByRole('button',{name:'The Test Film',exact:true}).first().click();
  await expect(page.getByRole('button',{name:'Resume · 0:20'})).toBeVisible();expect(errors).toEqual([]);
});
test('real HTML video resumes, seeks, pauses and reports stop',async({page})=>{
  const {readFile}=await import('node:fs/promises');const movie=await readFile(require('node:path').join(__dirname,'fixtures/test.webm'));
  const calls=await mockServer(page);
  await page.route('http://media.test/Videos/movie/stream**',route=>serveVideo(route,movie));
  await page.goto('/');await page.getByRole('button',{name:'The Test Film',exact:true}).first().click();await page.getByRole('button',{name:'Resume · 0:20'}).click();
  await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThanOrEqual(20);
  await expect.poll(()=>page.locator('video').evaluate(v=>v.paused)).toBe(false);
  await page.getByRole('button',{name:'Pause',exact:true}).click();await expect.poll(()=>page.locator('video').evaluate(v=>v.paused)).toBe(true);
  await page.getByRole('button',{name:'+30 seconds',exact:true}).click();await expect.poll(()=>page.locator('video').evaluate(v=>v.currentTime)).toBeGreaterThanOrEqual(50);
  await page.getByRole('button',{name:'Stop',exact:true}).click();await expect(page.locator('#player')).toBeHidden();
  await expect.poll(()=>calls.some(c=>c.path==='/Sessions/Playing/Stopped'&&c.body.PositionTicks>=500000000)).toBe(true);
  expect(await page.locator('video').getAttribute('src')).toBe(null);
});
test('backgrounding the app pauses video',async({page})=>{
  const {readFile}=await import('node:fs/promises');const movie=await readFile(require('node:path').join(__dirname,'fixtures/test.webm'));
  await mockServer(page);await page.route('http://media.test/Videos/movie/stream**',route=>serveVideo(route,movie));
  await page.goto('/');await page.getByRole('button',{name:'The Test Film',exact:true}).first().click();await page.getByRole('button',{name:'Play from beginning'}).click();
  await expect.poll(()=>page.locator('video').evaluate(v=>v.paused)).toBe(false);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>page.locator('video').evaluate(v=>v.paused)).toBe(true);
});
