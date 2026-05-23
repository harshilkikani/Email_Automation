/**
 * Pluggable offline AI adapter.
 *
 * Architectural rules (enforced by the server-side guards in
 * apps/server/src/services/ai.ts):
 *
 *   1. NEVER per-lead at runtime. The interface only exposes batch
 *      operations: template generation, reply-corpus analysis, weight
 *      suggestion from signal-outcomes, intel summarization across many
 *      leads. Anything that would scale with `recipients_per_send` is
 *      explicitly excluded.
 *
 *   2. The default `NoopAdapter` returns deterministic, hand-tuned fallbacks
 *      (e.g. template variations come from a known list). The product works
 *      with AI=off.
 *
 *   3. The "Ollama" adapter (a local LLM via http://localhost:11434) is
 *      gated behind ENABLE_LOCAL_AI=true so a misconfigured env can't
 *      silently spin up an LLM.
 */
import type { LiftRow } from './validation.js';
import type { ScoringWeights } from './scoring.js';
import type { Niche } from './types.js';

export type AiOperation =
  | 'generate_template' | 'analyze_replies' | 'suggest_weights' | 'summarize_intel';

export interface AiTemplateVariation {
  templateKey: string;
  subject: string;
  body: string;
  /** Why this variation makes sense (deterministic explanation, not LLM-prose). */
  rationale: string;
}

export interface AiReplyAnalysis {
  /** Topic clusters discovered across the corpus. */
  topics: Array<{ label: string; count: number; samples: string[] }>;
  /** Common objections, sorted by frequency. */
  objections: Array<{ label: string; count: number }>;
  /** Operator-actionable recommendations. */
  recommendations: string[];
}

export interface AiWeightSuggestion {
  weightKey: keyof ScoringWeights | string;
  deltaPoints: number;
  rationale: string;
}

export interface AiIntelSummary {
  /** Per-niche common-tech notes (e.g. "78% on WordPress, 60% on Calendly"). */
  byNiche: Array<{ niche: Niche; insights: string[] }>;
  /** Across-the-board notes. */
  global: string[];
}

export interface AiAdapter {
  /** Stable identifier for audit log. */
  readonly name: string;

  generateTemplate(input: {
    niche: Niche;
    seedSubject: string;
    seedBody: string;
    count: number;
  }): Promise<AiTemplateVariation[]>;

  analyzeReplies(input: {
    samples: Array<{ subject: string; body: string; intent: string }>;
  }): Promise<AiReplyAnalysis>;

  suggestWeights(input: {
    liftRows: LiftRow[];
    currentWeights: ScoringWeights;
  }): Promise<AiWeightSuggestion[]>;

  summarizeIntel(input: {
    /** One row per lead — intel facts only, no PII. */
    leads: Array<{ niche: Niche; techStack: string[]; bookingVendor: string | null; services: string[] }>;
  }): Promise<AiIntelSummary>;
}

/* ────────── Noop adapter ────────── */

/**
 * Deterministic fallback. Returns hand-curated variations + heuristic
 * analyses. Used:
 *   - by default when ENABLE_LOCAL_AI=false
 *   - when an external adapter throws (fail-closed semantics)
 */
export class NoopAiAdapter implements AiAdapter {
  readonly name = 'noop';

  async generateTemplate(input: { niche: Niche; seedSubject: string; seedBody: string; count: number }): Promise<AiTemplateVariation[]> {
    const variants: AiTemplateVariation[] = [];
    const baseSubject = input.seedSubject || `Quick question about ${input.niche.toLowerCase()} work in {{city}}`;
    const baseBody = input.seedBody || '';
    const subjectMutators: Array<(s: string) => string> = [
      (s) => s,
      (s) => s.replace(/Quick question/i, 'Two-minute question'),
      (s) => s.replace(/about/i, 'on'),
      (s) => `${s} — quick favor`,
    ];
    const bodyMutators: Array<(s: string) => string> = [
      (s) => s,
      (s) => s.replace(/Hi /, 'Hey '),
      (s) => s + '\n\nNo worries if not the right time.',
    ];
    for (let i = 0; i < input.count; i++) {
      const subj = subjectMutators[i % subjectMutators.length]!(baseSubject);
      const body = bodyMutators[i % bodyMutators.length]!(baseBody);
      variants.push({
        templateKey: `noop-v${i + 1}`,
        subject: subj,
        body,
        rationale: 'Deterministic noop variation (subject/body mutator pair).',
      });
    }
    return variants;
  }

