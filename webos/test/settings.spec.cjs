const {test,expect} = require('@playwright/test');

async function connected(page) {
  await page.addInitScript(() => localStorage.setItem('plezy.webos',JSON.stringify({
    deviceId:'settings-device',active:'server',servers:[{
      id:'server',kind:'jellyfin',name:'Living room',url:'http://settings.test',
      token:'saved-token',userId:'viewer'
    }]
  })));
  await page.route('http://settings.test/**',async route => {
    const pathname=new URL(route.request().url()).pathname;
    const json=pathname.endsWith('/Views') ? {Items:[{Id:'movies',Name:'Movies',CollectionType:'movies'}]} :
      pathname.endsWith('/Items/Resume') ? {Items:[]} :
      pathname.endsWith('/Items/Latest') ? [] :
      pathname.endsWith('/Items') ? {Items:[],TotalRecordCount:0} : {Items:[]};
    await route.fulfill({json});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
}

test('Settings uses upstream grouped tiles and pushed subpages with Back focus restoration',async({page},testInfo)=>{
  await connected(page);
  await page.screenshot({path:testInfo.outputPath('settings.png')});
  const group=page.locator('.settings-group').first();
  await expect(group.locator('.settings-tile')).toHaveCount(3);
  await expect(page.getByRole('heading',{name:'Connections'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Add Connection'})).toBeVisible();
  await expect(group.locator('.settings-tile').first()).toHaveCSS('border-top-left-radius','20px');
  await expect(group.locator('.settings-tile').nth(1)).toHaveCSS('border-top-left-radius','5px');
  await expect(group.locator('.settings-tile').last()).toHaveCSS('border-bottom-right-radius','20px');
  const playback=page.getByRole('button',{name:'Video Playback',exact:true});
  await playback.click();
  await page.screenshot({path:testInfo.outputPath('playback-settings.png')});
  await expect(page.getByRole('heading',{name:'Video Playback',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Player',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Auto-play & Skip'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Enhanced SRT playback'})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
  await expect(playback).toBeFocused();
  await page.getByRole('button',{name:'Services',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Services',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Simkl',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Simkl',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Simkl',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Services',exact:true})).toBeFocused();
});

test('Playback settings preserve toggle focus and use selection/input dialogs',async({page})=>{
  await connected(page);
  await page.getByRole('button',{name:'Video Playback',exact:true}).click();
  const srt=page.getByRole('button',{name:'Enhanced SRT playback'});
  await expect(page.getByRole('button',{name:'Enhanced ASS playback'})).toHaveCount(0);
  await expect(srt).toHaveAttribute('aria-pressed','false');
  await srt.click();
  await expect(srt).toHaveAttribute('aria-pressed','true');
  await expect(srt).toBeFocused();
  const quality=page.getByRole('button',{name:'Quality',exact:true});
  await page.keyboard.press('ArrowDown');
  await expect(quality).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Compatible H.264 / AAC',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(quality).toBeFocused();
  await expect(quality.locator('.settings-tile-subtitle')).toContainText('Compatible H.264 / AAC');
  const delay=page.getByRole('button',{name:'Automatic skip delay',exact:true});
  await delay.click();
  await page.getByRole('dialog').getByRole('spinbutton',{name:'Automatic skip delay'}).fill('31');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByText('Use a delay between 1 and 30 seconds.')).toBeVisible();
  await page.getByRole('dialog').getByRole('spinbutton',{name:'Automatic skip delay'}).fill('12');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(delay.locator('.settings-tile-subtitle')).toHaveText('12 seconds');
  const intro=page.getByRole('button',{name:'Intro chapter pattern',exact:true});
  await intro.click();
  await page.getByRole('dialog').getByRole('textbox',{name:'Intro chapter pattern'}).fill('[');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByText('Enter a nonempty valid regular expression.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(intro).toBeFocused();
  expect(await page.evaluate(()=>{
    const state=JSON.parse(localStorage.getItem('plezy.webos'));
    return [state.srtPlayback,Object.prototype.hasOwnProperty.call(state,'assPlayback'),state.quality,state.autoSkipDelay,state.introPattern];
  })).toEqual([true,false,'transcode',12,'']);
});

test('general Diagnostics lives under About, defaults off and persists only when enabled',async({page})=>{
  await connected(page);
  await page.getByRole('button',{name:'About',exact:true}).click();
  await expect(page.getByRole('heading',{name:'About',exact:true})).toBeVisible();
  await expect(page.getByText(/^Version \d+\.\d+\.\d+$/)).toBeVisible();
  const diagnostics=page.getByRole('button',{name:'Enable diagnostics',exact:true});
  await expect(diagnostics).toHaveAttribute('aria-pressed','false');
  await diagnostics.click();
  await expect(diagnostics).toHaveAttribute('aria-pressed','true');
  await expect(diagnostics).toBeFocused();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('plezy.webos')).diagnosticsEnabled)).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'About',exact:true}).click();
  await expect(page.getByRole('button',{name:'Enable diagnostics',exact:true}))
    .toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Enable diagnostics',exact:true}).click();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('plezy.webos')).diagnosticsEnabled)).toBe(false);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Video Playback',exact:true}).click();
  await expect(page.getByRole('button',{name:'Subtitle diagnostics',exact:true})).toHaveCount(0);
});

test('Subtitle Styling matches native Text/Border groups with TV-friendly editors and persists choices',async({page},testInfo)=>{
  await connected(page);
  await page.getByRole('button',{name:'Video Playback',exact:true}).click();
  const link=page.getByRole('button',{name:'Subtitle Styling',exact:true});
  await link.click();
  await expect(page.getByRole('heading',{name:'Subtitle Styling',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Text',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Border',exact:true})).toBeVisible();
  await expect(page.locator('.settings-group-items').first().locator('.settings-tile')).toHaveCount(6);
  await expect(page.locator('.settings-group-items').last().locator('.settings-tile')).toHaveCount(2);
  await expect(page.getByRole('button',{name:'Background Color'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'ASS Override'})).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('subtitle-styling.png')});

  const size=page.getByRole('button',{name:'Font Size',exact:true});
  await size.click();
  const spinner=page.getByRole('dialog').getByRole('button',{name:'Font Size'});
  await expect(spinner).toBeFocused();
  await expect(spinner).toHaveText('38');
  await page.keyboard.press('ArrowRight');
  await expect(spinner).toHaveText('39');
  await expect(spinner).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(spinner).toHaveText('39');
  await expect(spinner).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const save=page.getByRole('dialog').getByRole('button',{name:'Save'});
  const cancel=page.getByRole('dialog').getByRole('button',{name:'Cancel'});
  await expect(save).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(spinner).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(save).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(spinner).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(size).toBeFocused();
  await expect(size.locator('.settings-tile-subtitle')).toHaveText('39');

  const textColor=page.getByRole('button',{name:'Text Color',exact:true});
  await textColor.click();
  await expect(page.getByRole('dialog').getByRole('button',{name:'Hue'})).toBeFocused();
  await expect(page.getByRole('dialog').getByRole('button',{name:'Saturation'})).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button',{name:'Brightness'})).toBeVisible();
  const hex=page.getByRole('dialog').getByRole('textbox',{name:'Hex Color'});
  await hex.fill('FF0088');
  await page.getByRole('dialog').getByRole('button',{name:'Save'}).click();
  await expect(textColor.locator('.settings-color-swatch')).toHaveCSS('background-color','rgb(255, 0, 136)');
  await expect(textColor).toBeFocused();

  const margin=page.getByRole('button',{name:'Use margins',exact:true});
  await expect(margin).toHaveAttribute('aria-pressed','true');
  await margin.click();
  await expect(margin).toHaveAttribute('aria-pressed','false');
  await page.getByRole('button',{name:'Bold',exact:true}).click();
  await page.getByRole('button',{name:'Italic',exact:true}).click();
  const border=page.getByRole('button',{name:'Border Size',exact:true});
  await border.click();
  const control=page.getByRole('dialog').getByRole('button',{name:'Border Size'});
  await page.keyboard.press('ArrowLeft');
  await expect(control).toHaveText('2');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('dialog').getByRole('button',{name:'Save'})).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(control).toBeFocused();
  await page.keyboard.press('Enter');

  await page.keyboard.press('Escape');
  await expect(link).toBeFocused();
  await link.click();
  await expect(size.locator('.settings-tile-subtitle')).toHaveText('39');
  await expect(page.getByRole('button',{name:'Use margins'})).toHaveAttribute('aria-pressed','false');
  expect(await page.evaluate(()=>{
    const s=JSON.parse(localStorage.getItem('plezy.webos'));
    return [s.subtitleFontSize,s.subtitleTextColor,s.subtitleUseMargins,
      s.subtitleBold,s.subtitleItalic,s.subtitleBorderSize];
  })).toEqual([39,'#FF0088',false,true,true,2]);
});

