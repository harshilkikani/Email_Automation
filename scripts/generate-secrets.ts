#!/usr/bin/env tsx
/**
 * `pnpm secrets:gen` — generate strong secrets for first deployment.
 *
 * Prints to stdout in a format suitable for piping into your secrets manager:
 *   pnpm secrets:gen > secrets.txt           # then move to 1Password and delete
 *   pnpm secrets:gen | clip                  # Windows clipboard
 *   pnpm secrets:gen | pbcopy                # macOS clipboard
 *
 * Each value is 48 hex chars (192 bits of entropy from /dev/urandom).
 *
 * Do NOT:
 *   - paste these into chat
 *   - commit them
 *   - email them
 *
 * Do:
 *   - paste them into your password manager
 *   - paste them into `flyctl secrets set` directly in your terminal
 *   - paste them into your Neon dashboard (no — Neon hands you the DB URL)
 *
 * Use --quiet to suppress the explanatory header (good when piping into scripts).
 */
import { randomBytes } from 'node:crypto';

/* If the consumer closes the pipe (e.g. `... | head -3`), exit cleanly
   instead of throwing EPIPE. */
process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); });
process.stderr.on('error', () => undefined);

const quiet = process.argv.includes('--quiet');

function rand(): string {
  return randomBytes(24).toString('hex');     // 48 hex chars, 192 bits
}

const secrets = {
  AUTH_TOKEN: rand(),
  AUTH_COOKIE_SECRET: rand(),
  UNSUBSCRIBE_SIGNING_SECRET: rand(),
};

if (!quiet) {
  process.stderr.write([
    '# ─────────────────────────────────────────────────────────────',
    '# Keres AI — fresh secrets (do not commit, do not paste in chat)',
    '# Each value is 48 hex chars (192 bits of entropy).',
    '# Store these in your password manager / Fly secrets / GitHub secrets.',
    '# Anyone with AUTH_TOKEN can sign in. Anyone with AUTH_COOKIE_SECRET',
    '# can forge sessions. Anyone with UNSUBSCRIBE_SIGNING_SECRET can forge',
    '# unsubscribe tokens. Rotate immediately if any leak.',
    '# ─────────────────────────────────────────────────────────────',
    '',
  ].join('\n'));
}

for (const [k, v] of Object.entries(secrets)) {
  process.stdout.write(`${k}=${v}\n`);
}

if (!quiet) {
  process.stderr.write([
    '',
    '# Next: pipe these into your secrets store. Example:',
    '#   pnpm secrets:gen --quiet | while IFS== read -r k v; do',
    '#     flyctl secrets set "$k=$v" --app keres-ops',
    '#   done',
    '# Or one at a time:',
    '#   flyctl secrets set AUTH_TOKEN="<paste>" --app keres-ops',
    '',
  ].join('\n'));
}
