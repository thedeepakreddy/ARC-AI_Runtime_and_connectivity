import { useState } from 'react';
import type { Traffic } from '../lib/api';
import { dateTime, ms, num, pct, time } from '../lib/format';
import { useData, usePolling } from '../lib/hooks';
import { Empty, ErrorNote, Loading, PageHead, Segmented, TrafficChart } from '../ui';

type Range = '24h' | '7d' | '30d';
type By = 'app' | 'provider' | 'model' | 'key';

export function TrafficPage() {
  const [range, setRange] = useState<Range>('24h');
  const [by, setBy] = useState<By>('app');
  const { data, error, reload } = useData<Traffic>(`/console/traffic?range=${range}&by=${by}`, [
    range,
    by,
  ]);
  usePolling(reload, 60_000);
  const total = data?.rows.reduce((s, r) => s + r.requests, 0) ?? 0;
  const label = range === '24h' ? time : (t: string) => dateTime(t).split(',')[0]!;
  const withOverhead = data?.series.filter((p) => p.overheadMsAvg !== null) ?? [];
  const overhead = withOverhead.length
    ? withOverhead.reduce((s, p) => s + p.overheadMsAvg! * p.requests, 0) /
      Math.max(
        1,
        withOverhead.reduce((s, p) => s + p.requests, 0),
      )
    : null;

  return (
    <div className="page">
      <PageHead
        title="Traffic"
        sub="Requests through ARC. ARC overhead is the time ARC spends before the provider starts; the rest is the provider."
        actions={
          <Segmented<Range>
            label="Time range"
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
      <ErrorNote error={error} />
      {!data ? (
        <Loading rows={6} />
      ) : (
        <>
          <div className="panel">
            <div className="stats">
              <div className="stat">
                <div className="stat-label">Requests</div>
                <div className="stat-value">{num(total)}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Errors</div>
                <div className="stat-value">
                  {num(data.series.reduce((s, p) => s + p.errors, 0))}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Fallbacks</div>
                <div className="stat-value">
                  {num(data.series.reduce((s, p) => s + p.fallbacks, 0))}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">ARC overhead</div>
                <div className="stat-value">{ms(overhead)}</div>
                <div className="stat-note">Average</div>
              </div>
            </div>
            <div className="chart" style={{ borderTop: '1px solid var(--line)' }}>
              <TrafficChart points={data.series} label={label} height={200} />
            </div>
          </div>
          <div className="toolbar" style={{ marginTop: 32 }}>
            <h2 className="section-title">Breakdown</h2>
            <span className="spacer" />
            <Segmented<By>
              label="Group by"
              value={by}
              onChange={setBy}
              options={[
                ['app', 'App'],
                ['provider', 'Provider'],
                ['model', 'Model'],
                ['key', 'Key'],
              ]}
            />
          </div>
          <div className="table-wrap">
            {data.rows.length === 0 ? (
              <Empty title="No traffic in this period" />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{{ app: 'App', provider: 'Provider', model: 'Model', key: 'Key' }[by]}</th>
                    <th className="r">Requests</th>
                    <th className="hide-sm">Share</th>
                    <th className="r">Errors</th>
                    <th className="r hide-sm">Fallbacks</th>
                    <th className="r hide-sm">ARC overhead</th>
                    <th className="r hide-sm">Total time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className={by === 'model' ? 'mono' : ''}>{r.label}</td>
                      <td className="r num">{num(r.requests)}</td>
                      <td className="hide-sm" style={{ width: '18%' }}>
                        <div className="bar">
                          <span style={{ width: `${total ? (r.requests / total) * 100 : 0}%` }} />
                        </div>
                      </td>
                      <td className="r num">{pct(r.errorRate)}</td>
                      <td className="r num hide-sm">{pct(r.fallbackRate)}</td>
                      <td className="r num hide-sm">{ms(r.overheadMsAvg)}</td>
                      <td className="r num hide-sm">{ms(r.durationMsAvg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="hint">Times are averages. Live percentiles (p95, p99) are in Prometheus.</p>
        </>
      )}
    </div>
  );
}
