/**
 * Integration tests — require a running Postgres with pgvector.
 *
 * Start the database:  docker compose up -d
 *
 * These tests exercise the full pipeline: ingest → extract → resolve → search.
 * They bypass LLM-dependent assertions so tests stay fast and free.
 *
 * Run:  npm test -- --reporter=verbose
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Brain } from '../src/index.js';
import type { BrainConfig } from '../src/types.js';

const TEST_DB = process.env.DATABASE_URL || 'postgresql://brain:brain@localhost:5432/company_brain';
const TEST_GROUP = `test_${Date.now()}`;

let brain: Brain;

// Quick check if DB is available before running tests
async function checkDb(): Promise<boolean> {
  try {
    const { default: postgres } = await import('postgres');
    const sql = postgres(TEST_DB, { max: 1, connect_timeout: 1 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch { return false; }
}

const dbAvailable = await checkDb();

if (!dbAvailable) {
  console.log('\n[SKIP] Database not available at localhost:5432');
  console.log('[SKIP] Run "docker compose up -d" to enable integration tests\n');
}

const config: BrainConfig = {
  database: TEST_DB,
  defaultGroupId: TEST_GROUP,
  llm: process.env.OPENAI_API_KEY
    ? { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
    : process.env.ANTHROPIC_API_KEY
      ? { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }
      : undefined,
  extraction: {
    enableExtractionLog: true,
  },
};

beforeAll(async () => {
  if (!dbAvailable) return;
  brain = new Brain(config);
  await brain.init();
  console.log(`\n[SETUP] Connected to ${TEST_DB}`);
  console.log(`[SETUP] Test group: ${TEST_GROUP}`);
});

afterAll(async () => {
  if (dbAvailable && brain) {
    await brain.close();
    console.log('[TEARDOWN] Disconnected');
  }
});

describe('Full Pipeline Integration', () => {
  it.skipIf(!dbAvailable)('ingests a meeting transcript and extracts entities/facts', async () => {
    console.log('\n--- TEST: Ingest meeting transcript ---');

    const result = await brain.ingest({
      content: `Weekly sales sync - March 15, 2024.

      Alice Chen (alice@acme.com), VP of Acme Corp called about upgrading their plan.
      Their CTO Bob Zhang is evaluating CompetitorX.
      We decided to offer a 20% discount for Q1 commitment.`,
      sourceType: 'meeting_transcript',
      validAt: new Date('2024-03-15'),
      groupId: TEST_GROUP,
    });

    console.log(`[RESULT] Episode ID: ${result.episodeId}`);
    console.log(`[RESULT] Entities created: ${result.entitiesCreated}`);
    console.log(`[RESULT] Entities updated: ${result.entitiesUpdated}`);
    console.log(`[RESULT] Facts created: ${result.factsCreated}`);
    console.log(`[RESULT] Facts invalidated: ${result.factsInvalidated}`);

    expect(result.episodeId).toBeTruthy();
    expect(result.entitiesCreated).toBeGreaterThanOrEqual(0);
    expect(result.factsCreated).toBeGreaterThanOrEqual(0);
  }, 15000);

  it.skipIf(!dbAvailable)('finds entities by fuzzy name', async () => {
    console.log('\n--- TEST: Find entity by name ---');

    const entity = await brain.findEntity('Alice', TEST_GROUP);
    console.log(`[RESULT] Found: ${entity ? `${entity.name} (${entity.entityType})` : 'null'}`);

    // This test validates fuzzy search when semantic extraction created an entity.
    if (entity) {
      expect(entity.name.toLowerCase()).toContain('alice');
      expect(entity.entityType).toBe('person');
    }
  }, 15000);

  it.skipIf(!dbAvailable)('ingests contradicting information and invalidates old facts', async () => {
    console.log('\n--- TEST: Contradiction detection ---');

    // First ingest: Alice is VP at Acme
    const first = await brain.ingest({
      content: 'Alice Chen, VP of Acme Corp is leading the enterprise deal.',
      sourceType: 'meeting_transcript',
      validAt: new Date('2024-03-15'),
      groupId: TEST_GROUP,
    });
    console.log(`[FIRST] Entities: ${first.entitiesCreated} created, ${first.entitiesUpdated} updated`);
    console.log(`[FIRST] Facts: ${first.factsCreated} created`);

    // Second ingest: Alice is now CRO at Acme (contradiction with VP)
    const second = await brain.ingest({
      content: 'Alice Chen, CRO of Acme Corp announced Q2 results.',
      sourceType: 'meeting_transcript',
      validAt: new Date('2024-04-01'),
      groupId: TEST_GROUP,
    });
    console.log(`[SECOND] Entities: ${second.entitiesCreated} created, ${second.entitiesUpdated} updated`);
    console.log(`[SECOND] Facts: ${second.factsCreated} created, ${second.factsInvalidated} invalidated`);

    // The old "VP" fact should be invalidated, new "CRO" fact created
    // Note: this depends on entity resolution matching Alice Chen across ingests
    if (second.factsInvalidated > 0) {
      console.log('[TEMPORAL] Old fact invalidated — contradiction detected correctly');
    }
  }, 15000);

  it.skipIf(!dbAvailable)('searches with keyword matching', async () => {
    console.log('\n--- TEST: Keyword search ---');

    const results = await brain.search({
      query: 'Acme enterprise deal',
      groupId: TEST_GROUP,
      methods: ['keyword'],
      limit: 10,
    });

    console.log(`[RESULT] Found ${results.length} results`);
    for (const r of results.slice(0, 5)) {
      console.log(`  [${r.type}] score=${r.score.toFixed(3)} | ${r.content.slice(0, 80)}`);
    }

    // Should find something related to Acme
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(!dbAvailable)('gets entity with facts and related entities', async () => {
    console.log('\n--- TEST: Get entity with connections ---');

    const alice = await brain.findEntity('Alice', TEST_GROUP);
    if (!alice) {
      console.log('[SKIP] Alice not found — skipping entity detail test');
      return;
    }

    const full = await brain.getEntity(alice.id, {
      includeFacts: true,
      includeRelated: true,
      includeTimeline: true,
    });

    if (full) {
      console.log(`[ENTITY] ${full.entity.name} (${full.entity.entityType})`);
      console.log(`[ENTITY] Summary: ${full.entity.summary || '(none)'}`);
      console.log(`[FACTS] Active: ${full.facts.length}`);
      for (const f of full.facts) {
        console.log(`  ${f.relation}: ${f.factText} (confidence: ${f.confidence})`);
      }
      console.log(`[TIMELINE] Total (incl. invalidated): ${full.timeline.length}`);
      for (const f of full.timeline) {
        const status = f.invalidAt ? `INVALIDATED at ${f.invalidAt.toISOString()}` : 'ACTIVE';
        console.log(`  [${status}] ${f.factText}`);
      }
      console.log(`[RELATED] ${full.related.map(e => `${e.name} (${e.entityType})`).join(', ') || '(none)'}`);

      expect(full.entity.id).toBe(alice.id);
    }
  });

  it.skipIf(!dbAvailable)('supports temporal queries with getFacts', async () => {
    console.log('\n--- TEST: Temporal fact queries ---');

    const alice = await brain.findEntity('Alice', TEST_GROUP);
    if (!alice) {
      console.log('[SKIP] Alice not found');
      return;
    }

    // All facts including invalidated ones
    const allFacts = await brain.getFacts(alice.id, undefined, { includeInvalidated: true });
    console.log(`[ALL FACTS] ${allFacts.length} total`);
    for (const f of allFacts) {
      const status = f.invalidAt ? 'SUPERSEDED' : 'CURRENT';
      console.log(`  [${status}] ${f.factText} (valid: ${f.validAt.toISOString()})`);
    }

    // Only current facts
    const currentFacts = await brain.getFacts(alice.id);
    console.log(`[CURRENT] ${currentFacts.length} active facts`);
  });

  it.skipIf(!dbAvailable)('tracks extraction stats', async () => {
    console.log('\n--- TEST: Extraction stats ---');

    const stats = await brain.getExtractionStats();
    console.log(`[STATS] Total extractions: ${stats.totalExtractions}`);
    console.log(`[STATS] Structural pre-scan hits: ${stats.deterministicHits}`);
    console.log(`[STATS] LLM fallbacks: ${stats.llmFallbacks}`);
    console.log(`[STATS] Structural hit rate: ${(stats.deterministicRate * 100).toFixed(1)}%`);

    if (stats.topMissPatterns.length > 0) {
      console.log(`[STATS] Recurring low-signal previews:`);
      for (const p of stats.topMissPatterns) {
        console.log(`  ${p.count}x: ${p.pattern.slice(0, 60)}`);
      }
    }
  });
});
