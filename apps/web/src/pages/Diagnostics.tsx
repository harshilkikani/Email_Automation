import { useEffect, useState } from 'react';
import { api } from '../api';

interface Diag {
  ok: boolean;
  db: string;
  migrations: { current: boolean; lastApplied: string | null };
  providers: Record<string, boolean>;
  sampleMode: boolean;
  budgetMode: string;
  lastJobRun: { kind: string; status: string; completedAt: string | null } | null;
  lastSeedlistPassAt: string | null;
  gate: { ok: boolean; checks: Array<{ code: string; label: string; state: string; detail?: string; fix?: string; docs?: string }>; blockingCount: number; warningCount: number };
}

function tileClass(s: string) {
  return s === 'pass' ? 'pass' : s === 'fail' ? 'fail' : s === 'warn' ? 'warn' : '';
}

export default function Diagnostics() {
  const [d, setD] = useState<Diag | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    const r = await api.get<{ diagnostics: Diag }>('/diagnostics');
    setBusy(false);
    if (r.ok && r.data?.diagnostics) setD(r.data.diagnostics);
  };
  useEffect(() => { refresh(); }, []);

  if (!d) return <div className="empty">Loading diagnostics…</div>;
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">System <span className="it">diagnostics</span></h1>
        <p className="page-subtitle">Deployment health. Every check here must be green before launching a real campaign.</p>
      </div>
      <div className="container">
        <div className="health-hero">
          <div className="health-score" style={{ color: d.ok ? 'var(--accent)' : 'var(--danger)' }}>{d.ok ? '✓' : '✕'}</div>
          <div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>{d.ok ? 'All green' : `${d.gate.blockingCount} blocker(s)`}</div>
            <div className="panel-desc">
              DB: <strong>{d.db}</strong>{' · '}
              Last migration: <strong>{d.migrations.lastApplied ?? '—'}</strong>{' · '}
              Sample mode: <strong>{d.sampleMode ? 'ON' : 'off'}</strong>{' · '}
              Budget mode: <strong>{d.budgetMode}</strong>
            </div>
            <div className="health-tiles" style={{ marginTop: 12 }}>
              {Object.entries(d.providers).map(([k, v]) => (
                <div key={k} className={`h-tile ${v ? 'pass' : 'warn'}`}>
                  <div className="ht-name">{k}</div>
                  <div className="ht-state">{v ? 'enabled' : 'off'}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <button className="btn btn-primary btn-sm" onClick={refresh} disabled={busy}>{busy ? <span className="spinner"></span> : 'Recheck'}</button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Launch-gate checks</h2><span className="tbl-meta">{d.gate.checks.length}</span></div>
          {d.gate.checks.map(c => (
            <div className="dns-result" key={c.code + c.label}
                 style={{ background: c.state === 'pass' ? 'var(--accent-soft)' : c.state === 'fail' ? 'var(--danger-soft)' : c.state === 'warn' ? 'var(--warn-soft)' : 'var(--surface-2)',
                          borderColor: c.state === 'pass' ? 'var(--accent-line)' : c.state === 'fail' ? 'var(--danger-line)' : c.state === 'warn' ? 'var(--warn-line)' : 'var(--line)' }}>
              <div className="ic" style={{ color: c.state === 'pass' ? 'var(--accent)' : c.state === 'fail' ? 'var(--danger)' : c.state === 'warn' ? 'var(--warn)' : 'var(--fg-3)' }}>
                {c.state === 'pass' ? '✓' : c.state === 'fail' ? '✕' : c.state === 'warn' ? '◐' : '○'}
              </div>
              <div style={{ flex: 1 }}>
                <div className="ttl">{c.label}</div>
                {c.detail && <div className="msg">{c.detail}</div>}
                {c.fix && <div className="msg" style={{ marginTop: 2 }}><strong>Fix:</strong> {c.fix}</div>}
              </div>
            </div>
          ))}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Recent jobs &amp; seedlist</h2></div>
          <div className="kv"><span className="k">Last job</span>
            <span className="v">{d.lastJobRun ? `${d.lastJobRun.kind} (${d.lastJobRun.status})` : '—'}</span></div>
          <div className="kv"><span className="k">Last seedlist test pass</span>
            <span className="v">{d.lastSeedlistPassAt ? new Date(d.lastSeedlistPassAt).toLocaleString() : '—'}</span></div>
        </div>
      </div>
    </>
  );
}
