import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from './toast';
import { api, login } from './api';
import Dashboard from './pages/Dashboard';
import Discover from './pages/Discover';
import Leads from './pages/Leads';
import Campaigns from './pages/Campaigns';
import Deliverability from './pages/Deliverability';
import Settings from './pages/Settings';
import Validation from './pages/Validation';
import Inbox from './pages/Inbox';
import Costs from './pages/Costs';
import Suppression from './pages/Suppression';
import Diagnostics from './pages/Diagnostics';
import ProviderUsage from './pages/ProviderUsage';
import FirstRun from './pages/FirstRun';

const TABS = [
  { to: '/',                ico: '⌂', label: 'Dashboard' },
  { to: '/first-run',       ico: '◆', label: 'First run' },
  { to: '/discover',        ico: '✦', label: 'Find Leads' },
  { to: '/leads',           ico: '◫', label: 'Leads' },
  { to: '/campaigns',       ico: '✶', label: 'Campaigns' },
  { to: '/validation',      ico: '◐', label: 'Validation' },
  { to: '/inbox',           ico: '✉', label: 'Inbox' },
  { to: '/deliverability',  ico: '◈', label: 'Deliverability' },
  { to: '/diagnostics',     ico: '✚', label: 'Diagnostics' },
  { to: '/costs',           ico: '$', label: 'Costs' },
  { to: '/provider-usage',  ico: '◇', label: 'Provider usage' },
  { to: '/suppression',     ico: '⊘', label: 'Suppression' },
  { to: '/settings',        ico: '⚙', label: 'Settings' },
];

function Login({ onAuth }: { onAuth: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="overlay">
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h2 className="modal-title">Keres AI sign-in</h2>
        </div>
        <div className="modal-body">
          <p className="panel-desc">Enter the access token to sign in.</p>
          <div className="field" style={{ marginTop: 14 }}>
            <label className="field-label">Access token</label>
            <input className="field-input" type="password" value={token} onChange={e => setToken(e.target.value)} />
          </div>
          {err && <div className="callout danger">{err}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={async () => {
            const ok = await login(token);
            if (ok) onAuth();
            else setErr('Invalid token');
          }}>Sign in</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [sampleMode, setSampleMode] = useState(true);
  const [enableSes, setEnableSes] = useState<boolean | null>(null);
  const location = useLocation();

  useEffect(() => {
    api.get('/health').then(r => {
      setHealthy(!!r.ok);
      if (r.ok && r.data) {
        setSampleMode(!!r.data.sampleMode);
        setEnableSes(r.data.enableSes === true);
      }
    });
    api.get('/settings').then(r => setAuthed(!!r.ok));
  }, []);

  /* Setup-mode banner: production infra but outbound deliberately disabled.
     This is the safe state we want the operator to recognize, not "broken". */
  const setupBanner = healthy && !sampleMode && enableSes === false ? (
    <div className="setup-banner" role="status">
      <strong>Setup mode</strong>
      <span>Production infrastructure is live, but outbound email is intentionally disabled (<code>ENABLE_SES=false</code>). The launch-gate blockers below are the checklist for turning real sending on. See <a href="https://github.com/harshilkikani/keres-ai/blob/main/docs/NEXT-DOMAIN-CLOUDFLARE-SES-PLAN.md" target="_blank" rel="noopener">NEXT-DOMAIN-CLOUDFLARE-SES-PLAN.md</a>.</span>
    </div>
  ) : null;

  if (authed === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'Inter, sans-serif', color: '#888', fontSize: 15 }}>
        Loading…
      </div>
    );
  }
  if (authed === false) {
    return (
      <ToastProvider>
        <Login onAuth={() => setAuthed(true)} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="shell">
        <header className="topnav">
          <div className="brand">
            <div className="brand-mark">K</div>
            <div className="brand-text">
              <span className="label">Keres AI</span>
              <span className="name">Email Operations</span>
            </div>
          </div>
          <nav className="nav-tabs">
            {TABS.map(t => (
              <NavLink key={t.to} to={t.to} end={t.to === '/'}
                className={({ isActive }) => 'nav-tab' + (isActive ? ' active' : '')}>
                <span className="ico">{t.ico}</span>{t.label}
              </NavLink>
            ))}
          </nav>
          <div className="nav-right">
            <span className={'conn-pill ' + (healthy ? 'online' : 'offline')}>
              <span className="conn-dot"></span>
              <span>{healthy === null ? '…' : healthy ? (sampleMode ? 'Sample mode' : 'Live') : 'Offline'}</span>
            </span>
          </div>
        </header>
        {setupBanner}
        <main key={location.pathname} className="page">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/discover" element={<Discover />} />
            <Route path="/leads" element={<Leads />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/validation" element={<Validation />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/deliverability" element={<Deliverability />} />
            <Route path="/diagnostics" element={<Diagnostics />} />
            <Route path="/costs" element={<Costs />} />
            <Route path="/provider-usage" element={<ProviderUsage />} />
            <Route path="/first-run" element={<FirstRun />} />
            <Route path="/suppression" element={<Suppression />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
        <footer className="attribution">
          Discovery data © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>.
          Yelp data used only at-call-time per their TOS.
        </footer>
      </div>
    </ToastProvider>
  );
}
