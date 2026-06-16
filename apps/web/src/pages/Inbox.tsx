import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';

interface Reply {
  id: string; fromEmail: string; subject: string | null; textBody: string | null;
  autoIntent: string | null; manualIntent: string | null;
  classifierSource?: string;
  triaged: boolean; isAutoReply: boolean;
  receivedAt: string;
  bookedDemo?: boolean;
}

interface Sent {
  id: string; state: string; subject: string | null; body: string | null;
  sentAt: string | null; step: number | null;
  toName: string | null; toEmail: string | null; campaign: string | null;
}

interface PerfRow { k: string | null; sent: number; replied: number; bounced: number }
interface Perf {
  overall: { sent: number; replied: number; bounced: number };
  byOffer: PerfRow[]; byCta: PerfRow[]; byGap: PerfRow[]; byAiAngle: PerfRow[]; byNiche: PerfRow[];
}

/* Friendly labels mirroring the copy levers in core personalization. */
const CTA_LABEL = ['"send a 2-min example?"', '"reply yes for an example"', '"catching missed calls?"', '"mind if I send an example?"', '"open to a rundown?"'];
const AI_LABEL: Record<string, string> = { urgent: '24/7 AI receptionist', recurring: 'reactivation agent', estimate: 'estimate follow-up', realestate: 'instant inquiry reply', default: 'receptionist + agents' };
const OFFER_LABEL: Record<string, string> = { ai_solutions: 'AI solutions (core pitch)', claim_supplement: 'Insurance claim supplement', liens: 'Get-paid / liens' };
const fmtPct = (r: PerfRow) => r.sent > 0 ? `${((r.replied / r.sent) * 100).toFixed(1)}%` : '—';

const INTENTS = [
  'interested','conditional','objection',
  'not_interested_polite','not_interested_hostile',
  'wrong_person','auto_reply','referral','bounce','unsubscribe','unknown',
];

/** key → intent. Mirrors the brief. */
const KEY_TO_INTENT: Record<string, string> = {
  i: 'interested',
  c: 'conditional',
  o: 'objection',
  n: 'not_interested_polite',
  h: 'not_interested_hostile',
  w: 'wrong_person',
  r: 'referral',
  u: 'unsubscribe',
};

