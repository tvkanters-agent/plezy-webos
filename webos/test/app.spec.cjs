const {test,expect} = require('@playwright/test');
const item={Id:'movie',Name:'The Test Film',Type:'Movie',Overview:'A test library title.',RunTimeTicks:1200000000,ImageTags:{Primary:'poster'},UserData:{PlaybackPositionTicks:200000000}};
// Simulate only the TV's native bus boundary. The shipped code still performs
// both authenticated upstream requests and parses the title-detail payload.
async function mockCatalogBridge(page, ratings, type='movies') {
 await page.addInitScript(({ratings,type})=>{
   window.catalogCalls=[];
   window.PalmServiceBridge=class {
     cancel(){}
     call(uri,json){
       const payload=JSON.parse(json);window.catalogCalls.push({uri,...payload});
       const path=payload.path.split('?')[0];
       const authenticated=payload.authorization==='Bearer simkl_at_test';
       const response=!authenticated?{status:401,headers:{},body:'{}'}:
         path==='/redirect'?{status:302,headers:{location:'https://simkl.com/'+type+'/123/title'},body:''}:
         path==='/'+type+'/123'?{status:200,headers:{},body:JSON.stringify({ratings})}:
         {status:404,headers:{},body:'{}'};
       setTimeout(()=>this.onservicecallback(JSON.stringify({returnValue:true,...response})),0);
     }
   };
 },{ratings,type});
}
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
test('slow library loading fades the first grid without re-fading back navigation',async({page})=>{
  await mockServer(page);
  await page.route('http://media.test/Users/user/Items?**',async route=>{
    await new Promise(resolve=>setTimeout(resolve,220));
    await route.fulfill({json:{Items:[item],TotalRecordCount:1}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  const grid=page.locator('main .grid');
  await expect(grid).toHaveClass(/content-enter/);
  await expect(grid.locator('.card')).toHaveCount(1);
  expect(await grid.evaluate(node=>getComputedStyle(node).animationName)).toBe('content-enter');
  // Navigate away via the sidebar and Back: a preserved grid should return
  // without running the entrance animation for a second time.
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading',{name:'Movies',exact:true})).toBeVisible();
  await expect(page.locator('main .grid')).not.toHaveClass(/content-enter/);
  await expect(page.locator('main .grid .card')).toHaveCount(1);
});
test('slow home shelves fade in together instead of popping in',async({page})=>{
  await mockServer(page);
  await page.route('http://media.test/Users/user/Items/Resume**',async route=>{
    await new Promise(resolve=>setTimeout(resolve,220));
    await route.fulfill({json:{Items:[item]}});
  });
  await page.goto('/');
  await expect(page.locator('main .shelf').first()).toHaveClass(/content-enter/);
  await expect(page.locator('main .shelf .card').first()).toBeVisible();
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
  // A click starts an async library query; wait for its grid before cloning.
  await expect(page.locator('.grid .card').first()).toBeVisible();
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
  await page.addInitScript(() => {
    window.artworkOperations = [];
    const measured = new Set();
    const bounds = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.matches('img[data-poster-src]')) {
        measured.add(this);
        window.artworkOperations.push('read');
      }
      return bounds.call(this);
    };
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {...src, set(value) {
      if (measured.has(this)) window.artworkOperations.push('write');
      src.set.call(this, value);
    }});
  });
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'device',active:'plex',quality:'auto',
    servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
  await page.route('http://plex.test/**',route=>{
    const u=new URL(route.request().url());
    if(u.pathname==='/photo/:/transcode'){pending.push(route);return;}
    if(u.pathname==='/hubs')return route.fulfill({json:{MediaContainer:{Hub:[{
      title:'Recently added',Metadata:Array.from({length:20},(_,i)=>({
        ratingKey:String(i),type:'movie',title:'Film '+i,thumb:'/library/metadata/'+i+'/thumb/12345'
      }))
    }]}}});
    return route.fulfill({json:{MediaContainer:{Metadata:[]}}});
  });
  await page.goto('/');
  await expect.poll(()=>pending.length).toBe(2);
  await page.waitForTimeout(75);
  expect(pending).toHaveLength(2);
  // Disk lookup/fetch is asynchronous; src isn't assigned until resolved.
  expect(await page.evaluate(() => window.artworkOperations)).toEqual(['read','read']);
  for(const request of pending.splice(0))await request.fulfill({status:404});
  await expect.poll(()=>page.evaluate(() =>
    window.artworkOperations.filter(op => op === 'write').length)).toBe(2);
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

test('left from first media card restores the last focused sidebar destination',async({page})=>{
 await mockServer(page);await page.goto('/');
 const movies=page.locator('.rail-library-items').getByRole('button',{name:'Movies'});
 await movies.click();
 const card=page.locator('.grid .card').first();
 await card.focus();
 await page.keyboard.press('ArrowLeft');
 await expect(movies).toBeFocused();
});

test('moving left from the main pane defaults to Home then remembers rail focus',async({page})=>{
 await mockServer(page);await page.goto('/');
 const card=page.locator('main .shelf .card').first();
 const home=page.locator('#nav [data-nav-id="home"]');
 const settings=page.locator('#nav [data-nav-id="settings"]');
 const movies=page.locator('#nav [data-nav-id="library:movies"]');
 await expect(card).toBeFocused();
 // No rail element has been focused in this session.
 await page.keyboard.press('ArrowLeft');
 await expect(home).toBeFocused();
 // The chosen rail item, not the nearest item to the poster, is remembered.
 await settings.focus();
 await page.keyboard.press('ArrowRight');
 await expect(card).toBeFocused();
 await page.keyboard.press('ArrowLeft');
 await expect(settings).toBeFocused();
 // Remember the most recent focus even when it is not the active route.
 await movies.focus();
 await page.keyboard.press('ArrowRight');
 await expect(card).toBeFocused();
 await page.keyboard.press('ArrowLeft');
 await expect(movies).toBeFocused();
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
  // Finish the route's automatic focus before testing a new sidebar entry.
  // The separate gated-response tests exercise Right while data is pending.
  await expect(page.locator('main .grid .card').first()).toBeFocused();
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
  await expect(page.locator('#nav button:focus')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(first).toBeFocused();
  await page.locator('#nav').getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.getByLabel('Title',{exact:true})).toBeFocused();
});
test('Plex details show attributed IMDb/Simkl scores, 1080p, cast fallback and allow rating',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   simkl:{accessToken:'simkl_at_test',refreshToken:'simkl_rt_test',scope:'media:read media:write',expiresAt:Date.now()+3600000},
   deviceId:'dev',active:'plex',servers:[{id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'token'}]})));
 const film={ratingKey:'film',type:'movie',title:'The Great Film',year:2024,
  rating:7.3,ratingImage:'rottentomatoes://image.rating.ripe',
  Rating:[{image:'imdb://image.rating',type:'audience',value:8.3}],
  Role:[{tag:'Actor Example',role:'Detective',thumb:'/cast/actor.jpg'}],
  Media:[{videoResolution:'1080',Part:[{id:'part',key:'/movie.mp4'}]}]};
 const put=[], castPhotos=[];
 await mockCatalogBridge(page,{simkl:{rating:8.1,votes:120},imdb:{rating:8.6,votes:9000}});
 await page.route('https://api.simkl.com/**',route=>route.fulfill({json:[]}));
 await page.route('http://plex.test/**',route=>{
   const url=new URL(route.request().url()),path=url.pathname;
   if(path==='/:/rate') {put.push({method:route.request().method(),key:url.searchParams.get('key'),
     rating:url.searchParams.get('rating')});return route.fulfill({status:200,body:''});}
   if(path==='/photo/:/transcode') {
     castPhotos.push(url.searchParams.get('url'));
     return route.fulfill({status:404,body:''});
   }
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
 await expect.poll(()=>castPhotos).toContain('/cast/actor.jpg');
 await expect(page.locator('.cast-picture .person-placeholder svg')).toHaveCount(1);
 await expect(page.locator('.cast-picture img')).toHaveCount(0);
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
 // Cast's locked-focus row also returns to the last focused rail item.
 const target=page.locator('#nav [data-nav-id="settings"]');
 await target.focus();
 await cast.focus();
 await page.keyboard.press('ArrowLeft');
 await expect(target).toBeFocused();
 await page.keyboard.press('ArrowRight');
 await expect(cast).toBeFocused();
 await page.keyboard.press('ArrowRight');
 await expect(cast).toHaveAttribute('aria-label',/Person 1/);
 await page.keyboard.press('ArrowLeft');
 await expect(cast).toBeFocused();
 await expect(cast).toHaveAttribute('aria-label',/Person 0/);
 await page.keyboard.press('ArrowLeft');
 await expect(target).toBeFocused();
 await page.keyboard.press('ArrowRight');
 await expect(cast).toBeFocused();
 await page.keyboard.press('ArrowRight');
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
 await mockCatalogBridge(page,{simkl:{rating:8.6,votes:130},imdb:{rating:8.9,votes:500},mal:{rating:8.2,votes:30}},'anime');
 const writes=[];
 await page.route('https://api.simkl.com/**',route=>{
   const url=new URL(route.request().url());
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
 await expect(page.locator('.ratings-chip .rating-badge[aria-label="MyAnimeList 8.20"]')).toHaveCount(1);
 const catalogCalls=await page.evaluate(()=>window.catalogCalls);
 expect(catalogCalls.map(call=>call.path.split('?')[0])).toEqual(['/redirect','/anime/123']);
 expect(catalogCalls.every(call=>call.authorization==='Bearer simkl_at_test')).toBe(true);
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
 const times=[];
 await page.addInitScript(()=>{
   window.PalmSystem={};
   window.nativeOpens=[];
   HTMLMediaElement.prototype.load=function(){
     const source=this.querySelector('source');
     if(source) window.nativeOpens.push({url:source.src,type:source.type});
   };
   // Desktop Chromium cannot decode native LG mediaOption. Inspect the exact
   // source at load time; this fixture does not validate TV buffering.
   HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
 });
 const episode={ratingKey:'episode2',type:'episode',title:'Episode In Progress',
   parentRatingKey:'season1',grandparentRatingKey:'series',duration:1200000,
   viewOffset:125000,
   Media:[{container:'mkv',videoCodec:'hevc',audioCodec:'ac3',
     Part:[{id:'part2',key:'/video.mkv',Stream:[]}]}]};
 await page.route('http://plex.test/**',route=>{
   const url=new URL(route.request().url()),path=url.pathname;
   if(path==='/video/:/transcode/universal/start.m3u8') {
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
 const opens=await page.evaluate(()=>window.nativeOpens);
 expect(opens).toHaveLength(1);
 const url=new URL(opens[0].url);
 expect(url.pathname).toBe('/video/:/transcode/universal/start.m3u8');
 expect(url.searchParams.has('offset')).toBe(false);
 expect(url.searchParams.get('path')).toBe('/library/metadata/episode2');
 const [mime,encoded]=opens[0].type.split(';mediaOption=');
 expect(mime).toBe('application/vnd.apple.mpegurl');
 expect(JSON.parse(decodeURIComponent(encoded)).option.transmission.playTime.start).toBe(125000);
 // Preserve the target in progress reports while the decoder is opening.
 await expect.poll(()=>times.includes('125000')).toBe(true);
});

test('Plezy person fallback handles absent and failed portraits on cast strip and actor page',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   deviceId:'dev',active:'plex',servers:[{id:'plex',kind:'plex',name:'Plex',
     url:'http://plex.test',token:'token'}]})));
 const actors=[{id:'missing',tag:'No Portrait',role:'First role'},
   {id:'broken',tag:'Failed Portrait',role:'Second role',thumb:'/cast/missing.jpg'}];
 const film={ratingKey:'film',type:'movie',title:'Portrait Test Film',Role:actors};
 let attempts=0;
 await page.route('http://plex.test/**',route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/photo/:/transcode'){attempts++;return route.fulfill({status:404,body:''});}
   if(path==='/hubs')return route.fulfill({json:{MediaContainer:{
     Hub:[{title:'Movies',Metadata:[film]}]}}});
   const items=path==='/library/metadata/film'?[film]:[];
   return route.fulfill({json:{MediaContainer:{Metadata:items,totalSize:items.length}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/Portrait Test Film/}).first().click();
 const strip=page.locator('.cast-strip'), portraits=strip.locator('.cast-picture');
 await expect(portraits).toHaveCount(2);
 await expect(portraits.locator('.person-placeholder svg')).toHaveCount(2);
 // The head must be circular, not the malformed cubic path that drew a dark wedge.
 await expect(portraits.locator('.person-placeholder svg circle')).toHaveCount(2);
 await expect(portraits.locator('.person-placeholder svg circle').first()).toHaveAttribute('r','4');
 const portraitGeometry=await portraits.first().locator('svg').evaluate(svg=>{
   const head=svg.querySelector('circle').getBBox();
   const shoulders=svg.querySelector('path').getBBox();
   return {round:head.width===head.height, gap:shoulders.y-head.y-head.height};
 });
 expect(portraitGeometry.round).toBe(true);
 expect(portraitGeometry.gap).toBeGreaterThan(0);
 await expect(portraits.nth(0).locator('img')).toHaveCount(0);
 await portraits.nth(1).scrollIntoViewIfNeeded();
 await expect.poll(()=>attempts).toBeGreaterThan(0);
 await expect(portraits.nth(1).locator('img')).toHaveCount(0);
 await strip.focus();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('heading',{name:'No Portrait'})).toBeVisible();
 await expect(page.locator('.actor-avatar .person-placeholder svg')).toHaveCount(1);
 await expect(page.locator('.actor-avatar .person-placeholder svg circle')).toHaveCount(1);
 await expect(page.locator('.actor-avatar img')).toHaveCount(0);
 await page.keyboard.press('Escape');
 await expect(strip).toHaveCount(1);
 await strip.focus();
 await page.keyboard.press('ArrowRight');
 await page.keyboard.press('Enter');
 await expect(page.getByRole('heading',{name:'Failed Portrait'})).toBeVisible();
 await expect.poll(()=>attempts).toBeGreaterThan(1);
 await expect(page.locator('.actor-avatar img')).toHaveCount(0);
 await expect(page.locator('.actor-avatar .person-placeholder svg')).toHaveCount(1);
 await expect(page.locator('.actor-avatar .person-placeholder svg circle')).toHaveCount(1);
});

test('actor count loads without shifting the cast page header',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   deviceId:'dev',active:'plex',servers:[{id:'plex',kind:'plex',url:'http://plex.test',
     name:'Plex',token:'token'}]})));
 const actor={id:'411',tag:'Movie Actor',role:'The Lead'};
 const film={ratingKey:'film',type:'movie',title:'Film with Actor',Role:[actor]};
 let unblock, markRequested;
 const held=new Promise(resolve=>{unblock=resolve;});
 const requested=new Promise(resolve=>{markRequested=resolve;});
 await page.route('http://plex.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/library/people/411/media'){
     markRequested();
     await held;
     return route.fulfill({json:{MediaContainer:{Metadata:[film],totalSize:1}}});
   }
   if(path==='/hubs')return route.fulfill({json:{MediaContainer:{
     Hub:[{title:'Movies',Metadata:[film]}]}}});
   const entries=path==='/library/metadata/film'?[film]:[];
   return route.fulfill({json:{MediaContainer:{Metadata:entries,totalSize:entries.length}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/Film with Actor/}).first().click();
 await page.locator('.cast-strip').focus();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('heading',{name:'Movie Actor'})).toBeVisible();
 await requested;
 const count=page.locator('.actor-count');
 await expect(count).toBeEmpty();
 const geometry=()=>page.locator('.actor-hero').evaluate(hero=>{
   const box=selector=>hero.querySelector(selector).getBoundingClientRect();
   const top=hero.getBoundingClientRect().top;
   return {heroHeight:hero.getBoundingClientRect().height,
     identityHeight:box('.actor-identity').height, headingTop:box('h1').top-top,
     roleTop:box('.actor-role').top-top, countTop:box('.actor-count').top-top,
     countHeight:box('.actor-count').height};
 });
 const before=await geometry();
 expect(before.countHeight).toBeGreaterThan(0);
 // The reserved line must track typography changes, not a fixed pixel height.
 await count.evaluate(node=>{node.style.fontSize='1.5em';});
 const resized=await geometry();
 expect(resized.countHeight).toBeGreaterThan(before.countHeight);
 unblock();
 await expect(count).toHaveText('1 title');
 expect(await geometry()).toEqual(resized);
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
 await expect(page.locator('.actor-avatar .person-placeholder svg')).toHaveCount(1);
 await expect(page.locator('.actor-avatar .person-placeholder svg circle')).toHaveCount(1);
 await expect(page.locator('.actor-avatar img')).toHaveCount(0);
 await expect(page.getByText('The Lead')).toBeVisible();
 await expect(page.getByText('Rotterdam, Netherlands')).toBeVisible();
 await expect(page.getByText('Biography about the actor.')).toBeVisible();
 await expect(page.locator('main .grid .card')).toHaveCount(3);
 await expect(page.getByRole('button',{name:/TV Series with Actor/})).toBeVisible();
});

