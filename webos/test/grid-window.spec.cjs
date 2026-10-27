const {test, expect} = require('@playwright/test');

async function mockLongJellyfinLibrary(page) {
  await page.addInitScript(() => localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'device',active:'server',quality:'auto',
    servers:[{id:'server',kind:'jellyfin',url:'http://media.test',
      name:'Jellyfin',token:'token',userId:'user'}]
  })));
  const calls=[];
  await page.route('http://media.test/**', route => {
    const url=new URL(route.request().url());
    if(url.pathname.includes('/Images/')) return route.fulfill({status:404});
    if(url.pathname==='/Users/user/Views') return route.fulfill({json:{
      Items:[{Id:'movies',Name:'Movies',CollectionType:'movies'}]}});
    if(url.pathname==='/Users/user/Items') {
      const start=Number(url.searchParams.get('StartIndex')||0);
      calls.push(start);
      const items=Array.from({length:Math.max(0,Math.min(60,360-start))},(_,i)=>{
        const index=i+start;
        return {Id:String(index),Name:'Title '+String(index).padStart(3,'0'),
          Type:'Movie',ImageTags:{Primary:'art-'+index}};
      });
      return route.fulfill({json:{Items:items,TotalRecordCount:360}});
    }
    if(url.pathname.startsWith('/Users/user/Items/')) {
      const id=url.pathname.split('/').pop();
      return route.fulfill({json:{Id:id,Name:'Title '+id.padStart(3,'0'),Type:'Movie'}});
    }
    return route.fulfill({json:{Items:[]}});
  });
  return calls;
}

for (const layout of ['grid','flex']) {
  test('paginated '+layout+' grid stays bounded and returns to focused title',async({page})=>{
    const calls=await mockLongJellyfinLibrary(page);
    await page.setViewportSize({width:1280,height:720});
    await page.goto('/');
    if(layout==='flex') await page.addStyleTag({content:`
      main .grid {display:flex !important;}
      main .grid .card {flex:0 0 170px !important;width:170px !important;
        margin:0 20px 26px 0 !important;}
    `});
    await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
    await expect(page.locator('main .grid .card')).toHaveCount(60);
    // Reaching the end of each loaded range requests the next page. The
    // titles remain in memory/IndexedDB, but the number of DOM cards is bounded.
    for(let i=1;i<5;i++) {
      await page.locator('main').evaluate(node=>node.scrollTop=node.scrollHeight);
      await expect.poll(()=>calls.length).toBeGreaterThan(i);
    }
    await expect.poll(()=>page.locator('main .grid .card').count())
      .toBeLessThan(100);
    const before=await page.evaluate(()=>{
      const main=document.querySelector('main'), pane=main.getBoundingClientRect();
      const visible=Array.from(main.querySelectorAll('.grid .card')).find(node=>{
        const rect=node.getBoundingClientRect();
        return rect.top>=pane.top && rect.bottom<=pane.bottom;
      });
      if(!visible) return null;
      visible.focus();
      return {id:visible.dataset.focus,scroll:main.scrollTop};
    });
    expect(before).not.toBeNull();
    await page.locator('main .grid .card[data-focus="'+before.id+'"]').click();
    await expect(page.getByRole('heading',{name:'Title '+before.id.padStart(3,'0')})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('main .grid .card[data-focus="'+before.id+'"]')).toBeFocused();
    expect(Math.abs(await page.locator('main').evaluate(node=>node.scrollTop)-before.scroll))
      .toBeLessThan(3);
    await page.locator('main').evaluate(node=>node.scrollTop=0);
    await expect(page.locator('main .grid .card[data-focus="0"]')).toHaveCount(1);
    expect(calls.filter(offset=>offset===0)).toHaveLength(1);
    await expect.poll(()=>page.locator('main .grid .card').count())
      .toBeLessThan(100);
  });
}
