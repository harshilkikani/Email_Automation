import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

interface DashboardMetrics {
  totals: { leads: number; freshLast7d: number };
  last24h: { sent: number; delivered: number; bounced: number; complained: number; replied: number; unsubscribed: number };
  providers: { sampleMode: boolean; budgetMode: string };
}

interface LeadStats {
  total: number; with_email: number; sendable: number; contacted: number;
  today: number; week: number; byNiche: { k: string; n: number }[];
}

export default function Dashboard() {
  const nav = useNavigate();
  const [m, setM] = useState<DashboardMetrics | null>(null);
  const [ls, setLs] = useState<LeadStats | null>(null);
  const [jobValue, setJobValue] = useState(800);
  const [closeRate, setCloseRate] = useState(30);

  useEffect(() => {
    api.get<DashboardMetrics>('/metrics/dashboard').then(r => { if (r.ok && r.data) setM(r.data); });
    api.get<LeadStats>('/leads/stats').then(r => { if (r.ok && r.data) setLs(r.data); });
  }, []);

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
        {/* Lead pool volume */}
        <div className="stat-grid">
          <div className="stat-card"><div className="label">Total leads</div>
            <div className="value">{ls ? ls.total.toLocaleString() : '—'}</div></div>
          <div className="stat-card accent"><div className="label">Sendable (ready)</div>
            <div className="value">{ls ? ls.sendable.toLocaleString() : '—'}</div></div>
          <div className="stat-card"><div className="label">With email</div>
            <div className="value">{ls ? ls.with_email.toLocaleString() : '—'}</div></div>
          <div className="stat-card"><div className="label">Contacted</div>
            <div className="value">{ls ? ls.contacted.toLocaleString() : '—'}</div></div>
          <div className="stat-card"><div className="label">Added today</div>
            <div className="value">{ls ? `+${ls.today.toLocaleString()}` : '—'}</div></div>
          <div className="stat-card"><div className="label">This week</div>
            <div className="value">{ls ? `+${ls.week.toLocaleString()}` : '—'}</div></div>
        </div>

        {/* 24h send activity */}
        <div className="stat-grid">
          <div className="stat-card"><div className="label">Sent (24h)</div>
            <div className="value">{m?.last24h.sent ?? '—'}</div></div>
          <div className="stat-card"><div className="label">Delivered</div>
            <div className="value">{m?.last24h.delivered ?? '—'}</div></div>
          <div className="stat-card accent"><div className="label">Replied</div>
            <div className="value">{m?.last24h.replied ?? '—'}</div></div>
          <div className="stat-card"><div className="label">Bounced</div>
            <div className="value">{m?.last24h.bounced ?? '—'}</div></div>
        </div>

        {ls && ls.byNiche.length > 0 && (
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-head"><h2>◆ Lead pool by trade</h2>
              <span className="tbl-meta">filling automatically · {ls.byNiche.length} trades</span></div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ls.byNiche.map(b => (
                <span key={b.k} className="pill" style={{ fontSize: 12.5 }}>{b.k}: <strong>{b.n.toLocaleString()}</strong></span>
              ))}
            </div>
          </div>
        )}

        <div className="builder-grid">
          <div>
            <div className="panel">
              <div className="panel-head"><h2>⚡ Next best actions</h2></div>
              <div className="nba">
                <div className="nba-ico">①</div>
                <div className="nba-body">
                  <div className="nba-title">Confirm SES production access</div>
                  <div className="nba-desc">Settings → toggle "Production access confirmed" once your AWS ticket is approved.</div>
                </div>
              </div>
              <div className="nba">
                <div className="nba-ico">②</div>
                <div className="nba-body">
                  <div className="nba-title">Verify DNS for your outreach subdomain</div>
                  <div className="nba-desc">Deliverability → Check DNS. Spec-required SPF / DKIM / DMARC alignment.</div>
                </div>
              </div>
              <div className="nba">
                <div className="nba-ico">③</div>
                <div className="nba-body">
                  <div className="nba-title">Run Day-0 eyeball review</div>
                  <div className="nba-desc">Validation → New experiment. Rate 50 top leads before any sends.</div>
                </div>
              </div>
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