test('Plezy MDBList provider adds multiple branded ratings to one metadata pill',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   simkl:{accessToken:'simkl_at_test',refreshToken:'simkl_rt_test',scope:'media:read media:write',expiresAt:Date.now()+3600000},
   deviceId:'dev',active:'plex',mdblistApiKey:'example-key',
   servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
 const film={ratingKey:'mdb-film',type:'movie',title:'The Rated Film',year:2024,
   Guid:[{id:'imdb://tt5522344'}],rating:7.1,ratingImage:'imdb://rating'};
 const called=[];
 // Plezy delivers other catalog scores without waiting for a slow provider.
 await page.addInitScript(()=>{
   window.PalmServiceBridge=class { cancel(){} call(){window.releaseCatalog=()=>this.onservicecallback(
     JSON.stringify({returnValue:true,status:404,headers:{},body:'{}'}));} };
 });
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
 await expect(bubble).toHaveAttribute('aria-busy','true');
 await expect(bubble.locator('.rating-spinner')).toHaveCount(1);
 await expect(bubble.locator('.rating-badge')).toHaveCount(0);
 // Even though MDBList has returned, the pill must not grow in stages.
 await page.evaluate(()=>window.releaseCatalog());
 await expect(bubble).toHaveAttribute('aria-busy','false');
 await expect(bubble.locator('.rating-spinner')).toHaveCount(0);
 for(const provider of ['IMDb','Rotten Tomatoes critics','Rotten Tomatoes audience','metacritic','letterboxd','trakt']){
   await expect(bubble.locator('.rating-badge[aria-label^="'+provider+'"]')).toHaveCount(1);
 }
 await expect(bubble.locator('img[src="assets/rating_icons/rt_fresh.svg"]')).toHaveCount(1);
 await expect(bubble.locator('img[src="assets/trakt_circlemark.svg"]')).toHaveCount(1);
});


