import { ErrorNote, Icon, PageHead, Segmented, Status } from '@arc/ui';
import {
  type ApiKey,
  type Application,
  type ProviderAccount,
  type Traffic,
  get,
} from '@arc/ui/api';
import { HEALTH } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useOrg } from '../org';
import { type Range, UsagePanel } from './Usage';

/** Whether any app has an active ARC key (null while checking). One small request per app. */
function useAnyArcKey(apps: Application[] | undefined): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    if (!apps) return;
    let live = true;
    Promise.all(apps.map((a) => get<{ data: ApiKey[] }>(`/applications/${a.id}/api-keys`))).then(
      (all) => live && setHas(all.some((r) => r.data.some((k) => !k.revokedAt))),
      () => live && setHas(false),
    );
    return () => {
      live = false;
    };
  }, [apps]);
  return has;
}

export function OverviewPage() {
  const org = useOrg();
  const [range, setRange] = useState<Range>('24h');
  const keys = useData<{ data: ProviderAccount[] }>('/provider-accounts');
  const apps = useData<{ data: Application[] }>('/applications');
  const firstApp = apps.data?.data[0];
  const hasArcKey = useAnyArcKey(apps.data?.data);
  const usage = useData<Traffic>(`/usage?range=${range}&by=app`, [range]);
  const allTime = useData<Traffic>('/usage?range=30d&by=app');

  const providerKeys = keys.data?.data ?? [];
  const steps = [
    {
      done: providerKeys.length > 0,
      title: 'Add a provider key',
      sub: 'Your Gemini, Groq, OpenRouter… key. ARC encrypts it; your traffic only ever uses your keys.',
      to: '/keys?add=1',
      action: 'Add key',
    },
    {
      done: (apps.data?.data.length ?? 0) > 0,
      title: 'Create an app',
      sub: 'Each app gets its own ARC keys and its own usage.',
      to: '/apps?new=1',
      action: 'Create app',
    },
    {
      done: hasArcKey === true,
      title: 'Issue an ARC key',
      sub: 'The app sends it instead of a provider key. Shown once.',
      to: firstApp ? `/apps/${firstApp.id}?newKey=1` : '/apps',
      action: 'Issue key',
    },
    {
      done: (allTime.data?.series ?? []).some((p) => p.requests > 0),
      title: 'Send your first request',
      sub: 'Point any OpenAI-compatible client at ARC. The app page has the snippet.',
      to: firstApp ? `/apps/${firstApp.id}#connect` : '/apps',
      action: 'Show me',
    },
  ];
  const loaded = keys.data && apps.data && allTime.data && hasArcKey !== null;
  const doneCount = steps.filter((s) => s.done).length;
  const next = steps.findIndex((s) => !s.done);
  const failing = providerKeys.filter(
    (k) =>
      k.enabled && (k.healthStatus === 'invalid_credentials' || k.healthStatus === 'unreachable'),
  );

  return (
    <div className="page">
      <PageHead
        title="Overview"
        sub={org.name}
        actions={
          <Segmented
            label="Period"
            value={range}
            onChange={setRange}
            options={[
              ['24h', '24 hours'],
              ['7d', '7 days'],
              ['30d', '30 days'],
            ]}
          />
        }
      />
      <ErrorNote error={keys.error ?? apps.error ?? usage.error} />

      {loaded && doneCount < steps.length && (
        <section className="section" style={{ marginTop: 0 }} aria-labelledby="start-title">
          <div className="section-head">
            <h2 className="section-title" id="start-title">
              Get started
            </h2>
            <div className="progress-line">
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
              </div>
              {doneCount} of {steps.length} done
            </div>
          </div>
          <ol className="panel steps" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {steps.map((s, i) => (
              <li key={s.title} className={`step ${s.done ? 'done' : i === next ? 'next' : ''}`}>
                <span className="step-mark" aria-hidden="true">
                  {s.done && <Icon name="check" size={14} />}
                </span>
                <div>
                  <div className="step-title">
                    {s.title}
                    <span className="sr-only">{s.done ? ' (done)' : ''}</span>
                  </div>
                  {!s.done && <div className="step-sub">{s.sub}</div>}
                </div>
                {!s.done && org.canManage && (
                  <Link className={`btn sm ${i === next ? 'primary' : ''}`} to={s.to}>
                    {s.action}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {failing.length > 0 && (
        <section className="section" style={{ marginTop: loaded && doneCount < 4 ? 40 : 0 }}>
          <div className="section-head">
            <h2 className="section-title">Needs you</h2>
          </div>
          <div className="panel">
            {failing.map((k) => (
              <Link key={k.id} className="needs-row" to={`/keys?key=${k.id}`}>
                <Status tone="bad">{k.label}</Status>
                <span className="detail">
                  {HEALTH[k.healthStatus]?.label}
                  {k.lastValidationError ? ` · ${k.lastValidationError}` : ''}
                </span>
                <span className="go">Fix →</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section
        className="section"
        style={doneCount === 4 && !failing.length ? { marginTop: 0 } : undefined}
      >
        <UsagePanel traffic={usage.data} range={range} detailsLink />
      </section>
    </div>
  );
}
