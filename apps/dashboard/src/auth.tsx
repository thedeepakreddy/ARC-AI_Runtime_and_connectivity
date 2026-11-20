import { Wordmark } from '@arc/ui';
import { ApiError, type InvitationPreview, type Me, api, get } from '@arc/ui/api';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLE_LABEL } from './org';

const PASSWORD_MIN = 12;

/** Open space, no box: the same arrival as the owner console. */
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

function Input({
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

function message(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (err.status === 401) return 'That email and password don’t match.';
    return err.message;
  }
  return 'Couldn’t reach ARC. Check your connection and try again.';
}

function useSignupMode() {
  const [mode, setMode] = useState<'invite' | 'open' | null>(null);
  useEffect(() => {
    get<{ signup: 'invite' | 'open' }>('/auth/config').then(
      (c) => setMode(c.signup),
      () => setMode('invite'),
    );
  }, []);
  return mode;
}

export function SignIn({
  onDone,
  title = 'Sign in to ARC',
}: {
  onDone: () => void;
  title?: string;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mode = useSignupMode();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/login', { email, password });
      onDone();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }
  return (
    <AuthScreen title={title} onSubmit={submit}>
      <Input
        id="email"
        label="Email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoFocus
      />
      <Input
        id="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error && (
        <p className="error-text" role="alert" style={{ margin: '0 0 12px' }}>
          {error}
        </p>
      )}
      <button className="btn primary" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="foot">
        {mode === 'open' ? (
          <>
            New to ARC? <Link to="/signup">Create an organization</Link>
          </>
        ) : (
          'New here? Ask your organization for an invitation link.'
        )}
      </p>
    </AuthScreen>
  );
}

export function SignUp({ onDone }: { onDone: () => void }) {
  const mode = useSignupMode();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organization, setOrganization] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (mode === null) return null;
  if (mode !== 'open') {
    return (
      <AuthScreen title="Sign-up is by invitation">
        <p className="lead">
          Ask the person who runs ARC, or a teammate, for an invitation link. It signs you up in one
          step.
        </p>
        <Link className="btn primary" to="/">
          Back to sign in
        </Link>
      </AuthScreen>
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/signup', { email, password, organization: organization.trim() });
      onDone();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }
  return (
    <AuthScreen title="Create your organization" onSubmit={submit}>
      <Input
        id="org"
        label="Organization name"
        autoComplete="organization"
        value={organization}
        onChange={(e) => setOrganization(e.target.value)}
        required
        maxLength={200}
        autoFocus
      />
      <Input
        id="email"
        label="Work email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <PasswordInput value={password} onChange={setPassword} />
      {error && (
        <p className="error-text" role="alert" style={{ margin: '0 0 12px' }}>
          {error}
        </p>
      )}
      <button className="btn primary" disabled={busy || password.length < PASSWORD_MIN}>
        {busy ? 'Creating…' : 'Create organization'}
      </button>
      <p className="foot">
        Already have an account? <Link to="/">Sign in</Link>
      </p>
    </AuthScreen>
  );
}

function PasswordInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const short = value.length > 0 && value.length < PASSWORD_MIN;
  return (
    <div className="field">
      <label htmlFor="new-password" className="sr-only">
        Password
      </label>
      <input
        id="new-password"
        className="input"
        type="password"
        autoComplete="new-password"
        placeholder={`Password, ${PASSWORD_MIN}+ characters`}
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

/**
 * /invite#<token>. The token stays in the fragment, so it never reaches a server log; it goes
 * to the API in a request body. Works signed out (sign up) and signed in (accept).
 */
export function InvitePage({ me, onDone }: { me: Me | null | undefined; onDone: () => void }) {
  const [token] = useState(() => location.hash.slice(1));
  const [preview, setPreview] = useState<InvitationPreview | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [organization, setOrganization] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  useEffect(() => {
    if (!token) return setPreview(null);
    api<InvitationPreview>('POST', '/auth/invitations/preview', { token }).then(setPreview, () =>
      setPreview(null),
    );
  }, [token]);

  const finish = () => {
    history.replaceState(null, '', '/dashboard/');
    onDone();
    location.assign('/dashboard/');
  };

  if (preview === undefined || me === undefined) return null;
  if (preview === null) {
    return (
      <AuthScreen title="This invitation has expired or was used">
        <p className="lead">Ask whoever invited you for a new link. Links last 7 days.</p>
        <a className="btn primary" href="/dashboard/">
          Go to sign in
        </a>
      </AuthScreen>
    );
  }

  const joining = preview.organization ?? 'a new organization';
  const title = preview.newOrganization ? 'Set up your organization' : `Join ${joining}`;
  const sub = preview.newOrganization
    ? `You’re invited to ARC as ${preview.email}.`
    : `${preview.email} is invited as ${ROLE_LABEL[preview.role]?.toLowerCase()}.`;
  const orgField = preview.newOrganization && (
    <Input
      id="org"
      label="Organization name"
      autoComplete="organization"
      value={organization}
      onChange={(e) => setOrganization(e.target.value)}
      required
      maxLength={200}
    />
  );
  const errorLine = error && (
    <p className="error-text" role="alert" style={{ margin: '0 0 12px' }}>
      {error}
    </p>
  );

  // Signed in as someone else: say so instead of joining the wrong account.
  if (me && me.user.email.toLowerCase() !== preview.email.toLowerCase()) {
    return (
      <AuthScreen title="This invitation is for someone else">
        <p className="lead">
          You’re signed in as {me.user.email}, but the invitation is for {preview.email}. Sign out,
          then open the link again.
        </p>
        <button
          className="btn primary"
          onClick={async () => {
            await api('POST', '/auth/logout').catch(() => undefined);
            location.reload();
          }}
        >
          Sign out
        </button>
      </AuthScreen>
    );
  }

  if (me || needsSignIn) {
    if (!me) {
      return (
        <SignIn
          title={`Sign in as ${preview.email} to accept`}
          onDone={() => {
            setNeedsSignIn(false);
            onDone();
          }}
        />
      );
    }
    return (
      <AuthScreen
        title={title}
        eyebrow={sub}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('POST', '/auth/invitations/accept', {
              token,
              ...(preview.newOrganization ? { organization: organization.trim() } : {}),
            });
            finish();
          } catch (err) {
            setError(message(err));
            setBusy(false);
          }
        }}
      >
        {orgField}
        {errorLine}
        <button className="btn primary" disabled={busy}>
          {preview.newOrganization ? 'Create organization' : `Join ${joining}`}
        </button>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title={title}
      eyebrow={sub}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api('POST', '/auth/signup', {
            email: preview.email,
            password,
            inviteToken: token,
            ...(preview.newOrganization ? { organization: organization.trim() } : {}),
          });
          finish();
        } catch (err) {
          if (err instanceof ApiError && err.code === 'account_exists') {
            setNeedsSignIn(true);
          } else {
            setError(message(err));
          }
          setBusy(false);
        }
      }}
    >
      {orgField}
      <Input id="email" label="Email" type="email" value={preview.email} readOnly />
      <PasswordInput value={password} onChange={setPassword} />
      {errorLine}
      <button className="btn primary" disabled={busy || password.length < PASSWORD_MIN}>
        {busy ? 'Setting up…' : preview.newOrganization ? 'Create organization' : 'Join'}
      </button>
      <p className="foot">
        Have an account?{' '}
        <button type="button" className="link-button" onClick={() => setNeedsSignIn(true)}>
          Sign in to accept
        </button>
      </p>
    </AuthScreen>
  );
}
