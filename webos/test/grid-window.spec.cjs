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
    let before=null;
    for(let attempt=0;attempt<4 && !before;attempt++){
      before=await page.evaluate(()=>{
        const main=document.querySelector('main'), pane=main.getBoundingClientRect();
        const visible=Array.from(main.querySelectorAll('.grid .card')).find(node=>{
          const rect=node.getBoundingClientRect();
          return rect.top>=pane.top && rect.bottom<=pane.bottom;
        });
        if(!visible)return null;
        visible.focus();
        return {id:visible.dataset.focus,scroll:main.scrollTop};
      });
      // A bottom-aligned partial row (plus the pagination sentinel) is not
      // fully visible in a short viewport, especially in the flex fallback.
      if(!before){
        await page.locator('main').evaluate(main=>main.scrollTop=Math.max(0,main.scrollTop-250));
        await page.waitForTimeout(25);
      }
    }
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
    await expect.poll(async()=>!!(await visibleGridAnchor(page))).toBe(true);
    const initial=await visibleGridAnchor(page);
    expect(initial).not.toBeNull();
    await page.addStyleTag({content:'.grid .card .poster{height:200px!important}'});
    await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
    await expect.poll(async()=>!!(await visibleGridAnchor(page))).toBe(true);
    const altered=await visibleGridAnchor(page);
    expect(altered).not.toBeNull();
    expect(Math.abs(altered.index-initial.index)).toBeLessThanOrEqual(initial.columns);
    await page.setViewportSize({width:1090,height:720});
    await expect.poll(async()=>!!(await visibleGridAnchor(page))).toBe(true);
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

test('recycling reuses nearby artwork DOM and suspends both scroll listeners',async({page})=>{
  const calls=await mockLongJellyfinLibrary(page);
  const artworkRequests=[];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUsAlgYGBgYmBgYGBgAAAIcgC421576AAAAABJRU5ErkJggg==','base64');
  await page.route('http://media.test/Items/*/Images/Primary**',route=>{
    artworkRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({body:png,contentType:'image/png'});
  });
  await page.setViewportSize({width:1280,height:720});
  await page.goto('/');
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  await expect(page.locator('main .grid .card')).toHaveCount(60);
  await page.evaluate(()=>{
    window.mainScrollRemoved=0;
    const original=Element.prototype.removeEventListener;
    Element.prototype.removeEventListener=function(type,...args) {
      if(type==='scroll' && this.tagName==='MAIN')window.mainScrollRemoved++;
      return original.call(this,type,...args);
    };
  });
  await page.locator('main .grid .card[data-focus="0"]').click();
  await expect(page.getByRole('heading',{name:'Title 000'})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.mainScrollRemoved)).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('main .grid .card[data-focus="0"]')).toBeFocused();
  await fillFivePages(page,calls);
  await page.locator('main').evaluate(main=>main.scrollTop=0);
  await expect(page.locator('main .grid .card[data-focus="0"]')).toHaveCount(1);
  await expect(page.locator('main .grid .card[data-focus="0"] img'))
    .toHaveClass(/artwork-(ready|loaded)/);
  const initialRequestCount=artworkRequests.filter(x=>x==='/Items/0/Images/Primary').length;
  expect(initialRequestCount).toBeGreaterThan(0);
  await page.evaluate(()=>{window.savedCard=document.querySelector('.grid .card[data-focus="0"]')});
  await page.locator('main').evaluate(main=>main.scrollTop=main.scrollHeight*.7);
  await expect(page.locator('main .grid .card[data-focus="0"]')).toHaveCount(0);
  await page.locator('main').evaluate(main=>main.scrollTop=0);
  await expect(page.locator('main .grid .card[data-focus="0"]')).toHaveCount(1);
  expect(await page.evaluate(()=>document.querySelector('.grid .card[data-focus="0"]')===window.savedCard))
    .toBe(true);
  await expect(page.locator('main .grid .card[data-focus="0"] img'))
    .toHaveClass(/artwork-(ready|loaded)/);
  expect(artworkRequests.filter(x=>x==='/Items/0/Images/Primary').length)
    .toBe(initialRequestCount);
});

const tinyArtwork = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUsAlgYGBgYmBgYGBgAAAIcgC421576AAAAABJRU5ErkJggg==','base64');

for (const detachTiming of ['resolve-detached','resolve-reattached']) {
  test('pending artwork recovers after recycling ('+detachTiming+')',async({page})=>{
    const requests=[];
    const calls=await mockLongJellyfinLibrary(page);
    let releaseImage;
    const held = new Promise(resolve => { releaseImage=resolve; });
    await page.route('http://media.test/Items/0/Images/Primary**', async route=>{
      requests.push(route.request().url());
      if(requests.length===1)await held;
      await route.fulfill({body:tinyArtwork,contentType:'image/png'});
    });
    await page.goto('/');
    await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
    await expect.poll(()=>requests.length,{timeout:15000}).toBeGreaterThan(0);
    await fillFivePages(page,calls);
    await page.locator('main').evaluate(main=>main.scrollTop=0);
    await expect(page.locator('main .grid .card[data-focus="0"]')).toHaveCount(1);
    await page.evaluate(()=>{
      window.savedImage=document.querySelector('main .grid .card[data-focus="0"] img');
    });
    await page.locator('main').evaluate(main=>main.scrollTop=main.scrollHeight*.7);
    await expect(page.locator('main .grid .card[data-focus="0"]')).toHaveCount(0);
    if(detachTiming==='resolve-detached') {
      releaseImage();
      // Allow the pending asynchronous artwork result to complete while its
      // original node is detached, before the LRU returns that exact node.
      await page.waitForTimeout(100);
    }
    await page.locator('main').evaluate(main=>main.scrollTop=0);
    await expect(page.locator('main .grid .card[data-focus="0"]')).toHaveCount(1);
    if(detachTiming==='resolve-reattached')releaseImage();
    await expect(page.locator('main .grid .card[data-focus="0"] img'))
      .toHaveClass(/artwork-(loaded|ready)/,{timeout:15000});
    const result=await page.evaluate(()=>{
      const image=document.querySelector('main .grid .card[data-focus="0"] img');
      return {same:image===window.savedImage,naturalWidth:image.naturalWidth,visible:
        Number(getComputedStyle(image).opacity)};
    });
    expect(result.same).toBe(true);
    expect(result.naturalWidth).toBeGreaterThan(0);
    // Non-ready images intentionally fade in over 300 ms. Verify that the
    // transition completes rather than asserting mid-animation opacity.
    await expect.poll(()=>page.evaluate(()=>{
      const img=document.querySelector('main .grid .card[data-focus="0"] img');
      return Number(getComputedStyle(img).opacity);
    })).toBe(1);
  });
}

