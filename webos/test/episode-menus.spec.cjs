const {test,expect}=require('@playwright/test');

async function seasonServer(page, multi = false, configure) {
  const calls=[];
  const episode={ratingKey:'ep1',type:'episode',title:'The First Episode',index:1,
    grandparentTitle:'Example Series',grandparentRatingKey:'show',parentRatingKey:'season',
    parentIndex:1,duration:120000,viewOffset:15000,
    summary:'A brief episode synopsis.',originallyAvailableAt:'2026-11-15',
    Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',videoResolution:'1080',
      Part:[{id:'part',key:'/fixture.mp4'}]}]};
  const detailed={...episode,Media:[{...episode.Media[0],Part:[{...episode.Media[0].Part[0],
    Stream:[
      {streamType:2,id:11,languageCode:'eng',selected:1,codec:'aac'},
      {streamType:2,id:12,languageCode:'fra',codec:'ac3'},
      {streamType:3,id:21,languageCode:'eng',codec:'srt'},
      {streamType:3,id:22,languageCode:'spa',codec:'srt'}
    ]}]}]};
  const second={...episode,ratingKey:'ep2',title:'The Second Episode',index:2,
    Media:[{...episode.Media[0],Part:[{id:'part2',key:'/fixture2.mp4'}]}]};
  const secondDetail={...second,Media:[{...second.Media[0],Part:[{...second.Media[0].Part[0],
    Stream:[
      {streamType:2,id:41,languageCode:'eng',selected:1,codec:'aac'},
      {streamType:2,id:42,languageCode:'fr',codec:'ac3'},
      {streamType:3,id:51,languageCode:'eng',codec:'srt'},
      {streamType:3,id:52,languageCode:'es',codec:'srt'}
    ]}]}]};
  if (configure) configure(detailed, secondDetail, second);
  const show={ratingKey:'show',type:'show',title:'Example Series',leafCount:1,viewedLeafCount:0};
  const season={ratingKey:'season',type:'season',title:'Season 1',parentRatingKey:'show',
    parentTitle:'Example Series',leafCount:1,viewedLeafCount:0};
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'test',active:'plex',servers:[{id:'plex',kind:'plex',name:'Plex',
      url:'http://plex.test',token:'fixture'}]
  })));
  await page.context().route('http://plex.test/**',route=>{
    const req=route.request(),url=new URL(req.url());
    calls.push({path:url.pathname,method:req.method(),params:url.searchParams.toString()});
    let rows=[];
    if(url.pathname==='/hubs')return route.fulfill({json:{MediaContainer:{
      Hub:[{title:'On Deck',Metadata:[episode]},{title:'Series',Metadata:[show]}]
    }}});
    if(url.pathname==='/library/metadata/show')rows=[show];
    if(url.pathname==='/library/metadata/show/children')rows=[season];
    if(url.pathname==='/library/metadata/show/grandchildren')rows=multi?[episode,second]:[episode];
    if(req.method()==='PUT' && url.pathname.startsWith('/library/parts/')) {
      const part=[detailed,secondDetail].map(e=>e.Media[0].Part[0]).find(p=>url.pathname==='/library/parts/'+p.id);
      if (!part) return route.fulfill({status:404});
      for (const [param,type] of [['audioStreamID',2],['subtitleStreamID',3]]) {
        if (!url.searchParams.has(param)) continue;
        const id=Number(url.searchParams.get(param));
        const tracks=part.Stream.filter(track=>track.streamType===type);
        if (!(type===3 && id===0) && !tracks.some(track=>track.id===id))
          return route.fulfill({status:400});
        tracks.forEach(track=>{track.selected=Number(track.id===id);});
      }
      return route.fulfill({status:200,body:''});
    }
    if(url.pathname==='/library/metadata/season')rows=[season];
    if(url.pathname==='/library/metadata/season/children')rows=multi?[episode,second]:[episode];
    if(url.pathname==='/library/metadata/ep1')rows=[detailed];
    if(url.pathname==='/library/metadata/ep2')rows=[secondDetail];
    if(url.pathname==='/library/parts/part' || url.pathname==='/library/parts/part2' ||
       url.pathname==='/video/:/transcode/universal/stop' ||
       url.pathname==='/style' || url.pathname==='/scrobble')return route.fulfill({json:{}});
    if(url.pathname==='/:/scrobble' || url.pathname==='/:/unscrobble')
      return route.fulfill({contentType:'application/xml',body:'<MediaContainer size="0"/>'});
    if(url.pathname.startsWith('/:/') || url.pathname.endsWith('/start.m3u8'))return route.fulfill({json:{}});
    return route.fulfill({json:{MediaContainer:{Metadata:rows,totalSize:rows.length}}});
  });
  await page.goto('/');
  return calls;
}

