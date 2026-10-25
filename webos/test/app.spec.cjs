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
    const request=route.request(),url=new URL(request.url());calls.push({path:url.pathname,query:url.search,method:request.method(),body:request.postDataJSON()});
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

test('library sort controls request server-side ordering and preserve selection',async({page})=>{
  const calls=await mockServer(page);await page.goto('/');
  await page.getByRole('button',{name:'Libraries',exact:true}).click();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await page.getByRole('button',{name:'Recently added',exact:true}).click();
  await expect(page.getByRole('button',{name:'Recently added'})).toHaveAttribute('aria-pressed','true');
  await expect.poll(()=>calls.some(call=>call.path==='/Users/user/Items'&&
    new URLSearchParams(call.query).get('SortBy')==='DateCreated')).toBe(true);
  await page.getByRole('button',{name:'The Test Film',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Recently added'})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'The Test Film',exact:true})).toBeFocused();
});

test('startup remains navigable when localStorage access throws',async({page})=>{
  await page.addInitScript(()=>{
    Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new Error('SecurityError');}});
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Welcome to Plezy'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Add Jellyfin',exact:true})).toBeVisible();
});
test('startup remains navigable when Web Crypto is missing',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(window,'crypto',{configurable:true,value:undefined}));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Welcome to Plezy'})).toBeVisible();
});
test('a bundle that loads but never starts produces an actionable boot error',async({page})=>{
  await page.route('**/app.js',route=>route.fulfill({contentType:'text/javascript',body:'// intentionally no app bootstrap'}));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Plezy could not start'})).toBeVisible({timeout:7000});
  await expect(page.getByText(/script did not initialize/)).toBeVisible();
});
test('a broken library query has a visible retry action',async({page})=>{
  await mockServer(page);
  await page.route(/\/Users\/user\/Items\?/,route=>route.fulfill({status:503,json:{}}));
  await page.goto('/');
  await page.getByRole('button',{name:'Libraries',exact:true}).click();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await expect(page.getByText(/Could not load library titles/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry loading'})).toBeVisible();
});

test('unwatched filter and sort can be combined without client-side slicing',async({page})=>{
  const calls=await mockServer(page);await page.goto('/');
  await page.getByRole('button',{name:'Libraries',exact:true}).click();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await page.getByRole('button',{name:'Unwatched',exact:true}).click();
  await page.getByRole('button',{name:'Recently added',exact:true}).click();
  await expect(page.getByRole('button',{name:'Unwatched',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect.poll(()=>calls.some(call=>call.path==='/Users/user/Items'&&
    new URLSearchParams(call.query).get('SortBy')==='DateCreated'&&
    new URLSearchParams(call.query).get('IsPlayed')==='false')).toBe(true);
  await page.getByRole('button',{name:'The Test Film',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Unwatched',exact:true})).toHaveAttribute('aria-pressed','true');
});

test('Plex Next episode navigates to the next episode across seasons',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'device',active:'plex',quality:'auto',
    servers:[{id:'plex',kind:'plex',name:'Plex test',url:'http://plex.test',token:'test-token'}]
  })));
  const ep1={ratingKey:'ep1',title:'Pilot',type:'episode',index:1,parentIndex:1,parentRatingKey:'s1',
    grandparentRatingKey:'show',grandparentTitle:'Test Show',duration:900000};
  const ep2={ratingKey:'ep2',title:'Finale',type:'episode',index:1,parentIndex:2,parentRatingKey:'s2',
    grandparentRatingKey:'show',grandparentTitle:'Test Show',duration:900000};
  await page.route('http://plex.test/**',route=>{
    const path=new URL(route.request().url()).pathname;
    let data={MediaContainer:{}};
    if(path==='/hubs')data={MediaContainer:{Hub:[{title:'Continue watching',Metadata:[ep1]}]}};
    else if(path==='/library/metadata/ep1')data={MediaContainer:{Metadata:[ep1]}};
    else if(path==='/library/metadata/ep2')data={MediaContainer:{Metadata:[ep2]}};
    else if(path==='/library/metadata/s1/children')data={MediaContainer:{Metadata:[ep1],totalSize:1}};
    else if(path==='/library/metadata/s2/children')data={MediaContainer:{Metadata:[ep2],totalSize:1}};
    else if(path==='/library/metadata/show/children')data={MediaContainer:{Metadata:[
      {ratingKey:'s1',type:'season',index:1,title:'Season 1'},
      {ratingKey:'s2',type:'season',index:2,title:'Season 2'}],totalSize:2}};
    return route.fulfill({json:data});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Pilot, Test Show'}).click();
  await page.getByRole('button',{name:'Next episode',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Finale'})).toBeVisible();
});

test('Plex returning to the home shelf restores the activated poster focus',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'device',active:'plex',quality:'auto',servers:[{id:'plex',kind:'plex',name:'Plex test',url:'http://plex.test',token:'token'}]
  })));
  const item={ratingKey:'movie1',title:'Plex Film',type:'movie',duration:200000};
  await page.route('http://plex.test/**',route=>{
    const path=new URL(route.request().url()).pathname;
    return route.fulfill({json:path==='/hubs' ? {MediaContainer:{Hub:[{title:'Continue',Metadata:[item]}]}}
      : {MediaContainer:{Metadata:[item]}}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Plex Film',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Plex Film'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Plex Film',exact:true})).toBeFocused();
});
