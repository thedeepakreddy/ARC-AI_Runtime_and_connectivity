import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { type Model, type Provider, type ProviderAccount, type Traffic, api } from '../lib/api';
import { GROUPS, HEALTH, JURISDICTIONS, ago, dateTime, pct } from '../lib/format';
import { useData } from '../lib/hooks';
import {
  Confirm,
  Empty,
  ErrorNote,
  Field,
  Icon,
  Loading,
  Menu,
  PageHead,
  SearchInput,
  Sheet,
  Status,
  Switch,
  useToast,
} from '../ui';

type Validation = { status: string; modelsSeen: number; error: string | null };
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
            <div style={{ marginTop: 16 }}>
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
        />
      )}
      {adding && providers.data && (
        <AddKeySheet
          providers={providers.data.data}
          onClose={() => setAdding(false)}
          onDone={() => {
            reload();
          }}
        />
      )}
    </div>
  );
}

function ToggleKey({ account, onDone }: { account: ProviderAccount; onDone: () => void }) {
  const toast = useToast();
  return (
    <Switch
      label={`${account.label} on`}
      checked={account.enabled}
      onChange={async (v) => {
        try {
          await api('PATCH', `/provider-accounts/${account.id}`, { enabled: v });
          toast(`${account.label} turned ${v ? 'on' : 'off'}`);
          onDone();
        } catch (e) {
          toast((e as Error).message, true);
        }
      }}
    />
  );
}

function useKeyActions(account: ProviderAccount, onDone: () => void) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<'delete' | null>(null);
  const check = async () => {
    try {
      const r = await api<Validation>('POST', `/provider-accounts/${account.id}/validate`);
      toast(
        r.status === 'healthy'
          ? `${account.label} is healthy · ${r.modelsSeen} models`
          : `${account.label}: ${HEALTH[r.status]?.label ?? r.status}`,
        r.status !== 'healthy',
      );
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const dialog =
    confirm === 'delete' ? (
      <Confirm
        title={`Delete “${account.label}”?`}
        body="ARC stops using this key at once and deletes its encrypted copy. This can’t be undone."
        action="Delete key"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api('DELETE', `/provider-accounts/${account.id}`);
          toast(`${account.label} deleted`);
          onDone();
        }}
      />
    ) : null;
  return { check, askDelete: () => setConfirm('delete'), dialog };
}

function KeyMenu({
  account,
  onDone,
  onOpen,
}: {
  account: ProviderAccount;
  onDone: () => void;
  onOpen: () => void;
}) {
  const { check, askDelete, dialog } = useKeyActions(account, onDone);
  return (
    <>
      <Menu
        items={[
          { label: 'Check now', onSelect: check },
          { label: 'Details', onSelect: onOpen },
          'sep',
          { label: 'Delete…', onSelect: askDelete, danger: true },
        ]}
      />
      {dialog}
    </>
  );
}

