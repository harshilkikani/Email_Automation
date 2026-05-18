/**
 * Lint-style assertions that disallowed provider files do NOT exist in the
 * repo. Catches the spec rule "no Resend/Postmark outbound, no Apollo/Clay/
 * LinkedIn integrations at MVP".
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readdirSync } from 'node:fs';

const PROVIDERS_DIR = resolve(__dirname, '..', 'src');

const FORBIDDEN_FILES = [
  'resend.ts', 'resend-outbound.ts',
  'postmark-outbound.ts', 'postmark.ts',
  'apollo.ts', 'clay.ts', 'linkedin.ts', 'zoominfo.ts', 'rocketreach.ts',
];

describe('forbidden provider files do not exist', () => {
  for (const f of FORBIDDEN_FILES) {
    it(`no src/${f}`, () => {
      expect(existsSync(join(PROVIDERS_DIR, f))).toBe(false);
    });
  }
});

describe('no provider source mentions a forbidden vendor as a sender', () => {
  it('no file exports an outbound provider tied to Resend or Postmark', async () => {
    const files = readdirSync(PROVIDERS_DIR).filter(f => f.endsWith('.ts'));
    for (const f of files) {
      const src = await (await import('node:fs/promises')).readFile(join(PROVIDERS_DIR, f), 'utf8');
      const lower = src.toLowerCase();
      /* Postmark Inbound is fine — only INBOUND parser may exist. */
      if (lower.includes('postmark') && !f.includes('inbound')) {
        expect.fail(`Postmark referenced in ${f}, but only inbound.ts is allowed to mention Postmark.`);
      }
      expect(lower).not.toMatch(/\bresend\.com\b/);
      expect(lower).not.toMatch(/\bapollo\.io\b/);
      expect(lower).not.toMatch(/\bclay\.com\b/);
      expect(lower).not.toMatch(/\blinkedin\.com\b/);
      expect(lower).not.toMatch(/\brocketreach\.co\b/);
      expect(lower).not.toMatch(/\bzoominfo\.com\b/);
    }
  });
});
