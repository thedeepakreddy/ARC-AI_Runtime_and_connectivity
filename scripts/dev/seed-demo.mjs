#!/usr/bin/env node
/**
 * Demo data for developing and screenshotting the console. NEVER run against production.
 *
 *   DATABASE_URL=… ARC_URL=http://127.0.0.1:8080 ARC_OWNER_EMAIL=… ARC_OWNER_PASSWORD=… \
 *     node scripts/dev/seed-demo.mjs
 *
 * Uses the admin API for everything it can (keys are encrypted by ARC), then SQL for what only
 * real traffic or real providers would produce: health states, discovered models, 30 days of
 * request history.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const pg = require('pg');
const {
  DATABASE_URL,
  ARC_URL = 'http://127.0.0.1:8080',
  ARC_OWNER_EMAIL,
  ARC_OWNER_PASSWORD,
} = process.env;
if (!DATABASE_URL || !ARC_OWNER_EMAIL || !ARC_OWNER_PASSWORD)
  throw new Error('set DATABASE_URL, ARC_OWNER_EMAIL, ARC_OWNER_PASSWORD');
if (/prod/i.test(DATABASE_URL)) throw new Error('refusing to seed what looks like production');

const login = await fetch(`${ARC_URL}/admin/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: ARC_OWNER_EMAIL, password: ARC_OWNER_PASSWORD }),
});
const cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const api = async (method, path, body) => {
  const r = await fetch(`${ARC_URL}/admin/v1${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

const keys = [
  ['gemini', 'Gemini 1', 'healthy'],
  ['gemini', 'Gemini 2', 'healthy'],
  ['gemini', 'Gemini 3', 'rate_limited'],
  ['gemini', 'Gemini 4', 'invalid_credentials'],
  ['gemini', 'Gemini 5', 'healthy'],
  ['groq', 'Groq personal', 'healthy'],
  ['groq', 'Groq work', 'healthy'],
  ['openrouter', 'OpenRouter', 'healthy'],
  ['cerebras', 'Cerebras', 'healthy'],
  ['mistral', 'Mistral', 'unknown'],
];
const accounts = {};
for (const [providerId, label, health] of keys) {
  const a = await api('POST', '/provider-accounts', {
    providerId,
    label,
    apiKey: `demo-${randomUUID()}`,
  });
  accounts[label] = { id: a.id, providerId };
  await db.query(
    `UPDATE provider_accounts SET health_status = $2, last_validated_at = now() - (random() * interval '20 minutes'),
            last_validation_error = CASE WHEN $2 = 'invalid_credentials' THEN 'API key not valid. Please pass a valid API key.' END
      WHERE id = $1`,
    [a.id, health],
  );
}
await db.query("UPDATE provider_accounts SET enabled = false WHERE label = 'Mistral'");

const models = [
  [
    'gemini',
    'gemini-3.8-flash',
    'VERIFIED_FREE',
    ['text', 'streaming', 'tools', 'structured_output', 'vision', 'audio_input'],
    true,
  ],
  [
    'gemini',
    'gemini-4-hydrogen',
    'RESTRICTED_FREE',
    ['text', 'streaming', 'tools', 'structured_output'],
    true,
  ],
  ['gemini', 'gemini-embedding-001', 'VERIFIED_FREE', ['embeddings'], true],
  ['groq', 'llama-3.3-70b-versatile', 'VERIFIED_FREE', ['text', 'streaming', 'tools'], true],
  ['groq', 'llama-3.1-8b-instant', 'VERIFIED_FREE', ['text', 'streaming'], true],
  ['openrouter', 'deepseek/deepseek-r1:free', 'RESTRICTED_FREE', ['text', 'streaming'], true],
  ['cerebras', 'qwen-3-235b', 'VERIFIED_FREE', ['text', 'streaming', 'tools'], false],
  ['groq', 'llama-4-scout-17b-16e-instruct', 'UNKNOWN', [], false],
  ['groq', 'qwen-3-32b', 'UNKNOWN', [], false],
  ['groq', 'kimi-k2-instruct', 'UNKNOWN', [], false],
  ['openrouter', 'meta-llama/llama-4-maverick:free', 'UNKNOWN', [], false],
  ['openrouter', 'mistralai/mistral-small-3.2:free', 'UNKNOWN', [], false],
  ['mistral', 'mistral-medium-3', 'PAID', ['text', 'streaming', 'tools'], false],
];
for (const [providerId, modelId, eligibility, caps, enabled] of models) {
  const m = await db.query(
    `INSERT INTO models (provider_id, model_id, capabilities, eligibility, eligibility_evidence_url, eligibility_checked_at, enabled, source, terms_note)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 <> 'UNKNOWN' THEN 'https://example.com/pricing' END, CASE WHEN $4 <> 'UNKNOWN' THEN now() END, $5, 'discovered',
             CASE WHEN $4 = 'RESTRICTED_FREE' THEN '1,000 requests/day per project' END)
     ON CONFLICT (provider_id, model_id) DO UPDATE SET eligibility = EXCLUDED.eligibility RETURNING id`,
    [providerId, modelId, caps, eligibility, enabled],
  );
  for (const a of Object.values(accounts))
    if (a.providerId === providerId)
      await db.query(
        'INSERT INTO account_models (account_id, model_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [a.id, m.rows[0].id],
      );
}

const apps = {};
for (const [name, slug] of [
  ['Echo Phone', 'echo-phone'],
  ['Data Science Studio', 'data-science-studio'],
  ['Aira', 'aira'],
]) {
  const existing = (await api('GET', '/applications')).data.find((x) => x.slug === slug);
  apps[slug] = existing ?? (await api('POST', '/applications', { name, slug, firstParty: true }));
  if (slug !== 'aira')
    await api('POST', `/applications/${apps[slug].id}/api-keys`, { name: `${slug} production` });
}
await api('POST', `/applications/${apps['aira'].id}/api-keys`, {
  name: 'aira staging',
  expiresInDays: 5,
});
await api('PUT', `/applications/${apps['echo-phone'].id}/routing-policy`, {
  allowedJurisdictions: ['US', 'EU', 'UK', 'CA', 'SELF_HOSTED'],
  allowPaidOwnerKeys: false,
});
await db.query(
  "UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE name LIKE 'echo%' OR name LIKE 'data%'",
);

// 30 days of traffic, busier in the daytime, Echo mostly short Gemini/Groq turns.
const platform = (await db.query("SELECT id FROM tenants WHERE kind = 'platform'")).rows[0].id;
const routes = [
  ['echo-phone', 'gemini', 'gemini/gemini-3.8-flash', 'Gemini 1', 0.3],
  ['echo-phone', 'gemini', 'gemini/gemini-3.8-flash', 'Gemini 2', 0.26],
  ['echo-phone', 'gemini', 'gemini/gemini-3.8-flash', 'Gemini 5', 0.12],
  ['echo-phone', 'groq', 'groq/llama-3.3-70b-versatile', 'Groq personal', 0.14],
  ['data-science-studio', 'gemini', 'gemini/gemini-4-hydrogen', 'Gemini 1', 0.07],
  ['data-science-studio', 'openrouter', 'openrouter/deepseek/deepseek-r1:free', 'OpenRouter', 0.05],
  ['data-science-studio', 'groq', 'groq/llama-3.3-70b-versatile', 'Groq work', 0.06],
];
await db.query('DELETE FROM request_rollups');
const now = Date.now();
const rows = [];
for (let h = 30 * 24; h >= 0; h--) {
  const t = new Date(Math.floor((now - h * 3600_000) / 3600_000) * 3600_000);
  const hour = t.getUTCHours();
  const load =
    260 + 520 * Math.max(0, Math.sin(((hour - 6) / 24) * Math.PI * 2)) + Math.random() * 90;
  for (const [slug, provider, model, label, share] of routes) {
    const n = Math.round(load * share);
    const errors =
      Math.random() < 0.15 ? Math.round(n * 0.02 * Math.random()) : Math.round(n * 0.002);
    rows.push([
      t,
      platform,
      apps[slug].id,
      'chat/completions',
      provider,
      model,
      accounts[label].id,
      n,
      errors,
      Math.round(n * (provider === 'gemini' ? 0.012 : 0.004)),
      n * (1.1 + Math.random()),
      n,
      n * (slug === 'echo-phone' ? 380 : 2400),
    ]);
  }
}
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const cols = Array.from({ length: 13 }, (_, c) => chunk.map((r) => r[c]));
  await db.query(
    `INSERT INTO request_rollups (bucket, tenant_id, application_id, endpoint, provider_id, model_name, account_id, requests, errors, fallbacks, overhead_ms_sum, overhead_n, duration_ms_sum)
     SELECT * FROM unnest($1::timestamptz[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[], $9::int[], $10::int[], $11::float8[], $12::int[], $13::float8[])`,
    cols,
  );
}
// A customer organization, for the Customers page.
const t = await db.query(
  "INSERT INTO tenants (kind, name) VALUES ('organization', 'Northwind Analytics') RETURNING id",
);
await db.query(
  "INSERT INTO applications (tenant_id, name, slug) VALUES ($1, 'Forecasts', 'forecasts')",
  [t.rows[0].id],
);
await db.query(
  "INSERT INTO worker_heartbeats (worker_id, hostname, started_at) VALUES ('demo', 'demo', now()) ON CONFLICT (worker_id) DO UPDATE SET last_seen = now()",
);
await db.end();
console.log('seeded: 10 provider keys, 13 models, 3 apps, 30 days of traffic, 1 customer');