function KeySheet({
  account,
  provider,
  onClose,
  onDone,
}: {
  account: ProviderAccount;
  provider: Provider | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const models = useData<{ data: Model[] }>(
    `/models?provider=${encodeURIComponent(account.providerId)}`,
  );
  const { check, askDelete, dialog } = useKeyActions(account, () => {
    onDone();
  });
  const [label, setLabel] = useState(account.label);
  const [baseUrl, setBaseUrl] = useState(account.baseUrl ?? '');
  const [newKey, setNewKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setLabel(account.label);
    setBaseUrl(account.baseUrl ?? '');
  }, [account]);
  const h = account.enabled
    ? HEALTH[account.healthStatus]!
    : { label: 'Off', tone: 'off' as const };
  const changed = label !== account.label || (baseUrl || null) !== account.baseUrl;
  const enabledModels = (models.data?.data ?? []).filter((m) => m.enabled);

  return (
    <Sheet
      title={account.label}
      sub={`${provider?.displayName ?? account.providerId} · key ${account.secretHint ?? ''}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" onClick={askDelete} style={{ marginRight: 'auto' }}>
            Delete
          </button>
          <button className="btn" onClick={check}>
            Check now
          </button>
          <button
            className="btn primary"
            disabled={!changed || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('PATCH', `/provider-accounts/${account.id}`, {
                  label,
                  ...(provider?.defaultBaseUrl === null ? { baseUrl: baseUrl || null } : {}),
                });
                toast('Saved');
                onDone();
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </button>
        </>
      }
    >
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          <Status tone={h.tone}>{h.label}</Status>
        </dd>
        <dt>Last checked</dt>
        <dd>{account.lastValidatedAt ? dateTime(account.lastValidatedAt) : 'Never'}</dd>
        {account.lastValidationError && (
          <>
            <dt>Provider said</dt>
            <dd className="muted">{account.lastValidationError}</dd>
          </>
        )}
        <dt>Region</dt>
        <dd>{JURISDICTIONS[provider?.jurisdiction ?? ''] ?? '—'}</dd>
        <dt>Added</dt>
        <dd>{dateTime(account.createdAt)}</dd>
      </dl>
      <Field label="Label">
        {(id) => (
          <input
            id={id}
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        )}
      </Field>
      {provider?.defaultBaseUrl === null && (
        <Field label="Base URL" hint="Where this self-hosted or compatible server answers.">
          {(id) => (
            <input
              id={id}
              className="input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…/v1"
            />
          )}
        </Field>
      )}

      <div className="sub-head">Replace key</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Paste a new key for this label. The old one is deleted, and ARC checks the new one straight
        away.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input"
          type="password"
          autoComplete="off"
          placeholder="New API key"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          aria-label="New API key"
        />
        <button
          className="btn"
          disabled={!newKey.trim()}
          onClick={async () => {
            try {
              await api('PUT', `/provider-accounts/${account.id}/credential`, {
                apiKey: newKey.trim(),
              });
              setNewKey('');
              await check();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Replace
        </button>
      </div>

      <div className="sub-head">Models in use from {provider?.displayName ?? 'this provider'}</div>
      {!models.data ? (
        <div className="skeleton" />
      ) : enabledModels.length === 0 ? (
        <p className="hint">
          None turned on yet. <Link to="/models?tab=classify">Classify models →</Link>
        </p>
      ) : (
        <div className="chips">
          {enabledModels.map((m) => (
            <span key={m.id} className="badge">
              {m.modelId}
            </span>
          ))}
        </div>
      )}
      {dialog}
    </Sheet>
  );
}

function AddKeySheet({
  providers,
  onClose,
  onDone,
}: {
  providers: Provider[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Validation | null>(null);
  const [query, setQuery] = useState('');
  const provider = providers.find((p) => p.id === providerId);
  const needsUrl = provider?.defaultBaseUrl === null;

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map<string, Provider[]>();
    for (const p of providers) {
      if (q && !`${p.displayName} ${p.id}`.toLowerCase().includes(q)) continue;
      m.set(p.group, [...(m.get(p.group) ?? []), p]);
    }
    return [...m.entries()];
  }, [providers, query]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const a = await api<ProviderAccount>('POST', '/provider-accounts', {
        providerId,
        label: label.trim(),
        apiKey: key.trim(),
        ...(needsUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      setKey('');
      setResult(await api<Validation>('POST', `/provider-accounts/${a.id}/validate`));
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const ok = result.status === 'healthy';
    return (
      <Sheet
        title={ok ? 'Key added' : 'Key added, but it isn’t working'}
        onClose={onClose}
        footer={
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        }
      >
        <div className={`note ${ok ? 'ok' : 'bad'}`}>
          {ok
            ? `${provider?.displayName} accepted “${label}”. ${result.modelsSeen} models found.`
            : `${provider?.displayName} said: ${result.error ?? HEALTH[result.status]?.label ?? result.status}. The key is saved; fix it or replace it from its details.`}
        </div>
        {ok && result.modelsSeen > 0 && (
          <p style={{ marginTop: 16 }}>
            New models start as Unknown and unused until you classify them.{' '}
            <Link to="/models?tab=classify" onClick={onClose}>
              Classify models →
            </Link>
          </p>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet
      title="Add a provider key"
      sub="ARC encrypts the key and never shows it again; only its last 4 characters."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={
              !provider || !label.trim() || !key.trim() || (needsUrl && !baseUrl.trim()) || busy
            }
            onClick={save}
          >
            {busy ? 'Checking…' : 'Check and save'}
          </button>
        </>
      }
    >
      {!provider ? (
        <>
          <div className="toolbar">
            <SearchInput value={query} onChange={setQuery} placeholder="Search providers" />
          </div>
          {grouped.map(([group, list]) => (
            <div key={group}>
              <div className="sub-head">{GROUPS[group] ?? group}</div>
              <div className="panel">
                {list.map((p) => (
                  <button
                    key={p.id}
                    className="list-row"
                    style={{
                      width: '100%',
                      border: 0,
                      borderTop: '1px solid var(--line)',
                      background: 'none',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                    onClick={() => setProviderId(p.id)}
                  >
                    <span style={{ fontWeight: 500 }}>{p.displayName}</span>
                    <span className="faint" style={{ marginLeft: 'auto', fontSize: 13 }}>
                      {JURISDICTIONS[p.jurisdiction] ?? p.jurisdiction}
                    </span>
                    <Icon name="chevron" size={14} />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="list-row panel" style={{ marginBottom: 20 }}>
            <span style={{ fontWeight: 500 }}>{provider.displayName}</span>
            <span className="faint">{JURISDICTIONS[provider.jurisdiction]}</span>
            <button
              className="btn ghost sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => setProviderId('')}
            >
              Change
            </button>
          </div>
          <Field
            label="Label"
            hint="A name you’ll recognise, e.g. “Gemini 3” or “Groq — personal”."
          >
            {(id) => (
              <input
                id={id}
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={100}
              />
            )}
          </Field>
          <Field label="API key">
            {(id) => (
              <input
                id={id}
                className="input"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            )}
          </Field>
          {needsUrl && (
            <Field
              label="Base URL"
              hint="The server’s OpenAI-compatible address, e.g. http://ollama:11434/v1."
            >
              {(id) => (
                <input
                  id={id}
                  className="input"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://…/v1"
                />
              )}
            </Field>
          )}
          {error && <p className="error-text">{error}</p>}
        </>
      )}
    </Sheet>
  );
}
