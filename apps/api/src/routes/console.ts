import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { currentUser, requireSuperadmin, requireUser } from '../auth/context.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
  verifyPassword,
} from '../auth/password.js';
import { ArcError, notFound, parseInput } from '../errors.js';
import type { AdminDeps } from './deps.js';

/**
 * Data for the owner's console (apps/console). Superadmin only. Read models over existing tables
 * plus request_rollups; no request content is ever stored or returned.
 */

const RANGES = {
  '24h': { hours: 24, step: 'hour' },
  '7d': { hours: 168, step: 'day' },
  '30d': { hours: 720, step: 'day' },
} as const;
const rangeQuery = z.object({ range: z.enum(['24h', '7d', '30d']).default('24h') });
const trafficQuery = rangeQuery.extend({
  by: z.enum(['app', 'provider', 'model', 'key']).default('app'),
  /** Only this app's traffic. */
  app: z.uuid().optional(),
});
const idParam = z.object({ id: z.uuid() });
const passwordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

interface NeedsYou {
  kind: 'alert' | 'key_failing' | 'key_resting' | 'models_to_classify' | 'api_key_expiring';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail?: string | undefined;
  /** Console route that fixes it. */
  href: string;
}

const pct = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

export async function consoleRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireUser(db));

  async function platformTenantId(): Promise<string> {
    const r = await db.query<{ id: string }>("SELECT id FROM tenants WHERE kind = 'platform'");
    if (!r.rows[0]) throw notFound('Platform tenant');
    return r.rows[0].id;
  }

  async function firingAlerts(): Promise<NeedsYou[]> {
    if (!deps.alertmanagerUrl) return [];
    try {
      const res = await fetch(
        `${deps.alertmanagerUrl.replace(/\/+$/, '')}/api/v2/alerts?active=true&silenced=false&inhibited=false`,
        { signal: AbortSignal.timeout(1500) },
      );
      if (!res.ok) return [];
      const alerts = (await res.json()) as {
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      }[];
      return alerts.slice(0, 20).map((a) => ({
        kind: 'alert' as const,
        severity: a.labels?.severity === 'critical' ? 'critical' : 'warning',
        title: a.annotations?.summary ?? a.labels?.alertname ?? 'Alert firing',
        detail: a.labels?.alertname,
        href: '/traffic',
      }));
    } catch {
      return []; // Alertmanager down never breaks the console.
    }
  }

  app.get('/console/overview', async (req) => {
    requireSuperadmin(req);
    const { range } = parseInput(rangeQuery, req.query);
    const { hours, step } = RANGES[range];
    const tenantId = await platformTenantId();

    const [
      readiness,
      worker,
      keys,
      toClassify,
      expiring,
      alerts,
      totals,
      series,
      byApp,
      byProvider,
    ] = await Promise.all([
      deps.readiness?.() ?? Promise.resolve(null),
      db.query<{ last_seen: Date | null }>(
        'SELECT max(last_seen) AS last_seen FROM worker_heartbeats',
      ),
      db.query<{
        id: string;
        label: string;
        provider: string;
        health_status: string;
        last_validation_error: string | null;
      }>(
        `SELECT a.id, a.label, p.display_name AS provider, a.health_status, a.last_validation_error
             FROM provider_accounts a JOIN providers p ON p.id = a.provider_id
            WHERE a.tenant_id = $1 AND a.enabled
              AND a.health_status IN ('invalid_credentials', 'unreachable', 'rate_limited')
            ORDER BY a.health_status, p.display_name, a.label`,
        [tenantId],
      ),
      db.query<{ provider: string; n: number }>(
        `SELECT p.display_name AS provider, count(DISTINCT m.id)::int AS n
             FROM models m JOIN providers p ON p.id = m.provider_id
             JOIN account_models am ON am.model_id = m.id
             JOIN provider_accounts a ON a.id = am.account_id AND a.tenant_id = $1
            WHERE m.eligibility = 'UNKNOWN'
            GROUP BY p.display_name ORDER BY n DESC`,
        [tenantId],
      ),
      db.query<{ name: string; app: string; app_id: string; expires_at: Date }>(
        `SELECT k.name, a.name AS app, a.id AS app_id, k.expires_at
             FROM api_keys k JOIN applications a ON a.id = k.application_id
            WHERE k.tenant_id = $1 AND k.revoked_at IS NULL
              AND k.expires_at BETWEEN now() AND now() + interval '7 days'
            ORDER BY k.expires_at`,
        [tenantId],
      ),
      firingAlerts(),
      db.query<{ requests: number; errors: number; fallbacks: number; overhead: number | null }>(
        `SELECT coalesce(sum(requests), 0)::int AS requests, coalesce(sum(errors), 0)::int AS errors,
                  coalesce(sum(fallbacks), 0)::int AS fallbacks,
                  sum(overhead_ms_sum) / nullif(sum(overhead_n), 0) AS overhead
             FROM request_rollups WHERE bucket > now() - make_interval(hours => $1)`,
        [hours],
      ),
      db.query<{ t: Date; requests: number; errors: number }>(
        `SELECT g.t, coalesce(sum(r.requests), 0)::int AS requests, coalesce(sum(r.errors), 0)::int AS errors
             FROM generate_series(date_trunc($2, now()) - make_interval(hours => $1) + ('1 ' || $2)::interval,
                                  date_trunc($2, now()), ('1 ' || $2)::interval) AS g(t)
             LEFT JOIN request_rollups r ON date_trunc($2, r.bucket) = g.t
            GROUP BY g.t ORDER BY g.t`,
        [hours, step],
      ),
      db.query<{ id: string; name: string; requests: number; errors: number }>(
        `SELECT a.id, a.name, sum(r.requests)::int AS requests, sum(r.errors)::int AS errors
             FROM request_rollups r JOIN applications a ON a.id = r.application_id
            WHERE r.bucket > now() - make_interval(hours => $1)
            GROUP BY a.id, a.name ORDER BY requests DESC LIMIT 8`,
        [hours],
      ),
      db.query<{ provider: string; requests: number }>(
        `SELECT coalesce(p.display_name, r.provider_id) AS provider, sum(r.requests)::int AS requests
             FROM request_rollups r LEFT JOIN providers p ON p.id = r.provider_id
            WHERE r.bucket > now() - make_interval(hours => $1) AND r.provider_id <> ''
            GROUP BY 1 ORDER BY requests DESC LIMIT 8`,
        [hours],
      ),
    ]);

    const workerAgeS = worker.rows[0]?.last_seen
      ? Math.round((Date.now() - worker.rows[0].last_seen.getTime()) / 1000)
      : null;
    const services = [
      { name: 'API', status: 'up' as const },
      ...(readiness?.dependencies ?? []).map((d) => ({
        name:
          d.name === 'postgres'
            ? 'Postgres'
            : d.name === 'redis'
              ? 'Redis'
              : d.name === 'litellm'
                ? 'LiteLLM'
                : d.name,
        status: d.status === 'up' ? ('up' as const) : ('down' as const),
      })),
      {
        name: 'Worker',
        status: workerAgeS !== null && workerAgeS < 180 ? ('up' as const) : ('down' as const),
      },
    ];

    const needsYou: NeedsYou[] = [...alerts];
    for (const k of keys.rows) {
      const failing = k.health_status !== 'rate_limited';
      needsYou.push({
        kind: failing ? 'key_failing' : 'key_resting',
        severity: failing ? 'critical' : 'info',
        title: failing
          ? `${k.provider} key “${k.label}” ${k.health_status === 'unreachable' ? 'is unreachable' : 'was rejected'}`
          : `${k.provider} key “${k.label}” is resting after a rate limit`,
        ...(k.last_validation_error ? { detail: k.last_validation_error.slice(0, 160) } : {}),
        href: `/providers?key=${k.id}`,
      });
    }
    for (const m of toClassify.rows) {
      needsYou.push({
        kind: 'models_to_classify',
        severity: 'warning',
        title: `${m.n} new ${m.provider} model${m.n === 1 ? '' : 's'} to classify`,
        href: '/models?tab=classify',
      });
    }
    for (const k of expiring.rows) {
      needsYou.push({
        kind: 'api_key_expiring',
        severity: 'warning',
        title: `${k.app} key “${k.name}” expires ${k.expires_at.toISOString().slice(0, 10)}`,
        href: `/apps/${k.app_id}`,
      });
    }
    const order = { critical: 0, warning: 1, info: 2 };
    needsYou.sort((a, b) => order[a.severity] - order[b.severity]);

    const t = totals.rows[0]!;
    const providerTotal = byProvider.rows.reduce((s, r) => s + r.requests, 0);
    return {
      range,
      services,
      allUp: services.every((s) => s.status === 'up'),
      needsYou,
      counts: {
        modelsToClassify: toClassify.rows.reduce((s, r) => s + r.n, 0),
        failingKeys: keys.rows.filter((k) => k.health_status !== 'rate_limited').length,
        alerts: alerts.length,
      },
      totals: {
        requests: t.requests,
        errorRate: pct(t.errors, t.requests),
        fallbackRate: pct(t.fallbacks, t.requests),
        overheadMsAvg: t.overhead === null ? null : Math.round(Number(t.overhead) * 100) / 100,
      },
      series: series.rows.map((r) => ({
        t: r.t.toISOString(),
        requests: r.requests,
        errors: r.errors,
      })),
      byApp: byApp.rows.map((r) => ({
        id: r.id,
        name: r.name,
        requests: r.requests,
        errorRate: pct(r.errors, r.requests),
      })),
      byProvider: byProvider.rows.map((r) => ({
        provider: r.provider,
        requests: r.requests,
        share: pct(r.requests, providerTotal),
      })),
    };
  });

  app.get('/console/traffic', async (req) => {
    requireSuperadmin(req);
    const { range, by, app: appId } = parseInput(trafficQuery, req.query);
    const { hours, step } = RANGES[range];
    const group = {
      app: {
        key: 'a.id::text',
        label: 'a.name',
        join: 'JOIN applications a ON a.id = r.application_id',
      },
      provider: {
        key: 'r.provider_id',
        label: "coalesce(p.display_name, nullif(r.provider_id, ''), 'No route')",
        join: 'LEFT JOIN providers p ON p.id = r.provider_id',
      },
      model: {
        key: 'r.model_name',
        label: "coalesce(nullif(r.model_name, ''), 'No route')",
        join: '',
      },
      key: {
        key: 'r.account_id',
        label: "coalesce(pa.label || ' · ' || pp.display_name, 'No route')",
        join: 'LEFT JOIN provider_accounts pa ON pa.id::text = r.account_id LEFT JOIN providers pp ON pp.id = pa.provider_id',
      },
    }[by];
    const [rows, series] = await Promise.all([
      db.query<{
        id: string;
        label: string;
        requests: number;
        errors: number;
        fallbacks: number;
        overhead: number | null;
        duration: number | null;
      }>(
        `SELECT ${group.key} AS id, ${group.label} AS label, sum(r.requests)::int AS requests,
                sum(r.errors)::int AS errors, sum(r.fallbacks)::int AS fallbacks,
                sum(r.overhead_ms_sum) / nullif(sum(r.overhead_n), 0) AS overhead,
                sum(r.duration_ms_sum) / nullif(sum(r.requests), 0) AS duration
           FROM request_rollups r ${group.join}
          WHERE r.bucket > now() - make_interval(hours => $1)
            AND ($2::uuid IS NULL OR r.application_id = $2)
          GROUP BY 1, 2 ORDER BY requests DESC LIMIT 100`,
        [hours, appId ?? null],
      ),
      db.query<{
        t: Date;
        requests: number;
        errors: number;
        fallbacks: number;
        overhead: number | null;
      }>(
        `SELECT g.t, coalesce(sum(r.requests), 0)::int AS requests, coalesce(sum(r.errors), 0)::int AS errors,
                coalesce(sum(r.fallbacks), 0)::int AS fallbacks,
                sum(r.overhead_ms_sum) / nullif(sum(r.overhead_n), 0) AS overhead
           FROM generate_series(date_trunc($2, now()) - make_interval(hours => $1) + ('1 ' || $2)::interval,
                                date_trunc($2, now()), ('1 ' || $2)::interval) AS g(t)
           LEFT JOIN request_rollups r ON date_trunc($2, r.bucket) = g.t
                AND ($3::uuid IS NULL OR r.application_id = $3)
          GROUP BY g.t ORDER BY g.t`,
        [hours, step, appId ?? null],
      ),
    ]);
    const n = (v: number | null) => (v === null ? null : Math.round(Number(v) * 100) / 100);
    return {
      range,
      by,
      rows: rows.rows.map((r) => ({
        id: r.id,
        label: r.label,
        requests: r.requests,
        errorRate: pct(r.errors, r.requests),
        fallbackRate: pct(r.fallbacks, r.requests),
        overheadMsAvg: n(r.overhead),
        durationMsAvg: n(r.duration),
      })),
      series: series.rows.map((r) => ({
        t: r.t.toISOString(),
        requests: r.requests,
        errors: r.errors,
        fallbacks: r.fallbacks,
        overheadMsAvg: n(r.overhead),
      })),
    };
  });

  app.get('/console/customers', async (req) => {
    requireSuperadmin(req);
    const { rows } = await db.query(
      `SELECT t.id, t.name, t.kind, t.created_at AS "createdAt", t.suspended_at AS "suspendedAt",
              (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id) AS members,
              (SELECT count(*)::int FROM applications a WHERE a.tenant_id = t.id) AS apps,
              (SELECT count(*)::int FROM provider_accounts pa WHERE pa.tenant_id = t.id) AS "providerKeys",
              (SELECT coalesce(sum(r.requests), 0)::int FROM request_rollups r
                WHERE r.tenant_id = t.id AND r.bucket > now() - interval '30 days') AS "requests30d"
         FROM tenants t WHERE t.kind <> 'platform' ORDER BY t.created_at DESC`,
    );
    return { data: rows };
  });

  for (const action of ['suspend', 'unsuspend'] as const) {
    app.post(`/console/customers/:id/${action}`, async (req, reply) => {
      const user = requireSuperadmin(req);
      const { id } = parseInput(idParam, req.params);
      const r = await db.query(
        `UPDATE tenants SET suspended_at = ${action === 'suspend' ? 'coalesce(suspended_at, now())' : 'NULL'}
          WHERE id = $1 AND kind <> 'platform' RETURNING id`,
        [id],
      );
      if (!r.rowCount) throw notFound('Customer');
      await recordAudit(db, {
        tenantId: id,
        actorUserId: user.userId,
        action: `tenant.${action}ed`,
        targetType: 'tenant',
        targetId: id,
      });
      if (action === 'suspend') {
        // Effective at once on every instance: drop the customer's keys from verifier caches.
        const keys = await db.query<{ key_id: string }>(
          'SELECT key_id FROM api_keys WHERE tenant_id = $1',
          [id],
        );
        for (const k of keys.rows) deps.onApiKeyRevoked?.(k.key_id);
      }
      deps.onRoutingChange?.();
      return reply.code(204).send();
    });
  }

  // --- The signed-in user's own account (any user, not only superadmin) ---

  app.get('/account/sessions', async (req) => {
    const user = currentUser(req);
    const { rows } = await db.query<{
      id: string;
      user_agent: string | null;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, user_agent, created_at, expires_at FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      [user.userId],
    );
    return {
      data: rows.map((s) => ({
        id: s.id,
        userAgent: s.user_agent,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        current: s.id === user.sessionId,
      })),
    };
  });

  app.delete('/account/sessions/:id', async (req, reply) => {
    const user = currentUser(req);
    const { id } = parseInput(idParam, req.params);
    const r = await db.query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [id, user.userId],
    );
    if (!r.rowCount) throw notFound('Session');
    return reply.code(204).send();
  });

  app.post('/account/password', async (req, reply) => {
    const user = currentUser(req);
    const body = parseInput(passwordBody, req.body);
    const r = await db.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.userId],
    );
    if (!r.rows[0] || !(await verifyPassword(body.currentPassword, r.rows[0].password_hash))) {
      throw new ArcError(400, 'wrong_password', 'The current password is not correct');
    }
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      user.userId,
      await hashPassword(body.newPassword),
    ]);
    // Sign out every other session.
    await db.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
      [user.userId, user.sessionId],
    );
    await recordAudit(db, {
      tenantId: null,
      actorUserId: user.userId,
      action: 'user.password_changed',
    });
    return reply.code(204).send();
  });
}
