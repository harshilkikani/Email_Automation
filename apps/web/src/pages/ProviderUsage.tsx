import { useEffect, useState } from 'react';
import { api } from '../api';
import { buildRows, totalMonthCost, type RawProviderUsage, type ProviderRow } from '../lib/provider-usage';

function warnClass(w: ProviderRow['warn']): string {
  if (w === 'cap' || w === 'red') return 'fail';
  if (w === 'amber') return 'warn';
  return 'pass';
}

export default function ProviderUsagePage() {
  const [raw, setRaw] = useState<RawProviderUsage | null>(null);
  useEffect(() => { api.get<RawProviderUsage>('/provider-usage').then(r => { if (r.ok && r.data) setRaw(r.data); }); }, []);

  if (!raw) return <div className="empty">Loading provider usage…</div>;
  const rows = buildRows(raw);
  const total = totalMonthCost(rows);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Provider <span className="it">usage</span></h1>
        <p className="page-subtitle">
          Today and month-to-date counts + dollars per provider. Sub-$5/month architecture means
          paid providers are gated behind score thresholds + monthly caps. Use this page before any new send wave.
        </p>
      </div>
      <div className="container">
        {raw.sampleMode && (
          <div className="callout warn">
            <strong>Sample mode is on.</strong> No paid provider has been called. Set <code>SAMPLE_MODE=false</code> in <code>.env</code> / Fly secrets to record real usage.
          </div>
        )}
        {rows.length === 0 && (
          <div className="empty"><div className="e-ico">$</div><div className="e-title">No paid provider usage yet</div></div>
        )}
        {rows.length > 0 && (
          <div className="stat-grid">
            <div className="stat-card accent">
              <div className="label">Month-to-date</div>
              <div className="value">${total.toFixed(2)}</div>
              <div className="delta flat">across all paid providers</div>
            </div>
            <div className="stat-card">
              <div className="label">Forecast cap (v3.1)</div>
              <div className="value">$3.40</div>
              <div className="delta flat">target monthly burn</div>
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panel-head">
            <h2>By provider</h2>
            <a className="btn btn-secondary btn-sm" href="/api/export/provider-usage.csv">Export CSV</a>
          </div>
          <div className="tbl-wrap" style={{ border: 'none' }}>
            <table>
              <thead><tr>
                <th>Provider</th><th>Enabled</th>
                <th>Today calls</th><th>Today $</th>
                <th>MTD calls</th><th>MTD $</th>
                <th>Budget</th><th>Remaining</th><th>%</th>
                <th>Last call</th>
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.provider} title={r.notes}>
                    <td><strong>{r.provider}</strong></td>
                    <td>
                      <span className={`pill ${r.enabled ? 'replied' : 'contacted'}`}>
                        {r.enabled ? 'enabled' : 'off'}
                      </span>
                    </td>
                    <td>{r.todayCalls}</td>
                    <td>${r.todayCostUsd.toFixed(2)}</td>
                    <td>{r.monthCalls}</td>
                    <td>${r.monthCostUsd.toFixed(2)}</td>
                    <td>{r.budgetUsd === null ? '—' : `$${r.budgetUsd.toFixed(2)}`}</td>
                    <td>{r.remainingUsd === null ? '—' : `$${r.remainingUsd.toFixed(2)}`}</td>
                    <td>
                      <span className={`h-tile ${warnClass(r.warn)}`} style={{ padding: '2px 8px', display: 'inline-block' }}>
                        {r.budgetUsd === null ? '—' : r.pct.toFixed(0) + '%'}
                      </span>
                    </td>
                    <td>{r.lastCallAt ? new Date(r.lastCallAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Why we spent</h2></div>
          <ul style={{ marginLeft: 20, color: 'var(--fg-2)', fontSize: 12.5, lineHeight: 1.7 }}>
            {rows.filter(r => r.monthCalls > 0).map(r => (
              <li key={r.provider}><strong>{r.provider}</strong> — {r.notes}</li>
            ))}
            {rows.every(r => r.monthCalls === 0) && (
              <li>No paid usage this month. Free signals + scraping are doing the work.</li>
            )}
          </ul>
        </div>
      </div>
    </>
  );
}
