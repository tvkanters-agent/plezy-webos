const {test,expect} = require('@playwright/test');
const {readFile} = require('node:fs/promises');
const path = require('node:path');

async function mockPlexShow(page, empty = false) {
  await page.addInitScript(() => localStorage.setItem('plezy.webos', JSON.stringify({
    deviceId:'device',active:'plex',servers:[
      {id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'token'}
    ]
  })));
  const video = await readFile(path.join(__dirname,'fixtures/test.webm'));
  const show = {ratingKey:'show',type:'show',title:'Test Series'};
  const seasons = [
    {ratingKey:'s1',type:'season',title:'Season One',parentRatingKey:'show',index:1},
    {ratingKey:'s2',type:'season',title:'Season Two',parentRatingKey:'show',index:2}
  ];
  const episode = (id,title,season) => ({
    ratingKey:id,type:'episode',title,grandparentRatingKey:'show',
    parentRatingKey:season,index:1,grandparentTitle:'Test Series',
    duration:120000,Media:[{container:'mp4',videoCodec:'h264',audioCodec:'aac',
      Part:[{id:id+'part',key:'/video.webm'}]}]
  });
  const episodes = {
    s1:empty ? [] : [episode('e1','Season One Episode','s1')],
    s2:empty ? [] : [episode('e2','Season Two Episode','s2')]
  };
  const calls = [];
  await page.route('http://plex.test/**',async route => {
    const url = new URL(route.request().url());
    calls.push(url.pathname);
    if (url.pathname === '/video.webm')
      return route.fulfill({contentType:'video/webm',body:video});
    if (url.pathname === '/hubs')
      return route.fulfill({json:{MediaContainer:{Hub:[{title:'Shows',Metadata:[show]}]}}});
    if (url.pathname === '/library/metadata/show/onDeck')
      return route.fulfill({json:{MediaContainer:{Metadata:[]}}});
    const child = /^\/library\/metadata\/([^/]+)\/children$/.exec(url.pathname);
    if (child) {
      const id = child[1], rows = id === 'show' ? seasons : episodes[id] || [];
      const start = Number(url.searchParams.get('X-Plex-Container-Start') || 0);
      const size = Number(url.searchParams.get('X-Plex-Container-Size') || 60);
      return route.fulfill({json:{MediaContainer:{
        Metadata:rows.slice(start,start+size),totalSize:rows.length
      }}});
    }
    const detail = /^\/library\/metadata\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      const id = detail[1];
      const item = id === 'show' ? show : seasons.find(s => s.ratingKey === id) ||
        Object.values(episodes).flat().find(e => e.ratingKey === id);
      return route.fulfill({json:{MediaContainer:{Metadata:item ? [item] : []}}});
    }
    return route.fulfill({json:{MediaContainer:{Metadata:[]}}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Test Series',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Test Series',exact:true})).toBeVisible();
  return calls;
}

test('Plex show Shuffle opens an episode from seasons rather than reporting no episodes',async({page})=>{
  const calls = await mockPlexShow(page);
  await page.getByRole('button',{name:'Shuffle',exact:true}).click();
  await expect(page.locator('#player')).toBeVisible();
  await expect(page.locator('#player .player-title')).toHaveText(/Season (One|Two) Episode/);
  expect(calls).toContain('/library/metadata/s1/children');
  expect(calls).toContain('/library/metadata/s2/children');
});

test('Plex season Shuffle plays only that season\'s episodes',async({page})=>{
  const calls = await mockPlexShow(page);
  await page.getByRole('button',{name:'Season One',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Season One',exact:true})).toBeVisible();
  const start = calls.length;
  await page.getByRole('button',{name:'Shuffle',exact:true}).click();
  await expect(page.locator('#player .player-title')).toHaveText('Season One Episode');
  expect(calls.slice(start)).not.toContain('/library/metadata/s2/children');
});

test('Plex show Shuffle with empty seasons retains the detail page',async({page})=>{
  await mockPlexShow(page,true);
  await page.getByRole('button',{name:'Shuffle',exact:true}).click();
  await expect(page.locator('#toast')).toHaveText('No playable episodes were found.');
  await expect(page.locator('#player')).toBeHidden();
  await expect(page.getByRole('heading',{name:'Test Series',exact:true})).toBeVisible();
});
