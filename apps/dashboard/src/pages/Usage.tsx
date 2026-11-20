import { Empty, ErrorNote, Loading, PageHead, Segmented, TrafficChart } from '@arc/ui';
import type { Traffic } from '@arc/ui/api';
import { compact, dateTime, ms, num, pct, time } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';

export type Range = '24h' | '7d' | '30d';
type By = 'app' | 'provider' | 'model' | 'key';

const RANGES: [Range, string][] = [
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
];

const axisLabel = (range: Range) =>
  range === '24h' ? time : (t: string) => dateTime(t).split(',')[0]!;

/** Requests, error rate, fallbacks and ARC overhead over a range, with the traffic chart. */
export function UsagePanel({
  traffic,
  range,
  detailsLink,
}: {
  traffic: Traffic | null;
  range: Range;
  detailsLink?: boolean;
}) {
  if (!traffic) return <Loading rows={3} />;
  const s = traffic.series;
  const requests = s.reduce((a, p) => a + p.requests, 0);
  const errors = s.reduce((a, p) => a + p.errors, 0);
  const fallbacks = s.reduce((a, p) => a + p.fallbacks, 0);
  const withOverhead = s.filter((p) => p.overheadMsAvg !== null);
  const overhead = withOverhead.length
    ? withOverhead.reduce((a, p) => a + p.overheadMsAvg! * p.requests, 0) /
      Math.max(
        1,
        withOverhead.reduce((a, p) => a + p.requests, 0),
      )
    : null;
  if (requests === 0) {
    return (
      <div className="panel">
        <Empty title="No requests yet">
          Once an app sends requests with its ARC key, they show up here within a minute.
        </Empty>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="stats">
        <Stat
          label="Requests"
          value={compact(requests)}
          note={requests >= 10_000 ? `${num(requests)} total` : 'In this period'}
        />
        <Stat
          label="Error rate"
          value={pct(requests ? errors / requests : 0)}
          note="Returned an error to the app"
        />
        <Stat
          label="Fallbacks"
          value={pct(requests ? fallbacks / requests : 0)}
          note="Served by a second key or model"
        />
        <Stat
          label="ARC overhead"
          value={overhead === null ? '—' : ms(overhead).replace(' ms', '')}
          unit={overhead === null || overhead >= 1000 ? undefined : 'ms'}
          note="Average, before the provider"
        />
      </div>
      <div className="chart divider-top">
        <TrafficChart
          points={s}
          label={axisLabel(range)}
          action={detailsLink ? <Link to="/usage">Usage details →</Link> : undefined}
        />
      </div>
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
  unit?: string | undefined;
  note: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="stat-note">{note}</div>
    </div>
  );
}

export function UsagePage() {
  const [range, setRange] = useState<Range>('24h');
  const [by, setBy] = useState<By>('app');
  const totals = useData<Traffic>(`/usage?range=${range}&by=app`, [range]);
  const breakdown = useData<Traffic>(`/usage?range=${range}&by=${by}`, [range, by]);
  const rows = breakdown.data?.rows ?? [];
  const total = rows.reduce((a, r) => a + r.requests, 0);

  return (
    <div className="page">
      <PageHead
        title="Usage"
        sub="Every request your apps send through ARC. Metadata only: ARC never stores prompts or responses."
        actions={
          <Segmented<Range> label="Period" value={range} onChange={setRange} options={RANGES} />
        }
      />
      <ErrorNote error={totals.error ?? breakdown.error} />
      <UsagePanel traffic={totals.data} range={range} />

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Breakdown</h2>
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
        {!breakdown.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <div className="panel">
            <Empty title="Nothing in this period" />
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>
                    {{ app: 'App', provider: 'Provider', model: 'Model', key: 'Provider key' }[by]}
                  </th>
                  <th className="r">Requests</th>
                  <th className="hide-sm">Share</th>
                  <th className="r">Errors</th>
                  <th className="r hide-sm">Fallbacks</th>
                  <th className="r hide-sm">Total time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id || r.label}>
                    <td className={by === 'model' ? 'mono' : undefined} style={{ fontWeight: 500 }}>
                      {r.label}
                    </td>
                    <td className="r num">{num(r.requests)}</td>
                    <td className="hide-sm" style={{ width: '22%' }}>
                      <div className="bar" aria-hidden="true">
                        <span style={{ width: `${total ? (r.requests / total) * 100 : 0}%` }} />
                      </div>
                    </td>
                    <td className="r num">{pct(r.errorRate)}</td>
                    <td className="r num hide-sm">{pct(r.fallbackRate)}</td>
                    <td className="r num hide-sm">{ms(r.durationMsAvg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint footnote">
          Times are averages per request, including the provider. “No route” means no key or model
          could serve the request.
        </p>
      </section>
    </div>
  );
}
