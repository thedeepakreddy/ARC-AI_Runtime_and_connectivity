import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, type Me, type Overview, api, get, onUnauthorized } from '@arc/ui/api';
import { usePolling } from '@arc/ui/hooks';
import { AccountPage } from './pages/Account';
import { AppDetailPage, AppsPage } from './pages/Apps';
import { AuditPage } from './pages/Audit';
import { CustomersPage } from './pages/Customers';
import { ModelsPage } from './pages/Models';
import { OverviewPage } from './pages/Overview';
import { ProvidersPage } from './pages/Providers';
import { RoutingPage } from './pages/Routing';
import { TrafficPage } from './pages/Traffic';
import { Dot, Icon, Wordmark } from '@arc/ui';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = useCallback(() => {
    get<Me>('/auth/me').then(setMe, () => setMe(null));
  }, []);
  useEffect(() => {
    load();
    return onUnauthorized(() => setMe(null));
  }, [load]);

  if (me === undefined) return null;
  if (me === null) return <SignIn onDone={load} />;
  if (!me.user.isSuperadmin) return <NotOwner email={me.user.email} />;
  return <Shell me={me} />;
}

function Shell({ me }: { me: Me }) {
  const [summary, setSummary] = useState<Overview | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const refresh = useCallback(() => {
    get<Overview>('/console/overview?range=24h').then(setSummary, () => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  usePolling(refresh, 60_000);
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const { modelsToClassify = 0, failingKeys = 0, alerts = 0 } = summary?.counts ?? {};
  const down = summary?.services.filter((s) => s.status === 'down') ?? [];
  const systemTone = !summary ? '' : down.length || alerts ? 'bad' : failingKeys ? 'warn' : 'ok';
  const systemText = !summary
    ? 'Checking…'
    : down.length
      ? `${down.map((s) => s.name).join(', ')} down`
      : alerts
        ? `${alerts} alert${alerts > 1 ? 's' : ''} firing`
        : failingKeys
          ? `${failingKeys} provider key${failingKeys > 1 ? 's' : ''} failing`
          : 'All systems nominal';

  const link = (to: string, label: string, count?: number, tone?: 'alert' | 'bad') => (
    <NavLink to={to} end={to === '/'}>
      {label}
      {count ? (
        <span className={`nav-count num ${tone ?? ''}`}>
          {count}
          <span className="sr-only"> need attention</span>
        </span>
      ) : null}
    </NavLink>
  );

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="mobile-bar">
        <button className="btn ghost icon" aria-label="Menu" onClick={() => setMenuOpen(true)}>
          <Icon name="menu" />
        </button>
        <Wordmark height={13} />
      </div>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <NavLink to="/" className="brand" aria-label="ARC Console, overview">
          <Wordmark height={15} />
          <span className="brand-sub">Console</span>
        </NavLink>
        <nav className="nav" aria-label="Console">
          {link('/', 'Overview')}
          <div className="nav-group">Set up</div>
          {link('/providers', 'Providers & keys', failingKeys, 'bad')}
          {link('/models', 'Models', modelsToClassify, 'alert')}
          {link('/apps', 'Apps')}
          {link('/routing', 'Routing')}
          <div className="nav-group">Watch</div>
          {link('/traffic', 'Traffic')}
          {link('/customers', 'Customers')}
          {link('/audit', 'Audit log')}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/" className="system-line" style={{ textDecoration: 'none' }}>
            <Dot tone={systemTone} />
            {systemText}
          </NavLink>
          <div className="user-line">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {me.user.email}
            </span>
            <NavLink to="/account">Account</NavLink>
          </div>
        </div>
      </aside>
      <main className="main" id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<OverviewPage onChange={refresh} />} />
          <Route path="/providers" element={<ProvidersPage onChange={refresh} />} />
          <Route path="/models" element={<ModelsPage onChange={refresh} />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/:id" element={<AppDetailPage />} />
          <Route path="/routing" element={<RoutingPage />} />
          <Route path="/traffic" element={<TrafficPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/account" element={<AccountPage me={me} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/login', { email, password });
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : err instanceof ApiError && err.status === 401
            ? 'That email and password don’t match.'
            : 'Couldn’t sign in. Check your connection and try again.',
      );
      setBusy(false);
    }
  }
  return (
    <main className="signin">
      <form className="signin-card" onSubmit={submit} aria-labelledby="signin-title">
        <div className="signin-mark">
          <Wordmark height={46} />
        </div>
        <span className="eyebrow">AI Runtime &amp; Connectivity</span>
        <h1 id="signin-title">Sign in to the console</h1>
        <div className="field">
          <label htmlFor="email" className="sr-only">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="password" className="sr-only">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && (
          <p className="error-text" role="alert" style={{ margin: '0 0 12px' }}>
            {error}
          </p>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="foot">Owner access · Encrypted session</p>
      </form>
    </main>
  );
}

function NotOwner({ email }: { email: string }) {
  return (
    <main className="signin">
      <div className="signin-card">
        <div className="signin-mark">
          <Wordmark height={46} />
        </div>
        <h1>Owner access only</h1>
        <p className="lead">
          {email} is signed in, but this console is for the ARC owner. Customers use the ARC
          dashboard.
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
      </div>
    </main>
  );
}
