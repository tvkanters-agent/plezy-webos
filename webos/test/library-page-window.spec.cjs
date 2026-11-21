const {test, expect} = require('@playwright/test');

async function mockLibrary(page, total, beforePage = () => {}) {
  await page.addInitScript(() => localStorage.setItem('plezy.webos', JSON.stringify({
    deviceId:'device', active:'plex', servers:[{id:'plex', kind:'plex', name:'Plex',
      url:'http://plex.test', token:'test-token'}]
  })));
  const titles = Array.from({length:total}, (_, index) => ({ratingKey:String(index),
    type:'movie', title:'Film ' + index, year:Math.floor(index / 8) % 2 ? undefined : 2020}));
  const requests = [];
  await page.route('http://plex.test/**', async route => {
    const url = new URL(route.request().url());
    let data = {};
    if (url.pathname === '/library/sections') {
      data.Directory = [{key:'movies', title:'Movies', type:'movie'}];
    } else if (url.pathname === '/library/sections/movies/all') {
      const request = {rangeStart:url.searchParams.get('X-Plex-Container-Start'),
        rangeSize:url.searchParams.get('X-Plex-Container-Size'), sort:url.searchParams.get('sort')};
      const {rangeStart, rangeSize} = request;
      requests.push(request);
      const response = await beforePage({...request, titles});
      if (response?.status)
        return route.fulfill({status:response.status, json:{error:'Simulated Plex outage'}});
      data = response?.snapshot || {totalSize:titles.length, Metadata:rangeSize === null ? titles : titles.slice(+rangeStart, +rangeStart + +rangeSize)};
    } else if (url.pathname.startsWith('/library/metadata/')) {
      data.Metadata = titles.filter(item => item.ratingKey === url.pathname.split('/').pop());
    }
    return route.fulfill({json:{MediaContainer:data}});
  });
  return requests;
}

async function chooseDateSort(page, label = 'Recently added') {
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  await page.getByRole('button',{name:'Sort',exact:true}).click();
  await page.getByRole('group',{name:'Sort library'}).getByRole('button',{name:label}).click();
}

async function openDateSort(page, label) {
  await chooseDateSort(page, label);
  await expect(page.locator('.paged-window-grid .card').first()).toBeVisible();
}

const card = (page, id) => page.locator(`.paged-window-grid .card[data-focus="${id}"]`);
const pane = page => page.locator('main');
const cachedSnapshot = (page, plexSort) => page.evaluate(async plexSort => {
  const key = ':date-library:' + JSON.stringify(['movies',
    plexSort === 'addedAt:desc' ? 'recent' : 'release','all']);
  return new Promise(resolve => {
    const request = indexedDB.open('plezy-catalog-v1',1);
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const tx = request.result.transaction('pages','readonly');
      const cursor = tx.objectStore('pages').openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) { resolve(null); return; }
        if (String(row.key).endsWith(key)) resolve(row.value);
        else row.continue();
      };
      cursor.onerror = () => resolve(null);
    };
  });
}, plexSort);
const waitForLayout = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));

