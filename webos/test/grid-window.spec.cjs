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
  // Recycle several rows, not hundreds: the deliberately small shared LRU
  // retains nearby cards, but intentionally evicts distant artwork nodes.
  await page.locator('main').evaluate(main=>main.scrollTop=Math.min(3000,main.scrollHeight*.7));
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
    // Recycle several rows, not hundreds: the deliberately small shared LRU
  // retains nearby cards, but intentionally evicts distant artwork nodes.
  await page.locator('main').evaluate(main=>main.scrollTop=Math.min(3000,main.scrollHeight*.7));
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

for(const layout of ['grid','flex']) {
  test('virtual '+layout+' D-pad visits all logical rows before Cast',async({page})=>{
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
    await expect.poll(async()=>{
      await page.locator('main').evaluate(node=>node.scrollTop=node.scrollHeight);
      return calls.includes(300);
    }).toBe(true);
    await page.locator('main').evaluate(main=>{
      const cast=document.createElement('div');
      cast.className='cast-strip';cast.tabIndex=0;
      main.append(cast);
      main.scrollTop=0;
    });
    await expect(page.locator('.grid .card[data-focus="0"]')).toHaveCount(1);
    await page.locator('.grid .card[data-focus="0"]').focus();
    const columns=await page.locator('.grid').evaluate(grid=>grid._windowedGrid.columns);
    const lastRow=Math.ceil(360/columns)-1;
    for(let row=1;row<=lastRow;row++){
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('main .grid .card:focus'))
        .toHaveAttribute('data-focus',String(Math.min(row*columns,359)));
    }
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('main .cast-strip')).toBeFocused();
  });
  test('virtual '+layout+' grid restores a same-turn scroll and tab focus',async({page})=>{
    await mockLongJellyfinLibrary(page);
    await page.setViewportSize({width:1280,height:720});
    await page.goto('/');
    if(layout==='flex')await page.addStyleTag({content:`
      main .grid{display:flex!important}
      main .grid .card{flex:0 0 170px!important;width:170px!important;
        margin:0 20px 26px 0!important}
    `});
    await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
    await page.locator('main').evaluate(node=>node.scrollTop=node.scrollHeight);
    await expect.poll(async()=>!!(await visibleGridAnchor(page))).toBe(true);
    const first=await page.locator('main').evaluate(main=>{
      const pane=main.getBoundingClientRect();
      const card=Array.from(main.querySelectorAll('.grid .card')).find(el=>{
        const box=el.getBoundingClientRect();
        return box.top>pane.top+8 && box.bottom<pane.bottom-8;
      });
      if(!card)return null;
      card.focus();
      main.scrollTop+=29;
      const scroll=main.scrollTop;
      card.click();
      return {id:card.dataset.focus,scroll};
    });
    expect(first).not.toBeNull();
    await expect(page.getByRole('heading',{name:'Title '+first.id.padStart(3,'0')})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('main .grid .card[data-focus="'+first.id+'"]')).toBeFocused();
    expect(Math.abs((await page.locator('main').evaluate(n=>n.scrollTop))-first.scroll))
      .toBeLessThan(3);
    const second=await page.locator('main').evaluate(main=>{
      main.scrollTop+=23;
      const scroll=main.scrollTop;
      document.querySelector('nav button[data-nav-id="home"]').click();
      return scroll;
    });
    await expect(page.getByRole('heading',{name:'Your next watch'})).toBeVisible();
    await page.locator('nav button[data-nav-id="library:movies"]').click();
    expect(Math.abs((await page.locator('main').evaluate(n=>n.scrollTop))-second))
      .toBeLessThan(3);
    await expect(page.locator('main .grid .card[data-focus="'+first.id+'"]')).toBeFocused();
  });
}

