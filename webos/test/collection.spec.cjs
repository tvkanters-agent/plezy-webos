const {test, expect} = require('@playwright/test');

test('same-named Plex collections show movies and series across libraries', async ({page}) => {
  await page.addInitScript(() => localStorage.setItem('plezy.webos', JSON.stringify({
    deviceId: 'device', active: 'plex', servers: [{
      id: 'plex', kind: 'plex', name: 'Plex', url: 'http://plex.test', token: 'token'
    }]
  })));
  const filmCollection = {ratingKey:'movie-collection',type:'collection',title:'Favorites',librarySectionID:1};
  const tvCollection = {ratingKey:'tv-collection',type:'collection',title:'favorites',librarySectionID:2};
  const film = {ratingKey:'film',type:'movie',title:'A Favorite Film'};
  const show = {ratingKey:'show',type:'show',title:'A Favorite Series'};
  const calls = [];
  await page.route('http://plex.test/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    calls.push(path);
    let metadata = [], directory = [];
    if (path === '/library/sections') directory = [
      {key:'1',title:'Movies',type:'movie'}, {key:'2',title:'Series',type:'show'}
    ];
    if (path === '/library/sections/1/collections') metadata = [filmCollection];
    if (path === '/library/sections/2/collections') metadata = [tvCollection,
      {ratingKey:'unrelated',type:'collection',title:'Favorites Part Two',librarySectionID:2}];
    if (path === '/library/collections/movie-collection') metadata = [filmCollection];
    if (path === '/library/collections/movie-collection/children') metadata = [film];
    if (path === '/library/collections/tv-collection/children') metadata = [show];
    if (path === '/library/sections/1/all') metadata = [film];
    if (path === '/hubs') return route.fulfill({json:{MediaContainer:{Hub:[]}}});
    return route.fulfill({json:{MediaContainer:{Directory:directory, Metadata:metadata, totalSize:metadata.length}}});
  });
  await page.goto('/');
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  await page.locator('.library-tabs').getByRole('button',{name:'Collections'}).click();
  await page.locator('main').getByRole('button',{name:'Favorites',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Favorites'})).toBeVisible();
  await expect(page.locator('main').getByRole('button',{name:'A Favorite Film'})).toBeVisible();
  await expect(page.locator('main').getByRole('button',{name:'A Favorite Series'})).toBeVisible();
  const sections = page.locator('main .collection-library-section');
  await expect(sections).toHaveCount(2);
  await expect(sections.locator('.detail-children-title')).toHaveText(['Movies','Series']);
  await expect(sections.nth(0).locator('.grid .card')).toHaveCount(1);
  await expect(sections.nth(1).locator('.grid .card')).toHaveCount(1);
  await expect(sections.nth(0).getByRole('button',{name:'A Favorite Film'})).toBeVisible();
  await expect(sections.nth(1).getByRole('button',{name:'A Favorite Series'})).toBeVisible();
  await expect(page.locator('main > .detail-children-title')).toHaveCount(0);
  expect(calls).toContain('/library/collections/movie-collection/children');
  expect(calls).toContain('/library/collections/tv-collection/children');
  expect(calls).not.toContain('/library/collections/unrelated/children');
});

test('paged Plex collections continue the same library section before adding the next', async ({page}) => {
  await page.addInitScript(() => localStorage.setItem('plezy.webos', JSON.stringify({
    deviceId:'device',active:'plex',servers:[{
      id:'plex',kind:'plex',name:'Plex',url:'http://plex.test',token:'token'
    }]
  })));
  const collection = (id,library) => ({
    ratingKey:id,title:'Favorites',type:'collection',librarySectionID:library
  });
  const movieCollection = collection('films',1), tvCollection = collection('shows',2);
  await page.route('http://plex.test/**', route => {
    const url = new URL(route.request().url()), path=url.pathname;
    const start = Number(url.searchParams.get('X-Plex-Container-Start') || 0);
    const films = Array.from({length:61},(_,i)=>({
      ratingKey:'film-'+i,type:'movie',title:'Film '+i
    }));
    let metadata = [], directory = [];
    if(path==='/library/sections') directory=[
      {key:'1',title:'Movies',type:'movie'},{key:'2',title:'TV Shows',type:'show'}
    ];
    if(path==='/library/sections/1/collections')metadata=[movieCollection];
    if(path==='/library/sections/2/collections')metadata=[tvCollection];
    if(path==='/library/collections/films')metadata=[movieCollection];
    if(path==='/library/collections/films/children')metadata=films.slice(start,start+60);
    if(path==='/library/collections/shows/children')metadata=[
      {ratingKey:'show',title:'Series',type:'show'}
    ].slice(start,start+60);
    if(path==='/hubs')return route.fulfill({json:{MediaContainer:{Hub:[]}}});
    const total=path==='/library/collections/films/children'?61:metadata.length;
    return route.fulfill({json:{MediaContainer:{Directory:directory,Metadata:metadata,totalSize:total}}});
  });
  await page.goto('/');
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  await page.locator('.library-tabs').getByRole('button',{name:'Collections'}).click();
  await page.locator('main').getByRole('button',{name:'Favorites'}).click();
  const sections=page.locator('.collection-library-section');
  await expect(sections).toHaveCount(2);
  await expect(sections.locator('h2')).toHaveText(['Movies','TV Shows']);
  await expect(sections.nth(0).locator('.grid .card')).toHaveCount(61);
  await expect(sections.nth(1).locator('.grid .card')).toHaveCount(1);
  await expect(sections.nth(0).getByRole('button',{name:'Film 60'})).toHaveCount(1);
  await expect(sections.nth(1).getByRole('button',{name:'Series'})).toHaveCount(1);
});
