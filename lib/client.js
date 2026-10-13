"use strict";
/**
 * Browser half of dsh-zed-provider: the Zed card inside the Models settings
 * section.
 *
 * The shipped Models page renders a provider card for every row in the
 * configurable-provider directory, but its curated editors only exist for the
 * `llm-deepseek` and `llm-pi-ai` namespaces — any other namespace shows an
 * advanced hint and keeps its submit disabled. The page declares
 * `settings.models.provider-card`, keyed by `settingsNs`, as the seat for an
 * adapter's own extension; this module takes it for `llm-zed` and gives the
 * route an editable credential, which is the one field a Zed user must set.
 *
 * Everything the card needs is already on the wire: the shipped settings
 * controller exposes `credentials/describe`, `credentials/set` and
 * `credentials/unset`, so no new Host endpoint is required.
 *
 * The fiber hard-injects only the three services every root client plugin can
 * rely on (`slots`, `locale`, `remote`). The settings UI keeps `settingsScope`
 * to itself, and the web boot asserts that every client entry activated —
 * a root plugin that waits on a service it cannot see takes the whole boot
 * down, so the credential remote and the settings descriptor are resolved at
 * call time instead.
 *
 * The file is a client-module bundle, not an ES module: the browser loader
 * evaluates the `factory` and reads `apply`/`inject` off the exports object.
 */
