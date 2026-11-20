import { type ReactNode, useState } from 'react';
import {
  type Application,
  type Explain,
  type Policy,
  type ProviderAccount,
  api,
} from '@arc/ui/api';
import { CAPABILITIES, ELIGIBILITY, HEALTH, JURISDICTIONS, ms } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
import { Badge, ErrorNote, PageHead, Sheet, Status, Switch, useToast } from '@arc/ui';

const ALL_REGIONS = Object.keys(JURISDICTIONS);

export function describePolicy(p: Policy): ReactNode {
  const regions = p.allowedJurisdictions;
  const excluded = regions ? ALL_REGIONS.filter((r) => !regions.includes(r)) : [];
  return (
    <dl className="kv" style={{ margin: 0 }}>
      <dt>Regions</dt>
      <dd>
        {regions === null ? 'All regions' : regions.map((r) => JURISDICTIONS[r]).join(' · ')}
        {excluded.length > 0 && (
          <span className="faint"> — not {excluded.map((r) => JURISDICTIONS[r]).join(', ')}</span>
        )}
      </dd>
      <dt>Paid models</dt>
      <dd>
        {p.allowPaidOwnerKeys ? (
          <Badge tone="warn">Allowed on your keys</Badge>
        ) : (
          'Never on your keys'
        )}
      </dd>
    </dl>
  );
}

