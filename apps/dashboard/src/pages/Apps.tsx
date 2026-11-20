import {
  Badge,
  Confirm,
  CopyButton,
  Empty,
  ErrorNote,
  Icon,
  Loading,
  Menu,
  PageHead,
  useToast,
} from '@arc/ui';
import { type ApiKey, type Application, type Traffic, api } from '@arc/ui/api';
import { ago, date, num, pct } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
import { NewAppDialog, NewKeyDialog, RotateDialog, ShowOnceDialog } from '@arc/ui/keys';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiBaseUrl, useOrg } from '../org';
import { UsagePanel } from './Usage';

export function AppsPage() {
  const org = useOrg();
  const apps = useData<{ data: Application[] }>('/applications');
  const usage = useData<Traffic>('/usage?range=24h&by=app');
  const [params, setParams] = useSearchParams();
  const creating = params.get('new') === '1';
  const navigate = useNavigate();
  const stats = new Map((usage.data?.rows ?? []).map((r) => [r.id, r]));
  const create = () => setParams({ new: '1' });

  return (
    <div className="page">
      <PageHead
        title="Apps"
        sub="Each app has its own ARC keys and its own usage. Apps send requests to ARC instead of to a provider."
        actions={
          org.canManage && (
            <button className="btn primary" onClick={create}>
              <Icon name="plus" size={14} /> New app
            </button>
          )
        }
      />
      <ErrorNote error={apps.error} />
      {!apps.data ? (
        <Loading />
      ) : apps.data.data.length === 0 ? (
        <div className="panel">
          <Empty title="No apps yet">
            {org.canManage ? (
              <>
                Create one for each product or service that calls AI models.{' '}
                <button className="link-button" onClick={create}>
                  Create an app
                </button>
              </>
            ) : (
              'An admin of your organization can create one.'
            )}
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
                <th className="hide-sm">Created</th>
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
          onClose={() => setParams({})}
          onCreated={(id) => navigate(`/apps/${id}?newKey=1`)}
        />
      )}
    </div>
  );
}

export function AppDetailPage() {
  const org = useOrg();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const apps = useData<{ data: Application[] }>('/applications');
  const keys = useData<{ data: ApiKey[] }>(`/applications/${id}/api-keys`, [id]);
  const usage = useData<Traffic>(`/usage?range=24h&by=model&app=${id}`, [id]);
  const toast = useToast();
  const [shown, setShown] = useState<ApiKey | null>(null);
  const [rotating, setRotating] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const newKey = params.get('newKey') === '1' && org.canManage;
  const app = apps.data?.data.find((a) => a.id === id);

  useEffect(() => {
    if (location.hash === '#connect') document.getElementById('connect')?.scrollIntoView();
  }, [app]);

  if (apps.data && !app)
    return (
      <div className="page">
        <Empty title="App not found">
          <Link to="/apps">Back to apps</Link>
        </Empty>
      </div>
    );
  const active = (keys.data?.data ?? []).filter((k) => !k.revokedAt);

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
          {org.canManage && (
            <button className="btn sm" onClick={() => setParams({ newKey: '1' })}>
              <Icon name="plus" size={13} /> New key
            </button>
          )}
        </div>
        <div className="table-wrap">
          {!keys.data ? (
            <div className="panel-pad">
              <div className="skeleton" />
            </div>
          ) : active.length === 0 ? (
            <Empty title="No active keys">
              Issue a key, then set it as <span className="mono">ARC_API_KEY</span> where the app
              runs.
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th className="hide-sm">Last used</th>
                  <th className="hide-sm">Expires</th>
                  {org.canManage && (
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
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
                    <td className="muted hide-sm">{k.lastUsedAt ? ago(k.lastUsedAt) : 'Never'}</td>
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
                    {org.canManage && (
                      <td className="w">
                        <Menu
                          label={`Actions for ${k.name}`}
                          items={[
                            { label: 'Rotate…', onSelect: () => setRotating(k) },
                            'sep',
                            { label: 'Revoke…', onSelect: () => setRevoking(k), danger: true },
                          ]}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="section" id="connect">
        <div className="section-head">
          <h2 className="section-title">Connect your app</h2>
        </div>
        <ConnectPanel keyPrefix={active[0]?.displayPrefix} />
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Last 24 hours</h2>
          <Link to="/usage">All usage →</Link>
        </div>
        <UsagePanel traffic={usage.data} range="24h" />
      </section>

      {newKey && id && (
        <NewKeyDialog
          appId={id}
          onClose={() => setParams({})}
          onCreated={(k) => {
            setParams({});
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
          body={`${app?.name} stops being able to use this key at once.`}
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
    </div>
  );
}

/** Environment variables and a first request, for any OpenAI-compatible client. */
function ConnectPanel({ keyPrefix }: { keyPrefix: string | undefined }) {
  const base = apiBaseUrl();
  const curl = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer $ARC_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}'`;
  return (
    <div className="panel panel-pad">
      <div className="env">
        <span className="label">ARC_BASE_URL</span>
        <span className="mono">{base}</span>
        <CopyButton text={base} />
        <span className="label">ARC_API_KEY</span>
        <span className="mono faint">{keyPrefix ?? 'Issue a key above'}</span>
        <span />
      </div>
      <div className="code-head" style={{ marginTop: 22 }}>
        <span className="label">First request</span>
        <CopyButton text={curl} />
      </div>
      <pre className="code" tabIndex={0} aria-label="Example request">
        {curl}
      </pre>
      <p className="hint" style={{ margin: '12px 0 0' }}>
        <span className="mono">model: "auto"</span> lets ARC choose among the models your keys
        unlock; <span className="mono">arc/fast</span>, <span className="mono">arc/balanced</span>{' '}
        and <span className="mono">arc/deep</span> pick a mode, or name a model directly. Any OpenAI
        SDK works: set its base URL and API key to these.
      </p>
    </div>
  );
}