test('rating chip waits for personal and community ratings before showing scores',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
   simkl:{accessToken:'simkl_at_test',refreshToken:'simkl_rt_test',
     scope:'media:read media:write',expiresAt:Date.now()+3600000},
   deviceId:'dev',active:'plex',
   servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
 const film={ratingKey:'loading-film',type:'movie',title:'Ratings Loading Film',
   rating:7.4,ratingImage:'imdb://rating',Guid:[{id:'imdb://tt11223344'}]};
 await mockCatalogBridge(page,{simkl:{rating:8.1,votes:100},imdb:{rating:8.7,votes:9000}});
 let releasePersonal;
 await page.route('https://api.simkl.com/**',async route=>{
   if(new URL(route.request().url()).pathname==='/sync/ratings/movies'){
     await new Promise(resolve=>{releasePersonal=resolve;});
     return route.fulfill({json:[{movie:{ids:{imdb:'tt11223344'}},user_rating:9}]});
   }
   return route.fulfill({json:[]});
 });
 await page.route('http://plex.test/**',route=>{
   const path=new URL(route.request().url()).pathname;
   const rows=path==='/hubs'||path==='/library/metadata/loading-film'?[film]:[];
   return route.fulfill({json:{MediaContainer:path==='/hubs'?
     {Hub:[{title:'Movies',Metadata:rows}]}:{Metadata:rows,totalSize:rows.length}}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:/Ratings Loading Film/}).first().click();
 const bubble=page.locator('.detail-chips > .ratings-chip');
 await expect(bubble).toHaveAttribute('aria-busy','true');
 await expect(bubble.locator('.rating-spinner')).toHaveCount(1);
 await expect.poll(()=>typeof releasePersonal).toBe('function');
 await expect.poll(()=>page.evaluate(()=>window.catalogCalls.some(call=>
   call.path.startsWith('/movies/123')))).toBe(true);
 // Both the Plex score and completed community scores stay hidden until
 // the last enabled request (here: the personal rating) completes.
 await expect(bubble.locator('.rating-badge')).toHaveCount(0);
 releasePersonal();
 await expect(bubble).toHaveAttribute('aria-busy','false');
 await expect(bubble.locator('.rating-spinner')).toHaveCount(0);
 await expect(bubble.locator('.rating-badge[aria-label^="IMDb"]')).toHaveCount(1);
 await expect(bubble.locator('.rating-badge[aria-label^="Simkl"]')).toHaveCount(1);
 await expect(bubble.locator('.rating-personal')).toHaveAttribute(
   'aria-label','Your Simkl rating 9/10');
});

test('poster images stay invisible while pending, then fade in without a broken-image border',async({page})=>{
  await mockServer(page);
  const waiting=[];
  await page.route('http://media.test/Items/movie/Images/Primary**',route=>{
    waiting.push(route);
  });
  await page.goto('/');
  const poster=page.locator('main .card .poster').first();
  const image=poster.locator('img');
  await expect.poll(()=>waiting.length).toBeGreaterThan(0);
  expect(await image.evaluate(node=>getComputedStyle(node).opacity)).toBe('0');
  expect(await image.evaluate(node=>node.classList.contains('artwork-loaded'))).toBe(false);
  await waiting[0].fulfill({contentType:'image/svg+xml',
    body:'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#777"/></svg>'});
  await expect(image).toHaveClass(/artwork-loaded/);
  await expect.poll(()=>image.evaluate(node=>Number(getComputedStyle(node).opacity))).toBe(1);
  await expect(poster.locator('.poster-fallback')).toHaveCount(0);
});

test('missing artwork uses the native-style subdued fallback instead of a browser image error',async({page})=>{
  await mockServer(page);
  await page.goto('/');
  await expect(page.locator('main .card .poster .poster-fallback').first()).toBeVisible();
  const poster=page.locator('main .card .poster').first();
  await expect(poster.locator('img')).toHaveCount(0);
  await expect(poster).not.toContainText('▷');
});

for (const leavePane of [false, true]) {
test(`Right during a pending library request respects entry intent (leave: ${leavePane})`, async ({page}) => {
  await mockServer(page);
  let release;
  await page.route('http://media.test/Users/user/Items?**', async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({json:{Items:[item],TotalRecordCount:1}});
  });
  await page.goto('/');
  await page.getByRole('button', {name:'Movies',exact:true}).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole('button', {name:'Movies',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  // Keep the request blocked across animation frames, as on a slower server.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (leavePane) await page.getByRole('button', {name:'Movies',exact:true}).focus();
  release();
  await expect(page.locator('main .grid .card').first()).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (leavePane) await expect(page.getByRole('button', {name:'Movies',exact:true})).toBeFocused();
  else await expect(page.locator('main .grid .card').first()).toBeFocused();
});
}

test('Right enters controls of an empty library after loading completes', async ({page}) => {
  await mockServer(page);
  await page.route('http://media.test/Users/user/Items?**', route =>
    route.fulfill({json:{Items:[],TotalRecordCount:0}}));
  await page.goto('/');
  await page.getByRole('button', {name:'Movies',exact:true}).click();
  await expect(page.getByText('No titles found.', {exact:true})).toBeVisible();
  await expect(page.locator('main').getByRole('button', {name:'Recommended',exact:true})).toBeFocused();
  await page.getByRole('button', {name:'Movies',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('main').getByRole('button', {name:'Recommended',exact:true})).toBeFocused();
});

test('artwork persists through reload and decoded memory hits render before insertion',async({page})=>{
  await mockServer(page);
  let imageRequests=0;
  const image='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">'+
    '<rect width="16" height="16" fill="#777"/></svg>';
  await page.route('http://media.test/Items/movie/Images/Primary**',route=>{
    imageRequests++;
    return route.fulfill({body:image,headers:{
      'Content-Type':'image/svg+xml','Access-Control-Allow-Origin':'*'}});
  });
  await page.goto('/');
  const first=page.locator('main .card .poster img').first();
  await expect(first).toHaveClass(/artwork-loaded/);
  await expect.poll(()=>page.evaluate(()=>new Promise(resolve=>{
    const request=indexedDB.open('plezy-artwork-v1',1);
    request.onerror=()=>resolve(0);
    request.onsuccess=()=>{
      const tx=request.result.transaction('images','readonly');
      const count=tx.objectStore('images').count();
      count.onsuccess=()=>resolve(count.result);
      count.onerror=()=>resolve(0);
    };
  }))).toBeGreaterThan(0);
  const before=imageRequests;
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  const reused=page.locator('main .grid .poster img').first();
  await expect(reused).toHaveClass(/artwork-ready/);
  expect(await reused.getAttribute('src')).toMatch(/^blob:/);
  expect(imageRequests).toBe(before);
  await page.reload();
  const fromDisk=page.locator('main .card .poster img').first();
  await expect(fromDisk).toHaveClass(/artwork-ready/);
  expect(await fromDisk.getAttribute('src')).toMatch(/^blob:/);
  expect(imageRequests).toBe(before);
});
test('cast pictures fade in but do not enter the persistent artwork cache',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'dev',active:'plex',
    servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
  const actor={id:'1',tag:'Performer',role:'Lead',thumb:'/cast/1.jpg'};
  const movie={ratingKey:'film',type:'movie',title:'Film with Cast',Role:[actor]};
  await page.route('http://plex.test/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/photo/:/transcode')return route.fulfill({
      body:'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
      headers:{'Content-Type':'image/svg+xml','Access-Control-Allow-Origin':'*'}});
    if(path==='/hubs')return route.fulfill({json:{MediaContainer:{Hub:[{title:'Films',Metadata:[movie]}]}}});
    if(path==='/library/metadata/film')
      return route.fulfill({json:{MediaContainer:{Metadata:[movie]}}});
    return route.fulfill({json:{MediaContainer:{Metadata:[]}}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:/Film with Cast/}).first().click();
  const portrait=page.locator('.cast-picture img').first();
  await portrait.scrollIntoViewIfNeeded();
  await expect(portrait).toHaveClass(/artwork-loaded/);
  // The image is a composited fade layer on Chromium 53: its own corners
  // must be rounded, not merely masked by the parent's overflow:hidden.
  await expect(portrait).toHaveClass(/artwork-image/);
  const castRadii = await portrait.evaluate(img=>({
    image:getComputedStyle(img).borderTopLeftRadius,
    frame:getComputedStyle(img.parentElement).borderTopLeftRadius
  }));
  expect(castRadii).toEqual({image:'10px',frame:'10px'});
  await expect.poll(()=>portrait.evaluate(node=>Number(getComputedStyle(node).opacity))).toBe(1);
  expect(await portrait.getAttribute('data-artwork-cache')).toBe(null);
  expect(await portrait.getAttribute('src')).toMatch(/^http:/);
});

test('changed artwork tags refresh images while unchanged versions stay cached',async({page})=>{
  await mockServer(page);
  let tag='poster-old';
  const requested=[];
  await page.route('http://media.test/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.includes('/Images/')){
      requested.push(url.searchParams.get('tag'));
      return route.fulfill({body:'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
        headers:{'Content-Type':'image/svg+xml','Access-Control-Allow-Origin':'*'}});
    }
    const media={...item,ImageTags:{Primary:tag}};
    if(url.pathname.endsWith('/Items/Resume'))return route.fulfill({json:{Items:[media]}});
    if(url.pathname.endsWith('/Items/Latest'))return route.fulfill({json:[media]});
    if(url.pathname.endsWith('/Items/movie'))return route.fulfill({json:media});
    if(url.pathname.endsWith('/Items'))return route.fulfill({json:{Items:[media],TotalRecordCount:1}});
    return route.fallback();
  });
  await page.goto('/');
  await expect.poll(()=>requested.includes('poster-old')).toBe(true);
  await expect(page.locator('main .card .poster img').first()).toHaveClass(/artwork-loaded/);
  tag='poster-new';
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await expect.poll(()=>requested.includes('poster-new')).toBe(true);
  const updated=page.locator('main .grid .poster img').first();
  await expect(updated).toHaveClass(/artwork-loaded/);
  expect(new URL(await updated.getAttribute('data-artwork-url')).searchParams.get('tag')).toBe('poster-new');
  const count=requested.length;
  // A new navigation receives the same tag and reuses the decoded image.
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await expect(page.locator('main .grid .poster img').first()).toHaveClass(/artwork-ready/);
  expect(requested.length).toBe(count);
});

