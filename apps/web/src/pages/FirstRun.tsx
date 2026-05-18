import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useToast } from '../toast';

interface Step {
  key: string; label: string; status: string;
  description: string; detail?: string; fix?: string; deepLink?: string;
  notes: string;
}
interface Report {
  wizardKey: string;
  productionMode: boolean;
  steps: Step[];
  blockingCount: number;
  warnCount: number;
  generatedAt: string;
}

function dotColor(s: string): string {
  if (s === 'pass') return 'var(--accent)';
  if (s === 'warn') return 'var(--warn)';
  if (s === 'fail') return 'var(--danger)';
  if (s === 'skip') return 'var(--fg-3)';
  return 'var(--fg-3)';
}

export default function FirstRun() {
  const t = useToast();
  const nav = useNavigate();
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftNotes, setDraftNotes] = useState('');

  const refresh = async () => {
    setBusy(true);
    const r = await api.get<{ report: Report }>('/wizard/first-validation');
    setBusy(false);
    if (r.ok && r.data?.report) setReport(r.data.report);
  };
  useEffect(() => { refresh(); }, []);

  const saveNotes = async (stepKey: string) => {
    await api.put('/wizard/first-validation/notes', { stepKey, notes: draftNotes });
    setEditing(null);
    t.push('success', 'Saved');
    refresh();
  };

  if (!report) return <div className="empty">Loading first-run wizard…</div>;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">First validation <span className="it">run</span></h1>
        <p className="page-subtitle">
          Septic / Houston pilot. Live status from <code>/api/diagnostics</code>, <code>/api/launch-gate</code>, and DB state.
          Refresh-safe; the launch gate is never bypassed.
        </p>
      </div>
      <div className="container">
        <div className="health-hero">
          <div className="health-score" style={{ color: report.blockingCount === 0 ? 'var(--accent)' : 'var(--danger)' }}>
            {report.steps.filter(s => s.status === 'pass').length}/{report.steps.length}
          </div>
          <div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>
              {report.productionMode ? 'Production mode' : 'Sample mode'}
            </div>
            <div className="panel-desc">
              {report.blockingCount} blocker(s), {report.warnCount} warning(s). Generated {new Date(report.generatedAt).toLocaleTimeString()}.
            </div>
          </div>
          <div>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={refresh}>{busy ? <span className="spinner"/> : 'Refresh'}</button>
          </div>
        </div>

        <div className="panel">
          {report.steps.map(s => (
            <div className="dns-result" key={s.key}
                 style={{ background: s.status === 'pass' ? 'var(--accent-soft)'
                   : s.status === 'fail' ? 'var(--danger-soft)'
                   : s.status === 'warn' ? 'var(--warn-soft)' : 'var(--surface-2)',
                   borderColor: s.status === 'pass' ? 'var(--accent-line)'
                     : s.status === 'fail' ? 'var(--danger-line)'
                     : s.status === 'warn' ? 'var(--warn-line)' : 'var(--line)' }}>
              <div className="ic" style={{ color: dotColor(s.status) }}>
                {s.status === 'pass' ? '✓' : s.status === 'fail' ? '✕' : s.status === 'warn' ? '◐' : '○'}
              </div>
              <div style={{ flex: 1 }}>
                <div className="ttl">{s.label}</div>
                <div className="msg">{s.description}</div>
                {s.detail && <div className="msg" style={{ marginTop: 4 }}>{s.detail}</div>}
                {s.fix && <div className="msg" style={{ marginTop: 4 }}><strong>Fix:</strong> {s.fix}</div>}
                {editing === s.key ? (
                  <div style={{ marginTop: 8 }}>
                    <textarea className="field-input" rows={3} value={draftNotes} onChange={e => setDraftNotes(e.target.value)} />
                    <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => saveNotes(s.key)}>Save notes</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </div>
                ) : s.notes ? (
                  <div className="msg" style={{ marginTop: 6, fontStyle: 'italic', cursor: 'pointer' }}
                       onClick={() => { setEditing(s.key); setDraftNotes(s.notes); }}>
                    📝 {s.notes}
                  </div>
                ) : null}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {s.deepLink && (
                  <button className="btn btn-secondary btn-xs" onClick={() => nav(s.deepLink!)}>Open</button>
                )}
                {editing !== s.key && (
                  <button className="btn btn-ghost btn-xs"
                          onClick={() => { setEditing(s.key); setDraftNotes(s.notes); }}>Notes</button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="callout">
          <strong>Reminder.</strong> The launch gate (step 14) is authoritative.
          The wizard cannot be marked "done" while any step is failing — that's by design.
          See <NavLink to="/diagnostics">/diagnostics</NavLink> for the live launch-gate state any time.
        </div>
      </div>
    </>
  );
}