test('shared recycler pool stays bounded and clears on snapshot suspension',async({page})=>{
  const calls=await mockLongJellyfinLibrary(page);
  await page.goto('/');
  await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
  await fillFivePages(page,calls);
  for(const percent of [.2,.5,.85,.35,.7,.1,.9]){
    await page.locator('main').evaluate((main,percent)=>{
      main.scrollTop=main.scrollHeight*percent;
    },percent);
    await expect.poll(()=>page.locator('.grid').evaluate(grid=>
      grid._windowedGrid.retainedCardStats().globalCached)).toBeLessThanOrEqual(48);
  }
  await page.locator('nav button[data-nav-id="home"]').click();
  await page.locator('nav button[data-nav-id="library:movies"]').click();
  const stats=await page.locator('.grid').evaluate(grid=>grid._windowedGrid.retainedCardStats());
  expect(stats.globalCached).toBeLessThanOrEqual(48);
  expect(stats.localCached).toBeLessThanOrEqual(48);
  expect(stats.mounted).toBeLessThanOrEqual(
    Math.max(80,stats.columns*(stats.visibleRows+8)));
});

test('delayed Plex actor facts reflows virtualized person grid',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'device',active:'plex',
    servers:[{id:'plex',kind:'plex',url:'http://plex.test',name:'Plex',token:'token'}]
  })));
  const actor={id:'411',tag:'Actor Test',role:'Cast'};
  const lead={ratingKey:'lead',type:'movie',title:'Lead Film',Role:[actor]};
  const filmography=Array.from({length:240},(_,i)=>({
    ratingKey:'actor-'+i,type:'movie',title:'Actor Film '+i
  }));
  let releaseBio;
  const delayed=new Promise(resolve=>{releaseBio=resolve;});
  await page.route('https://discover.provider.plex.tv/library/people/actor-person',async route=>{
    await delayed;
    await route.fulfill({json:{MediaContainer:{Metadata:[{
      summary:'A detailed biography that changes the height of the header. '.repeat(6),
      bornAt:'1970-01-01',diedAt:'2020-01-01',birthPlace:'Test City'}]}}});
  });
  await page.route('http://plex.test/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/hubs')return route.fulfill({json:{MediaContainer:{
      Hub:[{title:'Movies',Metadata:[lead]}]}}});
    if(path==='/library/metadata/lead')return route.fulfill({json:{MediaContainer:{
      Metadata:[lead],totalSize:1}}});
    if(path==='/library/people/411')return route.fulfill({json:{MediaContainer:{
      Directory:[{tagKey:'actor-person'}]}}});
    if(path==='/library/people/411/media')return route.fulfill({json:{MediaContainer:{
      Metadata:filmography,totalSize:filmography.length}}});
    return route.fulfill({json:{MediaContainer:{Metadata:[],totalSize:0}}});
  });
  await page.setViewportSize({width:1280,height:720});
  await page.goto('/');
  await page.getByRole('button',{name:/Lead Film/}).first().click();
  await expect(page.locator('.cast-strip')).toHaveCount(1);
  await page.locator('.cast-strip').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Actor Test'})).toBeVisible();
  await expect(page.locator('.grid .card')).toHaveCount(60);
  await expect.poll(async()=>{
    await page.locator('main').evaluate(n=>n.scrollTop=n.scrollHeight);
    return page.locator('.grid .card').count();
  }).toBeLessThan(85);
  await page.locator('main').evaluate(main=>main.scrollTop=main.scrollHeight*.65);
  await expect.poll(async()=>!!(await visibleGridAnchor(page))).toBe(true);
  await page.locator('.grid').evaluate(grid=>{
    window.actorRefreshes=0;
    const original=grid._windowedGrid.refreshLayout;
    grid._windowedGrid.refreshLayout=()=>{window.actorRefreshes++;original();};
  });
  // Hold the focused filmography title in the same viewport position when
  // late actor facts/biography are inserted above the virtualized grid.
  const anchored=await page.locator('main').evaluate(main=>{
    const pane=main.getBoundingClientRect();
    const card=Array.from(main.querySelectorAll('.grid .card')).find(node=>{
      const box=node.getBoundingClientRect();
      return box.top>pane.top+12 && box.bottom<pane.bottom-12;
    });
    if(!card)return null;
    card.focus();
    return {id:card.dataset.focus,top:card.getBoundingClientRect().top,
      scroll:main.scrollTop};
  });
  expect(anchored).not.toBeNull();
  releaseBio();
  await expect(page.getByText('Test City')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.actorRefreshes)).toBeGreaterThan(0);
  await expect(page.locator('main .grid .card[data-focus="'+anchored.id+'"]')).toBeFocused();
  const preserved=await page.locator('main .grid .card[data-focus="'+anchored.id+'"]')
    .evaluate(node=>node.getBoundingClientRect().top);
  expect(Math.abs(preserved-anchored.top)).toBeLessThan(4);
  // A subsequent manual biography expansion is another above-grid layout
  // shift, including when the grid card is still holding remote focus.
  const toggle=page.locator('.actor-biography-toggle');
  await expect(toggle).toHaveCount(1);
  await toggle.evaluate(node=>node.click());
  await expect(toggle).toHaveText('Show less');
  await expect.poll(()=>page.locator('main .grid .card[data-focus="'+anchored.id+'"]')
    .evaluate(node=>node.getBoundingClientRect().top)).toBeCloseTo(anchored.top,0);
  await toggle.evaluate(node=>node.click());
  await expect(toggle).toHaveText('Show more');
  await expect.poll(()=>page.locator('main .grid .card[data-focus="'+anchored.id+'"]')
    .evaluate(node=>node.getBoundingClientRect().top)).toBeCloseTo(anchored.top,0);
  await expect.poll(async()=>!!(await visibleGridAnchor(page))).toBe(true);
  const before=await visibleGridAnchor(page);
  const focusedIndex=await page.locator('main .grid').evaluate((grid,index)=>{
    const node=Array.from(grid.querySelectorAll('.card')).find(n=>n._gridIndex===index);
    if(node)node.focus();
    return node ? node._gridIndex : null;
  },before.index);
  expect(focusedIndex).toBe(before.index);
  await page.keyboard.press('ArrowDown');
  await expect.poll(()=>page.locator('main .grid .card:focus')
    .evaluate(node=>node._gridIndex)).toBe(before.index+before.columns);
});

