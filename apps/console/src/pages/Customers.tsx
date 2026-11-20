import { useState } from 'react';
import { type Customer, type Invitation, api } from '@arc/ui/api';
import { ago, date, num } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
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
  SearchInput,
  useToast,
} from '@arc/ui';

export function CustomersPage() {
  const { data, error, reload } = useData<{ data: Customer[] }>('/console/customers');
  const [query, setQuery] = useState('');
  const [acting, setActing] = useState<{ c: Customer; action: 'suspend' | 'unsuspend' } | null>(
    null,
  );
  const toast = useToast();
  const invitations = useData<{ data: Invitation[] }>('/console/invitations');
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<Invitation | null>(null);
  const rows = (data?.data ?? []).filter(
    (c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="page">
      <PageHead
        title="Customers"
        sub="Organizations using ARC with their own keys. They never see your keys, apps or settings."
        actions={
          <button className="btn primary" onClick={() => setInviting(true)}>
            <Icon name="plus" size={14} /> Invite customer
          </button>
        }
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
            Invite one: they get a link to set up their organization in the ARC dashboard.
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
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="fw-500">{c.name}</td>
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
      {(invitations.data?.data.length ?? 0) > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Invited, not signed up yet</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Expires</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitations.data!.data.map((i) => (
                  <tr key={i.id}>
                    <td className="fw-500">{i.email}</td>
                    <td className="muted">{ago(i.expiresAt)}</td>
                    <td className="w">
                      <button
                        className="btn ghost sm"
                        onClick={async () => {
                          await api('DELETE', `/console/invitations/${i.id}`);
                          toast('Invitation revoked');
                          void invitations.reload();
                        }}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {inviting && (
        <InviteCustomerDialog
          onClose={() => setInviting(false)}
          onCreated={(i) => {
            setInviting(false);
            setLink(i);
            void invitations.reload();
          }}
        />
      )}
      {link?.token && (
        <Dialog
          title="Send this link"
          onClose={() => setLink(null)}
          footer={
            <button className="btn primary" onClick={() => setLink(null)}>
              Done
            </button>
          }
        >
          <p className="muted mt-0">
            Send it to {link.email} yourself. It works once, for 7 days, and only for that email;
            they name their organization and choose a password. ARC shows it only now.
          </p>
          <div className="secret-box">
            <span className="grow">{inviteLink(link.token)}</span>
            <CopyButton text={inviteLink(link.token)} />
          </div>
        </Dialog>
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

const inviteLink = (token: string) => `${location.origin}/dashboard/invite#${token}`;

function InviteCustomerDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (i: Invitation) => void;
}) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="Invite a customer"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!/^\S+@\S+\.\S+$/.test(email.trim()) || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                onCreated(
                  await api<Invitation>('POST', '/console/invitations', { email: email.trim() }),
                );
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Create link
          </button>
        </>
      }
    >
      <p className="muted mt-0">
        They become the owner of a new organization. Their apps only ever use the provider keys they
        add themselves.
      </p>
      <Field label="Email">
        {(id) => (
          <input
            id={id}
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
          />
        )}
      </Field>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}
