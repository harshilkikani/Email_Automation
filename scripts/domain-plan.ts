#!/usr/bin/env tsx
/**
 * `pnpm domain:plan` — dry-run planner for an outreach domain.
 *
 * Reads non-secret values from env, derives the canonical addresses + DNS
 * records the operator will eventually need, and prints them. Mutates
 * nothing. Reads nothing from Neon, Fly, AWS, or Cloudflare.
 *
 * Usage:
 *   ROOT_DOMAIN=example.com \
 *   OUTREACH_SUBDOMAIN=mail \
 *   APP_DOMAIN=ops.example.com \
 *   FROM_LOCAL_PART=hello \
 *   REPLY_TO_LOCAL_PART=replies \
 *   pnpm domain:plan
 *
 * Only ROOT_DOMAIN is required. Defaults:
 *   OUTREACH_SUBDOMAIN     = "outreach"
 *   APP_DOMAIN             = "keres-ops.fly.dev"   (the Fly hostname)
 *   FROM_LOCAL_PART        = "hello"
 *   REPLY_TO_LOCAL_PART    = "replies"
 *   SES_REGION             = "us-east-1"
 *
 * Exits 0 on success, 1 on invalid input. Never writes to disk. Never
 * exposes secrets — it doesn't read any.
 */
import process from 'node:process';

const RESET = '\x1b[0m'; const DIM = '\x1b[2m'; const GRN = '\x1b[32m';
const YEL = '\x1b[33m'; const RED = '\x1b[31m'; const BLU = '\x1b[36m';

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const LABEL_RE  = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const LOCAL_RE  = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/i;

export interface DomainPlanInput {
  rootDomain: string;
  outreachSubdomain: string;
  appDomain: string;
  fromLocalPart: string;
  replyToLocalPart: string;
  sesRegion: string;
}

export interface DnsRecord {
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX';
  name: string;
  value: string;
  ttl?: number;
  priority?: number;
  proxied: boolean;
  note: string;
  source: 'now' | 'from-ses-later' | 'from-postmark-later';
}

export interface DerivedPlan {
  input: DomainPlanInput;
  outreachDomain: string;
  fromEmail: string;
  replyToEmail: string;
  dmarcRua: string;
  dmarcRuf: string;
  records: DnsRecord[];
}

