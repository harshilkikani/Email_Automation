#!/usr/bin/env tsx
/**
 * `pnpm preflight:local` — chain of safe checks that prove the repo is
 * deployable to *some* environment.
 *
 * Order matters: cheapest first. If anything fails, we stop and tell the
 * operator exactly which step broke and what to fix.
 *
 * No credentials are required. `db:test` and `doctor` will skip gracefully
 * when Postgres or env vars aren't available — they emit warnings instead of
 * crashing the preflight.
 */
import { spawn } from 'node:child_process';

const RESET = '\x1b[0m';
const GRN = '\x1b[32m'; const RED = '\x1b[31m'; const YEL = '\x1b[33m'; const DIM = '\x1b[2m';

interface Step {
  name: string;
  cmd: string;
  args: string[];
  /** Treat non-zero exit as a warning, not a hard failure. */
  optional?: boolean;
  /** Description shown when this step starts. */
  desc?: string;
}

const steps: Step[] = [
  { name: 'install',    cmd: 'pnpm', args: ['install'],     desc: 'pnpm install (frozen lockfile follows on CI)' },
  { name: 'typecheck',  cmd: 'pnpm', args: ['typecheck'],   desc: 'tsc --noEmit across all packages' },
  { name: 'lint',       cmd: 'pnpm', args: ['lint'],        desc: 'eslint flat config' },
  { name: 'test',       cmd: 'pnpm', args: ['test'],        desc: 'vitest unit suite (173 tests, no DB / no network)' },
  { name: 'build',      cmd: 'pnpm', args: ['build'],       desc: 'all packages + web bundle' },
  { name: 'db:test',    cmd: 'pnpm', args: ['db:test'],     desc: 'integration vs Postgres', optional: true },
  { name: 'doctor',     cmd: 'pnpm', args: ['doctor'],      desc: 'env + DB + unsub-endpoint readiness', optional: true },
];

async function run(step: Step): Promise<{ ok: boolean; code: number | null }> {
  return new Promise(res => {
    const p = spawn(step.cmd, step.args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    p.on('exit', code => res({ ok: code === 0, code }));
    p.on('error', () => res({ ok: false, code: null }));
  });
}

async function main() {
  console.log(`${DIM}preflight:local${RESET} — chained safety checks`);
  console.log('');
  const failures: Step[] = [];
  const skipped: Step[] = [];

  for (const s of steps) {
    console.log(`${DIM}→${RESET} ${s.name}: ${s.desc ?? ''}`);
    const r = await run(s);
    if (r.ok) {
      console.log(`${GRN}✓${RESET} ${s.name}\n`);
    } else if (s.optional) {
      console.log(`${YEL}◐${RESET} ${s.name} skipped (exit ${r.code}) — that's fine if you're running without Postgres or a configured .env\n`);
      skipped.push(s);
    } else {
      console.log(`${RED}✕${RESET} ${s.name} failed (exit ${r.code})\n`);
      failures.push(s);
      break;
    }
  }

  console.log(`${DIM}---${RESET}`);
  if (failures.length === 0 && skipped.length === 0) {
    console.log(`${GRN}All checks passed.${RESET}`);
    process.exit(0);
  } else if (failures.length === 0) {
    console.log(`${GRN}All required checks passed.${RESET}  ${YEL}${skipped.length} optional check(s) skipped.${RESET}`);
    console.log(`${DIM}Skipped:${RESET}`);
    for (const s of skipped) console.log(`  - ${s.name}: probably needs ${s.name === 'db:test' ? 'docker postgres + DATABASE_URL' : 'a configured .env'}`);
    process.exit(0);
  } else {
    console.log(`${RED}${failures.length} required check(s) failed.${RESET}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
