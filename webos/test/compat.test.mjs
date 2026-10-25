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
      pad: '7'.padStart(3, '0'), aborted: await request};
  })()`, context);
  assert.deepEqual(Array.from(output.children), ['hi', ' there']);
  assert.equal(output.results[0].status, 'fulfilled');
  assert.equal(output.results[0].value, 7);
  assert.equal(output.results[1].status, 'rejected');
  assert.equal(output.final, 8);
  assert.equal(output.pad, '007');
  assert.equal(output.aborted, 'AbortError');
});
