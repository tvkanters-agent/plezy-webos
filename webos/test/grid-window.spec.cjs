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
          Type:'Movie',ProductionYear:index%3===0?2020:undefined,ImageTags:{Primary:'art-'+index}};
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
      await expect.poll(async()=>{
        await page.locator('main').evaluate(node=>node.scrollTop=node.scrollHeight);
        return calls.includes(i*60);
      }, {timeout:12000,message:'Missing page '+i+'; requests: '+calls.join(',')})
        .toBe(true);
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
    // Detaching a cached route for a title detail must not disable its
    // still-incomplete paginator after Back restores the DOM snapshot.
    await expect.poll(async()=>{
      await page.locator('main').evaluate(node=>node.scrollTop=node.scrollHeight);
      return calls.includes(300);
    },{timeout:12000}).toBe(true);
    await page.locator('main').evaluate(node=>node.scrollTop=0);
    await expect(page.locator('main .grid .card[data-focus="0"]')).toHaveCount(1);
    expect(calls.filter(offset=>offset===0)).toHaveLength(1);
    await expect.poll(()=>page.locator('main .grid .card').count())
      .toBeLessThan(100);
  });
}

async function fillFivePages(page,calls) {
  for (const offset of [60,120,180,240]) {
    await expect.poll(async()=>{
      await page.locator('main').evaluate(node=>node.scrollTop=node.scrollHeight);
      return calls.includes(offset);
    },{timeout:12000}).toBe(true);
  }
}
async function visibleGridAnchor(page) {
  return page.locator('main').evaluate(main=>{
    const pane=main.getBoundingClientRect();
    const cards=Array.from(main.querySelectorAll('.grid .card'));
    const visible=cards.filter(card=>{
      const box=card.getBoundingClientRect();
      return box.bottom>pane.top+12 && box.top<pane.bottom-12;
    });
    if(!visible.length)return null;
    const first=visible[0],firstTop=first.getBoundingClientRect().top;
    const columns=cards.filter(card=>Math.abs(card.getBoundingClientRect().top-
      cards[0].getBoundingClientRect().top)<3).length;
    return {index:first._gridIndex,columns,delta:firstTop-pane.top,scroll:main.scrollTop,
      focused:document.activeElement.dataset.focus};
  });
}
for(const layout of ['grid','flex']) {
  test('rail re-entry and wheel recovery do not rewind recycled '+layout+' grid',async({page})=>{
    const calls=await mockLongJellyfinLibrary(page);
    await page.setViewportSize({width:1280,height:720});
    await page.goto('/');
    if(layout==='flex') await page.addStyleTag({content:`
      main .grid{display:flex!important}
      main .grid .card{flex:0 0 170px!important;width:170px!important;
        margin:0 20px 26px 0!important}
    `});
    await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
    await fillFivePages(page,calls);
    await page.locator('main').evaluate(main=>main.scrollTop=0);
    await expect(page.locator('.grid .card[data-focus="0"]')).toHaveCount(1);
    await page.locator('.grid .card[data-focus="0"]').focus();
    await page.locator('main').evaluate(main=>main.scrollTop=main.scrollHeight);
    await expect.poll(async()=>{
      const anchor=await visibleGridAnchor(page);
      return anchor && Number(anchor.focused)>50 && anchor.focused===
        String(anchor.focused) ? Number(anchor.focused) : -1;
    }).toBeGreaterThan(50);
    const start=await page.locator('main').evaluate(main=>main.scrollTop);
    await page.locator('nav button[data-nav-id="library:movies"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async()=> {
      const anchor=await visibleGridAnchor(page);
      return anchor && Number(anchor.focused)>50;
    }).toBe(true);
    const after=await page.locator('main').evaluate(main=>main.scrollTop);
    expect(Math.abs(after-start)).toBeLessThan(3);
  });
  test('D-pad traverses virtual boundaries without skipping '+layout+' rows',async({page})=>{
    const calls=await mockLongJellyfinLibrary(page);
    await page.setViewportSize({width:1280,height:720});
    await page.goto('/');
    if(layout==='flex') await page.addStyleTag({content:`
      main .grid{display:flex!important}
      main .grid .card{flex:0 0 170px!important;width:170px!important;
        margin:0 20px 26px 0!important}
    `});
    await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
    await fillFivePages(page,calls);
    await page.locator('main').evaluate(main=>main.scrollTop=0);
    await expect(page.locator('.grid .card[data-focus="0"]')).toHaveCount(1);
    await page.locator('.grid .card[data-focus="0"]').focus();
    const columns=(await visibleGridAnchor(page)).columns;
    for(let row=1;row<18;row++){
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('main .grid .card:focus'))
        .toHaveAttribute('data-focus',String(row*columns));
    }
    for(let row=16;row>=0;row--){
      await page.keyboard.press('ArrowUp');
      await expect(page.locator('main .grid .card:focus'))
        .toHaveAttribute('data-focus',String(row*columns));
    }
  });
  test('resize preserves anchor across poster-height and breakpoint changes ('+layout+')',async({page})=>{
    const calls=await mockLongJellyfinLibrary(page);
    await page.setViewportSize({width:1280,height:720});
    await page.goto('/');
    if(layout==='flex')await page.addStyleTag({content:`
      main .grid{display:flex!important}
      main .grid .card{flex:0 0 170px!important;width:170px!important;
        margin:0 20px 26px 0!important}
    `});
    await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
    await fillFivePages(page,calls);
    await page.locator('main').evaluate(main=>main.scrollTop=main.scrollHeight*.6);
    const initial=await visibleGridAnchor(page);
    expect(initial).not.toBeNull();
    await page.addStyleTag({content:'.grid .card .poster{height:200px!important}'});
    await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
    const altered=await visibleGridAnchor(page);
    expect(altered).not.toBeNull();
    expect(Math.abs(altered.index-initial.index)).toBeLessThan(initial.columns);
    await page.setViewportSize({width:1090,height:720});
    const finalAnchor=await visibleGridAnchor(page);
    expect(finalAnchor).not.toBeNull();
    expect(Math.abs(finalAnchor.index-altered.index))
      .toBeLessThan(Math.max(finalAnchor.columns,altered.columns));
    // Mixed empty and populated subtitles must not produce uneven row strides.
    const strides=await page.locator('main .grid').evaluate(grid=>{
      const cards=Array.from(grid.querySelectorAll('.card')), rows=[];
      for(const card of cards){
        const top=card.getBoundingClientRect().top;
        if(rows.every(y=>Math.abs(y-top)>3))rows.push(top);
      }
      return rows.slice(1).map((top,i)=>top-rows[i]);
    });
    if(strides.length>1)
      expect(Math.max(...strides)-Math.min(...strides)).toBeLessThan(2);
  });
}
