import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';

interface SenderDomain {
  id: string; domain: string;
  spfStatus: string; dkimStatus: string; dmarcStatus: string; mxStatus: string;
  warmupState: string; dailySendBudget: number; sendsToday: number;
  isActive: boolean; unsubReachable: boolean; unsubLastStatus: number | null;
  dkimSelectors: string[]; spfExpectedInclude: string;
  lastCheckedAt: string | null;
  lastCheckDetail: any;
  lastSeedlistPassAt: string | null;
}

function tileClass(s: string) { return s === 'pass' ? 'pass' : s === 'fail' ? 'fail' : 'warn'; }

export default function Deliverability() {
  const t = useToast();
  const [rows, setRows] = useState<SenderDomain[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const r = await api.get<{ rows: SenderDomain[] }>('/sender-domains');
    if (r.ok && r.data) setRows(r.data.rows);
  };
  useEffect(() => { refresh(); }, []);

  const create = async () => {
    if (!newDomain) return;
    const r = await api.post('/sender-domains', { domain: newDomain });
    if (!r.ok) { t.push('error', 'Create failed', r.error); return; }
    setNewDomain(''); refresh();
  };
  const check = async (id: string) => {
    setBusy(id);
    const r = await api.post(`/sender-domains/${id}/check-dns`);
    setBusy(null);
    if (!r.ok) { t.push('error', 'DNS check failed', r.error); return; }
    t.push('success', 'DNS checked');
    refresh();
  };
  const testSend = async (id: string) => {
    setBusy(id);
    const r = await api.post(`/sender-domains/${id}/test-send`);
    setBusy(null);
    if (!r.ok) { t.push('error', 'Test send failed', r.error); return; }
    t.push('success', `Sent to ${r.data.sent} seedlist mailbox(es)`);
    refresh();
  };

  const score = (r: SenderDomain) =>
    (r.spfStatus === 'pass' ? 20 : 0) + (r.dkimStatus === 'pass' ? 30 : 0) +
    (r.dmarcStatus === 'pass' ? 20 : 0) + (r.mxStatus === 'pass' ? 10 : 0) +
    (r.unsubReachable ? 20 : 0);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Inbox <span className="it">deliverability</span></h1>
        <p className="page-subtitle">SPF + DKIM (all 3 SES selectors) + DMARC + unsubscribe reachability. Production sends are blocked until all four are green.</p>
      </div>
      <div className="container">
        <div className="panel">
          <div className="panel-head"><h2>Add an outreach subdomain</h2></div>
          <div className="field-row">
            <input className="field-input" value={newDomain} onChange={e => setNewDomain(e.target.value)} placeholder="e.g. outreach.yourdomain.com" />
            <button className="btn btn-primary btn-sm" onClick={create}>Add</button>
          </div>
          <p className="field-help">Always use a dedicated subdomain — never the root.</p>
        </div>

        {rows.length === 0 && (
          <div className="empty"><div className="e-ico">◈</div><div className="e-title">No sender domains yet</div></div>
        )}
        {rows.map(r => (
          <div className="panel" key={r.id}>
            <div className="health-hero">
              <div className="health-score">{score(r)}</div>
              <div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>{r.domain}</div>
                <div className="panel-desc">
                  Warmup: <strong>{r.warmupState}</strong> · {r.sendsToday}/{r.dailySendBudget} sent today
                  {r.lastCheckedAt && <> · checked {new Date(r.lastCheckedAt).toLocaleString()}</>}
                </div>
                <div className="health-tiles" style={{ marginTop: 12 }}>
                  {[
                    { name: 'SPF', state: r.spfStatus },
                    { name: 'DKIM', state: r.dkimStatus },
                    { name: 'DMARC', state: r.dmarcStatus },
                    { name: 'MX', state: r.mxStatus },
                    { name: 'Unsub', state: r.unsubReachable ? 'pass' : 'fail' },
                  ].map(t => (
                    <div className={`h-tile ${tileClass(t.state)}`} key={t.name}>
                      <div className="ht-name">{t.name}</div>
                      <div className="ht-state">{t.state}</div>
                    </div>
                  ))}
                </div>
                {r.lastCheckDetail?.detail?.dkim?.missing?.length > 0 && (
                  <div className="callout danger" style={{ marginTop: 10 }}>
                    <strong>DKIM missing selectors:</strong> {r.lastCheckDetail.detail.dkim.missing.join(', ')}.
                    SES Easy DKIM requires all three (s1, s2, s3).
                  </div>
                )}
                {r.lastCheckDetail?.detail?.spf?.includesEsp === false && (
                  <div className="callout danger" style={{ marginTop: 10 }}>
                    <strong>SPF wrong:</strong> Expected include of <code>{r.lastCheckDetail.detail.spf.expectedInclude}</code>.
                    Add it to your SPF TXT record.
                  </div>
                )}
                {r.lastSeedlistPassAt && (
                  <div className="kv" style={{ marginTop: 10 }}>
                    <span className="k">Last seedlist test passed</span>
                    <span className="v">{new Date(r.lastSeedlistPassAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={busy === r.id} onClick={() => check(r.id)}>
                  {busy === r.id ? <span className="spinner"></span> : 'Check DNS'}
                </button>
                <button className="btn btn-secondary btn-sm" disabled={busy === r.id} onClick={() => testSend(r.id)}>
                  Send seedlist test
                </button>
              </div>
            </div>
          </div>
        ))}

        <div className="panel">
          <div className="panel-head"><h2>Reminders</h2></div>
          <ul style={{ marginLeft: 20, color: 'var(--fg-2)', fontSize: 12.5, lineHeight: 1.7 }}>
            <li>Spam complaint rate must stay <strong>under 0.30%</strong>; we auto-pause at 0.10%.</li>
            <li>Hard-bounce rate must stay <strong>under 5%</strong>; we auto-pause at 4%.</li>
            <li>Honor unsubscribes within <strong>2 days</strong>. We honor immediately.</li>
            <li>Every send carries <code>List-Unsubscribe</code> + <code>List-Unsubscribe-Post: List-Unsubscribe=One-Click</code>.</li>
            <li>Plain-text only at MVP. No open tracking. No HTML.</li>
          </ul>
        </div>
      </div>
    </>
  );
}
