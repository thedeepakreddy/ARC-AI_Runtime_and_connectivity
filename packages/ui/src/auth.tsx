/**
 * Sign-in for both apps (owner console and customer dashboard): password, the second step
 * (authenticator or recovery code), "forgot password", Google, and the pages email links open
 * (reset password, confirm email). One-time tokens arrive in the URL fragment (#…), which the
 * browser never sends to a server, and go to the API in request bodies.
 */
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { ApiError, api, get } from './api';
import { Wordmark } from './index';

export const PASSWORD_MIN = 12;
export type AppName = 'console' | 'dashboard';

export interface AuthConfig {
  signup: 'invite' | 'open';
  passwordReset: boolean;
  google: boolean;
  /** Google AdSense for the dashboard sidebar, when this ARC shows ads. */
  ads?: { client: string; slot: string } | null;
}

export function useAuthConfig(): AuthConfig | null {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  useEffect(() => {
    get<AuthConfig>('/auth/config').then(setConfig, () =>
      setConfig({ signup: 'invite', passwordReset: false, google: false }),
    );
  }, []);
  return config;
}

/** Open space, no box: the arrival screen of both apps. */
export function AuthScreen({
  title,
  eyebrow = 'AI Runtime & Connectivity',
  children,
  onSubmit,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onSubmit?: (e: FormEvent) => void;
}) {
  const body = (
    <>
      <div className="signin-mark">
        <Wordmark height={46} />
      </div>
      <span className="eyebrow">{eyebrow}</span>
      <h1 id="auth-title">{title}</h1>
      {children}
    </>
  );
  return (
    <main className="signin">
      {onSubmit ? (
        <form className="signin-card" onSubmit={onSubmit} aria-labelledby="auth-title">
          {body}
        </form>
      ) : (
        <div className="signin-card">{body}</div>
      )}
    </main>
  );
}

export function AuthInput({
  id,
  label,
  ...rest
}: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="field">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input id={id} className="input" placeholder={label} {...rest} />
    </div>
  );
}

export function PasswordInput({
  value,
  onChange,
  label = `Password, ${PASSWORD_MIN}+ characters`,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  const short = value.length > 0 && value.length < PASSWORD_MIN;
  return (
    <div className="field">
      <label htmlFor="new-password" className="sr-only">
        {label}
      </label>
      <input
        id="new-password"
        className="input"
        type="password"
        autoComplete="new-password"
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby="password-hint"
        required
        minLength={PASSWORD_MIN}
      />
      <span id="password-hint" className={short ? 'hint warn-text' : 'sr-only'}>
        {short
          ? `${PASSWORD_MIN - value.length} more characters`
          : `At least ${PASSWORD_MIN} characters`}
      </span>
    </div>
  );
}

export function authMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (err.status === 401 && err.code === 'invalid_credentials') {
      return 'That email and password don’t match.';
    }
    return err.message;
  }
  return 'Couldn’t reach ARC. Check your connection and try again.';
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="error-text" role="alert" style={{ margin: '0 0 12px' }}>
      {error}
    </p>
  ) : null;
}

/** "Continue with Google": ARC prepares the request and sends the browser to Google. */
export function GoogleButton({
  app,
  extra,
  disabled,
}: {
  app: AppName;
  extra?: { inviteToken?: string; organization?: string };
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn google-btn"
      disabled={busy || disabled}
      onClick={async () => {
        setBusy(true);
        try {
          const { url } = await api<{ url: string }>('POST', '/auth/google/start', {
            app,
            ...extra,
          });
          location.assign(url);
        } catch {
          setBusy(false);
        }
      }}
    >
      <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
        <path
          fill="#FFC107"
          d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
        />
        <path
          fill="#FF3D00"
          d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
        />
        <path
          fill="#4CAF50"
          d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
        />
        <path
          fill="#1976D2"
          d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
        />
      </svg>
      {busy ? 'Opening Google…' : 'Continue with Google'}
    </button>
  );
}

/** What Google sign-in reported back (#google=…), in words. */
const GOOGLE_RESULT: Record<string, string> = {
  'no-account': 'There’s no ARC account for that Google address. Ask for an invitation link.',
  'wrong-account': 'That Google account doesn’t match the invitation’s email.',
  'needs-organization': 'Name your organization first, then continue with Google.',
  unverified: 'Google hasn’t verified that email address.',
  mismatch: 'This ARC account is linked to a different Google account.',
  disabled: 'This account is disabled.',
  expired: 'That took too long. Try again.',
  cancelled: 'Google sign-in was cancelled.',
  failed: 'Google sign-in didn’t work. Try again, or use your password.',
};

/** Read and clear #google=… / #mfa=… left by the Google redirect. */
function takeFragment(): { google?: string; mfa?: string } {
  const h = new URLSearchParams(location.hash.slice(1));
  const out: { google?: string; mfa?: string } = {};
  const g = h.get('google');
  const m = h.get('mfa');
  if (g) out.google = g;
  if (m) out.mfa = m;
  if (g || m) history.replaceState(null, '', location.pathname + location.search);
  return out;
}

/**
 * Email + password, then (when two-step sign-in is on) a code. Also offers "forgot password"
 * and Google when this ARC supports them.
 */
