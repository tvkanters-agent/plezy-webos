import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchingCollections, mergedCollectionLoader} from '../src/collection-merge.js';

const collection = (id, title, library) => ({
  id, title, type: 'collection', raw: {librarySectionID: library}
});
const media = (id, type = 'movie') => ({id, title: id, type});

test('matches equal collection names across libraries, not different titles or own library', async () => {
  const libraries = [
    {id: 'movies', title: 'Movies'}, {id: 'series', title: 'Series'},
    {id: 'archive', title: 'Archive'}, {id: 'broken', title: 'Broken'}
  ];
  const calls = [];
  const api = {
    libraries: async () => libraries,
    collections: async (id, start) => {
      calls.push([id, start]);
      if (id === 'broken') throw new Error('offline');
      if (id === 'movies') return {items: [collection('primary', 'Festival', 'movies'),
        collection('own-duplicate', 'Festival', 'movies')], total: 2};
      if (id === 'series') return start === 0
        ? {items: [collection('other', '  festival ', 'series')], total: 2}
        : {items: [collection('wrong', 'Festival Extra', 'series')], total: 2};
      return {items: [collection('archive', 'FESTIVAL', 'archive')], total: 1};
    }
  };
  const matches = await matchingCollections(api, collection('primary', 'Festival', 'movies'));
  assert.deepEqual(matches, [
    {id:'primary', libraryId:'movies', libraryTitle:'Movies'},
    {id:'other', libraryId:'series', libraryTitle:'Series'},
    {id:'archive', libraryId:'archive', libraryTitle:'Archive'}
  ]);
  assert.ok(calls.some(([id, start]) => id === 'series' && start === 1));
});

test('source library is inferred if Plex detail omits librarySectionID', async () => {
  const api = {
    libraries: async () => [{id: 'a', title: 'A'}, {id: 'b', title: 'B'}],
    collections: async id => ({items: id === 'a' ?
      [collection('first', 'Series', 'a'), collection('same-library', 'Series', 'a')] :
      [collection('second', 'Series', 'b')], total: id === 'a' ? 2 : 1})
  };
  assert.deepEqual(await matchingCollections(api, {id: 'first', title: 'Series'}), [
    {id:'first', libraryId:'a', libraryTitle:'A'},
    {id:'second', libraryId:'b', libraryTitle:'B'}
  ]);
});

test('mixed movie and TV collections stream in original order without repeated items', async () => {
  const first = Array.from({length: 65}, (_, i) => media('movie-' + i));
  const second = [first[0], media('series-0', 'show'), media('series-1', 'show')];
  const calls = [];
  const api = {
    libraries: async () => [{id: 'movies', title: 'Movies'}, {id: 'tv', title: 'TV'}],
    collections: async id => ({items: [collection(id === 'movies' ? 'movies-col' : 'tv-col',
      'Favorites', id)], total: 1}),
    children: async (id, start, kind) => {
      calls.push([id, start, kind]);
      const all = id === 'movies-col' ? first : second;
      return {items: all.slice(start, start + 60), total: all.length};
    }
  };
  const load = mergedCollectionLoader(api, collection('movies-col', 'Favorites', 'movies'));
  const page1 = await load(0), page2 = await load(60);
  assert.equal(page1.items.length, 60);
  assert.equal(page2.items.length, 7);
  assert.deepEqual([...page1.items, ...page2.items].map(item => item.id),
    [...first.map(item => item.id), 'series-0', 'series-1']);
  assert.equal(page2.total, 67);
  assert.deepEqual(page1.groups.map(group => [group.libraryTitle, group.items.length]),
    [['Movies', 60]]);
  assert.deepEqual(page2.groups.map(group => [group.libraryTitle, group.items.length]),
    [['Movies', 5], ['TV', 2]]);
  assert.deepEqual(page2.groups.map(group => group.libraryId), ['movies', 'tv']);
  assert.deepEqual(calls, [
    ['movies-col', 0, 'collection'], ['movies-col', 60, 'collection'],
    ['tv-col', 0, 'collection']
  ]);
});

test('a failed secondary collection does not prevent primary items rendering', async () => {
  const api = {
    libraries: async () => [{id: 'movies'}, {id: 'tv'}],
    collections: async id => ({items: [collection(id, 'Favorites', id)], total: 1}),
    children: async id => {
      if (id === 'tv') throw new Error('gone');
      return {items: [media('film')], total: 1};
    }
  };
  const result = await mergedCollectionLoader(api, collection('movies', 'Favorites', 'movies'))(0);
  assert.deepEqual(result.items.map(item => item.id), ['film']);
  assert.equal(result.total, 1);
});

test('a transient primary-page failure can be retried without dropping queued titles', async () => {
  let errorOnce = true;
  const api = {
    libraries: async () => [],
    children: async (id, start) => {
      if (start === 60 && errorOnce) { errorOnce = false; throw new Error('retry'); }
      return {items: Array.from({length: Math.min(60, 62 - start)},
        (_, index) => media('item-' + (start + index))), total: 62};
    }
  };
  const load = mergedCollectionLoader(api, collection('original', 'Favorites', 'movies'));
  assert.equal((await load(0)).items.length, 60);
  await assert.rejects(load(60), /retry/);
  const page = await load(60);
  assert.deepEqual(page.items.map(item => item.id), ['item-60','item-61']);
  assert.equal(page.total, 62);
});

test('library group metadata is preserved through page boundaries and unavailable libraries', async () => {
  const films = Array.from({length: 61}, (_, i) => media('film-' + i));
  const api = {
    libraries: async () => [{id:'films',title:'Films'}, {id:'empty',title:'Empty'},
      {id:'shows',title:'Television'}],
    collections: async id => ({items:[collection(id, 'Favorites', id)],total:1}),
    children: async (id,start) => {
      const items = id === 'films' ? films : id === 'shows' ? [media('series', 'show')] : [];
      return {items:items.slice(start,start+60),total:items.length};
    }
  };
  const load = mergedCollectionLoader(api, collection('films','Favorites','films'));
  const first = await load(0), second = await load(60);
  assert.deepEqual(first.groups.map(group => group.libraryTitle), ['Films']);
  assert.deepEqual(second.groups.map(group => group.libraryTitle), ['Films','Television']);
  assert.deepEqual(second.groups.map(group => group.items.map(item=>item.id)),
    [['film-60'],['series']]);
  assert.equal(second.total, 62);
});

test('unavailable collection discovery still shows original titles under its library heading', async () => {
  const api = {
    libraries: async () => { throw new Error('offline'); },
    children: async () => ({items:[media('one')],total:1})
  };
  const page = await mergedCollectionLoader(api, {
    id:'c',title:'Favorites',raw:{librarySectionID:7,librarySectionTitle:'My Movies'}
  })(0);
  assert.deepEqual(page.groups.map(group => group.libraryTitle), ['My Movies']);
});
