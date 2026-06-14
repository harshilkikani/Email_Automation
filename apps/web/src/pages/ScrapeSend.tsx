import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';

const NICHES = ['Septic', 'Water/Mold', 'HVAC', 'Roofer', 'Plumber', 'Electrician', 'Towing', 'Real Estate'];

interface Recipient { name: string; city: string | null; email: string | null; opener: string | null; verified: boolean }
interface ScrapeResult {
  campaignId: string; found: number; inserted: number; withEmail: number; verified: number; recipientCount: number;
  recipients: Recipient[]; sample: { subject: string; body: string } | null;
}
interface Status { status: string | null; total: number; sent: number; failed: number; pending: number }

export default function ScrapeSend() {
  const t = useToast();
  const [source, setSource] = useState<'online' | 'licenses'>('online');
  const [niche, setNiche] = useState('Septic');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [count, setCount] = useState(25);
  const [followups, setFollowups] = useState(2);
  const [phase, setPhase] = useState<'form' | 'review' | 'sending'>('form');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ScrapeResult | null>(null);
  const [gate, setGate] = useState<any>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const poll = useRef<number | null>(null);

  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);

  const scrape = async () => {
    if (!state || (source === 'online' && !city)) { t.push('warn', source === 'online' ? 'Enter a city and state' : 'Enter a state'); return; }
    setBusy(true); setGate(null);
    const r = source === 'licenses'
      ? await api.post<ScrapeResult & { needsFinder?: boolean }>('/quick/from-licenses', { niche, state, count, followups })
      : await api.post<ScrapeResult>('/quick/scrape', { niche, city, state, count, followups });
    setBusy(false);
    if (!r.ok || !r.data) { t.push('error', r.error === 'discovery_failed' ? 'Discovery failed — try another city/trade' : 'Scrape failed', r.error); return; }
    if ((r.data as any).needsFinder) { t.push('warn', 'Enable Google Places (or Foursquare) so we can find websites for your license list'); }
    setRes(r.data); setPhase('review');
    t.push('success', `${r.data.found} found · ${r.data.withEmail} with email · ${r.data.verified} verified`);
  };

  const send = async () => {
    if (!res) return;
    setBusy(true);
    const r = await api.post('/quick/send', { campaignId: res.campaignId });
    setBusy(false);
    if (!r.ok) {
      if (r.data?.gate) { setGate(r.data.gate); t.push('error', 'Blocked by launch gate — see below'); }
      else t.push('error', 'Send failed', r.error);
      return;
    }
    t.push('success', `Sending to ${res.recipientCount} businesses`);
    setPhase('sending');
    poll.current = window.setInterval(async () => {
      const s = await api.get<Status>(`/quick/status?campaignId=${res.campaignId}`);
      if (s.ok && s.data) {
        setStatus(s.data);
        if (s.data.pending === 0 && s.data.total > 0 && poll.current) { window.clearInterval(poll.current); poll.current = null; }
      }
    }, 3000);
  };

  const reset = () => { setPhase('form'); setRes(null); setGate(null); setStatus(null); if (poll.current) window.clearInterval(poll.current); };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Scrape <span className="it">&amp; send</span></h1>
        <p className="page-subtitle">Find local businesses, see a personalized email for each, and send — in one place.</p>
      </div>
      <div className="container">
        {/* Step 1 — form */}
        <div className="panel">
          <div className="panel-head"><h2>1 · Who to reach</h2></div>
          <div className="field-row">
            <div className="field"><label className="field-label">Source</label>
              <select className="field-input" value={source} onChange={e => setSource(e.target.value as 'online' | 'licenses')} disabled={phase !== 'form'}>
                <option value="online">Find online (Places / web)</option>
                <option value="licenses">My licensed-contractor list</option>
              </select></div>
            <div className="field"><label className="field-label">Trade</label>
              <select className="field-input" value={niche} onChange={e => setNiche(e.target.value)} disabled={phase !== 'form'}>
                {NICHES.map(n => <option key={n} value={n}>{n}</option>)}
              </select></div>
            {source === 'online' && (
              <div className="field"><label className="field-label">City</label>
                <input className="field-input" value={city} onChange={e => setCity(e.target.value)} placeholder="Austin" disabled={phase !== 'form'} /></div>
            )}
            <div className="field"><label className="field-label">State</label>
              <input className="field-input" value={state} onChange={e => setState(e.target.value)} placeholder="TX" maxLength={2} disabled={phase !== 'form'} /></div>
            <div className="field"><label className="field-label">How many</label>
              <input className="field-input" type="number" min={1} max={100} value={count} onChange={e => setCount(Number(e.target.value))} disabled={phase !== 'form'} /></div>
            <div className="field"><label className="field-label">Follow-ups</label>
              <select className="field-input" value={followups} onChange={e => setFollowups(Number(e.target.value))} disabled={phase !== 'form'}>
                <option value={0}>None (1 email)</option>
                <option value={1}>1 follow-up</option>
                <option value={2}>2 follow-ups</option>
                <option value={3}>3 follow-ups</option>
              </select></div>
          </div>
          {phase === 'form'
            ? <button className="btn btn-primary" onClick={scrape} disabled={busy}>{busy ? <span className="spinner" /> : 'Scrape businesses'}</button>
            : <button className="btn btn-secondary btn-sm" onClick={reset}>↺ Start over</button>}
          {busy && phase === 'form' && <p className="panel-desc" style={{ marginTop: 10 }}>Finding businesses and scraping their sites for emails… this can take a minute.</p>}
        </div>

        {/* Step 2 — review */}
        {res && (
          <div className="panel">
            <div className="panel-head"><h2>2 · Review</h2></div>
            <div className="health-tiles" style={{ marginBottom: 14 }}>
              {[['Found', res.found], ['New leads', res.inserted], ['With email', res.withEmail], ['Verified', res.verified], ['Will send', res.recipientCount]].map(([k, v]) => (
                <div className="h-tile" key={k as string}><div className="ht-name">{k}</div><div className="ht-state">{v as number}</div></div>
              ))}
            </div>

            {res.sample && (
              <div className="callout" style={{ marginBottom: 14 }}>
                <strong>Sample email</strong> (each business gets its own opener + rep name)
                <div style={{ fontWeight: 600, margin: '8px 0 4px' }}>Subject: {res.sample.subject}</div>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: 'var(--fg-2)', margin: 0 }}>{res.sample.body}</pre>
              </div>
            )}

            {res.recipients.length > 0 ? (
              <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                <thead><tr><th style={{ textAlign: 'left' }}>Business</th><th style={{ textAlign: 'left' }}>Email</th><th style={{ textAlign: 'left' }}>Verified</th><th style={{ textAlign: 'left' }}>Opener</th></tr></thead>
                <tbody>
                  {res.recipients.map((r, i) => (
                    <tr key={i} style={{ opacity: r.verified ? 1 : 0.5 }}>
                      <td>{r.name}<div style={{ color: 'var(--fg-3)' }}>{r.city}</div></td>
                      <td>{r.email}</td>
                      <td style={{ color: r.verified ? 'var(--accent)' : 'var(--fg-3)' }}>{r.verified ? '✓ verified' : 'skipped'}</td>
                      <td style={{ color: 'var(--fg-3)' }}>{r.opener ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="panel-desc">No scrapeable emails found for this batch — try another city or trade.</p>}

            {gate && (
              <div className="callout danger" style={{ marginTop: 12 }}>
                <strong>Can't send yet — {gate.blockingCount} blocker(s):</strong>
                <ul>{gate.checks.filter((c: any) => c.state === 'fail').map((c: any) => <li key={c.code}>{c.label}{c.fix ? ` — ${c.fix}` : ''}</li>)}</ul>
              </div>
            )}

            {phase === 'review' && res.recipientCount > 0 && (
              <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={send} disabled={busy}>
                {busy ? <span className="spinner" /> : `Send to ${res.recipientCount} business${res.recipientCount === 1 ? '' : 'es'}`}
              </button>
            )}
          </div>
        )}

        {/* Step 3 — sending */}
        {phase === 'sending' && (
          <div className="panel">
            <div className="panel-head"><h2>3 · Sending</h2></div>
            {status
              ? <>
                  <div className="kv"><span className="k">Sent</span><span className="v" style={{ color: 'var(--accent)' }}>{status.sent} / {status.total}</span></div>
                  {status.failed > 0 && <div className="kv"><span className="k">Failed</span><span className="v" style={{ color: 'var(--danger,#c00)' }}>{status.failed}</span></div>}
                  <p className="panel-desc" style={{ marginTop: 8 }}>{status.pending === 0 ? 'Done — all messages processed.' : 'Sending drips within your daily cap; you can leave this page.'}</p>
                </>
              : <p className="panel-desc">Queued — sending starts within ~15 seconds.</p>}
            <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={reset}>Scrape another batch</button>
          </div>
        )}
      </div>
    </>
  );
}
