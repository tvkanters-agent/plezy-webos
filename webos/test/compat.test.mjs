import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script, createContext, runInContext} from 'node:vm';

test('webOS 4.x shims restore missing Chromium 53 APIs', async () => {
  const source = await readFile(new URL('../src/compat.js', import.meta.url), 'utf8');
  const context = createContext({});
  runInContext(`
    class ElementMock {
      constructor() { this.children = []; }
      appendChild(node) { this.children.push(node); }
    }
    var Element = ElementMock;
    var document = {createTextNode: text => ({nodeType: 3, text})};
    var window = this;
    Promise.allSettled = undefined;
    Promise.prototype.finally = undefined;
    String.prototype.padStart = undefined;
    AbortController = undefined;
    Object.values = undefined;
    Object.entries = undefined;
    window.fetch = (url, options) => new Promise(() => {});
  `, context);
  new Script(source, {filename: 'compat.js'}).runInContext(context);
  const output = await runInContext(`(async () => {
    const element = new Element();
    element.append('hi', ' there');
    const results = await Promise.allSettled([Promise.resolve(7), Promise.reject('no')]);
    const final = await Promise.resolve(8).finally(() => {});
    const controller = new AbortController();
    const request = fetch('/unreachable', {signal: controller.signal}).catch(error => error.name);
    controller.abort();
    return {children: element.children.map(x => x.text), results, final,
      pad: '7'.padStart(3, '0'), aborted: await request,
      values: Object.values({a: 7, b: 8}).join(','),
      entries: JSON.stringify(Object.entries({a: 7, b: 8})),
      enumerable: Object.prototype.propertyIsEnumerable.call(Object, 'values') ||
        Object.prototype.propertyIsEnumerable.call(Object, 'entries')};
  })()`, context);
  assert.deepEqual(Array.from(output.children), ['hi', ' there']);
  assert.equal(output.results[0].status, 'fulfilled');
  assert.equal(output.results[0].value, 7);
  assert.equal(output.results[1].status, 'rejected');
  assert.equal(output.final, 8);
  assert.equal(output.pad, '007');
  assert.equal(output.aborted, 'AbortError');
  assert.equal(output.values, '7,8');
  assert.equal(output.entries, '[["a",7],["b",8]]');
  assert.equal(output.enumerable, false);
});

test('Chromium 53 object shims preserve own-key order and reject nullish input', async () => {
  const source = await readFile(new URL('../src/compat.js', import.meta.url), 'utf8');
  const context = createContext({});
  runInContext('var window = this; Object.values = undefined; Object.entries = undefined;', context);
  new Script(source).runInContext(context);
  assert.equal(runInContext(`(() => {
    const value = Object.create({inherited: 1});
    value[2] = 'two'; value[1] = 'one'; value.name = 'name';
    Object.defineProperty(value, 'hidden', {value: 9});
    value[Symbol('symbol')] = 3;
    return JSON.stringify([Object.values(value), Object.entries(value),
      Object.values('ab'), Object.entries(7)]);
  })()`, context), '[["one","two","name"],[["1","one"],["2","two"],["name","name"]],["a","b"],[]]');
  for (const method of ['values', 'entries']) {
    for (const value of ['null', 'undefined']) {
      assert.equal(runInContext(`(() => {
        try { Object.${method}(${value}); return false; }
        catch (error) { return error instanceof TypeError; }
      })()`, context), true);
    }
  }
  assert.equal(runInContext(`(() => {
    const values = Object.values, entries = Object.entries;
    ${source}
    return Object.values === values && Object.entries === entries;
  })()`, context), true, 'existing implementations are preserved');
});
