import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { type Me, type Overview, api, get, onUnauthorized } from '@arc/ui/api';
import { usePolling } from '@arc/ui/hooks';
import { AccountPage } from '@arc/ui/account';
import { ResetPasswordScreen, SignInForm } from '@arc/ui/auth';
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

  if (location.pathname.endsWith('/reset')) return <ResetPasswordScreen app="console" />;
  if (me === undefined) return null;
  if (me === null)
    return (
      <SignInForm
        app="console"
        title="Sign in to the console"
        onDone={load}
        footer={<p className="foot">Owner access · Encrypted session</p>}
      />
    );
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
            <span className="truncate">{me.user.email}</span>
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
          <Route path="/account" element={<AccountPage me={me} app="console" />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
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