test('previously visited unversioned library paints every cached image on its first frame',async({page})=>{
  await mockServer(page);
  const movies=Array.from({length:12},(_,i)=>({Id:'repeat-'+i,Name:'Repeat '+i,Type:'Movie'}));
  const image='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>';
  let requests=0;
  await page.route('http://media.test/**', route=>{
    const url=new URL(route.request().url());
    if(url.pathname.includes('/Images/')){
      requests++;
      return route.fulfill({body:image,headers:{
        'Content-Type':'image/svg+xml','Access-Control-Allow-Origin':'*'}});
    }
    if(url.pathname.endsWith('/Users/user/Items'))return route.fulfill({
      json:{Items:movies,TotalRecordCount:movies.length}});
    return route.fallback();
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  const first=page.locator('main .grid .poster img');
  await expect(first).toHaveCount(movies.length);
  await expect.poll(()=>first.evaluateAll(images=>images.filter(img=>
    img.classList.contains('artwork-loaded') && img.naturalWidth>0).length)).toBe(movies.length);
  await page.getByRole('button',{name:'Home',exact:true}).click();
  await expect(page.locator('main .shelf')).not.toHaveCount(0);
  const before=requests;
  // Capture a DOM mutation before the browser paints the new page: all
  // previously loaded images must already have their full-opacity class.
  await page.evaluate(expected=>{
    window.libraryFirstFrame=null;
    window.libraryFrameObserver=new MutationObserver(()=>{
      if(window.libraryFirstFrame)return;
      const grid=document.querySelector('main .grid');
      if(!grid||grid.querySelectorAll('.card').length!==expected)return;
      const imgs=Array.from(grid.querySelectorAll('.poster img'));
      window.libraryFirstFrame=imgs.map(img=>({
        ready:img.classList.contains('artwork-ready'),
        opacity:getComputedStyle(img).opacity, src:img.getAttribute('src')
      }));
      window.libraryFrameObserver.disconnect();
    });
    window.libraryFrameObserver.observe(document.querySelector('main'),{childList:true,subtree:true});
  },movies.length);
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.libraryFirstFrame)).not.toBeNull();
  const firstFrame=await page.evaluate(()=>window.libraryFirstFrame);
  expect(firstFrame).toHaveLength(movies.length);
  expect(firstFrame.every(img=>img.ready&&img.opacity==='1'&&img.src.startsWith('blob:'))).toBe(true);
  expect(requests).toBe(before);
});

