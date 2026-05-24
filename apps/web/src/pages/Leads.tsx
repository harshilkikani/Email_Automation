import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';

interface Lead {
  id: string; name: string; email: string | null; phone: string | null;
  city: string | null; state: string | null; niche: string; status: string;
  score: number; discoveredAt: string; tags: string[];
  emailVerificationStatus: string | null;
}

interface LeadDetail {
  ok: boolean;
  lead: Lead & { website: string | null; address: string | null; postalCode: string | null; disqualified: boolean; disqualificationReason: string | null };
  signals: any;
}

const STATUS_OPTIONS = ['all','new','uncontacted','contacted','replied','interested','booked','bounced','unsubscribed','dnc'];
const NICHE_OPTIONS = ['Septic', 'Water/Mold', 'HVAC', 'Roofer', 'Plumber', 'Electrician', 'Towing', 'Real Estate'];

function fmtFresh(iso: string): { label: string; cls: string } {
  const days = (Date.now() - new Date(iso).getTime()) / 86400e3;
  if (days < 1) return { label: 'today', cls: 'today' };
  if (days < 7) return { label: `${Math.floor(days)}d`, cls: 'week' };
  if (days < 30) return { label: `${Math.floor(days)}d`, cls: 'month' };
  return { label: `${Math.floor(days)}d`, cls: 'old' };
}
function nicheTag(n: string): string {
  return n === 'Roofer' ? 'roofer' : n === 'Septic' ? 'septic' : n === 'Water/Mold' ? 'water' : n === 'Real Estate' ? 're' : 'septic';
}
function scoreFillColor(s: number): string {
  if (s >= 80) return 'var(--accent)';
  if (s >= 60) return 'var(--info)';
  if (s >= 40) return 'var(--warn)';
  return 'var(--fg-3)';
}
function verifyBadge(status: string | null | undefined): { label: string; color: string; title: string } {
  switch (status) {
    case 'valid':                 return { label: 'Valid',      color: 'var(--accent)', title: 'Mailbox confirmed' };
    case 'unverifiable_provider': return { label: 'Provider',   color: 'var(--info)',   title: 'Major provider (Gmail/Outlook) — domain valid, mailbox not probed' };
    case 'unknown':               return { label: 'MX OK',      color: 'var(--info)',   title: 'Domain has a mail server; mailbox not confirmed (no SMTP probe)' };
    case 'role':                  return { label: 'Role',       color: 'var(--warn)',   title: 'Role address (info@, sales@…) — domain valid' };
    case 'catch_all':             return { label: 'Catch-all',  color: 'var(--warn)',   title: 'Domain accepts all addresses — deliverability uncertain' };
    case 'invalid':               return { label: 'Invalid',    color: 'var(--danger)', title: 'Bad syntax or no mail server — do not send' };
    case 'disposable':            return { label: 'Disposable', color: 'var(--danger)', title: 'Disposable/throwaway domain — do not send' };
    case 'skipped':               return { label: 'Skipped',    color: 'var(--fg-3)',   title: 'Verification skipped (sample mode)' };
    default:                      return { label: 'Unchecked',  color: 'var(--fg-3)',   title: 'Not yet verified' };
  }
}
function VBadge({ status }: { status: string | null | undefined }) {
  const b = verifyBadge(status);
  return (
    <span title={b.title} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, border: `1px solid ${b.color}`, color: b.color, whiteSpace: 'nowrap' }}>
      {b.label}
    </span>
  );
}