export default function Inbox() {
  const t = useToast();
  const [rows, setRows] = useState<Reply[]>([]);
  const [sent, setSent] = useState<Sent[]>([]);
  const [perf, setPerf] = useState<Perf | null>(null);
  const [view, setView] = useState<'sent' | 'replies' | 'performance'>('sent');
  const [filter, setFilter] = useState<string>('all');
  const [focusIdx, setFocusIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    const r = await api.get<{ rows: Reply[] }>('/inbound');
    if (r.ok && r.data) setRows(r.data.rows);
  };
  const refreshSent = async () => {
    const r = await api.get<{ rows: Sent[] }>('/sent');
    if (r.ok && r.data) setSent(r.data.rows);
  };
  const refreshPerf = async () => {
    const r = await api.get<Perf>('/performance');
    if (r.ok && r.data) setPerf(r.data);
  };
  useEffect(() => { refresh(); refreshSent(); refreshPerf(); }, []);

  const [sentFilter, setSentFilter] = useState('all');
  const filtered = useMemo(() => filter === 'all' ? rows : rows.filter(r => (r.manualIntent ?? r.autoIntent ?? 'unknown') === filter), [rows, filter]);
  const sentFiltered = useMemo(() => sentFilter === 'all' ? sent : sent.filter(s => s.state === sentFilter), [sent, sentFilter]);
  const SENT_STATES = ['sent', 'delivered', 'bounced', 'replied', 'failed'];

  const setIntent = async (id: string, intent: string) => {
    const r = await api.patch(`/inbound/${id}`, { manualIntent: intent, triaged: true });
    if (!r.ok) { t.push('error', 'Update failed'); return; }
    refresh();
  };
  const markBooked = async (id: string) => {
    await api.patch(`/inbound/${id}`, { bookedDemo: true, triaged: true });
    t.push('success', 'Marked: booked demo');
    refresh();
  };
  const suppress = async (id: string, scope: 'email' | 'domain') => {
    await api.post(`/inbound/${id}/suppress`, { scope });
    t.push('success', `Suppressed (${scope})`);
    refresh();
  };

  /* Keyboard shortcuts. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (view !== 'replies') return;   // reply-triage shortcuts only apply to replies
      const k = e.key.toLowerCase();
      const current = filtered[focusIdx];
      if (k === 'j') { setFocusIdx(i => Math.min(filtered.length - 1, i + 1)); return; }
      if (k === 'k') { setFocusIdx(i => Math.max(0, i - 1)); return; }
      if (!current) return;
      if (k === 'b') { markBooked(current.id); return; }
      if (k === 's') { suppress(current.id, 'email'); return; }
      if (k === 'd') { suppress(current.id, 'domain'); return; }
      const intent = KEY_TO_INTENT[k];
      if (intent) {
        e.preventDefault();
        setIntent(current.id, intent);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, focusIdx, view]);

  return (
    <div className="split">
      <aside className="sidebar">
        {view === 'sent' ? (
          <div className="sb-section">
            <div className="sb-label"><span>Status</span></div>
            <button className={'fb' + (sentFilter === 'all' ? ' on' : '')} onClick={() => setSentFilter('all')}>
              <span className="fb-row">All</span><span className="ct">{sent.length}</span>
            </button>
            {SENT_STATES.map(st => {
              const count = sent.filter(s => s.state === st).length;
              return (
                <button key={st} className={'fb' + (sentFilter === st ? ' on' : '')} onClick={() => setSentFilter(st)}>
                  <span className="fb-row">{st}</span><span className="ct">{count}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="sb-section">
            <div className="sb-label"><span>Intent</span></div>
            <button className={'fb' + (filter === 'all' ? ' on' : '')} onClick={() => setFilter('all')}>
              <span className="fb-row">All</span><span className="ct">{rows.length}</span>
            </button>
            {INTENTS.map(i => {
              const count = rows.filter(r => (r.manualIntent ?? r.autoIntent ?? 'unknown') === i).length;
              return (
                <button key={i} className={'fb' + (filter === i ? ' on' : '')} onClick={() => setFilter(i)}>
                  <span className="fb-row">{i}</span><span className="ct">{count}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="sb-section" style={{ display: view === 'replies' ? undefined : 'none' }}>
          <div className="sb-label"><span>Shortcuts</span></div>
          <div style={{ padding: '0 9px', fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.7 }}>
            <div>j / k — next / prev</div>
            <div>i — interested</div>
            <div>c — conditional</div>
            <div>o — objection</div>
            <div>n — not interested</div>
            <div>h — hostile (suppress)</div>
            <div>w — wrong person</div>
            <div>r — referral</div>
            <div>u — unsubscribe</div>
            <div>b — booked demo</div>
            <div>s — suppress email</div>
            <div>d — suppress domain</div>
          </div>
        </div>
      </aside>
      <div className="content">
        <div className="tbl-wrap">
          <div className="tbl-head">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className={'btn btn-xs ' + (view === 'sent' ? 'btn-primary' : 'btn-secondary')} onClick={() => setView('sent')}>Sent ({sent.length})</button>
              <button className={'btn btn-xs ' + (view === 'replies' ? 'btn-primary' : 'btn-secondary')} onClick={() => setView('replies')}>Replies ({rows.length})</button>
              <button className={'btn btn-xs ' + (view === 'performance' ? 'btn-primary' : 'btn-secondary')} onClick={() => setView('performance')}>Performance</button>
            </div>
            <span className="tbl-meta">{view === 'sent' ? `${sent.length} sent` : view === 'replies' ? `${filtered.length} replies` : `${perf?.overall.sent ?? 0} sent · ${perf?.overall.replied ?? 0} replied`}</span>
          </div>

          {view === 'performance' && perf && (
            <div style={{ padding: 14 }}>
              <div className="health-tiles" style={{ marginBottom: 14 }}>
                {[['Sent', perf.overall.sent], ['Replied', perf.overall.replied],
                  ['Reply rate', perf.overall.sent > 0 ? `${((perf.overall.replied / perf.overall.sent) * 100).toFixed(1)}%` : '—'],
                  ['Bounced', perf.overall.bounced]].map(([k, v]) => (
                  <div className="h-tile" key={k as string}><div className="ht-name">{k}</div><div className="ht-state">{v as any}</div></div>
                ))}
              </div>
              {(perf.overall.replied === 0 || perf.overall.sent < 100) && (
                <div className="callout" style={{ marginBottom: 14 }}>
                  <strong>Still gathering signal.</strong> Cold email runs ~1–5% reply rates and replies lag by days, so you need a few hundred sends before these numbers mean anything. Every send is now tagged with the copy it used, so as replies come in this will show exactly which subjects, CTAs, and pitches win — and we can then auto-favor the winners.
                </div>
              )}
              {([['Offer (which pitch)', perf.byOffer, (k: string | null) => OFFER_LABEL[k ?? ''] ?? k ?? '—'],
                 ['Call-to-action', perf.byCta, (k: string | null) => CTA_LABEL[Number(k)] ?? k ?? '—'],
                 ['Gap pitched', perf.byGap, (k: string | null) => (k ?? '—').replace(/_/g, ' ')],
                 ['AI angle', perf.byAiAngle, (k: string | null) => AI_LABEL[k ?? ''] ?? k ?? '—'],
                 ['Trade', perf.byNiche, (k: string | null) => k ?? '—']] as const).map(([title, data, label]) => (
                <div key={title} style={{ marginBottom: 16 }}>
                  <div className="sb-label" style={{ marginBottom: 6 }}><span>{title}</span></div>
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>Variant</th><th>Sent</th><th>Replied</th><th>Reply&nbsp;rate</th></tr></thead>
                    <tbody>
                      {data.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--fg-3)' }}>No sends yet</td></tr>}
                      {data.map((r, i) => (
                        <tr key={i} style={{ opacity: r.sent < 20 ? 0.55 : 1 }}>
                          <td>{label(r.k)}</td>
                          <td style={{ textAlign: 'center' }}>{r.sent}</td>
                          <td style={{ textAlign: 'center' }}>{r.replied}</td>
                          <td style={{ textAlign: 'center', color: r.replied > 0 ? 'var(--accent)' : 'var(--fg-3)' }}>{fmtPct(r)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {view === 'sent' && (
            <div>
              {sent.length === 0 && <div className="empty"><div className="e-ico">✉</div><div className="e-title">No sent emails yet</div><div className="e-sub">Send a batch from Scrape &amp; Send — copies appear here (and in your mailbox Sent folder).</div></div>}
              {sent.length > 0 && sentFiltered.length === 0 && <div className="empty"><div className="e-ico">✉</div><div className="e-title">No {sentFilter} emails</div></div>}
              {sentFiltered.map(s => (
                <div className="panel" key={s.id} style={{ margin: 14 }}>
                  <div className="panel-head" style={{ marginBottom: 8, paddingBottom: 8 }}>
                    <h2>{s.subject || '(no subject)'}</h2>
                    <span className="tbl-meta">{s.sentAt ? new Date(s.sentAt).toLocaleString() : ''}</span>
                  </div>
                  <div className="cc-meta" style={{ marginBottom: 10 }}>
                    <span>To: <strong>{s.toName || s.toEmail}</strong>{s.toName ? ` <${s.toEmail}>` : ''}</span>
                    <span>· <span className={'pill ' + (s.state === 'bounced' ? 'bounced' : s.state === 'delivered' ? 'booked' : '')}>{s.state}</span></span>
                    {s.step != null && s.step > 1 && <span>· follow-up #{s.step - 1}</span>}
                    {s.campaign && <span>· {s.campaign}</span>}
                  </div>
                  <div className="preview-box" style={{ maxHeight: 260 }}>
                    <div className="preview-body" style={{ whiteSpace: 'pre-wrap' }}>{s.body ?? '(body not stored for this send)'}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {view === 'replies' && <>
          {filtered.length === 0 && <div className="empty"><div className="e-ico">✉</div><div className="e-title">No replies match</div></div>}
          <div ref={listRef}>
            {filtered.map((r, idx) => (
              <div className="panel" key={r.id} style={{ margin: 14, borderColor: idx === focusIdx ? 'var(--accent-line)' : 'var(--line)' }}>
                <div className="panel-head" style={{ marginBottom: 8, paddingBottom: 8 }}>
                  <h2>{r.subject || '(no subject)'}</h2>
                  <span className="tbl-meta">{new Date(r.receivedAt).toLocaleString()}</span>
                </div>
                <div className="cc-meta" style={{ marginBottom: 10 }}>
                  <span>From: <strong>{r.fromEmail}</strong></span>
                  {r.autoIntent && <span>· auto ({r.classifierSource ?? 'regex'}): <strong style={{ color: 'var(--accent)' }}>{r.autoIntent}</strong></span>}
                  {r.manualIntent && <span>· manual: <strong style={{ color: 'var(--violet)' }}>{r.manualIntent}</strong></span>}
                  {r.bookedDemo && <span className="pill booked">booked</span>}
                  {r.isAutoReply && <span className="pill bounced">auto-reply</span>}
                </div>
                <div className="preview-box" style={{ maxHeight: 200 }}>
                  <div className="preview-body">{r.textBody ?? '(empty)'}</div>
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {INTENTS.map(i => (
                    <button key={i} className={'btn btn-xs ' + (r.manualIntent === i ? 'btn-primary' : 'btn-secondary')} onClick={() => setIntent(r.id, i)}>{i}</button>
                  ))}
                  <button className="btn btn-xs btn-primary" onClick={() => markBooked(r.id)}>Booked demo</button>
                  <button className="btn btn-xs btn-danger" onClick={() => suppress(r.id, 'email')}>Suppress email</button>
                  <button className="btn btn-xs btn-danger" onClick={() => suppress(r.id, 'domain')}>Suppress domain</button>
                </div>
              </div>
            ))}
          </div>
          </>}
        </div>
      </div>
    </div>
  );
}
