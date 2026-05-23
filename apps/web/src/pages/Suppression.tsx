import { useEffect, useState } from 'react';
import { api } from '../api';

interface SuppRow { id: string; email: string | null; domain: string | null; scope: string; reason: string; sourceEvent: string | null; createdAt: string }

export default function Suppression() {
  const [rows, setRows] = useState<SuppRow[]>([]);
  useEffect(() => { api.get<{ rows: SuppRow[] }>('/suppressions').then(r => { if (r.ok && r.data) setRows(r.data.rows); }); }, []);
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Suppression <span className="it">list</span></h1>
        <p className="page-subtitle">Auto-fed from unsubscribes, hard bounces, complaints, and hostile replies. Manual additions are scoped per-org.</p>
      </div>
      <div className="container">
        <div className="tbl-wrap">
          <div className="tbl-head"><h3>All suppressions</h3><span className="tbl-meta">{rows.length}</span></div>
          <table>
            <thead><tr><th>Email / Domain</th><th>Scope</th><th>Reason</th><th>Event</th><th>Added</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td><span className="email-text">{r.email ?? r.domain ?? '—'}</span></td>
                  <td>{r.scope}</td>
                  <td>{r.reason}</td>
                  <td>{r.sourceEvent ?? '—'}</td>
                  <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty"><div className="e-ico">⊘</div><div className="e-title">No suppressions yet</div></div>}
        </div>
      </div>
    </>
  );
}
