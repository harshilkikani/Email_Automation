/**
 * Server-side AI adapter factory.
 *
 * Reads ENABLE_LOCAL_AI + AI_RUNTIME from config and returns the appropriate
 * AiAdapter singleton. Falls back to NoopAiAdapter when:
 *   - ENABLE_LOCAL_AI=false (default)
 *   - AI_RUNTIME is anything other than 'ollama'
 *   - OLLAMA_URL is missing
 *
 * The singleton is constructed once at first call and reused. The Ollama
 * adapter itself falls back to NoopAiAdapter on any per-call error, so the
 * system is always safe to call regardless of whether Ollama is running.
 */
import { NoopAiAdapter, OllamaAdapter, type AiAdapter } from '@keres/core';
import { getConfig } from '../config.js';

let _adapter: AiAdapter | null = null;

export function getAiAdapter(): AiAdapter {
  if (_adapter) return _adapter;
  const cfg = getConfig();
  if (cfg.ai.enabled && cfg.ai.runtime === 'ollama' && cfg.ai.ollamaUrl) {
    _adapter = new OllamaAdapter(cfg.ai.ollamaUrl, cfg.ai.ollamaModel);
  } else {
    _adapter = new NoopAiAdapter();
  }
  return _adapter;
}

/** Reset the singleton — used in tests only. */
export function resetAiAdapter(): void {
  _adapter = null;
}