test('Subtitle numeric dialogs keep stable D-pad focus between value, actions and Back',async({page})=>{
  await connected(page);
  await page.getByRole('button',{name:'Video Playback',exact:true}).click();
  await page.getByRole('button',{name:'Subtitle Styling',exact:true}).click();
  const position=page.getByRole('button',{name:'Position',exact:true});
  await position.click();
  const dialog=page.getByRole('dialog');
  const number=dialog.getByRole('button',{name:'Position'});
  const save=dialog.getByRole('button',{name:'Save'});
  const cancel=dialog.getByRole('button',{name:'Cancel'});
  await expect(number).toBeFocused();
  for(let i=0;i<5;i++)await page.keyboard.press('ArrowRight');
  await expect(number).toHaveText('105');
  await expect(number).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(save).toBeFocused();
  await page.keyboard.press('ArrowRight'); // Right edge must not escape.
  await expect(save).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('ArrowLeft'); // Left edge must not escape.
  await expect(cancel).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(number).toBeFocused();
  for(let i=0;i<5;i++)await page.keyboard.press('ArrowLeft');
  await expect(number).toHaveText('100');
  await expect(number).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(save).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(number).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(position).toBeFocused();
  await expect(position.locator('.settings-tile-subtitle')).toHaveText('Bottom');
});

