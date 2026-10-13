import assert from 'node:assert/strict'
import test from 'node:test'

/** Load the browser bundle under a stubbed module loader and React. */
let loads = 0
async function loadClient() {
  let definition
  globalThis.window = { __ModuleLoader__: { load: (value) => (definition = value) } }
  // A distinct specifier per load: ESM caches the module, and each test needs
  // the factory to run against its own stub.
  await import(`../lib/client.js?load=${++loads}`)
  assert.equal(definition.id, 'dsh-zed-provider')
  return definition.factory((id) => {
    assert.equal(id, 'react')
    return {} // the wiring under test never renders
  })
}

/**
 * A client context that records what the card registers and what it calls.
 * `credentials: false` models a page where the credential remote never mounts,
 * which must degrade instead of hanging the fiber.
 */
function fakeContext({ apiKeyEnv = 'ZED_CREDENTIALS', credentials = true, settingsWire = true } = {}) {
  const calls = { credentials: [], locale: [], slots: [], injects: [], mutate: [], remoteSettingsDescribe: 0 }
  const namespace = { ns: 'llm-zed', revision: 7, value: { apiKeyEnv, visibleModels: ['claude-sonnet-5'] } }
  const credentialsRemote = {
    describe: async (refs) => {
      calls.credentials.push(['describe', ...refs])
      return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: true, writable: true }])) }
    },
    set: async (ref, value) => {
      calls.credentials.push(['set', ref, value])
      return { ok: true, value: undefined }
    },
    unset: async (ref) => {
      calls.credentials.push(['unset', ref])
      return { ok: true, value: undefined }
    },
  }

  const ctx = {
    effect: (run) => {
      const dispose = run()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: () => undefined, // no settingsScope handed to a root client plugin
    inject: (names, run) => {
      calls.injects.push(names.join(','))
      if (names.includes('remote.credentials') && credentials) {
        return run({ ...ctx, remote: { ...ctx.remote, credentials: credentialsRemote } })
      }
      return undefined
    },
    locale: { register: (ns, copy) => calls.locale.push({ ns, copy }) },
    remote: {
      credentials: credentials ? credentialsRemote : undefined,
      settings: settingsWire
        ? {
            describe: async () => {
              calls.remoteSettingsDescribe += 1
              return { ok: true, value: { namespaces: [namespace] } }
            },
            mutate: async (ns, ops, revision) => {
              calls.mutate.push({ ns, ops, revision })
              return { ok: true, value: { namespaces: [namespace], revision: 8, writable: true } }
            },
          }
        : undefined,
      llm: {
        discoverModels: async (settingsNs, request) => ({
          ok: true,
          value: [
            { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1000000, maxTokens: 128000 },
            { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 400000, maxTokens: 128000 },
          ],
        }),
      },
    },
    slots: {
      inject: (name, register) => {
        calls.slots.push(name)
        calls.registered = register()
      },
      register: (options, component) => {
        calls.options = options
        calls.component = component
        return () => {}
      },
    },
  }
  return { ctx, calls }
}

test('hard-injects only services a root client plugin is guaranteed', async () => {
  const client = await loadClient()
  assert.deepEqual(client.inject, ['slots', 'locale', 'remote'])
})

test('registers a Zed card on the Models page, keyed by its settings namespace', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext()
  client.apply(ctx)

  assert.deepEqual(calls.slots, ['settings.models.provider-card'])
  assert.deepEqual(calls.injects, ['remote.credentials'])
  assert.equal(calls.options.name, 'settings.models.provider-card')
  assert.equal(calls.options.key, 'llm-zed')
  assert.equal(calls.options.locale, 'settings.zed')
  assert.equal(typeof calls.component, 'function')
  assert.deepEqual(calls.locale.map((entry) => entry.ns), ['settings.zed'])
  assert.ok(Object.keys(calls.locale[0].copy).includes('en'))
})

test('reads, stores and clears the credential under the configured reference', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext({ apiKeyEnv: 'MY_ZED_REF' })
  client.apply(ctx)

  const injected = calls.options.inject()
  assert.deepEqual(await injected.describe(), { ref: 'MY_ZED_REF', configured: true, writable: true })
  assert.equal(await injected.save('12345 token-value'), undefined)
  assert.equal(await injected.clear(), undefined)

  assert.deepEqual(calls.credentials, [
    ['describe', 'MY_ZED_REF'],
    ['set', 'MY_ZED_REF', '12345 token-value'],
    ['unset', 'MY_ZED_REF'],
  ])
  assert.ok(calls.remoteSettingsDescribe >= 3, 'the reference is re-read per operation')
})

test('falls back to the default reference when no layer names one', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext({ apiKeyEnv: undefined, settingsWire: false })
  client.apply(ctx)

  const injected = calls.options.inject()
  assert.equal(injected.fallbackRef, 'ZED_CREDENTIALS')
  assert.equal((await injected.describe()).ref, 'ZED_CREDENTIALS')
})

test('degrades instead of hanging when the credential remote never mounts', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext({ credentials: false })
  client.apply(ctx)

  const injected = calls.options.inject()
  const described = await injected.describe()
  assert.equal(described.configured, false)
  assert.equal(described.writable, false)
  assert.equal(described.unavailable, true)
  assert.equal(
    await injected.save('12345 token'),
    'The credentials service is not reachable from this page yet; reload after DSH finishes starting.',
  )
})

test('surfaces a refused write instead of reporting success', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext()
  ctx.remote.credentials.set = async () => ({ ok: false, error: { message: 'read-only source' } })
  client.apply(ctx)
  assert.equal(await calls.options.inject().save('12345 token'), 'read-only source')
})

test('lists the catalog and writes the model selection', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext()
  client.apply(ctx)
  const injected = calls.options.inject()

  const catalog = await injected.catalog()
  assert.deepEqual(catalog.models.map((model) => model.id), ['claude-sonnet-5', 'gpt-5.6-luna'])
  assert.deepEqual(catalog.selected, ['claude-sonnet-5'])
  assert.equal(catalog.revision, 7)

  assert.equal(await injected.select(['claude-sonnet-5']), undefined)
  assert.deepEqual(calls.mutate.at(-1), {
    ns: 'llm-zed',
    ops: [{ op: 'set', path: ['visibleModels'], value: ['claude-sonnet-5'] }],
    revision: 7,
  })

  // A complete selection means "no narrowing", so the field is unset instead.
  assert.equal(await injected.select(['claude-sonnet-5', 'gpt-5.6-luna']), undefined)
  assert.deepEqual(calls.mutate.at(-1).ops, [{ op: 'unset', path: ['visibleModels'] }])
})

test('a catalog refusal degrades to an empty list instead of throwing', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext()
  ctx.remote.llm.discoverModels = async () => ({ ok: false, error: { message: 'no credential' } })
  client.apply(ctx)
  const catalog = await calls.options.inject().catalog()
  assert.deepEqual(catalog.models, [])
  assert.deepEqual(catalog.selected, ['claude-sonnet-5'])
})
