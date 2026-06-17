import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';

const NICHES = ['Septic', 'Water/Mold', 'HVAC', 'Roofer', 'Plumber', 'Electrician', 'Towing', 'Real Estate',
  'Pest Control', 'Garage Door', 'Locksmith', 'Appliance Repair', 'Pool Service', 'Landscaping',
  'Painter', 'Carpet Cleaning', 'Handyman', 'Tree Service',
  'Fencing', 'Concrete', 'Moving', 'Junk Removal', 'Window Cleaning', 'Pressure Washing', 'Solar', 'Flooring'];
const US_METRO_HINT = 336;  // size of the server's built-in metro sweep list (display hint)

interface SendStatus {
  sentToday: number; dailyCap: number; remaining: number; capReached: boolean;
  pending: number; dueNow: number; deferred: number; scheduledNext: string | null;
}

/** Friendly "Wed 10:00 AM (in ~6h)" for the next scheduled send batch. */
function formatWhen(iso: string | null): string {
  if (!iso) return 'soon';
  const d = new Date(iso); if (isNaN(d.getTime())) return 'soon';
  const hrs = Math.max(0, Math.round((d.getTime() - Date.now()) / 3_600_000));
  const when = d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return hrs <= 0 ? when : `${when} (in ~${hrs}h)`;
}

interface Recipient { name: string; city: string | null; email: string | null; owner: string | null; opener: string | null; verified: boolean }
interface ScrapeResult {
  campaignId: string; found: number; inserted: number; withEmail: number; verified: number; recipientCount: number;
  recipients: Recipient[]; sample: { subject: string; body: string } | null;
}
interface Status { status: string | null; total: number; sent: number; failed: number; pending: number }

interface Sweep { cursor: number; total: number; pool: number; added: number; last: string[] }

