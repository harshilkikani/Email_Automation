/**
 * Queue layer coverage notes.
 *
 * `apps/server/src/services/queue.ts` is a DB-only abstraction (db tier:
 * uses the `job_runs` table directly with SELECT ... FOR UPDATE SKIP LOCKED
 * to claim work; pg-boss tier: defers to the pg-boss library). Every
 * function in the module touches Postgres; there is no pure unit to test
 * in isolation without either an in-memory PG (pg-mem) or a real
 * connection.
 *
 * Decision: cover the queue with integration tests against the real
 * Postgres container used by `pnpm db:test`, NOT with mocked unit tests.
 * Mocking Drizzle's `db.execute(sql\`...\`)` results would re-implement
 * Postgres semantics inside vitest and immediately drift from reality.
 *
 * The placeholder below documents the desired coverage. When this is
 * picked up:
 *   - Move it into `apps/server/integration/queue.test.ts`.
 *   - Mirror the `pgReachable` skip-logic from `integration.test.ts`.
 *   - Call `initQueue(db, log)` to bring the adapter up.
 *   - Register a deterministic test handler via `getQueue().work()`.
 *   - Use `enqueue()` to fire jobs and assert outcomes.
 *
 * Tests to add when this is unblocked:
 *   1. enqueue → handler called once → job_runs row transitions to 'done'
 *   2. handler throws → attempts increments → retried up to retryLimit
 *      → moves to dead_letters on final failure
 *   3. singletonKey: two enqueues with the same key produce one job
 *   4. concurrent workers: two pollers in the same process do not double-claim
 *      (verified via FOR UPDATE SKIP LOCKED)
 *   5. scheduledFor in the future is honoured (not claimed until due)
 *
 * The current build already exercises the queue *initialization* path on
 * every integration-test app boot (see test-server.ts). The reply-FSM and
 * saturation tests in this PR cover the two largest pure-function gaps;
 * queue is the next priority.
 */
import { describe, it } from 'vitest';

describe('queue (placeholder)', () => {
  it.skip('integration tests pending — see file header for the plan', () => {
    /* intentionally empty */
  });
});
