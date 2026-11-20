import {
  Badge,
  Empty,
  ErrorNote,
  Loading,
  Menu,
  PageHead,
  SearchInput,
  Switch,
  useToast,
} from '@arc/ui';
import { type TenantModel, api } from '@arc/ui/api';
import { capLabel } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useOrg } from '../org';

/** What ARC knows about a model's price, in the customer's terms (it's their key and bill). */
const PRICE: Record<TenantModel['eligibility'], { label: string; tone: string }> = {
  VERIFIED_FREE: { label: 'Free', tone: 'ok' },
  RESTRICTED_FREE: { label: 'Free with limits', tone: 'warn' },
  PAID: { label: 'Paid', tone: 'bad' },
  UNKNOWN: { label: 'Not checked by ARC', tone: '' },
};

export function ModelsPage() {
  const org = useOrg();
  if (!org.canManage) {
    return (
      <div className="page">
        <PageHead title="Models" />
        <div className="panel">
          <Empty title="Admins choose models">
            Which models your apps can use is set by your organization’s admins and owners.
          </Empty>
        </div>
      </div>
    );
  }
  return <Models />;
}

function Models() {
  const toast = useToast();
  const { data, error, reload } = useData<{ data: TenantModel[] }>('/tenant/models');
  const [query, setQuery] = useState('');
  const rows = (data?.data ?? []).filter(
    (m) =>
      !query.trim() ||
      `${m.providerId}/${m.modelId}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  async function choose(m: TenantModel, enabled: boolean | null) {
    try {
      await api('PUT', `/tenant/models/${m.id}`, { enabled });
      toast(
        enabled === null
          ? `${m.modelId} follows ARC again`
          : `${m.modelId} turned ${enabled ? 'on' : 'off'}`,
      );
      void reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  return (
    <div className="page">
      <PageHead
        title="Models"
        sub="Every model your provider keys can reach. You decide which ones your apps use: they run on your keys, so paid models bill your provider account. Until you choose, a model follows ARC’s classification."
      />
      <ErrorNote error={error} />
      {!data ? (
        <Loading />
      ) : data.data.length === 0 ? (
        <div className="panel">
          <Empty title="No models yet">
            Models appear here once one of your <Link to="/keys">provider keys</Link> has been
            checked.
          </Empty>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <SearchInput value={query} onChange={setQuery} placeholder="Search models" />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Price</th>
                  <th className="hide-sm">Can do</th>
                  <th className="hide-sm">Set by</th>
                  <th className="r">Use</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const price = PRICE[m.eligibility];
                  return (
                    <tr key={m.id}>
                      <td>
                        <div className="mono" style={{ fontWeight: 500, color: 'var(--text)' }}>
                          {m.providerId}/{m.modelId}
                        </div>
                        {m.termsNote && (
                          <div className="faint" style={{ fontSize: 13 }}>
                            {m.termsNote}
                          </div>
                        )}
                      </td>
                      <td>
                        <Badge tone={price.tone}>{price.label}</Badge>
                      </td>
                      <td className="muted hide-sm" style={{ fontSize: 13 }}>
                        {m.capabilities.length ? m.capabilities.map(capLabel).join(', ') : '—'}
                      </td>
                      <td className="muted hide-sm">{m.choice === null ? 'ARC' : 'You'}</td>
                      <td className="r w">
                        <Switch
                          label={`Use ${m.modelId}`}
                          checked={m.enabled}
                          onChange={(v) => void choose(m, v)}
                        />
                      </td>
                      <td className="w">
                        {m.choice !== null && (
                          <Menu
                            label={`Actions for ${m.modelId}`}
                            items={[
                              { label: 'Follow ARC again', onSelect: () => void choose(m, null) },
                            ]}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.data.some((m) => m.eligibility === 'UNKNOWN') && (
            <p className="hint" style={{ margin: '12px 4px 0' }}>
              “Not checked by ARC” means ARC hasn’t confirmed its price or terms. You can still use
              it on your own keys; ARC never uses it on anyone else’s.
            </p>
          )}
        </>
      )}
    </div>
  );
}
