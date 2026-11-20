import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { type ApiKey, type Application, type Policy, type Traffic, api } from '@arc/ui/api';
import { ago, date, num, pct } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
import { Badge, Confirm, Empty, ErrorNote, Icon, Loading, Menu, PageHead, useToast } from '@arc/ui';
import { NewAppDialog, NewKeyDialog, RotateDialog, ShowOnceDialog } from '@arc/ui/keys';
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
                      <Link
                        className="row-link"
                        to={`/apps/${a.id}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {a.name}
                      </Link>
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
          firstParty
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/apps/${id}`)}
        />
      )}
    </div>
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
      <section className="section mt-0">
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
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {active.map((k) => (
                  <tr key={k.id}>
                    <td className="fw-500">
                      {k.name}
                      {k.scopes.length < 2 && (
                        <span className="ml-8">
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
              <div className="mb-8">
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
            <div className="divider-top">
              {rows
                .filter((r) => r.label !== 'No route')
                .slice(0, 5)
                .map((r) => (
                  <div className="list-row" key={r.id}>
                    <span className="mono grow">{r.label}</span>
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
