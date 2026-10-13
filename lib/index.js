/**
 * dsh-zed-provider — run a Zed AI subscription (Pro / Student) inside DeepSeek Harness.
 *
 * Zed's subscription includes monthly prompt credits spent through Zed Cloud's
 * own gateway. This bundle registers one LLM provider route, `zed-agent`, whose
 * calls travel that gateway:
 *
 *   1. a master credential (`<userId> <accessToken>`) is resolved per request from
 *      a literal `credentials` config value, the `apiKeyEnv` credential reference,
 *      the `llm-zed/zed-agent` grant record `/zed-login` writes, or the Zed app's
 *      own local keyring entry;
 *   2. `POST /client/llm_tokens` mints the short-lived gateway bearer token;
 *   3. `POST /completions` streams one turn back as NDJSON (see lib/parse.js).
 *
 * Only Zed's Anthropic backend is implemented, so the catalog advertises the
 * Claude models and filters the rest out rather than offering turns that cannot
 * run. Plan and quota stay Zed's business: an exhausted month answers HTTP 402
 * and surfaces as a `QUOTA` failure.
 *
 * @module dsh-zed-provider
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { credentialKey, credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, attributionHeaders, projectImagesForTextModel } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { buildAnthropicRequest } from './anthropic.js'
import { LlmStreamError, parseZedAnthropicStream } from './parse.js'
import { buildResponsesRequest, parseZedResponsesStream } from './responses.js'
import { decryptAccessToken, generateSignInKeypair, signInUrl } from './signin.js'

/** Plugin name; also the loader row id and the settings namespace. */
const name = 'llm-zed'
const inject = ['llm']

const PROVIDER = 'zed-agent'
const DISPLAY_NAME = 'Zed'
const ZED_CLOUD_URL = 'https://cloud.zed.dev'
const ZED_WEB_URL = 'https://zed.dev'
/** Version the gateway negotiates capabilities against. */
const ZED_APP_VERSION = '0.180.0'
const DEFAULT_API_KEY_ENV = 'ZED_CREDENTIALS'
const CREDENTIAL_KEY = credentialKey(name, PROVIDER)

const HEADER = {
  VERSION: 'x-zed-version',
  EXPIRED: 'x-zed-expired-token',
  OUTDATED: 'x-zed-outdated-token',
  STATUS: 'x-zed-client-supports-status-messages',
  STREAM_ENDED: 'x-zed-client-supports-stream-ended-request-completion-status',
  X_AI: 'x-zed-client-supports-x-ai',
}

const CATALOG_TTL_MS = 5 * 60 * 1000
const TOKEN_SAFETY_WINDOW_MS = 10 * 60 * 1000
const TOKEN_TTL_MS = 60 * 60 * 1000
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000
const SIGN_IN_PORT = 48921

const REASONING_EFFORTS = [
  { id: 'off', name: 'Off', description: 'Answer without extended thinking.' },
  { id: 'low', name: 'Low', description: 'Brief thinking for routine work.' },
  { id: 'high', name: 'High', description: 'The balance for most coding tasks.' },
  { id: 'max', name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
]

/**
 * `apiKeyEnv` is spelled that way because the web Models page reads exactly
 * that field to show and write this provider's credential; the value is a
 * credential *reference*, and what it holds is `"<userId> <accessToken>"`.
 */
const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  credentials: z.string().role('secret'),
  baseUrl: z.string(),
  visibleModels: z.array(z.string()).volatile(),
})

// ───────────────────────────── credentials ─────────────────────────────

