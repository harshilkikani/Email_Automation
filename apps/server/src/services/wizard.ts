/**
 * "First Validation Run" wizard.
 *
 * Server-derives each step's status from existing diagnostics + launch-gate +
 * domain/lead/experiment state, so the operator can refresh the browser and
 * see the same checklist position. Operator notes per step are persisted in
 * `wizard_progress`. The wizard NEVER bypasses the launch gate — Step 14
 * literally renders the live gate output.
 */
import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '@keres/db';
import { schema } from '@keres/db';
import { runDiagnostics } from './diagnostics.js';
import { getConfig } from '../config.js';

export const WIZARD_KEY = 'first-validation-septic-houston';

export type StepStatus = 'pass' | 'fail' | 'warn' | 'todo' | 'skip';

export interface WizardStep {
  key: string;
  label: string;
  status: StepStatus;
  description: string;
  detail?: string;
  fix?: string;
  deepLink?: string;        // frontend route to remediate
  /** Operator-saved notes; defaults to empty string. */
  notes: string;
}

export interface WizardReport {
  wizardKey: string;
  productionMode: boolean;
  steps: WizardStep[];
  blockingCount: number;
  warnCount: number;
  generatedAt: string;
}

export async function generateWizard(db: Database): Promise<WizardReport> {
  const cfg = getConfig();
  const org = (await db.select().from(schema.organizations).limit(1))[0];
  const orgId = org?.id ?? '';
  const diag = await runDiagnostics();
  const checks = new Map(diag.gate.checks.map(c => [c.code, c]));

  /* Pull notes for this wizard from the DB. */
  const notesRows = orgId
    ? await db.select().from(schema.wizardProgress).where(and(eq(schema.wizardProgress.orgId, orgId), eq(schema.wizardProgress.wizardKey, WIZARD_KEY)))
    : [];
  const noteByStep = new Map(notesRows.map(r => [r.stepKey, r.notes ?? '']));

  /* License + leads + experiment + recent campaign state. */
  const licenseCount = (await db.select({ c: sql<number>`count(*)::int` })
    .from(schema.stateLicensees).where(and(eq(schema.stateLicensees.state, 'TX'), eq(schema.stateLicensees.niche, 'Septic'))))[0]?.c ?? 0;
  const leadCount = orgId
    ? (await db.select({ c: sql<number>`count(*)::int` })
        .from(schema.leads).where(and(eq(schema.leads.orgId, orgId), eq(schema.leads.niche, 'Septic'))))[0]?.c ?? 0
    : 0;
  const experiment = orgId
    ? (await db.select().from(schema.validationExperiments)
        .where(and(eq(schema.validationExperiments.orgId, orgId), eq(schema.validationExperiments.niche, 'Septic')))
        .limit(1))[0]
    : undefined;
  const reviewCount = experiment
    ? (await db.select({ c: sql<number>`count(*)::int` })
        .from(schema.validationReviews).where(eq(schema.validationReviews.experimentId, experiment.id)))[0]?.c ?? 0
    : 0;
  const reachCampaign = experiment?.campaignId
    ? (await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, experiment.campaignId)).limit(1))[0]
    : undefined;

  const sm = (code: string): StepStatus => {
    const c = checks.get(code); if (!c) return 'todo';
    return (c.state as StepStatus) ?? 'todo';
  };

  const steps: WizardStep[] = [
    {
      key: 'env_ready',
      label: '1. Environment readiness',
      status: sm('sample_mode_off') === 'pass' ? 'pass' : 'fail',
      description: 'SAMPLE_MODE=false; DATABASE_URL set; AUTH_TOKEN strong; secrets present.',
      detail: checks.get('sample_mode_off')?.detail,
      fix: 'Set SAMPLE_MODE=false in .env / Fly secrets. Restart server.',
      deepLink: '/diagnostics',
      notes: noteByStep.get('env_ready') ?? '',
    },
    {
      key: 'sender_identity',
      label: '2. Sender identity',
      status: sm('sender_identity_complete'),
      description: 'From / Reply-To / Org name configured.',
      deepLink: '/settings',
      notes: noteByStep.get('sender_identity') ?? '',
    },
    {
      key: 'physical_address',
      label: '3. Physical mailing address (CAN-SPAM)',
      status: sm('physical_address_set'),
      description: 'A real, deliverable street address. CAN-SPAM-required.',
      deepLink: '/settings',
      notes: noteByStep.get('physical_address') ?? '',
    },
    {
      key: 'outreach_subdomain',
      label: '4. Outreach subdomain',
      status: sm('sender_domain_exists'),
      description: 'A dedicated subdomain like outreach.yourdomain.com (never the root).',
      deepLink: '/deliverability',
      notes: noteByStep.get('outreach_subdomain') ?? '',
    },
    {
      key: 'ses_production',
      label: '5. SES production access',
      status: sm('ses_production_access'),
      description: 'SES sandbox lifted. Configure region + access keys + configuration set.',
      fix: 'Open AWS SES → request production access. Then toggle Settings → Compliance.',
      deepLink: '/settings',
      notes: noteByStep.get('ses_production') ?? '',
    },
    {
      key: 'dns_records',
      label: '6. SPF / DKIM / DMARC',
      status: ['spf_pass', 'dkim_pass', 'dmarc_pass'].every(c => sm(c) === 'pass') ? 'pass' : 'fail',
      description: 'All three checks pass; DKIM requires all 3 SES selectors (s1/s2/s3).',
      deepLink: '/deliverability',
      notes: noteByStep.get('dns_records') ?? '',
    },
    {
      key: 'unsub_reachable',
      label: '7. Unsubscribe endpoint reachable',
      status: sm('unsub_reachable'),
      description: 'GET /api/unsubscribe/health returns 200 from the public internet.',
      fix: 'Confirm PUBLIC_BASE_URL is reachable; rerun Deliverability → Check DNS.',
      deepLink: '/deliverability',
      notes: noteByStep.get('unsub_reachable') ?? '',
    },
    {
      key: 'seedlist_config',
      label: '8. Seedlist configured',
      status: sm('seedlist_configured'),
      description: 'SEEDLIST_EMAILS includes at least one Gmail, Outlook, and custom-domain mailbox you control.',
      fix: 'Set SEEDLIST_EMAILS in .env to comma-separated mailboxes.',
      deepLink: '/settings',
      notes: noteByStep.get('seedlist_config') ?? '',
    },
    {
      key: 'seedlist_test',
      label: '9. Seedlist test passed within 7 days',
      status: sm('seedlist_test_recent'),
      description: 'Deliverability → "Send seedlist test", then open each seed mailbox and confirm Primary placement.',
      deepLink: '/deliverability',
      notes: noteByStep.get('seedlist_test') ?? '',
    },
    {
      key: 'license_import',
      label: '10. License CSV import (TX Septic)',
      status: licenseCount > 0 ? 'pass' : 'todo',
      description: licenseCount > 0
        ? `${licenseCount} TX Septic licensees imported.`
        : 'No TX Septic licensees imported yet — discovery will work but license_active won\'t score.',
      fix: 'See docs/LICENSE-SOURCES.md → TX → TDLR. POST CSV to /api/licenses/import.',
      deepLink: '/diagnostics',
      notes: noteByStep.get('license_import') ?? '',
    },
    {
      key: 'discovery_run',
      label: '11. Discovery run produced leads',
      status: leadCount > 0 ? 'pass' : 'todo',
      description: leadCount > 0 ? `${leadCount} Septic leads in DB.` : 'No Septic leads yet. Find Leads → Septic / Houston, TX.',
      deepLink: '/discover',
      notes: noteByStep.get('discovery_run') ?? '',
    },
    {
      key: 'day0_review',
      label: '12. Day 0 eyeball review',
      status: !experiment ? 'todo'
              : reviewCount >= 50 ? 'pass'
              : reviewCount > 0 ? 'warn'
              : 'todo',
      description: !experiment
        ? 'Create a Septic / Houston experiment in Validation Mode.'
        : reviewCount >= 50 ? `${reviewCount} leads reviewed.`
        : reviewCount > 0 ? `Only ${reviewCount} of 50 leads reviewed.`
        : 'No reviews yet. Validation → eyeball → rate 50 leads A/B/C/D.',
      deepLink: '/validation',
      notes: noteByStep.get('day0_review') ?? '',
    },
    {
      key: 'reach_campaign',
      label: '13. Reach-test campaign built',
      status: !reachCampaign ? 'todo'
              : reachCampaign.recipientCount >= 100 ? 'pass'
              : 'warn',
      description: !reachCampaign
        ? '100-send stratified campaign needed (Top 40 / Mid 30 / Bottom 20 / Control 10).'
        : `Campaign "${reachCampaign.name}" with ${reachCampaign.recipientCount} recipients.`,
      deepLink: '/validation',
      notes: noteByStep.get('reach_campaign') ?? '',
    },
    {
      key: 'launch_gate',
      label: '14. Pre-launch gate green',
      status: diag.gate.ok ? 'pass' : 'fail',
      description: diag.gate.ok ? 'All blockers cleared.' : `${diag.gate.blockingCount} blocker(s).`,
      deepLink: '/diagnostics',
      notes: noteByStep.get('launch_gate') ?? '',
    },
    {
      key: 'launched',
      label: '15. Campaign launched',
      status: reachCampaign && reachCampaign.status === 'running' ? 'pass'
              : reachCampaign && reachCampaign.status === 'completed' ? 'pass'
              : reachCampaign && reachCampaign.status === 'paused' ? 'warn'
              : 'todo',
      description: reachCampaign
        ? `Status: ${reachCampaign.status}. ${reachCampaign.sentCount}/${reachCampaign.recipientCount} sent.`
        : 'Once the gate is green, launch the campaign from the Campaigns tab.',
      deepLink: '/campaigns',
      notes: noteByStep.get('launched') ?? '',
    },
    {
      key: 'monitoring',
      label: '16. Monitoring',
      status: reachCampaign && reachCampaign.sentCount > 0 ? 'pass' : 'todo',
      description: 'Watch Dashboard → Last 24h. Check inbound triage daily.',
      deepLink: '/',
      notes: noteByStep.get('monitoring') ?? '',
    },
    {
      key: 'day7_verdict',
      label: '17. Day 7 verdict',
      status: reachCampaign && reachCampaign.sentCount >= 100 ? 'warn' : 'todo',
      description: 'After 100 sends + 7 days, evaluate inbox placement, bounce, complaint, replies.',
      deepLink: '/validation',
      notes: noteByStep.get('day7_verdict') ?? '',
    },
    {
      key: 'next_action',
      label: '18. Next action',
      status: 'todo',
      description: 'If reach-test passes → engagement test (500-send). Otherwise tune scoring / copy / DNS.',
      deepLink: '/validation',
      notes: noteByStep.get('next_action') ?? '',
    },
  ];

  const blockingCount = steps.filter(s => s.status === 'fail').length;
  const warnCount = steps.filter(s => s.status === 'warn').length;
  return {
    wizardKey: WIZARD_KEY,
    productionMode: !cfg.sampleMode,
    steps,
    blockingCount,
    warnCount,
    generatedAt: new Date().toISOString(),
  };
}

export async function saveStepNotes(db: Database, orgId: string, stepKey: string, notes: string): Promise<void> {
  await db.insert(schema.wizardProgress).values({
    orgId, wizardKey: WIZARD_KEY, stepKey, notes,
  }).onConflictDoUpdate({
    target: [schema.wizardProgress.orgId, schema.wizardProgress.wizardKey, schema.wizardProgress.stepKey],
    set: { notes, updatedAt: new Date() },
  });
}