export function derivePlan(raw: Partial<DomainPlanInput>): DerivedPlan {
  const rootDomain = (raw.rootDomain ?? '').trim().toLowerCase();
  if (!rootDomain) throw new Error('ROOT_DOMAIN is required.');
  if (!DOMAIN_RE.test(rootDomain)) throw new Error(`ROOT_DOMAIN "${rootDomain}" is not a valid domain.`);
  const outreachSubdomain = (raw.outreachSubdomain ?? 'outreach').trim().toLowerCase();
  if (!LABEL_RE.test(outreachSubdomain)) throw new Error(`OUTREACH_SUBDOMAIN "${outreachSubdomain}" is not a valid DNS label.`);
  const appDomain = (raw.appDomain ?? 'keres-ops.fly.dev').trim().toLowerCase();
  if (!DOMAIN_RE.test(appDomain)) throw new Error(`APP_DOMAIN "${appDomain}" is not a valid domain.`);
  const fromLocalPart = (raw.fromLocalPart ?? 'hello').trim().toLowerCase();
  if (!LOCAL_RE.test(fromLocalPart)) throw new Error(`FROM_LOCAL_PART "${fromLocalPart}" is not a valid mailbox local-part.`);
  const replyToLocalPart = (raw.replyToLocalPart ?? 'replies').trim().toLowerCase();
  if (!LOCAL_RE.test(replyToLocalPart)) throw new Error(`REPLY_TO_LOCAL_PART "${replyToLocalPart}" is not a valid mailbox local-part.`);
  const sesRegion = (raw.sesRegion ?? 'us-east-1').trim().toLowerCase();

  const outreachDomain = `${outreachSubdomain}.${rootDomain}`;
  const fromEmail = `${fromLocalPart}@${outreachDomain}`;
  const replyToEmail = `${replyToLocalPart}@${outreachDomain}`;
  const dmarcRua = `mailto:dmarc-rua@${rootDomain}`;
  const dmarcRuf = `mailto:dmarc-ruf@${rootDomain}`;

  const records: DnsRecord[] = [];

  /* App hostname (optional pretty CNAME). Only emit if APP_DOMAIN is not the
     bare Fly hostname — otherwise Cloudflare doesn't host it. */
  if (appDomain !== 'keres-ops.fly.dev') {
    records.push({
      type: 'CNAME',
      name: appDomain,
      value: 'keres-ops.fly.dev',
      proxied: false,
      ttl: 300,
      note: 'Pretty hostname for the Fly app. Do not proxy — Fly handles TLS.',
      source: 'now',
    });
  }

  /* SPF on the outreach subdomain — hard fail, only SES allowed to send. */
  records.push({
    type: 'TXT',
    name: outreachDomain,
    value: 'v=spf1 include:amazonses.com -all',
    proxied: false,
    ttl: 300,
    note: 'Sender Policy Framework. -all = anything not in this list is rejected.',
    source: 'now',
  });

  /* DMARC on the root, p=none for the first two weeks of monitoring. */
  records.push({
    type: 'TXT',
    name: `_dmarc.${rootDomain}`,
    value: `v=DMARC1; p=none; rua=${dmarcRua}; ruf=${dmarcRuf}; fo=1; aspf=r; adkim=r;`,
    proxied: false,
    ttl: 300,
    note: 'Start at p=none. Move to quarantine after two clean weeks of aggregate reports.',
    source: 'now',
  });

  /* SES MAIL FROM (Return-Path) MX placeholder — replaces SES's default
     amazonses.com bounce path with one aligned to the outreach subdomain. */
  records.push({
    type: 'MX',
    name: outreachDomain,
    value: `feedback-smtp.${sesRegion}.amazonses.com`,
    priority: 10,
    proxied: false,
    ttl: 300,
    note: 'SES feedback (bounce/complaint) routing. Required for MAIL FROM alignment.',
    source: 'now',
  });
  records.push({
    type: 'TXT',
    name: outreachDomain,
    value: 'v=spf1 include:amazonses.com ~all',
    proxied: false,
    ttl: 300,
    note: 'Secondary SPF for the MAIL FROM domain. Soft-fail because it overlaps with the primary SPF above.',
    source: 'now',
  });

  /* SES Easy DKIM — three CNAMEs that SES gives you after you create the
     verified identity. Cannot be filled in until then. */
  for (const i of [1, 2, 3]) {
    records.push({
      type: 'CNAME',
      name: `<TOKEN${i}>._domainkey.${outreachDomain}`,
      value: `<TOKEN${i}>.dkim.amazonses.com`,
      proxied: false,
      ttl: 300,
      note: `SES Easy DKIM selector ${i}. AWS console shows the exact <TOKEN${i}> after you create the verified identity.`,
      source: 'from-ses-later',
    });
  }

  /* Postmark inbound MX — only added when you opt into reply parsing. */
  records.push({
    type: 'MX',
    name: outreachDomain,
    value: 'inbound.postmarkapp.com',
    priority: 10,
    proxied: false,
    ttl: 300,
    note: 'Postmark Inbound — only add when ENABLE_POSTMARK_INBOUND=true. Conflicts with the SES feedback MX above; pick one or two (use a sub-subdomain).',
    source: 'from-postmark-later',
  });

  return {
    input: {
      rootDomain, outreachSubdomain, appDomain, fromLocalPart, replyToLocalPart, sesRegion,
    },
    outreachDomain, fromEmail, replyToEmail, dmarcRua, dmarcRuf,
    records,
  };
}

