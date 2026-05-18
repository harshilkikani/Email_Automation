import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';

interface Experiment {
  id: string; name: string; phase: string; niche: string; status: string;
  cities: string[]; templateKey: string | null; createdAt: string;
  campaignId?: string | null; verdict?: string | null;
}
interface Lead { id: string; name: string; niche: string; score: number; city: string | null; state: string | null }

const REASON_TAGS = [
  'closed_or_defunct', 'franchise_or_chain', 'residential_address',
  'wrong_niche', 'website_false_negative', 'tiny_business',
  'bad_phone', 'bad_address', 'bad_source_data', 'compliance_risk', 'other',
];
const NICHES = ['Septic','Water/Mold','HVAC','Roofer','Plumber','Electrician','Towing','Real Estate'];

export default function Validation() {
  const t = useToast();
  const [exps, setExps] = useState<Experiment[]>([]);
  const [name, setName] = useState('Septic — Houston Day 0');
  const [niche, setNiche] = useState('Septic');
  const [cities, setCities] = useState('Houston, Tampa, Atlanta');
  const [phase, setPhase] = useState<'eyeball'|'reach'|'engagement'|'refine'>('eyeball');
  const [topLeads, setTopLeads] = useState<Lead[]>([]);
  const [activeExp, setActiveExp] = useState<string | null>(null);
  const [ratings, setRatings] = useState<Record<string, { rating: 'A'|'B'|'C'|'D'; tags: string[] }>>({});
  const [openTags, setOpenTags] = useState<string | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const refreshExps = async () => {
    const qs = new URLSearchParams();
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    const r = await api.get<{ rows: Experiment[] }>(`/validation/experiments?${qs}`);
    if (r.ok && r.data) setExps(r.data.rows);
  };
  const fetchTopLeads = async (n: string) => {
    const r = await api.get<{ rows: Lead[] }>(`/leads?niche=${encodeURIComponent(n)}&limit=50`);
    if (r.ok && r.data) setTopLeads(r.data.rows);
  };
  useEffect(() => { fetchTopLeads(niche); }, [niche]);
  useEffect(() => { refreshExps(); }, [statusFilter]);

  const fetchSummary = async (id: string) => {
    const r = await api.get(`/validation/experiments/${id}`);
    if (r.ok && r.data) setSummary(r.data);
  };
  useEffect(() => { if (activeExp) fetchSummary(activeExp); }, [activeExp]);

  const createExp = async () => {
    const r = await api.post<{ id: string }>('/validation/experiments', {
      name, phase, niche,
      cities: cities.split(',').map(c => c.trim()).filter(Boolean),
    });
    if (!r.ok) { t.push('error', 'Create failed', r.error); return; }
    setActiveExp(r.data!.id);
    refreshExps();
    t.push('success', 'Experiment created');
  };

  const rate = async (leadId: string, rating: 'A'|'B'|'C'|'D') => {
    if (!activeExp) return;
    const existing = ratings[leadId]?.tags ?? [];
    setRatings(r => ({ ...r, [leadId]: { rating, tags: existing } }));
    await api.post('/validation/reviews', { experimentId: activeExp, leadId, rating, reasonTags: existing });
    fetchSummary(activeExp);
    if (rating === 'C' || rating === 'D') setOpenTags(leadId);
  };

  const toggleTag = async (leadId: string, tag: string) => {
    if (!activeExp) return;
    const cur = ratings[leadId] ?? { rating: 'C' as const, tags: [] };
    const tags = cur.tags.includes(tag) ? cur.tags.filter(x => x !== tag) : [...cur.tags, tag];
    setRatings(r => ({ ...r, [leadId]: { ...cur, tags } }));
    await api.post('/validation/reviews', { experimentId: activeExp, leadId, rating: cur.rating, reasonTags: tags });
  };

  const buildStratified = async (size: 'reach' | 'engagement') => {
    if (!activeExp) return;
    const r = await api.post(`/validation/experiments/${activeExp}/create-stratified-campaign`, {
      templateKey: nicheToTemplate(niche),
      size,
    });
    if (!r.ok) { t.push('error', 'Build failed', r.error); return; }
    t.push('success', `Stratified campaign built · ${r.data.recipientCount} recipients`);
    refreshExps();
  };

  const downloadCsv = (kind: 'signal-outcome' | 'reviews') => {
    if (!activeExp) return;
    const url = kind === 'signal-outcome'
      ? `/api/export/signal-outcome/${activeExp}.csv`
      : `/api/export/validation-reviews/${activeExp}.csv`;
    window.location.href = url;
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Validation <span className="it">mode</span></h1>
        <p className="page-subtitle">30-day plan: eyeball → reach → engagement → refine. Each phase has a kill criterion.</p>
      </div>
      <div className="container">
        <div className="builder-grid">
          <div>
            <div className="panel">
              <div className="panel-head"><h2><span className="panel-num">1</span>Define experiment</h2></div>
              <div className="field"><label className="field-label">Name</label>
                <input className="field-input" value={name} onChange={e => setName(e.target.value)} /></div>
              <div className="field-row">
                <div className="field"><label className="field-label">Phase</label>
                  <select className="field-input" value={phase} onChange={e => setPhase(e.target.value as any)}>
                    <option value="eyeball">Day 0 — Eyeball</option>
                    <option value="reach">Days 1-7 — Reach test</option>
                    <option value="engagement">Days 8-21 — Engagement</option>
                    <option value="refine">Days 22-30 — Refine</option>
                  </select></div>
                <div className="field"><label className="field-label">Niche</label>
                  <select className="field-input" value={niche} onChange={e => setNiche(e.target.value)}>
                    {NICHES.map(n => <option key={n}>{n}</option>)}
                  </select></div>
              </div>
              <div className="field"><label className="field-label">Cities (comma-separated)</label>
                <input className="field-input" value={cities} onChange={e => setCities(e.target.value)} /></div>
              <button className="btn btn-primary" onClick={createExp}>Create experiment</button>
            </div>

            <div className="panel">
              <div className="panel-head">
                <h2>Existing experiments</h2>
                <select className="field-input" style={{ width: 'auto', padding: '5px 9px' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                  <option value="all">All</option>
                  <option value="running">Running</option>
                  <option value="passed">Passed</option>
                  <option value="tuned">Tuned</option>
                  <option value="failed">Failed</option>
                  <option value="stopped">Stopped</option>
                </select>
              </div>
              {exps.length === 0 && <div className="empty"><div className="e-ico">◐</div><div className="e-title">No experiments yet</div></div>}
              {exps.map(e => (
                <div className={'camp-card' + (activeExp === e.id ? ' ' : '')} key={e.id} style={{ gridTemplateColumns: '1fr auto' }} onClick={() => setActiveExp(e.id)}>
                  <div>
                    <div className="cc-name">{e.name}</div>
                    <div className="cc-meta">{e.phase} · {e.niche} · {new Date(e.createdAt).toLocaleDateString()}</div>
                  </div>
                  <div>
                    <span className={`status-badge ${e.status === 'running' ? 'sending' : e.status === 'passed' ? 'complete' : 'draft'}`}>
                      <span className="dot"></span>{e.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {activeExp && phase === 'eyeball' && (
              <div className="panel">
                <div className="panel-head"><h2><span className="panel-num">2</span>Day-0 review</h2></div>
                <p className="panel-desc" style={{ marginBottom: 12 }}>
                  Rate A (clear buyer-fit), B (probably real), C (signals wrong), D (not a real business).
                  Add reason tags on C / D so we can tune the scorer.
                </p>
                <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                  {topLeads.map(l => {
                    const r = ratings[l.id];
                    return (
                      <div key={l.id}>
                        <div className="camp-card" style={{ gridTemplateColumns: '1fr auto' }}>
                          <div>
                            <div className="cc-name">{l.name}</div>
                            <div className="cc-meta">{l.city ?? '—'}, {l.state ?? '—'} · {l.niche} · score {l.score}</div>
                          </div>
                          <div className="row-actions">
                            {(['A','B','C','D'] as const).map(rt => (
                              <button key={rt}
                                className={'rating-btn' + (r?.rating === rt ? ' on ' + rt : '')}
                                onClick={() => rate(l.id, rt)}>{rt}</button>
                            ))}
                          </div>
                        </div>
                        {(openTags === l.id || (r?.tags?.length ?? 0) > 0) && (
                          <div className="tag-chips" style={{ marginTop: 4, marginBottom: 8 }}>
                            {REASON_TAGS.map(tag => (
                              <button key={tag} className="tag-chip" style={{
                                background: r?.tags.includes(tag) ? 'var(--accent-soft)' : undefined,
                                borderColor: r?.tags.includes(tag) ? 'var(--accent-line)' : undefined,
                              }} onClick={() => toggleTag(l.id, tag)}>{tag}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeExp && (phase === 'reach' || phase === 'engagement') && (
              <div className="panel">
                <div className="panel-head"><h2><span className="panel-num">2</span>Build stratified campaign</h2></div>
                <p className="panel-desc">
                  {phase === 'reach' ? 'Reach test: Top 40 / Mid 30 / Bottom 20 / Control 10 (=100 sends).' :
                                       'Engagement test: Top 200 / Mid 150 / Bottom 100 / Control 50 (=500 sends).'}
                  Seedlist mailboxes are inserted automatically.
                </p>
                <button className="btn btn-primary" onClick={() => buildStratified(phase as 'reach'|'engagement')}>Build campaign</button>
              </div>
            )}

            {activeExp && (
              <div className="panel">
                <div className="panel-head"><h2>Export</h2></div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => downloadCsv('signal-outcome')}>Signal-outcome CSV</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => downloadCsv('reviews')}>Reviews CSV</button>
                </div>
              </div>
            )}
          </div>

          <div>
            <div className="panel">
              <div className="panel-head"><h2>Live verdict</h2></div>
              {!activeExp && <div className="empty"><div className="e-ico">◐</div><div className="e-title">Select an experiment</div></div>}
              {activeExp && summary?.eyeball && (
                <>
                  <div className="summary-card">
                    <div className="num">{(summary.eyeball.aPlusBPct * 100).toFixed(0)}%</div>
                    <div className="lbl">A + B rated</div>
                  </div>
                  <div className={`callout ${summary.eyeball.verdict === 'pass' ? 'accent' : summary.eyeball.verdict === 'tune' ? 'warn' : 'danger'}`}>
                    <strong>{summary.eyeball.verdict.toUpperCase()}.</strong>{' '}
                    {summary.eyeball.verdict === 'pass' && '≥70% A+B — proceed to reach test.'}
                    {summary.eyeball.verdict === 'tune' && '50-69% A+B — review C/D reasons and tune scoring.'}
                    {summary.eyeball.verdict === 'stop' && '<50% A+B — major scoring problem. Do not send.'}
                  </div>
                </>
              )}
              {activeExp && summary?.results?.verdict && (
                <div className="callout accent" style={{ marginTop: 14 }}>
                  Phase verdict: <strong>{summary.results.verdict.verdict}</strong>
                </div>
              )}
            </div>
            <div className="panel">
              <div className="panel-head"><h2>Phase plan</h2></div>
              <div className="kv"><span className="k">Eyeball (Day 0)</span><span className="v">50 leads</span></div>
              <div className="kv"><span className="k">Reach (Day 1-7)</span><span className="v">100 sends</span></div>
              <div className="kv"><span className="k">Engagement (8-21)</span><span className="v">500 sends</span></div>
              <div className="kv"><span className="k">Refine (22-30)</span><span className="v">200-400 confirmatory</span></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function nicheToTemplate(n: string): string {
  return ({
    Septic: 'septic', 'Water/Mold': 'water', HVAC: 'hvac', Roofer: 'roofer',
    Plumber: 'plumber', Electrician: 'electrician', Towing: 'towing', 'Real Estate': 'real-estate',
  } as Record<string, string>)[n] ?? 'general-audit';
}