  async analyzeReplies(input: { samples: Array<{ subject: string; body: string; intent: string }> }): Promise<AiReplyAnalysis> {
    /* Group by intent — simple but useful, no LLM needed. */
    const byIntent = new Map<string, Array<{ subject: string; body: string }>>();
    for (const s of input.samples) {
      if (!byIntent.has(s.intent)) byIntent.set(s.intent, []);
      byIntent.get(s.intent)!.push({ subject: s.subject, body: s.body });
    }
    const topics = [...byIntent.entries()].map(([intent, rows]) => ({
      label: intent,
      count: rows.length,
      samples: rows.slice(0, 3).map(r => (r.body || r.subject).slice(0, 140)),
    })).sort((a, b) => b.count - a.count);
    const objectionRows = byIntent.get('objection') ?? [];
    const objections = bucketObjections(objectionRows);
    const recommendations: string[] = [];
    const interestedCount = byIntent.get('interested')?.length ?? 0;
    const conditionalCount = byIntent.get('conditional')?.length ?? 0;
    const polite = byIntent.get('not_interested_polite')?.length ?? 0;
    if (interestedCount + conditionalCount < polite) {
      recommendations.push('Polite-no replies outnumber positive replies — consider tightening ICP or rewriting CTA.');
    }
    if (objections.length > 0) {
      recommendations.push(`Top objection cluster: "${objections[0]?.label}" (${objections[0]?.count} occurrences).`);
    }
    return { topics, objections, recommendations };
  }

  async suggestWeights(input: { liftRows: LiftRow[]; currentWeights: ScoringWeights }): Promise<AiWeightSuggestion[]> {
    /* Deterministic: convert each significant LiftRow into a suggestion using
       the same rules as deriveWeightPlan, just translated into the new
       evidence-style return shape. */
    const out: AiWeightSuggestion[] = [];
    for (const row of input.liftRows) {
      if (!Number.isFinite(row.liftReply) || row.nTrue < 30) continue;
      const lift = row.liftReply;
      let delta = 0;
      if (lift >= 2) delta = 3;
      else if (lift >= 1.5) delta = 2;
      else if (lift < 0.7 && lift > 0) delta = -3;
      else if (lift < 1) delta = -1;
      if (delta === 0) continue;
      out.push({
        weightKey: row.signal,
        deltaPoints: delta,
        rationale: `Lift ${lift.toFixed(2)}× on ${row.nTrue} sends; ${delta > 0 ? 'boost' : 'reduce'} the weight.`,
      });
    }
    return out;
  }

  async summarizeIntel(input: { leads: Array<{ niche: Niche; techStack: string[]; bookingVendor: string | null; services: string[] }> }): Promise<AiIntelSummary> {
    const byNicheMap = new Map<Niche, { tech: Map<string, number>; booking: Map<string, number>; services: Map<string, number>; total: number }>();
    for (const l of input.leads) {
      if (!byNicheMap.has(l.niche)) byNicheMap.set(l.niche, { tech: new Map(), booking: new Map(), services: new Map(), total: 0 });
      const m = byNicheMap.get(l.niche)!;
      m.total++;
      for (const t of l.techStack) m.tech.set(t, (m.tech.get(t) ?? 0) + 1);
      if (l.bookingVendor) m.booking.set(l.bookingVendor, (m.booking.get(l.bookingVendor) ?? 0) + 1);
      for (const s of l.services) m.services.set(s, (m.services.get(s) ?? 0) + 1);
    }
    const byNiche = [...byNicheMap.entries()].map(([niche, m]) => {
      const topTech = topN(m.tech, 3);
      const topBook = topN(m.booking, 2);
      const insights: string[] = [];
      if (topTech.length > 0) {
        insights.push(`Top tech stacks: ${topTech.map(([k, v]) => `${k} (${pct(v, m.total)})`).join(', ')}`);
      }
      if (topBook.length > 0) {
        insights.push(`Booking vendors: ${topBook.map(([k, v]) => `${k} (${pct(v, m.total)})`).join(', ')}`);
      }
      return { niche, insights };
    });
    const global: string[] = [];
    const totalWithBooking = input.leads.filter(l => l.bookingVendor !== null).length;
    if (input.leads.length > 0) {
      global.push(`${pct(totalWithBooking, input.leads.length)} of leads already use an online booking vendor.`);
    }
    return { byNiche, global };
  }
}