export function renderPlan(plan: DerivedPlan): string {
  const out: string[] = [];
  const { input, outreachDomain, fromEmail, replyToEmail, records } = plan;
  out.push(`${BLU}== Derived values (no secrets) ==${RESET}`);
  out.push(`  ROOT_DOMAIN          = ${input.rootDomain}`);
  out.push(`  OUTREACH_DOMAIN      = ${outreachDomain}`);
  out.push(`  APP_DOMAIN           = ${input.appDomain}`);
  out.push(`  FROM_EMAIL           = ${fromEmail}`);
  out.push(`  REPLY_TO_EMAIL       = ${replyToEmail}`);
  out.push(`  SES_REGION           = ${input.sesRegion}`);
  out.push('');

  out.push(`${BLU}== Cloudflare DNS records to add NOW ==${RESET}  ${DIM}(do not proxy any of them)${RESET}`);
  out.push(`  ${DIM}type   name                              value/target${RESET}`);
  for (const r of records.filter(r => r.source === 'now')) {
    const prio = r.priority !== undefined ? ` prio=${r.priority}` : '';
    out.push(`  ${GRN}${r.type.padEnd(6)}${RESET} ${r.name.padEnd(33)} ${r.value}${prio}`);
    out.push(`         ${DIM}↪ ${r.note}${RESET}`);
  }
  out.push('');

  out.push(`${BLU}== DNS records to add AFTER SES verifies the identity ==${RESET}`);
  out.push(`  ${DIM}You cannot fill in <TOKEN1/2/3> until AWS SES → Verified identities${RESET}`);
  out.push(`  ${DIM}→ Create identity → Easy DKIM has run.${RESET}`);
  for (const r of records.filter(r => r.source === 'from-ses-later')) {
    out.push(`  ${YEL}${r.type.padEnd(6)}${RESET} ${r.name.padEnd(46)} ${r.value}`);
    out.push(`         ${DIM}↪ ${r.note}${RESET}`);
  }
  out.push('');

  out.push(`${BLU}== DNS to defer until inbound reply parsing is wanted ==${RESET}`);
  for (const r of records.filter(r => r.source === 'from-postmark-later')) {
    const prio = r.priority !== undefined ? ` prio=${r.priority}` : '';
    out.push(`  ${DIM}${r.type.padEnd(6)} ${r.name.padEnd(33)} ${r.value}${prio}${RESET}`);
    out.push(`         ${DIM}↪ ${r.note}${RESET}`);
  }
  out.push('');

  out.push(`${BLU}== Fly secrets / app settings that may change later ==${RESET}`);
  out.push(`  ${DIM}(do not run yet — pasted here so you know what to set after DNS is live)${RESET}`);
  out.push(`  flyctl secrets set --stage --app keres-ops \\`);
  out.push(`    FROM_EMAIL=${fromEmail} \\`);
  out.push(`    REPLY_TO=${replyToEmail} \\`);
  out.push(`    OUTREACH_SUBDOMAIN=${outreachDomain}`);
  out.push('');
  out.push(`  ${DIM}Then update the org row in Neon (via UI Settings or PUT /api/settings).${RESET}`);
  out.push('');

  out.push(`${RED}== DO NOT do yet ==${RESET}`);
  out.push(`  ${RED}✕${RESET} do not set ENABLE_SES=true`);
  out.push(`  ${RED}✕${RESET} do not mark DNS verified — wait for the runtime DNS check to pass`);
  out.push(`  ${RED}✕${RESET} do not run a seedlist test until ENABLE_SES is intentionally enabled and SES is in production access`);
  out.push(`  ${RED}✕${RESET} do not launch any campaign`);
  out.push(`  ${RED}✕${RESET} do not enable Postmark outbound — this app only uses Postmark Inbound`);
  out.push(`  ${RED}✕${RESET} do not enable Hunter, Bouncer, Yelp, or Google Places paid tiers`);
  out.push(`  ${RED}✕${RESET} do not allocate a dedicated SES IP, Virtual Deliverability Manager, or Mail Manager paid features`);
  out.push('');

  out.push(`${DIM}This script mutated nothing. No secrets were read. Re-run any time as values change.${RESET}`);
  return out.join('\n');
}

function main(): void {
  try {
    const plan = derivePlan({
      rootDomain: process.env.ROOT_DOMAIN ?? '',
      outreachSubdomain: process.env.OUTREACH_SUBDOMAIN,
      appDomain: process.env.APP_DOMAIN,
      fromLocalPart: process.env.FROM_LOCAL_PART,
      replyToLocalPart: process.env.REPLY_TO_LOCAL_PART,
      sesRegion: process.env.SES_REGION,
    });
    console.log(renderPlan(plan));
  } catch (e: any) {
    process.stderr.write(`${RED}✕ ${e?.message ?? e}${RESET}\n`);
    process.stderr.write(`${DIM}Set ROOT_DOMAIN=<your-domain> and re-run.${RESET}\n`);
    process.exit(1);
  }
}

/* Only run main() when invoked directly, not when imported by tests. */
const isDirect = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return argv1.includes('domain-plan');
  } catch { return false; }
})();
if (isDirect) main();
