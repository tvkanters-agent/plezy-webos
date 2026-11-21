const {test,expect}=require('@playwright/test');

// A show detail is preserved as a detached DOM snapshot while its season is open.
async function mockPlexShow(page, ratingResult = {ratings:[{source:'imdb',value:8.7,votes:250}]}) {
  await page.addInitScript(() => localStorage.setItem('plezy.webos', JSON.stringify({
    deviceId:'test', active:'plex', mdblistApiKey:'test-key',
    servers:[{id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'fixture'}]
  })));
  const calls=[];
  let releaseRating;
  const ratingGate=new Promise(resolve=>{releaseRating=resolve;});
  let ratingRequests=0;
  await page.route('https://api.mdblist.com/**', async route=>{
    ratingRequests++;
    await ratingGate;
    await route.fulfill({status:ratingResult ? 200 : 404,json:ratingResult || {error:'not found'}});
  });
  let watched=false;
  const show=()=>({ratingKey:'show',type:'show',title:'Example Series',
    leafCount:1,viewedLeafCount:watched?1:0,Guid:[{id:'imdb://tt1234567'}]});
  const season={ratingKey:'season',type:'season',title:'Season 1',parentRatingKey:'show',
    leafCount:1,viewedLeafCount:0};
  const episode={ratingKey:'episode',type:'episode',title:'Episode One',parentRatingKey:'season',
    grandparentRatingKey:'show',parentIndex:1,index:1,duration:120000,
    Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{
      id:'part',key:'/fixture.mp4',Stream:[{id:1,streamType:2,codec:'aac',selected:1}]
    }]}]};
  await page.route('http://plex.test/**', async route=>{
    const url=new URL(route.request().url());
    calls.push(url.pathname);
    if(url.pathname==='/:/scrobble'||url.pathname==='/:/unscrobble'){
      watched=url.pathname==='/:/scrobble';
      return route.fulfill({contentType:'application/xml',body:'<MediaContainer />'});
    }
    if(url.pathname==='/hubs')return route.fulfill({json:{MediaContainer:{
      Hub:[{title:'Series',Metadata:[show()]}]}}});
    const rows=url.pathname==='/library/metadata/show'?[show()]:
      url.pathname==='/library/metadata/show/children'?[season]:
      url.pathname==='/library/metadata/season'?[season]:
      url.pathname==='/library/metadata/season/children'?[episode]:
      url.pathname==='/library/metadata/show/onDeck'?[episode]:
      url.pathname==='/library/metadata/episode'?[episode]:[];
    return route.fulfill({json:{MediaContainer:{Metadata:rows,totalSize:rows.length}}});
  });
  await page.goto('/');
  return {calls,releaseRating,ratingRequests:()=>ratingRequests};
}
async function openShow(page) {
  await page.locator('#main .shelf .card').first().click();
  await expect(page.getByRole('heading',{name:'Example Series'})).toBeVisible();
  await expect(page.getByRole('button',{name:/Season 1/})).toBeVisible();
}
async function openSeasonAndReturn(page) {
  await page.evaluate(()=>{window.originalShowDetail=document.querySelector('#main .detail');});
  await page.getByRole('button',{name:/Season 1/}).click();
  await expect(page.getByRole('heading',{name:'Season 1'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading',{name:'Example Series'})).toBeVisible();
  expect(await page.evaluate(()=>
    document.querySelector('#main .detail')===window.originalShowDetail)).toBe(true);
}

test('Back to Plex show restores working Play and watched controls',async({page})=>{
  const server=await mockPlexShow(page);
  await openShow(page);
  await openSeasonAndReturn(page);
  await page.getByRole('button',{name:'Mark watched',exact:true}).click();
  await expect(page.getByRole('button',{name:'Mark unwatched',exact:true})).toBeVisible();
  await expect.poll(()=>server.calls.filter(path=>path==='/:/scrobble').length).toBe(1);
  await page.getByRole('button',{name:'Mark unwatched',exact:true}).click();
  await expect(page.getByRole('button',{name:'Mark watched',exact:true})).toBeVisible();
  await expect.poll(()=>server.calls.filter(path=>path==='/:/unscrobble').length).toBe(1);
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await expect(page.locator('#player')).toBeVisible();
  await expect.poll(()=>server.calls.filter(path=>path==='/library/metadata/show/onDeck').length)
    .toBeGreaterThan(0);
  server.releaseRating();
});

for(const timing of ['before','during','after']) {
  test('ratings resolve '+timing+' Back without freezing restored show spinner',async({page})=>{
    const server=await mockPlexShow(page);
    await openShow(page);
    const rating=page.locator('#main .ratings-chip');
    await expect(rating).toHaveAttribute('aria-busy','true');
    await expect.poll(server.ratingRequests).toBe(1);
    await page.evaluate(()=>{window.originalRatingChip=document.querySelector('#main .ratings-chip');});
    if(timing==='before') {
      server.releaseRating();
      await expect(rating).toHaveAttribute('aria-busy','false');
    }
    await page.getByRole('button',{name:/Season 1/}).click();
    await expect(page.getByRole('heading',{name:'Season 1'})).toBeVisible();
    if(timing==='during'){
      server.releaseRating();
      await expect.poll(()=>page.evaluate(()=>
        window.originalRatingChip.getAttribute('aria-busy'))).toBe('false');
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading',{name:'Example Series'})).toBeVisible();
    if(timing==='after')server.releaseRating();
    await expect(page.locator('#main .ratings-chip')).toHaveAttribute('aria-busy','false');
    await expect(page.locator('#main .ratings-chip .rating-badge')).toContainText(['8.7']);
    expect(await page.evaluate(()=>
      document.querySelector('#main .ratings-chip')===window.originalRatingChip)).toBe(true);
  });
}

for(const timing of ['before','during','after']) {
  test('empty ratings lookup '+timing+' Back removes the detached chip',async({page})=>{
    const server=await mockPlexShow(page,null);
    await openShow(page);
    const rating=page.locator('#main .ratings-chip');
    await expect(rating).toHaveAttribute('aria-busy','true');
    await expect.poll(server.ratingRequests).toBe(1);
    await page.evaluate(()=>{window.emptyRatingChip=document.querySelector('#main .ratings-chip');});
    if(timing==='before') {
      server.releaseRating();
      await expect(rating).toHaveCount(0);
    }
    await page.getByRole('button',{name:/Season 1/}).click();
    await expect(page.getByRole('heading',{name:'Season 1'})).toBeVisible();
    if(timing==='during'){
      server.releaseRating();
      await expect.poll(()=>page.evaluate(()=>
        window.emptyRatingChip.parentNode===null)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading',{name:'Example Series'})).toBeVisible();
    if(timing==='after')server.releaseRating();
    await expect(page.locator('#main .ratings-chip')).toHaveCount(0);
    expect(await page.evaluate(()=>
      window.emptyRatingChip.parentNode===null)).toBe(true);
  });
}
