#!/usr/bin/env tsx
/**
 * `pnpm preflight:deploy` — credential-free deploy readiness audit.
 *
 * Does NOT need Fly, Neon, AWS, or anything else. Confirms:
 *   1. All required files exist.
 *   2. All required scripts pass (delegates to preflight:local).
 *   3. Production-mode env-var schema makes sense (without revealing values).
 *
 * Then prints the operator checklist for the next manual steps.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const RESET = '\x1b[0m';
const GRN = '\x1b[32m'; const RED = '\x1b[31m'; const YEL = '\x1b[33m'; const DIM = '\x1b[2m';
const root = process.cwd();

interface FileCheck { path: string; reason: string }

const required: FileCheck[] = [
  { path: 'fly.toml',                                reason: 'Fly app config (auto-stop, health checks)' },
  { path: 'apps/server/Dockerfile',                  reason: 'Container build for Fly' },
  { path: '.dockerignore',                           reason: 'Keep node_modules + dist + .env out of build context' },
  { path: 'docker-compose.yml',                      reason: 'Local Postgres for development' },
  { path: '.env.example',                            reason: 'Documented env template' },
  { path: '.gitignore',                              reason: 'Must exclude .env, node_modules, .claude' },
  { path: 'package.json',                            reason: 'Workspace + scripts' },
  { path: 'pnpm-lock.yaml',                          reason: 'Reproducible dep install' },
  { path: 'pnpm-workspace.yaml',                     reason: 'Workspace definition' },
  { path: '.github/workflows/test.yml',              reason: 'CI on every PR + push' },
  { path: '.github/workflows/deploy.yml',            reason: 'Deploy on main after tests pass' },
  { path: 'scripts/doctor.ts',                       reason: 'Operator-runnable env check' },
  { path: 'scripts/install-hooks.sh',                reason: 'Installs pre-commit secret scanner' },
  { path: 'scripts/pre-commit.sh',                   reason: 'Refuses commits with .env or key shapes' },
  { path: 'docs/SETUP.md',                           reason: 'New-developer onboarding' },
  { path: 'docs/DEPLOYMENT.md',                      reason: 'Fly deployment instructions' },
  { path: 'docs/COMPLIANCE.md',                      reason: 'CAN-SPAM + Gmail/Yahoo + SES AUP enforcement' },
  { path: 'docs/PROVIDERS.md',                       reason: 'Per-provider config + TOS notes' },
  { path: 'docs/RUNBOOK.md',                         reason: 'Daily/weekly/monthly operator playbook' },
  { path: 'docs/LICENSE-SOURCES.md',                 reason: 'CSV import paths for TX/FL/GA/CA/AZ/NC/TN' },
  { path: 'docs/PRE-ACCOUNT-DEPLOYMENT-AUDIT.md',    reason: 'Confirms repo is account-creation ready' },
];

function checkFiles(): { ok: boolean; missing: FileCheck[] } {
  const missing: FileCheck[] = [];
  for (const f of required) {
    if (!existsSync(resolve(root, f.path))) missing.push(f);
  }
  return { ok: missing.length === 0, missing };
}

function envExamplePresentsExpected(): { ok: boolean; missing: string[] } {
  const txt = readFileSync(resolve(root, '.env.example'), 'utf8');
  const required = [
    'NODE_ENV', 'SAMPLE_MODE', 'BUDGET_MODE', 'PORT', 'PUBLIC_BASE_URL',
    'DATABASE_URL', 'DATABASE_DRIVER',
    'AUTH_TOKEN', 'AUTH_COOKIE_NAME', 'AUTH_COOKIE_SECRET',
    'ORG_NAME', 'FROM_NAME', 'FROM_EMAIL', 'REPLY_TO', 'PHYSICAL_ADDRESS',
    'OUTREACH_SUBDOMAIN', 'DEFAULT_BOOKING_LINK',
    'ENABLE_SES', 'SES_REGION', 'SES_PRODUCTION_ACCESS_CONFIRMED',
    'ENABLE_POSTMARK_INBOUND', 'INBOUND_ADDRESS',
    'ENABLE_OSM', 'ENABLE_YELP', 'ENABLE_PLACES', 'ENABLE_HUNTER', 'ENABLE_BOUNCER',
    'SEEDLIST_EMAILS', 'BOUNCE_PAUSE_PCT', 'COMPLAINT_PAUSE_PCT', 'DAILY_SEND_CAP_DEFAULT',
    'LOG_LEVEL', 'SERVE_WEB',
  ];
  const missing = required.filter(k => !new RegExp(`^${k}=`, 'm').test(txt));
  return { ok: missing.length === 0, missing };
}

function envFileTrackedInGit(): { ok: boolean; tracked: string[] } {
  const r = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: true, tracked: [] };
  const tracked = r.stdout.split(/\r?\n/).filter(l => /(^|\/)\.env(\.[^/]+)?$/.test(l) && !l.endsWith('.example'));
  return { ok: tracked.length === 0, tracked };
}

function main() {
  console.log(`${DIM}preflight:deploy${RESET} — credential-free deploy readiness audit\n`);
  let fail = false;

  /* 1. Required files. */
  const files = checkFiles();
  console.log(files.ok ? `${GRN}✓${RESET} required files (${required.length}) present`
                       : `${RED}✕${RESET} missing files:`);
  if (!files.ok) {
    files.missing.forEach(f => console.log(`    - ${f.path}  ${DIM}${f.reason}${RESET}`));
    fail = true;
  }

  /* 2. .env.example schema. */
  const envSchema = envExamplePresentsExpected();
  if (envSchema.ok) {
    console.log(`${GRN}✓${RESET} .env.example documents all required keys`);
  } else {
    console.log(`${RED}✕${RESET} .env.example missing keys: ${envSchema.missing.join(', ')}`);
    fail = true;
  }

  /* 3. No committed .env. */
  const tracked = envFileTrackedInGit();
  if (tracked.ok) {
    console.log(`${GRN}✓${RESET} no .env file is tracked in git`);
  } else {
    console.log(`${RED}✕${RESET} .env file(s) tracked in git: ${tracked.tracked.join(', ')}`);
    fail = true;
  }

  /* 4. Run preflight:local. */
  console.log(`\n${DIM}→${RESET} running pnpm preflight:local (delegated)`);
  const r = spawnSync('pnpm', ['preflight:local'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail = true;

  /* 5. Operator checklist. */
  console.log(`\n${DIM}---${RESET}`);
  if (fail) {
    console.log(`${RED}Preflight failed. Fix the items above before account creation.${RESET}`);
    process.exit(1);
  }
  console.log(`${GRN}Preflight passed. Repo is account-creation-ready.${RESET}\n`);
  console.log(`${DIM}Next manual steps (read first, then act):${RESET}`);
  console.log(`  1. ${YEL}docs/SECRET-HANDLING.md${RESET}              — how to keep keys out of chat/logs`);
  console.log(`  2. ${YEL}docs/ACCOUNT-CREATION-CHECKLIST.md${RESET}   — which accounts you need NOW vs later`);
  console.log(`  3. ${YEL}bash scripts/generate-secrets.sh${RESET}     — generate strong values locally`);
  console.log(`  4. ${YEL}docs/DEPLOYMENT-SECRETS-RUNBOOK.md${RESET}   — paste into Fly/Neon dashboards, not Claude`);
  console.log(`  5. ${YEL}docs/FIRST-DEPLOYMENT-RUNBOOK.md${RESET}     — flyctl launch → secrets set → deploy → smoke`);
  console.log('');
  console.log(`${DIM}Do not create AWS/SES, Postmark, Yelp, Hunter, or Bouncer accounts until you're actually ready to send.${RESET}`);
  process.exit(0);
}

main();
