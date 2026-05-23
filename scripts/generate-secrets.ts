#!/usr/bin/env tsx
/**
 * `pnpm secrets:gen` — generate strong secrets to a locked local file.
 *
 * DEFAULT: writes KEY=value lines to ~/.keres-secrets.env, refuses to
 * overwrite an existing file, restricts the file ACL to the current user
 * on Windows, and prints only which key NAMES were written — never values.
 *
 * Flags:
 *   --rotate         allow overwriting an existing file (regenerates ALL keys
 *                    — invalidates live sessions and unsubscribe tokens)
 *   --out <path>     custom output path (default: ~/.keres-secrets.env)
 *   --stdout         write KEY=value lines to stdout instead of a file
 *                    (for piping into 1Password / a clipboard manager)
 *   --quiet          suppress explanatory output
 *
 * Generated keys (each 48 hex chars / 192 bits of entropy):
 *   AUTH_TOKEN                  bearer token for /api/auth/login
 *   AUTH_COOKIE_SECRET          session cookie signer
 *   UNSUBSCRIBE_SIGNING_SECRET  unsubscribe + seedlist token signer
 *
 * The app's other "webhook" surfaces use provider-side signatures:
 *   - SES SNS notifications are verified via Amazon's public-key signing
 *     (see packages/providers/src/ses-events.ts), no shared secret needed.
 *   - Postmark Inbound uses Basic Auth (POSTMARK_INBOUND_USERNAME/PASSWORD).
 * So there is no separate WEBHOOK_SIGNING_SECRET.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); });
process.stderr.on('error', () => undefined);

interface Args { rotate: boolean; out: string; stdout: boolean; quiet: boolean }

function parseArgs(): Args {
  const a = process.argv.slice(2);
  let out = join(homedir(), '.keres-secrets.env');
  const oi = a.indexOf('--out');
  if (oi >= 0 && a[oi + 1]) out = a[oi + 1] as string;
  return {
    rotate: a.includes('--rotate'),
    out,
    stdout: a.includes('--stdout'),
    quiet: a.includes('--quiet'),
  };
}

function rand(): string {
  return randomBytes(24).toString('hex');
}

function lockAclOnWindows(path: string): boolean {
  if (process.platform !== 'win32') return false;
  const user = process.env.USERNAME;
  if (!user) return false;
  const r = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
  return r.status === 0;
}

function main(): void {
  const args = parseArgs();
  const secrets: Record<string, string> = {
    AUTH_TOKEN: rand(),
    AUTH_COOKIE_SECRET: rand(),
    UNSUBSCRIBE_SIGNING_SECRET: rand(),
  };
  const body = Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

  if (args.stdout) {
    if (!args.quiet) {
      process.stderr.write('# secrets:gen --stdout — pipe these into your password manager / clipboard. Do not commit.\n');
    }
    process.stdout.write(body);
    return;
  }

  if (existsSync(args.out) && !args.rotate) {
    process.stderr.write(`✗ ${args.out} already exists. Refusing to overwrite.\n`);
    process.stderr.write(`  Run with --rotate to regenerate (this INVALIDATES live sessions and unsubscribe tokens).\n`);
    process.exit(1);
  }

  writeFileSync(args.out, body, { mode: 0o600 });
  const locked = lockAclOnWindows(args.out);

  if (!args.quiet) {
    const verb = args.rotate ? 'rotated' : 'wrote';
    console.log(`✓ ${verb} ${Object.keys(secrets).length} secrets to ${args.out}`);
    console.log(`  Keys: ${Object.keys(secrets).join(', ')}`);
    console.log(`  Each value is 48 hex chars / 192 bits. Values were NOT printed.`);
    if (process.platform === 'win32') {
      console.log(`  ACL: ${locked ? `restricted to ${process.env.USERNAME ?? 'current user'} via icacls` : 'icacls failed — inherited home-dir ACLs only'}`);
    }
    console.log(`  Next: pipe these into Fly secrets without echoing values, e.g.`);
    console.log(`    Get-Content ${args.out} | ForEach-Object { flyctl secrets set $_ --stage --app keres-ops }`);
  }
}

main();
