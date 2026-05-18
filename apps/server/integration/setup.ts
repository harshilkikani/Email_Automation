/**
 * Integration-test bootstrap. Runs once per `db:test` invocation:
 *   1. Probes the configured DATABASE_URL.
 *   2. If unreachable, throws with an actionable message (tests skip).
 *   3. Drops & recreates the `public` schema for a truly fresh DB.
 *   4. Runs migrations + seed.
 *   5. Returns a Fastify app + a thin HTTP helper.
 */
import { Client } from 'pg';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

export async function ensurePg(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.end();
  } catch (e: any) {
    throw new Error(
      `Cannot connect to Postgres at ${url}. ` +
      `Start it with \`docker compose up -d postgres\` and retry. ` +
      `Underlying: ${e?.message ?? e}`,
    );
  }
}

export async function resetSchema(): Promise<void> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE');
    await c.query('CREATE SCHEMA public');
    await c.query('GRANT ALL ON SCHEMA public TO public');
    /* Also reset the migration ledger if it exists outside public. */
    await c.query('DROP TABLE IF EXISTS _keres_migrations');
  } finally {
    await c.end();
  }
}

function runScript(args: string[], extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn('pnpm', args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...extraEnv },
      shell: process.platform === 'win32',
    });
    p.on('exit', code => code === 0 ? res() : rej(new Error(`${args.join(' ')} failed with exit ${code}`)));
  });
}

export async function migrateAndSeed(): Promise<void> {
  await runScript(['--filter', '@keres/db', 'migrate']);
  await runScript(['--filter', '@keres/server', 'seed']);
}

export { __dirname };
