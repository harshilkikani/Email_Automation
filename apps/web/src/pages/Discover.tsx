import { useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';

const NICHES = ['Septic', 'Water/Mold', 'HVAC', 'Roofer', 'Plumber', 'Electrician', 'Towing', 'Real Estate'];

export default function Discover() {
  const t = useToast();
  const [niche, setNiche] = useState<string>('Septic');
  const [city, setCity] = useState('Houston');
  const [state, setState] = useState('TX');
  const [targetCount, setTargetCount] = useState(25);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ found: number; inserted: number; duplicates: number; disqualified: number; attribution?: string } | null>(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    const r = await api.post('/discovery/run', { niche, city, state, targetCount });
    setRunning(false);
    if (!r.ok) { t.push('error', 'Discovery failed', r.error); return; }
    setResult(r.data);
    t.push('success', `Found ${r.data.found}`, `${r.data.inserted} inserted · ${r.data.duplicates} duplicates · ${r.data.disqualified} disqualified`);
  };

  const importCsv = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const csv = await file.text();
    const r = await api.post('/leads/import-csv', { csv });
    if (!r.ok) { t.push('error', 'CSV import failed', r.error); return; }
    t.push('success', 'CSV imported', `${r.data.inserted} inserted · ${r.data.skipped} skipped`);
    e.target.value = '';
    /* Imported leads start unverified; verify them like discovered ones. */
    if (r.data.inserted > 0) {
      const v = await api.post<{ verified: number }>('/leads/verify-pending', { limit: 500 });
      if (v.ok) t.push('success', 'Emails verified', `${v.data?.verified ?? 0} checked`);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Find <span className="it">new leads</span></h1>
        <p className="page-subtitle">
          Discover fresh businesses by niche, city, and state. Every candidate is hard-filtered, deduped, and scored before insert.
        </p>
      </div>
      <div className="container">
        <div className="builder-grid">
          <div>
            <div className="panel">
              <div className="panel-head"><h2><span className="panel-num">1</span>Search criteria</h2></div>
              <div className="field-row">
                <div className="field">
                  <label className="field-label">Niche</label>
                  <select className="field-input" value={niche} onChange={e => setNiche(e.target.value)}>
                    {NICHES.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label">State (2-letter)</label>
                  <input className="field-input" value={state} maxLength={2} onChange={e => setState(e.target.value.toUpperCase())} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="field-label">City</label>
                  <input className="field-input" value={city} onChange={e => setCity(e.target.value)} />
                </div>
                <div className="field">
                  <label className="field-label">Target count</label>
                  <input className="field-input" type="number" value={targetCount}
                    onChange={e => setTargetCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
                </div>
              </div>
              <button className="btn btn-primary" style={{ width: '100%', padding: 11 }} disabled={running} onClick={run}>
                {running ? <><span className="spinner"></span> Discovering…</> : '✦ Run discovery'}
              </button>
            </div>

            <div className="panel">
              <div className="panel-head">
                <h2><span className="panel-num">2</span>Or import CSV</h2>
                <span className="tbl-meta">Headers: name, email, phone, website, address, city, state, niche</span>
              </div>
              <input type="file" accept=".csv" onChange={importCsv} />
            </div>
          </div>

          <div>
            <div className="panel">
              <div className="panel-head"><h2>Results</h2></div>
              {!result && <div className="empty"><div className="e-ico">✦</div><div className="e-title">No discovery run yet</div><div className="e-msg">Set criteria and click Run.</div></div>}
              {result && (
                <>
                  <div className="summary-card">
                    <div className="num">{result.inserted}</div>
                    <div className="lbl">leads inserted</div>
                  </div>
                  <div className="summary-row"><span className="k">Found by adapter</span><span className="v">{result.found}</span></div>
                  <div className="summary-row"><span className="k">Duplicates skipped</span><span className="v">{result.duplicates}</span></div>
                  <div className="summary-row"><span className="k">Disqualified</span><span className="v">{result.disqualified}</span></div>
                  {result.attribution && (
                    <p className="panel-desc" style={{ marginTop: 12 }}>{result.attribution}</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