export default function Leads() {
  const t = useToast();
  const [rows, setRows] = useState<Lead[]>([]);
  const [status, setStatus] = useState('all');
  const [niche, setNiche] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState<LeadDetail | null>(null);

  const refresh = async () => {
    const q = new URLSearchParams();
    if (niche !== 'all') q.set('niche', niche);
    if (status !== 'all') q.set('status', status);
    q.set('limit', '200');
    const r = await api.get(`/leads?${q}`);
    if (r.ok && r.data) setRows(r.data.rows);
  };
  useEffect(() => { refresh();   }, [status, niche]);

  const filtered = useMemo(() => rows.filter(r => {
    if (!search) return true;
    const s = search.toLowerCase();
    return r.name.toLowerCase().includes(s)
      || (r.email ?? '').toLowerCase().includes(s)
      || (r.city ?? '').toLowerCase().includes(s);
  }), [rows, search]);

  const openDrawer = async (id: string) => {
    const r = await api.get<LeadDetail>(`/leads/${id}`);
    if (r.ok && r.data) setDrawer(r.data);
  };

  const bulkSuppress = async () => {
    for (const id of selected) await api.post(`/leads/${id}/suppress`);
    setSelected(new Set());
    t.push('success', `Suppressed ${selected.size}`);
    refresh();
  };

  const bulkVerify = async () => {
    const ids = [...selected];
    for (const id of ids) await api.post(`/leads/${id}/verify`);
    setSelected(new Set());
    t.push('success', `Verified ${ids.length}`);
    refresh();
  };

  const [verifying, setVerifying] = useState(false);
  const verifyPending = async () => {
    setVerifying(true);
    const r = await api.post<{ verified: number; skipped: number }>('/leads/verify-pending', { limit: 200 });
    setVerifying(false);
    if (r.ok) t.push('success', `Verified ${r.data?.verified ?? 0}${r.data?.skipped ? `, skipped ${r.data.skipped}` : ''}`);
    else t.push('error', r.error ?? 'Verify failed');
    refresh();
  };

  return (
    <div className="split">
      <aside className="sidebar">
        <div className="search-wrap">
          <span className="search-icon">⌕</span>
          <input className="search-input" placeholder="Search name, email, city…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="sb-section">
          <div className="sb-label"><span>Status</span></div>
          {STATUS_OPTIONS.map(s => (
            <button key={s} className={'fb' + (status === s ? ' on' : '')} onClick={() => setStatus(s)}>
              <span className="fb-row">{s}</span>
            </button>
          ))}
        </div>
        <div className="sb-section">
          <div className="sb-label"><span>Niche</span></div>
          <button className={'fb' + (niche === 'all' ? ' on' : '')} onClick={() => setNiche('all')}>All</button>
          {NICHE_OPTIONS.map(n => (
            <button key={n} className={'fb' + (niche === n ? ' on' : '')} onClick={() => setNiche(n)}>{n}</button>
          ))}
        </div>
      </aside>
      <div className="content">
        {selected.size > 0 && (
          <div className="bulk-bar">
            <span className="txt">{selected.size} selected</span>
            <button className="btn btn-sm" onClick={bulkVerify}>Verify</button>
            <button className="btn btn-danger btn-sm" onClick={bulkSuppress}>Suppress</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
        <div className="tbl-wrap">
          <div className="tbl-head">
            <h3>Lead Library</h3>
            <span className="tbl-meta">{filtered.length} leads</span>
            <button className="btn btn-sm" style={{ marginLeft: 'auto' }} disabled={verifying} onClick={verifyPending}>
              {verifying ? 'Verifying…' : 'Verify pending'}
            </button>
          </div>
          <div className="tbl-scroll">
            <table>
              <thead><tr>
                <th style={{ width: 34 }}></th><th>Business</th><th>Email</th><th>Verified</th><th>Niche</th><th>Location</th><th>Status</th><th>Score</th><th>Found</th>
              </tr></thead>
              <tbody>
                {filtered.map(r => {
                  const f = fmtFresh(r.discoveredAt);
                  return (
                    <tr key={r.id} onClick={() => openDrawer(r.id)}>
                      <td onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(r.id)} onChange={e => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(r.id); else next.delete(r.id);
                          setSelected(next);
                        }} />
                      </td>
                      <td>
                        <div className="biz-name">{r.name}</div>
                        {r.phone && <div className="biz-addr">{r.phone}</div>}
                      </td>
                      <td><span className="email-text">{r.email ?? '—'}</span></td>
                      <td>{r.email ? <VBadge status={r.emailVerificationStatus} /> : <span className="email-text">—</span>}</td>
                      <td><span className={`tag ${nicheTag(r.niche)}`}><span className="dot"></span>{r.niche}</span></td>
                      <td><span className="loc-text">{r.city ?? '—'}, {r.state ?? ''}</span></td>
                      <td><span className={`pill ${r.status}`}>{r.status}</span></td>
                      <td>
                        <span className="score-bar">
                          <span className="score-track"><span className="score-fill" style={{ width: r.score + '%', background: scoreFillColor(r.score) }} /></span>
                          <span className="score-num">{r.score}</span>
                        </span>
                      </td>
                      <td><span className={`fresh ${f.cls}`}>{f.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="empty"><div className="e-ico">⌕</div><div className="e-title">No leads</div><div className="e-msg">Run discovery to populate this library.</div></div>
            )}
          </div>
        </div>
      </div>

      {drawer && (
        <div className="drawer" style={{ transform: 'translateX(0)' }}>
          <div className="drawer-header">
            <div>
              <h2 style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>{drawer.lead.name}</h2>
              <div className="biz-addr">{drawer.lead.city}, {drawer.lead.state} · {drawer.lead.niche} · score {drawer.lead.score}</div>
            </div>
            <button className="btn btn-ghost btn-icon" onClick={() => setDrawer(null)}>✕</button>
          </div>
          <div className="drawer-body">
            <div className="panel">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Why score</h3>
              {Array.isArray(drawer.signals?.contributions) && drawer.signals.contributions.length > 0 ? (
                drawer.signals.contributions.map((c: any, i: number) => (
                  <div className="kv" key={i}>
                    <span className="k">{c.signal} = {String(c.value)}</span>
                    <span className="v" style={{ color: c.points >= 0 ? 'var(--accent)' : 'var(--danger)' }}>
                      {c.points >= 0 ? '+' : ''}{c.points}
                    </span>
                  </div>
                ))
              ) : <p className="panel-desc">No signal contributions captured yet.</p>}
            </div>
            <div className="panel">
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Contact</h3>
              <div className="kv"><span className="k">Email</span><span className="v">{drawer.lead.email ?? '—'}</span></div>
              <div className="kv">
                <span className="k">Email status</span>
                <span className="v" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <VBadge status={drawer.lead.emailVerificationStatus} />
                  {drawer.lead.email && (
                    <button className="btn btn-ghost btn-sm" onClick={async () => {
                      const r = await api.post<{ status?: string }>(`/leads/${drawer.lead.id}/verify`);
                      if (r.ok) { t.push('success', `Email: ${r.data?.status ?? 'done'}`); openDrawer(drawer.lead.id); refresh(); }
                      else t.push('error', r.error ?? 'Verify failed');
                    }}>Verify</button>
                  )}
                </span>
              </div>
              <div className="kv"><span className="k">Phone</span><span className="v">{drawer.lead.phone ?? '—'}</span></div>
              <div className="kv"><span className="k">Website</span><span className="v">{drawer.lead.website ?? '—'}</span></div>
              <div className="kv"><span className="k">Address</span><span className="v">{drawer.lead.address ?? '—'}</span></div>
            </div>
          </div>
          <div className="drawer-footer">
            <button className="btn btn-danger btn-sm" onClick={async () => {
              await api.post(`/leads/${drawer.lead.id}/suppress`);
              setDrawer(null); refresh();
            }}>Suppress</button>
          </div>
        </div>
      )}
    </div>
  );
}
