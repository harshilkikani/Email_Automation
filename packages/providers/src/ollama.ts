/**
 * Ollama-backed AiAdapter.
 *
 * Targets the Ollama HTTP API at http://localhost:11434 by default. The model
 * is configurable (`OLLAMA_MODEL`, e.g. `llama3.1:8b-instruct-q4_K_M`). All
 * prompts are written to be deterministic with `temperature: 0` and explicit
 * JSON output format so the result is parseable.
 *
 * On any failure (timeout, parse error, model missing) the adapter throws,
 * and the server wrapper falls back to the NoopAiAdapter — meaning the
 * product never blocks on AI availability.
 */
import { request } from 'undici';
import type {
  AiAdapter, AiTemplateVariation, AiReplyAnalysis, AiWeightSuggestion,
  AiIntelSummary, Niche, LiftRow, ScoringWeights,
} from '@keres/core';
import { NoopAiAdapter } from '@keres/core';

export interface OllamaAdapterConfig {
  baseUrl: string;             // http://localhost:11434
  model: string;               // llama3.1:8b-instruct-q4_K_M
  requestTimeoutMs: number;
}

export class OllamaAdapter implements AiAdapter {
  readonly name = 'ollama';
  private fallback = new NoopAiAdapter();

  constructor(private cfg: OllamaAdapterConfig) {}

  async generateTemplate(input: { niche: Niche; seedSubject: string; seedBody: string; count: number }): Promise<AiTemplateVariation[]> {
    const prompt = [
      `You generate cold-email subject + body variations for ${input.niche} businesses.`,
      `RULES: plain text only, US English, no emojis, no all-caps subject, < 80 words body.`,
      `INPUT subject: "${input.seedSubject}"`,
      `INPUT body: """`, input.seedBody, `"""`,
      `Return JSON: { "variations": [ { "subject": "...", "body": "...", "rationale": "..." } ] }`,
      `Generate exactly ${input.count} variations.`,
    ].join('\n');
    try {
      const result = await this.call<{ variations: Array<{ subject: string; body: string; rationale: string }> }>(prompt);
      return (result.variations ?? []).slice(0, input.count).map((v, i) => ({
        templateKey: `ollama-v${i + 1}`,
        subject: v.subject?.trim() ?? input.seedSubject,
        body: v.body?.trim() ?? input.seedBody,
        rationale: v.rationale?.trim() ?? '',
      }));
    } catch {
      return this.fallback.generateTemplate(input);
    }
  }

  async analyzeReplies(input: { samples: Array<{ subject: string; body: string; intent: string }> }): Promise<AiReplyAnalysis> {
    /* Cap input size — Ollama context windows are tight for cheap models. */
    const trimmed = input.samples.slice(0, 60).map(s => ({
      subject: (s.subject ?? '').slice(0, 80),
      body: (s.body ?? '').slice(0, 240),
      intent: s.intent,
    }));
    const prompt = [
      `Cluster the following cold-email replies. Identify topics, objections, and operator recommendations.`,
      `Return JSON: { "topics": [{ "label": "...", "count": n, "samples": ["..."] }], `,
      `              "objections": [{ "label": "...", "count": n }], `,
      `              "recommendations": ["..."] }`,
      `Replies (newline-delimited JSON):`,
      ...trimmed.map(t => JSON.stringify(t)),
    ].join('\n');
    try {
      const r = await this.call<AiReplyAnalysis>(prompt);
      return {
        topics: r.topics ?? [],
        objections: r.objections ?? [],
        recommendations: r.recommendations ?? [],
      };
    } catch {
      return this.fallback.analyzeReplies(input);
    }
  }

  async suggestWeights(input: { liftRows: LiftRow[]; currentWeights: ScoringWeights }): Promise<AiWeightSuggestion[]> {
    /* Local LLMs are not reliable for numerical recommendations; we keep the
       Noop adapter's deterministic implementation here and ignore the LLM. */
    return this.fallback.suggestWeights(input);
  }

  async summarizeIntel(input: { leads: Array<{ niche: Niche; techStack: string[]; bookingVendor: string | null; services: string[] }> }): Promise<AiIntelSummary> {
    const sample = input.leads.slice(0, 200);
    const prompt = [
      `Summarize cold-outreach lead facts. Each lead is one JSON line.`,
      `Return JSON: { "byNiche": [{ "niche": "...", "insights": ["..."] }], "global": ["..."] }`,
      `Leads:`,
      ...sample.map(l => JSON.stringify(l)),
    ].join('\n');
    try {
      const r = await this.call<AiIntelSummary>(prompt);
      return { byNiche: r.byNiche ?? [], global: r.global ?? [] };
    } catch {
      return this.fallback.summarizeIntel(input);
    }
  }

  private async call<T>(prompt: string): Promise<T> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      const res = await request(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.cfg.model,
          prompt,
          stream: false,
          format: 'json',
          options: { temperature: 0, num_ctx: 4096 },
        }),
        headersTimeout: this.cfg.requestTimeoutMs,
        bodyTimeout: this.cfg.requestTimeoutMs,
        signal: controller.signal,
      });
      const data = await res.body.json() as { response?: string; error?: string };
      if (res.statusCode >= 400) throw new Error(`ollama_http_${res.statusCode}: ${data.error ?? ''}`);
      if (!data.response) throw new Error('ollama_no_response');
      return JSON.parse(data.response) as T;
    } finally {
      clearTimeout(t);
    }
  }
}