/** Unwrap one volatile config field; plain values pass through unchanged. */
function field(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * Parse a master credential: Zed stores `"<userId> <accessToken>"`, and the
 * keyring record form is JSON with either spelling of both halves.
 * @returns `{ userId, accessToken }`, or undefined when the value cannot authenticate.
 */
export function parseMasterCredential(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return undefined
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      const userId = String(parsed.userId ?? parsed.user_id ?? parsed.accountId ?? parsed.id ?? '').trim()
      const accessToken = String(
        parsed.accessToken ?? parsed.access_token ?? parsed.access ?? parsed.token ?? '',
      ).trim()
      if (userId.length > 0 && accessToken.length > 0) return { userId, accessToken }
    } catch {
      // Not JSON after all: fall through to the space-separated form.
    }
  }
  const space = text.indexOf(' ')
  if (space > 0) {
    const userId = text.slice(0, space).trim()
    const accessToken = text.slice(space + 1).trim()
    if (userId.length > 0 && accessToken.length > 0) return { userId, accessToken }
  }
  return undefined
}

function exec(file, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout }, (error, stdout) => resolve(error ? undefined : stdout))
  })
}

/**
 * Read the credential the Zed editor itself stored on this machine, when the
 * native sign-in already ran there. Best effort: an absent keyring is not an error.
 */
async function importLocalZedCredential() {
  try {
    if (process.platform === 'darwin') {
      const secret =
        (await exec('security', ['find-generic-password', '-s', 'zed.dev', '-a', 'zed-credentials', '-w'])) ??
        (await exec('security', ['find-generic-password', '-s', 'zed.dev', '-w']))
      return secret === undefined ? undefined : parseMasterCredential(secret)
    }
    if (process.platform === 'linux') {
      const secret = await exec('secret-tool', ['lookup', 'url', ZED_WEB_URL])
      return secret === undefined ? undefined : parseMasterCredential(secret)
    }
  } catch {
    // Unsupported platform or unavailable keyring.
  }
  return undefined
}

// ───────────────────────────── failures ─────────────────────────────

function trim(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** Provider-neutral failure code for one HTTP status, in the retry vocabulary. */
function httpCode(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 || status === 413) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return status === undefined ? 'TRANSPORT' : `HTTP_${status}`
}

