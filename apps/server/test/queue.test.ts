/**
 * Queue layer coverage notes.
 *
 * The real DB-bound tests for `apps/server/src/services/queue.ts` (enqueue,
 * singletonKey dedup, metrics) live in `apps/server/integration/integration.test.ts`
 * as part of the integration suite. Putting them there ensures:
 *   - They run under `pnpm db:test`, never under `pnpm test`.
 *   - They share the single seeded DB fork the integration suite uses
 *     (singleFork: true in vitest.integration.config.ts) instead of
 *     racing the schema reset.
 *
 * This file remains as a navigation breadcrumb for future contributors
 * looking for "queue tests".
 */
import { describe, it } from 'vitest';

describe('queue (unit placeholder)', () => {
  it.skip('see apps/server/integration/integration.test.ts — queue tests live there', () => {
    /* intentionally empty */
  });
});
