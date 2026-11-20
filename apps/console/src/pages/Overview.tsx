import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Overview } from '@arc/ui/api';
import { compact, dateTime, ms, num, pct, time } from '@arc/ui/format';
import { useData, usePolling } from '@arc/ui/hooks';
import { Dot, ErrorNote, Icon, Loading, PageHead, Segmented, TrafficChart } from '@arc/ui';

type Range = '24h' | '7d' | '30d';

export function OverviewPage({ onChange }: { onChange: () => void }) {
  const [range, setRange] = useState<Range>('24h');
  const { data, error, reload } = useData<Overview>(`/console/overview?range=${range}`, [range]);
  usePolling(reload, 30_000);

  return (
    <div className="page">
      <PageHead
        title="Overview"
        actions={
          <Segmented<Range>
            label="Time range"
            value={range}
            onChange={(r) => {
              setRange(r);
              onChange();
            }}
            options={[
              ['24h', '24 hours'],
              ['7d', '7 days'],
              ['30d', '30 days'],
            ]}
          />
        }
      />
      <ErrorNote error={error} />
      {!data ? (
        <Loading rows={6} />
      ) : (
        <>
          <section className="panel status-hero" aria-label="System status">
            <Dot tone={data.allUp ? 'ok' : 'bad'} />
            <span className="title">{data.allUp ? 'All systems nominal' : 'Systems degraded'}</span>
            <div className="services">
              {data.services.map((s) => (
                <span key={s.name} className="service">
                  <Dot tone={s.status === 'up' ? 'ok' : 'bad'} />
                  {s.name}
                </span>
              ))}
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <h2 className="section-title">
                Needs you
                {data.needsYou.length ? (
                  <span className="faint num"> · {data.needsYou.length}</span>
                ) : null}
              </h2>
            </div>
            <div className="panel">
              {data.needsYou.length === 0 ? (
                <div className="calm">
                  <Icon name="check" />
                  Nothing needs you. ARC is handling everything.
                </div>
              ) : (
                data.needsYou.map((n, i) => (
                  <Link key={i} to={n.href} className="needs-row">
                    <Dot
                      tone={
                        n.severity === 'critical' ? 'bad' : n.severity === 'warning' ? 'warn' : ''
                      }
                    />
                    <div className="min-w-0">
                      <div>{n.title}</div>
                      {n.detail && <div className="detail">{n.detail}</div>}
                    </div>
                    <span className="go">{actionFor(n.kind)} →</span>
                  </Link>
                ))
              )}
            </div>
          </section>

          <section className="section" aria-label="Traffic">
            <div className="panel">
              <div className="stats">
                <Stat
                  label="Requests"
                  value={compact(data.totals.requests)}
                  note={`${num(data.totals.requests)} total`}
                />
                <Stat
                  label="Error rate"
                  value={pct(data.totals.errorRate)}
                  note="Returned an error to the app"
                />
                <Stat
                  label="Fallbacks"
                  value={pct(data.totals.fallbackRate)}
                  note="Served by a second key or model"
                />
                <Stat
                  label="ARC overhead"
                  value={
                    data.totals.overheadMsAvg === null
                      ? '—'
                      : ms(data.totals.overheadMsAvg).replace(' ms', '')
                  }
                  unit={
                    data.totals.overheadMsAvg === null || data.totals.overheadMsAvg >= 1000
                      ? ''
                      : 'ms'
                  }
                  note="Average, before the provider"
                />
              </div>
              <div className="chart divider-top">
                <TrafficChart
                  action={<Link to="/traffic">Traffic details →</Link>}
                  points={data.series}
                  label={range === '24h' ? time : (t) => dateTime(t).split(',')[0]!}
                />
              </div>
            </div>
          </section>

          <section className="section split">
            <div>
              <div className="section-head">
                <h2 className="section-title">By app</h2>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>App</th>
                      <th className="r">Requests</th>
                      <th className="r">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byApp.length === 0 && (
                      <tr>
                        <td colSpan={3} className="faint">
                          No traffic in this period.
                        </td>
                      </tr>
                    )}
                    {data.byApp.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Link to={`/apps/${a.id}`} style={{ color: 'var(--text)' }}>
                            {a.name}
                          </Link>
                        </td>
                        <td className="r num">{num(a.requests)}</td>
                        <td className="r num">{pct(a.errorRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <div className="section-head">
                <h2 className="section-title">By provider</h2>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Share</th>
                      <th className="r">
                        <span className="sr-only">Percent</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byProvider.length === 0 && (
                      <tr>
                        <td colSpan={3} className="faint">
                          No traffic in this period.
                        </td>
                      </tr>
                    )}
                    {data.byProvider.map((p) => (
                      <tr key={p.provider}>
                        <td>{p.provider}</td>
                        <td style={{ width: '45%' }}>
                          <div className="bar">
                            <span style={{ width: `${Math.max(2, p.share * 100)}%` }} />
                          </div>
                        </td>
                        <td className="r num">{pct(p.share)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  note,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function actionFor(kind: string) {
  return (
    {
      alert: 'View',
      key_failing: 'Review',
      key_resting: 'View',
      models_to_classify: 'Classify',
      api_key_expiring: 'Rotate',
    }[kind] ?? 'Open'
  );
}
