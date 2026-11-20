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
    '<?xml version="1.0" encoding="utf-8"?>\n<Preferences GdmEnabled="0" EnableIPv6="0" DlnaEnabled="0" RelayEnabled="0" LogDebug="1"/>');
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
      signal:AbortSignal.timeout(options.method === 'POST' ? 70000 : 14000)});
  }
  await waitFor('Plex never finished starting',async () => (await get('/library/sections')).ok);
  const params = new URLSearchParams({name:'Plezy Subtitle Fixture',type:'movie',
    agent:'com.plexapp.agents.none',scanner:'Plex Video Files Scanner',language:'xn',location:library});
  await waitFor('Plex did not become ready to create the fixture library',async () => {
    const added = await get('/library/sections?' + params,{method:'POST'});
    if (added.ok) { console.log('Plex fixture library created'); return true; }
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
    const old = new URL(session.subtitleAsset.url);
    const sub = new URL(old);
    sub.pathname = '/subtitles/:/transcode/universal/start';
    sub.searchParams.set('session',crypto.randomUUID().replaceAll('-',''));
    sub.searchParams.set('X-Plex-Session-Identifier',sub.searchParams.get('session'));
    for (const [key, value] of Object.entries({protocol:'http',fastSeek:'1',copyts:'1',directPlay:'1',hasMDE:'1',
      directStream:'1',directStreamAudio:'1',subtitles:'sidecar',advancedSubtitles:'text'}))
      sub.searchParams.set(key,value);
    for (const key of ['videoQuality','videoCodec','audioCodec','videoResolution','maxVideoBitrate',
        'subtitleSize','X-Plex-Client-Profile-Extra']) sub.searchParams.delete(key);
    for (const variant of ['http','web-full','http-ass-extension','generic-sidecar']) {
      const url = new URL(sub);
      const subtitleSession = crypto.randomUUID().replaceAll('-','');
      url.searchParams.set('session',subtitleSession);
      url.searchParams.set('X-Plex-Session-Identifier',subtitleSession);
      if (variant === 'web-full') {
        url.searchParams.delete('context');
        url.searchParams.delete('subtitleStreamID');
        for (const [key,value] of Object.entries({audioBoost:'100',subtitleSize:'100',videoResolution:'1920x1080',
          videoQuality:'100',mediaBufferSize:'50000',location:'lan'})) url.searchParams.set(key,value);
      } else if (variant === 'http-ass-extension') {
        url.pathname += '.ass';
      } else if (variant === 'generic-sidecar') {
        url.searchParams.set('X-Plex-Platform','Generic');
        url.searchParams.set('X-Plex-Client-Profile-Name','Generic');
        url.searchParams.set('X-Plex-Client-Profile-Extra',
          'add-transcode-target(type=subtitleProfile&context=all&protocol=http&container=ass&subtitleCodec=ass)');
      }
      try {
        const response = await fetch(url,{signal:AbortSignal.timeout(8000)});
        const content = await response.text();
        console.log('Standalone HTTP subtitle:',track.codec,variant,response.status,response.headers.get('content-type'),
          content.includes('Embedded'),content.length);
      } catch(e) { console.log('Standalone HTTP subtitle:',track.codec,variant,e.name); }
    }
    const logs = await readFile(join(profile,'Logs','Plex Media Server.log'),'utf8');
    for (const row of logs.split('\n').filter(line=>/transcod|sidecar|protocol|selected.*stream/i.test(line)).slice(-48)) {
      const message = row.split(' - ').at(-1).replaceAll(token,'[fixture token]').replace(/https?:[^ ]+/g,'[url]').replace(/\?[^ ]+/g,'?[query]');
      console.log('PMS event:',message.slice(0,255));
    }
    if (track === tracks[0]) {
      const video = new URL(session.url);
      video.searchParams.set('X-Plex-Platform','Generic');
      video.searchParams.set('X-Plex-Client-Profile-Name','Generic');
      video.searchParams.set('X-Plex-Session-Identifier',video.searchParams.get('session'));
      video.searchParams.set('hasMDE','1');
      video.searchParams.set('fastSeek','1');
      const master = await fetch(video,{signal:AbortSignal.timeout(25000)});
      const masterText = await master.text();
      console.log('Generic HLS start:',master.status,masterText.startsWith('#EXTM3U'));
      if (!masterText.startsWith('#EXTM3U')) continue;
      let playlist = masterText;
      let playlistUrl = video;
      if (masterText.includes('#EXT-X-STREAM-INF')) {
        const variant = playlist.split(/\r?\n/).find(line=>line&&!line.startsWith('#'));
        playlistUrl = new URL(variant,video);
        playlist = await (await get(playlistUrl.pathname+playlistUrl.search)).text();
      }
      const part = playlist.split(/\r?\n/).find(line=>line&&!line.startsWith('#'));
      if(!part) { console.log('Plex supplied no HLS segments'); continue; }
      const segment = new URL(part,playlistUrl);
      const mediaResponse = await get(segment.pathname+segment.search);
      const size = (await mediaResponse.arrayBuffer()).byteLength;
      console.log('Generic HLS first segment:',mediaResponse.status,size);

    }
  }
});
