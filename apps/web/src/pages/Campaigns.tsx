import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';

interface Campaign {
  id: string; name: string; status: string; templateKey: string;
  recipientCount: number; sentCount: number; deliveredCount: number;
  bouncedCount: number; repliedCount: number; complainedCount: number; unsubCount: number;
  createdAt: string;
}

const TEMPLATES = [
  { key: 'septic',       label: 'Septic — 2am emergencies' },
  { key: 'water',        label: 'Water / Mold — 24/7 intake' },
  { key: 'hvac',         label: 'HVAC — no-heat / no-cool' },
  { key: 'roofer',       label: 'Roofing — missed calls' },
  { key: 'plumber',      label: 'Plumbing — leak calls' },
  { key: 'electrician',  label: 'Electrical — service calls' },
  { key: 'towing',       label: 'Towing — roadside urgency' },
  { key: 'real-estate',  label: 'Real Estate — speed to lead' },
  { key: 'general-audit', label: 'General — free call audit' },
];

export default function Campaigns() {
  const t = useToast();
  const [rows, setRows] = useState<Campaign[]>([]);
  const [view, setView] = useState<'list' | 'new'>('list');
  const [name, setName] = useState('');
  const [tplKey, setTplKey] = useState('septic');
  const [niche, setNiche] = useState('Septic');
  const [minScore, setMinScore] = useState(60);
  const [preview, setPreview] = useState<{ subject: string; body: string; lint: any[] } | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    const r = await api.get('/campaigns');
    if (r.ok && r.data) setRows(r.data.rows);
  };
  useEffect(() => { refresh(); }, []);

  const create = async () => {
    setCreating(true);
    const r = await api.post('/campaigns', {
      name, templateKey: tplKey,
      audienceFilter: { niche, minScore, status: 'uncontacted' },
    });
    setCreating(false);
    if (!r.ok) { t.push('error', 'Create failed', r.error); return; }
    /* preview against the first eligible lead */
    const leadsR = await api.get(`/leads?niche=${encodeURIComponent(niche)}&limit=1`);
    if (leadsR.ok && leadsR.data?.rows?.[0]) {
      const pr = await api.post<{ subject: string; body: string; lint: any[] }>(`/campaigns/${r.data.id}/render-preview`, { leadId: leadsR.data.rows[0].id });
      if (pr.ok && pr.data) setPreview(pr.data);
    }
    t.push('success', 'Campaign created (draft)');
    refresh();
  };

  const launch = async (id: string) => {
    /* Pre-flight the launch gate; show blockers in a toast before touching launch. */
    const pre = await api.get<{ gate: { ok: boolean; checks: Array<{ label: string; state: string; detail?: string }> } }>(`/campaigns/${id}/launch-gate`);
    if (pre.ok && pre.data && !pre.data.gate.ok) {
      const blockers = pre.data.gate.checks.filter(c => c.state === 'fail').map(c => c.label).join('; ');
      t.push('error', 'Cannot launch', blockers);
      return;
    }
    const r = await api.post<{ ok: boolean; gate?: { checks?: Array<{ label: string; state: string }> } }>(`/campaigns/${id}/launch`);
    if (!r.ok && (r.data as any)?.gate?.checks?.length) {
      const blockers = (r.data as any).gate.checks.filter((c: any) => c.state === 'fail').map((c: any) => c.label).join('; ');
      t.push('error', 'Cannot launch', blockers);
      return;
    }
    if (!r.ok) { t.push('error', 'Launch failed', r.error); return; }
    t.push('success', 'Campaign running');
    refresh();
  };

  const pause = async (id: string) => { await api.post(`/campaigns/${id}/pause`); refresh(); };
  const resume = async (id: string) => { await api.post(`/campaigns/${id}/resume`); refresh(); };

  if (view === 'new') return (
    <>
      <div className="page-header">
        <h1 className="page-title">New <span className="it">campaign</span></h1>
      </div>
      <div className="container">
        <div className="builder-grid">
          <div>
            <div className="panel">
              <div className="panel-head"><h2>Audience</h2></div>
              <div className="field"><label className="field-label">Campaign name</label>
                <input className="field-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Septic Houston — May outreach" /></div>
              <div className="field-row">
                <div className="field"><label className="field-label">Niche</label>
                  <select className="field-input" value={niche} onChange={e => setNiche(e.target.value)}>
                    {['Septic','Water/Mold','HVAC','Roofer','Plumber','Electrician','Towing','Real Estate'].map(n => <option key={n}>{n}</option>)}
                  </select></div>
                <div className="field"><label className="field-label">Min score</label>
                  <input className="field-input" type="number" value={minScore} onChange={e => setMinScore(Number(e.target.value) || 0)} /></div>
              </div>
              <div className="field"><label className="field-label">Template</label>
                <select className="field-input" value={tplKey} onChange={e => setTplKey(e.target.value)}>
                  {TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select></div>
              <div className="callout accent">
                <strong>Anti-repeat protection is on.</strong> Suppressed, bounced, unsubscribed, and DNC leads are excluded automatically.
              </div>
              <button className="btn btn-primary" onClick={create} disabled={creating || !name}>
                {creating ? <><span className="spinner"></span> Creating…</> : 'Create draft &amp; preview'}
              </button>
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={() => setView('list')}>Cancel</button>
            </div>
          </div>
          <div>
            <div className="panel">
              <div className="panel-head"><h2>Preview</h2></div>
              {!preview && <div className="empty"><div className="e-ico">✶</div><div className="e-title">No preview yet</div></div>}
              {preview && (
                <div className="preview-box">
                  <div className="preview-subj">{preview.subject}</div>
                  <div className="preview-body">{preview.body}</div>
                </div>
              )}
              {preview && Array.isArray(preview.lint) && preview.lint.length > 0 && (
                <>
                  <h3 style={{ fontSize: 12, margin: '12px 0 6px' }}>Linter</h3>
                  {preview.lint.map((i: any, k: number) => (
                    <div key={k} className={`callout ${i.severity === 'error' ? 'danger' : i.severity === 'warn' ? 'warn' : ''}`}>
                      <strong>{i.severity}</strong> · {i.code}: {i.message}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Campaign <span className="it">builder</span></h1>
      </div>
      <div className="container">
        <div className="panel-head" style={{ border: 'none', marginBottom: 12 }}>
          <h2 style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 400 }}>Your campaigns</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setView('new')}>+ New campaign</button>
        </div>
        {rows.length === 0 && (
          <div className="empty"><div className="e-ico">✶</div><div className="e-title">No campaigns yet</div></div>
        )}
        {rows.map(c => (
          <div className="camp-card" key={c.id}>
            <div>
              <div className="cc-name">{c.name}</div>
              <div className="cc-meta">
                <span className={`status-badge ${c.status === 'running' ? 'sending' : c.status === 'completed' ? 'complete' : c.status === 'paused' ? 'paused' : 'draft'}`}>
                  <span className="dot"></span>{c.status}
                </span>
                <span>· {c.templateKey}</span>
                <span>· {new Date(c.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
            <div className="cc-stats">
              <div className="cc-stat"><div className="v">{c.recipientCount}</div><div className="l">Recipients</div></div>
              <div className="cc-stat green"><div className="v">{c.sentCount}</div><div className="l">Sent</div></div>
              <div className="cc-stat green"><div className="v">{c.repliedCount}</div><div className="l">Replied</div></div>
              <div className="cc-stat red"><div className="v">{c.bouncedCount}</div><div className="l">Bounced</div></div>
            </div>
            <div className="row-actions">
              {c.status === 'draft' && <button className="btn btn-primary btn-sm" onClick={() => launch(c.id)}>Launch</button>}
              {c.status === 'running' && <button className="btn btn-secondary btn-sm" onClick={() => pause(c.id)}>Pause</button>}
              {c.status === 'paused' && <button className="btn btn-primary btn-sm" onClick={() => resume(c.id)}>Resume</button>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
