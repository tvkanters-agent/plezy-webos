const {test, expect} = require('@playwright/test');

// PlexAlphaBarStrategy and LibraryBrowseTab parity: server bucket counts,
// sparse offset-jumps, highlighted letter, TV D-pad/Back, sort visibility.
async function mockPlexAlphabet(page, {count = 180} = {}) {
  await page.addInitScript(() => localStorage.setItem('plezy.webos', JSON.stringify({
    deviceId:'device', active:'plex', quality:'auto',
    servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'test-token'}]
  })));
  const calls = [];
  const letters = 'ABCDEF'.split('');
  const media = Array.from({length:count},(_,i) => ({
    ratingKey:String(i), type:'movie',
    title:letters[Math.floor(i/30)] + ' Film ' + String(i).padStart(3,'0')
  }));
  await page.route('http://plex.test/**',route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    calls.push({path,params:Object.fromEntries(url.searchParams.entries())});
    let data = {};
    if (path === '/library/sections') {
      data.Directory = [{key:'movies', title:'Movies', type:'movie'}];
    } else if (path === '/library/sections/movies/firstCharacter') {
      data.Directory = letters.map((letter,i) => ({
        key:letter,title:letter,size:Math.max(0,Math.min(30,count-i*30))
      }));
    } else if (path === '/library/sections/movies/all' ||
               path === '/library/sections/movies/unwatched') {
      const start = Number(url.searchParams.get('X-Plex-Container-Start') || 0);
      const limit = Number(url.searchParams.get('X-Plex-Container-Size') || 60);
      data = {totalSize:count,Metadata:media.slice(start,start+limit)};
    } else if (path.indexOf('/library/metadata/') === 0) {
      const key = Number(path.split('/').pop());
      data.Metadata = media[key] ? [media[key]] : [];
    } else if (path === '/hubs' || path === '/hubs/continueWatching') {
      data.Hub = [];
    }
    return route.fulfill({json:{MediaContainer:data}});
  });
  return calls;
}