test('Manage Libraries switches update the rail without rebuilding or losing remote focus',async({page})=>{
  await connected(page);
  const manage=page.getByRole('button',{name:'Manage Libraries',exact:true});
  await expect(manage).toBeVisible();
  await manage.click();
  const hide=page.getByRole('button',{name:'Hide Movies in sidebar'});
  await expect(hide).toHaveAttribute('aria-pressed','true');
  await hide.click();
  const show=page.getByRole('button',{name:'Show Movies in sidebar'});
  await expect(show).toHaveAttribute('aria-pressed','false');
  await expect(show).toBeFocused();
  await expect(page.locator('.rail-library-items').getByRole('button',{name:'Movies'})).toHaveCount(0);
  await show.click();
  await expect(page.locator('.rail-library-items').getByRole('button',{name:'Movies'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(manage).toBeFocused();
});

test('TV remote reaches lower settings rows by scrolling without losing focus',async({page})=>{
  await page.setViewportSize({width:1280,height:720});
  await connected(page);
  await page.getByRole('button',{name:'Video Playback',exact:true}).click();
  const first=page.getByRole('button',{name:'Enhanced SRT playback'});
  await expect(first).toBeFocused();
  for(let i=0;i<9;i++)await page.keyboard.press('ArrowDown');
  const last=page.getByRole('button',{name:'Credits chapter pattern',exact:true});
  await expect(last).toBeFocused();
  expect(await last.evaluate(node=>{
    const row=node.getBoundingClientRect(),view=document.querySelector('#main').getBoundingClientRect();
    return row.top>=view.top && row.bottom<=view.bottom;
  })).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Video Playback',exact:true})).toBeFocused();
});
