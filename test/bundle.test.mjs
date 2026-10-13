import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * The built halves have opposite module formats, and getting either wrong is a
 * load-time failure the unit tests cannot see:
 *
 * - `lib/client.js` is fetched as a classic script by the web boot, which
 *   evaluates it through `window.__ModuleLoader__.load`. Any ESM syntax in it —
 *   including the `export {}` the compiler adds when it decides a file is a
 *   module — is a SyntaxError that takes the whole GUI boot down.
 * - the Host half is imported as ESM by the Loader, so it must keep its imports.
 *
 * `new Function` compiles a body as a classic script without running it, which
 * is exactly the parse the browser performs.
 */
const read = (name) => readFile(new URL(`../lib/${name}`, import.meta.url), 'utf8')

test('the client bundle parses as a classic script and enters through the loader', async () => {
  const source = await read('client.js')
  assert.doesNotThrow(() => new Function(source), 'client.js must not contain module syntax')
  assert.match(source, /window\.__ModuleLoader__/, 'the bundle must register through the loader')
  assert.match(source, /\.load\(\{/)
  assert.match(source, /id: 'dsh-zed-provider'/)
})

test('the host half stays an ES module with its harness imports', async () => {
  const source = await read('index.js')
  assert.match(source, /^import /m, 'index.js must keep its imports')
  assert.match(source, /export \{ Config, PROVIDER, apply, inject, name \}/)
  for (const name of ['parse', 'responses', 'anthropic', 'frames', 'signin']) {
    const part = await read(`${name}.js`)
    // The protocol modules are import-free except for frames.js, so the tests
    // can run them under plain node without the harness packages present.
    assert.doesNotMatch(part, /from '@deepseek-ai\//, `${name}.js must not import the harness at runtime`)
  }
})
