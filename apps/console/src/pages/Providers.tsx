import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Provider, ProviderAccount, Traffic } from '@arc/ui/api';
import { HEALTH, JURISDICTIONS, ago, pct } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
import { Empty, ErrorNote, Icon, Loading, PageHead, SearchInput, Status } from '@arc/ui';
import { AddKeySheet, KeyMenu, KeySheet, ToggleKey } from '@arc/ui/keys';

type StatusFilter = 'all' | 'problems' | 'off';

export function ProvidersPage({ onChange }: { onChange: () => void }) {
  const providers = useData<{ data: Provider[] }>('/providers');
  const accounts = useData<{ data: ProviderAccount[] }>('/provider-accounts');
  const traffic = useData<Traffic>('/console/traffic?range=24h&by=key');
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const openId = params.get('key');

  const byId = useMemo(
    () => new Map((providers.data?.data ?? []).map((p) => [p.id, p])),
    [providers.data],
  );
  const share = useMemo(() => {
    // Each key's share of its provider's traffic over 24 hours.
    const rows = traffic.data?.rows ?? [];
    const byAccount = new Map(rows.map((r) => [r.id, r.requests]));
    const totals = new Map<string, number>();
    for (const a of accounts.data?.data ?? [])
      totals.set(a.providerId, (totals.get(a.providerId) ?? 0) + (byAccount.get(a.id) ?? 0));
    return (a: ProviderAccount) => {
      const total = totals.get(a.providerId) ?? 0;
      return total ? (byAccount.get(a.id) ?? 0) / total : null;
    };
  }, [traffic.data, accounts.data]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (accounts.data?.data ?? []).filter((a) => {
      if (
        q &&
        !`${a.label} ${byId.get(a.providerId)?.displayName ?? a.providerId} ${a.secretHint ?? ''}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      if (status === 'problems')
        return (
          a.enabled &&
          ['invalid_credentials', 'unreachable', 'unsupported', 'rate_limited'].includes(
            a.healthStatus,
          )
        );
      if (status === 'off') return !a.enabled;
      return true;
    });
    const m = new Map<string, ProviderAccount[]>();
    for (const a of list) m.set(a.providerId, [...(m.get(a.providerId) ?? []), a]);
    return [...m.entries()].sort((x, y) =>
      (byId.get(x[0])?.displayName ?? x[0]).localeCompare(byId.get(y[0])?.displayName ?? y[0]),
    );
  }, [accounts.data, byId, filter, status]);

  const reload = () => {
    void accounts.reload();
    onChange();
  };
  const open = accounts.data?.data.find((a) => a.id === openId) ?? null;

  return (
    <div className="page">
      <PageHead
        title="Providers & keys"
        sub="Every provider key ARC can use. Add as many keys per provider as you have; ARC spreads the load and steps around keys that fail."
        actions={
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> Add key
          </button>
        }
      />
      <div className="toolbar">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter keys" />
        <select
          className="select"
          style={{ width: 'auto' }}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          aria-label="Status"
        >
          <option value="all">All keys</option>
          <option value="problems">Needing attention</option>
          <option value="off">Turned off</option>
        </select>
      </div>
      <ErrorNote error={accounts.error ?? providers.error} />
      {!accounts.data || !providers.data ? (
        <Loading />
      ) : accounts.data.data.length === 0 ? (
        <div className="panel">
          <Empty title="No provider keys yet">
            Add a key from Gemini, Groq, OpenRouter or any other provider to start routing.
            <div className="mt-16">
              <button className="btn primary" onClick={() => setAdding(true)}>
                Add your first key
              </button>
            </div>
          </Empty>
        </div>
      ) : groups.length === 0 ? (
        <div className="panel">
          <Empty title="No keys match" />
        </div>
      ) : (
        groups.map(([providerId, keys]) => {
          const p = byId.get(providerId);
          const healthy = keys.filter((k) => k.enabled && k.healthStatus === 'healthy').length;
          const isOpen = !collapsed.has(providerId);
          return (
            <section key={providerId} className="group table-wrap">
              <button
                className="group-head"
                aria-expanded={isOpen}
                onClick={() =>
                  setCollapsed((c) => {
                    const n = new Set(c);
                    if (n.has(providerId)) n.delete(providerId);
                    else n.add(providerId);
                    return n;
                  })
                }
              >
                <span className={`chev ${isOpen ? 'open' : ''}`}>
                  <Icon name="chevron" size={14} />
                </span>
                <span className="name">{p?.displayName ?? providerId}</span>
                <span className="faint">
                  {JURISDICTIONS[p?.jurisdiction ?? ''] ?? p?.jurisdiction}
                </span>
                <span className="meta num">
                  {keys.length} {keys.length === 1 ? 'key' : 'keys'} · {healthy} healthy
                </span>
              </button>
              {isOpen && (
                <table className="fixed">
                  <colgroup>
                    <col style={{ width: '24%' }} />
                    <col style={{ width: '17%' }} />
                    <col style={{ width: '17%' }} />
                    <col className="hide-sm" style={{ width: '18%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '7%' }} />
                    <col style={{ width: '5%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Label</th>
                      <th className="hide-sm">Key</th>
                      <th>Status</th>
                      <th className="hide-sm">Checked</th>
                      <th className="r hide-sm">Share, 24 h</th>
                      <th className="r">On</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((a) => {
                      const h = a.enabled
                        ? HEALTH[a.healthStatus]!
                        : { label: 'Off', tone: 'off' as const };
                      const s = share(a);
                      return (
                        <tr
                          key={a.id}
                          className={`clickable ${a.id === openId ? 'selected' : ''}`}
                          onClick={() => setParams({ key: a.id })}
                        >
                          <td>
                            <button
                              type="button"
                              className="row-link"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setParams({ key: a.id });
                              }}
                            >
                              {a.label}
                            </button>
                          </td>
                          <td className="mono faint hide-sm">{a.secretHint ?? '—'}</td>
                          <td>
                            <Status tone={h.tone}>{h.label}</Status>
                          </td>
                          <td className="faint hide-sm">{ago(a.lastValidatedAt)}</td>
                          <td className="r num hide-sm">
                            {s === null ? <span className="faint">—</span> : pct(s)}
                          </td>
                          <td className="r w">
                            <ToggleKey account={a} onDone={reload} />
                          </td>
                          <td className="w">
                            <KeyMenu
                              account={a}
                              onDone={reload}
                              onOpen={() => setParams({ key: a.id })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          );
        })
      )}
      {open && (
        <KeySheet
          account={open}
          provider={byId.get(open.providerId)}
          onClose={() => setParams({})}
          onDone={reload}
          noModels={
            <>
              None turned on yet. <Link to="/models?tab=classify">Classify models →</Link>
            </>
          }
        />
      )}
      {adding && providers.data && (
        <AddKeySheet
          providers={providers.data.data}
          onClose={() => setAdding(false)}
          onDone={() => {
            reload();
          }}
          afterAdd={(close) => (
            <>
              New models start as Unknown and unused until you classify them.{' '}
              <Link to="/models?tab=classify" onClick={close}>
                Classify models →
              </Link>
            </>
          )}
        />
      )}
    </div>
  );
}
