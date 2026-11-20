import { Dot, Icon, Wordmark } from '@arc/ui';
import { AccountPage } from '@arc/ui/account';
import { type Me, api, get, onUnauthorized, setTenant } from '@arc/ui/api';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthScreen, InvitePage, SignIn, SignUp } from './auth';
import { AppDetailPage, AppsPage } from './pages/Apps';
import { KeysPage } from './pages/Keys';
import { OverviewPage } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { TeamPage } from './pages/Team';
import { UsagePage } from './pages/Usage';
import { type Org, OrgContext, ROLE_LABEL, useOrg } from './org';

const TENANT_KEY = 'arc.dashboard.tenant';
const remembered = () => {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
};
const remember = (id: string) => {
  try {
    localStorage.setItem(TENANT_KEY, id);
  } catch {
    // Private mode: the choice just isn't remembered.
  }
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const location = useLocation();
  const load = useCallback(() => {
    get<Me>('/auth/me').then(setMe, () => setMe(null));
  }, []);
  useEffect(() => {
    load();
    return onUnauthorized(() => setMe(null));
  }, [load]);

  if (location.pathname === '/invite') return <InvitePage me={me} onDone={load} />;
  if (me === undefined) return null;
  if (me === null) {
    return (
      <Routes>
        <Route path="/signup" element={<SignUp onDone={load} />} />
        <Route path="*" element={<SignIn onDone={load} />} />
      </Routes>
    );
  }
  return <Signed me={me} onChange={load} />;
}

function Signed({ me, onChange }: { me: Me; onChange: () => void }) {
  const orgs = useMemo(() => me.tenants.filter((t) => t.kind !== 'platform'), [me]);
  const [tenantId, setTenantId] = useState<string | null>(() => {
    const r = remembered();
    return orgs.find((o) => o.id === r)?.id ?? orgs[0]?.id ?? null;
  });
  const current = orgs.find((o) => o.id === tenantId) ?? orgs[0];
  // Set before children render, so their first requests carry the tenant.
  setTenant(current?.id ?? null);

  if (!current) {
    return (
      <AuthScreen
        title={me.user.isSuperadmin ? 'This is the customer dashboard' : 'No organization yet'}
      >
        <p className="lead">
          {me.user.isSuperadmin ? (
            <>
              You’re the ARC owner. Your providers, apps and customers are in the{' '}
              <a href="/console/">console</a>.
            </>
          ) : (
            <>
              {me.user.email} isn’t a member of any organization. Ask a teammate for an invitation
              link, or sign out.
            </>
          )}
        </p>
        <SignOutButton />
      </AuthScreen>
    );
  }
  const org: Org = {
    ...current,
    role: current.role as Org['role'],
    canManage: current.role !== 'member',
    isOwner: current.role === 'owner',
    reload: onChange,
  };
  return (
    <OrgContext.Provider value={org}>
      {/* Remount everything when the organization changes: no data from the previous one. */}
      <Shell
        key={current.id}
        me={me}
        orgs={orgs}
        onSwitch={(id) => {
          remember(id);
          setTenantId(id);
        }}
      />
    </OrgContext.Provider>
  );
}

function SignOutButton() {
  return (
    <button
      className="btn primary"
      onClick={async () => {
        await api('POST', '/auth/logout').catch(() => undefined);
        location.assign('/dashboard/');
      }}
    >
      Sign out
    </button>
  );
}

function Shell({
  me,
  orgs,
  onSwitch,
}: {
  me: Me;
  orgs: Me['tenants'];
  onSwitch: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => setMenuOpen(false), [location.pathname]);

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
        <NavLink to="/" className="brand" aria-label="ARC, overview">
          <Wordmark height={15} />
        </NavLink>
        <OrgSwitcher
          orgs={orgs}
          onSwitch={(id) => {
            onSwitch(id);
            navigate('/');
          }}
        />
        <nav className="nav" aria-label="Dashboard">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <div className="nav-group">Build</div>
          <NavLink to="/apps">Apps</NavLink>
          <NavLink to="/keys">Provider keys</NavLink>
          <NavLink to="/usage">Usage</NavLink>
          <div className="nav-group">Organization</div>
          <NavLink to="/team">Team</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="sidebar-foot">
          <div className="system-line">
            <Dot tone="ok" />
            Requests use only your keys
          </div>
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
          <Route path="/" element={<OverviewPage />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/:id" element={<AppDetailPage />} />
          <Route path="/keys" element={<KeysPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/account" element={<AccountPage me={me} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** The organization this dashboard acts for; a menu when the user belongs to several. */
function OrgSwitcher({ orgs, onSwitch }: { orgs: Me['tenants']; onSwitch: (id: string) => void }) {
  const org = useOrg();
  if (orgs.length < 2) {
    return (
      <div className="org-line">
        <span className="org-name">{org.name}</span>
        <span className="org-role">{ROLE_LABEL[org.role]}</span>
      </div>
    );
  }
  return (
    <label className="org-line org-select">
      <span className="sr-only">Organization</span>
      <select value={org.id} onChange={(e) => onSwitch(e.target.value)} className="select">
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
