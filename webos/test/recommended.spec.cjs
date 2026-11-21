const {test, expect} = require('@playwright/test');

// Plex Recommended can return multiple hubs with identical headings. The
// hubIdentifier is the stable identity when shelves change position or title.
function hubs(phase) {
  const rows = Array.from({length:6}, (_,row) => ({
    hubIdentifier:'hub-'+row,
    title:'Shelf '+row,
    Metadata:Array.from({length:15}, (_,i) => ({
      ratingKey:row+'-'+i, title:phase >= 1 && row === 1 && i === 2
        ? 'Updated film 1-2' : 'Film '+row+'-'+i,
      type:'movie',thumb:'/library/metadata/'+row+'-'+i+'/thumb/123'
    }))
  }));
  if (phase >= 2) {
    rows[1].Metadata = [rows[1].Metadata[4], ...rows[1].Metadata.slice(1,4),
      ...rows[1].Metadata.slice(5), {
        ratingKey:'1-new',title:'New film 1',type:'movie',
        thumb:'/library/metadata/1-new/thumb/123'
      }];
    rows.splice(0, 1);
    rows.unshift(rows.splice(4, 1)[0]);
    rows.push({hubIdentifier:'hub-6',title:'New shelf',
      Metadata:[{ratingKey:'6-0',title:'New shelf film',type:'movie'}]});
  }
  return rows;
}

async function mockRecommendedPlex(page) {
  await page.addInitScript(() => localStorage.setItem('plezy.webos', JSON.stringify({
    deviceId:'device', active:'plex', quality:'auto',
    servers:[{id:'plex',kind:'plex',name:'Plex test',url:'http://plex.test',token:'token'}]
  })));
  const state = {phase:0, requests:0, gate:null, release:null};
  await page.route('http://plex.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/thumb/') || path.startsWith('/photo/')) {
      return route.fulfill({contentType:'image/svg+xml',
        body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>'});
    }
    if (path === '/library/sections/1/hubs') {
      state.requests++;
      if (state.gate) await state.gate;
      return route.fulfill({json:{MediaContainer:{Hub:hubs(state.phase)}}});
    }
    if (path === '/library/sections') return route.fulfill({
      json:{MediaContainer:{Directory:[{key:'1',title:'Movies',type:'movie'}]}}
    });
    if (path === '/hubs') return route.fulfill({
      json:{MediaContainer:{Hub:[{title:'On Deck',
        Metadata:[{ratingKey:'home-1',title:'Home film',type:'movie'}]}]}}
    });
    return route.fulfill({json:{MediaContainer:{Metadata:[],Directory:[],Hub:[]}}});
  });
  return state;
}

async function enterRecommended(page) {
  await page.goto('/');
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await page.getByRole('button',{name:'Recommended',exact:true}).click();
  await expect(page.locator('#main .shelf')).toHaveCount(6);
}

