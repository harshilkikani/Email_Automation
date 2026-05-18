/**
 * DB client factory. Supports two drivers:
 *  - `node`             — `pg` against any reachable Postgres (local, Fly Postgres).
 *  - `neon-serverless`  — `@neondatabase/serverless` for Neon's HTTP-fetch driver.
 *
 * The choice is controlled by `DATABASE_DRIVER` in the environment.
 */
import * as schema from './schema.js';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { neon, neonConfig } from '@neondatabase/serverless';

export type Schema = typeof schema;
/**
 * Both driver flavors return a Drizzle client with the same query surface for
 * our usage. We pick the node-postgres flavor as the canonical TS type so the
 * server's calls (`.returning(...)` etc.) typecheck cleanly regardless of
 * which driver the env selects at runtime.
 */
export type Database = ReturnType<typeof drizzleNode<Schema>>;

let cached: { db: Database; close: () => Promise<void> } | null = null;

export function getDb(): Database {
  return getDbWithClose().db;
}

export function getDbWithClose(): { db: Database; close: () => Promise<void> } {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL not set');
  }
  const driver = process.env.DATABASE_DRIVER ?? 'node';
  if (driver === 'neon-serverless') {
    neonConfig.fetchConnectionCache = true;
    const sql = neon(url);
    const db = drizzleNeon(sql, { schema }) as unknown as Database;
    cached = { db, close: async () => undefined };
  } else {
    const pool = new Pool({ connectionString: url, max: 10 });
    const db = drizzleNode(pool, { schema });
    cached = { db, close: async () => { await pool.end(); } };
  }
  return cached;
}

export { schema };