test('shared recycler budget covers nine separately cached library pages',async({page})=>{
  await mockLongJellyfinLibrary(page);
  await page.route('http://media.test/Users/user/Views**',route=>
    route.fulfill({json:{Items:Array.from({length:9},(_,index)=>({
      Id:'movies-'+index,Name:'Movies '+index,CollectionType:'movies'
    }))}}));
  await page.goto('/');
  for(let index=0;index<9;index++){
    await page.locator('nav button[data-nav-id="library:movies-'+index+'"]').click();
    await expect(page.locator('main .grid .card')).toHaveCount(60);
    // Visit enough different rows to populate and then prune per-grid caches.
    await page.locator('main').evaluate(main=>main.scrollTop=main.scrollHeight);
    await expect.poll(()=>page.locator('main .grid').evaluate(grid=>
      grid._windowedGrid.retainedCardStats().globalCached)).toBeLessThanOrEqual(48);
  }
  // Earlier tabs remain restorable, but their detached/recycled artwork nodes
  // are not retained separately by each of the nine recycler instances.
  await page.locator('nav button[data-nav-id="library:movies-3"]').click();
  const stats=await page.locator('main .grid').evaluate(grid=>grid._windowedGrid.retainedCardStats());
  expect(stats.globalCached).toBeLessThanOrEqual(48);
  expect(stats.mounted).toBeLessThanOrEqual(
    Math.max(80,stats.columns*(stats.visibleRows+8)));
});

