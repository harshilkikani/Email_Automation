#!/usr/bin/env tsx
/**
 * `pnpm doctor` — quick environment + readiness check.
 *
 * Doesn't hit any third-party network beyond your configured DATABASE_URL and
 * PUBLIC_BASE_URL. Prints a coloured checklist + a per-line fix when something
 * is off. Exit code is 0 if all required checks pass, 1 otherwise.
 */
import { Client } from 'pg';
import { request } from 'undici';

const RESET = '\x1b[0m'; const GREEN = '\x1b[32m'; const RED = '\x1b[31m';
const YEL = '\x1b[33m'; const DIM = '\x1b[2m';

interface Check { name: string; state: 'pass' | 'fail' | 'warn'; detail?: string; fix?: string }
const out: Check[] = [];

function need(name: string, fn: () => boolean, detail?: string, fix?: string) {
  out.push({ name, state: fn() ? 'pass' : 'fail', detail, fix });
}
function want(name: string, fn: () => boolean, detail?: string, fix?: string) {
  out.push({ name, state: fn() ? 'pass' : 'warn', detail, fix });
}

const env = process.env;

/* Node version */
const nodeMajor = Number(process.versions.node.split('.')[0]);
need('Node 20+', () => nodeMajor >= 20, `Got ${process.version}`, 'Use nvm or Volta to install Node 20 LTS.');

/* pnpm */
need('pnpm available', () => true, '(invoked via pnpm)');

/* Env vars */
need('DATABASE_URL set', () => !!env.DATABASE_URL, undefined, 'Add DATABASE_URL=postgres://... to .env.');
need('AUTH_TOKEN strong (>=32 chars)', () => !!env.AUTH_TOKEN && env.AUTH_TOKEN.length >= 32 && env.AUTH_TOKEN !== 'change-me',
  env.AUTH_TOKEN ? `length=${env.AUTH_TOKEN.length}` : 'unset',
  'Generate a 48+ char random string: openssl rand -hex 24');
need('AUTH_COOKIE_SECRET strong (>=32 chars)', () => !!env.AUTH_COOKIE_SECRET && env.AUTH_COOKIE_SECRET.length >= 32 && env.AUTH_COOKIE_SECRET !== 'change-me-too',
  env.AUTH_COOKIE_SECRET ? `length=${env.AUTH_COOKIE_SECRET.length}` : 'unset',
  'Same: openssl rand -hex 24');
need('PUBLIC_BASE_URL set', () => !!env.PUBLIC_BASE_URL, undefined, 'Set to https://<host> in production.');

/* Sample mode + production */
if (env.NODE_ENV === 'production') {
  need('SAMPLE_MODE=false in production', () => env.SAMPLE_MODE !== 'true',
    `SAMPLE_MODE=${env.SAMPLE_MODE}`, 'Set SAMPLE_MODE=false in Fly secrets.');
}
want('Seedlist configured', () => !!env.SEEDLIST_EMAILS && env.SEEDLIST_EMAILS.length > 0,
  env.SEEDLIST_EMAILS ?? 'unset', 'Set SEEDLIST_EMAILS to comma-separated mailboxes.');

/* DB reachable */
async function checkDb() {
  if (!env.DATABASE_URL) return;
  try {
    const c = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    await c.connect();
    const r = await c.query('SELECT name FROM _keres_migrations ORDER BY applied_at DESC LIMIT 1');
    const lastMigration = r.rows[0]?.name ?? null;
    await c.end();
    out.push({ name: 'DB reachable', state: 'pass' });
    out.push({
      name: 'Migrations applied', state: lastMigration ? 'pass' : 'fail',
      detail: lastMigration ?? 'no _keres_migrations rows',
      fix: 'Run `pnpm db:migrate`.',
    });
  } catch (e: any) {
    out.push({ name: 'DB reachable', state: 'fail', detail: e?.message, fix: '`docker compose up -d postgres`' });
  }
}

/* PUBLIC_BASE_URL + unsubscribe health */
async function checkUnsub() {
  if (!env.PUBLIC_BASE_URL) return;
  const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/unsubscribe/health`;
  try {
    const r = await request(url, { method: 'GET', headersTimeout: 3000, bodyTimeout: 3000 });
    out.push({
      name: 'Unsubscribe endpoint reachable',
      state: r.statusCode >= 200 && r.statusCode < 400 ? 'pass' : 'fail',
      detail: `status=${r.statusCode} at ${url}`,
      fix: 'Confirm PUBLIC_BASE_URL is correct and that the server is running.',
    });
  } catch (e: any) {
    out.push({
      name: 'Unsubscribe endpoint reachable', state: 'fail',
      detail: e?.message, fix: 'Start the server (`pnpm dev`) or confirm PUBLIC_BASE_URL.',
    });
  }
}

/* Provider config presence */
const providers = [
  { flag: 'ENABLE_SES', vars: ['SES_REGION', 'SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY'] },
  { flag: 'ENABLE_BOUNCER', vars: ['BOUNCER_API_KEY'] },
  { flag: 'ENABLE_HUNTER', vars: ['HUNTER_API_KEY'] },
  { flag: 'ENABLE_YELP', vars: ['YELP_API_KEY'] },
];
for (const p of providers) {
  if (env[p.flag] === 'true') {
    for (const v of p.vars) {
      need(`${p.flag} + ${v}`, () => !!env[v], `${v}=${env[v] ? 'set' : 'empty'}`, `Set ${v} in .env / Fly secrets.`);
    }
  }
}

await checkDb();
await checkUnsub();

let failed = 0, warned = 0;
console.log('');
for (const c of out) {
  const tag = c.state === 'pass' ? `${GREEN}✓${RESET}` : c.state === 'warn' ? `${YEL}◐${RESET}` : `${RED}✕${RESET}`;
  console.log(`${tag} ${c.name}${c.detail ? `  ${DIM}${c.detail}${RESET}` : ''}`);
  if (c.state === 'fail') {
    failed++;
    if (c.fix) console.log(`  ${RED}→${RESET} ${c.fix}`);
  } else if (c.state === 'warn') {
    warned++;
    if (c.fix) console.log(`  ${YEL}→${RESET} ${c.fix}`);
  }
}
console.log('');
console.log(`${failed === 0 ? GREEN + 'All required checks passed.' + RESET : RED + `${failed} required check(s) failed.` + RESET}${warned > 0 ? `  ${YEL}${warned} warning(s).${RESET}` : ''}`);

process.exit(failed === 0 ? 0 : 1);
