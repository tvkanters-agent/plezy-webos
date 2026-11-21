const {test, expect} = require('@playwright/test');

function pageRequest(url) {
  const rangeStart = Number(url.searchParams.get('X-Plex-Container-Start'));
  const rangeSize = Number(url.searchParams.get('X-Plex-Container-Size'));
  const sort = url.searchParams.get('sort');
  const overlap = ['addedAt:desc','originallyAvailableAt:desc'].includes(sort)
    ? Math.max(0, rangeSize - 60) : 0;
  return {start:rangeStart + overlap, rangeStart, rangeSize, sort};
}

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
      const request = pageRequest(url);
      const {rangeStart, rangeSize} = request;
      requests.push(request);
      const response = await beforePage({...request, titles});
      if (response?.status)
        return route.fulfill({status:response.status, json:{error:'Simulated Plex outage'}});
      data = response?.snapshot || {totalSize:titles.length, Metadata:titles.slice(rangeStart, rangeStart + rangeSize)};
    } else if (url.pathname.startsWith('/library/metadata/')) {
      data.Metadata = titles.filter(item => item.ratingKey === url.pathname.split('/').pop());
    }
    return route.fulfill({json:{MediaContainer:data}});
  });
  return requests;
}

async function openDateSort(page, label = 'Recently added') {
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  await page.getByRole('button',{name:'Sort',exact:true}).click();
  await page.getByRole('group',{name:'Sort library'}).getByRole('button',{name:label}).click();
  await expect(page.locator('.paged-window-grid .card').first()).toBeVisible();
}

