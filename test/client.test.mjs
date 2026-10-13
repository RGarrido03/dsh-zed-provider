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
function fakeContext({ apiKeyEnv = 'ZED_CREDENTIALS', credentials = true, settingsWire = true, llmWire = true } = {}) {
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

  const llmRemote = {
    discoverModels: async (settingsNs, request) => ({
      ok: true,
      value: [
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1000000, maxTokens: 128000 },
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 400000, maxTokens: 128000 },
      ],
    }),
  }
  const settingsRemote = {
    describe: async () => {
      calls.remoteSettingsDescribe += 1
      return { ok: true, value: { namespaces: [namespace] } }
    },
    mutate: async (ns, ops, revision) => {
      calls.mutate.push({ ns, ops, revision })
      return { ok: true, value: { namespaces: [namespace], revision: 8, writable: true } }
    },
  }

  const ctx = {
    __namespace: namespace,
    effect: (run) => {
      const dispose = run()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: () => undefined, // no settingsScope handed to a root client plugin
    inject: (names, run) => {
      calls.injects.push(names.join(','))
      // Each remote key is mounted only for a plugin that declares it, so the
      // child context carries exactly the requested key.
      const granted = {}
      if (names.includes('remote.credentials') && credentials) granted.credentials = credentialsRemote
      if (names.includes('remote.llm') && llmWire) granted.llm = llmRemote
      if (names.includes('remote.settings') && settingsWire) granted.settings = settingsRemote
      if (Object.keys(granted).length === 0) return undefined
      return run({ ...ctx, remote: granted })
    },
    locale: { register: (ns, copy) => calls.locale.push({ ns, copy }) },
    // The real `remote` service is a proxy that throws on keyed access from a
    // context that did not inject the key, so the fake throws the same way: a
    // fallback to `ctx.remote.<key>` must fail here, not pass by accident.
    remote: new Proxy(
      { $on: undefined },
      {
        get(target, key) {
          if (key === '$on') return target.$on
          if (key === 'credentials' || key === 'llm' || key === 'settings') {
            throw new Error(`cannot get property "remote.${key}" without inject`)
          }
          return undefined
        },
      },
    ),
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
  return { ctx, calls, remotes: { credentials: credentialsRemote, llm: llmRemote, settings: settingsRemote } }
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
  // All three remotes this card reads must be declared: a key that is not
  // injected is not mounted, and the method silently misses (which is what made
  // a linked provider read as "not linked yet").
  assert.deepEqual(calls.injects, ['remote.credentials', 'remote.llm', 'remote.settings'])
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
    'This page cannot reach the Host service for that yet; reload once DSH has finished starting.',
  )
})

test('surfaces a refused write instead of reporting success', async () => {
  const client = await loadClient()
  const { ctx, calls, remotes } = fakeContext()
  remotes.credentials.set = async () => ({ ok: false, error: { message: 'read-only source' } })
  client.apply(ctx)
  assert.equal(await calls.options.inject().save('12345 token'), 'read-only source')
})

test('reads the catalog through the mounted llm remote', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext()
  client.apply(ctx)
  const catalog = await calls.options.inject().catalog()
  assert.equal(catalog.ok, true)
  assert.equal(catalog.models.length, 2)
})

test('an empty stored selection reads as "offer everything", not "offer nothing"', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext()
  // The schema default for an array field is [], so this is what the effective
  // settings value looks like until the user narrows anything.
  ctx.__namespace.value.visibleModels = []
  client.apply(ctx)
  const catalog = await calls.options.inject().catalog()
  assert.equal(catalog.ok, true)
  assert.equal(catalog.selected, null, 'no narrowing is null, not an empty list')
})

test('lists the catalog and writes the model selection', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext()
  client.apply(ctx)
  const injected = calls.options.inject()

  const catalog = await injected.catalog()
  assert.equal(catalog.ok, true)
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

test('a catalog refusal is reported, not swallowed: it is the linked test', async () => {
  const client = await loadClient()
  const { ctx, calls, remotes } = fakeContext()
  remotes.llm.discoverModels = async () => ({ ok: false, error: { message: 'llm-zed: no Zed credential' } })
  client.apply(ctx)
  const catalog = await calls.options.inject().catalog()
  assert.equal(catalog.ok, false)
  assert.equal(catalog.message, 'llm-zed: no Zed credential')
  assert.deepEqual(catalog.models, [])
  assert.deepEqual(catalog.selected, ['claude-sonnet-5'])
})

test('subscribes to the pushes that can change a credential', async () => {
  const client = await loadClient()
  const { ctx, calls } = fakeContext()

  // Without the remote event bridge there is nothing to subscribe to.
  client.apply(ctx)
  const noBridge = calls.options.inject().subscribe(() => {})
  assert.equal(typeof noBridge, 'function')
  noBridge()

  const events = []
  const offs = []
  let refreshed = 0
  ctx.remote.$on = (event, handler) => {
    events.push(event)
    void handler
    const off = () => offs.push(event)
    return off
  }
  client.apply(ctx)
  const subscribe = calls.options.inject().subscribe(() => {
    refreshed += 1
  })
  assert.deepEqual(events, [
    'credentials/reference-updated',
    'credentials/record-updated',
    'settings/document-updated',
    'llm/adapters-updated',
  ])
  subscribe()
  assert.deepEqual(offs, events)
  assert.equal(refreshed, 0, 'subscribing does not itself refresh')
})
