#!/usr/bin/env node
/**
 * Operating Memory Suite
 *
 * Live test for the product thesis:
 * "not company-wide search, but a living map of how the company works."
 *
 * This suite intentionally mixes interactions, policy docs, support tickets,
 * Figma/design notes, private runbooks, and random chatter. It runs against the
 * compiled dist package to avoid depending on tsx during live smoke tests.
 *
 * Run:
 *   npm run build
 *   node tests/operating-memory-suite.mjs
 *
 */

import postgres from 'postgres';
import { Brain, disconnect } from '../packages/core/dist/index.js';

const DB = process.env.DATABASE_URL || 'postgresql://brain:brain@localhost:5432/company_brain';
const GROUP = process.env.GROUP_ID || 'default';

function header(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function log(label, value) {
  console.log(`[${label}]`, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function resetGroup() {
  const db = postgres(DB, { max: 1 });
  try {
    await db`DELETE FROM groups WHERE id = ${GROUP}`;
  } finally {
    await db.end();
  }
}

function makeBrain() {
  return new Brain({
    database: DB,
    defaultGroupId: GROUP,
    llm: process.env.OPENAI_API_KEY
      ? { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
      : process.env.ANTHROPIC_API_KEY
        ? { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }
        : undefined,
    embedding: process.env.OPENAI_API_KEY
      ? { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
      : undefined,
    extraction: { enableExtractionLog: true },
  });
}

const episodes = [
  {
    sourceType: 'slack_thread',
    sourceId: 'ops-refund-thread',
    content: [
      'Slack #support-ops, Mon 9:18am',
      'Talia: quick reminder on refund handling because people keep asking in DMs.',
      'For customer-impact refunds under $5k, Support Lead can approve service credit.',
      'From $5k to $25k, RevOps plus Finance must approve before anything is promised.',
      'Cash refunds are not allowed unless Legal explicitly approves.',
      'Anything above $25k goes to exec review and must be logged as REFUND-EXCEPTION.',
      'Talia: customer-facing wording should say service credit, not refund, unless Legal has approved cash refund language.',
    ].join('\n'),
    metadata: { channel: 'support-ops', kind: 'interaction_policy' },
  },
  {
    sourceType: 'policy_doc',
    sourceId: 'pricing-exception-policy-v3',
    content: [
      'Pricing Exception Policy v3',
      'Standard discounts up to 15% can be approved by the Account Executive.',
      'Discounts above 15% and up to 30% require Sales Manager approval.',
      'Discounts above 30% require Pricing Council approval and Finance review.',
      'Procurement carve-outs are allowed only when Finance signs off in the deal desk note.',
      'No verbal approvals count. The approval must be recorded in Deal Desk before quote send.',
    ].join('\n'),
    metadata: { docType: 'policy', owner: 'Revenue Operations' },
  },
  {
    sourceType: 'incident_retrospective',
    sourceId: 'sev2-response-retro',
    content: [
      'Incident response retro / draft runbook update',
      'For Sev2 incidents, first responder opens #incidents and names an Incident Commander.',
      'Incident Commander owns timeline, decisions, and customer-safe status.',
      'Comms owner posts first internal update within 10 minutes and external/statuspage update within 15 minutes if customers are affected.',
      'Do not state root cause externally until Engineering Lead confirms it.',
      'Safe customer message: investigation ongoing, impact scoped, next update time provided.',
      'After mitigation, Engineering Lead owns the postmortem draft within 2 business days.',
    ].join('\n'),
    metadata: { docType: 'runbook_update', incidentClass: 'sev2' },
  },
  {
    sourceType: 'figma_design_note',
    sourceId: 'figma-checkout-redesign-frame-42',
    content: [
      'Figma comments / Checkout Redesign frame 42',
      'Mina: after user testing, primary CTA changes from "Continue" to "Review order".',
      'Reason: users thought Continue skipped review and caused checkout anxiety.',
      'Design status: not implementation-ready until accessibility contrast review passes.',
      'Owner: Mina owns design follow-up; Andre owns FE implementation once ready.',
      'This applies to Checkout Redesign only, not the onboarding flow.',
    ].join('\n'),
    metadata: { file: 'Checkout Redesign', frame: '42', sourceUrl: 'figma://checkout/frame/42' },
  },
  {
    sourceType: 'support_ticket',
    sourceId: 'atlas-retail-escalation',
    content: [
      'Support ticket SUP-8801',
      'Customer: Atlas Retail. Atlas Retail is not Atlas Robotics.',
      'Issue: CSV import failed because header row had duplicated sku column.',
      'Support workflow note: ask customer to re-upload after deduping the header. If import fails again, escalate to Data Import on-call.',
    ].join('\n'),
    metadata: { customer: 'Atlas Retail', ticket: 'SUP-8801' },
  },
  {
    sourceType: 'private_runbook',
    sourceId: 'incident-webhook-secret-runbook',
    content: [
      'Private Incident Automation Runbook',
      'PagerDuty incident webhook token is stored in 1Password item "PD incident webhook token".',
      'Owner is Security Ops / Noor.',
      'Access is restricted to security and incident-commanders.',
      'Do not paste token values into Slack or customer channels.',
    ].join('\n'),
    visibility: {
      allowedGroups: ['security', 'incident-commanders'],
      classification: 'restricted',
      sourceSystem: 'runbook',
    },
    metadata: { docType: 'private_runbook' },
  },
  {
    sourceType: 'slack_thread',
    sourceId: 'random-snacks-thread',
    content: [
      'Slack #random',
      'Ben: anyone want leftover snacks?',
      'Rhea: sure lol',
      'Ben: also elevator is slow today',
    ].join('\n'),
    metadata: { channel: 'random' },
  },
];

const questions = [
  {
    id: 'refund-process',
    query: 'How do we handle customer-impact refunds above $10k?',
    must: ['$5k', '$25k', 'RevOps', 'Finance', 'Legal', 'service credit'],
    mustNot: ['cash refunds are allowed'],
  },
  {
    id: 'pricing-exception',
    query: 'How do we approve and record pricing exceptions above 30%?',
    must: ['Pricing Council', 'Finance', 'Deal Desk'],
    mustNot: ['Account Executive can approve'],
  },
  {
    id: 'sev2-response',
    query: 'What should engineering do during a Sev2 incident?',
    must: ['Incident Commander', '#incidents', '15 minutes', 'root cause', 'postmortem'],
    mustNot: ['root cause externally until Engineering Lead confirms'],
  },
  {
    id: 'figma-handoff',
    query: 'What changed in the checkout redesign Figma, who owns design and FE implementation, and is it ready for engineering?',
    must: ['Review order', 'accessibility contrast review', 'not implementation-ready', 'Mina', 'Andre'],
    mustNot: ['onboarding is affected'],
  },
  {
    id: 'support-workflow',
    query: 'How should support handle the Atlas Retail CSV import issue?',
    must: ['deduping', 'header', 'Data Import on-call', 'Atlas Retail'],
    mustNot: ['Atlas Robotics is the same'],
  },
  {
    id: 'entity-separation',
    query: 'Is Atlas Robotics the same as Atlas Retail?',
    must: ['not', 'Atlas Retail', 'Atlas Robotics'],
    mustNot: ['same customer'],
  },
  {
    id: 'missing-process',
    query: 'How do we handle hardware procurement exceptions?',
    must: ['do not have accessible evidence'],
    mustNot: ['pricing', 'refund', 'incident'],
  },
  {
    id: 'restricted-normal',
    query: 'Where is the PagerDuty incident webhook token?',
    access: { groups: ['support'] },
    must: ['do not have accessible evidence'],
    mustNot: ['1Password', 'PD incident webhook token', 'Noor'],
  },
  {
    id: 'restricted-security',
    query: 'Where is the PagerDuty incident webhook token and who owns it?',
    access: { groups: ['security'] },
    must: ['1Password', 'PD incident webhook token', 'Noor'],
    mustNot: [],
  },
];

function score(answer, test) {
  const lower = answer.toLowerCase();
  const missing = test.must.filter(term => !lower.includes(term.toLowerCase()));
  const forbidden = test.mustNot.filter(term => lower.includes(term.toLowerCase()));
  return { passed: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

async function timed(label, fn) {
  const start = Date.now();
  try {
    const value = await fn();
    return { label, ok: true, ms: Date.now() - start, value };
  } catch (error) {
    return { label, ok: false, ms: Date.now() - start, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  header('OPERATING MEMORY SUITE');
  log('INIT', { DB, GROUP });
  await resetGroup();

  const brain = makeBrain();
  await brain.init();

  header('INGEST');
  const ingestOutcomes = [];
  for (const episode of episodes) {
    const outcome = await timed(`ingest:${episode.sourceId}`, () => brain.ingest({ ...episode, groupId: GROUP }));
    ingestOutcomes.push(outcome);
    log(outcome.ok ? 'INGEST_OK' : 'INGEST_FAIL', outcome);
  }

  header('QUESTIONS');
  const answerOutcomes = [];
  for (const test of questions) {
    const outcome = await timed(`answer:${test.id}`, async () => {
      const answer = await brain.answer({
        query: test.query,
        groupId: GROUP,
        access: test.access,
        limit: 16,
        methods: ['semantic', 'keyword', 'graph'],
        trace: true,
      });
      const scored = score(answer.answer, test);
      return {
        passed: scored.passed,
        missing: scored.missing,
        forbidden: scored.forbidden,
        answer: answer.answer,
        confidence: answer.confidence,
        citations: answer.citations.map(citation => citation.id),
        mode: answer.trace?.synthesis.mode,
        answerability: answer.trace?.answerability,
      };
    });
    answerOutcomes.push(outcome);
    log(outcome.ok && outcome.value.passed ? 'PASS' : 'FAIL', outcome);
  }

  const passed = answerOutcomes.filter(outcome => outcome.ok && outcome.value.passed).length;
  const failed = answerOutcomes.length - passed;

  header('SUMMARY');
  log('SUMMARY', {
    ingestSucceeded: ingestOutcomes.filter(outcome => outcome.ok).length,
    ingestTotal: ingestOutcomes.length,
    answerPassed: passed,
    answerTotal: answerOutcomes.length,
    failedCases: answerOutcomes
      .filter(outcome => !outcome.ok || !outcome.value.passed)
      .map(outcome => ({
        label: outcome.label,
        error: outcome.error,
        missing: outcome.value?.missing,
        forbidden: outcome.value?.forbidden,
        answer: outcome.value?.answer,
        mode: outcome.value?.mode,
      })),
  });

  await brain.close();
  await disconnect();

  if (failed > 0 || ingestOutcomes.some(outcome => !outcome.ok)) {
    process.exitCode = 1;
  }
}

main().catch(async error => {
  console.error(error);
  await disconnect();
  process.exit(1);
});
