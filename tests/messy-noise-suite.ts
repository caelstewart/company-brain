#!/usr/bin/env npx tsx
/**
 * Messy Noise Suite
 *
 * Runs a live, deliberately chaotic ingestion + question suite against Company Brain.
 * This is not a deterministic unit test. It is a pressure test for the real pipeline:
 * source normalization, extraction, permissions, retrieval, grounded answers, and
 * active canonicalization policy.
 *
 * Run:
 *   npx tsx tests/messy-noise-suite.ts
 *
 * Optional:
 *   GROUP_ID=isolated_scratch npx tsx tests/messy-noise-suite.ts
 *   npx tsx tests/messy-noise-suite.ts --dry-run
 */

import postgres from 'postgres';
import {
  Brain,
  type AccessContext,
  type EpisodeInput,
  type GroundedAnswer,
  type SearchMethod,
  disconnect,
} from '@company-brain/core';

const DB = process.env.DATABASE_URL || 'postgresql://brain:brain@localhost:5432/company_brain';
const GROUP = process.env.GROUP_ID || 'default';
const HAS_LLM = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
const HAS_EMBEDDINGS = Boolean(process.env.OPENAI_API_KEY);
const DRY_RUN = process.argv.includes('--dry-run');

interface QuestionCase {
  id: string;
  question: string;
  access?: AccessContext;
  methods?: SearchMethod[];
  mustInclude: string[];
  mustNotInclude?: string[];
  notes?: string;
}

function log(section: string, message: unknown, data?: unknown) {
  const prefix = `\x1b[36m[${section}]\x1b[0m`;
  if (data === undefined) {
    console.log(`${prefix} ${typeof message === 'string' ? message : JSON.stringify(message, null, 2)}`);
  } else {
    console.log(`${prefix} ${message}`, JSON.stringify(data, null, 2));
  }
}

function pass(message: string) {
  console.log(`\x1b[32mPASS\x1b[0m ${message}`);
}

function fail(message: string) {
  console.log(`\x1b[31mFAIL\x1b[0m ${message}`);
}

function header(title: string) {
  console.log(`\n\x1b[1m\x1b[33m${'='.repeat(78)}\x1b[0m`);
  console.log(`\x1b[1m\x1b[33m${title}\x1b[0m`);
  console.log(`\x1b[1m\x1b[33m${'='.repeat(78)}\x1b[0m`);
}

async function resetGroup() {
  const db = postgres(DB, { max: 1 });
  try {
    await db`DELETE FROM groups WHERE id = ${GROUP}`;
  } finally {
    await db.end();
  }
}