for(const layout of ['grid','flex']) {
  test('detached '+layout+' library remeasures before Back and cached-tab return',async({page})=>{
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
    await page.locator('main').evaluate(main=>main.scrollTop=main.scrollHeight*.55);
    await expect.poll(async()=>!!(await visibleGridAnchor(page))).toBe(true);
    const first=await visibleGridAnchor(page);
    await page.locator('main .grid .card[data-focus="'+first.focused+'"]').count();
    // Use an actually visible card and ensure a stable route focus is saved.
    const focusId=await page.locator('main').evaluate(main=>{
      const view=main.getBoundingClientRect();
      const card=Array.from(main.querySelectorAll('.grid .card')).find(node=>{
        const box=node.getBoundingClientRect();
        return box.top>=view.top+10 && box.bottom<=view.bottom-10;
      });
      if(card)card.focus();
      return card && card.dataset.focus;
    });
    expect(focusId).toBeTruthy();
    await page.locator('main .grid .card[data-focus="'+focusId+'"]').click();
    await expect(page.getByRole('heading',{name:'Title '+focusId.padStart(3,'0')})).toBeVisible();
    await page.setViewportSize({width:1050,height:720});
    await page.keyboard.press('Escape');
    await expect(page.locator('main .grid .card[data-focus="'+focusId+'"]')).toBeFocused();
    const measure=await page.locator('main .grid').evaluate(grid=>{
      const card=grid.querySelector('.card');
      const rowTop=card.getBoundingClientRect().top;
      const actual=Array.from(grid.querySelectorAll('.card')).filter(
        node=>Math.abs(node.getBoundingClientRect().top-rowTop)<3).length;
      return {actual,recorded:grid._windowedGrid.columns,
        focusedIndex:document.activeElement._gridIndex};
    });
    expect(measure.recorded).toBe(measure.actual);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('main .grid .card:focus'))
      .toHaveAttribute('data-focus',String(Number(focusId)+measure.actual));
    // Switching tabs retains the same detached recycler; resize while cached.
    const activeId=await page.locator('main .grid .card:focus').getAttribute('data-focus');
    await page.locator('nav button[data-nav-id="home"]').click();
    await page.setViewportSize({width:1280,height:720});
    await page.locator('nav button[data-nav-id="library:movies"]').click();
    await expect(page.locator('main .grid .card[data-focus="'+activeId+'"]')).toBeFocused();
    const second=await page.locator('main .grid').evaluate(grid=>{
      const first=grid.querySelector('.card'),y=first.getBoundingClientRect().top;
      return {recorded:grid._windowedGrid.columns,actual:Array.from(grid.querySelectorAll('.card'))
        .filter(node=>Math.abs(node.getBoundingClientRect().top-y)<3).length};
    });
    expect(second.recorded).toBe(second.actual);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('main .grid .card:focus'))
      .toHaveAttribute('data-focus',String(Number(activeId)+second.actual));
  });
  test('fresh '+layout+' page reorder preserves the focused title identity',async({page})=>{
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
    await page.locator('main').evaluate(main=>main.scrollTop=0);
    await expect(page.locator('main .grid .card[data-focus="10"]')).toHaveCount(1);
    await page.locator('main .grid .card[data-focus="10"]').focus();
    await page.locator('main .grid').evaluate(async grid=>{
      const entries=Array.from({length:60},(_,index)=>({
        id:String(index),title:'Title '+String(index).padStart(3,'0'),
        type:'Movie',subtitle:index%3===0?'2020':'',
        raw:{Id:String(index),Name:'Title '+String(index).padStart(3,'0'),
          Type:'Movie',ImageTags:{Primary:'art-'+index}}
      }));
      const [moved]=entries.splice(10,1);
      entries.push(moved);
      await grid._applyCatalogUpdate(0,{changed:true,value:{items:entries,total:360}});
    });
    await expect(page.locator('main .grid .card[data-focus="10"]')).toBeFocused();
    const state=await page.locator('main .grid .card[data-focus="10"]').evaluate(node=>{
      const pane=document.querySelector('main').getBoundingClientRect();
      const box=node.getBoundingClientRect();
      return {index:node._gridIndex,visible:box.bottom>pane.top && box.top<pane.bottom};
    });
    expect(state.index).toBe(59);
    expect(state.visible).toBe(true);
  });
}
