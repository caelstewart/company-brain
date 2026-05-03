/**
 * Basic usage example for Company Brain.
 *
 * Prerequisites:
 *   docker compose up -d
 *   export DATABASE_URL=postgresql://brain:brain@localhost:5432/company_brain
 *   export OPENAI_API_KEY=sk-...
 *
 * Run:
 *   npx tsx examples/basic-usage.ts
 */

import { Brain } from '@company-brain/core';

async function main() {
  const brain = new Brain({
    database: process.env.DATABASE_URL || 'postgresql://brain:brain@localhost:5432/company_brain',
    embedding: process.env.OPENAI_API_KEY
      ? { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
      : undefined,
    llm: process.env.OPENAI_API_KEY
      ? { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
      : process.env.ANTHROPIC_API_KEY
        ? { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }
        : undefined,
  });

  // Initialize database schema
  await brain.init();
  console.log('Brain initialized.\n');

  // ─── Ingest meeting transcript ──────────────────────────────

  console.log('--- Ingesting meeting transcript ---');
  const meeting1 = await brain.ingest({
    content: `Weekly sales sync - March 15, 2024

    Alice Chen from Acme Corp called. They want to upgrade from the starter
    plan to enterprise. Their CTO Bob Zhang is running an evaluation of us
    vs. CompetitorX. Alice says they need SSO and audit logs.

    Action item: Send Alice the enterprise pricing deck by Friday.
    Decision: We'll offer a 20% discount if they commit before end of Q1.`,
    sourceType: 'meeting_transcript',
    validAt: new Date('2024-03-15'),
  });

  console.log(`Episode: ${meeting1.episodeId}`);
  console.log(`Entities created: ${meeting1.entitiesCreated}`);
  console.log(`Facts created: ${meeting1.factsCreated}\n`);

  // ─── Ingest a follow-up ─────────────────────────────────────

  console.log('--- Ingesting follow-up ---');
  const meeting2 = await brain.ingest({
    content: `Update from Alice Chen - March 22, 2024

    Alice confirmed Acme Corp is going with us over CompetitorX.
    Bob Zhang approved the enterprise deal. They're signing next week.
    Alice is moving from VP Sales to Chief Revenue Officer at Acme.`,
    sourceType: 'meeting_transcript',
    validAt: new Date('2024-03-22'),
  });

  console.log(`Episode: ${meeting2.episodeId}`);
  console.log(`Facts created: ${meeting2.factsCreated}`);
  console.log(`Facts invalidated: ${meeting2.factsInvalidated} (e.g., Alice's old role)\n`);

  // ─── Search ─────────────────────────────────────────────────

  console.log('--- Searching: "What\'s happening with Acme?" ---');
  const results = await brain.search({ query: "What's happening with Acme?" });
  for (const r of results.slice(0, 5)) {
    console.log(`  [${r.type}] ${r.content} (score: ${r.score.toFixed(3)})`);
  }
  console.log();

  // ─── Find entity ────────────────────────────────────────────

  console.log('--- Finding entity: "Alice" ---');
  const alice = await brain.findEntity('Alice');
  if (alice) {
    console.log(`  Found: ${alice.name} (${alice.entityType})`);
    console.log(`  Summary: ${alice.summary}`);

    // Get full entity with connections
    const full = await brain.getEntity(alice.id, {
      includeFacts: true,
      includeRelated: true,
    });

    if (full) {
      console.log(`  Current facts: ${full.facts.length}`);
      console.log(`  Related entities: ${full.related.map(e => e.name).join(', ')}`);
    }
  }
  console.log();

  // ─── Point-in-time query ────────────────────────────────────

  console.log('--- Point-in-time: "Alice role" as of March 16 ---');
  const marchFacts = await brain.search({
    query: 'Alice role',
    asOf: new Date('2024-03-16'),
  });
  for (const r of marchFacts.slice(0, 3)) {
    console.log(`  ${r.content}`);
  }
  console.log();

  // ─── Extraction stats ──────────────────────────────────────

  console.log('--- Extraction stats ---');
  const stats = await brain.getExtractionStats();
  console.log(`  Total extractions: ${stats.totalExtractions}`);
  console.log(`  Deterministic rate: ${(stats.deterministicRate * 100).toFixed(1)}%`);
  console.log(`  LLM fallbacks: ${stats.llmFallbacks}`);

  await brain.close();
  console.log('\nDone.');
}

main().catch(console.error);
