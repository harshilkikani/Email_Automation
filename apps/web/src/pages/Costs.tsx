import { useEffect, useState } from 'react';
import { api } from '../api';

interface Costs { breakdown: Record<string, number>; forecast: number }

export default function CostsPage() {
  const [c, setC] = useState<Costs | null>(null);
  useEffect(() => { api.get<Costs>('/metrics/costs').then(r => { if (r.ok && r.data) setC(r.data); }); }, []);
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Monthly <span className="it">cost forecast</span></h1>
        <p className="page-subtitle">All paid provider calls are tracked in <code>cost_events</code>. Forecast assumes 5k sends/mo and 1k qualified leads.</p>
      </div>
      <div className="container">
        <div className="builder-grid">
          <div>
            <div className="panel">
              <div className="panel-head"><h2>Per-provider month-to-date</h2></div>
              {c && Object.keys(c.breakdown).length === 0 && (
                <div className="empty"><div className="e-ico">$</div><div className="e-title">No paid provider usage yet</div></div>
              )}
              {c && Object.entries(c.breakdown).map(([prov, usd]) => (
                <div className="kv" key={prov}>
                  <span className="k">{prov}</span><span className="v">${usd.toFixed(2)}</span>
                </div>
              ))}
            </div>
            <div className="panel">
              <div className="panel-head"><h2>What we deliberately don't pay for</h2></div>
              <ul style={{ marginLeft: 20, color: 'var(--fg-2)', fontSize: 12.5, lineHeight: 1.7 }}>
                <li>Apollo / Clay / LinkedIn / ZoomInfo / RocketReach — <strong>never</strong></li>
                <li>Per-lead runtime AI — deferred to v1</li>
                <li>Google Places — disabled unless explicitly turned on</li>
                <li>Twilio Lookup at intake — deferred to point-of-sale</li>
                <li>Emailable monthly minimum — replaced by Bouncer PAYG</li>
              </ul>
            </div>
          </div>
          <div>
            <div className="panel">
              <div className="panel-head"><h2>Forecast</h2></div>
              <div className="summary-card">
                <div className="num">${c?.forecast?.toFixed(2) ?? '—'}</div>
                <div className="lbl">monthly total (v3.1)</div>
              </div>
              <div className="summary-row"><span className="k">Fly auto-stop</span><span className="v">$1.50</span></div>
              <div className="summary-row"><span className="k">Neon Postgres free</span><span className="v">$0.00</span></div>
              <div className="summary-row"><span className="k">Domain (annual ÷ 12)</span><span className="v">$1.00</span></div>
              <div className="summary-row"><span className="k">AWS SES (5k sends)</span><span className="v">$0.50</span></div>
              <div className="summary-row"><span className="k">Bouncer PAYG amortized</span><span className="v">$0.40</span></div>
              <div className="summary-row"><span className="k">OSM / NOAA / Census / state</span><span className="v">$0.00</span></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