const card = (page, id) => page.locator(`.paged-window-grid .card[data-focus="${id}"]`);
const pane = page => page.locator('main');
const cachedPage = (page, plexSort, offset) => page.evaluate(async ({plexSort,offset}) => {
  const key = ':browse:' + JSON.stringify(['movies',
    plexSort === 'addedAt:desc' ? 'recent' : 'release','all','',offset,null]);
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
}, {plexSort,offset});
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
    for (let loaded = 60; loaded <= 3000; loaded += 60) {
      if (loaded > 60) {
        const oldHeight = await pane(page).evaluate(node => {
          node.scrollTop = node.scrollHeight;
          return node.scrollHeight;
        });
        await expect.poll(() => pane(page).evaluate(node => node.scrollHeight)).toBeGreaterThan(oldHeight);
      }
      if (![60,600,3000].includes(loaded)) continue;
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
    expect(requests.filter(entry => entry.sort === sort).map(entry => entry.start))
      .toEqual(Array.from({length:50}, (_, index) => index * 60));

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

test('a delayed page hands focus to the adjacent row and respects a later focus move', async ({page}) => {
  const releases = new Map();
  await mockLibrary(page, 180, ({start, sort}) => {
    if (sort === 'addedAt:desc' && start > 0)
      return new Promise(resolve => releases.set(start,resolve));
  });
  await page.goto('/');
  await openDateSort(page);
  const goToLoadedEnd = () => pane(page).evaluate(node => { node.scrollTop = node.scrollHeight; });
  await goToLoadedEnd();
  await expect.poll(() => releases.has(60)).toBe(true);
  await card(page,'59').focus();
  await page.keyboard.press('ArrowDown');
  await expect(card(page,'59')).toBeFocused();
  releases.get(60)();
  await expect(card(page,'67')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(card(page,'59')).toBeFocused();

  await goToLoadedEnd();
  await expect.poll(() => releases.has(120)).toBe(true);
  await card(page,'119').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(card(page,'111')).toBeFocused();
  releases.get(120)();
  await expect(card(page,'120')).toBeAttached();
  await expect(card(page,'111')).toBeFocused();
});

test('a cached date sort paints before refresh and keeps the focused poster on insert and removal', async ({page}) => {
  let refresh = false, release;
  await mockLibrary(page, 90, async ({start, sort, titles}) => {
    if (!refresh || start || sort !== 'addedAt:desc') return;
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
  for (const mutation of ['insert', 'remove']) {
    test(`restored ${sortLabel} repaginates after a first-page ${mutation}`, async ({page}) => {
      let mutateOnRefresh = false;
      const requests = await mockLibrary(page, 180, ({start, sort, titles}) => {
        if (!mutateOnRefresh || start !== 0 || sort !== plexSort) return;
        mutateOnRefresh = false;
        if (mutation === 'insert')
          titles.unshift({ratingKey:'new', type:'movie', title:'New Film'});
        else titles.shift();
      });
      await page.goto('/');
      await openDateSort(page, sortLabel);
      const grid = page.locator('.paged-window-grid');
      // Load three contiguous pages before leaving the tab.
      for (const offset of [60, 120]) {
        const previousHeight = await pane(page).evaluate(main => {
          main.scrollTop = main.scrollHeight;
          return main.scrollHeight;
        });
        await expect.poll(() => requests.some(r => r.sort === plexSort && r.start === offset))
          .toBe(true);
        await expect.poll(() => pane(page).evaluate(main => main.scrollHeight))
          .toBeGreaterThan(previousHeight);
      }
      await expect.poll(() => grid.evaluate(node => node._libraryWindow.has(179)))
        .toBe(true);
      await page.getByRole('button', {name:'Settings',exact:true}).click();
      mutateOnRefresh = true;
      await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
      // Wait for the first page's changed identity, then scroll through the
      // replacement pages: the bounded window only fetches what is reached.
      await expect.poll(() => grid.evaluate((node, id) =>
        node._libraryWindow.focusById(id)?._libraryWindowIndex,
        mutation === 'insert' ? 'new' : '1')).toBe(0);
      for (const [offset, lastIndex] of [
        [60, 119], [120, mutation === 'insert' ? 179 : 178],
        ...(mutation === 'insert' ? [[180, 180]] : [])
      ]) {
        await pane(page).evaluate(main => { main.scrollTop = main.scrollHeight; });
        await expect.poll(() =>
          requests.filter(r => r.sort === plexSort && r.start === offset).length)
          .toBeGreaterThanOrEqual(offset === 180 ? 1 : 2);
        await expect.poll(() =>
          grid.evaluate((node, index) => node._libraryWindow.has(index), lastIndex))
          .toBe(true);
      }
      // The restored tab must not splice old offsets 60/120 into the changed
      // first page, even when both first pages contain exactly 60 titles.
      const ids = mutation === 'insert'
        ? ['new','59','60','119','120','179']
        : ['1','59','60','119','120','179'];
      const expected = mutation === 'insert'
        ? [0,60,61,120,121,180]
        : [0,58,59,118,119,178];
      await expect.poll(async () => grid.evaluate((node, ids) => {
        const windowed = node._libraryWindow;
        return ids.map(id => {
          const card = windowed.focusById(id);
          return card ? card._libraryWindowIndex : -1;
        });
      }, ids)).toEqual(expected);
      expect(requests.filter(r => r.sort === plexSort && r.start === 60).length)
        .toBeGreaterThanOrEqual(2);
      expect(requests.filter(r => r.sort === plexSort && r.start === 120).length)
        .toBeGreaterThanOrEqual(2);
    });
  }
}

for (const [sortLabel, plexSort] of [
  ['Recently added', 'addedAt:desc'], ['Release date', 'originallyAvailableAt:desc']
]) {
  for (const [mutation, failure] of [['insert','hold'], ['remove','503']]) {
    test(`persisted ${sortLabel} rejects shifted page after restart (${mutation}, ${failure})`, async ({page}) => {
      let changeFirstPage = false, afterRestart = false, releaseSecond;
      const requests = await mockLibrary(page, 180, async ({start, sort, titles}) => {
        if (sort !== plexSort) return;
        if (start === 0 && changeFirstPage) {
          changeFirstPage = false;
          if (mutation === 'insert')
            titles.unshift({ratingKey:'new',type:'movie',title:'New Film'});
          else titles.shift();
        }
        if (start === 60 && afterRestart) {
          if (failure === '503') return {status:503};
          await new Promise(resolve => { releaseSecond = resolve; });
        }
      });
      await page.goto('/');
      await openDateSort(page, sortLabel);
      const grid = page.locator('.paged-window-grid');
      await pane(page).evaluate(main => { main.scrollTop = main.scrollHeight; });
      await expect.poll(() => grid.evaluate(node => node._libraryWindow.has(119))).toBe(true);
      await expect.poll(async () => (await cachedPage(page, plexSort, 60))?.data?.items?.[0]?.id).toBe('60');
      await pane(page).evaluate(main => { main.scrollTop = 0; });
      await page.getByRole('button',{name:'Settings',exact:true}).click();
      changeFirstPage = true;
      await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
      await expect.poll(() => grid.evaluate((node, id) =>
        node._libraryWindow.focusById(id)?._libraryWindowIndex,
        mutation === 'insert' ? 'new' : '1')).toBe(0);
      await expect.poll(async () => (await cachedPage(page, plexSort, 0))?.data?.items?.[0]?.id)
        .toBe(mutation === 'insert' ? 'new' : '1');
      expect((await cachedPage(page, plexSort, 60)).data.items[0].id).toBe('60');
      const oldRequests = requests.filter(r => r.sort === plexSort && r.start === 60).length;
      afterRestart = true;
      await page.reload();
      await openDateSort(page,sortLabel);
      await pane(page).evaluate(main => { main.scrollTop = main.scrollHeight; });
      await expect.poll(() => requests.filter(r =>
        r.sort === plexSort && r.start === 60).length).toBeGreaterThan(oldRequests);
      if (failure === 'hold') {
        await expect.poll(() => !!releaseSecond).toBe(true);
        expect(await grid.evaluate(node => node._libraryWindow.has(60))).toBe(false);
        releaseSecond();
        await expect.poll(() => grid.evaluate((node, id) =>
          node._libraryWindow.focusById(id)?._libraryWindowIndex,
          mutation === 'insert' ? '59' : '61')).toBe(60);
      } else {
        await expect(page.getByText(/Could not load library titles:/)).toBeVisible();
        expect(await grid.evaluate(node => node._libraryWindow.has(60))).toBe(false);
      }
    });
  }
}

for (const [sortLabel, plexSort] of [
  ['Recently added', 'addedAt:desc'], ['Release date', 'originallyAvailableAt:desc']
]) {
  test(`${sortLabel} keeps pending successors tied to their ordering across restart`, async ({page}) => {
    let arrival, offline = false;
    const successors = [];
    await mockLibrary(page, 180, async ({start, rangeStart, rangeSize, sort, titles}) => {
      if (sort !== plexSort) return;
      if (start === 0 && arrival) {
        titles.unshift({ratingKey:arrival, type:'movie', title:'Arrival ' + arrival});
        arrival = null;
      }
      if (start === 60) {
        if (offline) return {status:503};
        const snapshot = {totalSize:titles.length, Metadata:titles.slice(rangeStart, rangeStart + rangeSize)};
        await new Promise(resolve => successors.push(resolve));
        return {snapshot};
      }
    });
    const movies = page.locator('.rail-library-items').getByRole('button',{name:'Movies'});
    const settings = page.getByRole('button',{name:'Settings',exact:true});
    const grid = page.locator('.paged-window-grid');
    const scrollToBoundary = () => pane(page).evaluate(main => { main.scrollTop = main.scrollHeight; });
    const hasSuccessor = () => grid.evaluate(node => node._libraryWindow.has(60));
    const boundary = () => grid.evaluate(node => ['57','58','59'].map(id =>
      node._libraryWindow.focusById(id)?._libraryWindowIndex));
    await page.goto('/');
    await openDateSort(page, sortLabel);
    for (const id of ['A','B']) {
      await pane(page).evaluate(main => { main.scrollTop = 0; });
      await settings.click();
      arrival = id;
      await movies.click();
      await expect(card(page,id)).toBeVisible();
      await scrollToBoundary();
      await expect.poll(() => successors.length).toBe(id === 'A' ? 1 : 2);
    }
    // Let the current ordering finish first, then deliver the older response.
    expect(await hasSuccessor()).toBe(false);
    successors[1]();
    await expect.poll(boundary).toEqual([59,60,61]);
    const oldResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.hostname === 'plex.test' && url.searchParams.get('sort') === plexSort &&
        pageRequest(url).start === 60;
    });
    successors[0]();
    await oldResponse;
    await expect.poll(async () => (await cachedPage(page,plexSort,60))?.data.items[0].id)
      .toBe('58');
    offline = true;
    await page.reload();
    await openDateSort(page, sortLabel);
    const failedResponse = page.waitForResponse(response =>
      response.status() === 503 && new URL(response.url()).hostname === 'plex.test');
    await scrollToBoundary();
    await failedResponse;
    await expect.poll(boundary).toEqual([59,60,61]);
  });

  test(`${sortLabel} reconciles a first-page refresh completed while detached`, async ({page}) => {
    let holdFirst = false, arrival = true;
    const refreshes = [];
    await mockLibrary(page, 180, async ({start, sort, titles}) => {
      if (sort !== plexSort || start !== 0 || !holdFirst) return;
      if (arrival) {
        titles.unshift({ratingKey:'new', type:'movie', title:'Arrival'});
        arrival = false;
      }
      await new Promise(resolve => refreshes.push(resolve));
    });
    const movies = page.locator('.rail-library-items').getByRole('button',{name:'Movies'});
    const settings = page.getByRole('button',{name:'Settings',exact:true});
    const grid = page.locator('.paged-window-grid');
    await page.goto('/');
    await openDateSort(page, sortLabel);
    await settings.click();
    holdFirst = true;
    await movies.click();
    await expect.poll(() => refreshes.length).toBe(1);
    await settings.click();
    refreshes[0]();
    await expect.poll(async () => (await cachedPage(page,plexSort,0))?.data.items[0].id)
      .toBe('new');
    await movies.click();
    await expect.poll(() => refreshes.length).toBe(2);
    // The new first page is already on disk. Apply it while the next refresh
    // is still held, then check the complete boundary once paging resumes.
    await expect(card(page,'new')).toBeVisible();
    refreshes[1]();
    await pane(page).evaluate(main => { main.scrollTop = main.scrollHeight; });
    await expect.poll(() => grid.evaluate(node => ['58','59','60'].map(id =>
      node._libraryWindow.focusById(id)?._libraryWindowIndex))).toEqual([59,60,61]);
  });
}

for (const [sortLabel, plexSort] of [
  ['Recently added', 'addedAt:desc'], ['Release date', 'originallyAvailableAt:desc']
]) {
  test(`${sortLabel} can browse a cached chain during a held first-page refresh`, async ({page}) => {
    let hold = false;
    const requests = new Map();
    await mockLibrary(page, 180, ({start, sort}) => {
      if (hold && sort === plexSort)
        return new Promise(resolve => requests.set(start, resolve));
    });
    const grid = page.locator('.paged-window-grid');
    const scrollToEnd = () => pane(page).evaluate(main => { main.scrollTop = main.scrollHeight; });
    await page.goto('/');
    await openDateSort(page, sortLabel);
    for (const offset of [60,120]) {
      await scrollToEnd();
      await expect.poll(async () => (await cachedPage(page,plexSort,offset))?.data.items[0].id)
        .toBe(String(offset));
    }
    hold = true;
    await page.reload();
    await openDateSort(page, sortLabel);
    await expect.poll(() => requests.has(0)).toBe(true);
    for (const offset of [60,120]) {
      await scrollToEnd();
      await expect.poll(() => grid.evaluate((node, index) =>
        node._libraryWindow.reveal(index)?.dataset.focus, offset)).toBe(String(offset));
    }
    requests.forEach(resolve => resolve({status:503}));
  });

  for (const mutation of ['insert','remove']) {
    test(`${sortLabel} proves a live boundary beyond a held cached page (${mutation})`, async ({page}) => {
      let phase = 'seed';
      let releaseSecond;
      await mockLibrary(page, 180, async ({start, rangeStart, rangeSize, sort, titles}) => {
        if (sort !== plexSort) return;
        if (phase === 'shift') {
          if (mutation === 'insert') titles.splice(80,0,{ratingKey:'new',type:'movie',title:'Arrival'});
          else titles.splice(80,1);
          phase = 'hold';
        }
        if (phase === 'offline' && start >= 60) return {status:503};
        if (phase === 'hold' && start === 60) {
          const snapshot = {totalSize:titles.length, Metadata:titles.slice(rangeStart,rangeStart + rangeSize)};
          await new Promise(resolve => { releaseSecond = resolve; });
          return {snapshot};
        }
      });
      const grid = page.locator('.paged-window-grid');
      const scrollToEnd = () => pane(page).evaluate(main => { main.scrollTop = main.scrollHeight; });
      const boundary = () => grid.evaluate(node => [118,119,120,121].map(index =>
        node._libraryWindow.reveal(index)?.dataset.focus || null));
      const oldBoundary = ['118','119',null,null];
      const correctedBoundary = mutation === 'insert'
        ? ['117','118','119','120'] : ['119','120','121','122'];
      const successorResponse = status => page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.hostname === 'plex.test' && pageRequest(url).sort === plexSort &&
          pageRequest(url).start === 120 && response.status() === status;
      });
      await page.goto('/');
      await openDateSort(page,sortLabel);
      await scrollToEnd();
      await expect.poll(async () => (await cachedPage(page,plexSort,60))?.data.items[0].id).toBe('60');
      expect(await cachedPage(page,plexSort,120)).toBeNull();

      phase = 'shift';
      await page.reload();
      await openDateSort(page,sortLabel);
      await scrollToEnd();
      await expect.poll(() => !!releaseSecond).toBe(true);
      await expect.poll(boundary).toEqual(oldBoundary);
      const live = successorResponse(200);
      await scrollToEnd();
      await live;
      // The new third page arrived before the held second page. It cannot
      // extend the old second page in either the grid or IndexedDB.
      await waitForLayout(page);
      expect(await boundary()).toEqual(oldBoundary);
      expect(await cachedPage(page,plexSort,120)).toBeNull();

      // Restart before any repair can land. Offline, the two coherent cached
      // pages are still available and the third cannot be resurrected.
      phase = 'offline';
      await page.reload();
      await openDateSort(page,sortLabel);
      const offline = successorResponse(503);
      await scrollToEnd();
      await expect.poll(boundary).toEqual(oldBoundary);
      await scrollToEnd();
      await offline;
      await expect(page.getByText(/Could not load library titles:/)).toBeVisible();
      expect(await boundary()).toEqual(oldBoundary);
      expect(await cachedPage(page,plexSort,120)).toBeNull();
      releaseSecond();

      // A subsequent online visit repaginates in the new order and persists
      // a complete, correctly joined boundary.
      phase = 'online';
      await page.reload();
      await openDateSort(page,sortLabel);
      await scrollToEnd();
      await expect.poll(() => grid.evaluate(node => node._libraryWindow.has(119))).toBe(true);
      await scrollToEnd();
      await expect.poll(boundary).toEqual(correctedBoundary);
      await expect.poll(async () => (await cachedPage(page,plexSort,120))?.data.items[0].id)
        .toBe(correctedBoundary[2]);
      phase = 'offline';
      await page.reload();
      await openDateSort(page,sortLabel);
      await scrollToEnd();
      await expect.poll(() => grid.evaluate(node => node._libraryWindow.has(119))).toBe(true);
      await scrollToEnd();
      await expect.poll(boundary).toEqual(correctedBoundary);
    });
  }
}

test('a live date grid repairs a shift before multiple already loaded boundaries', async ({page}) => {
  let insert = false;
  const requests = await mockLibrary(page, 240, ({start, sort, titles}) => {
    if (insert && start === 120 && sort === 'addedAt:desc') {
      insert = false;
      titles.unshift({ratingKey:'new',type:'movie',title:'Arrival'});
    }
  });
  const grid = page.locator('.paged-window-grid');
  const scrollToEnd = () => pane(page).evaluate(main => { main.scrollTop = main.scrollHeight; });
  await page.goto('/');
  await openDateSort(page);
  await scrollToEnd();
  await expect.poll(() => grid.evaluate(node => node._libraryWindow.has(119))).toBe(true);
  insert = true;
  await scrollToEnd();
  await expect.poll(() => grid.evaluate(node =>
    node._libraryWindow.focusById('new')?._libraryWindowIndex)).toBe(0);
  await scrollToEnd();
  await expect.poll(() => grid.evaluate(node => node._libraryWindow.has(119))).toBe(true);
  await scrollToEnd();
  await expect.poll(() => grid.evaluate(node => [59,60,119,120].map(index =>
    node._libraryWindow.reveal(index)?.dataset.focus))).toEqual(['58','59','118','119']);
  expect(requests.filter(request => request.sort === 'addedAt:desc' && request.start === 120)
    .map(request => [request.rangeStart,request.rangeSize])).toEqual([[60,120],[60,120]]);
});
