import { useState } from 'react';
import { type Me, type Session, api } from './api';
import { ago, dateTime } from './format';
import { useData } from './hooks';
import { Badge, Field, PageHead, useToast } from './index';

function browserName(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : ua.slice(0, 40);
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

export function AccountPage({ me }: { me: Me }) {
  const sessions = useData<{ data: Session[] }>('/account/sessions');
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <PageHead title="Account" sub={me.user.email} />
      <section>
        <div className="section-head">
          <h2 className="section-title">Password</h2>
        </div>
        <form
          className="panel panel-pad"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await api('POST', '/account/password', {
                currentPassword: current,
                newPassword: next,
              });
              setCurrent('');
              setNext('');
              toast('Password changed. Other sessions were signed out.');
              void sessions.reload();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <Field label="Current password">
            {(id) => (
              <input
                id={id}
                className="input"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="New password"
            hint="At least 12 characters. Changing it signs out your other sessions."
          >
            {(id) => (
              <input
                id={id}
                className="input"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                minLength={12}
              />
            )}
          </Field>
          {error && <p className="error-text">{error}</p>}
          <button className="btn primary" disabled={!current || next.length < 12}>
            Change password
          </button>
        </form>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Where you’re signed in</h2>
        </div>
        <div className="panel">
          {(sessions.data?.data ?? []).map((s) => (
            <div key={s.id} className="list-row">
              <div>
                <div style={{ fontWeight: 500 }}>
                  {browserName(s.userAgent)} {s.current && <Badge tone="accent">This device</Badge>}
                </div>
                <div className="hint">
                  Signed in {ago(s.createdAt)} · expires {dateTime(s.expiresAt)}
                </div>
              </div>
              {!s.current && (
                <button
                  className="btn sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={async () => {
                    await api('DELETE', `/account/sessions/${s.id}`);
                    toast('Signed out that session');
                    void sessions.reload();
                  }}
                >
                  Sign out
                </button>
              )}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <button
            className="btn"
            onClick={async () => {
              await api('POST', '/auth/logout').catch(() => undefined);
              location.assign('/console/');
            }}
          >
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
