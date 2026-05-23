/**
 * Integration-test config — runs against a real Postgres at DATABASE_URL.
 *
 *   docker compose up -d postgres
 *   pnpm db:test
 *
 * Distinct from the unit `pnpm test` (vitest.config.ts) which excludes the
 * integration folder.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/server/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    /* PG boot + migrations + seed can take 30s on a cold machine. */
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    /* Force a single worker so the shared DB is not raced. */
    poolOptions: { forks: { singleFork: true } },
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
