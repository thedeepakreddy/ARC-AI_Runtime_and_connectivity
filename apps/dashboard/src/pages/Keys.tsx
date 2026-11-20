import { Empty, ErrorNote, Icon, Loading, PageHead, Status } from '@arc/ui';
import type { Provider, ProviderAccount } from '@arc/ui/api';
import { HEALTH, JURISDICTIONS, ago } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
import { AddKeySheet, KeyMenu, KeySheet, ToggleKey } from '@arc/ui/keys';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useOrg } from '../org';

export function KeysPage() {
  const org = useOrg();
  if (!org.canManage) {
    return (
      <div className="page">
        <PageHead title="Provider keys" />
        <div className="panel">
          <Empty title="Admins manage provider keys">
            Your organization’s keys are visible to its admins and owners. Ask one of them if a key
            needs attention.
          </Empty>
        </div>
      </div>
    );
  }
  return <Keys />;
}

function Keys() {
  const providers = useData<{ data: Provider[] }>('/providers');
  const accounts = useData<{ data: ProviderAccount[] }>('/provider-accounts');
  const [params, setParams] = useSearchParams();
  const adding = params.get('add') === '1';
  const openId = params.get('key');
  const byId = useMemo(
    () => new Map((providers.data?.data ?? []).map((p) => [p.id, p])),
    [providers.data],
  );
  const list = accounts.data?.data ?? [];
  const open = list.find((a) => a.id === openId);
  const reload = () => void accounts.reload();
  const add = () => setParams({ add: '1' });

  return (
    <div className="page">
      <PageHead
        title="Provider keys"
        sub="Your own keys for Gemini, Groq, OpenRouter and the rest. ARC encrypts them, spreads requests across them and steps around keys that fail. Your apps’ traffic only ever uses these keys."
        actions={
          <button className="btn primary" onClick={add}>
            <Icon name="plus" size={14} /> Add key
          </button>
        }
      />
      <ErrorNote error={accounts.error} />
      {!accounts.data ? (
        <Loading />
      ) : list.length === 0 ? (
        <div className="panel">
          <Empty title="No provider keys yet">
            Add at least one key so your apps’ requests have somewhere to go.{' '}
            <button className="link-button" onClick={add}>
              Add a key
            </button>
          </Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th className="hide-sm">Provider</th>
                <th>Status</th>
                <th className="hide-sm">Checked</th>
                <th className="r">On</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const h = a.enabled
                  ? HEALTH[a.healthStatus]!
                  : { label: 'Off', tone: 'off' as const };
                const p = byId.get(a.providerId);
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
                        onClick={(e) => {
                          e.stopPropagation();
                          setParams({ key: a.id });
                        }}
                      >
                        {a.label}
                      </button>
                      <div className="mono faint">{a.secretHint ?? ''}</div>
                    </td>
                    <td className="hide-sm">
                      {p?.displayName ?? a.providerId}
                      <div className="faint" style={{ fontSize: 13 }}>
                        {JURISDICTIONS[p?.jurisdiction ?? ''] ?? ''}
                      </div>
                    </td>
                    <td>
                      <Status tone={h.tone}>{h.label}</Status>
                    </td>
                    <td className="faint hide-sm">{ago(a.lastValidatedAt)}</td>
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
        </div>
      )}
      {open && (
        <KeySheet
          account={open}
          provider={byId.get(open.providerId)}
          onClose={() => setParams({})}
          onDone={reload}
          noModels="ARC hasn’t made any of this provider’s models available yet. Models found with your key become usable once ARC has classified them."
        />
      )}
      {adding && providers.data && (
        <AddKeySheet
          providers={providers.data.data}
          onClose={() => setParams({})}
          onDone={reload}
          afterAdd={() =>
            'Your apps can use this key straight away for models ARC has already classified.'
          }
        />
      )}
    </div>
  );
}