test('actor avatar image itself stays circular during its fade',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'dev',active:'plex',
    servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]})));
  const actor={id:'17',tag:'Performer',thumb:'/cast/17.jpg'};
  const film={ratingKey:'film',type:'movie',title:'Cast Image Test',Role:[actor]};
  await page.route('http://plex.test/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/photo/:/transcode')return route.fulfill({
      body:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>',
      headers:{'Content-Type':'image/svg+xml'}});
    if(path==='/hubs')return route.fulfill({json:{MediaContainer:{
      Hub:[{title:'Films',Metadata:[film]}]}}});
    if(path==='/library/metadata/film')return route.fulfill({
      json:{MediaContainer:{Metadata:[film]}}});
    return route.fulfill({json:{MediaContainer:{Metadata:[]}}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:/Cast Image Test/}).first().click();
  await page.locator('.cast-strip').focus();
  await page.keyboard.press('Enter');
  const portrait=page.locator('.actor-avatar img');
  await expect(portrait).toHaveCount(1);
  await expect(portrait).toHaveClass(/artwork-loaded/);
  const geometry=await portrait.evaluate(img=>{
    const parent=getComputedStyle(img.parentElement), style=getComputedStyle(img);
    return {childRadius:style.borderTopLeftRadius,parentRadius:parent.borderTopLeftRadius,
      width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height};
  });
  expect(geometry.childRadius).toBe(geometry.parentRadius);
  expect(geometry.childRadius).toBe('40px');
  expect(geometry.width).toBe(geometry.height);
});

