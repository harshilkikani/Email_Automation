import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';

interface Settings {
  org: {
    id: string; name: string; timezone: string;
    fromName: string; fromEmail: string; replyTo: string;
    physicalAddress: string; outreachSubdomain: string; defaultBookingLink: string;
    productionAccessConfirmed: boolean; budgetMode: string;
  };
  runtime: { sampleMode: boolean; providersEnabled: Record<string, boolean> };
}

export default function SettingsPage() {
  const t = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Partial<Settings['org']>>({});

  useEffect(() => {
    api.get<Settings>('/settings').then(r => { if (r.ok && r.data) { setS(r.data); setDraft(r.data.org); } });
  }, []);

  const save = async () => {
    const r = await api.put('/settings', draft);
    if (!r.ok) { t.push('error', 'Save failed', r.error); return; }
    t.push('success', 'Settings saved');
    const fresh = await api.get<Settings>('/settings');
    if (fresh.ok && fresh.data) { setS(fresh.data); setDraft(fresh.data.org); }
  };

  if (!s) return (
    <div className="container" style={{ padding: 24, color: 'var(--fg-3)' }}>Loading settings…</div>
  );
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Settings <span className="it">&amp; identity</span></h1>
        <p className="page-subtitle">Sender identity, runtime mode, compliance. Secrets live in the server <code>.env</code> — never here.</p>
      </div>
      <div className="container">
        <div className="builder-grid">
          <div>
            <div className="panel">
              <div className="panel-head"><h2>Sender identity</h2></div>
              <div className="field-row">
                <div className="field"><label className="field-label">Organization name</label>
                  <input className="field-input" value={draft.name ?? ''} onChange={e => setDraft({ ...draft, name: e.target.value })} /></div>
                <div className="field"><label className="field-label">Outreach subdomain</label>
                  <input className="field-input" value={draft.outreachSubdomain ?? ''} onChange={e => setDraft({ ...draft, outreachSubdomain: e.target.value })} /></div>
              </div>
              <div className="field-row">
                <div className="field"><label className="field-label">From name</label>
                  <input className="field-input" value={draft.fromName ?? ''} onChange={e => setDraft({ ...draft, fromName: e.target.value })} /></div>
                <div className="field"><label className="field-label">From email</label>
                  <input className="field-input" value={draft.fromEmail ?? ''} onChange={e => setDraft({ ...draft, fromEmail: e.target.value })} /></div>
              </div>
              <div className="field"><label className="field-label">Reply-to</label>
                <input className="field-input" value={draft.replyTo ?? ''} onChange={e => setDraft({ ...draft, replyTo: e.target.value })} /></div>
              <div className="field"><label className="field-label">Physical postal address (CAN-SPAM required)</label>
                <input className="field-input" value={draft.physicalAddress ?? ''} onChange={e => setDraft({ ...draft, physicalAddress: e.target.value })} /></div>
              <div className="field"><label className="field-label">Default booking link</label>
                <input className="field-input" value={draft.defaultBookingLink ?? ''} onChange={e => setDraft({ ...draft, defaultBookingLink: e.target.value })} /></div>
              <button className="btn btn-primary" onClick={save}>Save</button>
            </div>
            <div className="panel">
              <div className="panel-head"><h2>Compliance gates</h2></div>
              <div className="field" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input type="checkbox" checked={!!draft.productionAccessConfirmed}
                  onChange={e => setDraft({ ...draft, productionAccessConfirmed: e.target.checked })} />
                <span>SES production access confirmed (sandbox lifted)</span>
              </div>
              <div className="field"><label className="field-label">Budget mode</label>
                <select className="field-input" value={draft.budgetMode ?? 'free'} onChange={e => setDraft({ ...draft, budgetMode: e.target.value })}>
                  <option value="free">free</option><option value="low">low</option><option value="normal">normal</option>
                </select>
              </div>
              <button className="btn btn-primary" onClick={save}>Save</button>
            </div>
          </div>
          <div>
            <div className="panel">
              <div className="panel-head"><h2>Runtime</h2></div>
              <div className="kv"><span className="k">Sample mode</span><span className="v">{s.runtime.sampleMode ? 'on' : 'off'}</span></div>
              {Object.entries(s.runtime.providersEnabled).map(([k, v]) => (
                <div className="kv" key={k}><span className="k">{k}</span><span className="v" style={{ color: v ? 'var(--accent)' : 'var(--fg-3)' }}>{v ? 'enabled' : 'off'}</span></div>
              ))}
            </div>
            <div className="callout warn">
              <strong>Sensitive credentials.</strong> Never enter SMTP passwords, SES keys, or any API tokens into this UI. Put them in <code>.env</code> or Fly secrets.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
