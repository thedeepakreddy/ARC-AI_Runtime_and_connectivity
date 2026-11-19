/**
 * ARC load test and regression gate.
 *
 * Starts the real built ARC API (dist/main.js) against a fresh database, a real LiteLLM proxy and
 * two mock providers (each in its own process), then runs:
 *   cold          first requests after start / after the routing cache expires
 *   echo-voice    Echo-style short streaming turns: client TTFT and ARC overhead
 *   dss-long      Data Science Studio-style long non-streaming requests
 *   degraded      one key failing 30% of the time: fallback must keep errors near zero
 *
 * Reports p50/p95/p99. With --gate, exits non-zero if ARC overhead p95 or the error rate breach
 * bench/thresholds.json. Provider latency is simulated and reported separately from ARC overhead.
 *
 * Env: BENCH_DATABASE_URL (admin connection), BENCH_REDIS_URL, LITELLM_URL, LITELLM_MASTER_KEY.
 * Args: --gate  --requests <n>  --concurrency <n>  --out <file.json>
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { generateKeyFile } from '../src/vault/vault.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};

const ADMIN_DB = process.env.BENCH_DATABASE_URL ?? 'postgres://arc:arc@127.0.0.1:5432/postgres';
const REDIS_URL = process.env.BENCH_REDIS_URL ?? 'redis://127.0.0.1:6379/2';
const LITELLM_URL = process.env.LITELLM_URL;
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY ?? 'sk-test-master';
const REQUESTS = Number(opt('--requests', '300'));
const CONCURRENCY = Number(opt('--concurrency', '10'));
if (!LITELLM_URL) {
  console.error('LITELLM_URL is required: the benchmark measures the real ARC → LiteLLM path');
  process.exit(2);
}

const children: ChildProcess[] = [];
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function startProcess(
  cmd: string,
  argv: string[],
  env: Record<string, string>,
): { proc: ChildProcess; firstLine: Promise<string> } {
  const proc = spawn(cmd, argv, {
    cwd: apiDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let stderr = '';
  proc.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const firstLine = new Promise<string>((resolve, reject) => {
    let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) resolve(buf.slice(0, nl));
    });
    proc.on('exit', (code) => reject(new Error(`${argv.join(' ')} exited ${code}: ${stderr}`)));
  });
  // Not every caller awaits the first line (e.g. ARC logs nothing to stdout at warn level).
  firstLine.catch(() => undefined);
  return { proc, firstLine };
}

async function waitFor(url: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not become ready`);
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const summary = (xs: number[]) => ({
  p50: pct(xs, 50),
  p95: pct(xs, 95),
  p99: pct(xs, 99),
  n: xs.length,
});

interface Sample {
  ok: boolean;
  overheadMs: number;
  ttftMs: number;
  totalMs: number;
  attempts: number;
}

async function main(): Promise<number> {
  const work = mkdtempSync(path.join(tmpdir(), 'arc-bench-'));
  const vaultFile = path.join(work, 'vault.json');
  writeFileSync(vaultFile, generateKeyFile(), { mode: 0o600 });
  const dbName = `arc_bench_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_DB });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const dbUrl = new URL(ADMIN_DB);
  dbUrl.pathname = `/${dbName}`;

  try {
    // Mock providers: A (will degrade) and B, each in its own process.
    const mocks = await Promise.all(
      [0, 1].map(async () => {
        const { firstLine } = startProcess(
          process.execPath,
          ['--import', 'tsx', 'bench/mock-server.ts'],
          {},
        );
        const [url, control] = (await firstLine).split(' ');
        return { url: url!, control: control! };
      }),
    );
    const configure = (i: number, cfg: Record<string, number>) =>
      fetch(mocks[i]!.control, { method: 'POST', body: JSON.stringify(cfg) });

    // ARC itself: the production build.
    const port = await freePort();
    const env = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: dbUrl.toString(),
      REDIS_URL,
      LITELLM_BASE_URL: LITELLM_URL!,
      LITELLM_MASTER_KEY,
      ARC_VAULT_KEY_FILE: vaultFile,
      COOKIE_SECURE: 'false',
      METRICS_PORT: '0',
      RATE_LIMIT_PER_MINUTE: '100000',
    };
    startProcess(process.execPath, ['dist/main.js'], env);
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/healthz`);

    // Owner, two keys for the same model, classification, app and ARC key.
    await new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, ['dist/cli/create-owner.js'], {
        cwd: apiDir,
        env: {
          ...process.env,
          DATABASE_URL: dbUrl.toString(),
          ARC_OWNER_EMAIL: 'bench@arc.test',
          ARC_OWNER_PASSWORD: 'bench-password-123',
        },
        stdio: 'ignore',
      });
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('create-owner failed'))));
    });
    const login = await fetch(`${base}/admin/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bench@arc.test', password: 'bench-password-123' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    /** Shape of the admin responses this script reads. */
    interface AdminJson {
      id: string;
      key: string;
      data: Array<{ id: string }>;
    }
    const call = async (method: string, url: string, body?: unknown): Promise<AdminJson> => {
      const r = await fetch(`${base}/admin/v1${url}`, {
        method,
        headers: body ? { cookie, 'content-type': 'application/json' } : { cookie },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return (r.status === 204 ? {} : await r.json()) as AdminJson;
    };
    const accounts: string[] = [];
    for (const [i, m] of mocks.entries()) {
      const a = await call('POST', '/provider-accounts', {
        providerId: 'llama-cpp',
        label: `bench-${i}`,
        apiKey: `bench-provider-key-${i}`,
        baseUrl: m.url,
      });
      accounts.push(a.id);
      await call('POST', `/provider-accounts/${a.id}/validate`);
    }
    for (const m of (await call('GET', '/models?provider=llama-cpp')).data) {
      await call('PATCH', `/models/${m.id}`, {
        eligibility: 'VERIFIED_FREE',
        eligibilityEvidenceUrl: 'https://example.test/bench',
        capabilities: ['text', 'streaming'],
        enabled: true,
      });
    }
    const appId = (
      await call('POST', '/applications', { name: 'Bench', slug: 'bench', firstParty: true })
    ).id;
    const arcKey = (await call('POST', `/applications/${appId}/api-keys`, { name: 'bench' }))
      .key as string;

    async function request(stream: boolean): Promise<Sample> {
      const t0 = performance.now();
      try {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${arcKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-cpp/mock-chat',
            stream,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        const reader = res.body!.getReader();
        let ttft = NaN;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (Number.isNaN(ttft) && value?.length) ttft = performance.now() - t0;
        }
        return {
          ok: res.ok,
          overheadMs: Number(res.headers.get('x-arc-overhead-ms') ?? NaN),
          ttftMs: ttft,
          totalMs: performance.now() - t0,
          attempts: Number(res.headers.get('x-arc-route-attempts') ?? 0),
        };
      } catch {
        return {
          ok: false,
          overheadMs: NaN,
          ttftMs: NaN,
          totalMs: performance.now() - t0,
          attempts: 0,
        };
      }
    }

    async function load(n: number, concurrency: number, stream: boolean): Promise<Sample[]> {
      const out: Sample[] = [];
      let started = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (started < n) {
            started++;
            out.push(await request(stream));
          }
        }),
      );
      return out;
    }

    const results: Record<string, unknown> = {};
    const report = (name: string, samples: Sample[], providerTtftMs: number) => {
      const ok = samples.filter((s) => s.ok);
      const r = {
        requests: samples.length,
        errorRate: (samples.length - ok.length) / Math.max(samples.length, 1),
        fallbackRate: ok.filter((s) => s.attempts > 1).length / Math.max(ok.length, 1),
        arcOverheadMs: summary(ok.map((s) => s.overheadMs).filter(Number.isFinite)),
        clientTtftMs: summary(ok.map((s) => s.ttftMs).filter(Number.isFinite)),
        addedTtftMs: summary(ok.map((s) => s.ttftMs - providerTtftMs).filter(Number.isFinite)),
        totalMs: summary(ok.map((s) => s.totalMs)),
        simulatedProviderTtftMs: providerTtftMs,
      };
      results[name] = r;
      return r;
    };

    // cold: first request after start (empty caches), then first request after cache expiry.
    await Promise.all(
      [0, 1].map((i) =>
        configure(i, { responseDelayMs: 40, chunks: 5, chunkDelayMs: 20, failRate: 0 }),
      ),
    );
    const cold = [await request(true)];
    await new Promise((r) => setTimeout(r, 5_500));
    cold.push(await request(true));
    report('cold', cold, 40);

    // Warm-up, not reported.
    await load(30, 5, true);

    report('echo-voice', await load(REQUESTS, CONCURRENCY, true), 40);

    await Promise.all(
      [0, 1].map((i) =>
        configure(i, { responseDelayMs: 300, chunks: 1, chunkDelayMs: 0, failRate: 0 }),
      ),
    );
    report(
      'dss-long',
      await load(Math.ceil(REQUESTS / 3), Math.max(2, Math.floor(CONCURRENCY / 2)), false),
      300,
    );

    // Degrade the key ARC currently ranks first, so its failures exercise fallback.
    const explained = (await call('POST', '/routing/explain', {
      model: 'llama-cpp/mock-chat',
    })) as unknown as {
      selected: { accountId: string };
    };
    const primary = accounts.indexOf(explained.selected.accountId);
    await configure(primary, { responseDelayMs: 40, chunks: 5, chunkDelayMs: 20, failRate: 0.3 });
    await configure(1 - primary, { responseDelayMs: 40, chunks: 5, chunkDelayMs: 20, failRate: 0 });
    report('degraded', await load(REQUESTS, CONCURRENCY, true), 40);

    // Print and gate.
    const thresholds = JSON.parse(readFileSync(path.join(here, 'thresholds.json'), 'utf8')) as {
      overheadP95Ms: number;
      maxErrorRate: number;
    };
    const fmt = (s: { p50: number; p95: number; p99: number }) =>
      `${s.p50.toFixed(2)} / ${s.p95.toFixed(2)} / ${s.p99.toFixed(2)}`;
    console.log(
      `\nARC load test — ${REQUESTS} req, concurrency ${CONCURRENCY}, via LiteLLM at ${LITELLM_URL}\n`,
    );
    console.log(
      '| scenario | n | errors | fallbacks | ARC overhead p50/p95/p99 ms | client TTFT p50/p95/p99 ms | ARC+LiteLLM added TTFT p50/p95 ms | total p50/p95 ms |',
    );
    console.log('|---|---|---|---|---|---|---|---|');
    const failures: string[] = [];
    for (const [name, r] of Object.entries(results) as Array<[string, ReturnType<typeof report>]>) {
      console.log(
        `| ${name} | ${r.requests} | ${(r.errorRate * 100).toFixed(1)}% | ${(r.fallbackRate * 100).toFixed(1)}% | ${fmt(r.arcOverheadMs)} | ${fmt(r.clientTtftMs)} | ${r.addedTtftMs.p50.toFixed(1)} / ${r.addedTtftMs.p95.toFixed(1)} | ${r.totalMs.p50.toFixed(1)} / ${r.totalMs.p95.toFixed(1)} |`,
      );
      if (name !== 'cold' && r.arcOverheadMs.p95 > thresholds.overheadP95Ms) {
        failures.push(
          `${name}: ARC overhead p95 ${r.arcOverheadMs.p95.toFixed(2)} ms > ${thresholds.overheadP95Ms} ms`,
        );
      }
      if (r.errorRate > thresholds.maxErrorRate) {
        failures.push(
          `${name}: error rate ${(r.errorRate * 100).toFixed(2)}% > ${thresholds.maxErrorRate * 100}%`,
        );
      }
    }
    const out = opt('--out', '');
    if (out)
      writeFileSync(
        out,
        `${JSON.stringify({ at: new Date().toISOString(), requests: REQUESTS, concurrency: CONCURRENCY, results }, null, 2)}\n`,
      );
    if (flag('--gate')) {
      if (failures.length) {
        for (const f of failures) console.error(`GATE FAIL: ${f}`);
        return 1;
      }
      console.log('\nregression gate passed');
    }
    return 0;
  } finally {
    for (const c of children) c.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    for (const c of children) c.kill('SIGTERM');
    process.exit(1);
  },
);