test('Home does not flash a loading string while its first requests are pending',async({page})=>{
  await mockServer(page);
  let release;
  await page.route('http://media.test/Users/user/Items/Resume**',async route=>{
    await new Promise(resolve=>{release=resolve;});
    await route.fulfill({json:{Items:[item]}});
  });
  await page.goto('/');
  await expect.poll(()=>typeof release).toBe('function');
  await expect(page.getByRole('heading',{name:'Your next watch'})).toBeVisible();
  await expect(page.getByText('Loading your library…')).toHaveCount(0);
  await expect(page.getByText('Loading libraries…')).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toMatch(/Loading your library/);
  release();
  await expect(page.locator('main .shelf')).not.toHaveCount(0);
});

test('all media artwork inherits the exact frame radius, including future frames',async({page})=>{
  await mockServer(page);
  await page.goto('/');
  const result=await page.evaluate(()=>{
    const main=document.querySelector('main');
    const cases=[
      {name:'poster',outer:'poster',parent:null,expected:'14px',style:'border-radius:14px'},
      {name:'cast',outer:'cast-picture',parent:null,expected:'10px'},
      {name:'avatar',outer:'actor-avatar',parent:null,expected:'40px'},
      {name:'episode',outer:'poster',parent:'episode-thumb',expected:'6px'},
      {name:'future',outer:'new-media-artwork-frame',parent:null,
        style:'border-radius:19px;overflow:hidden',expected:'19px'}
    ];
    return cases.map(entry=>{
      const holder=document.createElement('div');
      if(entry.parent)holder.className=entry.parent;
      const frame=document.createElement('div');
      frame.className=entry.outer;
      if(entry.style)frame.setAttribute('style',entry.style);
      const img=document.createElement('img');
      img.className='artwork-image artwork-loaded';
      img.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
      frame.appendChild(img);
      if(entry.parent)holder.appendChild(frame);
      main.appendChild(entry.parent?holder:frame);
      const image=getComputedStyle(img).borderTopLeftRadius;
      const parent=getComputedStyle(frame).borderTopLeftRadius;
      (entry.parent?holder:frame).remove();
      return {name:entry.name,image,parent,expected:entry.expected};
    });
  });
  for(const item of result){
    expect(item.parent,item.name+' frame radius').toBe(item.expected);
    expect(item.image,item.name+' fading image radius').toBe(item.expected);
  }
});

