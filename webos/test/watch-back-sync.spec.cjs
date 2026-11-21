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

async function seasonWatchServer(page, initialWatched) {
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'fixture',active:'plex',
    servers:[{id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'fixture'}]
  })));
  let releaseWrite, releasePage, writeRequests = 0, laterPageRequests = 0;
  const writeGate = new Promise(resolve=>{ releaseWrite = resolve; });
  const pageGate = new Promise(resolve=>{ releasePage = resolve; });
  const show = {ratingKey:'show',type:'show',title:'Watch State Series'};
  const season = (id, number, leafCount) => ({ratingKey:id,type:'season',
    title:'Season '+number,index:number,parentRatingKey:show.ratingKey,parentTitle:show.title,
    leafCount,viewedLeafCount:initialWatched ? leafCount : 0});
  const first = season('first',1,2), other = season('other',2,1);
  const episode = (parent, number) => ({ratingKey:parent.ratingKey+'-'+number,type:'episode',
    title:'Episode '+number,index:number,parentRatingKey:parent.ratingKey,
    grandparentRatingKey:show.ratingKey,duration:120000,viewCount:initialWatched ? 1 : 0,
    viewOffset:number === 1 && !initialWatched ? 15000 : 0});
  await page.route('http://plex.test/**',async route=>{
    const {pathname,searchParams} = new URL(route.request().url());
    const reply = (rows,totalSize=rows.length) =>
      route.fulfill({json:{MediaContainer:{Metadata:rows,totalSize}}});
    switch (pathname) {
      case '/:/scrobble':
      case '/:/unscrobble':
        expect(searchParams.get('key')).toBe(first.ratingKey);
        expect(pathname).toBe(initialWatched?'/:/unscrobble':'/:/scrobble');
        writeRequests++;
        await writeGate;
        return route.fulfill({status:200,body:''});
      case '/hubs':
        return route.fulfill({json:{MediaContainer:{Hub:[{title:'Series',Metadata:[show]}]}}});
      case '/library/metadata/show': return reply([show]);
      case '/library/metadata/show/children': return reply([first,other]);
      case '/library/metadata/first': return reply([first]);
      case '/library/metadata/other': return reply([other]);
      case '/library/metadata/first/children':
        if (searchParams.get('X-Plex-Container-Start') !== '1') return reply([episode(first,1)],2);
        laterPageRequests++;
        await pageGate;
        // Return the state captured before the season acknowledgment.
        return reply([episode(first,2)],2);
      case '/library/metadata/other/children': return reply([episode(other,1)]);
      default: return reply([]);
    }
  });
  await page.goto('/');
  await page.getByRole('button',{name:show.title,exact:true}).click();
  return {releaseWrite,releasePage,writeRequests:()=>writeRequests,laterPageRequests:()=>laterPageRequests};
}

function savedCatalogRows(page, keyPart) {
  return page.evaluate(keyPart=>new Promise((resolve,reject)=>{
    const open = indexedDB.open('plezy-catalog-v1',1);
    open.onerror = ()=>reject(open.error);
    open.onsuccess = ()=>{
      const db = open.result;
      const request = db.transaction('pages').objectStore('pages').getAll();
      request.onerror = ()=>reject(request.error);
      request.onsuccess = ()=>{
        db.close();
        resolve(request.result.filter(row=>row.key.includes(keyPart)).map(row=>row.data));
      };
    };
  }),keyPart);
}

for (const watched of [true,false]) {
  test('reopened season updates loaded and pending episodes on '+(watched?'watch':'unwatch'),async({page})=>{
    const server = await seasonWatchServer(page,!watched);
    const season = page.getByRole('button',{name:/^Season 1/});
    const initial = page.getByRole('button',{name:watched?'Mark watched':'Mark unwatched',exact:true});
    const committed = page.getByRole('button',{name:watched?'Mark unwatched':'Mark watched',exact:true});
    const first = page.locator('.episode-entry[data-catalog-id="first-1"]');
    const more = first.getByRole('button',{name:/More options/});
    try {
      await season.click();
      await expect(first).toBeVisible();
      await initial.click();
      await expect.poll(server.writeRequests).toBe(1);
      await page.keyboard.press('Escape');
      await season.click();
      await expect(initial).toBeVisible();
      await expect(first.locator('.episode-progress')).toHaveCount(watched?1:0);
      await expect(first.locator('.badge')).toHaveCount(watched?0:1);
      await expect.poll(server.laterPageRequests).toBeGreaterThan(0);
      await more.focus();
      server.releaseWrite();
      await expect(committed).toBeVisible();
      await expect(first.locator('.badge')).toHaveCount(watched?1:0);
      await expect(first.locator('.episode-progress')).toHaveCount(0);
      await expect(more).toBeFocused();
      await more.click();
      await expect(page.getByRole('button',{name:watched?'Mark as Unwatched':'Mark as Watched',exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:watched?'Mark as Watched':'Mark as Unwatched',exact:true})).toHaveCount(0);
      await page.keyboard.press('Escape');

      server.releasePage();
      const later = page.locator('.episode-entry[data-catalog-id="first-2"]');
      await expect(later).toBeVisible();
      await expect(later.locator('.badge')).toHaveCount(watched?1:0);
      await expect.poll(async()=>{
        const pages = await savedCatalogRows(page,':children:["first","season",false,');
        return pages.flatMap(page=>page.items.map(item=>[item.id,item.watched,item.resume]));
      }).toEqual([['first-1',watched,0],['first-2',watched,0]]);
    } finally {
      server.releaseWrite();
      server.releasePage();
    }
  });
}