export default function ScrapeSend() {
  const t = useToast();
  const [source, setSource] = useState<'auto' | 'online' | 'licenses' | 'mass' | 'offer'>('auto');
  const [offer, setOffer] = useState<'claim_supplement' | 'liens' | 'reviews'>('claim_supplement');
  const [niche, setNiche] = useState('Septic');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [count, setCount] = useState(15);
  const [followups, setFollowups] = useState(3);
  const [phase, setPhase] = useState<'form' | 'review' | 'sending'>('form');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ScrapeResult | null>(null);
  const [gate, setGate] = useState<any>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const poll = useRef<number | null>(null);

  /* Mass mode: niche-only auto-sweep of US metros into one growing pool. */
  const [sweeping, setSweeping] = useState(false);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const stopRef = useRef(false);

  /* DMARC authentication summary (deliverability health). */
  const [dmarc, setDmarc] = useState<{ passPct: number | null; totalMessages: number; reports: number } | null>(null);
  /* Daily send-limit status. */
  const [sendStatus, setSendStatus] = useState<SendStatus | null>(null);
  /* Lead-pool volume. */
  const [leadStats, setLeadStats] = useState<{ total: number; with_email: number; sendable: number; contacted: number; today: number; week: number; byNiche: { k: string; n: number }[] } | null>(null);
  /* Focus mode: trades that send first (pool keeps everything). */
  const [focus, setFocusState] = useState<string[]>([]);
  const [showFocus, setShowFocus] = useState(false);

  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); stopRef.current = true; }, []);
  useEffect(() => { (async () => {
    const r = await api.get<{ summary: { passPct: number | null; totalMessages: number; reports: number } }>('/dmarc/summary');
    if (r.ok && r.data?.summary) setDmarc(r.data.summary);
    const s = await api.get<SendStatus>('/send-status');
    if (s.ok && s.data) setSendStatus(s.data);
    const ls = await api.get<typeof leadStats>('/leads/stats');
    if (ls.ok && ls.data) setLeadStats(ls.data);
    const f = await api.get<{ niches: string[] }>('/focus');
    if (f.ok && f.data) setFocusState(f.data.niches ?? []);
  })(); }, [phase, status]);

  const toggleFocus = async (niche: string) => {
    const next = focus.includes(niche) ? focus.filter(n => n !== niche) : [...focus, niche];
    setFocusState(next);
    const r = await api.post<{ niches: string[]; repriced: number }>('/focus', { niches: next });
    if (r.ok && r.data) { setFocusState(r.data.niches); t.push('success', next.length ? `Focusing ${next.length} trade${next.length === 1 ? '' : 's'} — other leads stay in the pool` : 'Focus cleared — best-fit leads send first'); }
  };

  const startPolling = (campaignId: string) => {
    if (poll.current) window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      const s = await api.get<Status>(`/quick/status?campaignId=${campaignId}`);
      if (s.ok && s.data) {
        setStatus(s.data);
        if (s.data.pending === 0 && s.data.total > 0 && poll.current) { window.clearInterval(poll.current); poll.current = null; }
      }
    }, 3000);
  };

  /* Loop the sweep endpoint through the whole metro list, accumulating the pool. */
  const runSweep = async () => {
    setSweeping(true); stopRef.current = false;
    let cursor = sweep && sweep.cursor < sweep.total ? sweep.cursor : 0;
    let added = sweep?.added ?? 0;
    try {
      while (!stopRef.current) {
        const r = await api.post<any>('/quick/sweep', { niche, cursor });
        if (!r.ok || !r.data) { t.push('error', 'Sweep failed', r.error); break; }
        added += r.data.added;
        setSweep({ cursor: r.data.nextCursor ?? r.data.total, total: r.data.totalMetros, pool: r.data.poolCount, added, last: r.data.metrosSwept });
        if (r.data.done || r.data.nextCursor == null) { t.push('success', `Sweep complete · ${r.data.poolCount} ready to send`); break; }
        cursor = r.data.nextCursor;
      }
    } finally { setSweeping(false); }
  };

  const sendAll = async () => {
    setBusy(true); setGate(null);
    const r = await api.post<any>('/quick/send-all', { niche, followups });
    setBusy(false);
    if (!r.ok) {
      if (r.data?.gate) { setGate(r.data.gate); t.push('error', 'Blocked by launch gate — see below'); }
      else if (r.error === 'empty_pool') t.push('warn', 'No verified leads in the pool yet — run a sweep first');
      else t.push('error', 'Send failed', r.error);
      return;
    }
    t.push('success', `Queued ${r.data.recipientCount} — campaign live, sending at prospects’ local mornings`);
    setPhase('sending');
    startPolling(r.data.campaignId);
  };

  /* Primary flow: niche only, "Get N leads anywhere." */
  const getLeads = async () => {
    setBusy(true); setGate(null);
    const r = await api.post<ScrapeResult>('/quick/get', { niche, count, followups });
    setBusy(false);
    if (!r.ok || !r.data) { t.push('error', r.error === 'discovery_failed' ? 'Discovery failed — try again' : 'Couldn’t get leads', r.error); return; }
    setRes(r.data); setPhase('review');
    t.push('success', `${r.data.inserted} new · pool ${r.data.recipientCount} · ${r.data.verified} verified`);
  };

  /* Validation: A/B a different offer (claim supplement / get-paid) on the niche's pool. */
  const validateOffer = async () => {
    setBusy(true); setGate(null);
    const r = await api.post<ScrapeResult>('/quick/validate', { offer, niche, count, followups });
    setBusy(false);
    if (!r.ok || !r.data) { t.push('error', 'Couldn’t stage offer test', r.error); return; }
    setRes(r.data); setPhase('review');
    const offerName = offer === 'claim_supplement' ? 'claim-supplement' : offer === 'liens' ? 'get-paid' : 'reviews';
    t.push('success', `Staged ${r.data.recipientCount} for the ${offerName} test`);
  };

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
    startPolling(res.campaignId);
  };

  const reset = () => { setPhase('form'); setRes(null); setGate(null); setStatus(null); stopRef.current = true; if (poll.current) window.clearInterval(poll.current); };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Scrape <span className="it">&amp; send</span></h1>
        <p className="page-subtitle">Find local businesses, see a personalized email for each, and send — in one place.</p>
        {dmarc && dmarc.reports > 0 && (
          <p className="page-subtitle" style={{ marginTop: 6, fontSize: 13 }}
             title="DMARC pass rate across all mail seen by providers. Forwarded copies of your mail break SPF/DKIM and lower this — your direct sends authenticate separately.">
            <span style={{ color: (dmarc.passPct ?? 0) >= 70 ? 'var(--accent)' : '#b8860b' }}>●</span>{' '}
            Email authentication active — <strong>{dmarc.passPct ?? 0}% DMARC pass</strong> ({dmarc.totalMessages} msgs/14d; forwarded copies lower this)
          </p>
        )}
      </div>
      <div className="container">
        {/* Lead-pool volume — at-a-glance */}
        {leadStats && (
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-head" style={{ marginBottom: 10 }}>
              <h2>Lead pool</h2>
              <span className="tbl-meta">{leadStats.today > 0 ? `+${leadStats.today} today` : ''}{leadStats.week > 0 ? ` · +${leadStats.week} this week` : ''} · filling automatically</span>
            </div>
            <div className="health-tiles">
              {[['Total leads', leadStats.total], ['Sendable (ready)', leadStats.sendable], ['With email', leadStats.with_email], ['Contacted', leadStats.contacted], ['Added today', leadStats.today]].map(([k, v]) => (
                <div className="h-tile" key={k as string}><div className="ht-name">{k}</div><div className="ht-state">{(v as number).toLocaleString()}</div></div>
              ))}
            </div>
            {leadStats.byNiche.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {leadStats.byNiche.slice(0, 12).map(b => (
                  <span key={b.k} className="pill" style={{ fontSize: 12 }}>{b.k}: <strong>{b.n}</strong></span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Daily send-limit status */}
        {sendStatus && sendStatus.dailyCap > 0 && (
          sendStatus.capReached ? (
            <div className="callout danger" style={{ marginBottom: 14 }}>
              <strong>⏸ Daily send limit reached — {sendStatus.sentToday}/{sendStatus.dailyCap} sent today.</strong>{' '}
              {sendStatus.pending > 0 ? `${sendStatus.pending} queued email${sendStatus.pending === 1 ? '' : 's'} will resume automatically tomorrow.` : 'Sending resumes tomorrow.'} This protects your domain reputation during warm-up; the cap rises as you keep sending.
            </div>
          ) : (
            <div className="callout" style={{ marginBottom: 14 }}>
              <strong>{sendStatus.sentToday}/{sendStatus.dailyCap} sent today</strong> · {sendStatus.remaining} left in today’s safe limit{sendStatus.pending > 0 ? ` · ${sendStatus.pending} queued` : ''}.
            </div>
          )
        )}

        {/* Scheduled-send status — makes the local-timezone timing visible so a staged
            campaign never looks "stuck". Shows when emails are deferred to local mornings. */}
        {sendStatus && sendStatus.deferred > 0 && !sendStatus.capReached && (
          <div className="callout" style={{ marginBottom: 14, borderLeft: '3px solid #2563eb' }}>
            <strong>📅 {sendStatus.deferred} email{sendStatus.deferred === 1 ? '' : 's'} scheduled</strong> — sending at each prospect’s local business hours (~10am) for the best open rates.{' '}
            {sendStatus.dueNow > 0 ? `${sendStatus.dueNow} going out now. ` : ''}
            Next batch: <strong>{formatWhen(sendStatus.scheduledNext)}</strong>.
            <div className="panel-desc" style={{ marginTop: 4 }}>This is normal, not a delay — your campaign is live and will send automatically. You can close this page.</div>
          </div>
        )}

        {/* Focus mode — which trades send first (pool keeps every trade) */}
        <div className="callout" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span><strong>🎯 Focus{focus.length ? `: ${focus.join(', ')}` : ' off'}</strong> · {focus.length ? 'these trades send first' : 'best-fit leads send first across all trades'}</span>
            <button className="btn-ghost" style={{ fontSize: 13 }} onClick={() => setShowFocus(v => !v)}>{showFocus ? 'Hide' : 'Change'}</button>
          </div>
          {showFocus && (
            <div style={{ marginTop: 10 }}>
              <p className="panel-desc" style={{ marginTop: 0, marginBottom: 8 }}>Pick 1–2 trades to prioritize while you find your first clients. <strong>Nothing is lost</strong> — every other metro and trade stays in the pool and sends right after, or whenever you clear the focus.</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {NICHES.map(n => (
                  <button key={n} onClick={() => toggleFocus(n)}
                    className={focus.includes(n) ? 'chip chip-on' : 'chip'}
                    style={{ padding: '4px 10px', borderRadius: 14, fontSize: 12, cursor: 'pointer', border: '1px solid var(--border, #ccc)', background: focus.includes(n) ? 'var(--accent, #2563eb)' : 'transparent', color: focus.includes(n) ? '#fff' : 'inherit' }}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Step 1 — form */}
        <div className="panel">
          <div className="panel-head"><h2>1 · Who to reach</h2></div>
          <div className="field-row">
            <div className="field"><label className="field-label">Trade</label>
              <select className="field-input" value={niche} onChange={e => setNiche(e.target.value)} disabled={phase !== 'form'}>
                {NICHES.map(n => <option key={n} value={n}>{n}</option>)}
              </select></div>
            <div className="field"><label className="field-label">Source</label>
              <select className="field-input" value={source} onChange={e => setSource(e.target.value as 'auto' | 'online' | 'licenses' | 'mass' | 'offer')} disabled={phase !== 'form'}>
                <option value="auto">Find leads anywhere (recommended)</option>
                <option value="online">Target a specific city</option>
                <option value="mass">Fill the pool fast — sweep all metros</option>
                <option value="offer">Test an offer (A/B a pitch)</option>
                <option value="licenses">My licensed-contractor list</option>
              </select></div>
            {source === 'offer' && (
              <div className="field"><label className="field-label">Offer to test</label>
                <select className="field-input" value={offer} onChange={e => setOffer(e.target.value as 'claim_supplement' | 'liens' | 'reviews')} disabled={phase !== 'form'}>
                  <option value="claim_supplement">Insurance claim supplement (roofing/restoration)</option>
                  <option value="liens">Get-paid / liens (any contractor)</option>
                  <option value="reviews">Google reviews autopilot (any local business)</option>
                </select></div>
            )}
            {source === 'online' && (
              <div className="field"><label className="field-label">City</label>
                <input className="field-input" value={city} onChange={e => setCity(e.target.value)} placeholder="Austin" disabled={phase !== 'form'} /></div>
            )}
            {source === 'online' && (
              <div className="field"><label className="field-label">State</label>
                <input className="field-input" value={state} onChange={e => setState(e.target.value)} placeholder="TX" maxLength={2} disabled={phase !== 'form'} /></div>
            )}
            {source === 'licenses' && (
              <div className="field"><label className="field-label">State</label>
                <input className="field-input" value={state} onChange={e => setState(e.target.value)} placeholder="TX" maxLength={2} disabled={phase !== 'form'} /></div>
            )}
            {source !== 'mass' && (
              <div className="field"><label className="field-label">How many</label>
                <input className="field-input" type="number" min={1} max={50} value={count} onChange={e => setCount(Number(e.target.value))} disabled={phase !== 'form'} /></div>
            )}
            <div className="field"><label className="field-label">Follow-ups</label>
              <select className="field-input" value={followups} onChange={e => setFollowups(Number(e.target.value))} disabled={phase !== 'form'}>
                <option value={0}>None (1 email)</option>
                <option value={1}>1 follow-up</option>
                <option value={2}>2 follow-ups</option>
                <option value={3}>3 follow-ups (recommended)</option>
                <option value={4}>4 follow-ups</option>
              </select></div>
          </div>
          {source === 'auto' && phase === 'form' && (
            <>
              <button className="btn btn-primary" onClick={getLeads} disabled={busy}>{busy ? <span className="spinner" /> : `Get ${count} leads`}</button>
              <p className="panel-desc" style={{ marginTop: 10 }}>No city needed — we pull <strong>{count}</strong> fresh <strong>{niche}</strong> businesses from across the US, scrape their sites for owner emails, and stage them to review. {busy ? 'Finding businesses… ~30 seconds.' : 'Collect a small batch, review, send — repeat daily.'}</p>
            </>
          )}
          {source === 'mass' && (
            <p className="panel-desc" style={{ marginTop: 4 }}>Sweeps major US metros for <strong>{niche}</strong>, piling every verified business into one pool, then you send to all of them (dripped safely within your daily cap). Best for filling the pool fast.</p>
          )}
          {source === 'offer' && phase === 'form' && (
            <>
              <button className="btn btn-primary" onClick={validateOffer} disabled={busy}>{busy ? <span className="spinner" /> : `Stage ${count} for offer test`}</button>
              <p className="panel-desc" style={{ marginTop: 10 }}>
                A/B tests a different pitch on your <strong>{niche}</strong> pool: {offer === 'claim_supplement'
                  ? <>“we recover the 20–40% insurers underpay on your claims” (best for <strong>Roofer</strong> / <strong>Water/Mold</strong>).</>
                  : <>“our AI files lien notices so you never lose the right to get paid” (any contractor).</>} Review, send, then compare reply rate in the Inbox → Performance tab.
              </p>
            </>
          )}
          {source === 'offer' && phase !== 'form' && <button className="btn btn-secondary btn-sm" onClick={reset}>↺ Start over</button>}
          {(source === 'online' || source === 'licenses') && (
            phase === 'form'
              ? <button className="btn btn-primary" onClick={scrape} disabled={busy}>{busy ? <span className="spinner" /> : 'Scrape businesses'}</button>
              : <button className="btn btn-secondary btn-sm" onClick={reset}>↺ Start over</button>)}
          {source === 'auto' && phase !== 'form' && <button className="btn btn-secondary btn-sm" onClick={reset}>↺ Start over</button>}
          {busy && phase === 'form' && (source === 'online' || source === 'licenses') && <p className="panel-desc" style={{ marginTop: 10 }}>Finding businesses and scraping their sites for emails… this can take a minute.</p>}
        </div>

        {/* Mass mode — sweep + send-to-all */}
        {source === 'mass' && phase !== 'sending' && (
          <div className="panel">
            <div className="panel-head"><h2>2 · Fill the pool & send</h2></div>
            <div className="health-tiles" style={{ marginBottom: 14 }}>
              {[['Metros swept', sweep ? `${Math.min(sweep.cursor, sweep.total)} / ${sweep.total}` : `0 / ${US_METRO_HINT}`],
                ['New this run', sweep?.added ?? 0],
                ['Ready to send', sweep?.pool ?? 0]].map(([k, v]) => (
                <div className="h-tile" key={k as string}><div className="ht-name">{k}</div><div className="ht-state">{v as any}</div></div>
              ))}
            </div>
            {sweeping && <p className="panel-desc" style={{ marginBottom: 10 }}>Sweeping {sweep?.last?.join(' · ') ?? '…'} — this runs in batches; leave it going. <strong>Pool: {sweep?.pool ?? 0}</strong></p>}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {!sweeping
                ? <button className="btn btn-primary" onClick={runSweep} disabled={busy}>{sweep && sweep.cursor < sweep.total ? 'Keep sweeping' : 'Find leads everywhere'}</button>
                : <button className="btn btn-secondary" onClick={() => { stopRef.current = true; }}>Stop sweeping</button>}
              <button className="btn btn-primary" onClick={sendAll} disabled={busy || sweeping || !sweep || sweep.pool === 0}>
                {busy ? <span className="spinner" /> : `Send to all${sweep?.pool ? ` (${sweep.pool})` : ''} — drip-safe`}
              </button>
            </div>
            {gate && (
              <div className="callout danger" style={{ marginTop: 12 }}>
                <strong>Can't send yet — {gate.blockingCount} blocker(s):</strong>
                <ul>{gate.checks.filter((c: any) => c.state === 'fail').map((c: any) => <li key={c.code}>{c.label}{c.fix ? ` — ${c.fix}` : ''}</li>)}</ul>
              </div>
            )}
            <p className="panel-desc" style={{ marginTop: 12 }}>Tip: add a free <strong>Brave Search API key</strong> (or Google Places) to pull in far more businesses per metro. OSM works with no key.</p>
          </div>
        )}

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
                <thead><tr><th style={{ textAlign: 'left' }}>Business</th><th style={{ textAlign: 'left' }}>Owner</th><th style={{ textAlign: 'left' }}>Email</th><th style={{ textAlign: 'left' }}>Verified</th><th style={{ textAlign: 'left' }}>Opener</th></tr></thead>
                <tbody>
                  {res.recipients.map((r, i) => (
                    <tr key={i} style={{ opacity: r.verified ? 1 : 0.5 }}>
                      <td>{r.name}<div style={{ color: 'var(--fg-3)' }}>{r.city}</div></td>
                      <td>{r.owner ?? '—'}</td>
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
                  <p className="panel-desc" style={{ marginTop: 8 }}>{
                    status.pending === 0 ? 'Done — all messages processed.'
                    : sendStatus && sendStatus.deferred > 0
                      ? `📅 Scheduled — emails send at each prospect’s local ~10am (next batch ${formatWhen(sendStatus.scheduledNext)}). Your campaign is live; you can close this page.`
                      : 'Sending now — drips within your daily cap; you can leave this page.'
                  }</p>
                </>
              : <p className="panel-desc">{sendStatus && sendStatus.deferred > 0
                  ? `📅 Queued — campaign is live. Emails send at each prospect’s local business hours (next batch ${formatWhen(sendStatus.scheduledNext)}); you can close this page.`
                  : 'Queued — sending starts within ~15 seconds.'}</p>}
            <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={reset}>Scrape another batch</button>
          </div>
        )}
      </div>
    </>
  );
}
