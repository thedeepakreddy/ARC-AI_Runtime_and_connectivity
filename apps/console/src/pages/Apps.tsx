import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { type ApiKey, type Application, type Policy, type Traffic, api } from '../lib/api';
import { ago, date, num, pct } from '../lib/format';
import { useData } from '../lib/hooks';
import {
  Badge,
  Confirm,
  CopyButton,
  Dialog,
  Empty,
  ErrorNote,
  Field,
  Icon,
  Loading,
  Menu,
  PageHead,
  useToast,
} from '../ui';
import { PolicyEditor, describePolicy } from './Routing';

export function AppsPage() {
  const apps = useData<{ data: Application[] }>('/applications');
  const traffic = useData<Traffic>('/console/traffic?range=24h&by=app');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const stats = new Map((traffic.data?.rows ?? []).map((r) => [r.id, r]));

  return (
    <div className="page">
      <PageHead
        title="Apps"
        sub="Each app gets its own ARC keys and, if you like, its own routing rules."
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> New app
          </button>
        }
      />
      <ErrorNote error={apps.error} />
      {!apps.data ? (
        <Loading />
      ) : apps.data.data.length === 0 ? (
        <div className="panel">
          <Empty title="No apps yet">
            Register Echo, Data Science Studio or any other app to give it an ARC key.
          </Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>App</th>
                <th className="r">Requests, 24 h</th>
                <th className="r">Errors</th>
                <th className="r hide-sm">Fallbacks</th>
                <th className="hide-sm">Added</th>
              </tr>
            </thead>
            <tbody>
              {apps.data.data.map((a) => {
                const s = stats.get(a.id);
                return (
                  <tr key={a.id} className="clickable" onClick={() => navigate(`/apps/${a.id}`)}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{a.name}</div>
                      <div className="mono faint">{a.slug}</div>
                    </td>
                    <td className="r num">
                      {s ? num(s.requests) : <span className="faint">—</span>}
                    </td>
                    <td className="r num">
                      {s ? pct(s.errorRate) : <span className="faint">—</span>}
                    </td>
                    <td className="r num hide-sm">
                      {s ? pct(s.fallbackRate) : <span className="faint">—</span>}
                    </td>
                    <td className="faint hide-sm">{date(a.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewAppDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/apps/${id}`)}
        />
      )}
    </div>
  );
}

function NewAppDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const auto = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  const s = touched ? slug : auto;
  return (
    <Dialog
      title="New app"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!name.trim() || s.length < 2}
            onClick={async () => {
              try {
                const a = await api<Application>('POST', '/applications', {
                  name: name.trim(),
                  slug: s,
                  firstParty: true,
                });
                onCreated(a.id);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Create app
          </button>
        </>
      }
    >
      <Field label="Name">
        {(id) => (
          <input
            id={id}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Aira"
          />
        )}
      </Field>
      <Field label="Short name" hint="Lowercase, used in metrics and logs.">
        {(id) => (
          <input
            id={id}
            className="input mono"
            value={s}
            onChange={(e) => {
              setTouched(true);
              setSlug(e.target.value);
            }}
          />
        )}
      </Field>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}

export function AppDetailPage() {
  const { id } = useParams();
  const apps = useData<{ data: Application[] }>('/applications');
  const keys = useData<{ data: ApiKey[] }>(`/applications/${id}/api-keys`, [id]);
  const policy = useData<{ policy: Policy | null; inheritsTenantPolicy: boolean }>(
    `/applications/${id}/routing-policy`,
    [id],
  );
  const global = useData<Policy>('/routing/policy');
  const traffic = useData<Traffic>(`/console/traffic?range=24h&by=model&app=${id}`, [id]);
  const toast = useToast();
  const [newKey, setNewKey] = useState(false);
  const [shown, setShown] = useState<ApiKey | null>(null);
  const [rotating, setRotating] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [editing, setEditing] = useState(false);
  const app = apps.data?.data.find((a) => a.id === id);

  if (apps.data && !app)
    return (
      <div className="page">
        <Empty title="App not found">
          <Link to="/apps">Back to apps</Link>
        </Empty>
      </div>
    );
  const active = (keys.data?.data ?? []).filter((k) => !k.revokedAt);
  const effective = policy.data?.policy ?? global.data ?? null;
  const rows = traffic.data?.rows ?? [];
  const total = rows.reduce((s, r) => s + r.requests, 0);
  const errors = rows.reduce((s, r) => s + r.requests * r.errorRate, 0);
  const fallbacks = rows.reduce((s, r) => s + r.requests * r.fallbackRate, 0);

  return (
    <div className="page">
      <PageHead
        crumb={<Link to="/apps">Apps</Link>}
        title={app?.name ?? ' '}
        sub={app ? <span className="mono">{app.slug}</span> : null}
      />
      <section className="section" style={{ marginTop: 0 }}>
        <div className="section-head">
          <h2 className="section-title">ARC keys</h2>
          <button className="btn sm" onClick={() => setNewKey(true)}>
            <Icon name="plus" size={13} /> New key
          </button>
        </div>
        <div className="table-wrap">
          {!keys.data ? (
            <div className="panel-pad">
              <div className="skeleton" />
            </div>
          ) : active.length === 0 ? (
            <Empty title="No active keys">
              Issue a key, then set it as ARC_API_KEY where the app runs.
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Last used</th>
                  <th className="hide-sm">Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {active.map((k) => (
                  <tr key={k.id}>
                    <td style={{ fontWeight: 500 }}>
                      {k.name}
                      {k.scopes.length < 2 && (
                        <span style={{ marginLeft: 8 }}>
                          <Badge>
                            {k.scopes.includes('inference') ? 'Requests only' : 'Models only'}
                          </Badge>
                        </span>
                      )}
                    </td>
                    <td className="mono faint">{k.displayPrefix}</td>
                    <td className="muted">{k.lastUsedAt ? ago(k.lastUsedAt) : 'Never'}</td>
                    <td className="muted hide-sm">
                      {k.expiresAt ? (
                        Date.parse(k.expiresAt) - Date.now() < 7 * 864e5 ? (
                          <Badge tone="warn">{ago(k.expiresAt)}</Badge>
                        ) : (
                          date(k.expiresAt)
                        )
                      ) : (
                        'Never'
                      )}
                    </td>
                    <td className="w">
                      <Menu
                        items={[
                          { label: 'Rotate…', onSelect: () => setRotating(k) },
                          'sep',
                          { label: 'Revoke…', onSelect: () => setRevoking(k), danger: true },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Routing rules</h2>
          <div className="head-actions">
            {!policy.data?.inheritsTenantPolicy && (
              <button
                className="btn ghost sm"
                onClick={async () => {
                  await api('DELETE', `/applications/${id}/routing-policy`);
                  toast('Now using the global rules');
                  void policy.reload();
                }}
              >
                Use global rules
              </button>
            )}
            <button className="btn sm" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
        </div>
        <div className="panel panel-pad">
          {!policy.data || !effective ? (
            <div className="skeleton" />
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>
                <Badge tone={policy.data.inheritsTenantPolicy ? '' : 'accent'}>
                  {policy.data.inheritsTenantPolicy ? 'Global rules' : 'Custom for this app'}
                </Badge>
              </div>
              {describePolicy(effective)}
            </>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Last 24 hours</h2>
          <Link to="/traffic">All traffic →</Link>
        </div>
        <div className="panel">
          <div className="stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="stat">
              <div className="stat-label">Requests</div>
              <div className="stat-value">{num(total)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Error rate</div>
              <div className="stat-value">{pct(total ? errors / total : 0)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Fallbacks</div>
              <div className="stat-value">{pct(total ? fallbacks / total : 0)}</div>
            </div>
          </div>
          {rows.filter((r) => r.label !== 'No route').length > 0 && (
            <div style={{ borderTop: '1px solid var(--line)' }}>
              {rows
                .filter((r) => r.label !== 'No route')
                .slice(0, 5)
                .map((r) => (
                  <div className="list-row" key={r.id}>
                    <span className="mono" style={{ flex: 1 }}>
                      {r.label}
                    </span>
                    <div className="bar" style={{ width: 160 }}>
                      <span style={{ width: `${(r.requests / total) * 100}%` }} />
                    </div>
                    <span className="num faint" style={{ width: 52, textAlign: 'right' }}>
                      {pct(r.requests / total)}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </section>

      {newKey && (
        <NewKeyDialog
          appId={id!}
          onClose={() => setNewKey(false)}
          onCreated={(k) => {
            setNewKey(false);
            setShown(k);
            void keys.reload();
          }}
        />
      )}
      {shown && <ShowOnceDialog apiKey={shown} onClose={() => setShown(null)} />}
      {rotating && (
        <RotateDialog
          apiKey={rotating}
          onClose={() => setRotating(null)}
          onRotated={(k) => {
            setRotating(null);
            setShown(k);
            void keys.reload();
          }}
        />
      )}
      {revoking && (
        <Confirm
          title={`Revoke “${revoking.name}”?`}
          body={`${app?.name} stops being able to use this key immediately, on every ARC instance.`}
          action="Revoke key"
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await api('DELETE', `/api-keys/${revoking.id}`);
            toast('Key revoked');
            void keys.reload();
          }}
        />
      )}
      {editing && effective && (
        <PolicyEditor
          title={`Routing rules for ${app?.name}`}
          initial={effective}
          onClose={() => setEditing(false)}
          onSave={async (p) => {
            await api('PUT', `/applications/${id}/routing-policy`, p);
            toast('Routing rules saved');
            void policy.reload();
          }}
        />
      )}
    </div>
  );
}

function NewKeyDialog({
  appId,
  onClose,
  onCreated,
}: {
  appId: string;
  onClose: () => void;
  onCreated: (k: ApiKey) => void;
}) {
  const [name, setName] = useState('production');
  const [expires, setExpires] = useState('');
  const [scope, setScope] = useState<'both' | 'inference'>('both');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title="New ARC key"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={async () => {
              try {
                onCreated(
                  await api<ApiKey>('POST', `/applications/${appId}/api-keys`, {
                    name: name.trim(),
                    scopes: scope === 'both' ? ['inference', 'models:read'] : ['inference'],
                    ...(expires ? { expiresInDays: Number(expires) } : {}),
                  }),
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Create key
          </button>
        </>
      }
    >
      <Field label="Name">
        {(id) => (
          <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </Field>
      <Field label="Expires">
        {(id) => (
          <select
            id={id}
            className="select"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          >
            <option value="">Never</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In a year</option>
          </select>
        )}
      </Field>
      <Field label="Can">
        {(id) => (
          <select
            id={id}
            className="select"
            value={scope}
            onChange={(e) => setScope(e.target.value as 'both' | 'inference')}
          >
            <option value="both">Send requests and list models</option>
            <option value="inference">Send requests only</option>
          </select>
        )}
      </Field>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}

function ShowOnceDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  const [stored, setStored] = useState(false);
  return (
    <Dialog
      title="Copy your new key"
      onClose={onClose}
      dismissable={stored}
      footer={
        <button className="btn primary" disabled={!stored} onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        This is the only time ARC shows this key. Store it where the app runs, as{' '}
        <span className="mono">ARC_API_KEY</span>.
      </p>
      <div className="secret-box">
        <span style={{ flex: 1 }}>{apiKey.key}</span>
        <CopyButton text={apiKey.key ?? ''} />
      </div>
      <label className="check" style={{ marginTop: 16 }}>
        <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />
        I’ve stored the key
      </label>
    </Dialog>
  );
}

function RotateDialog({
  apiKey,
  onClose,
  onRotated,
}: {
  apiKey: ApiKey;
  onClose: () => void;
  onRotated: (k: ApiKey) => void;
}) {
  const [overlap, setOverlap] = useState(60);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={`Rotate “${apiKey.name}”`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              try {
                onRotated(
                  await api<ApiKey>('POST', `/api-keys/${apiKey.id}/rotate`, {
                    overlapMinutes: overlap,
                  }),
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Rotate key
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        ARC issues a new key with the same name and permissions. What happens to the old one?
      </p>
      <div className="radio-list">
        {[
          [60, 'Keep it working for 1 hour', 'Time to update the app, then it stops.'],
          [1440, 'Keep it working for 24 hours', 'For apps you can’t update right away.'],
          [0, 'Revoke it now', 'For a leaked key. The app stops until it has the new key.'],
        ].map(([v, title, help]) => (
          <label key={v} className="radio-card">
            <input
              type="radio"
              name="overlap"
              checked={overlap === v}
              onChange={() => setOverlap(v as number)}
            />
            <span>
              <strong>{title}</strong>
              <span className="hint">{help}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}
