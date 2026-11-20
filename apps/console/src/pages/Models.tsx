import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { type Eligibility, type Model, type Provider, type Traffic, api } from '../lib/api';
import { CAPABILITIES, ELIGIBILITY, capLabel, date, num } from '../lib/format';
import { useData } from '../lib/hooks';
import {
  Badge,
  Empty,
  ErrorNote,
  Field,
  Loading,
  PageHead,
  SearchInput,
  Sheet,
  Switch,
  Tabs,
  useToast,
} from '../ui';

type Tab = 'classify' | 'use' | 'off' | 'all';

export function ModelsPage({ onChange }: { onChange: () => void }) {
  const models = useData<{ data: Model[] }>('/models');
  const providers = useData<{ data: Provider[] }>('/providers');
  const traffic = useData<Traffic>('/console/traffic?range=24h&by=model');
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [cap, setCap] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const toast = useToast();

  const all = models.data?.data ?? [];
  const counts = {
    classify: all.filter((m) => m.eligibility === 'UNKNOWN').length,
    use: all.filter((m) => m.enabled).length,
    off: all.filter((m) => !m.enabled && m.eligibility !== 'UNKNOWN').length,
    all: all.length,
  };
  const tab = (params.get('tab') as Tab | null) ?? (counts.classify ? 'classify' : 'use');
  const setTab = (t: Tab) => {
    setSelected(new Set());
    setParams({ tab: t });
  };
  const names = useMemo(
    () => new Map((providers.data?.data ?? []).map((p) => [p.id, p.displayName])),
    [providers.data],
  );
  const requests = useMemo(
    () => new Map((traffic.data?.rows ?? []).map((r) => [r.id, r.requests])),
    [traffic.data],
  );
  const openId = params.get('model');
  const open = all.find((m) => m.id === openId) ?? null;

  const rows = all.filter((m) => {
    if (tab === 'classify' && m.eligibility !== 'UNKNOWN') return false;
    if (tab === 'use' && !m.enabled) return false;
    if (tab === 'off' && (m.enabled || m.eligibility === 'UNKNOWN')) return false;
    if (provider && m.providerId !== provider) return false;
    if (cap && !m.capabilities.includes(cap)) return false;
    const q = query.trim().toLowerCase();
    return (
      !q ||
      `${m.modelId} ${m.displayName ?? ''} ${names.get(m.providerId) ?? ''}`
        .toLowerCase()
        .includes(q)
    );
  });
  const usedProviders = [...new Set(all.map((m) => m.providerId))].sort();
  const reload = () => {
    void models.reload();
    onChange();
  };
  const allChecked = rows.length > 0 && rows.every((m) => selected.has(m.id));

  return (
    <div className="page">
      <PageHead
        title="Models"
        sub="ARC only uses models you’ve classified with evidence and turned on. Unknown is never treated as free."
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'classify', label: 'To classify', count: counts.classify },
          { id: 'use', label: 'In use', count: counts.use },
          { id: 'off', label: 'Off', count: counts.off },
          { id: 'all', label: 'All', count: counts.all },
        ]}
      />
      <div className="toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Search models" />
        <select
          className="select"
          style={{ width: 'auto' }}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          aria-label="Provider"
        >
          <option value="">All providers</option>
          {usedProviders.map((p) => (
            <option key={p} value={p}>
              {names.get(p) ?? p}
            </option>
          ))}
        </select>
        {tab !== 'classify' && (
          <select
            className="select"
            style={{ width: 'auto' }}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            aria-label="Can do"
          >
            <option value="">Can do anything</option>
            {CAPABILITIES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        )}
      </div>
      <ErrorNote error={models.error} />
      {!models.data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="panel">
          {tab === 'classify' ? (
            <Empty title="Nothing to classify">
              New models appear here when ARC discovers them through a provider key.
            </Empty>
          ) : (
            <Empty title="No models here" />
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="w">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allChecked}
                    onChange={() =>
                      setSelected(allChecked ? new Set() : new Set(rows.map((m) => m.id)))
                    }
                  />
                </th>
                <th>Model</th>
                <th>Provider</th>
                <th>Status</th>
                <th className="hide-sm">Can do</th>
                <th className="r hide-sm">Requests, 24 h</th>
                <th className="r">On</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const e = ELIGIBILITY[m.eligibility]!;
                const name = `${m.providerId}/${m.modelId}`;
                return (
                  <tr
                    key={m.id}
                    className={`clickable ${m.id === openId ? 'selected' : ''}`}
                    onClick={() => setParams({ tab, model: m.id })}
                  >
                    <td className="w" onClick={(ev) => ev.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${m.modelId}`}
                        checked={selected.has(m.id)}
                        onChange={() =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (n.has(m.id)) n.delete(m.id);
                            else n.add(m.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{m.displayName ?? m.modelId}</div>
                      {m.displayName && <div className="mono faint">{m.modelId}</div>}
                    </td>
                    <td className="muted">{names.get(m.providerId) ?? m.providerId}</td>
                    <td>
                      <Badge tone={e.tone}>{e.label}</Badge>
                    </td>
                    <td className="hide-sm">
                      <span className="muted" style={{ fontSize: 13 }}>
                        {m.capabilities.length ? m.capabilities.map(capLabel).join(', ') : '—'}
                      </span>
                    </td>
                    <td className="r num hide-sm">
                      {requests.has(name) ? (
                        num(requests.get(name)!)
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="r w">
                      <Switch
                        label={`${m.modelId} on`}
                        checked={m.enabled}
                        disabled={m.eligibility === 'UNKNOWN'}
                        title={
                          m.eligibility === 'UNKNOWN'
                            ? 'Classify this model before turning it on'
                            : undefined
                        }
                        onChange={async (v) => {
                          try {
                            await api('PATCH', `/models/${m.id}`, { enabled: v });
                            reload();
                          } catch (err) {
                            toast((err as Error).message, true);
                          }
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {selected.size > 0 && (
        <div className="bulkbar">
          <span className="num">{selected.size} selected</span>
          <button className="btn ghost sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button
            className="btn primary sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => setBulk(true)}
          >
            Classify…
          </button>
        </div>
      )}
      {open && (
        <ClassifySheet
          models={[open]}
          providerName={names.get(open.providerId) ?? open.providerId}
          onClose={() => setParams({ tab })}
          onDone={reload}
        />
      )}
      {bulk && (
        <ClassifySheet
          models={all.filter((m) => selected.has(m.id))}
          providerName=""
          onClose={() => setBulk(false)}
          onDone={() => {
            setSelected(new Set());
            reload();
          }}
        />
      )}
    </div>
  );
}

/** Classify one model, or the same classification for several at once. */
function ClassifySheet({
  models,
  providerName,
  onClose,
  onDone,
}: {
  models: Model[];
  providerName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const one = models.length === 1 ? models[0]! : null;
  const toast = useToast();
  const [eligibility, setEligibility] = useState<Eligibility>(one?.eligibility ?? 'VERIFIED_FREE');
  const [evidence, setEvidence] = useState(one?.eligibilityEvidenceUrl ?? '');
  const [caps, setCaps] = useState<Set<string>>(
    new Set(one?.capabilities ?? ['text', 'streaming']),
  );
  const [terms, setTerms] = useState(one?.termsNote ?? '');
  const [enabled, setEnabled] = useState(one ? one.enabled || one.eligibility === 'UNKNOWN' : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (eligibility === 'UNKNOWN') setEnabled(false);
  }, [eligibility]);

  const needsEvidence = eligibility !== 'UNKNOWN';
  const evidenceChanged =
    !one || evidence !== (one.eligibilityEvidenceUrl ?? '') || eligibility !== one.eligibility;
  const valid = !needsEvidence || /^https?:\/\/\S+$/.test(evidence.trim());

  async function save() {
    setBusy(true);
    setError(null);
    try {
      for (const m of models) {
        await api('PATCH', `/models/${m.id}`, {
          eligibility,
          ...(needsEvidence && evidenceChanged ? { eligibilityEvidenceUrl: evidence.trim() } : {}),
          capabilities: [...caps],
          termsNote: eligibility === 'RESTRICTED_FREE' ? terms.trim() || null : null,
          enabled: eligibility === 'UNKNOWN' ? false : enabled,
        });
      }
      toast(models.length === 1 ? 'Model saved' : `${models.length} models classified`);
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={one ? (one.displayName ?? one.modelId) : `Classify ${models.length} models`}
      sub={
        one
          ? `${providerName} · ${one.modelId}`
          : models
              .map((m) => m.modelId)
              .slice(0, 4)
              .join(', ') + (models.length > 4 ? ` and ${models.length - 4} more` : '')
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="sub-head" style={{ marginTop: 0 }}>
        Status
      </div>
      <div className="radio-list">
        {(['VERIFIED_FREE', 'RESTRICTED_FREE', 'PAID', 'UNKNOWN'] as Eligibility[]).map((e) => (
          <label key={e} className="radio-card">
            <input
              type="radio"
              name="eligibility"
              checked={eligibility === e}
              onChange={() => setEligibility(e)}
            />
            <span>
              <strong>{ELIGIBILITY[e]!.label}</strong>
              <span className="hint">{ELIGIBILITY[e]!.help}</span>
            </span>
          </label>
        ))}
      </div>

      {needsEvidence && (
        <div style={{ marginTop: 18 }}>
          <Field
            label="Evidence"
            hint={
              one?.eligibilityCheckedAt && !evidenceChanged
                ? `Checked ${date(one.eligibilityCheckedAt)}. Change the link to record a new check.`
                : 'A link to the provider’s pricing or terms page. ARC records today as the date checked.'
            }
          >
            {(id) => (
              <input
                id={id}
                className="input"
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                placeholder="https://…"
              />
            )}
          </Field>
        </div>
      )}
      {eligibility === 'RESTRICTED_FREE' && (
        <Field
          label="Terms note"
          hint="The provider’s limits, kept next to the model. E.g. “50 requests/day, no commercial use”."
        >
          {(id) => (
            <textarea
              id={id}
              className="textarea"
              value={terms}
              maxLength={500}
              onChange={(e) => setTerms(e.target.value)}
            />
          )}
        </Field>
      )}

      <div className="sub-head">What it can do</div>
      <div className="grid-2">
        {CAPABILITIES.map(([k, l]) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              checked={caps.has(k)}
              onChange={() =>
                setCaps((c) => {
                  const n = new Set(c);
                  if (n.has(k)) n.delete(k);
                  else n.add(k);
                  return n;
                })
              }
            />
            {l}
          </label>
        ))}
      </div>
      <p className="hint">
        ARC only sends a request to models that can do everything it needs, e.g. images or tools.
      </p>

      <div className="list-row panel" style={{ marginTop: 18 }}>
        <div>
          <div style={{ fontWeight: 500 }}>
            Use {models.length > 1 ? 'these models' : 'this model'}
          </div>
          <div className="hint">
            {eligibility === 'UNKNOWN'
              ? 'Unknown models can never be turned on.'
              : 'ARC may route requests to it.'}
          </div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <Switch
            label="Use"
            checked={enabled}
            disabled={eligibility === 'UNKNOWN'}
            onChange={setEnabled}
          />
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
    </Sheet>
  );
}
