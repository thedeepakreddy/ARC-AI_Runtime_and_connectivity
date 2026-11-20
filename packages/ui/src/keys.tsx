/**
 * Keys, shared by the owner console and the customer dashboard: ARC keys for apps (issue, show
 * once, rotate) and provider keys (add and check, details, turn on/off, replace, delete).
 * Secrets are shown once and never stored in the browser.
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  type ApiKey,
  type Application,
  type Model,
  type Provider,
  type ProviderAccount,
  api,
} from './api';
import { GROUPS, HEALTH, JURISDICTIONS, dateTime } from './format';
import { useData } from './hooks';
import {
  Confirm,
  CopyButton,
  Dialog,
  Field,
  Icon,
  Menu,
  SearchInput,
  Sheet,
  Status,
  Switch,
  useToast,
} from './index';

export type Validation = { status: string; modelsSeen: number; error: string | null };

export function NewAppDialog({
  onClose,
  onCreated,
  firstParty = false,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  /** Owner console only: the platform's own apps. */
  firstParty?: boolean;
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
                  ...(firstParty ? { firstParty: true } : {}),
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
            placeholder="My app"
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

export function NewKeyDialog({
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

export function ShowOnceDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
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

export function RotateDialog({
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

export function ToggleKey({ account, onDone }: { account: ProviderAccount; onDone: () => void }) {
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

export function useKeyActions(account: ProviderAccount, onDone: () => void) {
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

export function KeyMenu({
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

export function KeySheet({
  account,
  provider,
  onClose,
  onDone,
  noModels,
}: {
  account: ProviderAccount;
  provider: Provider | undefined;
  onClose: () => void;
  onDone: () => void;
  /** What to say when ARC has no models turned on for this provider. */
  noModels?: ReactNode;
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
        <p className="hint">{noModels ?? 'None turned on yet.'}</p>
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

export function AddKeySheet({
  providers,
  onClose,
  onDone,
  afterAdd,
}: {
  providers: Provider[];
  onClose: () => void;
  onDone: () => void;
  /** Shown after a healthy key with models, e.g. the console's link to classify them. */
  afterAdd?: (close: () => void) => ReactNode;
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
        {ok && result.modelsSeen > 0 && afterAdd && (
          <p style={{ marginTop: 16 }}>{afterAdd(onClose)}</p>
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
