import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

interface DashboardMetrics {
  totals: { leads: number; freshLast7d: number };
  last24h: { sent: number; delivered: number; bounced: number; complained: number; replied: number; unsubscribed: number };
  verification?: { deliverable: number; risky: number; undeliverable: number; unchecked: number; withEmail: number };
  providers: { sampleMode: boolean; budgetMode: string };
}

interface Blocker { key: string; status: string; message: string; howToFix?: string | null }
interface ReadyState { ok: boolean; blockingCount?: number; blockers?: Blocker[] }

export default function Dashboard() {
  const nav = useNavigate();
  const [m, setM] = useState<DashboardMetrics | null>(null);
  const [ready, setReady] = useState<ReadyState | null>(null);
  const [jobValue, setJobValue] = useState(800);
  const [closeRate, setCloseRate] = useState(30);

  useEffect(() => {
    api.get<DashboardMetrics>('/metrics/dashboard').then(r => { if (r.ok && r.data) setM(r.data); });
    /* /api/ready returns 503 (ok:false) while launch-gate blockers remain, but
       the JSON body is still on r.data — read it regardless of the ok flag. */
    api.get<ReadyState>('/ready').then(r => { if (r.data) setReady(r.data as ReadyState); });
  }, []);

  const blockers = (ready?.blockers ?? []).filter(b => b.status === 'fail');

  const sent = m?.last24h.sent ?? 0;
  const replies = Math.round(sent * 0.04);
  const booked = Math.round(replies * (closeRate / 100));
  const revenue = booked * jobValue;

  return (
    <>
      <div className="hero">
        <span className="hero-eyebrow">◆ Internal lead-gen &amp; cold-email console</span>
        <h1 className="hero-title">Find leads daily. <span className="it">Send smarter.</span></h1>
        <p className="hero-subtitle">
          Discover fresh businesses, dedupe automatically, personalize every email, and run compliant outreach sequences — all in one console.
        </p>
        <div className="qa-grid">
          <div className="qa-card" onClick={() => nav('/discover')}>
            <div className="qa-icon">✦</div>
            <div className="qa-title">Find new leads</div>
            <div className="qa-desc">OSM Overpass primary; CSV import; deduped against your library.</div>
            <span className="qa-arrow">Start →</span>
          </div>
          <div className="qa-card" onClick={() => nav('/validation')}>
            <div className="qa-icon">◐</div>
            <div className="qa-title">Validation mode</div>
            <div className="qa-desc">30-day plan: eyeball → reach → engagement → refine.</div>
            <span className="qa-arrow">Open →</span>
          </div>
          <div className="qa-card" onClick={() => nav('/campaigns')}>
            <div className="qa-icon">✶</div>
            <div className="qa-title">Build a campaign</div>
            <div className="qa-desc">Templated, signal-aware, plain-text, compliant.</div>
            <span className="qa-arrow">Start →</span>
          </div>
          <div className="qa-card" onClick={() => nav('/deliverability')}>
            <div className="qa-icon">◈</div>
            <div className="qa-title">Deliverability</div>
            <div className="qa-desc">Verify SPF / DKIM / DMARC / MX before launch.</div>
            <span className="qa-arrow">Check →</span>
          </div>
        </div>
      </div>
      <div className="container">
        <div className="stat-grid">
          <div className="stat-card"><div className="label">Total leads</div>
            <div className="value">{m?.totals.leads ?? '—'}</div></div>
          <div className="stat-card accent"><div className="label">Fresh (7d)</div>
            <div className="value">{m?.totals.freshLast7d ?? '—'}</div></div>
          <div className="stat-card"><div className="label">Sent (24h)</div>
            <div className="value">{m?.last24h.sent ?? '—'}</div></div>
          <div className="stat-card"><div className="label">Delivered</div>
            <div className="value">{m?.last24h.delivered ?? '—'}</div></div>
          <div className="stat-card"><div className="label">Replied</div>
            <div className="value">{m?.last24h.replied ?? '—'}</div></div>
          <div className="stat-card"><div className="label">Bounced</div>
            <div className="value">{m?.last24h.bounced ?? '—'}</div></div>
        </div>

        <div className="builder-grid">
          <div>
            <div className="panel">
              <div className="panel-head">
                <h2>⚡ Launch checklist</h2>
                {ready && <span className="tbl-meta">{blockers.length === 0 ? 'all clear' : `${blockers.length} blocking`}</span>}
              </div>
              {!ready && <p className="panel-desc">Loading launch-gate status…</p>}
              {ready && blockers.length === 0 && (
                <div className="nba">
                  <div className="nba-ico" style={{ color: 'var(--accent)' }}>✓</div>
                  <div className="nba-body">
                    <div className="nba-title">All launch-gate checks pass</div>
                    <div className="nba-desc">You're clear to enable real sending. Build a campaign to start outreach.</div>
                  </div>
                </div>
              )}
              {blockers.slice(0, 6).map((b, i) => (
                <div className="nba" key={b.key}>
                  <div className="nba-ico">{i + 1}</div>
                  <div className="nba-body">
                    <div className="nba-title">{b.message}</div>
                    {b.howToFix && <div className="nba-desc">{b.howToFix}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="panel">
              <div className="panel-head"><h2>◆ ROI calculator</h2></div>
              <div className="field">
                <label className="field-label">Avg. job value ($)</label>
                <input className="field-input" type="number" value={jobValue}
                  onChange={e => setJobValue(Number(e.target.value) || 0)} />
              </div>
              <div className="field">
                <label className="field-label">Close rate from booked calls (%)</label>
                <input className="field-input" type="number" value={closeRate}
                  onChange={e => setCloseRate(Number(e.target.value) || 0)} />
              </div>
              <div className="divider" />
              <div className="kv"><span className="k">Emails sent (24h)</span><span className="v">{sent}</span></div>
              <div className="kv"><span className="k">Projected replies (4%)</span><span className="v">{replies}</span></div>
              <div className="kv"><span className="k">Projected booked</span><span className="v">{booked}</span></div>
              <div className="kv">
                <span className="k">Projected revenue</span>
                <span className="v" style={{ color: 'var(--accent)' }}>${revenue.toLocaleString()}</span>
              </div>
            </div>
            <div className="panel">
              <div className="panel-head">
                <h2>✉ Email verification</h2>
                <span className="tbl-meta" style={{ cursor: 'pointer' }} onClick={() => nav('/leads')}>View →</span>
              </div>
              {m?.verification && m.verification.withEmail > 0 ? (
                <>
                  <div className="kv"><span className="k">Deliverable</span><span className="v" style={{ color: 'var(--accent)' }}>{m.verification.deliverable}</span></div>
                  <div className="kv"><span className="k">Risky (role / catch-all)</span><span className="v" style={{ color: 'var(--warn)' }}>{m.verification.risky}</span></div>
                  <div className="kv"><span className="k">Undeliverable</span><span className="v" style={{ color: 'var(--danger)' }}>{m.verification.undeliverable}</span></div>
                  <div className="kv"><span className="k">Unchecked</span><span className="v">{m.verification.unchecked}</span></div>
                </>
              ) : (
                <p className="panel-desc">No emailable leads yet. Run discovery or import a CSV, then verify from the Leads page.</p>
              )}
            </div>
            <div className="panel">
              <div className="panel-head"><h2>◷ Runtime mode</h2></div>
              <div className="kv">
                <span className="k">Sample mode</span>
                <span className="v">{m?.providers.sampleMode ? 'On' : 'Off (live)'}</span>
              </div>
              <div className="kv">
                <span className="k">Budget mode</span>
                <span className="v">{m?.providers.budgetMode}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