export function PolicyEditor({
  title,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  initial: Policy;
  onClose: () => void;
  onSave: (p: Omit<Policy, 'applicationId'>) => Promise<void>;
}) {
  const [regions, setRegions] = useState<Set<string>>(
    new Set(initial.allowedJurisdictions ?? ALL_REGIONS),
  );
  const [paid, setPaid] = useState(initial.allowPaidOwnerKeys);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={regions.size === 0 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave({
                  allowedJurisdictions: regions.size === ALL_REGIONS.length ? null : [...regions],
                  allowPaidOwnerKeys: paid,
                });
                onClose();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Save rules
          </button>
        </>
      }
    >
      <div className="sub-head" style={{ marginTop: 0 }}>
        Where requests may go
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        By the provider’s jurisdiction. ARC never sends a request to a region that isn’t ticked,
        even as a fallback.
      </p>
      <div className="grid-2">
        {ALL_REGIONS.map((r) => (
          <label key={r} className="check">
            <input
              type="checkbox"
              checked={regions.has(r)}
              onChange={() =>
                setRegions((s) => {
                  const n = new Set(s);
                  if (n.has(r)) n.delete(r);
                  else n.add(r);
                  return n;
                })
              }
            />
            {JURISDICTIONS[r]}
          </label>
        ))}
      </div>
      <div className="sub-head">Paid models</div>
      <div className="list-row panel">
        <div>
          <div style={{ fontWeight: 500 }}>Allow paid models on your keys</div>
          <div className="hint">
            Off: ARC uses only free models. On: paid models may be used, and providers may charge
            you.
          </div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <Switch label="Allow paid models" checked={paid} onChange={setPaid} />
        </div>
      </div>
      {paid && (
        <div className="note warn" style={{ marginTop: 12 }}>
          Requests may now cost money. Check each paid model’s pricing before turning it on.
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </Sheet>
  );
}

const VERDICTS: Record<string, string> = {
  selected: 'Chosen',
  eligible: 'Fallback',
  rejected_model: 'Different model',
  rejected_eligibility: 'Not free or not classified',
  rejected_jurisdiction: 'Region not allowed',
  rejected_health: 'Key unhealthy',
  rejected_cooldown: 'Key resting',
  rejected_capability: 'Can’t do what’s needed',
};

export function RoutingPage() {
  const policy = useData<Policy>('/routing/policy');
  const apps = useData<{ data: Application[] }>('/applications');
  const accounts = useData<{ data: ProviderAccount[] }>('/provider-accounts');
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState('auto');
  const [appId, setAppId] = useState('');
  const [caps, setCaps] = useState<Set<string>>(new Set(['text']));
  const [result, setResult] = useState<Explain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyName = new Map((accounts.data?.data ?? []).map((a) => [a.id, a.label]));

  async function explain() {
    setError(null);
    try {
      setResult(
        await api<Explain>('POST', '/routing/explain', {
          model: model.trim() || 'auto',
          ...(appId ? { applicationId: appId } : {}),
          capabilities: [...caps],
        }),
      );
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    }
  }

  return (
    <div className="page">
      <PageHead
        title="Routing"
        sub="How ARC chooses a model and key: your rules first, then health, free before paid, then measured speed."
      />
      <section>
        <div className="section-head">
          <h2 className="section-title">Global rules</h2>
          <button className="btn sm" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
        <div className="panel panel-pad">
          {!policy.data ? <div className="skeleton" /> : describePolicy(policy.data)}
        </div>
        <p className="hint">
          Apps follow these unless they have their own rules (Apps → an app → Routing rules).
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">What would ARC pick?</h2>
        </div>
        <div className="panel panel-pad">
          <div
            style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}
          >
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="ex-model">Model</label>
              <input
                id="ex-model"
                className="input mono"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="auto, arc/fast or provider/model"
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="ex-app">As app</label>
              <select
                id="ex-app"
                className="select"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
              >
                <option value="">Global rules</option>
                {(apps.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="label" style={{ margin: '16px 0 8px' }}>
            The request needs
          </div>
          <div className="chips">
            {CAPABILITIES.map(([k, l]) => (
              <button
                key={k}
                type="button"
                className={`badge ${caps.has(k) ? 'accent' : ''}`}
                style={{ cursor: 'pointer', border: 0 }}
                aria-pressed={caps.has(k)}
                onClick={() =>
                  setCaps((s) => {
                    const n = new Set(s);
                    if (n.has(k)) n.delete(k);
                    else n.add(k);
                    return n;
                  })
                }
              >
                {l}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 18 }}>
            <button className="btn primary" onClick={explain}>
              Explain route
            </button>
          </div>
        </div>
        {error && (
          <div className="note bad" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
        {result && (
          <div style={{ marginTop: 16 }}>
            {result.routable && result.selected ? (
              <div className="note ok" style={{ marginBottom: 12 }}>
                ARC would use <span className="mono">{result.selected.model}</span> on key “
                {keyName.get(result.selected.accountId) ?? result.selected.accountId.slice(0, 8)}”
                {result.fallbackOrder && result.fallbackOrder.length > 1 && (
                  <>
                    , with {result.fallbackOrder.length - 1} fallback
                    {result.fallbackOrder.length > 2 ? 's' : ''} ready
                  </>
                )}
                .
              </div>
            ) : (
              <div className="note bad" style={{ marginBottom: 12 }}>
                No route: {result.reason?.replace(/_/g, ' ')}. Nothing would be sent; the app gets a
                clear error.
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Key</th>
                    <th>Status</th>
                    <th className="hide-sm">Pricing</th>
                    <th className="hide-sm">Health</th>
                    <th className="r hide-sm">Expected</th>
                  </tr>
                </thead>
                <tbody>
                  {result.candidates.length === 0 && (
                    <tr>
                      <td colSpan={6} className="faint">
                        No candidates: no enabled model matches.
                      </td>
                    </tr>
                  )}
                  {result.candidates.map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{c.model}</td>
                      <td className="muted">{keyName.get(c.accountId) ?? '—'}</td>
                      <td>
                        <Badge
                          tone={
                            c.verdict === 'selected'
                              ? 'ok'
                              : c.verdict === 'eligible'
                                ? 'accent'
                                : ''
                          }
                        >
                          {VERDICTS[c.verdict] ?? c.verdict}
                        </Badge>
                        {c.detail && <div className="hint">{c.detail}</div>}
                      </td>
                      <td className="hide-sm">{ELIGIBILITY[c.eligibility]?.label}</td>
                      <td className="hide-sm">
                        <Status tone={HEALTH[c.health]?.tone ?? ''}>
                          {HEALTH[c.health]?.label ?? c.health}
                        </Status>
                      </td>
                      <td className="r num hide-sm">{ms(c.expectedMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
      <ErrorNote error={policy.error} />
      {editing && policy.data && (
        <PolicyEditor
          title="Global routing rules"
          initial={policy.data}
          onClose={() => setEditing(false)}
          onSave={async (p) => {
            await api('PUT', '/routing/policy', p);
            toast('Routing rules saved');
            void policy.reload();
          }}
        />
      )}
    </div>
  );
}
