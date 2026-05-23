import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Alias order matters — Vitest matches the first key whose string is a prefix.
 * Subpath aliases (`@keres/email/headers`) MUST appear before bare aliases
 * (`@keres/email`).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/server/integration/**'],
    pool: 'threads',
    reporters: ['default'],
  },
  resolve: {
    alias: [
      { find: '@keres/db/schema',         replacement: path.resolve(here, 'packages/db/src/schema.ts') },
      { find: '@keres/db/client',         replacement: path.resolve(here, 'packages/db/src/client.ts') },
      { find: '@keres/db',                replacement: path.resolve(here, 'packages/db/src/index.ts') },
      { find: '@keres/core/scoring',      replacement: path.resolve(here, 'packages/core/src/scoring.ts') },
      { find: '@keres/core/dedupe',       replacement: path.resolve(here, 'packages/core/src/dedupe.ts') },
      { find: '@keres/core/templates',    replacement: path.resolve(here, 'packages/core/src/templates.ts') },
      { find: '@keres/core/validation',   replacement: path.resolve(here, 'packages/core/src/validation.ts') },
      { find: '@keres/core/budget',       replacement: path.resolve(here, 'packages/core/src/budget.ts') },
      { find: '@keres/core/filters',      replacement: path.resolve(here, 'packages/core/src/filters.ts') },
      { find: '@keres/core',              replacement: path.resolve(here, 'packages/core/src/index.ts') },
      { find: '@keres/email/headers',     replacement: path.resolve(here, 'packages/email/src/headers.ts') },
      { find: '@keres/email/unsubscribe', replacement: path.resolve(here, 'packages/email/src/unsubscribe.ts') },
      { find: '@keres/email/linter',      replacement: path.resolve(here, 'packages/email/src/linter.ts') },
      { find: '@keres/email/render',      replacement: path.resolve(here, 'packages/email/src/render.ts') },
      { find: '@keres/email',             replacement: path.resolve(here, 'packages/email/src/index.ts') },
      { find: '@keres/providers',         replacement: path.resolve(here, 'packages/providers/src/index.ts') },
    ],
  },
});