async function movieServer(page) {
  const calls=[];
  const movie={ratingKey:'movie',type:'movie',title:'Example Movie',duration:120000,
    Media:[
      {container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'movie-part-0',key:'/first.mp4'}]},
      {container:'mp4',videoCodec:'h264',audioCodec:'aac',Part:[{id:'movie-part-1',key:'/second.mp4'}]}
    ]};
  const detailed={...movie,Media:movie.Media.map((media,index)=>({...media,
    Part:[{...media.Part[0],Stream:[
      {streamType:2,id:index?12:11,languageCode:index?'fra':'eng',selected:1,codec:'aac'},
      {streamType:2,id:index?13:14,languageCode:index?'eng':'fra',codec:'aac'},
      {streamType:3,id:index?22:21,languageCode:'spa',codec:'srt'}
    ]}]}))};
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'test',active:'plex',servers:[{id:'plex',kind:'plex',name:'Plex',
      url:'http://plex.test',token:'fixture'}]
  })));
  await page.route('http://plex.test/**',route=>{
    const req=route.request(),url=new URL(req.url());
    calls.push({path:url.pathname,method:req.method(),params:url.searchParams.toString()});
    if(url.pathname==='/hubs')return route.fulfill({json:{MediaContainer:{
      Hub:[{title:'Recently added',Metadata:[movie]}]
    }}});
    if(url.pathname==='/library/metadata/movie')
      return route.fulfill({json:{MediaContainer:{Metadata:[detailed]}}});
    if(req.method()==='PUT' || url.pathname.startsWith('/video/:/transcode'))
      return route.fulfill({contentType:'application/xml',body:'<MediaContainer />'});
    return route.fulfill({json:{MediaContainer:{Metadata:[]}}});
  });
  await page.goto('/');
  return calls;
}

test('season episode metadata matches Plezy weight and separator spacing',async({page})=>{
  await seasonServer(page);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:/Season 1/}).click();
  const row=page.locator('.episode-entry').first();
  const meta=row.locator('.episode-row-meta');
  await expect(meta).toHaveCSS('font-weight','400');
  await expect(meta.locator('.episode-row-meta-value')).toHaveCount(3);
  await expect(meta.locator('.episode-row-meta-separator')).toHaveCount(2);
  const spacing=await row.evaluate(node=>{
    const summary=node.querySelector('.episode-summary').getBoundingClientRect();
    const metadata=node.querySelector('.episode-row-meta');
    const children=Array.from(metadata.children).map(child=>child.getBoundingClientRect());
    return {
      above:metadata.getBoundingClientRect().top-summary.bottom,
      before:children[1].left-children[0].right,
      after:children[2].left-children[1].right
    };
  });
  expect(spacing.above).toBeGreaterThanOrEqual(5.5);
  expect(spacing.above).toBeLessThanOrEqual(6.5);
  expect(spacing.before).toBeGreaterThanOrEqual(8.5);
  expect(spacing.after).toBeGreaterThanOrEqual(8.5);
});

test('season episode overflow changes watched state without starting playback',async({page})=>{
  const calls=await seasonServer(page);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:/Season 1/}).click();
  const row=page.locator('.episode-entry');
  await expect(row).toHaveCount(1);
  const more=row.getByRole('button',{name:'More options for 1. The First Episode'});
  // EpisodeCard uses an icon-only overflow action, not a visible label
  // protruding from underneath the ellipsis disc.
  await expect(more).toHaveText('');
  await expect(more.locator('svg')).toHaveCount(1);
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
  await expect(page.locator('#dialog')).toBeVisible();
  await expect(page.locator('.episode-track-column').first().getByRole('button',{name:'French'}))
    .toHaveAttribute('aria-pressed','true');
  await page.locator('.episode-track-column').last().getByRole('button',{name:'Spanish'}).click();
  await expect(page.locator('.episode-track-column').last().getByRole('button',{name:'Spanish'}))
    .toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#dialog')).toBeVisible();
  await expect.poll(()=>calls.some(call=>call.path==='/library/parts/part' &&
    new URLSearchParams(call.params).get('subtitleStreamID')==='22')).toBe(true);
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
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