function transportFailure(what, error, signal) {
  if (signal?.aborted) return error // the runtime turns this into an aborted finish
  return new LlmError(`llm-zed: ${what}: ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT', {
    cause: error,
  })
}

// ───────────────────────────── llm tokens ─────────────────────────────

const tokenCache = new Map()
const minting = new Map()

function tokenCacheKey(credentials) {
  return `${credentials.userId}:${credentials.accessToken}`
}

export function invalidateLlmToken(credentials) {
  tokenCache.delete(tokenCacheKey(credentials))
}

/** Mint (or reuse) the short-lived gateway bearer token for one master credential. */
async function llmToken(credentials, baseUrl, signal) {
  const key = tokenCacheKey(credentials)
  const cached = tokenCache.get(key)
  if (cached !== undefined && Date.now() < cached.expiresAt - TOKEN_SAFETY_WINDOW_MS) return cached.token
  const inFlight = minting.get(key)
  if (inFlight !== undefined) return inFlight

  const minted = (async () => {
    let response
    try {
      response = await fetch(`${baseUrl}/client/llm_tokens`, {
        method: 'POST',
        headers: {
          ...attributionHeaders(),
          Authorization: `${credentials.userId} ${credentials.accessToken}`,
          'Content-Type': 'application/json',
          [HEADER.VERSION]: ZED_APP_VERSION,
        },
        body: JSON.stringify({ organization_id: null }),
        signal: signal ?? null,
      })
    } catch (error) {
      throw transportFailure('could not reach Zed Cloud to mint an LLM token', error, signal)
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) {
        throw new LlmError(
          'llm-zed: Zed Cloud rejected the stored credential. Run /zed-login to link your account again.',
          'AUTH',
          { status: response.status },
        )
      }
      if (response.status === 402) {
        throw new LlmError(
          "llm-zed: this Zed account has no active AI plan, or this month's prompt credits are spent. See https://zed.dev/account.",
          'QUOTA',
          { status: 402 },
        )
      }
      throw new LlmError(
        `llm-zed: could not mint a Zed LLM token (HTTP ${response.status})${detail ? `: ${trim(detail, 300)}` : ''}`,
        httpCode(response.status),
        { status: response.status },
      )
    }
    const payload = await response.json().catch(() => undefined)
    const token = typeof payload?.token === 'string' ? payload.token : ''
    if (token.length === 0) {
      throw new LlmError('llm-zed: Zed Cloud returned an empty LLM token', 'MALFORMED_RESPONSE')
    }
    tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS })
    return token
  })().finally(() => minting.delete(key))

  minting.set(key, minted)
  return minted
}

// ───────────────────────────── model catalog ─────────────────────────────

/** Zed wire backends this plugin implements. */
const BACKENDS = new Set(['anthropic', 'open_ai'])

/** Zed wire backends, mapped from the spellings `GET /models` uses. */
function wireBackend(provider) {
  if (provider === 'anthropic' || provider === 'open_ai' || provider === 'google' || provider === 'x_ai') {
    return provider
  }
  if (provider === 'openai') return 'open_ai'
  if (provider === 'xai') return 'x_ai'
  return undefined
}

function modelName(entry) {
  return typeof entry.display_name === 'string' && entry.display_name.length > 0 ? entry.display_name : entry.id
}

async function fetchCatalog(baseUrl, credentials, signal) {
  const headers = {
    ...attributionHeaders(),
    [HEADER.VERSION]: ZED_APP_VERSION,
    [HEADER.X_AI]: 'true',
    'Content-Type': 'application/json',
  }
  if (credentials !== undefined) headers.Authorization = `Bearer ${await llmToken(credentials, baseUrl, signal)}`

  let response
  try {
    response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: signal ?? AbortSignal.timeout(20_000),
    })
  } catch (error) {
    throw transportFailure('could not reach the Zed Cloud model list', error, signal)
  }
  if (!response.ok) {
    throw new LlmError(
      response.status === 401 || response.status === 403
        ? 'llm-zed: Zed Cloud rejected the stored credential. Run /zed-login again.'
        : `llm-zed: Zed Cloud model list failed (HTTP ${response.status})`,
      httpCode(response.status),
      { status: response.status },
    )
  }
  const payload = await response.json().catch(() => undefined)
  const models = Array.isArray(payload?.models) ? payload.models : []
  const seen = new Set()
  return models.filter((model) => {
    if (model === null || typeof model !== 'object') return false
    if (typeof model.id !== 'string' || model.id.length === 0) return false
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

// ───────────────────────────── adapter ─────────────────────────────

class ZedAdapter extends LlmAdapter {
  #deps
  #catalog
  #catalogAt = 0

  constructor(deps) {
    super()
    this.#deps = deps
  }

  providerInfo(provider) {
    return { id: provider, name: DISPLAY_NAME }
  }

  /**
   * Whether this route can actually run one catalog entry. Zed's other backends
   * (Gemini, Grok) are refused here rather than offered broken.
   */
  #runnable(entry) {
    return entry.is_disabled !== true && BACKENDS.has(wireBackend(entry.provider))
  }

  /** The `visibleModels` selection, re-read per call so a settings edit applies live. */
  #visible() {
    const selected = field(this.#deps.visibleModels())
    return Array.isArray(selected) && selected.length > 0 ? selected : undefined
  }

  /** Zed Cloud authenticates even its model list, so every path needs one. */
  async #credential() {
    const credentials = await this.#deps.credentials()
    if (credentials === undefined) {
      throw new LlmError(
        'llm-zed: no Zed credential for the zed-agent route. Run /zed-login in the composer, or store ' +
          `"<userId> <accessToken>" under the credential reference "${this.#deps.apiKeyEnv()}".`,
        'MISSING_CREDENTIAL',
      )
    }
    return credentials
  }

  async #entries(signal, credentials) {
    if (this.#catalog !== undefined && Date.now() - this.#catalogAt < CATALOG_TTL_MS) return this.#catalog
    try {
      const entries = await fetchCatalog(
        this.#deps.baseUrl(),
        credentials ?? (await this.#credential()),
        signal,
      )
      this.#catalog = entries
      this.#catalogAt = Date.now()
      return entries
    } catch (error) {
      if (this.#catalog !== undefined) return this.#catalog // stale beats nothing
      throw error
    }
  }

  async #entry(model, signal, credentials) {
    const entries = await this.#entries(signal, credentials)
    return entries.find((entry) => entry.id === model)
  }

  async listModels(provider) {
    const entries = await this.#entries(undefined)
    const visible = this.#visible()
    return entries
      .filter((entry) => this.#runnable(entry))
      .filter((entry) => visible === undefined || visible.includes(entry.id))
      .map((entry) => ({ provider, id: entry.id, name: modelName(entry), inputModalities: ['text'] }))
  }

  /**
   * Everything this route could serve, ignoring the current selection — what the
   * settings card lists as tick boxes. Served to the browser through
   * `llm/discoverModels` for this plugin's settings namespace.
   */
  async discover(signal) {
    const entries = await this.#entries(signal)
    return entries.filter((entry) => this.#runnable(entry)).map((entry) => ({
      id: entry.id,
      name: modelName(entry),
      ...(typeof entry.max_token_count === 'number' && entry.max_token_count > 0
        ? { contextWindow: Math.trunc(entry.max_token_count) }
        : {}),
      ...(typeof entry.max_output_tokens === 'number' && entry.max_output_tokens > 0
        ? { maxTokens: Math.trunc(entry.max_output_tokens) }
        : {}),
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model, signal) {
    const entry = await this.#entry(model, signal)
    const info = { provider, id: model, name: entry === undefined ? model : modelName(entry), inputModalities: ['text'] }
    if (entry === undefined) return info
    if (typeof entry.max_token_count === 'number' && entry.max_token_count > 0) {
      info.context = { contextWindow: Math.trunc(entry.max_token_count) }
    }
    if (typeof entry.max_output_tokens === 'number' && entry.max_output_tokens > 0) {
      info.defaultMaxTokens = Math.trunc(entry.max_output_tokens)
    }
    if (entry.supports_thinking === true) info.reasoning = { efforts: REASONING_EFFORTS }
    return info
  }

  async *stream(options) {
    const credentials = await this.#credential()
    const entry = await this.#entry(options.model, options.signal, credentials)
    const backend = entry === undefined ? 'anthropic' : wireBackend(entry.provider)
    if (!BACKENDS.has(backend)) {
      throw new LlmError(
        `llm-zed: "${options.model}" runs on Zed's ${backend ?? 'unknown'} backend, which this plugin does not implement; pick a Claude or GPT model on the zed-agent route`,
        'UNSUPPORTED_CONTENT',
      )
    }

    const baseUrl = this.#deps.baseUrl()
    // Both builders take the history already projected onto this route's
    // modalities; the transcript is otherwise read-only.
    const projected = { ...options, messages: projectImagesForTextModel(options.messages ?? []) }
    const body = JSON.stringify({
      thread_id: randomUUID(),
      prompt_id: randomUUID(),
      provider: backend,
      model: options.model,
      provider_request:
        backend === 'open_ai' ? buildResponsesRequest(projected, entry) : buildAnthropicRequest(projected, entry),
    })

    const send = (token) =>
      fetch(`${baseUrl}/completions`, {
        method: 'POST',
        headers: {
          ...attributionHeaders(),
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          [HEADER.VERSION]: ZED_APP_VERSION,
          [HEADER.STATUS]: 'true',
          [HEADER.STREAM_ENDED]: 'true',
        },
        body,
        signal: options.signal ?? null,
      })

    let response
    try {
      response = await send(await llmToken(credentials, baseUrl, options.signal))
      if (
        response.status === 401 ||
        response.headers.has(HEADER.EXPIRED) ||
        response.headers.has(HEADER.OUTDATED)
      ) {
        // The gateway rotates tokens faster than the TTL: mint once more and retry.
        invalidateLlmToken(credentials)
        response = await send(await llmToken(credentials, baseUrl, options.signal))
      }
    } catch (error) {
      throw transportFailure('could not reach Zed Cloud', error, options.signal)
    }

    if (response.status === 402) {
      throw new LlmError(
        "llm-zed: this Zed account has no active AI plan, or this month's prompt credits are spent. See https://zed.dev/account.",
        'QUOTA',
        { status: 402 },
      )
    }
    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '')
      throw new LlmError(
        `llm-zed: Zed Cloud rejected the request (HTTP ${response.status})${detail ? `: ${trim(detail, 300)}` : ''}`,
        httpCode(response.status),
        { status: response.status },
      )
    }

    try {
      const chunks =
        backend === 'open_ai'
          ? parseZedResponsesStream(response.body, { signal: options.signal })
          : parseZedAnthropicStream(response.body, { signal: options.signal })
      yield* chunks
    } catch (error) {
      if (error instanceof LlmStreamError) throw new LlmError(`llm-zed: ${error.message}`, error.code)
      throw error
    }
  }
}