test('persisted Home and library artwork paint ready on the first DOM frame after restart',async({page})=>{
  await mockServer(page);
  const titles=Array.from({length:4},(_,i)=>({
    Id:'cached-'+i,Name:'Persisted '+i,Type:'Movie',
    ImageTags:{Primary:'tag-'+i}
  }));
  const picture='<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12">'+
    '<rect width="12" height="12"/></svg>';
  let requests=0;
  await page.route('http://media.test/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.includes('/Images/')){
      requests++;
      return route.fulfill({body:picture,headers:{
        'Content-Type':'image/svg+xml','Access-Control-Allow-Origin':'*'}});
    }
    if(path.endsWith('/Items/Resume'))return route.fulfill({json:{Items:titles}});
    if(path.endsWith('/Items/Latest'))return route.fulfill({json:[]});
    if(path==='/Users/user/Items')return route.fulfill({
      json:{Items:titles,TotalRecordCount:titles.length}});
    return route.fallback();
  });
  // Observe the exact DOM insertion, before paint or image load handlers.
  // This observer is installed on both initial load and the restarted app.
  await page.addInitScript(()=>{
    window.firstHomeArtwork=null;
    const record=()=>{
      if(window.firstHomeArtwork)return;
      const shelf=document.querySelector('main .shelf');
      if(!shelf || shelf.querySelectorAll('.poster img').length!==4)return;
      window.firstHomeArtwork=Array.from(shelf.querySelectorAll('.poster img')).map(img=>({
        ready:img.classList.contains('artwork-ready'),src:img.getAttribute('src'),
        opacity:getComputedStyle(img).opacity
      }));
    };
    const start=()=>{
      const obs=new MutationObserver(record);
      obs.observe(document.documentElement,{subtree:true,childList:true});
    };
    if(document.documentElement)start();
    else document.addEventListener('readystatechange',start,{once:true});
  });
  await page.goto('/');
  await expect.poll(()=>page.locator('main .shelf .poster img.artwork-loaded').count()).toBe(4);
  // The async disk write is not on the image-load critical path.
  await expect.poll(()=>page.evaluate(()=>new Promise(resolve=>{
    const req=indexedDB.open('plezy-artwork-v1',1);
    req.onerror=()=>resolve(0);
    req.onsuccess=()=>{
      const tx=req.result.transaction('images','readonly');
      const n=tx.objectStore('images').count();
      n.onsuccess=()=>resolve(n.result);
      n.onerror=()=>resolve(0);
    };
  }))).toBeGreaterThanOrEqual(4);
  const before=requests;
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>window.firstHomeArtwork)).not.toBeNull();
  const home=await page.evaluate(()=>window.firstHomeArtwork);
  expect(home).toHaveLength(4);
  expect(home.every(img=>img.ready && img.src.startsWith('blob:') && img.opacity==='1')).toBe(true);
  expect(requests).toBe(before);
  // A separate route has the same requirement: all images are already ready
  // when the library grid is appended, not restored in two-image waves.
  await page.evaluate(()=>{
    window.firstLibraryArtwork=null;
    const obs=new MutationObserver(()=>{
      if(window.firstLibraryArtwork)return;
      const grid=document.querySelector('main .grid');
      if(!grid || grid.querySelectorAll('.poster img').length!==4)return;
      window.firstLibraryArtwork=Array.from(grid.querySelectorAll('.poster img')).map(img=>({
        ready:img.classList.contains('artwork-ready'),src:img.getAttribute('src'),
        opacity:getComputedStyle(img).opacity
      }));
      obs.disconnect();
    });
    obs.observe(document.querySelector('main'),{subtree:true,childList:true});
  });
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.firstLibraryArtwork)).not.toBeNull();
  const library=await page.evaluate(()=>window.firstLibraryArtwork);
  expect(library).toHaveLength(4);
  expect(library.every(img=>img.ready && img.src.startsWith('blob:') && img.opacity==='1')).toBe(true);
  expect(requests).toBe(before);
});
