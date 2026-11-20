#!/usr/bin/env node
/**
 * ARC owner tasks from the command line, through the audited admin API. No dependencies.
 *
 *   node scripts/ops/arc-admin.mjs app-key --name "Echo Phone" --slug echo-phone
 *       Registers the first-party app (once) and issues a new ARC key for it. The key is printed
 *       once and never stored by ARC: put it straight into the app's hosting secrets.
 *
 *   PROVIDER_API_KEY=… node scripts/ops/arc-admin.mjs add-provider-key --provider gemini --label "Gemini 1"
 *       Adds a provider key (the key comes from the environment, never from arguments, so it stays
 *       out of shell history) and validates it. Add as many keys per provider as you like.
 *
 *   node scripts/ops/arc-admin.mjs enable-model --provider gemini --model gemini-3.8-flash \
 *       --eligibility VERIFIED_FREE --evidence https://ai.google.dev/gemini-api/docs/pricing \
 *       --capabilities text,streaming,tools,structured_output,vision
 *       Classifies a discovered model (evidence URL required) and enables it for routing.
 *
 *   node scripts/ops/arc-admin.mjs models [--provider gemini]
 *
 * Env: ARC_URL (default http://127.0.0.1:8080), ARC_OWNER_EMAIL, ARC_OWNER_PASSWORD.
 * Output is JSON on stdout; `app-key --key-only` prints just the key.
 */

const ARC_URL = (process.env.ARC_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const [command, ...rest] = process.argv.slice(2);

function opts(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else {
      out[name] = next;
      i++;
    }
  }
  return out;
}

function fail(message) {
  console.error(`arc-admin: ${message}`);
  process.exit(1);
}

function need(o, ...names) {
  for (const n of names) if (!o[n] || o[n] === true) fail(`--${n} is required`);
}

let cookie = '';
async function login() {
  const email = process.env.ARC_OWNER_EMAIL;
  const password = process.env.ARC_OWNER_PASSWORD;
  if (!email || !password) fail('set ARC_OWNER_EMAIL and ARC_OWNER_PASSWORD');
  const res = await fetch(`${ARC_URL}/admin/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) fail(`login failed (${res.status})`);
  const set = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  cookie = set.map((c) => c.split(';')[0]).join('; ');
}

async function api(method, path, body) {
  const res = await fetch(`${ARC_URL}/admin/v1${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error ?? {};
    const err = new Error(
      `${method} ${path} → ${res.status} ${e.code ?? ''} ${e.message ?? ''}`.trim(),
    );
    err.status = res.status;
    err.code = e.code;
    throw err;
  }
  return data;
}

async function appKey(o) {
  need(o, 'name', 'slug');
  const apps = (await api('GET', '/applications')).data;
  let app = apps.find((a) => a.slug === o.slug);
  if (!app)
    app = await api('POST', '/applications', { name: o.name, slug: o.slug, firstParty: true });
  const key = await api('POST', `/applications/${app.id}/api-keys`, {
    name: typeof o['key-name'] === 'string' ? o['key-name'] : `${o.slug} production`,
    ...(o['expires-in-days'] ? { expiresInDays: Number(o['expires-in-days']) } : {}),
  });
  if (o['key-only']) return console.log(key.key);
  console.log(
    JSON.stringify(
      {
        applicationId: app.id,
        slug: app.slug,
        keyId: key.id,
        displayPrefix: key.displayPrefix,
        key: key.key,
      },
      null,
      2,
    ),
  );
  console.error("Store this key in the app's hosting secrets now: ARC will not show it again.");
}

async function addProviderKey(o) {
  need(o, 'provider', 'label');
  const apiKey = process.env.PROVIDER_API_KEY;
  if (!apiKey) fail('set PROVIDER_API_KEY in the environment (not as an argument)');
  const account = await api('POST', '/provider-accounts', {
    providerId: o.provider,
    label: o.label,
    apiKey,
    ...(typeof o['base-url'] === 'string' ? { baseUrl: o['base-url'] } : {}),
  });
  const check = await api('POST', `/provider-accounts/${account.id}/validate`);
  const models = (await api('GET', `/models?provider=${encodeURIComponent(o.provider)}`)).data;
  console.log(
    JSON.stringify(
      {
        accountId: account.id,
        label: account.label,
        secretHint: account.secretHint,
        validation: check,
        models: models.map((m) => m.modelId),
      },
      null,
      2,
    ),
  );
}

async function enableModel(o) {
  need(o, 'provider', 'model', 'eligibility', 'evidence', 'capabilities');
  const models = (await api('GET', `/models?provider=${encodeURIComponent(o.provider)}`)).data;
  let model = models.find((m) => m.modelId === o.model);
  if (!model) model = await api('POST', '/models', { providerId: o.provider, modelId: o.model });
  const updated = await api('PATCH', `/models/${model.id}`, {
    capabilities: String(o.capabilities)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
    eligibility: o.eligibility,
    eligibilityEvidenceUrl: o.evidence,
    enabled: o.disable ? false : true,
  });
  console.log(JSON.stringify(updated, null, 2));
}

async function listModels(o) {
  const q = typeof o.provider === 'string' ? `?provider=${encodeURIComponent(o.provider)}` : '';
  const models = (await api('GET', `/models${q}`)).data;
  console.log(
    JSON.stringify(
      models.map(({ providerId, modelId, eligibility, enabled, capabilities }) => ({
        providerId,
        modelId,
        eligibility,
        enabled,
        capabilities,
      })),
      null,
      2,
    ),
  );
}

const commands = {
  'app-key': appKey,
  'add-provider-key': addProviderKey,
  'enable-model': enableModel,
  models: listModels,
};
if (!commands[command]) {
  console.error(
    `usage: arc-admin.mjs <${Object.keys(commands).join('|')}> [options]  (see the header of this file)`,
  );
  process.exit(2);
}
try {
  await login();
  await commands[command](opts(rest));
} catch (err) {
  fail(err.message);
}