// ───────────────────────────── sign-in ─────────────────────────────

function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    execFile(command, args, () => {})
  } catch {
    // The URL is printed either way.
  }
}

/**
 * Run Zed's native-app sign-in: an RSA keypair identifies this DSH process to
 * zed.dev, which posts the encrypted access token back to a loopback port.
 */
function startZedSignIn(signal) {
  const keypair = generateSignInKeypair()
  let resolveResult
  let rejectResult
  const completion = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  let settled = false
  const settle = (fn, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    server.close()
    fn(value)
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const reply = (status, text) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(text)
    }
    const failure = url.searchParams.get('error')
    if (failure !== null) {
      reply(400, 'Zed sign-in failed. You can close this tab.')
      settle(rejectResult, new Error(url.searchParams.get('error_description') ?? failure))
      return
    }
    const userId = url.searchParams.get('user_id')
    const encrypted = url.searchParams.get('access_token')
    if (userId === null || encrypted === null) {
      reply(404, 'Waiting for the Zed sign-in callback.')
      return
    }
    let accessToken
    try {
      accessToken = decryptAccessToken(encrypted, keypair.privateKeyPem)
    } catch {
      // Another Zed instance's callback landed on our port.
      reply(409, 'This sign-in link belongs to another process.')
      return
    }
    reply(200, 'Zed is linked. You can close this tab and return to DeepSeek Harness.')
    settle(resolveResult, { userId, accessToken })
  })

  const timer = setTimeout(() => {
    settle(rejectResult, new Error('Zed sign-in timed out after five minutes; run /zed-login again.'))
  }, SIGN_IN_TIMEOUT_MS)
  timer.unref?.()

  const onAbort = () => settle(rejectResult, new Error('Zed sign-in cancelled.'))
  signal?.addEventListener('abort', onAbort, { once: true })

  const listen = (port) =>
    new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })

  const ready = (async () => {
    try {
      await listen(SIGN_IN_PORT)
    } catch {
      await listen(0)
    }
    return { url: signInUrl(server.address().port, keypair.publicKeyDerBase64Url), completion }
  })()

  return {
    ready,
    dispose: () => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      server.close()
    },
  }
}