// The shipped client bundles all enter through `window.__ModuleLoader__`; the
// cast keeps this script free of a global interface merge.
const loader = window.__ModuleLoader__;
loader.load({
    id: 'dsh-zed-provider',
    factory: (require) => {
        const React = require('react');
        const module = { exports: {} };
        const exports = module.exports;
        /** Locale namespace for this card's copy. */
        const NS = 'settings.zed';
        /** Settings namespace of the Host plugin, i.e. its loader row id. */
        const SETTINGS_NS = 'llm-zed';
        /** The route id, for diagnostics. */
        const PROVIDER = 'zed-agent';
        /** Must match the Host plugin's `apiKeyEnv` default. */
        const DEFAULT_REF = 'ZED_CREDENTIALS';
        const COPY = {
            en: {
                statusLinked: 'Linked — Zed accepts this credential.',
                statusMissing: 'Not linked yet.',
                statusUnwritable: 'This credential comes from a read-only source (environment or a lower layer), so it cannot be replaced here.',
                hint: 'Run /zed-login in the composer: it opens Zed’s sign-in page and stores the credential for you.',
                fallback: 'Or paste the credential Zed holds, in the form <userId> <accessToken>.',
                fieldLabel: 'Zed credential',
                placeholder: '<userId> <accessToken>',
                save: 'Save',
                saving: 'Saving…',
                clear: 'Remove',
                cleared: 'Credential removed.',
                saved: 'Credential stored.',
                invalid: 'Paste both halves: a numeric user id, a space, then the access token.',
                storedRef: 'Stored under %s.',
                unavailable: 'The credentials service is not reachable from this page yet; reload after DSH finishes starting.',
                modelsTitle: 'Models',
                modelsHint: 'Untick the models you never use; the picker then offers only the ticked ones.',
                modelsAll: 'All models are offered. Tick any box to start narrowing the list.',
                modelsReset: 'Offer all models',
                modelsLoading: 'Reading Zed\u2019s catalog\u2026',
                modelsEmpty: 'Zed reports no models this plugin can run yet \u2014 link an account first.',
                modelsFailed: 'Could not read the model catalog: %s',
            },
            zh: {
                statusLinked: '已关联 — Zed 接受该凭据。',
                statusMissing: '尚未关联。',
                statusUnwritable: '该凭据来自只读来源（环境变量或下层配置），无法在此替换。',
                hint: '在输入框执行 /zed-login：它会打开 Zed 登录页并自动保存凭据。',
                fallback: '也可以粘贴 Zed 保存的凭据，格式为 <userId> <accessToken>。',
                fieldLabel: 'Zed 凭据',
                placeholder: '<userId> <accessToken>',
                save: '保存',
                saving: '保存中…',
                clear: '移除',
                cleared: '凭据已移除。',
                saved: '凭据已保存。',
                invalid: '请粘贴完整的两部分：数字用户 id、一个空格、访问令牌。',
                storedRef: '保存在 %s 下。',
                unavailable: '当前页面还无法访问凭据服务；请在 DSH 启动完成后重新加载。',
                modelsTitle: '模型',
                modelsHint: '取消勾选你不使用的模型，选择器就只提供勾选的模型。',
                modelsAll: '当前提供全部模型。勾选任意一项即可开始筛选。',
                modelsReset: '提供全部模型',
                modelsLoading: '正在读取 Zed 模型目录…',
                modelsEmpty: 'Zed 尚未报告本插件可运行的模型——请先关联账号。',
                modelsFailed: '无法读取模型目录：%s',
            },
        };
        const h = React.createElement;
        const styles = {
            root: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' },
            status: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px' },
            dot: (ok) => ({
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                flex: '0 0 auto',
                background: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)',
            }),
            hint: { fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-label-secondary)', margin: 0 },
            row: { display: 'flex', gap: '8px', alignItems: 'center' },
            label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
            input: {
                flex: '1 1 auto',
                minWidth: 0,
                padding: '6px 8px',
                fontSize: '12px',
                color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-bg-base)',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: '6px',
            },
            button: {
                padding: '6px 12px',
                fontSize: '12px',
                color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: '6px',
                cursor: 'pointer',
            },
            details: { marginTop: '2px' },
            summary: {
                cursor: 'pointer',
                fontSize: '12px',
                color: 'var(--dsw-alias-label-primary)',
                userSelect: 'none',
            },
            list: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                gap: '2px 12px',
                margin: '4px 0 0',
                padding: 0,
                listStyle: 'none',
            },
            item: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', minWidth: 0 },
            itemName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            meta: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' },
            message: (bad) => ({
                fontSize: '12px',
                margin: 0,
                color: bad ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
            }),
        };
        /** Same two accepted shapes as the Host parser; refuses anything else early. */
        function credentialProblem(raw) {
            const text = typeof raw === 'string' ? raw.trim() : '';
            if (text.length === 0)
                return 'empty';
            if (text.startsWith('{')) {
                try {
                    const parsed = JSON.parse(text);
                    const userId = parsed.userId ?? parsed.user_id ?? parsed.accountId ?? parsed.id;
                    const token = parsed.accessToken ?? parsed.access_token ?? parsed.access ?? parsed.token;
                    return typeof userId !== 'undefined' && typeof token === 'string' && token.length > 0 ? null : 'invalid';
                }
                catch {
                    return 'invalid';
                }
            }
            const space = text.indexOf(' ');
            if (space <= 0)
                return 'invalid';
            return text.slice(space + 1).trim().length > 0 ? null : 'invalid';
        }
        /** Read `apiKeyEnv` out of one settings namespace view. */
        function refFromNamespaces(namespaces) {
            if (!Array.isArray(namespaces))
                return undefined;
            const view = namespaces.find((entry) => entry.ns === SETTINGS_NS);
            const named = view?.value === null || typeof view?.value !== 'object' ? undefined : view.value.apiKeyEnv;
            return typeof named === 'string' && named.length > 0 ? named : undefined;
        }
        function ZedProviderCard(props) {
            const t = typeof props.t === 'function' ? props.t : (key) => COPY.en[key] ?? key;
            const [credential, setCredential] = React.useState(null);
            const [draft, setDraft] = React.useState('');
            const [busy, setBusy] = React.useState(false);
            const [failure, setFailure] = React.useState(null);
            const [notice, setNotice] = React.useState(null);
            /**
             * The inject face is rebuilt on every render, so callbacks are read
             * through a ref: depending on their identity would re-run the effect on
             * each render and loop.
             */
            const api = React.useRef(props);
            api.current = props;
            const refresh = () => {
                const describe = api.current?.describe;
                if (typeof describe !== 'function') {
                    setCredential((current) => current ?? { configured: false, writable: true });
                    return;
                }
                Promise.resolve(describe())
                    .then((described) => setCredential(described ?? { configured: false, writable: true }))
                    .catch(() => setCredential({ configured: false, writable: true }));
            };
            const [catalog, setCatalog] = React.useState(null);
            const [modelsBusy, setModelsBusy] = React.useState(false);
            const [modelsFailure, setModelsFailure] = React.useState(null);
            const [editorOpen, setEditorOpen] = React.useState(false);
            const [editorResolved, setEditorResolved] = React.useState(false);
            const root = React.useRef(null);
            // The plugin's answer wins: a Zed link can live in the credential
            // reference, in the grant record, or in the app keyring, and only the
            // Host can tell. `keyConfigured` is the page's optimistic first paint.
            const linked = catalog === null ? props.keyConfigured === true : catalog.ok === true;
            const writable = credential === null || credential.writable !== false;
            const loadCatalog = React.useRef(() => { });
            loadCatalog.current = () => {
                const call = api.current?.catalog;
                if (typeof call !== 'function')
                    return;
                setModelsBusy(true);
                Promise.resolve(call())
                    .then((value) => {
                    setCatalog(value ?? { ok: false, models: [], selected: null, message: 'no catalog' });
                    setModelsFailure(value?.ok === true ? null : (value?.message ?? null));
                })
                    .catch((error) => {
                    setCatalog({ ok: false, models: [], selected: null });
                    setModelsFailure(error instanceof Error ? error.message : String(error));
                })
                    .finally(() => setModelsBusy(false));
            };
            React.useEffect(() => {
                if (props.keyConfigured === true)
                    setCredential({ configured: true, writable: true });
                refresh();
                loadCatalog.current();
            }, [props.keyConfigured]);
            // The Host pushes credential, settings and provider changes, so a
            // /zed-login run in the composer flips this card without a reload.
            React.useEffect(() => {
                const subscribe = api.current?.subscribe;
                if (typeof subscribe !== 'function')
                    return undefined;
                return subscribe(() => {
                    refresh();
                    loadCatalog.current();
                });
            }, []);
            /**
             * This block belongs to the provider's editor, which the shipped card only
             * renders once Edit is pressed: the seat is a sibling *before* that editor
             * inside the row. So the row is in editing posture exactly when something
             * follows the seat — observed rather than assumed, because the seat gets
             * no editing flag. When the structure is not recognised the block stays
             * visible: hiding configuration the user cannot bring back is worse.
             */
            React.useEffect(() => {
                const node = root.current;
                if (node === null || typeof MutationObserver === 'undefined')
                    return undefined;
                const seat = node.closest('[data-slot="settings.models.provider-card"]') ?? node.parentElement;
                const row = seat?.parentElement;
                if (row === null || row === undefined)
                    return undefined;
                const sync = () => {
                    setEditorOpen(row.lastElementChild !== seat);
                    setEditorResolved(true);
                };
                sync();
                const observer = new MutationObserver(sync);
                observer.observe(row, { childList: true });
                return () => {
                    observer.disconnect();
                };
            }, []);
            const models = catalog?.models ?? [];
            const selected = catalog?.selected ?? (models.length > 0 ? models.map((model) => model.id) : null);
            /** One tick writes the whole selection; an empty or complete set unsets the field. */
            const toggle = (id) => {
                if (selected === null)
                    return;
                const next = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id].sort();
                setCatalog((current) => (current === null ? current : { ...current, selected: next }));
                setModelsBusy(true);
                Promise.resolve(api.current.select(next))
                    .then((error) => {
                    if (typeof error === 'string' && error.length > 0)
                        setModelsFailure(error);
                    loadCatalog.current();
                })
                    .catch((error) => setModelsFailure(error instanceof Error ? error.message : String(error)))
                    .finally(() => setModelsBusy(false));
            };
            const resetModels = () => {
                setModelsBusy(true);
                Promise.resolve(api.current.select(models.map((model) => model.id)))
                    .then((error) => {
                    if (typeof error === 'string' && error.length > 0)
                        setModelsFailure(error);
                    loadCatalog.current();
                })
                    .catch((error) => setModelsFailure(error instanceof Error ? error.message : String(error)))
                    .finally(() => setModelsBusy(false));
            };
            const submit = () => {
                const problem = credentialProblem(draft);
                if (problem !== null) {
                    setFailure(t('invalid'));
                    setNotice(null);
                    return;
                }
                setBusy(true);
                setFailure(null);
                Promise.resolve(api.current.save(draft.trim()))
                    .then((error) => {
                    if (typeof error === 'string' && error.length > 0)
                        setFailure(error);
                    else {
                        setNotice(t('saved'));
                        setDraft('');
                        refresh();
                    }
                })
                    .catch((error) => setFailure(error instanceof Error ? error.message : String(error)))
                    .finally(() => setBusy(false));
            };
            const clear = () => {
                setBusy(true);
                setFailure(null);
                Promise.resolve(api.current.clear())
                    .then((error) => {
                    if (typeof error === 'string' && error.length > 0)
                        setFailure(error);
                    else {
                        setNotice(t('cleared'));
                        setCredential({ configured: false, writable: true });
                    }
                })
                    .catch((error) => setFailure(error instanceof Error ? error.message : String(error)))
                    .finally(() => setBusy(false));
            };
            const collapsed = editorResolved && !editorOpen;
            return h('div', { style: styles.root, 'data-zed-provider-card': PROVIDER, ref: root }, collapsed ? null : h('div', { style: styles.root }, h('div', { style: styles.status }, h('span', { style: styles.dot(linked) }), h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, linked ? t('statusLinked') : t('statusMissing'))), linked ? null : h('p', { style: styles.hint }, t('hint')), writable
                ? h('div', { style: styles.row }, h('label', { style: styles.label, htmlFor: 'zed-credential' }, t('fieldLabel')), h('input', {
                    id: 'zed-credential',
                    style: styles.input,
                    type: 'password',
                    autoComplete: 'off',
                    spellCheck: false,
                    placeholder: t('placeholder'),
                    value: draft,
                    disabled: busy,
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                        if (event.key === 'Enter' && !busy)
                            submit();
                    },
                }), h('button', { type: 'button', style: styles.button, disabled: busy || draft.trim().length === 0, onClick: submit }, busy ? t('saving') : t('save')), linked
                    ? h('button', { type: 'button', style: styles.button, disabled: busy, onClick: clear }, t('clear'))
                    : null)
                : h('p', { style: styles.hint }, t('statusUnwritable')), linked
                ? h('details', { style: styles.details }, h('summary', { style: styles.summary }, t('modelsTitle'), models.length > 0
                    ? h('span', { style: styles.meta }, ` (${String(selected === null ? models.length : selected.length)}/${String(models.length)})`)
                    : null), h('p', { style: styles.hint }, selected === null ? t('modelsAll') : t('modelsHint')), modelsBusy ? h('p', { style: styles.meta }, t('modelsLoading')) : null, modelsFailure === null
                    ? null
                    : h('p', { style: styles.message(true) }, t('modelsFailed').replace('%s', modelsFailure)), models.length === 0
                    ? h('p', { style: styles.hint }, t('modelsEmpty'))
                    : h('ul', { style: styles.list }, models.map((model) => h('li', { key: model.id, style: styles.item }, h('label', { style: styles.item }, h('input', {
                        type: 'checkbox',
                        checked: selected === null || selected.includes(model.id),
                        disabled: modelsBusy,
                        onChange: () => toggle(model.id),
                    }), h('span', { style: styles.itemName, title: model.id }, model.name ?? model.id)), model.contextWindow === undefined
                        ? null
                        : h('span', { style: styles.meta }, `${String(Math.round(model.contextWindow / 1000))}k`)))), selected === null || models.length === 0
                    ? null
                    : h('button', { type: 'button', style: styles.button, disabled: modelsBusy, onClick: resetModels }, t('modelsReset')))
                : null, h('p', { style: styles.message(false) }, t('storedRef').replace('%s', credential?.ref ?? props.fallbackRef ?? DEFAULT_REF)), failure === null ? null : h('p', { style: styles.message(true) }, failure), notice === null ? null : h('p', { style: styles.message(false) }, notice)));
        }
        const inject = ['slots', 'locale', 'remote'];
        /**
         * Register the card and its copy. Everything crossing the wire is bound
         * here, so the component itself only ever sees plain callbacks.
         * @param ctx - this plugin's context.
         */
        function apply(ctx) {
            ctx.effect(() => ctx.locale.register(NS, COPY), 'dsh-zed-provider: card copy');
            /**
             * The credential remote, captured by a child fiber so the card's write
             * path lights up whenever the Host mounts it — without making the main
             * fiber wait for it.
             */
            let mountedCredentials;
            ctx.inject(['remote.credentials'], (child) => {
                mountedCredentials = child.remote?.credentials;
                return () => {
                    mountedCredentials = undefined;
                };
            });
            const credentialsOf = () => mountedCredentials ?? ctx.remote?.credentials;
            /** The reference the Host resolves; read per call so a settings edit is honored. */
            const refOf = async () => {
                try {
                    const scope = ctx.get('settingsScope');
                    const snapshot = scope?.describe?.().getSnapshot?.();
                    const named = refFromNamespaces(snapshot?.view?.namespaces);
                    if (named !== undefined)
                        return named;
                }
                catch {
                    // The settings UI's own scope is not always reachable from here.
                }
                try {
                    const described = await ctx.remote?.settings?.describe?.();
                    if (described?.ok === true) {
                        const named = refFromNamespaces(described.value?.namespaces);
                        if (named !== undefined)
                            return named;
                    }
                }
                catch {
                    // Fall through to the default reference the Host ships with.
                }
                return DEFAULT_REF;
            };
            const describe = async () => {
                const ref = await refOf();
                const credentials = credentialsOf();
                if (credentials === undefined)
                    return { ref, configured: false, writable: false, unavailable: true };
                const response = await credentials.describe([ref]);
                if (!response.ok)
                    throw new Error(response.error?.message ?? 'the credential could not be read');
                return { ref, ...(response.value?.[ref] ?? { configured: false, writable: true }) };
            };
            const write = async (run) => {
                const credentials = credentialsOf();
                if (credentials === undefined)
                    return COPY.en.unavailable;
                const ref = await refOf();
                const response = await run(credentials, ref);
                return response.ok ? undefined : (response.error?.message ?? 'the request was refused');
            };
            /** This namespace's stored section, for the model selection and its revision. */
            const namespaceOf = async () => {
                const described = await ctx.remote?.settings?.describe?.();
                if (described?.ok !== true)
                    throw new Error(described?.error?.message ?? 'settings are unavailable');
                const namespaces = (described.value?.namespaces ?? []);
                const view = namespaces.find((entry) => entry.ns === SETTINGS_NS);
                if (view === undefined)
                    throw new Error('this provider has no settings section');
                const value = view.value !== null && typeof view.value === 'object' ? view.value : {};
                return { ns: SETTINGS_NS, value, revision: view.revision };
            };
            /**
             * Zed's catalog for this route, plus the ids the picker is narrowed to.
             * A successful call is also the only honest "linked" test: the Host
             * answered it by resolving a credential and Zed accepted it, which the
             * page's own credential join cannot know (it only sees the reference).
             */
            const catalog = async () => {
                const discovered = await ctx.remote?.llm?.discoverModels?.(SETTINGS_NS, { provider: PROVIDER });
                const view = await namespaceOf().catch(() => undefined);
                const visible = view?.value.visibleModels;
                const selected = Array.isArray(visible) ? visible.filter((id) => typeof id === 'string') : null;
                if (discovered?.ok !== true) {
                    return { ok: false, models: [], selected, message: discovered?.error?.message ?? 'the model catalog is unavailable' };
                }
                return { ok: true, models: discovered.value ?? [], selected, revision: view?.revision };
            };
            /** Refresh hooks: the Host pushes these when a credential or provider changes. */
            const subscribe = (handler) => {
                const remote = ctx.remote;
                if (typeof remote?.$on !== 'function')
                    return () => { };
                const offs = [
                    remote.$on('credentials/reference-updated', handler),
                    remote.$on('credentials/record-updated', handler),
                    remote.$on('settings/document-updated', handler),
                    remote.$on('llm/adapters-updated', handler),
                ];
                return () => {
                    for (const off of offs)
                        if (typeof off === 'function')
                            off();
                };
            };
            /** Write the selection: every runnable model means the field is unset. */
            const select = async (ids) => {
                const settings = ctx.remote?.settings;
                if (typeof settings?.mutate !== 'function')
                    return COPY.en.unavailable;
                const view = await namespaceOf();
                const all = (await catalog().catch(() => ({ models: [] }))).models;
                const ops = ids.length === 0 || ids.length === all.length
                    ? [{ op: 'unset', path: ['visibleModels'] }]
                    : [{ op: 'set', path: ['visibleModels'], value: ids }];
                const response = await settings.mutate(SETTINGS_NS, ops, view.revision);
                return response.ok ? undefined : (response.error?.message ?? 'the selection was refused');
            };
            ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
                name: 'settings.models.provider-card',
                key: SETTINGS_NS,
                locale: NS,
                inject: () => ({
                    fallbackRef: DEFAULT_REF,
                    describe,
                    save: (value) => write((credentials, ref) => credentials.set(ref, value)),
                    clear: () => write((credentials, ref) => credentials.unset(ref)),
                    catalog,
                    select,
                    subscribe,
                }),
            }, ZedProviderCard));
        }
        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    },
});
