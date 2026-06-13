/**
 * One-shot production verification / activation, runnable inside the Fly machine:
 *
 *   fly ssh console -a keres-ops -C "node apps/server/dist/apps/server/src/ops-verify.js"
 *
 * Steps (each is idempotent / safe to re-run):
 *   1. Reconcile the org + sender domain to the configured identity (same as seed).
 *   2. Run a live DNS check against the sender domain (updates SPF/DKIM/DMARC +
 *      unsubscribe-reachability status — Fly has working DNS, unlike a sandbox).
 *   3. Send one seedlist self-test through the real outbound provider.
 *   4. Print the launch gate so it's obvious what (if anything) still blocks.
 *
 * Pass `--no-send` to skip the test email.
 */
import { getDbWithClose, schema } from '@keres/db';
import { getConfig } from './config.js';
import { runDnsCheck } from './services/sender.js';
import { sendSeedlistTest } from './services/seedlist.js';
import { evaluateLaunchGate } from './services/launch-gate.js';
import { eq } from 'drizzle-orm';

async function main() {
  const cfg = getConfig();
  const send = !process.argv.includes('--no-send');
  const { db, close } = getDbWithClose();
  try {
    const org = (await db.select().from(schema.organizations).limit(1))[0];
    if (!org) { console.error('No organization — run seed first.'); process.exit(1); }
    const dom = (await db.select().from(schema.senderDomains).where(eq(schema.senderDomains.orgId, org.id)).limit(1))[0];
    if (!dom) { console.error('No sender domain — run seed first.'); process.exit(1); }

    console.log(`\nOutbound: ${cfg.smtp.enabled ? `SMTP ${cfg.smtp.host} as ${cfg.smtp.user}` : 'see config'} | sampleMode=${cfg.sampleMode}`);
    console.log(`Identity: ${org.fromName} <${org.fromEmail}> | address: ${org.physicalAddress || '<EMPTY>'}\n`);

    /* 2. Live DNS check (persists status onto the sender_domains row). */
    console.log(`Running DNS check for ${dom.domain} …`);
    const dns = await runDnsCheck(dom.domain, {
      sampleMode: false,
      expectedSpfInclude: dom.spfExpectedInclude ?? undefined,
      requiredDkimSelectors: dom.dkimSelectors ?? undefined,
      publicBaseUrl: cfg.publicBaseUrl,
    });
    await db.update(schema.senderDomains).set({
      spfStatus: dns.spf, dkimStatus: dns.dkim, dmarcStatus: dns.dmarc, mxStatus: dns.mx,
      dmarcPolicy: dns.dmarcPolicy ?? null,
      unsubReachable: dns.unsubscribeReachable === 'pass',
      unsubLastStatus: dns.detail.unsubscribe.status ?? null,
      lastCheckedAt: new Date(),
      lastCheckDetail: dns as unknown as Record<string, unknown>,
    }).where(eq(schema.senderDomains.id, dom.id));
    console.log(`  SPF=${dns.spf} DKIM=${dns.dkim} DMARC=${dns.dmarc} MX=${dns.mx} unsub=${dns.unsubscribeReachable}\n`);

    /* 3. Live send test. */
    if (send) {
      console.log('Sending seedlist self-test to', cfg.seedlistEmails.join(', '), '…');
      const r = await sendSeedlistTest(db, dom.id, undefined, 'Keres PROD activation test');
      console.log('  ', JSON.stringify(r), '\n');
    }

    /* 4. Launch gate. */
    const gate = await evaluateLaunchGate(db, { bouncePausePct: cfg.bouncePausePct, complaintPausePct: cfg.complaintPausePct, seedlistTtlHours: 72 });
    console.log(`LAUNCH GATE: ${gate.ok ? 'PASS ✅' : `BLOCKED — ${gate.blockingCount} blocker(s)`}`);
    for (const c of gate.checks) {
      const icon = c.state === 'pass' ? 'PASS' : c.state === 'fail' ? 'FAIL' : c.state.toUpperCase();
      console.log(`  ${icon}  ${c.label}${c.state === 'fail' && c.fix ? `  → ${c.fix}` : ''}`);
    }
  } finally {
    await close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
