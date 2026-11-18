import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { DependencyCheck } from '../src/readiness.js';

const up = (name: string): DependencyCheck => ({ name, check: async () => undefined });
const down = (name: string, message: string): DependencyCheck => ({
  name,
  check: async () => {
    throw new Error(message);
  },
});
const hang = (name: string): DependencyCheck => ({
  name,
  check: (signal) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted'))),
    ),
});

describe('api foundation', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it('GET /healthz returns ok without touching dependencies', async () => {
    app = buildApp({ checks: [hang('postgres')], readinessTimeoutMs: 50 });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz is 200 when every dependency is up', async () => {
    app = buildApp({
      checks: [up('postgres'), up('redis'), up('litellm')],
      readinessTimeoutMs: 100,
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
    expect(res.json().dependencies).toHaveLength(3);
  });

  it('GET /readyz is 503 and redacts URLs when a dependency is down', async () => {
    app = buildApp({
      checks: [up('redis'), down('postgres', 'connect failed postgres://arc:pw@db:5432/arc')],
      readinessTimeoutMs: 100,
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const pgStatus = res.json().dependencies.find((d: { name: string }) => d.name === 'postgres');
    expect(pgStatus.status).toBe('down');
    expect(pgStatus.error).not.toContain('pw');
    expect(pgStatus.error).toContain('<url>');
  });

  it('GET /readyz never hangs: slow dependencies time out', async () => {
    app = buildApp({ checks: [hang('litellm')], readinessTimeoutMs: 50 });
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.statusCode).toBe(503);
    expect(res.json().dependencies[0].status).toBe('timeout');
  });

  it('propagates a well-formed x-request-id and replaces a malformed one', async () => {
    app = buildApp({ checks: [], readinessTimeoutMs: 50 });
    const good = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'echo-turn-12345' },
    });
    expect(good.headers['x-request-id']).toBe('echo-turn-12345');

    const bad = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
