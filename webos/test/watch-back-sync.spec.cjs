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
  const history=[];
  const movie=()=>({ratingKey:'movie',type:'movie',title:'Watch Back Test',
    duration:120000,viewCount:plexWatched?1:0,Guid:[{id:'imdb://tt1234567'}]});
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
      signalPlexStarted();
      await gate;
      plexWatched=path==='/:/scrobble';
      return route.fulfill({contentType:'application/xml',body:'<MediaContainer />'});
    }
    if(path==='/hubs')return route.fulfill({json:{MediaContainer:{
      Hub:[{title:'Movies',Metadata:[movie()]}]}}});
    const rows=path==='/library/metadata/movie'?[movie()]:[];
    return route.fulfill({json:{MediaContainer:{Metadata:rows,totalSize:rows.length}}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Watch Back Test',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Watch Back Test'})).toBeVisible();
  return {history,started,releasePlex,plexRequests:()=>plexRequests};
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