test('detail action-row status shows playable stream choices and updates without moving focus',async({page})=>{
  const calls=await seasonServer(page,true);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  const status=page.locator('.detail-playback-tracks');
  await expect(status).toHaveAttribute('aria-label',
    'Audio & Subtitles: 1080p, H.264, English · AAC, Off');
  await expect(status.locator('svg')).toHaveCount(2);
  await expect(status).not.toHaveAttribute('data-focus',/./);
  const row=page.locator('.detail-actions');
  const geometry=await page.evaluate(()=>{
    const status=document.querySelector('.detail-playback-tracks').getBoundingClientRect();
    const row=document.querySelector('.detail-actions').getBoundingClientRect();
    const hero=document.querySelector('.detail').getBoundingClientRect();
    return {right:hero.right-status.right, bottom:row.bottom-status.bottom,
      left:status.left-hero.left, width:hero.width};
  });
  expect(geometry.right).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.bottom)).toBeLessThanOrEqual(1);
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.width*.6-1);
  const more=page.getByRole('button',{name:'More options',exact:true});
  await more.click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await page.locator('.episode-track-column').first().getByRole('button',{name:'French'}).click();
  await page.locator('.episode-track-column').last().getByRole('button',{name:'Spanish'}).click();
  await expect(status).toHaveAttribute('aria-label',
    'Audio & Subtitles: 1080p, H.264, French · AC3, Spanish · SRT');
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await expect.poll(()=>calls.some(call=>call.path==='/library/parts/part2' &&
    new URLSearchParams(call.params).get('subtitleStreamID')==='52')).toBe(true);
  await page.getByRole('button',{name:/Season 1/}).click();
  await expect(page.locator('.detail-playback-tracks')).toHaveAttribute('aria-label',
    'Audio & Subtitles: 1080p, H.264, French · AC3, Spanish · SRT');
  await page.getByRole('button',{name:/The First Episode/}).first().click();
  await expect(page.locator('#player')).toBeVisible();
  await expect(page.locator('.detail-playback-tracks')).toHaveAttribute('aria-label',
    'Audio & Subtitles: 1080p, H.264, French · AC3, Spanish · SRT');
  // Back restores a detached detail DOM rather than rebuilding its route.
  // Its status must still respond to choices made after the restoration.
  // The episode tile starts video. Explicitly stop and wait for focus to
  // return before navigating Back; two rapid Escapes can race the fixture's
  // failing decoder and leave the video overlay above the detail screen.
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(page.locator('#player')).toBeHidden();
  await expect(page.getByRole('button',{name:/The First Episode/}).first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(status).toHaveAttribute('aria-label',
    'Audio & Subtitles: 1080p, H.264, French · AC3, Spanish · SRT');
  await more.click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await page.locator('.episode-track-column').last().getByRole('button',{name:'Off'}).click();
  await expect(status).toHaveAttribute('aria-label',
    'Audio & Subtitles: 1080p, H.264, French · AC3, Off');
  await page.setViewportSize({width:920,height:600});
  await expect(status.locator('.detail-playback-tracks-line')).toContainText('Off');
  const fitted=await status.evaluate(node=>({
    rendered:node.querySelector('.detail-playback-tracks-line').getBoundingClientRect().width,
    available:node.clientWidth
  }));
  expect(fitted.rendered).toBeLessThanOrEqual(fitted.available+1);
});

test('movie track status follows version changes and selected subtitles including Off',async({page})=>{
  await movieServer(page);
  await page.getByRole('button',{name:'Example Movie'}).first().click();
  const status=page.locator('.detail-playback-tracks');
  await expect(status).toHaveAttribute('aria-label', 'Audio & Subtitles: H.264, English · AAC, Off');
  await page.getByRole('combobox',{name:'Media version'}).selectOption('1');
  await expect(status).toHaveAttribute('aria-label', 'Audio & Subtitles: H.264, French · AAC, Off');
  await page.getByRole('button',{name:'More options',exact:true}).click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await page.locator('.episode-track-column').last().getByRole('button',{name:'Spanish'}).click();
  await expect(status).toHaveAttribute('aria-label','Audio & Subtitles: H.264, French · AAC, Spanish · SRT');
});

