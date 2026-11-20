import {test} from 'node:test';
import {execFile, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {Plex} from '../src/api.js';
import {extractMatroskaSubtitle} from '../src/matroska-subtitles.js';

const exec = promisify(execFile);
const version = '1.43.5.11079-b3b13e506';
const digest = '74e9a71c97e06d6e925cc4398279141fd838ee9df446f90e769614fa2c87a206';
const origin = 'http://127.0.0.1:32400';
const client = {'X-Plex-Client-Identifier':'plezy-subtitle-fixture', Accept:'application/json'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(message, finish) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = await finish();
    if (result) return result;
    await sleep(500);
  }
  throw new Error(message);
}

test('temporary live Plex subtitle transport probe', {skip:!process.env.GITHUB_ACTIONS, timeout:200000}, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'plezy-pms-'));
  const pkg = join(scratch, 'plex.deb');
  const packageUrl = 'https://downloads.plex.tv/plex-media-server-new/' + version + '/debian/plexmediaserver_' + version + '_amd64.deb';
  await exec('curl', ['-fsSL','--max-time','55','-o',pkg,packageUrl]);
  if (createHash('sha256').update(await readFile(pkg)).digest('hex') !== digest) throw Error('Plex package digest differs');
  await exec('dpkg-deb',['-x',pkg,scratch]);
  const home = join(scratch,'usr/lib/plexmediaserver');
  const library = join(scratch,'library');
  const state = join(scratch,'state');
  const profile = join(state,'Plex Media Server');
  await mkdir(library);
  await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'Preferences.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<Preferences GdmEnabled="0" EnableIPv6="0" DlnaEnabled="0" RelayEnabled="0"/>');
  await copyFile(new URL('./fixtures/embedded-subtitles.mkv', import.meta.url),join(library,'Plezy Fixture.mkv'));
  const process = spawn(join(home,'Plex Media Server'),{cwd:home,stdio:'ignore',env:{...globalThis.process.env,
    PLEX_MEDIA_SERVER_HOME:home, PLEX_MEDIA_SERVER_APPLICATION_SUPPORT_DIR:state,
    PLEX_MEDIA_SERVER_DISABLE_AUTOUPDATES:'1',LD_LIBRARY_PATH:join(home,'lib')}});
  t.after(() => process.kill());
  await waitFor('Plex did not listen',async () => {
    if (process.exitCode !== null || process.signalCode) throw Error('Plex exited on startup: ' + (process.exitCode ?? process.signalCode));
    const response = await fetch(origin + '/identity',{signal:AbortSignal.timeout(1000)}).catch(()=>null);
    return response?.ok;
  });
  const token = (await readFile(join(profile,'.LocalAdminToken'),'utf8')).trim();
  async function get(path, options = {}) {
    return fetch(origin + path,{...options,headers:{...client,'X-Plex-Token':token,...options.headers},
      signal:AbortSignal.timeout(14000)});
  }
  await waitFor('Plex never finished starting',async () => (await get('/library/sections')).ok);
  const params = new URLSearchParams({name:'Plezy Subtitle Fixture',type:'movie',
    agent:'tv.plex.agents.movie',scanner:'Plex Movie',language:'en-US',location:library});
  await waitFor('Plex did not become ready to create the fixture library',async () => {
    const added = await get('/library/sections?' + params,{method:'POST'});
    if (added.ok) return true;
    const details = (await added.text()).replaceAll(token,'[fixture token]').slice(0,350);
    if (details.includes('still starting up')) return false;
    throw Error('Could not create a fixture library: HTTP ' + added.status + ' ' + details);
  });
  const sections = (await (await get('/library/sections')).json()).MediaContainer.Directory;
  const section = sections.find(x => x.title === 'Plezy Subtitle Fixture');
  if (!section) throw Error('Could not find the fixture library');
  await get('/library/sections/' + section.key + '/refresh?force=1');
  const entry = await waitFor('Plex did not scan the fixture', async () =>
    (await (await get('/library/sections/' + section.key + '/all')).json()).MediaContainer.Metadata?.[0]);
  const raw = await waitFor('Plex did not analyze the fixture tracks', async () => {
    const item = (await (await get('/library/metadata/' + entry.ratingKey)).json()).MediaContainer.Metadata[0];
    return item.Media?.[0]?.Part?.[0]?.Stream?.some(track => track.streamType === 3) && item;
  });
  const part = raw.Media[0].Part[0];
  const tracks = part.Stream.filter(x => x.streamType === 3);
  console.log('Plex fixture streams:', JSON.stringify(tracks.map(x=>({codec:x.codec,index:x.index,subIndex:x.subIndex}))));
  const cors = await get(part.key,{method:'OPTIONS',headers:{Origin:'null','Access-Control-Request-Method':'GET',
    'Access-Control-Request-Headers':'range'}});
  console.log('Plex OPTIONS:', cors.status, cors.headers.get('access-control-allow-origin'),
    cors.headers.get('access-control-allow-headers'));
  const api = new Plex({kind:'plex',url:origin,token},'plezy-subtitle-fixture');
  for (const track of tracks) {
    const session = await api.playback({id:raw.ratingKey,title:raw.title,duration:raw.duration,raw},{subtitle:track.id});
    const text = await extractMatroskaSubtitle(session.subtitleAsset,AbortSignal.timeout(10000));
    console.log('MKV range extraction:',track.codec,text.includes('Embedded'));
    const current = new URL(session.subtitleAsset.url);
    for (const variant of ['current','sidecar','plex-web-contract']) {
      const url = new URL(current);
      url.searchParams.set('session',crypto.randomUUID());
      if (variant !== 'current') url.searchParams.set('subtitles','sidecar');
      if (variant === 'plex-web-contract') {
        url.searchParams.set('hasMDE','1');
        url.searchParams.set('fastSeek','1');
        url.searchParams.set('directStreamAudio','1');
        url.searchParams.set('X-Plex-Session-Identifier',crypto.randomUUID());
        for (const key of ['videoQuality','videoCodec','audioCodec','videoResolution','maxVideoBitrate','X-Plex-Client-Profile-Extra'])
          url.searchParams.delete(key);
      }
      try {
        const response = await fetch(url,{signal:AbortSignal.timeout(12000)});
        const text = await response.text();
        console.log('Plex sidecar:',track.codec,variant,response.status,response.headers.get('content-type'),
          text.includes('Embedded'),text.length, response.ok ? '' : text.replaceAll(token,'[fixture token]').slice(0,180));
      } catch (error) { console.log('Plex sidecar:',track.codec,variant,error.name); }
    }
  }
});