/** Confirm the credential and learn the account label the gateway reports. */
async function describeAccount({ userId, accessToken }, baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/client/users/me`, {
      method: 'GET',
      headers: {
        ...attributionHeaders(),
        Authorization: `${userId} ${accessToken}`,
        'Content-Type': 'application/json',
        [HEADER.VERSION]: ZED_APP_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    const profile = await response.json()
    return {
      userId: profile?.id === undefined ? userId : String(profile.id),
      login: profile?.github_login ?? profile?.email ?? undefined,
    }
  } catch {
    return undefined
  }
}

// ───────────────────────────── plugin ─────────────────────────────

function apply(ctx, config) {
  const apiKeyRef = () => {
    const named = field(config.apiKeyEnv)
    if (typeof named === 'string' && isCredentialRefName(named)) return credentialRef(named)
    if (named !== undefined && named !== DEFAULT_API_KEY_ENV) {
      ctx.logger?.warn?.(`llm-zed: apiKeyEnv "${String(named)}" is not a valid credential reference; using ${DEFAULT_API_KEY_ENV}`)
    }
    return credentialRef(DEFAULT_API_KEY_ENV)
  }
  const baseUrl = () => String(config.baseUrl ?? ZED_CLOUD_URL).replace(/\/+$/, '')
  const literal = () =>
    typeof config.credentials === 'string' && config.credentials.length > 0 ? config.credentials : undefined

  /** Stored grant, if `/zed-login` (or a keyring import) wrote one. */
  const storedCredential = async () => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    try {
      const record = await credentials.readRecord(CREDENTIAL_KEY)
      if (record?.kind !== 'grant') return undefined
      const payload = record.payload
      const userId = payload?.userId === undefined ? '' : String(payload.userId)
      const accessToken = typeof payload?.accessToken === 'string' ? payload.accessToken : ''
      return userId.length === 0 || accessToken.length === 0 ? undefined : { userId, accessToken }
    } catch {
      return undefined
    }
  }

  const storeCredential = async (credential, login) => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      throw new Error('the credentials service is unavailable; cannot store the Zed credential')
    }
    await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({
      kind: 'grant',
      payload: { ...credential, ...(login === undefined ? {} : { login }), linkedAt: new Date().toISOString() },
    }))
  }

  /**
   * One credential, resolved in the order a user would expect: an explicit
   * config value, the credential seam, our own grant record, then the Zed
   * editor's local keyring (imported once, so later requests are cheap).
   */
  const zedCredential = async () => {
    const fromConfig = parseMasterCredential(literal())
    if (fromConfig !== undefined) return fromConfig
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const fromSeam = parseMasterCredential((await credentials.resolve(apiKeyRef()))?.value)
      if (fromSeam !== undefined) return fromSeam
    }
    const stored = await storedCredential()
    if (stored !== undefined) return stored
    const imported = await importLocalZedCredential()
    if (imported === undefined) return undefined
    try {
      await storeCredential(imported)
    } catch {
      // Serving this request still works even if the import could not persist.
    }
    return imported
  }

  const adapter = new ZedAdapter({
    baseUrl,
    apiKeyEnv: () => String(apiKeyRef()),
    credentials: zedCredential,
    visibleModels: () => config.visibleModels,
  })

  const settingsNs = ctx.fiber.entry?.options.id ?? name
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs, settingsPath: [] },
  ])
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => {
    void request
    return adapter.discover(signal)
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'zed-login',
      description: 'Link your Zed AI subscription so its Claude models can run here',
      handler: async (invocation) => {
        const existing = await zedCredential()
        if (existing !== undefined) {
          const account = await describeAccount(existing, baseUrl())
          return { kind: 'success', text: `Zed is already linked${account?.login ? ` as ${account.login}` : ''}.` }
        }
        const signIn = startZedSignIn(invocation.signal)
        try {
          const { url, completion } = await signIn.ready
          openBrowser(url)
          const credential = await completion
          const account = await describeAccount(credential, baseUrl())
          await storeCredential(credential, account?.login)
          invalidateLlmToken(credential)
          return {
            kind: 'success',
            text:
              `Zed linked${account?.login ? ` as ${account.login}` : ''}. ` +
              'Its Claude models are now selectable under the Zed provider in the model picker.',
          }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        } finally {
          signIn.dispose()
        }
      },
    })
  })
}

export { Config, PROVIDER, apply, inject, name }
