/** Account → Security: two-step sign-in, recovery codes, Google, email confirmation. */
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api } from './api';
import { useData } from './hooks';
import { Badge, CopyButton, Dialog, Field, Status, useToast } from './index';

interface Security {
  mfaEnabled: boolean;
  recoveryCodesLeft: number;
  google: boolean;
  emailVerified: boolean;
  /** Whether this ARC can send email. */
  email: boolean;
  /** Whether this ARC offers Google sign-in. */
  googleSignIn: boolean;
}

export function SecuritySection({ app }: { app: 'console' | 'dashboard' }) {
  const { data, reload } = useData<Security>('/account/security');
  const toast = useToast();
  const [setup, setSetup] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [regen, setRegen] = useState(false);

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Security</h2>
      </div>
      <div className="panel">
        <div className="list-row">
          <div className="grow">
            <div className="fw-500">Two-step sign-in</div>
            <div className="hint">
              {data?.mfaEnabled
                ? `A code from your authenticator app at every sign-in. ${data.recoveryCodesLeft} recovery codes left.`
                : 'Ask for a code from an authenticator app (1Password, Google Authenticator…) after your password.'}
            </div>
          </div>
          {data &&
            (data.mfaEnabled ? (
              <>
                <Status tone="ok">On</Status>
                <button className="btn sm" onClick={() => setRegen(true)}>
                  New recovery codes
                </button>
                <button className="btn sm danger" onClick={() => setTurningOff(true)}>
                  Turn off
                </button>
              </>
            ) : (
              <button className="btn sm primary" onClick={() => setSetup(true)}>
                Turn on
              </button>
            ))}
        </div>
        <div className="list-row">
          <div className="grow">
            <div className="fw-500">Email</div>
            <div className="hint">
              {data?.emailVerified
                ? 'Confirmed.'
                : 'Not confirmed yet. Creating apps and keys needs a confirmed email.'}
            </div>
          </div>
          {data &&
            (data.emailVerified ? (
              <Status tone="ok">Confirmed</Status>
            ) : data.email ? (
              <button
                className="btn sm"
                onClick={async () => {
                  await api('POST', '/auth/verify-email/send', { app });
                  toast('Confirmation email sent');
                }}
              >
                Send confirmation email
              </button>
            ) : (
              <Badge tone="warn">Not confirmed</Badge>
            ))}
        </div>
        {(data?.googleSignIn || data?.google) && (
          <div className="list-row">
            <div className="grow">
              <div className="fw-500">Google</div>
              <div className="hint">
                {data?.google
                  ? 'You can sign in with your Google account.'
                  : 'Sign in with Google from the sign-in screen once, to link it.'}
              </div>
            </div>
            {data?.google && <Status tone="ok">Linked</Status>}
          </div>
        )}
      </div>

      {setup && (
        <SetupDialog
          onClose={() => setSetup(false)}
          onEnabled={(c) => {
            setSetup(false);
            setCodes(c);
            void reload();
          }}
        />
      )}
      {regen && (
        <CodeDialog
          title="New recovery codes"
          body="Enter a code from your authenticator. Your old recovery codes stop working."
          action="Make new codes"
          onClose={() => setRegen(false)}
          onSubmit={async (code) => {
            const r = await api<{ recoveryCodes: string[] }>(
              'POST',
              '/account/mfa/recovery-codes',
              {
                code,
              },
            );
            setRegen(false);
            setCodes(r.recoveryCodes);
            void reload();
          }}
        />
      )}
      {turningOff && (
        <CodeDialog
          title="Turn off two-step sign-in?"
          body="Signing in will need only your password again."
          action="Turn off"
          withPassword
          onClose={() => setTurningOff(false)}
          onSubmit={async (code, password) => {
            await api('POST', '/account/mfa/disable', { code, password });
            setTurningOff(false);
            toast('Two-step sign-in is off');
            void reload();
          }}
        />
      )}
      {codes && <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />}
    </section>
  );
}

function SetupDialog({
  onClose,
  onEnabled,
}: {
  onClose: () => void;
  onEnabled: (codes: string[]) => void;
}) {
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ secret: string; otpauthUrl: string }>('POST', '/account/mfa/setup').then(
      async (s) => {
        setSecret(s);
        // Drawn here, in the browser: the secret never goes to a QR service.
        setQr(await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 200 }));
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  return (
    <Dialog
      title="Turn on two-step sign-in"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={code.trim().length !== 6}
            onClick={async () => {
              try {
                const r = await api<{ recoveryCodes: string[] }>('POST', '/account/mfa/enable', {
                  code,
                });
                onEnabled(r.recoveryCodes);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Turn on
          </button>
        </>
      }
    >
      <p className="muted mt-0">1. Scan this with your authenticator app.</p>
      <div className="qr">
        {qr && <img src={qr} alt="QR code for your authenticator app" width={200} height={200} />}
      </div>
      {secret && (
        <p className="hint text-center">
          Can’t scan? Enter this key:{' '}
          <span className="mono">{secret.secret.match(/.{1,4}/g)?.join(' ')}</span>
        </p>
      )}
      <Field label="2. Enter the 6-digit code it shows">
        {(id) => (
          <input
            id={id}
            className="input mono"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        )}
      </Field>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}

function CodeDialog({
  title,
  body,
  action,
  withPassword,
  onClose,
  onSubmit,
}: {
  title: string;
  body: string;
  action: string;
  withPassword?: boolean;
  onClose: () => void;
  onSubmit: (code: string, password: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={code.trim().length < 6 || (withPassword && !password)}
            onClick={async () => {
              try {
                await onSubmit(code, password);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {action}
          </button>
        </>
      }
    >
      <p className="muted mt-0">{body}</p>
      {withPassword && (
        <Field label="Password">
          {(id) => (
            <input
              id={id}
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
      )}
      <Field label="Code from your authenticator, or a recovery code">
        {(id) => (
          <input
            id={id}
            className="input mono"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        )}
      </Field>
      {error && <p className="error-text">{error}</p>}
    </Dialog>
  );
}

function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const [stored, setStored] = useState(false);
  const text = codes.join('\n');
  return (
    <Dialog
      title="Save your recovery codes"
      onClose={onClose}
      dismissable={stored}
      footer={
        <button className="btn primary" disabled={!stored} onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="muted mt-0">
        If you lose your phone, each code signs you in once. This is the only time ARC shows them:
        keep them in your password manager.
      </p>
      <div className="secret-box" style={{ alignItems: 'flex-start' }}>
        <pre style={{ flex: 1, margin: 0, font: 'inherit', lineHeight: 1.8 }}>{text}</pre>
        <CopyButton text={text} />
      </div>
      <label className="check mt-16">
        <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />
        I’ve saved my recovery codes
      </label>
    </Dialog>
  );
}