test('movie context menu selects tracks for the chosen version before starting playback',async({page})=>{
  const calls=await movieServer(page);
  await page.getByRole('button',{name:'Example Movie'}).first().click();
  await page.getByRole('combobox',{name:'Media version'}).selectOption('1');
  const more=page.getByRole('button',{name:'More options',exact:true});
  await more.click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await expect(page.locator('.episode-track-columns .episode-track-column')).toHaveCount(2);
  await expect(page.locator('.episode-track-column').first().getByRole('button',{name:'French'}))
    .toHaveAttribute('aria-pressed','true');
  await page.locator('.episode-track-column').first().getByRole('button',{name:'English'}).click();
  await page.locator('.episode-track-column').last().getByRole('button',{name:'Spanish'}).click();
  await expect(page.locator('#player')).toBeHidden();
  expect(calls.filter(call=>call.method==='PUT')).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await expect.poll(()=>calls.some(call=>{
    const params=new URLSearchParams(call.params);
    return call.path==='/library/parts/movie-part-1' && call.method==='PUT' &&
      params.get('audioStreamID')==='13' && params.get('subtitleStreamID')==='22';
  })).toBe(true);
  expect(calls.some(call=>call.path==='/library/parts/movie-part-0' && call.method==='PUT')).toBe(false);
});

test('show and season context menus choose the same episode as Play, carrying its track intent',async({page})=>{
  const calls=await seasonServer(page,true);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:'More options',exact:true}).click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await expect(page.getByRole('heading',{name:'Audio & Subtitles · The First Episode'})).toBeVisible();
  await page.locator('.episode-track-column').first().getByRole('button',{name:'French'}).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:/Season 1/}).click();
  await page.getByRole('button',{name:'More options',exact:true}).click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await expect(page.locator('.episode-track-column').first().getByRole('button',{name:'French'}))
    .toHaveAttribute('aria-pressed','true');
  await page.locator('.episode-track-column').last().getByRole('button',{name:'Off'}).click();
  await page.keyboard.press('Escape');
  await expect.poll(()=>calls.some(call=>call.path==='/library/parts/part2' &&
    new URLSearchParams(call.params).get('audioStreamID')==='42')).toBe(true);
  await page.locator('.episode-row').nth(1).click();
  await expect.poll(()=>calls.some(call=>{
    const params=new URLSearchParams(call.params);
    return call.path==='/library/parts/part2' && call.method==='PUT' &&
      params.get('audioStreamID')==='42' && params.get('subtitleStreamID')==='0';
  })).toBe(true);
});

test('language choices from an episode menu carry into another episode with different stream IDs',async({page})=>{
  const calls=await seasonServer(page,true);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:/Season 1/}).click();
  const more=page.getByRole('button',{name:'More options for 1. The First Episode'});
  await more.click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await page.locator('.episode-track-column').first().getByRole('button',{name:'French'}).click();
  await page.locator('.episode-track-column').last().getByRole('button',{name:'Spanish'}).click();
  await page.keyboard.press('Escape');
  const moreSecond=page.getByRole('button',{name:'More options for 2. The Second Episode'});
  await moreSecond.click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await expect(page.locator('.episode-track-column').first().getByRole('button',{name:'French'}))
    .toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.episode-track-column').last().getByRole('button',{name:'Spanish'}))
    .toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Escape');
  await page.locator('.episode-row').nth(1).click();
  await expect.poll(()=>calls.some(call=>{
    const params=new URLSearchParams(call.params);
    return call.path==='/library/parts/part2' && call.method==='PUT' &&
      params.get('audioStreamID')==='42' && params.get('subtitleStreamID')==='52';
  })).toBe(true);
});

test('subtitle Off carries between episodes and player audio changes update the show preference',async({page})=>{
  const calls=await seasonServer(page,true);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:/Season 1/}).click();
  await page.locator('.episode-row').first().click();
  await expect(page.locator('#player')).toBeVisible();
  await page.locator('[data-action="tracks-options"]').click();
  await expect(page.locator('.player-track-columns')).toBeVisible();
  await page.locator('.player-track-column').first().getByRole('button',{name:/French/}).click();
  await expect.poll(()=>calls.some(call=>call.path==='/library/parts/part' &&
    new URLSearchParams(call.params).get('audioStreamID')==='12')).toBe(true);
  await page.locator('[data-action="stop"]').click();
  await expect(page.locator('#player')).toBeHidden();
  const second=page.getByRole('button',{name:'More options for 2. The Second Episode'});
  await second.click();
  await page.getByRole('button',{name:'Audio & Subtitles'}).click();
  await expect(page.locator('.episode-track-column').first().getByRole('button',{name:'French'}))
    .toHaveAttribute('aria-pressed','true');
  await page.locator('.episode-track-column').last().getByRole('button',{name:'Off'}).click();
  await expect(page.locator('#dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.episode-row').first().click();
  await expect.poll(()=>calls.some(call=>{
    const params=new URLSearchParams(call.params);
    return call.path==='/library/parts/part' && call.method==='PUT' &&
      params.get('audioStreamID')==='12' && params.get('subtitleStreamID')==='0';
  })).toBe(true);
});

