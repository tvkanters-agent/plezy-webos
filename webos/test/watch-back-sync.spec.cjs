const {test,expect}=require('@playwright/test');

async function watchedServer(page, initialWatched) {
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'fixture',active:'plex',
    servers:[{id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'fixture'}],
    simkl:{accessToken:'simkl_at_fixture',refreshToken:'simkl_rt_fixture',
      expiresAt:Date.now()+3600000,scope:'media:read media:write'}
  })));
  let plexWatched=initialWatched, plexRequests=0, releasePlex, signalPlexStarted;
  const gate=new Promise(resolve=>{releasePlex=resolve;});
  const started=new Promise(resolve=>{signalPlexStarted=resolve;});
  const history=[], plexWrites=[];
  const movie=()=>({ratingKey:'movie',type:'movie',title:'Watch Back Test',
    duration:120000,viewCount:plexWatched?1:0,Guid:[{id:'imdb://tt1234567'}]});
  const other=()=>({ratingKey:'other',type:'movie',title:'Other Watch Test',
    duration:120000,viewCount:initialWatched?1:0,Guid:[{id:'imdb://tt2345678'}]});
  await page.route('https://api.simkl.com/**',route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path.startsWith('/sync/history'))
      history.push({path,body:request.postDataJSON()});
    return route.fulfill({json:{}});
  });
  await page.route('http://plex.test/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(path==='/:/scrobble'||path==='/:/unscrobble') {
      plexRequests++;
      plexWrites.push(path);
      signalPlexStarted();
      await gate;
      plexWatched=path==='/:/scrobble';
      return route.fulfill({contentType:'application/xml',body:'<MediaContainer />'});
    }
    if(path==='/hubs')return route.fulfill({json:{MediaContainer:{
      Hub:[{title:'Movies',Metadata:[movie(),other()]}]}}});
    const rows=path==='/library/metadata/movie'?[movie()]:
      path==='/library/metadata/other'?[other()]:[];
    return route.fulfill({json:{MediaContainer:{Metadata:rows,totalSize:rows.length}}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Watch Back Test',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Watch Back Test'})).toBeVisible();
  return {history,started,releasePlex,plexRequests:()=>plexRequests,
    plexWrites:()=>plexWrites.slice()};
}

for (const watched of [true,false]) {
  test('Back before Plex '+(watched?'watched':'unwatched')+' acknowledgment still syncs Simkl',async({page})=>{
    const server=await watchedServer(page,!watched);
    try {
      await page.getByRole('button',{name:watched?'Mark watched':'Mark unwatched',
        exact:true}).click();
      await server.started;
      await page.keyboard.press('Escape');
      await expect(page.locator('#main .detail')).toHaveCount(0);
      server.releasePlex();
      await expect.poll(()=>server.history.filter(x=>x.path===(watched?
        '/sync/history':'/sync/history/remove')).length).toBe(1);
      expect(server.plexRequests()).toBe(1);
      expect(server.history).toHaveLength(1);
      expect(server.history[0].body.movies[0].ids.imdb).toBe('tt1234567');
      await page.getByRole('button',{name:'Watch Back Test',exact:true}).click();
      await expect(page.getByRole('button',{name:watched?'Mark unwatched':'Mark watched',
        exact:true})).toBeVisible();
    } finally {server.releasePlex();}
  });
}

for (const watched of [true,false]) {
  test('reopened detail reconciles delayed '+(watched?'watched':'unwatched')+' acknowledgment',async({page})=>{
    const server=await watchedServer(page,!watched);
    const initialLabel=watched?'Mark watched':'Mark unwatched';
    const committedLabel=watched?'Mark unwatched':'Mark watched';
    const firstPath=watched?'/:/scrobble':'/:/unscrobble';
    const reversePath=watched?'/:/unscrobble':'/:/scrobble';
    try {
      await page.getByRole('button',{name:initialLabel,exact:true}).click();
      await server.started;
      await page.keyboard.press('Escape');
      await expect(page.locator('#main .detail')).toHaveCount(0);
      // Reopen from the pre-acknowledgment cache, before the first write settles.
      await page.getByRole('button',{name:'Watch Back Test',exact:true}).click();
      await expect(page.getByRole('button',{name:initialLabel,exact:true})).toBeVisible();
      server.releasePlex();
      await expect(page.getByRole('button',{name:committedLabel,exact:true})).toBeVisible();
      await expect.poll(()=>server.history.length).toBe(1);
      expect(server.plexWrites()).toEqual([firstPath]);
      expect(server.history[0].path).toBe(watched?'/sync/history':'/sync/history/remove');
      // The next operation must match the label that is actually displayed.
      await page.getByRole('button',{name:committedLabel,exact:true}).click();
      await expect.poll(()=>server.plexWrites().length).toBe(2);
      await expect.poll(()=>server.history.length).toBe(2);
      expect(server.plexWrites()).toEqual([firstPath,reversePath]);
      expect(server.history[1].path).toBe(watched?'/sync/history/remove':'/sync/history');
    } finally {server.releasePlex();}
  });

  test('delayed '+(watched?'watched':'unwatched')+' acknowledgment leaves another detail unchanged',async({page})=>{
    const server=await watchedServer(page,!watched);
    const otherLabel=watched?'Mark watched':'Mark unwatched';
    try {
      await page.getByRole('button',{name:watched?'Mark watched':'Mark unwatched',
        exact:true}).click();
      await server.started;
      await page.keyboard.press('Escape');
      await page.getByRole('button',{name:'Other Watch Test',exact:true}).click();
      await expect(page.getByRole('button',{name:otherLabel,exact:true})).toBeVisible();
      server.releasePlex();
      await expect.poll(()=>server.history.length).toBe(1);
      await expect(page.getByRole('button',{name:otherLabel,exact:true})).toBeVisible();
      expect(server.plexWrites()).toEqual([watched?'/:/scrobble':'/:/unscrobble']);
    } finally {server.releasePlex();}
  });
}
