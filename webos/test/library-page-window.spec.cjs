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
      const start = Number(url.searchParams.get('X-Plex-Container-Start'));
      const size = Number(url.searchParams.get('X-Plex-Container-Size'));
      const sort = url.searchParams.get('sort');
      requests.push({start, size, sort});
      await beforePage({start, sort, titles});
      data = {totalSize:titles.length, Metadata:titles.slice(start, start + size)};
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
