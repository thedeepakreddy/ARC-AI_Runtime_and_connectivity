import {
  AuthInput,
  AuthScreen,
  GoogleButton,
  PASSWORD_MIN,
  PasswordInput,
  SignInForm,
  authMessage,
  useAuthConfig,
} from '@arc/ui/auth';
import { ApiError, type InvitationPreview, type Me, api, get } from '@arc/ui/api';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLE_LABEL } from './org';

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
  initialEmail,
}: {
  onDone: () => void;
  title?: string;
  initialEmail?: string;
}) {
  const mode = useSignupMode();
  return (
    <SignInForm
      app="dashboard"
      title={title}
      onDone={onDone}
      {...(initialEmail ? { initialEmail } : {})}
      footer={
        <p className="foot">
          {mode === 'open' ? (
            <>
              New to ARC? <Link to="/signup">Create an organization</Link>
            </>
          ) : (
            'New here? Ask your organization for an invitation link.'
          )}
        </p>
      }
    />
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
      setError(authMessage(err));
      setBusy(false);
    }
  }
  return (
    <AuthScreen title="Create your organization" onSubmit={submit}>
      <AuthInput
        id="org"
        label="Organization name"
        autoComplete="organization"
        value={organization}
        onChange={(e) => setOrganization(e.target.value)}
        required
        maxLength={200}
        autoFocus
      />
      <AuthInput
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
  const config = useAuthConfig();

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
    <AuthInput
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
          initialEmail={preview.email}
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
            setError(authMessage(err));
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
            setError(authMessage(err));
          }
          setBusy(false);
        }
      }}
    >
      {orgField}
      <AuthInput id="email" label="Email" type="email" value={preview.email} readOnly />
      <PasswordInput value={password} onChange={setPassword} />
      {errorLine}
      <button className="btn primary" disabled={busy || password.length < PASSWORD_MIN}>
        {busy ? 'Setting up…' : preview.newOrganization ? 'Create organization' : 'Join'}
      </button>
      {config?.google && (
        <>
          <div className="or" aria-hidden="true">
            or
          </div>
          <GoogleButton
            app="dashboard"
            disabled={preview.newOrganization && !organization.trim()}
            extra={{
              inviteToken: token,
              ...(preview.newOrganization ? { organization: organization.trim() } : {}),
            }}
          />
        </>
      )}
      <p className="foot">
        Have an account?{' '}
        <button type="button" className="link-button" onClick={() => setNeedsSignIn(true)}>
          Sign in to accept
        </button>
      </p>
    </AuthScreen>
  );
}