test('explicit player choices survive relaunch and reach the matching tracks on a sibling',async({page})=>{
  const calls=await seasonServer(page,true,(first,next,listing)=>{
    delete first.grandparentRatingKey;
    const streams=first.Media[0].Part[0].Stream;
    streams[3].languageCode='eng';
    streams[3].displayTitle='English (SRT)';
    streams[3].extendedDisplayTitle='English Dialogue (SRT)';
    const target=next.Media[0].Part[0].Stream;
    target[0].selected=0;
    target[1].selected=1;
    target[2].languageCode='eng';
    target[2].displayTitle='English (SRT)';
    target[2].extendedDisplayTitle='English Dialogue (SRT)';
    target[3].languageCode='eng';
    target[3].displayTitle='English (SRT)';
    target[3].extendedDisplayTitle='English Signs (SRT)';
    target[3].selected=1;
    // A listing with both track types can still omit the desired streams.
    listing.Media[0].Part[0].Stream=[target[1],target[3]];
  });
  const openSeason=async()=>{
    await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
    await page.getByRole('button',{name:/Season 1/}).click();
  };
  await openSeason();
  await page.locator('.episode-row').first().click();
  await page.locator('[data-action="tracks-options"]').click();
  const english=page.locator('.player-track-column').first().getByRole('button',{name:/English/});
  await expect(english).toHaveAttribute('aria-pressed','true');
  const starts=calls.filter(call=>call.path.endsWith('/start.m3u8')).length;
  await english.click();
  await expect.poll(()=>calls.some(call=>call.path==='/library/parts/part' &&
    new URLSearchParams(call.params).get('audioStreamID')==='11')).toBe(true);
  expect(calls.filter(call=>call.path.endsWith('/start.m3u8'))).toHaveLength(starts);
  await page.locator('.player-track-column').last().getByRole('button',{name:/Dialogue/}).click();
  await expect.poll(()=>calls.some(call=>call.path==='/library/parts/part' &&
    new URLSearchParams(call.params).get('subtitleStreamID')==='22')).toBe(true);
  await page.reload();
  await openSeason();
  await page.locator('.episode-row').nth(1).click();
  await expect.poll(()=>calls.some(call=>{
    const params=new URLSearchParams(call.params);
    return call.method==='PUT' && call.path==='/library/parts/part2' &&
      params.get('audioStreamID')==='41' && params.get('subtitleStreamID')==='51';
  })).toBe(true);
  await expect(page.locator('#player video')).toHaveAttribute('src',/audioStreamID=41/);
});

test('another Plex client sees Japanese audio and full ASS on an unopened episode',async({page})=>{
  const calls=await seasonServer(page,true,(first,next)=>{
    next.parentRatingKey='season2';
    const tracks=ids=>[
      {streamType:2,id:ids[0],languageCode:'eng',codec:'aac',selected:1},
      {streamType:2,id:ids[1],languageCode:'jpn',codec:'aac'},
      {streamType:3,id:ids[2],languageCode:'eng',codec:'ass',title:'Signs & Songs',selected:1},
      {streamType:3,id:ids[3],languageCode:'eng',codec:'ass',title:'Full subtitles'}
    ];
    first.Media[0].Part[0].Stream=tracks([11,12,21,22]);
    next.Media[0].Part[0].Stream=tracks([43,42,54,51]).reverse();
  });
  await page.getByRole('button',{name:/The First Episode/}).first().click();
  await page.locator('.detail-play').click();
  await page.locator('[data-action="tracks-options"]').click();
  await page.locator('.player-track-column').first().getByRole('button',{name:/Japanese/}).click();
  await page.locator('.player-track-column').last().getByRole('button',{name:/Full subtitles/}).click();
  const reader=await page.context().newPage();
  await expect.poll(async()=>{
    const response=await reader.goto('http://plex.test/library/metadata/ep2?X-Plex-Token=fixture');
    const {MediaContainer}=await response.json();
    return MediaContainer.Metadata[0].Media[0].Part[0].Stream.filter(s=>s.selected).map(s=>s.id).sort();
  }).toEqual([42,51]);
  expect(calls.some(call=>call.path.includes('/transcode/') &&
    new URLSearchParams(call.params).get('path')==='/library/metadata/ep2')).toBe(false);
});

