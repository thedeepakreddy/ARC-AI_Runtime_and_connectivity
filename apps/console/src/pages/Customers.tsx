import { useState } from 'react';
import { type Customer, api } from '../lib/api';
import { date, num } from '../lib/format';
import { useData } from '../lib/hooks';
import {
  Badge,
  Confirm,
  Empty,
  ErrorNote,
  Loading,
  Menu,
  PageHead,
  SearchInput,
  useToast,
} from '../ui';

export function CustomersPage() {
  const { data, error, reload } = useData<{ data: Customer[] }>('/console/customers');
  const [query, setQuery] = useState('');
  const [acting, setActing] = useState<{ c: Customer; action: 'suspend' | 'unsuspend' } | null>(
    null,
  );
  const toast = useToast();
  const rows = (data?.data ?? []).filter(
    (c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="page">
      <PageHead
        title="Customers"
        sub="Organizations using ARC with their own keys. They never see your keys, apps or settings."
      />
      <div className="toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Search customers" />
      </div>
      <ErrorNote error={error} />
      {!data ? (
        <Loading />
      ) : data.data.length === 0 ? (
        <div className="panel">
          <Empty title="No customers yet">
            Customers appear here when they sign up through the ARC dashboard.
          </Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Status</th>
                <th className="r">Members</th>
                <th className="r hide-sm">Apps</th>
                <th className="r hide-sm">Their keys</th>
                <th className="r">Requests, 30 d</th>
                <th className="hide-sm">Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 500 }}>{c.name}</td>
                  <td>
                    {c.suspendedAt ? (
                      <Badge tone="bad">Suspended</Badge>
                    ) : (
                      <Badge tone="ok">Active</Badge>
                    )}
                  </td>
                  <td className="r num">{num(c.members)}</td>
                  <td className="r num hide-sm">{num(c.apps)}</td>
                  <td className="r num hide-sm">{num(c.providerKeys)}</td>
                  <td className="r num">{num(c.requests30d)}</td>
                  <td className="faint hide-sm">{date(c.createdAt)}</td>
                  <td className="w">
                    <Menu
                      items={[
                        c.suspendedAt
                          ? {
                              label: 'Restore access',
                              onSelect: () => setActing({ c, action: 'unsuspend' }),
                            }
                          : {
                              label: 'Suspend…',
                              onSelect: () => setActing({ c, action: 'suspend' }),
                              danger: true,
                            },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {acting && (
        <Confirm
          title={
            acting.action === 'suspend' ? `Suspend ${acting.c.name}?` : `Restore ${acting.c.name}?`
          }
          body={
            acting.action === 'suspend'
              ? 'Their ARC keys stop working at once and members can’t sign in to their organization. Nothing is deleted; you can restore access later.'
              : 'Their keys work again and members can sign in.'
          }
          action={acting.action === 'suspend' ? 'Suspend' : 'Restore access'}
          danger={acting.action === 'suspend'}
          onClose={() => setActing(null)}
          onConfirm={async () => {
            await api('POST', `/console/customers/${acting.c.id}/${acting.action}`);
            toast(
              acting.action === 'suspend'
                ? `${acting.c.name} suspended`
                : `${acting.c.name} restored`,
            );
            void reload();
          }}
        />
      )}
    </div>
  );
}
