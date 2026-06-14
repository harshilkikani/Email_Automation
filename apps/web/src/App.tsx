import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from './toast';
import { api, login } from './api';
import ScrapeSend from './pages/ScrapeSend';
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

const PRIMARY_TABS = [
  { to: '/',         ico: '✦', label: 'Scrape & Send' },
  { to: '/leads',    ico: '◫', label: 'Leads' },
  { to: '/inbox',    ico: '✉', label: 'Inbox' },
  { to: '/settings', ico: '⚙', label: 'Settings' },
];

const ADVANCED_TABS = [
  { to: '/dashboard',       ico: '⌂', label: 'Dashboard' },
  { to: '/discover',        ico: '✦', label: 'Find Leads' },
  { to: '/campaigns',       ico: '✶', label: 'Campaigns' },
  { to: '/deliverability',  ico: '◈', label: 'Deliverability' },
  { to: '/validation',      ico: '◐', label: 'Validation' },
  { to: '/diagnostics',     ico: '✚', label: 'Diagnostics' },
  { to: '/costs',           ico: '$', label: 'Costs' },
  { to: '/provider-usage',  ico: '◇', label: 'Provider usage' },
  { to: '/suppression',     ico: '⊘', label: 'Suppression' },
  { to: '/first-run',       ico: '◆', label: 'First run' },
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
          <p className="panel-desc">Enter the internal access token (from your <code>.env</code>).</p>
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
  const [advOpen, setAdvOpen] = useState(false);
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
        {healthy === false
          ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'Inter, sans-serif', flexDirection: 'column', gap: 12, color: '#888', fontSize: 14 }}>
              <div style={{ fontSize: 28 }}>⚡</div>
              <div style={{ fontWeight: 600, color: '#333', fontSize: 16 }}>Server offline</div>
              <div style={{ maxWidth: 380, textAlign: 'center', lineHeight: 1.6 }}>Cannot reach the Keres AI API. The server may be starting up — try refreshing in a few seconds.</div>
              <button style={{ marginTop: 8, padding: '8px 20px', cursor: 'pointer', borderRadius: 6, border: '1px solid #ddd', background: '#fff' }} onClick={() => window.location.reload()}>Retry</button>
            </div>
          )
          : <Login onAuth={() => setAuthed(true)} />
        }
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
            {PRIMARY_TABS.map(t => (
              <NavLink key={t.to} to={t.to} end={t.to === '/'}
                className={({ isActive }) => 'nav-tab' + (isActive ? ' active' : '')}>
                <span className="ico">{t.ico}</span>{t.label}
              </NavLink>
            ))}
            <div style={{ position: 'relative' }}>
              <button className="nav-tab" onClick={() => setAdvOpen(o => !o)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit' }}>
                <span className="ico">⋯</span>Advanced ▾
              </button>
              {advOpen && (
                <div onMouseLeave={() => setAdvOpen(false)}
                  style={{ position: 'absolute', top: '100%', right: 0, zIndex: 50, minWidth: 200, background: 'var(--panel, #131519)', border: '1px solid var(--line, #23262d)', borderRadius: 10, padding: 6, boxShadow: '0 8px 24px rgba(0,0,0,.4)' }}>
                  {ADVANCED_TABS.map(t => (
                    <NavLink key={t.to} to={t.to} onClick={() => setAdvOpen(false)}
                      className={({ isActive }) => 'nav-tab' + (isActive ? ' active' : '')}
                      style={{ display: 'flex', gap: 8, padding: '8px 12px', borderRadius: 8 }}>
                      <span className="ico">{t.ico}</span>{t.label}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
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
            <Route path="/" element={<ScrapeSend />} />
            <Route path="/dashboard" element={<Dashboard />} />
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
