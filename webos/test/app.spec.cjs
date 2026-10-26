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
  const calls=await mockServer(page);await page.goto('/');await expect(page.locator('.rail-library-items')).toBeVisible();
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
  await page.locator('main').getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByRole('button',{name:'Remove from this TV'})).toBeVisible();
});
test('removing a server removes its token',async({page})=>{
  await mockServer(page);await page.goto('/');await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Remove from this TV'}).click();
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
  await expect(page.locator('#player')).toBeVisible();await expect.poll(()=>!!reply).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.locator('.controls')).toBeHidden();
  await page.keyboard.press('Escape');reply();
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
  await expect(page.locator('.rail-library-items')).toBeVisible();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await page.getByRole('button',{name:'Sort',exact:true}).click();
  await page.getByRole('group',{name:'Sort library'}).getByRole('button',{name:'Recently added',exact:true}).click();
  await page.getByRole('button',{name:'Sort',exact:true}).click();
  await expect(page.getByRole('group',{name:'Sort library'}).getByRole('button',{name:'Recently added'})).toHaveAttribute('aria-pressed','true');
  await expect.poll(()=>calls.some(call=>call.path==='/Users/user/Items'&&
    new URLSearchParams(call.query).get('SortBy')==='DateCreated')).toBe(true);
  await page.getByRole('button',{name:'The Test Film',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group',{name:'Sort library'}).getByRole('button',{name:'Recently added'})).toHaveAttribute('aria-pressed','true');
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
test('syntax errors show the bundle name and browser version on the TV',async({page})=>{
  await page.route('**/app.js',route=>route.fulfill({contentType:'text/javascript',
    body:'function broken() { const = {; }'}));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Plezy could not start'})).toBeVisible();
  await expect(page.locator('#main')).toContainText('SyntaxError');
  await expect(page.locator('#main')).toContainText('Script: app.js');
  await expect(page.locator('#main')).toContainText('TV browser engine: Chromium');
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
  await expect(page.locator('.rail-library-items')).toBeVisible();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await expect(page.getByText(/Could not load library titles/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry loading'})).toBeVisible();
});

test('unwatched filter and sort can be combined without client-side slicing',async({page})=>{
  const calls=await mockServer(page);await page.goto('/');
  await expect(page.locator('.rail-library-items')).toBeVisible();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await page.getByRole('button',{name:'Filters',exact:true}).click();
  await page.getByRole('group',{name:'Filter watched status'}).getByRole('button',{name:'Unwatched',exact:true}).click();
  await page.getByRole('button',{name:'Sort',exact:true}).click();
  await page.getByRole('group',{name:'Sort library'}).getByRole('button',{name:'Recently added',exact:true}).click();
  await page.getByRole('button',{name:'Filters',exact:true}).click();
  await expect(page.getByRole('group',{name:'Filter watched status'}).getByRole('button',{name:'Unwatched',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect.poll(()=>calls.some(call=>call.path==='/Users/user/Items'&&
    new URLSearchParams(call.query).get('SortBy')==='DateCreated'&&
    new URLSearchParams(call.query).get('IsPlayed')==='false')).toBe(true);
  await page.getByRole('button',{name:'The Test Film',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group',{name:'Filter watched status'}).getByRole('button',{name:'Unwatched',exact:true})).toHaveAttribute('aria-pressed','true');
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

test('Plex PIN login offers a choice when multiple servers are reachable',async({page})=>{
  await page.route('https://plex.tv/**',route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/api/v2/pins')return route.fulfill({json:{id:42,code:'ABCD',expiresIn:300}});
    if(pathname==='/api/v2/pins/42')return route.fulfill({json:{authToken:'account-secret'}});
    if(pathname==='/api/v2/resources')return route.fulfill({json:[
      {provides:'server',clientIdentifier:'first',name:'Living Room Plex',accessToken:'token-one',
        connections:[{uri:'http://plex-first.test',protocol:'http',local:true}]},
      {provides:'server',clientIdentifier:'second',name:'Media Plex',accessToken:'token-two',
        connections:[{uri:'http://plex-second.test',protocol:'http',local:true}]}
    ]});
    return route.fulfill({status:404});
  });
  for(const host of ['plex-first.test','plex-second.test']){
    await page.route('http://'+host+'/**',route=>{
      const pathname=new URL(route.request().url()).pathname;
      return route.fulfill({json:pathname==='/' ? {MediaContainer:{machineIdentifier:host}} : {MediaContainer:{Hub:[]}}});
    });
  }
  await page.goto('/');
  await page.getByRole('button',{name:'Sign in with Plex'}).click();
  await expect(page.getByRole('button',{name:'Media Plex'})).toBeVisible({timeout:12000});
  await page.getByRole('button',{name:'Media Plex'}).click();
  await expect(page.getByRole('heading',{name:'Your next watch'})).toBeVisible();
  const saved=JSON.parse(await page.evaluate(()=>localStorage.getItem('plezy.webos')));
  expect(saved.servers).toHaveLength(2);
  expect(saved.active).toBe('second');
  expect(saved.servers.find(s=>s.id==='second').token).toBe('token-two');
});

test('Simkl PIN linking stores writable session and enables automatic tracking',async({page})=>{
  const calls=[];
  await page.route('https://api.simkl.com/**',async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;
    calls.push({pathname,body:request.postData()});
    if(pathname==='/oauth2/device'){
      if(request.headers()['content-type']!=='application/json' || !request.postDataJSON().scope)
        return route.fulfill({status:400,json:{error:'invalid_request',error_description:'Invalid JSON request, please validate'}});
      return route.fulfill({json:{device_code:'device-key',
      user_code:'ABCD-EFGH',verification_uri:'https://simkl.com/device',expires_in:900,interval:5}});
    }
    if(pathname==='/oauth2/token'){
      if(request.headers()['content-type']!=='application/json')
        return route.fulfill({status:400,json:{error:'invalid_request',error_description:'Invalid JSON request, please validate'}});
      return route.fulfill({json:{access_token:'simkl_at_tv_test',
      refresh_token:'simkl_rt_tv_test',expires_in:604800,scope:'media:read media:write'}});
    }
    return route.fulfill({status:404});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Connect Simkl'}).click();
  await expect(page.getByText('ABCD-EFGH')).toBeVisible();
  await expect(page.getByRole('button',{name:'Disconnect Simkl'})).toBeVisible({timeout:12000});
  const session=JSON.parse(await page.evaluate(()=>localStorage.getItem('plezy.webos'))).simkl;
  expect(session.accessToken).toBe('simkl_at_tv_test');
  expect(session.scope).toContain('media:write');
  expect(calls.map(x=>x.pathname)).toContain('/oauth2/token');
  await page.getByRole('button',{name:'Disconnect Simkl'}).click();
  expect(JSON.parse(await page.evaluate(()=>localStorage.getItem('plezy.webos'))).simkl).toBeNull();
});
test('Plex movie playback automatically scrobbles to Simkl with play, pause and stop',async({page})=>{
  const {readFile}=await import('node:fs/promises');
  const movie=await readFile(require('node:path').join(__dirname,'fixtures/test.webm'));
  const events=[];
  await page.addInitScript(()=>{
    localStorage.setItem('plezy.webos',JSON.stringify({deviceId:'device',active:'plex',
      servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'test-token'}],
      quality:'auto',simkl:{accessToken:'simkl_at_scrobble',refreshToken:'simkl_rt_scrobble',
        expiresAt:Date.now()+600000,scope:'media:read media:write'}}));
  });
  await page.route('https://api.simkl.com/**',route=>{
    events.push({path:new URL(route.request().url()).pathname,
      body:JSON.parse(route.request().postData()),auth:route.request().headers()['authorization']});
    return route.fulfill({json:{action:'start'}});
  });
  const item={ratingKey:'m1',title:'Simkl Test Film',type:'movie',duration:1200000,
    Guid:[{id:'imdb://tt7654321'}],Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
      Part:[{id:'part',key:'/library/parts/part/test.webm',Stream:[]}]}]};
  await page.route('http://plex.test/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/library/parts/part/test.webm')return serveVideo(route,movie);
    const data=path==='/hubs'?{MediaContainer:{Hub:[{title:'Recently Added',Metadata:[item]}]}}
      :{MediaContainer:{Metadata:[item]}};
    return route.fulfill({json:data});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Simkl Test Film',exact:true}).click();
  await page.getByRole('button',{name:'Play',exact:true}).first().click();
  await expect.poll(()=>events.some(e=>e.path==='/scrobble/start')).toBe(true);
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect.poll(()=>events.some(e=>e.path==='/scrobble/pause')).toBe(true,{timeout:8000});
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect.poll(()=>events.some(e=>e.path==='/scrobble/stop')).toBe(true,{timeout:8000});
  const first=events.find(e=>e.path==='/scrobble/start');
  expect(first.body.movie.ids.imdb).toBe('tt7654321');
  expect(first.body.progress).toBeGreaterThanOrEqual(0);
  expect(first.auth).toBe('Bearer simkl_at_scrobble');
  expect(events.filter(e=>e.path.startsWith('/scrobble/'))).toHaveLength(3);
});

test('webOS 4.x missing browser APIs do not block first launch or Plex login',async({page})=>{
  await page.addInitScript(()=>{
    window.AbortController=undefined;
    Promise.allSettled=undefined;
    Promise.prototype.finally=undefined;
    String.prototype.padStart=undefined;
    Element.prototype.append=undefined;
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Welcome to Plezy'})).toBeVisible();
  await page.getByRole('button',{name:'Sign in with Plex',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Link your Plex account'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Cancel'})).toBeVisible();
});

test('TV D-pad navigation does not pin every library card to top of viewport',async({page})=>{
  await mockServer(page);
  await page.goto('/');
  await expect(page.locator('.rail-library-items')).toBeVisible();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await expect(page.locator('.grid .card').first()).toBeVisible();
  // Put the main scroll partway down without moving a focused element.
  await page.evaluate(()=>{
    const main=document.querySelector('main');
    const grid=document.querySelector('.grid');
    for(let n=0;n<45;n++){
      const btn=grid.firstElementChild.cloneNode(true);
      btn.dataset.focus='f'+n;
      grid.append(btn);
    }
    main.scrollTop=300;
  });
  const previous=await page.locator('main').evaluate(x=>x.scrollTop);
  const cards=page.locator('.grid .card');
  await cards.nth(15).focus();
  await page.keyboard.press('ArrowRight');
  const after=await page.locator('main').evaluate(x=>x.scrollTop);
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThan(previous+450);
});

test('offscreen library posters are deferred until reaching the viewport',async({page})=>{
  const images=[];
  await mockServer(page);
  await page.route('http://media.test/**/Images/**',route=>{
    images.push(route.request().url());return route.fulfill({status:404});
  });
  await page.goto('/');
  await expect(page.locator('.rail-library-items')).toBeVisible();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await page.evaluate(()=>{
    const grid=document.querySelector('.grid');
    const entry=grid.querySelector('.card');
    // Enough rows to extend beyond the one-viewport prefetch margin.
    for(let n=0;n<120;n++){
      const clone=entry.cloneNode(true);
      // Mock image failures replace the poster contents with a placeholder.
      // Install a fresh deferred image rather than assuming an img survived.
      const poster=clone.querySelector('.poster');
      poster.textContent='';
      const img=document.createElement('img');
      img.alt='';
      img.setAttribute('data-poster-src','http://media.test/Items/offscreen-'+n+'/Images/Primary');
      poster.appendChild(img);
      grid.append(clone);
    }
  });
  await page.evaluate(()=>document.querySelector('main').dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(100);
  const pending=await page.locator('.grid img[data-poster-src]').count();
  expect(pending).toBeGreaterThan(0);
});

test('navigation follows Plezy rail layout without invented webOS branding',async({page})=>{
  await page.goto('/');
  await expect(page.locator('.brand')).toHaveText('Plezy');
  await expect(page.getByText('Your media.')).toHaveCount(0);
  const setting=page.getByRole('button',{name:'Settings'});
  await expect(setting.locator('svg')).toHaveCount(1);
});

test('libraries are navigable in the rail and can be hidden and restored',async({page})=>{
  await mockServer(page);await page.goto('/');
  await expect(page.locator('.rail-library-items').getByRole('button',{name:'Movies'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Hide libraries'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Libraries',exact:true})).toHaveCount(0);
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  await expect(page.getByRole('button',{name:'Browse',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('heading',{name:'Movies'})).toBeVisible();
});

test('poster loading caps initial concurrent artwork requests',async({page})=>{
  const pending=[];
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'device',active:'plex',quality:'auto',
    servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
  await page.route('http://plex.test/**',route=>{
    const u=new URL(route.request().url());
    if(u.pathname==='/photo/:/transcode'){pending.push(route);return;}
    if(u.pathname==='/hubs')return route.fulfill({json:{MediaContainer:{Hub:[{
      title:'Recently added',Metadata:Array.from({length:20},(_,i)=>({
        ratingKey:String(i),type:'movie',title:'Film '+i,thumb:'/library/metadata/'+i+'/thumb'
      }))
    }]}}});
    return route.fulfill({json:{MediaContainer:{Metadata:[]}}});
  });
  await page.goto('/');
  await expect.poll(()=>pending.length).toBe(2);
  await page.waitForTimeout(75);
  expect(pending).toHaveLength(2);
  for(const request of pending.splice(0))await request.fulfill({status:404});
});

test('Plex show detail displays metadata and browsable seasons',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'dev',active:'plex',quality:'auto',
    servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
  const show={ratingKey:'show',type:'show',title:'Example Series',year:2025,
    summary:'Story details.',tagline:'A new beginning.',studio:'Studio',
    contentRating:'TV-14',rating:8.2,Genre:[{tag:'Drama'}],Role:[{tag:'Actor One'}],
    art:'/library/metadata/show/art',thumb:'/library/metadata/show/thumb'};
  await page.route('http://plex.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p==='/hubs')return route.fulfill({json:{MediaContainer:{Hub:[{title:'TV',Metadata:[show]}]}}});
    if(p==='/library/metadata/show')return route.fulfill({json:{MediaContainer:{Metadata:[show]}}});
    if(p==='/library/metadata/show/children')return route.fulfill({json:{MediaContainer:{Metadata:[
      {ratingKey:'season1',type:'season',title:'Season 1',index:1}],totalSize:1}}});
    if(p==='/library/sections')return route.fulfill({json:{MediaContainer:{Directory:[]}}});
    return route.fulfill({status:404});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Example Series'}).click();
  await expect(page.getByRole('heading',{name:'Example Series'})).toBeVisible();
  await expect(page.getByText('A new beginning.')).toBeVisible();
  await expect(page.getByText(/Drama/)).toBeVisible();
  await expect(page.getByText(/Actor One/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Seasons'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Season 1'})).toBeVisible();
});

test('sidebar can collapse, and settings can hide individual Plex libraries',async({page})=>{
  await mockServer(page);await page.goto('/');
  await expect(page.locator('.rail-library-items').getByRole('button',{name:'Movies'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Collapse sidebar'})).toHaveCount(0);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('button',{name:'Hide Movies in sidebar'})).toBeVisible();
  await page.getByRole('button',{name:'Hide Movies in sidebar'}).click();
  await expect(page.locator('.rail-library-items').getByRole('button',{name:'Movies'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Show Movies in sidebar'})).toBeVisible();
});

test('Settings has gear icon and Libraries heading is not focusable',async({page})=>{
  await mockServer(page);await page.goto('/');
  await expect(page.getByRole('button',{name:'Libraries',exact:true})).toHaveCount(0);
  const settings=page.getByRole('button',{name:'Settings',exact:true});
  await expect(settings.locator('svg path')).toHaveAttribute('d',/M19.14/);
  await settings.click();
  await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
});

test('remote arrows remain in their navigation zone, scroll page at boundaries',async({page})=>{
  await mockServer(page);await page.goto('/');
  const library=page.locator('.rail-library-items').getByRole('button',{name:'Movies'});
  await library.focus();
  await expect(library).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(library).toBeFocused();
  // Background page rendering is not permitted to steal sidebar focus.
  await page.waitForTimeout(100);
  await expect(library).toBeFocused();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const control=page.locator('main button').first();
  await control.focus();await page.keyboard.press('ArrowUp');
  await expect(page.locator('aside button:focus')).toHaveCount(0);
  // The heading is noninteractive; Up must not unexpectedly transfer focus
  // from main content into the sidebar.
  await expect(page.locator('main button:focus')).toHaveCount(1);
});

test('Plex watched indicators show remaining episodes on partially watched series',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   deviceId:'dev',active:'plex',quality:'auto',servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
 const show={ratingKey:'s1',title:'Partly watched',type:'show',thumb:'/poster',
   leafCount:9,viewedLeafCount:5,viewCount:1};
 await page.route('http://plex.test/**',route=>{
   if(new URL(route.request().url()).pathname==='/hubs')
     return route.fulfill({json:{MediaContainer:{Hub:[{title:'TV',Metadata:[show]}]}}});
   return route.fulfill({json:{MediaContainer:{Metadata:[]}}});
 });
 await page.goto('/');
 await expect(page.locator('.card').filter({hasText:'Partly watched'}).locator('.badge')).toHaveText('4');
});

test('left from first media card returns to the active library rail item',async({page})=>{
 await mockServer(page);await page.goto('/');
 await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
 const card=page.locator('.grid .card').first();
 await card.focus();
 await page.keyboard.press('ArrowLeft');
 await expect(page.locator('.rail-library-items').getByRole('button',{name:'Movies'})).toBeFocused();
});
test('back restores a covered library page without refetching items',async({page})=>{
 const calls=await mockServer(page);await page.goto('/');
 await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
 const first=page.getByRole('button',{name:'The Test Film',exact:false}).first();
 await first.focus();
 const before=calls.filter(x=>x.path.endsWith('/Items')).length;
 await first.click();
 await expect(page.getByRole('heading',{name:'The Test Film'})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('heading',{name:'Movies'})).toBeVisible();
 expect(calls.filter(x=>x.path.endsWith('/Items')).length).toBe(before);
});

test('compound detail icons use independent correctly sized strokes and shapes',async({page})=>{
  await mockServer(page);
  await page.goto('/');
  await page.getByRole('button',{name:'The Test Film',exact:false}).first().click();
  const check=page.getByRole('button',{name:'Mark watched'}).locator('svg');
  await expect(check.locator('path[fill="none"][stroke="currentColor"]')).toHaveCount(1);
  const tick=await check.locator('path').evaluate(el=>({width:el.getBBox().width}));
  expect(tick.width).toBeGreaterThan(13);
  expect(tick.width).toBeLessThan(22);
  const dots=page.getByRole('button',{name:'More options'}).locator('svg circle');
  await expect(dots).toHaveCount(3);
  const widths=await dots.evaluateAll(nodes=>nodes.map(node=>node.getBBox().width));
  expect(new Set(widths).size).toBe(1);
});

test('detail page renders Plezy-style separate metadata chips and tonal actions',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   deviceId:'dev',active:'plex',servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
 const item={ratingKey:'movie',title:'Example movie',type:'movie',year:2025,
   contentRating:'PG-13',rating:7.8,duration:7200000,Genre:[{tag:'Drama'}],
   Media:[{container:'mp4',videoResolution:'1080p',Part:[{id:'part',key:'/video.mp4'}]}]};
 await page.route('http://plex.test/**',route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/hubs')return route.fulfill({json:{MediaContainer:{Hub:[{
     title:'Movies',Metadata:[item]}]}}});
   if(pathname==='/library/metadata/movie')return route.fulfill({json:{MediaContainer:{Metadata:[item]}}});
   return route.fulfill({json:{MediaContainer:{Metadata:[]}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:'Example movie'}).click();
 await expect(page.locator('.detail-chips .detail-chip')).toContainText(['2025','PG-13']);
 await expect(page.locator('.detail-actions .detail-play')).toBeVisible();
 await expect(page.getByRole('button',{name:'Mark watched'})).toBeVisible();
});

test('D-pad Right from every sidebar destination crosses directly into the main pane', async ({page}) => {
  await mockServer(page);
  await page.goto('/');
  await expect(page.locator('main').getByRole('button', {name:'The Test Film',exact:true}).first()).toBeVisible();

  await page.locator('#nav').getByRole('button', {name:'Home',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('main').getByRole('button', {name:'The Test Film',exact:true}).first()).toBeFocused();

  await page.locator('#nav').getByRole('button', {name:'Search',exact:true}).click();
  await expect(page.getByLabel('Title', {exact:true})).toBeVisible();
  await page.locator('#nav').getByRole('button', {name:'Search',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('Title', {exact:true})).toBeFocused();

  await page.getByRole('button', {name:'Movies',exact:true}).click();
  await page.getByRole('button', {name:'Movies',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('main .grid .card').first()).toBeFocused();
});

test('Plezy season header includes series information and functional actions',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
  deviceId:'dev',active:'plex',servers:[{id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'token'}]})));
 const show={ratingKey:'show',type:'show',title:'Example Series',year:2023,
  summary:'The series overview.',contentRating:'TV-14',thumb:'/show/thumb',
  art:'/show/art',Genre:[{tag:'Drama'}]};
 const season={ratingKey:'season1',parentRatingKey:'show',type:'season',title:'Season 1',
  index:1,thumb:'/season/thumb',leafCount:1,viewedLeafCount:0};
 const episode={ratingKey:'ep',type:'episode',title:'Pilot',index:1,parentIndex:1,
  parentRatingKey:'season1',grandparentRatingKey:'show',grandparentTitle:'Example Series'};
 await page.route('http://plex.test/**',route=>{
  const name=new URL(route.request().url()).pathname;
  if(name==='/hubs')return route.fulfill({json:{MediaContainer:{Hub:[{title:'Shows',Metadata:[show]}]}}});
  if(name==='/library/metadata/show')return route.fulfill({json:{MediaContainer:{Metadata:[show]}}});
  if(name==='/library/metadata/season1')return route.fulfill({json:{MediaContainer:{Metadata:[season]}}});
  if(name==='/library/metadata/show/children')return route.fulfill({json:{MediaContainer:{Metadata:[season],totalSize:1}}});
  if(name==='/library/metadata/season1/children')return route.fulfill({json:{MediaContainer:{Metadata:[episode],totalSize:1}}});
  return route.fulfill({json:{MediaContainer:{Directory:[],Metadata:[]}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/Example Series/}).first().click();
 await page.getByRole('button',{name:'Season 1',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Season 1'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Example Series',exact:true})).toBeVisible();
 await expect(page.getByText('The series overview.')).toBeVisible();
 await expect(page.getByRole('button',{name:'Shuffle'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Mark watched'})).toBeVisible();
 await page.getByRole('button',{name:'More options'}).click();
 await expect(page.getByRole('button',{name:'View series'})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('heading',{name:'Season 1'})).toBeVisible();
 await expect(page.getByRole('button',{name:'View series'})).toBeHidden();
});
test('episode overflow opens actions without launching compatible playback',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
  deviceId:'dev',active:'plex',servers:[{id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'token'}]})));
 const show={ratingKey:'show',type:'show',title:'The Parent Series',year:2020,
   summary:'About this series.',art:'/show/art'};
 const episode={ratingKey:'ep',type:'episode',title:'Pilot',parentIndex:1,index:1,
   parentRatingKey:'season',grandparentRatingKey:'show',
   grandparentTitle:'The Parent Series',thumb:'/episode/thumb',
   viewOffset:150000,duration:1800000,
   summary:'The first episode.',Media:[{Part:[{id:'part',key:'/video.mp4'}]}]};
 await page.route('http://plex.test/**',route=>{
   const name=new URL(route.request().url()).pathname;
   if(name==='/hubs')return route.fulfill({json:{MediaContainer:{Hub:[{title:'On deck',Metadata:[episode]}]}}});
   if(name==='/library/metadata/ep')return route.fulfill({json:{MediaContainer:{Metadata:[episode]}}});
   if(name==='/library/metadata/show')return route.fulfill({json:{MediaContainer:{Metadata:[show]}}});
   return route.fulfill({json:{MediaContainer:{Directory:[],Metadata:[]}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/Pilot/}).first().click();
 await expect(page.getByRole('button',{name:/^Resume/})).toBeFocused();
 await expect(page.getByRole('button',{name:'The Parent Series',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'More options'}).click();
 await expect(page.getByRole('button',{name:'Compatible playback'})).toBeVisible();
 await expect(page.locator('#player')).toBeHidden();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('button',{name:'Compatible playback'})).toBeHidden();
 await expect(page.getByRole('heading',{name:'Pilot'})).toBeVisible();
});

test('library rail enters first poster, restores poster on return, and moves to search input',async({page})=>{
  await mockServer(page);await page.goto('/');
  await page.locator('#nav').getByRole('button',{name:'Movies',exact:true}).click();
  const first=page.locator('main .grid .card').first();
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#nav').getByRole('button',{name:'Movies',exact:true})).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(first).toBeFocused();
  await page.locator('#nav').getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.getByLabel('Title',{exact:true})).toBeFocused();
});
test('Plex details show attributed IMDb/Simkl scores, 1080p, cast photos and allow rating',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   deviceId:'dev',active:'plex',servers:[{id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'token'}]})));
 const film={ratingKey:'film',type:'movie',title:'The Great Film',year:2024,
  rating:7.3,ratingImage:'rottentomatoes://image.rating.ripe',
  Rating:[{image:'imdb://image.rating',type:'audience',value:8.3}],
  Role:[{tag:'Actor Example',role:'Detective',thumb:'/cast/actor.jpg'}],
  Media:[{videoResolution:'1080',Part:[{id:'part',key:'/movie.mp4'}]}]};
 const put=[];
 await page.route('https://api.simkl.com/redirect**',route=>route.fulfill({status:404,json:{}}));
 await page.route('https://api.simkl.com/ratings**',route=>route.fulfill({json:{
   simkl:{rating:8.1,votes:120},imdb:{rating:8.6,votes:9000}}}));
 await page.route('http://plex.test/**',route=>{
   const url=new URL(route.request().url()),path=url.pathname;
   if(path==='/:/rate') {put.push({method:route.request().method(),key:url.searchParams.get('key'),
     rating:url.searchParams.get('rating')});return route.fulfill({status:200,body:''});}
   if(path==='/hubs')return route.fulfill({json:{MediaContainer:{Hub:[{title:'Movies',Metadata:[film]}]}}});
   if(path==='/library/metadata/film')return route.fulfill({json:{MediaContainer:{Metadata:[{...film,
     Guid:[{id:'imdb://tt1234567'}]}]}}});
   return route.fulfill({json:{MediaContainer:{Metadata:[]}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/The Great Film/}).first().click();
 await expect(page.locator('.detail-chips')).toContainText('1080p');
 await expect(page.locator('.ratings-chip .rating-badge[aria-label^="IMDb"]')).toHaveCount(1);
 await expect(page.locator('.ratings-chip .rating-badge[aria-label^="Simkl"]')).toHaveCount(1);
 await expect(page.locator('.ratings-chip')).toHaveCount(1);
 await expect(page.locator('.detail-chips > .ratings-chip')).toHaveCount(1);
 await expect(page.locator('.ratings-chip img[src="assets/rating_icons/imdb.svg"]')).toHaveCount(1);
 await expect(page.locator('.ratings-chip img[src="assets/simkl_mark.svg"]')).toHaveCount(1);
 await expect(page.getByRole('heading',{name:'Cast'})).toBeVisible();
 await expect(page.getByText('Actor Example')).toBeVisible();
 await expect(page.getByText('Detective')).toBeVisible();
 await expect(page.locator('.cast-picture img')).toHaveAttribute('src',/cast%2Factor/);
 await page.getByRole('button',{name:'Rate',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Rate The Great Film'})).toBeVisible();
 const plex=page.locator('.rating-row[data-service="Plex"]');
 await plex.focus();
 for(let i=0;i<9;i++)await page.keyboard.press('ArrowRight');
 await expect(plex).toHaveAttribute('aria-label','Plex rating 9 out of 10');
 await page.keyboard.press('Enter');
 await expect.poll(()=>put.length).toBe(1);
 expect(put[0]).toEqual({method:'PUT',key:'film',rating:'9'});
 await expect(page.getByRole('button',{name:'Rate',exact:true})).toBeFocused();
 await expect(page.locator('.cast-strip')).not.toBeFocused();
});

test('Plezy cast is below episode list with locked D-pad focus, invisible scrollbar and actor filmography',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   deviceId:'device',active:'plex',servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'test'}]})));
 const actors=Array.from({length:18},(_,i)=>({id:'actor'+i,tag:'Person '+i,
   role:'Character '+i,thumb:'/actors/'+i+'.jpg'}));
 const show={ratingKey:'series',type:'show',title:'Original Series',
   Role:actors,Guid:[{id:'tvdb://123456'}]};
 const season={ratingKey:'season',type:'season',title:'Season 1',parentRatingKey:'series'};
 const episode={ratingKey:'episode',type:'episode',title:'Episode One',parentRatingKey:'season',parentIndex:1,index:1};
 await page.route('http://plex.test/**',route=>{
   const path=new URL(route.request().url()).pathname;
   const entries=path==='/hubs'?[show]:
     path==='/library/metadata/series'?[show]:
     path==='/library/metadata/series/children'?[season]:
     path==='/library/metadata/season/children'?[episode]:
     path.startsWith('/library/people/actor')?[show]:[];
   return route.fulfill({json:{MediaContainer:path==='/hubs'?{Hub:[{title:'Shows',Metadata:[show]}]}:
     {Metadata:entries,totalSize:entries.length}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/Original Series/}).first().click();
 await expect(page.getByRole('heading',{name:'Seasons'})).toBeVisible();
 const cast=page.locator('.cast-strip');
 await expect(cast).toHaveAttribute('tabindex','0');
 const seasonCard=page.locator('main .grid .card').last();
 await seasonCard.focus();
 await page.keyboard.press('ArrowDown');
 await expect(cast).toBeFocused();
 const order=await page.evaluate(()=>{
   const seasons=document.querySelector('.detail-children-title');
   const cast=document.querySelector('.cast-section');
   return !!(seasons.compareDocumentPosition(cast)&Node.DOCUMENT_POSITION_FOLLOWING);
 });
 expect(order).toBe(true);
 await cast.focus();
 await page.keyboard.press('ArrowRight');
 await expect(cast).toBeFocused();
 await expect(cast).toHaveAttribute('aria-label',/Person 1/);
 // Moving among already visible actors must not snap each actor left.
 await expect.poll(()=>cast.evaluate(el=>el.scrollLeft)).toBe(0);
 for(let i=0;i<16;i++)await page.keyboard.press('ArrowRight');
 await expect.poll(()=>cast.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
 const hidden=await cast.evaluate(el=>getComputedStyle(el).scrollbarWidth==='none');
 // Chromium may not implement scrollbar-width, but the webOS CSS must hide it.
 expect(hidden || await cast.evaluate(el=>getComputedStyle(el).overflowX==='auto')).toBe(true);
 await page.keyboard.press('Enter');
 await expect(page.getByRole('heading',{name:'Person 17'})).toBeVisible();
});

test('connected Simkl movie and series rating rows read existing user score and write to Simkl',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   deviceId:'dev',active:'plex',servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}],
   simkl:{accessToken:'simkl_at_test',refreshToken:'simkl_rt_test',scope:'media:read media:write',
     expiresAt:Date.now()+3600000}})));
 const show={ratingKey:'series',type:'show',title:'Rated Series',
   Guid:[{id:'tvdb://321'}]};
 const writes=[];
 await page.route('https://api.simkl.com/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/redirect')return route.fulfill({status:404,json:{}});
   if(url.pathname==='/ratings')return route.fulfill({json:{simkl:{rating:8.6,votes:130},
     imdb:{rating:8.9,votes:500}}});
   if(url.pathname==='/sync/ratings/shows')return route.fulfill({json:[
     {show:{ids:{tvdb:321}},user_rating:7}]});
   if(url.pathname==='/sync/ratings'){writes.push(JSON.parse(route.request().postData()));
      return route.fulfill({status:201,json:{added:{shows:1}}});}
   return route.fulfill({json:{}});
 });
 await page.route('http://plex.test/**',route=>{
   const path=new URL(route.request().url()).pathname;
   return route.fulfill({json:{MediaContainer:path==='/hubs'?{Hub:[{title:'Shows',Metadata:[show]}]}:
     {Metadata:path==='/library/metadata/series'?[show]:[],totalSize:0}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/Rated Series/}).first().click();
 await expect(page.locator('.ratings-chip .rating-badge[aria-label^="Simkl"]')).toHaveCount(1);
 await expect(page.locator('.ratings-chip .rating-badge[aria-label^="IMDb"]')).toHaveCount(1);
 await expect(page.locator('.ratings-chip')).toHaveCount(1);
 await page.getByRole('button',{name:'Rate',exact:true}).click();
 const personal=page.locator('.ratings-chip .rating-personal');
 await expect(personal).toHaveAttribute('aria-label','Your Simkl rating 7/10');
 await expect(personal.locator('svg circle')).toHaveCount(1);
 const simkl=page.locator('.rating-row[data-service="Simkl"]');
 await expect(simkl).toHaveAttribute('aria-label','Simkl rating 7 out of 10');
 await simkl.focus();
 await page.keyboard.press('ArrowRight');
 await page.keyboard.press('ArrowRight');
 await page.keyboard.press('Enter');
 await expect.poll(()=>writes.length,{timeout:8000,
   message:'Simkl save status: '+await simkl.locator('.rating-service-status').textContent()}).toBe(1);
 expect(writes[0]).toEqual({shows:[{ids:{tvdb:321},rating:9}]});
});

test('series Play uses the full on-deck episode resume offset before HLS buffering',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   deviceId:'dev',active:'plex',servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
 const show={ratingKey:'series',type:'show',title:'Partially Viewed Series'};
 const times=[],hlsStarts=[];
 const episode={ratingKey:'episode2',type:'episode',title:'Episode In Progress',
   parentRatingKey:'season1',grandparentRatingKey:'series',duration:1200000,
   viewOffset:125000,
   Media:[{container:'mkv',videoCodec:'hevc',audioCodec:'ac3',
     Part:[{id:'part2',key:'/video.mkv',Stream:[]}]}]};
 await page.route('http://plex.test/**',route=>{
   const url=new URL(route.request().url()),path=url.pathname;
   if(path==='/video/:/transcode/universal/start.m3u8') {
     hlsStarts.push(url.searchParams.get('offset'));
     // Mocked JSON is deliberately not valid video: decoder may fall back.
     return route.fulfill({status:200,contentType:'application/vnd.apple.mpegurl',
       body:'#EXTM3U\n#EXT-X-VERSION:3\n'});
   }
   if(path==='/:/timeline') {
     times.push(url.searchParams.get('time'));
     return route.fulfill({status:200,body:''});
   }
   const rows=path==='/hubs'?[show]:path==='/library/metadata/series'?[show]:
     path==='/library/metadata/series/onDeck'?[{ratingKey:'episode2',type:'episode',title:'Episode In Progress'}]:
     path==='/library/metadata/episode2'?[episode]:[];
   return route.fulfill({json:{MediaContainer:path==='/hubs'?{Hub:[{title:'Shows',Metadata:rows}]}:
     {Metadata:rows,totalSize:rows.length}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/Partially Viewed Series/}).first().click();
 await page.getByRole('button',{name:'Play',exact:true}).first().click();
 await expect(page.locator('#player')).toBeVisible();
 await expect.poll(()=>hlsStarts.includes('125')).toBe(true);
 expect(hlsStarts[0]).toBe('125');
 // The first request and Plex progress both start from the resume point.
 await expect.poll(()=>times.includes('125000')).toBe(true);
});

test('Plezy actor page displays compact portrait, character, biography and filmography',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   deviceId:'dev',active:'plex',servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
 const actor={id:'411',tag:'Movie Actor',role:'The Lead',thumb:'/cast/411.jpg'};
 const film={ratingKey:'film',type:'movie',title:'Movie with Actor',Role:[actor]};
 const other={ratingKey:'other',type:'movie',title:'Another Film'};
 const series={ratingKey:'series',type:'show',title:'TV Series with Actor'};
 await page.route('https://discover.provider.plex.tv/library/people/plex-person',route=>
   route.fulfill({json:{MediaContainer:{Metadata:[{
     summary:'Biography about the actor.',bornAt:'1970-01-12',
     birthPlace:'Rotterdam, Netherlands'}]}}}));
 await page.route('http://plex.test/**',route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/hubs/search')return route.fulfill({json:{MediaContainer:{Hub:[{
     title:'Actors',Directory:[{tag:'Movie Actor',
       key:'/library/sections/2/all?actor=399',librarySectionType:2}]}]}}});
   if(path==='/library/people/411')
     return route.fulfill({json:{MediaContainer:{Directory:[{tagKey:'plex-person'}]}}});
   const entries=path==='/hubs'?[film]:
     path==='/library/metadata/film'?[film]:
     path==='/library/people/411/media'?[film,other]:
     path==='/library/sections/2/all'?[series]:[];
   return route.fulfill({json:{MediaContainer:path==='/hubs'?
     {Hub:[{title:'Movies',Metadata:entries}]}:{Metadata:entries,totalSize:entries.length}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/Movie with Actor/}).first().click();
 await page.locator('.cast-strip').focus();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('heading',{name:'Movie Actor'})).toBeVisible();
 await expect(page.locator('.actor-avatar img')).toHaveCount(1);
 await expect(page.getByText('The Lead')).toBeVisible();
 await expect(page.getByText('Rotterdam, Netherlands')).toBeVisible();
 await expect(page.getByText('Biography about the actor.')).toBeVisible();
 await expect(page.locator('main .grid .card')).toHaveCount(3);
 await expect(page.getByRole('button',{name:/TV Series with Actor/})).toBeVisible();
});

