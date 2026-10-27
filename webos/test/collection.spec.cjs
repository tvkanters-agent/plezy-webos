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
  expect(calls).toContain('/library/collections/movie-collection/children');
  expect(calls).toContain('/library/collections/tv-collection/children');
  expect(calls).not.toContain('/library/collections/unrelated/children');
});
