import {
  Badge,
  Confirm,
  CopyButton,
  Dialog,
  ErrorNote,
  Field,
  Icon,
  Loading,
  Menu,
  PageHead,
  useToast,
} from '@arc/ui';
import { type Invitation, type Member, api } from '@arc/ui/api';
import { ago, date } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
import { useState } from 'react';
import { ROLE_HELP, ROLE_LABEL, useOrg } from '../org';

type Role = Member['role'];
const ROLES: Role[] = ['owner', 'admin', 'member'];
const inviteLink = (token: string) => `${location.origin}/dashboard/invite#${token}`;

export function TeamPage() {
  const org = useOrg();
  const toast = useToast();
  const members = useData<{ data: Member[] }>('/members');
  const invitations = useData<{ data: Invitation[] }>(org.canManage ? '/invitations' : null);
  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<Invitation | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const list = members.data?.data ?? [];
  const owners = list.filter((m) => m.role === 'owner').length;

  async function setRole(m: Member, role: Role) {
    try {
      await api('PATCH', `/members/${m.userId}`, { role });
      toast(`${m.email} is now ${ROLE_LABEL[role]!.toLowerCase()}`);
      void members.reload();
      if (m.you) org.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <PageHead
        title="Team"
        sub={`People in ${org.name}. Owners manage everything, admins manage apps and keys, members can look.`}
        actions={
          org.canManage && (
            <button className="btn primary" onClick={() => setInviting(true)}>
              <Icon name="plus" size={14} /> Invite
            </button>
          )
        }
      />
      <ErrorNote error={members.error} />
      {!members.data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th className="hide-sm">Last signed in</th>
                <th className="hide-sm">Joined</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => {
                const lastOwner = m.role === 'owner' && owners === 1;
                const canRemove = m.you
                  ? !lastOwner
                  : org.canManage && (m.role !== 'owner' || org.isOwner);
                return (
                  <tr key={m.userId}>
                    <td style={{ fontWeight: 500 }}>
                      {m.email} {m.you && <Badge tone="accent">You</Badge>}
                    </td>
                    <td>
                      {org.isOwner && !(m.you && lastOwner) ? (
                        <select
                          className="select"
                          style={{ width: 130, height: 32 }}
                          aria-label={`Role for ${m.email}`}
                          value={m.role}
                          onChange={(e) => void setRole(m, e.target.value as Role)}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          title={lastOwner ? 'An organization needs at least one owner' : undefined}
                        >
                          {ROLE_LABEL[m.role]}
                        </span>
                      )}
                    </td>
                    <td className="muted hide-sm">
                      {m.lastLoginAt ? ago(m.lastLoginAt) : 'Never'}
                    </td>
                    <td className="faint hide-sm">{date(m.joinedAt)}</td>
                    <td className="w">
                      {canRemove && (
                        <Menu
                          label={`Actions for ${m.email}`}
                          items={[
                            {
                              label: m.you ? 'Leave organization…' : 'Remove…',
                              onSelect: () => setRemoving(m),
                              danger: true,
                            },
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
      )}

      {org.canManage && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Pending invitations</h2>
          </div>
          {!invitations.data ? (
            <Loading rows={1} />
          ) : invitations.data.data.length === 0 ? (
            <div className="panel calm">No invitations waiting. Links last 7 days.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th className="hide-sm">Invited by</th>
                    <th>Expires</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.data.data.map((i) => (
                    <tr key={i.id}>
                      <td style={{ fontWeight: 500 }}>{i.email}</td>
                      <td>{ROLE_LABEL[i.role]}</td>
                      <td className="muted hide-sm">{i.invitedBy ?? '—'}</td>
                      <td className="muted">{ago(i.expiresAt)}</td>
                      <td className="w">
                        <button
                          className="btn ghost sm"
                          onClick={async () => {
                            await api('DELETE', `/invitations/${i.id}`);
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
          )}
        </section>
      )}

      {inviting && (
        <InviteDialog
          onClose={() => setInviting(false)}
          onCreated={(i) => {
            setInviting(false);
            setCreated(i);
            void invitations.reload();
          }}
        />
      )}
      {created?.token && (
        <Dialog
          title="Send this link"
          onClose={() => setCreated(null)}
          footer={
            <button className="btn primary" onClick={() => setCreated(null)}>
              Done
            </button>
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>
            Send it to {created.email} yourself, by email or chat. It works once, for 7 days, and
            only for that email. ARC shows it only now.
          </p>
          <div className="secret-box">
            <span style={{ flex: 1 }}>{inviteLink(created.token)}</span>
            <CopyButton text={inviteLink(created.token)} />
          </div>
        </Dialog>
      )}
      {removing && (
        <Confirm
          title={removing.you ? `Leave ${org.name}?` : `Remove ${removing.email}?`}
          body={
            removing.you
              ? 'You lose access to its apps, keys and usage straight away. Someone will need to invite you again.'
              : `${removing.email} loses access to ${org.name} straight away. Their account stays, and any other organizations they belong to.`
          }
          action={removing.you ? 'Leave' : 'Remove'}
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api('DELETE', `/members/${removing.userId}`);
            if (removing.you) {
              location.assign('/dashboard/');
              return;
            }
            toast(`${removing.email} removed`);
            void members.reload();
          }}
        />
      )}
    </div>
  );
}

function InviteDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (i: Invitation) => void;
}) {
  const org = useOrg();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = ROLES.filter((r) => org.isOwner || r !== 'owner');
  return (
    <Dialog
      title={`Invite to ${org.name}`}
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
                  await api<Invitation>('POST', '/invitations', { email: email.trim(), role }),
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
      <div className="label" style={{ marginBottom: 8 }} id="role-label">
        Role
      </div>
      <div className="radio-list" role="radiogroup" aria-labelledby="role-label">
        {allowed.map((r) => (
          <label key={r} className="radio-card">
            <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
            <span>
              <strong>{ROLE_LABEL[r]}</strong>
              <span className="hint">{ROLE_HELP[r]}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}