for (const watched of [true,false]) for (const reopened of [false,true]) {
  test('covered '+(reopened?'reopened ':'')+'season restores episode state after '+(watched?'watch':'unwatch'),async({page})=>{
    const server = await seasonWatchServer(page,!watched);
    const season = page.getByRole('button',{name:/^Season 1/});
    const mark = watched?'Mark watched':'Mark unwatched';
    const reverse = watched?'Mark unwatched':'Mark watched';
    const first = page.locator('.episode-entry[data-catalog-id="first-1"]');
    const later = page.locator('.episode-entry[data-catalog-id="first-2"]');
    try {
      await season.click();
      await expect(first).toBeVisible();
      await page.getByRole('button',{name:mark,exact:true}).click();
      await expect.poll(server.writeRequests).toBe(1);
      if (reopened) {
        await page.keyboard.press('Escape');
        await season.click();
        await expect(first).toBeVisible();
      }
      await expect(first.locator('.badge')).toHaveCount(watched?0:1);
      await expect(first.locator('.episode-progress')).toHaveCount(watched?1:0);
      await expect.poll(server.laterPageRequests).toBeGreaterThan(0);
      await first.evaluate(row=>{window.retainedSeasonRow=row;});

      await page.getByRole('button',{name:'More options',exact:true}).click();
      await page.getByRole('button',{name:'View series',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Watch State Series',exact:true})).toBeVisible();
      await season.focus();
      server.releaseWrite();
      await expect.poll(async()=>{
        const [detail] = await savedCatalogRows(page,':detail:["first","season"]');
        return detail?.item.watched;
      }).toBe(watched);
      await expect(season).toBeFocused();
      await expect(page.getByRole('button',{name:'Mark watched',exact:true})).toBeVisible();
      if (reopened) {
        const pendingPage = page.waitForResponse(response=>{
          const url = new URL(response.url());
          return url.pathname === '/library/metadata/first/children' &&
            url.searchParams.get('X-Plex-Container-Start') === '1';
        });
        server.releasePage();
        await (await pendingPage).finished();
      }

      await page.keyboard.press('Escape');
      await expect(page.getByRole('button',{name:reverse,exact:true})).toBeVisible();
      await expect(first.locator('.badge')).toHaveCount(watched?1:0);
      await expect(first.locator('.episode-progress')).toHaveCount(0);
      expect(await first.evaluate(row=>row===window.retainedSeasonRow)).toBe(true);
      await first.getByRole('button',{name:/More options/}).click();
      await expect(page.getByRole('button',{name:watched?'Mark as Unwatched':'Mark as Watched',exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:watched?'Mark as Watched':'Mark as Unwatched',exact:true})).toHaveCount(0);
      await page.keyboard.press('Escape');

      server.releasePage();
      await expect(later).toBeVisible();
      await expect(later.locator('.badge')).toHaveCount(watched?1:0);
      await expect.poll(async()=>{
        const pages = await savedCatalogRows(page,':children:["first","season",false,');
        return pages.flatMap(page=>page.items.map(item=>[item.id,item.watched,item.resume]));
      }).toEqual([['first-1',watched,0],['first-2',watched,0]]);
      expect(server.writeRequests()).toBe(1);
    } finally {
      server.releaseWrite();
      server.releasePage();
    }
  });
}

test('a delayed season acknowledgment leaves another season and its episode unchanged',async({page})=>{
  const server = await seasonWatchServer(page,false);
  try {
    await page.getByRole('button',{name:/^Season 1/}).click();
    await page.getByRole('button',{name:'Mark watched',exact:true}).click();
    await expect.poll(server.writeRequests).toBe(1);
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:/^Season 2/}).click();
    const episode = page.locator('.episode-entry[data-catalog-id="other-1"]');
    await expect(episode.locator('.episode-progress')).toBeVisible();
    const acknowledged = page.waitForResponse(response=>new URL(response.url()).pathname==='/:/scrobble');
    server.releaseWrite();
    await acknowledged;
    await episode.getByRole('button',{name:/More options/}).click();
    await expect(page.getByRole('button',{name:'Mark watched',exact:true})).toBeVisible();
    await expect(episode.locator('.episode-progress')).toBeVisible();
    await expect(episode.locator('.badge')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Mark as Watched',exact:true})).toBeVisible();
  } finally {
    server.releaseWrite();
    server.releasePage();
  }
});
