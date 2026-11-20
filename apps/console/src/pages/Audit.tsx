import { useState } from 'react';
import type { AuditEvent } from '../lib/api';
import { dateTime } from '../lib/format';
import { useData } from '../lib/hooks';
import { Empty, ErrorNote, Loading, PageHead, SearchInput } from '../ui';

const WORDS: Record<string, string> = {
  'platform.owner_created': 'Owner account created',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.login_failed': 'Failed sign-in',
  'application.created': 'App created',
  'api_key.created': 'ARC key created',
  'api_key.revoked': 'ARC key revoked',
  'api_key.rotated_with_overlap': 'ARC key rotated with overlap',
  'provider_account.created': 'Provider key added',
  'provider_account.updated': 'Provider key changed',
  'provider_account.deleted': 'Provider key deleted',
  'provider_account.credential_replaced': 'Provider key replaced',
  'provider_account.validated': 'Provider key checked',
  'model.created': 'Model added',
  'model.updated': 'Model changed',
  'routing_policy.updated': 'Routing rules changed',
  'routing_policy.deleted': 'Routing rules reset to global',
  'user.password_changed': 'Password changed',
};
const describe = (a: string) =>
  WORDS[a] ?? a.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function AuditPage() {
  const { data, error } = useData<{ data: AuditEvent[] }>('/audit-events?limit=200');
  const [query, setQuery] = useState('');
  const rows = (data?.data ?? []).filter((e) => {
    const q = query.trim().toLowerCase();
    return (
      !q ||
      `${e.action} ${describe(e.action)} ${e.targetType ?? ''} ${JSON.stringify(e.metadata)}`
        .toLowerCase()
        .includes(q)
    );
  });
  return (
    <div className="page">
      <PageHead
        title="Audit log"
        sub="Every change to keys, models, apps and rules, with who made it. Never request content."
      />
      <div className="toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Filter events" />
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 13 }}>
          Latest 200
        </span>
      </div>
      <ErrorNote error={error} />
      {!data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="panel">
          <Empty title="No events" />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th className="hide-sm">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="muted num" style={{ whiteSpace: 'nowrap' }}>
                    {dateTime(e.createdAt)}
                  </td>
                  <td>{describe(e.action)}</td>
                  <td className="hide-sm faint" style={{ fontSize: 13 }}>
                    {Object.entries(e.metadata ?? {})
                      .map(
                        ([k, v]) =>
                          `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
                      )
                      .join(' · ') ||
                      (e.targetType ? `${e.targetType} ${e.targetId?.slice(0, 8) ?? ''}` : '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