function bucketObjections(rows: Array<{ subject: string; body: string }>): Array<{ label: string; count: number }> {
  const buckets: Array<{ label: string; re: RegExp; count: number }> = [
    { label: 'price', re: /price|too\s+expensive|cost|budget|cheaper/i, count: 0 },
    { label: 'timing', re: /not\s+(?:the\s+)?(?:right\s+)?time|too\s+busy|later|next\s+(?:quarter|year)/i, count: 0 },
    { label: 'wrong_person', re: /wrong\s+person|forward(ed)?|not\s+(?:me|the\s+right)/i, count: 0 },
    { label: 'no_need', re: /don'?t\s+need|already\s+have|happy\s+with|no\s+thanks/i, count: 0 },
    { label: 'cold_email', re: /unsolicited|cold\s+email|how\s+did\s+you\s+(?:get|find)/i, count: 0 },
  ];
  for (const row of rows) {
    const text = `${row.subject} ${row.body}`;
    for (const b of buckets) {
      if (b.re.test(text)) { b.count++; break; }
    }
  }
  return buckets.filter(b => b.count > 0).map(b => ({ label: b.label, count: b.count })).sort((a, b) => b.count - a.count);
}

function topN(m: Map<string, number>, n: number): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function pct(num: number, denom: number): string {
  if (denom === 0) return '0%';
  return `${((num / denom) * 100).toFixed(0)}%`;
}

/* ────────── Ollama adapter ────────── */

/**
 * Offline LLM adapter backed by a local Ollama server.
 *
 * All four operations are batch-only: template generation, reply analysis,
 * weight suggestions, and intel summarisation. The model is prompted with
 * structured JSON so output can be parsed deterministically. On any error
 * (network, parse, timeout) the fallback NoopAdapter is used — fail-closed
 * semantics preserve correctness even when Ollama is down or misconfigured.
 *
 * Activate with: ENABLE_LOCAL_AI=true AI_RUNTIME=ollama OLLAMA_URL=... OLLAMA_MODEL=...
 */
export class OllamaAdapter implements AiAdapter {
  readonly name = 'ollama';

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fallback: AiAdapter = new NoopAiAdapter(),
  ) {}

  async generateTemplate(input: {
    niche: Niche;
    seedSubject: string;
    seedBody: string;
    count: number;
  }): Promise<AiTemplateVariation[]> {
    const prompt = `You are a cold-email copywriter for a B2B AI receptionist product targeting small ${input.niche} businesses.
Generate ${input.count} distinct plain-text email variations. Each MUST:
- Start from the seed but vary the hook, CTA, or tone
- Stay under 120 words in the body
- Use no HTML, no tracking links, no emojis
- Keep subject under 60 characters

Seed subject: ${input.seedSubject || `Quick question about ${input.niche.toLowerCase()} work in {{city}}`}
Seed body: ${input.seedBody || '(empty — generate from scratch)'}

Respond ONLY with a JSON array of objects:
[{"templateKey":"v1","subject":"...","body":"...","rationale":"..."}]`;

    try {
      const raw = await this.complete(prompt);
      const parsed = extractJsonArray(raw) as AiTemplateVariation[];
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty_parse');
      return parsed.map((v, i) => ({
        templateKey: v.templateKey ?? `ollama-v${i + 1}`,
        subject: String(v.subject ?? ''),
        body: String(v.body ?? ''),
        rationale: String(v.rationale ?? 'Ollama-generated variation.'),
      })).slice(0, input.count);
    } catch {
      return this.fallback.generateTemplate(input);
    }
  }

  async analyzeReplies(input: {
    samples: Array<{ subject: string; body: string; intent: string }>;
  }): Promise<AiReplyAnalysis> {
    if (input.samples.length === 0) return this.fallback.analyzeReplies(input);
    const corpus = input.samples.slice(0, 40).map((s, i) =>
      `[${i + 1}] intent=${s.intent} | subject="${s.subject}" | body="${s.body.slice(0, 200)}"`,
    ).join('\n');

    const prompt = `Analyze this cold-email reply corpus. Identify topic clusters, common objections, and actionable recommendations.
Corpus:
${corpus}

Respond ONLY with JSON:
{"topics":[{"label":"...","count":N,"samples":["..."]}],"objections":[{"label":"...","count":N}],"recommendations":["..."]}`;

    try {
      const raw = await this.complete(prompt);
      const parsed = extractJsonObject(raw) as unknown as AiReplyAnalysis;
      if (!parsed.topics) throw new Error('missing_topics');
      return {
        topics: (parsed.topics ?? []).slice(0, 10),
        objections: (parsed.objections ?? []).slice(0, 5),
        recommendations: (parsed.recommendations ?? []).slice(0, 5),
      };
    } catch {
      return this.fallback.analyzeReplies(input);
    }
  }

  async suggestWeights(input: {
    liftRows: LiftRow[];
    currentWeights: ScoringWeights;
  }): Promise<AiWeightSuggestion[]> {
    const significant = input.liftRows.filter(r => r.nTrue >= 30 && Number.isFinite(r.liftReply));
    if (significant.length === 0) return this.fallback.suggestWeights(input);

    const rowSummary = significant.slice(0, 20).map(r =>
      `signal=${r.signal} lift=${r.liftReply?.toFixed(2)} n=${r.nTrue}`,
    ).join('\n');
    const currentStr = JSON.stringify(input.currentWeights, null, 2);

    const prompt = `You are a scoring-weight advisor for a cold-email ICP scoring system.
Current weights (JSON): ${currentStr}

Signal lift observations (from 30-day validation data):
${rowSummary}

Rules:
- Each delta MUST be ≤ ±30% of the current absolute weight value
- Only suggest changes for signals with lift ≥ 1.5× or ≤ 0.7×
- Provide a concise rationale per suggestion

Respond ONLY with a JSON array:
[{"weightKey":"...","deltaPoints":N,"rationale":"..."}]`;

    try {
      const raw = await this.complete(prompt);
      const parsed = extractJsonArray(raw) as AiWeightSuggestion[];
      if (!Array.isArray(parsed)) throw new Error('parse_fail');
      return parsed
        .filter(s => typeof s.weightKey === 'string' && typeof s.deltaPoints === 'number')
        .slice(0, 10);
    } catch {
      return this.fallback.suggestWeights(input);
    }
  }

  async summarizeIntel(input: {
    leads: Array<{ niche: Niche; techStack: string[]; bookingVendor: string | null; services: string[] }>;
  }): Promise<AiIntelSummary> {
    if (input.leads.length === 0) return this.fallback.summarizeIntel(input);

    /* Aggregate stats client-side to keep the prompt token count bounded. */
    const niches = new Set(input.leads.map(l => l.niche));
    const byNicheStats: string[] = [];
    for (const niche of niches) {
      const group = input.leads.filter(l => l.niche === niche);
      const techCounts = new Map<string, number>();
      const bookingCounts = new Map<string, number>();
      for (const l of group) {
        for (const t of l.techStack) techCounts.set(t, (techCounts.get(t) ?? 0) + 1);
        if (l.bookingVendor) bookingCounts.set(l.bookingVendor, (bookingCounts.get(l.bookingVendor) ?? 0) + 1);
      }
      const topTech = [...techCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(', ');
      const topBook = [...bookingCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}:${v}`).join(', ');
      byNicheStats.push(`${niche} (n=${group.length}): tech=[${topTech}] booking=[${topBook}]`);
    }

    const prompt = `Summarize website intelligence for cold-email targeting.
Data (niche totals, top tech stacks, booking vendors):
${byNicheStats.join('\n')}

Write 1-2 punchy insights per niche and 1-2 global insights.
Respond ONLY with JSON:
{"byNiche":[{"niche":"...","insights":["..."]}],"global":["..."]}`;

    try {
      const raw = await this.complete(prompt);
      const parsed = extractJsonObject(raw) as unknown as AiIntelSummary;
      if (!parsed.byNiche) throw new Error('missing_byNiche');
      return {
        byNiche: (parsed.byNiche ?? []).slice(0, niches.size),
        global: (parsed.global ?? []).slice(0, 5),
      };
    } catch {
      return this.fallback.summarizeIntel(input);
    }
  }

  private async complete(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: false }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`ollama_http_${res.status}`);
    const body = await res.json() as { response?: string };
    if (!body.response) throw new Error('ollama_empty_response');
    return body.response;
  }
}

function extractJsonArray(raw: string): unknown[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no_json_array');
  return JSON.parse(m[0]) as unknown[];
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no_json_object');
  return JSON.parse(m[0]) as Record<string, unknown>;
}