test('Plezy MDBList provider adds multiple branded ratings to one metadata pill',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   deviceId:'dev',active:'plex',mdblistApiKey:'example-key',
   servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
 const film={ratingKey:'mdb-film',type:'movie',title:'The Rated Film',year:2024,
   Guid:[{id:'imdb://tt5522344'}],rating:7.1,ratingImage:'imdb://rating'};
 const called=[];
 // Plezy delivers other catalog scores without waiting for a slow provider.
 let releaseSimkl;
 const simklWaiting=new Promise(resolve=>{releaseSimkl=resolve;});
 await page.route('https://api.simkl.com/ratings**',async route=>{
   await simklWaiting;
   return route.fulfill({status:404,json:{}});
 });
 await page.route('https://api.simkl.com/redirect**',route=>
   route.fulfill({status:404,json:{}}));
 await page.route('https://api.mdblist.com/**',route=>{
   const url=new URL(route.request().url());
   called.push(url);
   return route.fulfill({json:{ratings:[
     {source:'imdb',value:8.8,votes:20000},
     {source:'tomatoes',value:91,votes:200},
     {source:'popcorn',value:85,votes:200},
     {source:'metacritic',value:73,votes:300},
     {source:'letterboxd',value:4.0,votes:5000},
     {source:'trakt',value:89,votes:650}] }});
 });
 await page.route('http://plex.test/**',route=>{
   const path=new URL(route.request().url()).pathname;
   const rows=path==='/hubs'||path==='/library/metadata/mdb-film'?[film]:[];
   return route.fulfill({json:{MediaContainer:path==='/hubs'?
     {Hub:[{title:'Movies',Metadata:rows}]}:{Metadata:rows,totalSize:rows.length}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/The Rated Film/}).first().click();
 await expect.poll(()=>called.length).toBe(1);
 expect(called[0].pathname).toBe('/imdb/movie/tt5522344');
 expect(called[0].searchParams.get('apikey')).toBe('example-key');
 const bubble=page.locator('.detail-chips > .ratings-chip');
 await expect(bubble).toHaveCount(1);
 for(const provider of ['IMDb','Rotten Tomatoes critics','Rotten Tomatoes audience','metacritic','letterboxd','trakt']){
   await expect(bubble.locator('.rating-badge[aria-label^="'+provider+'"]')).toHaveCount(1);
 }
 await expect(bubble.locator('img[src="assets/rating_icons/rt_fresh.svg"]')).toHaveCount(1);
 await expect(bubble.locator('img[src="assets/trakt_circlemark.svg"]')).toHaveCount(1);
 releaseSimkl();
});