test('marking a season updates every visible episode without replacing rows',async({page})=>{
  await seasonServer(page,true);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:/Season 1/}).click();
  await expect(page.locator('.episode-entry')).toHaveCount(2);
  await page.evaluate(()=>{window.savedEpisodeRow=document.querySelector('.episode-entry');});
  await page.getByRole('button',{name:'Mark watched',exact:true}).click();
  await expect(page.locator('.episode-entry .badge')).toHaveCount(2);
  await expect(page.locator('.episode-entry .episode-progress')).toHaveCount(0);
  await page.getByRole('button',{name:'Mark unwatched',exact:true}).click();
  await expect(page.locator('.episode-entry .badge')).toHaveCount(0);
  expect(await page.evaluate(()=>document.querySelector('.episode-entry')===window.savedEpisodeRow)).toBe(true);
});

test('episode refresh retains an unchanged row and its overflow focus',async({page})=>{
  await seasonServer(page,true);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:/Season 1/}).click();
  const more=page.getByRole('button',{name:'More options for 1. The First Episode'});
  await more.focus();
  const result=await page.evaluate(async()=>{
    const grid=document.querySelector('.episode-list');
    const original=grid.firstElementChild;
    const focused=document.activeElement;
    const items=Array.from(grid.children).map(row=>JSON.parse(JSON.stringify(row._catalogItem)));
    items[1].summary='Changed second episode';
    await grid._applyCatalogUpdate(0,{changed:true,value:{items,total:items.length}});
    return {retained:grid.firstElementChild===original,focused:document.activeElement===focused};
  });
  expect(result).toEqual({retained:true,focused:true});
});

test('a newer episode Play request wins when metadata returns out of order',async({page})=>{
  await seasonServer(page,true);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:/Season 1/}).click();
  let finishFirst,requested=false;
  const delayed=new Promise(resolve=>{finishFirst=resolve;});
  await page.route('http://plex.test/library/metadata/ep1**',async route=>{
    requested=true;
    await delayed;
    return route.fulfill({json:{MediaContainer:{Metadata:[{
      ratingKey:'ep1',type:'episode',title:'The First Episode',duration:120000,
      Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
        Part:[{id:'part',key:'/fixture.mp4',Stream:[]}]}]
    }]}}});
  });
  await page.locator('.episode-row').first().click();
  await expect.poll(()=>requested).toBe(true);
  await page.locator('.episode-row').nth(1).click();
  await expect(page.locator('.player-title')).toHaveText('The Second Episode');
  finishFirst();
  await page.waitForTimeout(300);
  await expect(page.locator('.player-title')).toHaveText('The Second Episode');
});

test('an explicit episode unwatch survives a refresh after marking its season watched',async({page})=>{
  await seasonServer(page,true);
  await page.getByRole('button',{name:'Example Series',exact:true}).first().click();
  await page.getByRole('button',{name:/Season 1/}).click();
  await page.getByRole('button',{name:'Mark watched',exact:true}).click();
  await expect(page.locator('.episode-entry .badge')).toHaveCount(2);
  await page.getByRole('button',{name:'More options for 1. The First Episode'}).click();
  await page.getByRole('button',{name:'Mark as Unwatched',exact:true}).click();
  await expect(page.locator('.episode-entry').first().locator('.badge')).toHaveCount(0);
  await page.evaluate(async()=>{
    const grid=document.querySelector('.episode-list');
    const items=Array.from(grid.children).map(row=>JSON.parse(JSON.stringify(row._catalogItem)));
    items.forEach(item=>{item.watched=true;item.raw.viewCount=1;});
    await grid._applyCatalogUpdate(0,{changed:true,value:{items,total:items.length}});
  });
  await expect(page.locator('.episode-entry').first().locator('.badge')).toHaveCount(0);
  await expect(page.locator('.episode-entry').last().locator('.badge')).toHaveCount(1);
});
