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
  const [filter, setFilter] = useState<string>('all');
  const [focusIdx, setFocusIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    const r = await api.get<{ rows: Reply[] }>('/inbound');
    if (r.ok && r.data) setRows(r.data.rows);
  };
  useEffect(() => { refresh(); }, []);

  const filtered = useMemo(() => filter === 'all' ? rows : rows.filter(r => (r.manualIntent ?? r.autoIntent ?? 'unknown') === filter), [rows, filter]);

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
  }, [filtered, focusIdx]);

  return (
    <div className="split">
      <aside className="sidebar">
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
        <div className="sb-section">
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
            <h3>Inbox</h3>
            <span className="tbl-meta">{filtered.length} replies · {filtered[focusIdx]?.fromEmail ? `focused: ${filtered[focusIdx]?.fromEmail}` : 'no focus'}</span>
          </div>
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
        </div>
      </div>
    </div>
  );
}
