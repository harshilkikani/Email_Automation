/**
 * Lightweight migration runner.
 * Reads ./migrations/*.sql in lexical order and applies any that aren't already in `_keres_migrations`.
 * Designed to work with both `pg` (node) and `@neondatabase/serverless`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'migrations');

async function ensureLedger(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _keres_migrations (
      name        text primary key,
      applied_at  timestamptz not null default now()
    );
  `);
}

async function appliedSet(client: Client): Promise<Set<string>> {
  const r = await client.query('SELECT name FROM _keres_migrations');
  return new Set(r.rows.map(x => x.name as string));
}

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await ensureLedger(client);
    const applied = await appliedSet(client);
    const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      console.log(`▶︎ Applying ${file} (${sql.length} bytes)`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _keres_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`✓ Applied ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    console.log('All migrations up to date.');
  } finally {
    await client.end();
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