test('restored Recommended revalidates only changed cards and retains focus, artwork and scroll', async ({page}) => {
  const state = await mockRecommendedPlex(page);
  await enterRecommended(page);
  const initial = await page.evaluate(() => {
    const pane = document.querySelector('#main');
    const shelves = pane.querySelectorAll('.shelf');
    const row = shelves[1].querySelector('.cards');
    const card = row.children[4];
    card.focus();
    row.scrollLeft = 450;
    pane.scrollTop = 300;
    window.recommendedNodes = {
      first:shelves[0], second:shelves[1], third:shelves[2],
      unchanged:card, image:card.querySelector('img'),
      changed:row.children[2], row
    };
    return {left:row.scrollLeft, top:pane.scrollTop};
  });
  expect(initial.left).toBeGreaterThan(0);
  expect(initial.top).toBeGreaterThan(0);

  state.phase = 1;
  let finishRefresh;
  state.gate = new Promise(resolve => { finishRefresh = resolve; });
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await expect(page.locator('#main .shelf')).toHaveCount(6);
  // A pointer click on the rail intentionally focuses the rail. Focus the
  // unchanged card again before releasing the pending background refresh.
  expect(await page.evaluate(() => {
    const saved = window.recommendedNodes;
    saved.unchanged.focus();
    saved.row.scrollLeft = 450;
    document.querySelector('#main').scrollTop = 300;
    return document.activeElement === saved.unchanged;
  })).toBe(true);
  finishRefresh();
  await expect(page.getByRole('button',{name:'Updated film 1-2',exact:true})).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => {
    const pane = document.querySelector('#main');
    const saved = window.recommendedNodes;
    const second = pane.querySelectorAll('.shelf')[1];
    return {
      shelves:saved.first===pane.querySelectorAll('.shelf')[0] &&
        saved.second===second && saved.third===pane.querySelectorAll('.shelf')[2],
      card:saved.unchanged===second.querySelectorAll('.card')[4],
      artwork:saved.image===saved.unchanged.querySelector('img'),
      replaced:saved.changed!==second.querySelectorAll('.card')[2],
      focused:document.activeElement===saved.unchanged,
      left:saved.row.scrollLeft, top:pane.scrollTop
    };
  })).toEqual({
    shelves:true,card:true,artwork:true,replaced:true,focused:true,
    left:initial.left,top:initial.top
  });

  // Reorder existing hubs, remove one, append a new one and reorder items.
  // Surviving sections and cards should remain the same physical nodes.
  await page.evaluate(() => {
    const pane = document.querySelector('#main');
    window.recommendedSurvivor = pane.querySelectorAll('.shelf')[5];
    window.recommendedItem = pane.querySelectorAll('.shelf')[1]
      .querySelectorAll('.card')[4];
  });
  state.phase = 2;
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await expect(page.locator('#main .shelf')).toHaveCount(6);
  await expect(page.locator('#main .shelf h2').first()).toHaveText('Shelf 5');
  await expect(page.locator('#main .shelf h2').last()).toHaveText('New shelf');
  await expect(page.locator('#main .shelf').nth(1).locator('.card').first())
    .toHaveAttribute('aria-label','Film 1-4');
  expect(await page.evaluate(() => ({
    moved:window.recommendedSurvivor===document.querySelector('#main .shelf'),
    item:window.recommendedItem===document.querySelectorAll('#main .shelf')[1]
      .querySelector('.card')
  }))).toEqual({moved:true,item:true});
});

test('persistent Recommended cache refresh preserves the initially displayed cards', async ({page}) => {
  const state = await mockRecommendedPlex(page);
  await enterRecommended(page);
  await expect.poll(() => page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('plezy-catalog-v1', 1);
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('pages','readonly');
      const cursor = tx.objectStore('pages').openCursor();
      let found = false;
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (String(entry.key).includes(':recommended:1')) found = true;
        entry.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(found); };
      tx.onerror = () => { db.close(); resolve(false); };
    };
  }))).toBe(true);
  state.phase = 1;
  let release;
  state.gate = new Promise(resolve => { release = resolve; });
  await page.reload();
  await page.getByRole('button',{name:'Movies',exact:true}).click();
  await page.getByRole('button',{name:'Recommended',exact:true}).click();
  await expect(page.locator('#main .shelf')).toHaveCount(6);
  await expect(page.getByRole('button',{name:'Film 1-2',exact:true})).toHaveCount(1);
  await page.evaluate(() => {
    window.cachedCard = document.querySelectorAll('#main .shelf')[0]
      .querySelector('.card');
    window.cachedImage = window.cachedCard.querySelector('img');
  });
  release();
  await expect(page.getByRole('button',{name:'Updated film 1-2',exact:true})).toHaveCount(1);
  expect(await page.evaluate(() => {
    const card = document.querySelectorAll('#main .shelf')[0].querySelector('.card');
    return window.cachedCard===card && window.cachedImage===card.querySelector('img');
  })).toBe(true);
});