for (const [layout, label, sort] of [
  ['grid','Recently added','addedAt:desc'], ['flex','Release date','originallyAvailableAt:desc']
]) {
  test(`date sort bounds mounted posters and focus work through 3,000 titles (${layout})`, async ({page}) => {
    const requests = await mockLibrary(page, 3000);
    if (layout === 'flex') await page.addInitScript(() => { window.IntersectionObserver = undefined; });
    await page.goto('/');
    if (layout === 'flex') await page.addStyleTag({content:`
      .grid { display:flex !important; flex-wrap:wrap !important; gap:0 !important; }
      .grid .card { flex:0 0 170px !important; width:170px !important; margin:0 20px 26px 0 !important; }
    `});
    await openDateSort(page, label);
    await expect(page.locator('.alpha-jump-bar')).toHaveCount(0);
    const counts = [];
    for (const index of [60, 1500, 2940]) {
      await page.locator('.paged-window-grid').evaluate((node, index) => node._libraryWindow.reveal(index), index);
      await waitForLayout(page);
      const result = await pane(page).evaluate(main => {
        const cards = Array.from(main.querySelectorAll('.paged-window-grid .card'));
        const view = main.getBoundingClientRect();
        const origin = cards.find(node => {
          const box = node.getBoundingClientRect();
          return box.top >= view.top && box.bottom <= view.bottom;
        });
        origin.focus();
        const measure = Element.prototype.getClientRects;
        let reads = 0;
        Element.prototype.getClientRects = function() {
          if (this.matches('.paged-window-grid .card')) reads++;
          return measure.call(this);
        };
        try {
          origin.dispatchEvent(new KeyboardEvent('keydown',{keyCode:40,bubbles:true,cancelable:true}));
          return {mounted:cards.length, reads, moved:origin !== document.activeElement};
        } finally { Element.prototype.getClientRects = measure; }
      });
      expect(result.moved).toBe(true);
      expect(result.reads).toBeGreaterThan(0);
      expect(result.reads).toBeLessThanOrEqual(result.mounted);
      expect(result.mounted).toBeLessThanOrEqual(72);
      counts.push(result.mounted);
    }
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(24);
    expect(requests.filter(entry => entry.sort === sort)).toEqual([{sort,rangeStart:null,rangeSize:null}]);

    const focused = page.locator('.paged-window-grid .card:focus');
    const id = await focused.getAttribute('data-focus');
    const scroll = await pane(page).evaluate(node => node.scrollTop);
    await focused.press('Enter');
    await expect(page.getByRole('heading',{name:'Film ' + id,exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card(page,id)).toBeFocused();
    expect(await pane(page).evaluate(node => node.scrollTop)).toBeCloseTo(scroll,0);

    const firstInRow = await card(page,id).evaluate(node => {
      const first = Array.from(node.parentNode.children).find(card => card.offsetTop === node.offsetTop);
      first.focus();
      return first.dataset.focus;
    });
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('nav button:focus')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(card(page,firstInRow)).toBeFocused();
    await page.setViewportSize({width:1600,height:900});
    await expect(card(page,firstInRow)).toBeInViewport();
    await expect(card(page,firstInRow)).toBeFocused();

    await pane(page).evaluate(node => { node.scrollTop = 0; });
    await expect(card(page,'0')).toBeInViewport();
    await page.keyboard.press('ArrowDown');
    await expect(card(page,'0')).toBeFocused();
  });
}

test('a cached date sort paints before refresh and keeps the focused poster on insert and removal', async ({page}) => {
  let refresh = false, release;
  await mockLibrary(page, 90, async ({sort, titles}) => {
    if (!refresh || sort !== 'addedAt:desc') return;
    await new Promise(resolve => { release = resolve; });
    titles.unshift({ratingKey:'new',type:'movie',title:'Inserted Film'});
    titles.splice(3,1);
  });
  await page.goto('/');
  await openDateSort(page);
  await page.reload();
  refresh = true;
  await openDateSort(page);
  await expect.poll(() => !!release).toBe(true);
  await expect(card(page,'2')).toBeVisible();
  await card(page,'10').focus();
  await card(page,'10').evaluate(node => { window.cachedPoster = node; });
  release();
  await expect(card(page,'new')).toBeVisible();
  await expect(card(page,'2')).toHaveCount(0);
  await expect(card(page,'10')).toBeFocused();
  expect(await card(page,'10').evaluate(node => node === window.cachedPoster)).toBe(true);
});

for (const [sortLabel, plexSort] of [
  ['Recently added', 'addedAt:desc'], ['Release date', 'originallyAvailableAt:desc']
]) {
  test(`${sortLabel} replaces a cross-boundary swap as one snapshot and reopens it offline`, async ({page}) => {
    let hold, swap = false, offline = false;
    const requests = await mockLibrary(page, 180, async ({sort, titles}) => {
      if (sort !== plexSort) return;
      if (offline) return {status:503};
      if (swap) {
        await new Promise(resolve => { hold = resolve; });
        [titles[20], titles[130]] = [titles[130], titles[20]];
      }
    });
    const ids = () => page.locator('.paged-window-grid').evaluate(grid =>
      Array.from({length:180}, (_, i) => grid._libraryWindow.reveal(i)?.dataset.focus));
    const original = Array.from({length:180}, (_, i) => String(i));
    const reordered = [...original];
    [reordered[20], reordered[130]] = [reordered[130], reordered[20]];
    await page.goto('/');
    await openDateSort(page, sortLabel);
    await expect.poll(async () => (await cachedSnapshot(page,plexSort))?.data.items.length).toBe(180);
    swap = true;
    await page.reload();
    await openDateSort(page, sortLabel);
    await expect.poll(() => !!hold).toBe(true);
    expect(await ids()).toEqual(original);
    hold();
    await expect.poll(async () => (await cachedSnapshot(page,plexSort))?.data.items[130].id).toBe('20');
    await expect.poll(ids).toEqual(reordered);
    offline = true;
    await page.reload();
    await openDateSort(page, sortLabel);
    expect(await ids()).toEqual(reordered);
    expect(requests.filter(r => r.sort === plexSort)).toEqual(
      Array(3).fill({sort:plexSort,rangeStart:null,rangeSize:null}));
  });

  test(`${sortLabel} rejects a 60-of-180 response and retries the whole sort`, async ({page}) => {
    let cap = true;
    await mockLibrary(page, 180, ({sort,titles}) => {
      if (sort === plexSort && cap)
        return {snapshot:{totalSize:180,Metadata:titles.slice(0,60)}};
    });
    await page.goto('/');
    await chooseDateSort(page, sortLabel);
    const retry = page.getByRole('button',{name:'Retry loading'});
    await expect(retry).toBeVisible();
    await expect(page.getByRole('button',{name:'Browse by title'})).toBeVisible();
    expect(await cachedSnapshot(page,plexSort)).toBeNull();
    cap = false;
    await retry.click();
    await pane(page).evaluate(main => { main.scrollTop = main.scrollHeight; });
    await expect.poll(() => page.locator('.paged-window-grid').evaluate(grid =>
      grid._libraryWindow.reveal(179)?.dataset.focus)).toBe('179');
    await expect(retry).toBeHidden();
  });
}
for (const depth of [3,25,50]) {
  test(`insertion after scrolling ${depth} former pages needs one restore request`, async ({page}) => {
    const total = depth * 60 + 120;
    let insert = false;
    const requests = await mockLibrary(page, total, ({sort,titles}) => {
      if (insert && sort === 'addedAt:desc') {
        titles.unshift({ratingKey:'new',type:'movie',title:'New'});
        insert = false;
      }
    });
    await page.goto('/');
    await openDateSort(page);
    const grid = page.locator('.paged-window-grid');
    const near = depth * 60;
    expect(await grid.evaluate((g,i) => g._libraryWindow.reveal(i)?.dataset.focus, near)).toBe(String(near));
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    insert = true;
    await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
    await expect.poll(() => grid.evaluate(g => g._libraryWindow.reveal(0)?.dataset.focus)).toBe('new');
    expect(await grid.evaluate((g,i) => g._libraryWindow.reveal(i+1)?.dataset.focus, near)).toBe(String(near));
    expect(await grid.evaluate((g,i) => g._libraryWindow.reveal(i)?.dataset.focus, total)).toBe(String(total-1));
    expect(requests.filter(r => r.sort === 'addedAt:desc')).toEqual(
      Array(2).fill({sort:'addedAt:desc',rangeStart:null,rangeSize:null}));
  });
}

test('a capped refresh keeps the complete snapshot and offers working title browsing', async ({page}) => {
  let cap = false;
  await mockLibrary(page, 180, ({sort,titles}) => {
    if (sort === 'addedAt:desc' && cap) return {snapshot:{totalSize:180,Metadata:titles.slice(0,60)}};
  });
  await page.goto('/');
  await openDateSort(page);
  await expect.poll(async () => (await cachedSnapshot(page,'addedAt:desc'))?.data.total).toBe(180);
  cap = true;
  await page.reload();
  await openDateSort(page);
  const byTitle = page.getByRole('button',{name:'Browse by title'});
  await expect(byTitle).toBeVisible();
  expect(await page.locator('.paged-window-grid').evaluate(g => g._libraryWindow.reveal(179)?.dataset.focus)).toBe('179');
  expect((await cachedSnapshot(page,'addedAt:desc')).data.items.length).toBe(180);
  await byTitle.click();
  await expect(page.locator('.paged-window-grid')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Film 0',exact:false}).first()).toBeVisible();
});
