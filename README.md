# dsh-zed-provider

Run your **Zed AI subscription** (Zed Pro / Student — the monthly prompt credits)
inside DeepSeek Harness. The bundle registers one LLM provider route,
`zed-agent`, whose turns are minted and streamed through Zed Cloud
(`https://cloud.zed.dev`) exactly as the Zed editor does it.

## Install

```bash
dsh plugin --profile web add dsh-zed-provider
```

## Link your Zed account

Type `/zed-login` in the Harness composer. The command opens Zed's native-app
sign-in page, waits for the loopback callback, and stores the resulting grant in
the Harness credential store (`llm-zed/zed-agent`). Later requests reuse it, and
the short-lived gateway token is minted automatically and refreshed on demand.

Credentials are resolved in this order, so any one of them is enough:

1. `config.credentials` — a literal `"<userId> <accessToken>"` (or JSON) value.
2. `config.apiKeyEnv` (default `ZED_CREDENTIALS`) — resolved through the
   credential seam. The Models settings page shows this as the Zed card's key
   field, so a credential pasted there works without `/zed-login`.
3. The `llm-zed/zed-agent` grant record written by `/zed-login`.
4. The Zed editor's own local keyring entry, on macOS (`zed.dev`) and Linux
   (`secret-tool`), imported once into the grant record — sign in inside Zed and
   this plugin picks it up by itself.

`apiKeyEnv` is spelled that way because the Models page reads exactly that field
name; its value is a credential *reference*, and what it holds is the
`"<userId> <accessToken>"` pair Zed issues.

## Settings UI

Settings → **Models** → the **Zed** card carries this bundle's own editor
(`lib/client.js`, a client-module half registered on the page's
`settings.models.provider-card` seat for the `llm-zed` namespace):

- credential status, from the card's credential join plus a live
  `credentials/describe`;
- a credential field that stores `"<userId> <accessToken>"` under the reference
  `apiKeyEnv` names (read live from the settings document, default
  `ZED_CREDENTIALS`), with **Remove** to unset it;
- a refusal instead of a silent no-op when that reference is supplied by a
  read-only source such as an environment variable.

It also carries the **model chooser**: the Host registers
`llm.registerModelDiscovery` for this namespace, the page reads it through
`llm/discoverModels`, and the tick boxes write `visibleModels` through
`settings/mutate`. That field is volatile, so a tick changes the picker on the
next catalog read without a reload; an empty or complete selection unsets it,
meaning "offer every model this plugin can run".

`baseUrl` stays a composition-only field in `cordis.patch.yml`.

The client fiber hard-injects only `slots`, `locale` and `remote`, and picks the
credential remote up through `ctx.inject(['remote.credentials'], …)`. That is
deliberate: the web boot asserts that every client entry activated, so a root
client plugin that waits on a service the settings UI keeps private (such as
`settingsScope`) takes the whole GUI boot down with
`<package>: pending (waiting for service: …)`.

## Models

`listModels` reads `GET /models` with your credential and advertises the models
Zed reports for the backends this plugin implements — **Claude** (Anthropic
Messages) and **GPT** (OpenAI Responses). Zed's Gemini and Grok entries are
filtered out rather than offered broken; selecting one anyway fails fast with
`UNSUPPORTED_CONTENT`.

Each model carries Zed's own context window, output cap, and — when
`supports_thinking` — the effort levels `off` / `low` / `high` / `max`, mapped
onto Anthropic extended thinking budgets.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `ZED_CREDENTIALS` | Credential reference holding `"<userId> <accessToken>"`. |
| `credentials` | absent | Literal credential value; highest priority, composition-time. |
| `baseUrl` | `https://cloud.zed.dev` | Zed Cloud endpoint. |
| `visibleModels` | all supported | Narrow the catalog to these model ids. |

## Quota

Zed owns the accounting: no plan or no credits left answers HTTP 402, which
surfaces as a `QUOTA` failure naming https://zed.dev/account. The plugin does
not invent percentages or limits.

## Development

`pnpm install` (which runs the `prepare` hook), then `pnpm check` —
typecheck, build, tests. Sources are TypeScript under `src/`; `lib/` is build
output and is git-ignored, because the `prepare`/`prepack` hooks rebuild it
wherever the package is consumed and the published tarball carries the built
copy through the `files` allowlist.

A profile can install this bundle as a `link:` to a working copy, in which case
that copy's `lib/` is what the Host imports: rebuild after changing `src/`, or
the Host keeps running the previous build.

`node --test test/*.test.mjs` covers the pieces that fail silently in
production: the NDJSON → `StreamChunk` translation for both backends
(`src/frames.ts` framing, `src/parse.ts` Anthropic events, `src/responses.ts`
Responses events), the RSA sign-in handshake (`src/signin.ts`), the request
projections (`src/anthropic.ts`, `src/responses.ts`), and the card's slot
registration, credential and model-selection wiring (`src/client.ts`, loaded
under a stubbed module loader in `test/client.test.mjs`). The tests import the
built `lib/`, because that is what the Harness actually runs. Only
`src/index.ts` touches the Harness runtime.

Two install-time facts worth knowing: the Host half is re-imported only by a
profile restart (ESM caches by URL), and the client half is composed from the
Loader's entries at Host boot, so adding or removing `exports["./client"]` takes
a restart too — after that it is served per request under a content hash, so
client-side edits reach the browser on the next load.