for(const layout of ['grid','flex']) {
  test('Down at the last loaded row never moves sideways or self-focuses ('+layout+')',async({page})=>{
    const calls=await mockLongJellyfinLibrary(page);
    await page.setViewportSize({width:1280,height:720});
    await page.goto('/');
    if(layout==='flex') await page.addStyleTag({content:`
      main .grid{display:flex!important}
      main .grid .card{flex:0 0 170px!important;width:170px!important;
        margin:0 20px 26px 0!important}
    `});
    await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
    await expect(page.locator('.grid .card')).toHaveCount(60);
    const columns=await page.locator('.grid').evaluate(grid=>grid._windowedGrid.columns);
    const finalRow=Math.floor(59/columns);
    const firstOfLast=finalRow*columns;
    await page.locator('.grid .card[data-focus="'+firstOfLast+'"]').focus();
    await page.keyboard.press('ArrowDown');
    // The incomplete paginator can still trigger its next fetch, but not
    // redirect focus to another card in the same terminal row.
    const focused=await page.evaluate(()=>document.activeElement.dataset.focus);
    expect(focused).not.toBe('59');
    // Once more pages have loaded, the actual final row must also hand off
    // to ordinary page scrolling (rather than focus itself indefinitely).
    await fillFivePages(page,calls);
    await expect.poll(async()=>{
      await page.locator('main').evaluate(main=>main.scrollTop=main.scrollHeight);
      return calls.includes(300);
    }).toBe(true);
    await page.locator('main').evaluate(main=>main.scrollTop=main.scrollHeight);
    const lastRow=Math.floor(359/columns)*columns;
    await expect(page.locator('.grid .card[data-focus="'+lastRow+'"]')).toHaveCount(1);
    await page.locator('.grid .card[data-focus="'+lastRow+'"]').focus();
    await page.keyboard.press('ArrowDown');
    const terminal=await page.evaluate(()=>document.activeElement.dataset.focus);
    expect(terminal).not.toBe('359');
  });
  test('overlapping '+layout+' offset pages keep both logical cards distinct',async({page})=>{
    const calls=await mockLongJellyfinLibrary(page);
    await page.route('http://media.test/Users/user/Items**',route=>{
      const url=new URL(route.request().url());
      const start=Number(url.searchParams.get('StartIndex')||0);
      if(start!==60)return route.fallback();
      // An insertion above a page boundary makes page 60 contain the old
      // final item 59 again; there must be two distinct logical DOM nodes.
      calls.push(start);
      const items=Array.from({length:60},(_,i)=>{
        const n=start+i-1;
        return {Id:String(n),Name:'Title '+String(n).padStart(3,'0'),
          Type:'Movie',ImageTags:{Primary:'art-'+n}};
      });
      return route.fulfill({json:{Items:items,TotalRecordCount:360}});
    });
    await page.setViewportSize({width:1280,height:720});
    await page.goto('/');
    if(layout==='flex') await page.addStyleTag({content:`
      main .grid{display:flex!important}
      main .grid .card{flex:0 0 170px!important;width:170px!important;
        margin:0 20px 26px 0!important}
    `});
    await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
    await expect.poll(async()=>{
      await page.locator('main').evaluate(main=>main.scrollTop=main.scrollHeight);
      return calls.includes(60);
    }).toBe(true);
    await expect.poll(async()=>page.locator('.grid').evaluate(grid=>{
      const cards=Array.from(grid.querySelectorAll('.card'));
      return cards.some(n=>n._gridIndex>=60);
    })).toBe(true);
    await page.locator('main').evaluate(main=>{
      const grid=main.querySelector('.grid');
      const cards=Array.from(grid.querySelectorAll('.card'));
      const first=cards[0].getBoundingClientRect();
      const second=cards.find(node=>Math.abs(node.getBoundingClientRect().top-first.top)>3);
      const stride=second?second.getBoundingClientRect().top-first.top:340;
      const columns=grid._windowedGrid.columns;
      // The grid already has a virtual top spacer. Its current position is
      // not the origin of the entire catalog: the spacer's position is.
      const top=main.scrollTop+grid.previousElementSibling.getBoundingClientRect().top-
        main.getBoundingClientRect().top;
      main.scrollTop=top+Math.floor(59/columns)*stride;
    });
    await expect(page.locator('.grid .card[data-focus="59"]')).toHaveCount(2);
    const duplicateState=await page.locator('.grid').evaluate(grid=>{
      const nodes=Array.from(grid.querySelectorAll('.card'));
      const duplicates=nodes.filter(node=>node.dataset.focus==='59');
      return {total:nodes.length,unique:new Set(nodes).size,
        indices:duplicates.map(node=>node._gridIndex),same:duplicates[0]===duplicates[1]};
    });
    expect(duplicateState.indices).toEqual([59,60]);
    expect(duplicateState.same).toBe(false);
    expect(duplicateState.total).toBe(duplicateState.unique);
    await page.locator('.grid .card[data-focus="59"]').first().focus();
    const columns=await page.locator('.grid').evaluate(grid=>grid._windowedGrid.columns);
    await page.keyboard.press('ArrowDown');
    await expect.poll(()=>page.locator('.grid .card:focus').evaluate(node=>node._gridIndex))
      .toBe(59+columns);
    // Returning from detail must restore the second occurrence, not the
    // first card with the same data-focus/title ID.
    await page.locator('.grid .card[data-focus="59"]').nth(1).click();
    await expect(page.getByRole('heading',{name:'Title 059'})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(()=>page.locator('.grid .card:focus').evaluate(node=>({
      key:node._gridKey,index:node._gridIndex
    }))).toEqual({key:JSON.stringify(['59',1]),index:60});
    // A freshness update removes the first occurrence from page 0 while
    // retaining the same title at page 60, now occurrence zero.
    await page.locator('.grid').evaluate(async grid=>{
      const entries=Array.from({length:60},(_,i)=>({
        id:String(i),title:'Title '+String(i).padStart(3,'0'),
        type:'Movie',subtitle:i%3===0?'2020':'',
        raw:{Id:String(i),Name:'Title '+String(i).padStart(3,'0'),
          Type:'Movie',ImageTags:{Primary:'art-'+i}}
      }));
      entries[59]={id:'replacement-59',title:'Replacement title',type:'Movie',
        raw:{Id:'replacement-59',Name:'Replacement title',Type:'Movie'}};
      await grid._applyCatalogUpdate(0,{changed:true,value:{items:entries,total:360}});
    });
    await expect(page.locator('.grid .card[data-focus="59"]')).toHaveCount(1);
    await expect.poll(()=>page.locator('.grid .card:focus').evaluate(node=>({
      key:node._gridKey,id:node.dataset.focus,index:node._gridIndex
    }))).toEqual({key:JSON.stringify(['59',0]),id:'59',index:60});
  });
}

for(const layout of ['grid','flex']) {
  test('resizing taller loads newly visible artwork without child-list mutation ('+layout+')',async({page})=>{
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUsAlgYGBgYmBgYGBgAAAIcgC421576AAAAABJRU5ErkJggg==','base64');
    await mockLongJellyfinLibrary(page);
    await page.route('http://media.test/Items/*/Images/Primary**',route=>
      route.fulfill({body:png,contentType:'image/png'}));
    await page.setViewportSize({width:1280,height:550});
    await page.goto('/');
    if(layout==='flex') await page.addStyleTag({content:`
      main .grid{display:flex!important}
      main .grid .card{flex:0 0 170px!important;width:170px!important;
        margin:0 20px 26px 0!important}
    `});
    await page.locator('.rail-library-items').getByRole('button',{name:'Movies'}).click();
    await expect(page.locator('.grid .card')).toHaveCount(60);
    // Clear focus scrolling from entering the library before measuring. The
    // poster must become visible due only to changing the viewport height.
    await page.locator('nav button[data-nav-id="library:movies"]').focus();
    await page.locator('main').evaluate(main=>{main.scrollTop=0;});
    await expect.poll(()=>page.locator('main').evaluate(main=>main.scrollTop)).toBe(0);
    const target=await page.locator('main').evaluate(main=>{
      const view=main.getBoundingClientRect();
      const img=Array.from(main.querySelectorAll('img[data-poster-src]')).find(node=>{
        const box=node.getBoundingClientRect();
        return box.top>view.bottom+230 && box.top<view.bottom+850;
      });
      if(!img)return null;
      window.resizeTargetImage=img;
      window.resizeTargetCard=img.closest('.card');
      return {src:img.getAttribute('src'),pending:img.getAttribute('data-poster-src')};
    });
    expect(target).not.toBeNull();
    expect(target.src).toBeNull();
    expect(target.pending).toBeTruthy();
    const scroll=await page.locator('main').evaluate(main=>main.scrollTop);
    await page.setViewportSize({width:1280,height:1550});
    const resized=await page.evaluate(()=>({
      connected:window.resizeTargetImage.isConnected,
      sameCard:window.resizeTargetImage.closest('.card')===window.resizeTargetCard,
      src:window.resizeTargetImage.getAttribute('src'),
      pending:window.resizeTargetImage.getAttribute('data-poster-src')
    }));
    expect(resized.connected).toBe(true);
    expect(resized.sameCard).toBe(true);
    await expect.poll(()=>page.evaluate(()=>{
      const img=window.resizeTargetImage;
      return img.getAttribute('src')!==null && img.complete && img.naturalWidth>0;
    }),{timeout:15000}).toBe(true);
    expect(await page.locator('main').evaluate(main=>main.scrollTop)).toBe(scroll);
  });
}