test('Plex TV alphabet rail jumps to unloaded letters with firstCharacter counts',async({page})=>{
  const calls = await mockPlexAlphabet(page);
  await page.goto('/');
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  const rail=page.getByRole('group',{name:'Alphabet navigation'});
  await expect(rail).toBeVisible();
  await expect(rail.locator('.alpha-letter-slot')).toHaveCount(6);
  await expect(rail.locator('.alpha-letter-slot.current').first()).toContainText('A');
  await rail.getByRole('button',{name:'F',exact:true}).click();
  await expect(page.locator('.alpha-window-grid .card[data-focus="150"]')).toBeVisible();
  await expect.poll(()=>calls.some(call=>call.path.endsWith('/all')&&
    Number(call.params['X-Plex-Container-Start'])>=100)).toBe(true);
  // Jump must not fetch every intervening page or create thousands of nodes.
  expect(calls.filter(call=>call.path.endsWith('/all')).length).toBeLessThan(6);
  await expect(rail.locator('.alpha-letter-slot.highlighted')).toContainText('F');
  await page.keyboard.press('Escape');
  await expect(page.locator('.alpha-window-grid .card:focus')).toHaveCount(1);
  await expect(rail).not.toBeFocused();
  // Native LibraryBrowseTab retains its scroll and alpha state when returning
  // from an item. The webOS snapshot must retain both the rail and the cards.
  await page.locator('.alpha-window-grid .card[data-focus="150"]').click();
  await expect(page.getByRole('heading',{name:'F Film 150'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rail).toBeVisible();
  await expect(page.locator('.alpha-window-grid .card[data-focus="150"]')).toBeVisible();
  const query=calls.find(call=>call.path.endsWith('/firstCharacter'));
  expect(query.params.includeCollections).toBe('1');
});

test('alphabet rail is reachable with right arrow, and up/down request letter jumps',async({page})=>{
  await mockPlexAlphabet(page);
  await page.goto('/');
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  const rail=page.locator('.alpha-jump-bar');
  await expect(rail).toBeVisible();
  // Last card has no right-hand grid neighbor, matching the Flutter grid.
  await page.locator('.alpha-window-grid .card').last().focus();
  await page.keyboard.press('ArrowRight');
  await expect(rail).toBeFocused();
  const before=await rail.locator('.alpha-letter-slot.highlighted').getAttribute('aria-label');
  const order='ABCDEF';
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(175); // Flutter's 150ms D-pad jump debounce.
  await expect(rail.locator('.alpha-letter-slot.highlighted')).toHaveAttribute('aria-label',
    order[Math.min(order.length-1,order.indexOf(before)+1)]);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.alpha-window-grid .card:focus')).toHaveCount(1);
});

test('alpha rail is absent when sort is not title or fewer than 80 titles',async({page})=>{
  await mockPlexAlphabet(page,{count:65});
  await page.goto('/');
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  await expect(page.locator('.alpha-jump-bar')).toHaveCount(0);
  await expect(page.locator('.alpha-window-grid')).toHaveCount(0);
});

test('MediaBrowser alphabet filters by NameStartsWith and reselect toggles it off',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'device',active:'jellyfin',quality:'auto',
    servers:[{id:'jellyfin',kind:'jellyfin',url:'http://media.test',
      name:'Jellyfin',token:'token',userId:'user'}]
  })));
  const calls=[];
  await page.route('http://media.test/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/Users/user/Views')
      return route.fulfill({json:{Items:[{Id:'movies',Name:'Movies',CollectionType:'movies'}]}});
    if(url.pathname==='/Users/user/Items'){
      calls.push(Object.fromEntries(url.searchParams.entries()));
      const prefix=url.searchParams.get('NameStartsWith');
      const items=Array.from({length:90},(_,i)=>({
        Id:String(i),Name:(i<45?'A':'B')+' Film '+i,Type:'Movie'
      })).filter(item=>!prefix || item.Name.startsWith(prefix));
      const start=Number(url.searchParams.get('StartIndex')||0);
      return route.fulfill({json:{Items:items.slice(start,start+60),TotalRecordCount:items.length}});
    }
    return route.fulfill({json:{Items:[]}});
  });
  await page.goto('/');
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  const bar=page.getByRole('group',{name:'Alphabet navigation'});
  await expect(bar).toBeVisible();
  await expect(bar.locator('.alpha-letter-slot')).toHaveCount(27);
  await expect(bar.locator('.alpha-letter-slot.current')).toHaveCount(0);
  await bar.getByRole('button',{name:'B',exact:true}).click();
  await expect.poll(()=>calls.some(c=>c.NameStartsWith==='B')).toBe(true);
  await expect(bar.locator('.alpha-letter-slot.highlighted')).toContainText('B');
  await bar.getByRole('button',{name:'B',exact:true}).click();
  await expect.poll(()=>calls.filter(c=>!c.NameStartsWith).length).toBeGreaterThan(1);
  // Reselect clears the prefix; Plezy then has no active letter, and
  // entering the unfiltered rail starts from its first navigable slot.
  await expect(bar.locator('.alpha-letter-slot.current')).toHaveCount(0);
  await expect(bar.locator('.alpha-letter-slot.highlighted')).toContainText('#');
  await page.keyboard.press('Escape');
  await expect(page.locator('.grid .card:focus')).toHaveCount(1);
});

test('MediaBrowser nonalphabetical # bucket uses NameLessThan=A',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'device',active:'jellyfin',quality:'auto',
    servers:[{id:'jellyfin',kind:'jellyfin',url:'http://media.test',
      name:'Jellyfin',token:'token',userId:'user'}]
  })));
  const requests=[];
  await page.route('http://media.test/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/Users/user/Views')
      return route.fulfill({json:{Items:[{Id:'movies',Name:'Movies',CollectionType:'movies'}]}});
    if(url.pathname==='/Users/user/Items'){
      requests.push(Object.fromEntries(url.searchParams.entries()));
      return route.fulfill({json:{TotalRecordCount:90,
        Items:Array.from({length:60},(_,i)=>({Id:String(i),Name:'A Film '+i,Type:'Movie'}))}});
    }
    return route.fulfill({json:{Items:[]}});
  });
  await page.goto('/');
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  await page.getByRole('group',{name:'Alphabet navigation'}).getByRole('button',{name:'#'}).click();
  await expect.poll(()=>requests.some(q=>q.NameLessThan==='A' && !q.NameStartsWith)).toBe(true);
});