export function SignInForm({
  app,
  title,
  onDone,
  footer,
  initialEmail = '',
}: {
  app: AppName;
  title: string;
  onDone: () => void;
  footer?: ReactNode;
  initialEmail?: string;
}) {
  const config = useAuthConfig();
  const [fromGoogle] = useState(takeFragment);
  const [step, setStep] = useState<'password' | 'code' | 'forgot' | 'sent'>(
    fromGoogle.mfa ? 'code' : 'password',
  );
  const [mfaToken, setMfaToken] = useState(fromGoogle.mfa ?? '');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(
    fromGoogle.google && fromGoogle.google !== 'ok'
      ? (GOOGLE_RESULT[fromGoogle.google] ?? null)
      : null,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (fromGoogle.google === 'ok') onDone();
  }, [fromGoogle, onDone]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_expired') {
        setStep('password');
        setCode('');
      }
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (step === 'code') {
    return (
      <AuthScreen
        title="Enter your code"
        eyebrow="Two-step sign-in"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('POST', '/auth/login/mfa', { mfaToken, code });
            onDone();
          });
        }}
      >
        <p className="lead">The 6-digit code from your authenticator app, or a recovery code.</p>
        <AuthInput
          id="code"
          label="Code"
          inputMode="text"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          autoFocus
        />
        <ErrorLine error={error} />
        <button className="btn primary" disabled={busy || code.trim().length < 6}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <p className="foot">
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setStep('password');
              setCode('');
              setError(null);
            }}
          >
            Start again
          </button>
        </p>
      </AuthScreen>
    );
  }

  if (step === 'forgot' || step === 'sent') {
    return (
      <AuthScreen
        title={step === 'sent' ? 'Check your inbox' : 'Reset your password'}
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('POST', '/auth/password-reset/request', { email, app });
            setStep('sent');
          });
        }}
      >
        {step === 'sent' ? (
          <p className="lead">
            If {email} has an ARC account, a link to choose a new password is on its way. It works
            once, for 30 minutes.
          </p>
        ) : (
          <>
            <p className="lead">We’ll email you a link to choose a new password.</p>
            <AuthInput
              id="email"
              label="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
            <ErrorLine error={error} />
            <button className="btn primary" disabled={busy}>
              {busy ? 'Sending…' : 'Send link'}
            </button>
          </>
        )}
        <p className="foot">
          <button type="button" className="link-button" onClick={() => setStep('password')}>
            Back to sign in
          </button>
        </p>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title={title}
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const r = await api<{ ok?: true; mfaRequired?: true; mfaToken?: string }>(
            'POST',
            '/auth/login',
            { email, password },
          );
          if (r.mfaRequired && r.mfaToken) {
            setMfaToken(r.mfaToken);
            setPassword('');
            setStep('code');
          } else onDone();
        });
      }}
    >
      <AuthInput
        id="email"
        label="Email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoFocus
      />
      <AuthInput
        id="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <ErrorLine error={error} />
      <button className="btn primary" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {config?.google && (
        <>
          <div className="or" aria-hidden="true">
            or
          </div>
          <GoogleButton app={app} />
        </>
      )}
      {config?.passwordReset && (
        <p className="foot" style={{ marginTop: 18 }}>
          <button type="button" className="link-button" onClick={() => setStep('forgot')}>
            Forgot password?
          </button>
        </p>
      )}
      {footer}
    </AuthScreen>
  );
}

/** /reset#<token>: choose a new password; every session ends. */
export function ResetPasswordScreen({ app }: { app: AppName }) {
  const [token] = useState(() => location.hash.slice(1));
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (token) history.replaceState(null, '', location.pathname);
  }, [token]);
  if (done) {
    return (
      <AuthScreen title="Password changed">
        <p className="lead">You’ve been signed out everywhere. Sign in with your new password.</p>
        <a className="btn primary" href={`/${app}/`}>
          Sign in
        </a>
      </AuthScreen>
    );
  }
  return (
    <AuthScreen
      title="Choose a new password"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api('POST', '/auth/password-reset/complete', { token, newPassword: password });
          setDone(true);
        } catch (err) {
          setError(authMessage(err));
          setBusy(false);
        }
      }}
    >
      <PasswordInput value={password} onChange={setPassword} />
      <ErrorLine error={error} />
      <button className="btn primary" disabled={busy || !token || password.length < PASSWORD_MIN}>
        {busy ? 'Saving…' : 'Save password'}
      </button>
      <p className="foot">
        <a href={`/${app}/`}>Back to sign in</a>
      </p>
    </AuthScreen>
  );
}

/** /verify#<token>: confirms the email address, then back to the app. */
export function VerifyEmailScreen({ app }: { app: AppName }) {
  const [state, setState] = useState<'checking' | 'ok' | 'failed'>('checking');
  useEffect(() => {
    const token = location.hash.slice(1);
    history.replaceState(null, '', location.pathname);
    api('POST', '/auth/verify-email', { token }).then(
      () => setState('ok'),
      () => setState('failed'),
    );
  }, []);
  if (state === 'checking') return null;
  return (
    <AuthScreen title={state === 'ok' ? 'Email confirmed' : 'This link has expired or was used'}>
      <p className="lead">
        {state === 'ok'
          ? 'Thanks. You can create apps and keys now.'
          : 'Sign in and ask for a new confirmation email from the banner.'}
      </p>
      <a className="btn primary" href={`/${app}/`}>
        Continue
      </a>
    </AuthScreen>
  );
}