async function main() {
  header('MESSY NOISE SUITE');
  log('INIT', `Database: ${DB}`);
  log('INIT', `Group: ${GROUP}`);
  log('INIT', `LLM extraction: ${HAS_LLM ? 'enabled' : 'disabled - semantic extraction fails closed'}`);
  log('INIT', `Embeddings/search: ${HAS_EMBEDDINGS ? 'enabled' : 'disabled - keyword/graph fallback only'}`);

  if (DRY_RUN) {
    const episodes = messyEpisodes();
    const questions = questionCases();
    log('DRY', `Would ingest ${episodes.length} noisy episodes`);
    log('DRY', `Would run ${questions.length} hard questions`);
    log('DRY', 'Question IDs', questions.map(question => question.id));
    return;
  }

  await resetGroup();

  const brain = new Brain({
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

  await brain.init();

  header('INGEST RAW NOISE');
  const episodes = messyEpisodes();
  const ingestResult = await brain.ingestBatch(episodes);
  log('INGEST', 'Batch result', ingestResult);
  if (ingestResult.ambiguities.length > 0) {
    log('INGEST', 'Inline ambiguities surfaced by resolver', ingestResult.ambiguities);
  }

  header('ACTIVE CANONICALIZATION POLICY');
  const canonicalization = await brain.proposeCanonicalClusters({
    minConfidence: 0.72,
    autoApplyThreshold: 0.94,
    ambiguousThreshold: 0.78,
    limit: 20,
  });
  log('CANON', 'Policy result', canonicalization);

  header('QUESTION PRESSURE TESTS');
  const questions = questionCases();
  const outcomes: Array<{ id: string; passed: boolean; missing: string[]; unexpected: string[] }> = [];

  for (const testCase of questions) {
    console.log(`\n\x1b[35m--- ${testCase.id}: ${testCase.question} ---\x1b[0m`);
    if (testCase.notes) log('CASE', testCase.notes);

    const answer = await brain.answer({
      query: testCase.question,
      groupId: GROUP,
      access: testCase.access,
      limit: 10,
      methods: testCase.methods,
      trace: true,
    });

    printAnswer(answer);
    printTrace(answer);
    const outcome = scoreAnswer(testCase, answer);
    outcomes.push(outcome);

    if (outcome.passed) {
      pass(`${testCase.id}`);
    } else {
      fail(`${testCase.id}`);
      if (outcome.missing.length) log('MISSING', outcome.missing);
      if (outcome.unexpected.length) log('UNEXPECTED', outcome.unexpected);
    }
  }

  header('SUMMARY');
  const passed = outcomes.filter(outcome => outcome.passed).length;
  const failed = outcomes.length - passed;
  log('SUMMARY', `${passed}/${outcomes.length} cases passed`);
  if (failed > 0) {
    log('SUMMARY', 'Failed cases', outcomes.filter(outcome => !outcome.passed));
  }

  const stats = await brain.getExtractionStats(new Date(Date.now() - 60 * 60 * 1000));
  log('STATS', 'Recent extraction stats', stats);

  await brain.close();
  await disconnect();

  if (failed > 0) {
    process.exitCode = 1;
  }
}

function messyEpisodes(): EpisodeInput[] {
  return [
    {
      sourceType: 'slack_message',
      sourceId: 'noise-investor-thread-1',
      content: [
        'fwd from elena / deal-notes??',
        'north star, Northstar V, "NSV" all same ppl I think.',
        'they introd maya l. -> Orbital DB / ODB / Orbital Database Inc.',
        'Maya says procurement blockers = sec questionnaire + DPA redlines.',
        'someone wrote "series a maybe??" but later max said partner mtg FRI is real.',
        'Need data room refresh before partner mtg. Do NOT call it closed.',
      ].join('\n'),
      metadata: {
        channel: 'investor-chaos',
        channelId: 'C_INV',
        userId: 'U_ELENA',
        threadMessages: [
          { user: 'U_MAX', text: 'NSV asked for data room refresh before Friday partner mtg' },
          { user: 'U_MAYA', text: 'I can help if security questionnaire and DPA are ready.' },
          { user: 'U_ELENA', text: 'ODB == Orbital Database Inc, same thing.' },
        ],
        reactions: [{ name: 'eyes', count: 3 }],
      },
    },
    {
      sourceType: 'crm_record',
      sourceId: 'noise-investor-crm-1',
      content: [
        'raw CRM paste, ugly:',
        'Account: Orbital Database Inc (also OrbitalDB in old notes)',
        'Relationship note: Maya Lin advising procurement. Northstar Ventures requested updated data room.',
        'Stage: fundraising, Series A. Next step: send security questionnaire + DPA by Thursday.',
        'Owner maybe Elena? Actually Max owns investor follow-up.',
      ].join('\n'),
      metadata: {
        recordType: 'relationship_note',
        owner: 'Max',
        stage: 'fundraising',
        fields: { messy: true, aliases: ['OrbitalDB', 'ODB'] },
      },
    },
    {
      sourceType: 'analytics_event',
      sourceId: 'noise-product-analytics-1',
      content: [
        'dashboard dump lol:',
        'chkout_conv -18.4% WoW AFTER pmt-step-v2 ramped 50->100.',
        '3ds_retry_eu 2.7x, US flat.',
        'IMPORTANT: correlation not proven, dont say root cause yet.',
        'rollback started 22:10 but fraud says preserve EU retry logs.',
      ].join('\n'),
      metadata: {
        eventName: 'checkout_regression',
        dimensions: { experiment: 'payment-step-v2', region: 'EU', ramp: '100%' },
        properties: { checkout_conversion_delta: -18.4, retries_multiplier: 2.7 },
      },
      visibility: { allowedGroups: ['growth', 'fraud'], classification: 'product_sensitive' },
    },
    {
      sourceType: 'slack_message',
      sourceId: 'noise-product-slack-1',
      content: [
        'priya edited msg 3x:',
        'payment-step-v2 smells like 3DS retries. rollback tonight unless cohort isolation works.',
        'later edit: rollback actually started 22:10. preserve logs.',
        'DO NOT SAY CAUSED. dashboard says correlation only.',
      ].join('\n'),
      metadata: {
        channel: 'growth-alerts',
        channelId: 'C_GROWTH',
        userId: 'U_PRIYA',
        threadMessages: [
          { user: 'U_FRAUD', text: 'keep EU 3DS retry logs for fraud analysis' },
          { user: 'U_PM', text: 'customer comms should say investigating, not resolved' },
        ],
      },
      visibility: { allowedGroups: ['growth', 'fraud'], classification: 'product_sensitive' },
    },
    {
      sourceType: 'slack_message',
      sourceId: 'noise-security-public-1',
      content: [
        'public eng update:',
        'weird eu-west infra thing. nora says no customer data access observed so far.',
        'details are in sec channel. do not speculate.',
      ].join('\n'),
      metadata: { channel: 'eng-updates', channelId: 'C_ENG', userId: 'U_NORA' },
    },
    {
      sourceType: 'slack_message',
      sourceId: 'noise-security-private-1',
      content: [
        'SEC ONLY incident 42:',
        'anom admin token use in eu-west. Nora rotated token + disabled stale automation user svc-old-17.',
        'token path was /legacy/ops/admin_token, do NOT share.',
        'no customer data access observed so far. root cause still unknown.',
      ].join('\n'),
      metadata: {
        channel: 'security-incidents',
        channelId: 'C_SEC',
        userId: 'U_NORA',
        reactions: [{ name: 'rotating_light', count: 5 }],
      },
      visibility: { allowedGroups: ['security'], classification: 'security_incident' },
    },
    {
      sourceType: 'call_transcript',
      sourceId: 'noise-hiring-call-1',
      content: [
        'Recruiting debrief, diarized badly:',
        'Ava: Omar Singh is onsite for Staff Backend.',
        'Ben: strong distributed systems, weaker React depth.',
        'Ava: do not put React concern in public eng notes.',
        'Panel focus next: systems design + incident debugging.',
      ].join('\n'),
      metadata: {
        title: 'Omar debrief messy transcript',
        participants: ['Ava', 'Ben'],
        turns: [
          { speaker: 'Ava', text: 'Omar onsite Staff Backend' },
          { speaker: 'Ben', text: 'React depth concern' },
        ],
      },
      visibility: { allowedGroups: ['recruiting'], classification: 'candidate_feedback' },
    },
    {
      sourceType: 'document',
      sourceId: 'noise-arch-doc-1',
      content: [
        'atlas scratchpad v0.2',
        'cannot cut legacy q consumer until EB replay tests green.',
        'EventBridge migration blocked by duplicate event ids; idempotency patch required.',
        'Samir owns. Mina said "maybe Kafka??" but NO decision to use Kafka.',
        'Current decision: keep legacy read path.',
      ].join('\n'),
      metadata: { title: 'Atlas scratchpad', status: 'draft' },
    },
    {
      sourceType: 'meeting_transcript',
      sourceId: 'noise-arch-meeting-1',
      content: [
        'standup messy:',
        'Samir: replay still failing due duplicate event ids.',
        'Mina: keep legacy queue read path until EventBridge replay passes.',
        'Decision reaffirmed. Kafka is just a maybe, not selected.',
      ].join('\n'),
      metadata: {
        title: 'Atlas standup',
        actionItems: ['Samir to land idempotency patch'],
        decisions: ['Keep legacy read path until replay passes'],
      },
    },
  ];
}

function questionCases(): QuestionCase[] {
  return [
    {
      id: 'investor-alias-chain',
      question: 'How are Maya Lin, Northstar, and OrbitalDB connected, and what is the next step?',
      mustInclude: ['Maya', 'Northstar', 'Orbital', 'data room'],
      mustNotInclude: ['deal is closed', 'it is closed', 'closed won'],
      notes: 'Tests aliases, noisy CRM/Slack, and avoiding overclaiming the deal is closed.',
    },
    {
      id: 'product-causality-caveat',
      question: 'Did payment-step-v2 cause the checkout conversion drop?',
      access: { principalId: 'growth-user', groups: ['growth'] },
      mustInclude: ['correlation', '3DS', 'EU'],
      mustNotInclude: ['definitely caused', 'root cause was payment-step-v2'],
      notes: 'Tests product analytics and caveating causality.',
    },
    {
      id: 'product-permission-hidden',
      question: 'What happened with payment-step-v2 and EU 3DS retries?',
      access: { principalId: 'random-eng', groups: ['engineering'] },
      mustInclude: [],
      mustNotInclude: ['3DS', 'rollback', '18.4'],
      notes: 'Tests that growth/fraud-only analytics are hidden from unrelated engineering users.',
    },
    {
      id: 'security-visible',
      question: 'What happened in incident 42 and what did Nora do?',
      access: { principalId: 'sec-user', groups: ['security'] },
      mustInclude: ['admin token', 'Nora', 'stale automation'],
      mustNotInclude: ['root cause was'],
      notes: 'Tests restricted security incident retrieval and no root-cause hallucination.',
    },
    {
      id: 'security-hidden',
      question: 'What was the token path in incident 42?',
      access: { principalId: 'pm-user', groups: ['product'] },
      mustInclude: [],
      mustNotInclude: ['/legacy/ops/admin_token', 'svc-old-17', 'admin token'],
      notes: 'Tests explicit secret leakage prevention.',
    },
    {
      id: 'hiring-recruiter-visible',
      question: 'What concerns did the panel raise about Omar Singh?',
      access: { principalId: 'recruiter', groups: ['recruiting'] },
      mustInclude: ['React', 'systems'],
      notes: 'Tests candidate feedback access.',
    },
    {
      id: 'hiring-eng-hidden',
      question: 'What concerns did the panel raise about Omar Singh?',
      access: { principalId: 'eng-user', groups: ['engineering'] },
      mustInclude: [],
      mustNotInclude: ['React depth', 'weaker React'],
      notes: 'Tests restricted candidate feedback hidden from engineering.',
    },
    {
      id: 'architecture-blocker',
      question: 'What blocks Atlas from leaving the legacy queue consumer, and did the team choose Kafka?',
      mustInclude: ['EventBridge', 'idempotency', 'legacy'],
      mustNotInclude: ['decided to use Kafka', 'selected Kafka'],
      notes: 'Tests blocker chain and negated decision.',
    },
  ];
}

function printAnswer(answer: GroundedAnswer) {
  log('ANSWER', answer.answer);
  if (answer.inference.length > 0) log('INFERENCE', answer.inference);
  if (answer.missing.length > 0) log('MISSING', answer.missing);
  log('CONF', answer.confidence);
  log('CITATIONS', answer.citations.map(citation => ({
    id: citation.id,
    type: citation.type,
    quote: citation.quote || citation.content.slice(0, 220),
    confidence: citation.confidence,
  })));
}

function printTrace(answer: GroundedAnswer) {
  const trace = answer.trace;
  if (!trace) return;

  log('TRACE/STORED', 'Stored corpus visible to this question', {
    episodes: trace.corpus.storedEpisodes.length,
    sourceIds: trace.corpus.storedEpisodes.slice(0, 12).map(episode => ({
      sourceId: episode.sourceId,
      type: episode.sourceType,
      retention: episode.retention,
      extract: episode.shouldExtract,
      preview: episode.preview.slice(0, 90),
    })),
  });
  log('TRACE/EXTRACTED', 'Extracted graph/memory visible to this question', {
    facts: trace.corpus.extractedFacts.length,
    memory: trace.corpus.memoryObjects.length,
    sampleFacts: trace.corpus.extractedFacts.slice(0, 8).map(fact => ({
      relation: fact.relation,
      confidence: fact.confidence,
      sourceEpisodeId: fact.sourceEpisodeId,
      quote: fact.quote || fact.text.slice(0, 120),
    })),
    sampleMemory: trace.corpus.memoryObjects.slice(0, 8).map(memory => ({
      kind: memory.kind,
      status: memory.status,
      subject: memory.subject,
      quote: memory.quote || memory.summary.slice(0, 120),
    })),
  });
  log('TRACE/RETRIEVED', 'Evidence retrieved for this question', {
    memoryResults: trace.retrieval.memoryResults.length,
    graphResults: trace.retrieval.graphResults.length,
    sourceContextResults: trace.retrieval.sourceContextResults.map(result => ({
      type: result.type,
      method: result.method,
      score: Math.round(result.score * 1000) / 1000,
      text: (result.quote || result.content).slice(0, 180),
    })),
    fusedResults: trace.retrieval.fusedResults.slice(0, 12).map(result => ({
      type: result.type,
      method: result.method,
      score: Math.round(result.score * 1000) / 1000,
      relation: result.relation,
      sourceEpisodeId: result.sourceEpisodeId,
      text: (result.quote || result.content).slice(0, 140),
    })),
    citations: trace.retrieval.citations.map(citation => ({
      id: citation.id,
      type: citation.type,
      confidence: citation.confidence,
      sourceEpisodeId: citation.sourceEpisodeId,
      text: (citation.quote || citation.content).slice(0, 140),
    })),
  });
  log('TRACE/RELEVANCE', 'Relevance gate decision', {
    canAnswer: trace.relevance.canAnswer,
    missingSubject: trace.relevance.missingSubject,
    reason: trace.relevance.reason,
    missing: trace.relevance.missing,
  });
  log('TRACE/FINAL', 'Answer synthesis output', {
    mode: trace.synthesis.mode,
    citedIds: trace.synthesis.citedIds,
    confidence: trace.synthesis.confidence,
    missing: trace.synthesis.missing,
    answer: trace.synthesis.answer.slice(0, 220),
  });
}

function scoreAnswer(testCase: QuestionCase, answer: GroundedAnswer) {
  const supportedCorpus = [
    answer.answer,
    answer.inference.join(' '),
    Array.isArray(answer.missing) ? answer.missing.join(' ') : String(answer.missing || ''),
    answer.citations.map(citation => `${citation.quote || ''} ${citation.content}`).join(' '),
  ].join('\n').toLowerCase();
  const leakCorpus = [
    answer.answer,
    answer.inference.join(' '),
    answer.citations.map(citation => `${citation.quote || ''} ${citation.content}`).join(' '),
  ].join('\n').toLowerCase();

  const missing = testCase.mustInclude.filter(term => !supportedCorpus.includes(term.toLowerCase()));
  const questionLower = testCase.question.toLowerCase();
  const unexpected = (testCase.mustNotInclude || []).filter(term => {
    const normalized = term.toLowerCase();
    if (answer.citations.length === 0 && questionLower.includes(normalized)) return false;
    return leakCorpus.includes(normalized);
  });
  return {
    id: testCase.id,
    passed: missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
  };
}

main().catch(async err => {
  console.error(err);
  await disconnect().catch(() => {});
  process.exit(1);
});
