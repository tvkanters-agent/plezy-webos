const {test,expect}=require('@playwright/test');

async function seasonServer(page) {
  const calls=[];
  const episode={ratingKey:'ep1',type:'episode',title:'The First Episode',index:1,
    grandparentTitle:'Example Series',grandparentRatingKey:'show',parentRatingKey:'season',
    parentIndex:1,duration:120000,viewOffset:15000,
    Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'part',key:'/fixture.mp4'}]}]};
  const detailed={...episode,Media:[{...episode.Media[0],Part:[{...episode.Media[0].Part[0],
    Stream:[
      {streamType:2,id:11,languageCode:'eng',selected:1,codec:'aac'},
      {streamType:2,id:12,languageCode:'fra',codec:'ac3'},
      {streamType:3,id:21,languageCode:'eng',codec:'srt'},
      {streamType:3,id:22,languageCode:'spa',codec:'srt'}
    ]}]}]};
  const show={ratingKey:'show',type:'show',title:'Example Series',leafCount:1,viewedLeafCount:0};
  const season={ratingKey:'season',type:'season',title:'Season 1',parentRatingKey:'show',
    parentTitle:'Example Series',leafCount:1,viewedLeafCount:0};
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'test',active:'plex',servers:[{id:'plex',kind:'plex',name:'Plex',
      url:'http://plex.test',token:'fixture'}]
  })));
  await page.route('http://plex.test/**',route=>{
    const req=route.request(),url=new URL(req.url());
    calls.push({path:url.pathname,method:req.method(),params:url.searchParams.toString()});
    let rows=[];
    if(url.pathname==='/hubs')return route.fulfill({json:{MediaContainer:{
      Hub:[{title:'On Deck',Metadata:[episode]},{title:'Series',Metadata:[show]}]
    }}});
    if(url.pathname==='/library/metadata/show')rows=[show];
    if(url.pathname==='/library/metadata/show/children')rows=[season];
    if(url.pathname==='/library/metadata/season')rows=[season];
    if(url.pathname==='/library/metadata/season/children')rows=[episode];
    if(url.pathname==='/library/metadata/ep1')rows=[detailed];
    if(url.pathname==='/library/parts/part' || url.pathname==='/video/:/transcode/universal/stop' ||
       url.pathname==='/style' || url.pathname==='/scrobble')return route.fulfill({json:{}});
    if(url.pathname.startsWith('/:/') || url.pathname.endsWith('/start.m3u8'))return route.fulfill({json:{}});
    return route.fulfill({json:{MediaContainer:{Metadata:rows,totalSize:rows.length}}});
  });
  await page.goto('/');
  return calls;
}

test('season episode overflow changes watched state without starting playback',async({page})=>{
  const calls=await seasonServer(page);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:/Season 1/}).click();
  const row=page.locator('.episode-entry');
  await expect(row).toHaveCount(1);
  const more=row.getByRole('button',{name:'More options for 1. The First Episode'});
  await more.click();
  await expect(page.getByRole('button',{name:'Mark as Watched'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Mark as Unwatched'})).toBeVisible();
  await page.getByRole('button',{name:'Mark as Watched'}).click();
  await expect.poll(()=>calls.filter(call=>call.path==='/:/scrobble').length).toBe(1);
  await expect(row.locator('.badge')).toHaveText('✓');
  await more.click();
  await expect(page.getByRole('button',{name:'Mark as Watched'})).toHaveCount(0);
  await page.getByRole('button',{name:'Mark as Unwatched'}).click();
  await expect.poll(()=>calls.filter(call=>call.path==='/:/unscrobble').length).toBe(1);
  await expect(row.locator('.badge')).toHaveCount(0);
  await expect(page.locator('#player')).toBeHidden();
});

test('season episode track choices load full metadata and reach Plex playback stream IDs',async({page})=>{
  const calls=await seasonServer(page);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:/Season 1/}).click();
  const more=page.getByRole('button',{name:'More options for 1. The First Episode'});
  await more.click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await expect(page.locator('.episode-track-columns .episode-track-column')).toHaveCount(2);
  await expect(page.getByRole('button',{name:'English'}).first()).toHaveAttribute('aria-pressed','true');
  await page.locator('.episode-track-column').first().getByRole('button',{name:'French'}).click();
  await expect(page.locator('#dialog')).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await expect(page.locator('.episode-track-column').first().getByRole('button',{name:'French'}))
    .toHaveAttribute('aria-pressed','true');
  await page.locator('.episode-track-column').last().getByRole('button',{name:'Spanish'}).click();
  expect(calls.some(call=>call.path==='/library/parts/part')).toBe(false);
  await page.locator('.episode-row').click();
  await expect.poll(()=>calls.some(call=>{
    const params=new URLSearchParams(call.params);
    return call.path==='/library/parts/part' && call.method==='PUT' &&
      params.get('audioStreamID')==='12' && params.get('subtitleStreamID')==='22';
  })).toBe(true);
});

test('episode detail More options exposes the same source choices and Back restores focus',async({page})=>{
  await seasonServer(page);
  await page.getByRole('button',{name:/The First Episode/}).first().click();
  const more=page.getByRole('button',{name:'More options',exact:true});
  await more.click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await expect(page.getByRole('heading',{name:/Audio & Subtitles/})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog')).toBeHidden();
  await expect(more).toBeFocused();
});
