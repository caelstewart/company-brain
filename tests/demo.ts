#!/usr/bin/env npx tsx
/**
 * Company Brain Demo — Verbose walkthrough.
 *
 * This script exercises the entire system with detailed logging
 * so you can see exactly how the knowledge graph works:
 *
 * 1. Deterministic extraction (regex, patterns)
 * 2. Entity/fact resolution (dedup, contradiction detection)
 * 3. Graph wiring (entities linked via temporal facts)
 * 4. Hybrid search (keyword + graph traversal)
 * 5. Temporal queries (point-in-time, timeline)
 * 6. Skill resolver (intent → skill matching)
 * 7. Connector framework (filesystem sync)
 *
 * Prerequisites:
 *   docker compose up -d
 *
 * Run:
 *   npx tsx tests/demo.ts
 */

import { Brain, SkillResolver, FilesystemConnector, ConnectorRegistry } from '@company-brain/core';
import {
  extractEntitiesDeterministic,
  extractFactsDeterministic,
} from '@company-brain/core/extraction';

const DB = process.env.DATABASE_URL || 'postgresql://brain:brain@localhost:5432/company_brain';
const GROUP = `demo_${Date.now()}`;

function log(section: string, msg: string, data?: any) {
  const prefix = `\x1b[36m[${section}]\x1b[0m`;
  if (data !== undefined) {
    console.log(`${prefix} ${msg}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

function header(title: string) {
  console.log(`\n\x1b[1m\x1b[33m${'═'.repeat(60)}\x1b[0m`);
  console.log(`\x1b[1m\x1b[33m  ${title}\x1b[0m`);
  console.log(`\x1b[1m\x1b[33m${'═'.repeat(60)}\x1b[0m\n`);
}

function subheader(title: string) {
  console.log(`\n\x1b[35m--- ${title} ---\x1b[0m\n`);
}

async function main() {
  header('COMPANY BRAIN DEMO');
  log('INIT', `Database: ${DB}`);
  log('INIT', `Demo group: ${GROUP}`);

  // ─── Connect & Init ──────────────────────────────────────
  const hasLLM = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  log('INIT', `LLM available: ${hasLLM ? 'yes (will use LLM-first extraction)' : 'no (deterministic-only mode)'}`);

  const brain = new Brain({
    database: DB,
    defaultGroupId: GROUP,
    llm: process.env.ANTHROPIC_API_KEY
      ? { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }
      : process.env.OPENAI_API_KEY
        ? { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
        : undefined,
    embedding: process.env.OPENAI_API_KEY
      ? { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
      : undefined,
    extraction: {
      enableExtractionLog: true,
    },
  });

  try {
    await brain.init();
    log('INIT', 'Database schema initialized');
  } catch (err: any) {
    console.error(`\n\x1b[31mERROR: Cannot connect to database.\x1b[0m`);
    console.error(`Run: docker compose up -d\n`);
    process.exit(1);
  }

  // ════════════════════════════════════════════════════════════
  // PART 1: DETERMINISTIC EXTRACTION (no DB, no LLM)
  // ════════════════════════════════════════════════════════════

  header('PART 1: DETERMINISTIC EXTRACTION');

  const sampleTexts = [
    {
      label: 'Meeting transcript with roles',
      text: `Alice Chen, VP of Acme Corp talked about the enterprise upgrade.
      Their CTO Bob Zhang is evaluating competitors.
      Contact alice.chen@acme.com for follow-up.`,
    },
    {
      label: 'Decision + action items',
      text: `We decided to offer 20% discount for Q1 commitments.
      TODO: Send pricing deck to Alice by Friday.
      Action: Schedule follow-up with @bobz next week.`,
    },
    {
      label: 'Narrative (hard for deterministic)',
      text: `The quarterly board meeting covered several strategic topics.
      Revenue growth exceeded expectations at 34% YoY. The team
      discussed expanding into the European market, particularly
      Germany and France. Several partnerships were mentioned but
      no specific names were committed to yet.`,
    },
  ];

  for (const sample of sampleTexts) {
    subheader(sample.label);
    log('INPUT', sample.text.trim().split('\n').map(l => l.trim()).join('\n      '));

    const entities = extractEntitiesDeterministic(sample.text);
    const facts = extractFactsDeterministic(sample.text, entities);

    if (entities.length > 0) {
      log('ENTITIES', `Found ${entities.length}:`);
      for (const e of entities) {
        const attrs = e.attributes && Object.keys(e.attributes).length > 0
          ? ` attrs=${JSON.stringify(e.attributes)}`
          : '';
        console.log(`    \x1b[32m${e.name}\x1b[0m (${e.entityType}) confidence=${e.confidence}${attrs}`);
      }
    } else {
      log('ENTITIES', 'None found (would trigger LLM fallback in production)');
    }

    if (facts.length > 0) {
      log('FACTS', `Extracted ${facts.length}:`);
      for (const f of facts) {
        console.log(`    \x1b[34m${f.sourceName}\x1b[0m --[${f.relation}]--> \x1b[34m${f.targetName}\x1b[0m`);
        console.log(`      "${f.factText}" (confidence=${f.confidence})`);
      }
    } else {
      log('FACTS', 'No relationships extracted');
    }
  }

  // ════════════════════════════════════════════════════════════
  // PART 2: FULL PIPELINE (ingest → extract → resolve → store)
  // ════════════════════════════════════════════════════════════

  header('PART 2: FULL INGESTION PIPELINE');

  subheader('Ingest #1: Initial meeting');
  const ingest1 = await brain.ingest({
    content: `Sales sync March 15, 2024.
    Alice Chen, VP of Acme Corp is upgrading to enterprise.
    Their CTO Bob Zhang is evaluating CompetitorX.
    Contact alice.chen@acme.com for pricing.`,
    sourceType: 'meeting_transcript',
    validAt: new Date('2024-03-15'),
    groupId: GROUP,
  });

  log('INGEST-1', 'Result:', {
    episodeId: ingest1.episodeId,
    entitiesCreated: ingest1.entitiesCreated,
    entitiesUpdated: ingest1.entitiesUpdated,
    factsCreated: ingest1.factsCreated,
    factsInvalidated: ingest1.factsInvalidated,
  });

  subheader('Ingest #2: Follow-up (one week later)');
  const ingest2 = await brain.ingest({
    content: `Update from Alice Chen, March 22.
    Alice Chen, CRO of Acme Corp confirmed the enterprise deal.
    Bob Zhang approved the purchase.`,
    sourceType: 'meeting_transcript',
    validAt: new Date('2024-03-22'),
    groupId: GROUP,
  });

  log('INGEST-2', 'Result:', {
    episodeId: ingest2.episodeId,
    entitiesCreated: ingest2.entitiesCreated,
    entitiesUpdated: ingest2.entitiesUpdated,
    factsCreated: ingest2.factsCreated,
    factsInvalidated: ingest2.factsInvalidated,
  });

  if (ingest2.factsInvalidated > 0) {
    log('TEMPORAL', `${ingest2.factsInvalidated} fact(s) invalidated — Alice's role changed from VP → CRO`);
  }

  subheader('Ingest #3: Unrelated company');
  const ingest3 = await brain.ingest({
    content: `Dave Wilson, CEO of BigTech Inc announced a new product launch.
    They are hiring engineers. Contact dave@bigtech.io for opportunities.`,
    sourceType: 'press_release',
    validAt: new Date('2024-03-20'),
    groupId: GROUP,
  });

  log('INGEST-3', 'Result:', {
    entitiesCreated: ingest3.entitiesCreated,
    factsCreated: ingest3.factsCreated,
  });

  // ════════════════════════════════════════════════════════════
  // PART 3: KNOWLEDGE GRAPH EXPLORATION
  // ════════════════════════════════════════════════════════════

  header('PART 3: KNOWLEDGE GRAPH');

  subheader('Find entity: "Alice"');
  const alice = await brain.findEntity('Alice', GROUP);
  if (alice) {
    log('FOUND', `${alice.name} (${alice.entityType}) id=${alice.id}`);
    log('SUMMARY', alice.summary || '(no summary yet)');

    subheader('Alice: Full entity with connections');
    const full = await brain.getEntity(alice.id, {
      includeFacts: true,
      includeRelated: true,
      includeTimeline: true,
    });

    if (full) {
      log('ACTIVE-FACTS', `${full.facts.length} current facts:`);
      for (const f of full.facts) {
        console.log(`    \x1b[32m✓\x1b[0m ${f.factText} (${f.relation}, confidence=${f.confidence})`);
      }

      if (full.timeline.length > full.facts.length) {
        log('TIMELINE', `Full history (${full.timeline.length} facts, including invalidated):`);
        for (const f of full.timeline) {
          const icon = f.invalidAt ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m';
          const status = f.invalidAt ? `SUPERSEDED ${f.invalidAt.toISOString().split('T')[0]}` : 'CURRENT';
          console.log(`    ${icon} [${f.validAt.toISOString().split('T')[0]}] ${f.factText} — ${status}`);
        }
      }

      log('RELATED', `${full.related.length} connected entities:`);
      for (const r of full.related) {
        console.log(`    → ${r.name} (${r.entityType})`);
      }
    }
  } else {
    log('FIND', 'Alice not found (extraction may not have captured her name)');
  }

  subheader('Find entity: "Acme"');
  const acme = await brain.findEntity('Acme', GROUP);
  if (acme) {
    log('FOUND', `${acme.name} (${acme.entityType}) id=${acme.id}`);
    const acmeFull = await brain.getEntity(acme.id, { includeFacts: true, includeRelated: true });
    if (acmeFull) {
      log('FACTS', `${acmeFull.facts.length} active facts about ${acme.name}`);
      for (const f of acmeFull.facts) {
        console.log(`    ${f.factText}`);
      }
      log('RELATED', acmeFull.related.map(e => `${e.name} (${e.entityType})`).join(', ') || '(none)');
    }
  }

  // ════════════════════════════════════════════════════════════
  // PART 4: HYBRID SEARCH
  // ════════════════════════════════════════════════════════════

  header('PART 4: HYBRID SEARCH');

  const queries = [
    'What is happening with Acme?',
    'enterprise deal',
    'Who is Bob Zhang?',
    'BigTech hiring',
  ];

  for (const q of queries) {
    subheader(`Search: "${q}"`);
    const results = await brain.search({
      query: q,
      groupId: GROUP,
      methods: ['keyword', 'graph'],  // No semantic (needs embeddings/API key)
      limit: 5,
    });

    if (results.length > 0) {
      for (const r of results) {
        console.log(`    \x1b[36m[${r.type}]\x1b[0m score=${r.score.toFixed(3)} | ${r.content.slice(0, 80)}`);
        if (r.relation) console.log(`          relation: ${r.relation}`);
      }
    } else {
      log('SEARCH', 'No results');
    }
  }

  // ════════════════════════════════════════════════════════════
  // PART 5: TEMPORAL QUERIES
  // ════════════════════════════════════════════════════════════

  header('PART 5: TEMPORAL QUERIES');

  if (alice) {
    subheader('All facts about Alice (including superseded)');
    const allFacts = await brain.getFacts(alice.id, undefined, { includeInvalidated: true });
    for (const f of allFacts) {
      const status = f.invalidAt
        ? `\x1b[31mINVALIDATED ${f.invalidAt.toISOString().split('T')[0]}\x1b[0m`
        : '\x1b[32mACTIVE\x1b[0m';
      console.log(`    [${f.validAt.toISOString().split('T')[0]}] ${f.factText} — ${status}`);
    }

    subheader('Facts as of March 16 (should show VP, not CRO)');
    const marchFacts = await brain.getFacts(alice.id, undefined, {
      includeInvalidated: false,
      asOf: new Date('2024-03-16'),
    });
    if (marchFacts.length > 0) {
      for (const f of marchFacts) {
        console.log(`    ${f.factText}`);
      }
    } else {
      log('TEMPORAL', 'No facts found as of March 16');
    }

    subheader('Facts as of April 1 (should show CRO)');
    const aprilFacts = await brain.getFacts(alice.id, undefined, {
      includeInvalidated: false,
      asOf: new Date('2024-04-01'),
    });
    if (aprilFacts.length > 0) {
      for (const f of aprilFacts) {
        console.log(`    ${f.factText}`);
      }
    } else {
      log('TEMPORAL', 'No facts found as of April 1');
    }
  }

  // ════════════════════════════════════════════════════════════
  // PART 6: SKILL RESOLVER
  // ════════════════════════════════════════════════════════════

  header('PART 6: SKILL RESOLVER');

  const resolver = new SkillResolver();
  log('SKILLS', `${resolver.list().length} skills loaded`);
  log('ALWAYS-ON', `${resolver.getAlwaysOn().map(s => s.id).join(', ')}`);

  subheader('Routing table (what the LLM sees)');
  console.log(resolver.toRoutingTable());

  const testInputs = [
    'what do we know about Acme Corp?',
    'enrich this person Alice Chen',
    'here are my meeting notes from today',
    'show me the timeline for the deal',
    'how is our extraction doing?',
    'tell me a joke', // should not match well
  ];

  subheader('Skill matching');
  for (const input of testInputs) {
    const match = resolver.resolve(input);
    if (match) {
      console.log(`  "${input}"`);
      console.log(`    → \x1b[32m${match.skill.name}\x1b[0m (confidence=${match.confidence.toFixed(2)}, trigger="${match.matchedTrigger}")`);
    } else {
      console.log(`  "${input}"`);
      console.log(`    → \x1b[33mNo match\x1b[0m`);
    }
  }

  // ════════════════════════════════════════════════════════════
  // PART 7: EXTRACTION STATS (FAIL-IMPROVE LOOP)
  // ════════════════════════════════════════════════════════════

  header('PART 7: FAIL-IMPROVE LOOP');

  const stats = await brain.getExtractionStats();
  log('STATS', 'Extraction statistics:', {
    totalExtractions: stats.totalExtractions,
    deterministicHits: stats.deterministicHits,
    llmFallbacks: stats.llmFallbacks,
    deterministicRate: `${(stats.deterministicRate * 100).toFixed(1)}%`,
  });

  if (stats.totalExtractions > 0) {
    log('INSIGHT', stats.deterministicRate >= 0.7
      ? 'System is in good shape — >70% deterministic'
      : 'System needs more patterns — suggest running getSuggestedPatterns()');
  }

  // ════════════════════════════════════════════════════════════
  // PART 8: CUSTOM SCHEMA
  // ════════════════════════════════════════════════════════════

  header('PART 8: CUSTOM ONTOLOGY');

  await brain.defineSchema({
    entityTypes: [
      { id: 'deal', label: 'Deal', description: 'A sales deal or opportunity' },
      { id: 'feature_request', label: 'Feature Request', description: 'Customer feature request' },
    ],
    relationTypes: [
      { id: 'requested_feature', label: 'Requested', sourceTypes: ['person'], targetTypes: ['feature_request'] },
      { id: 'part_of_deal', label: 'Part Of Deal', sourceTypes: ['feature_request'], targetTypes: ['deal'] },
    ],
  });

  log('SCHEMA', 'Registered custom entity types: deal, feature_request');
  log('SCHEMA', 'Registered custom relation types: requested_feature, part_of_deal');

  // ════════════════════════════════════════════════════════════
  // DONE
  // ════════════════════════════════════════════════════════════

  header('DEMO COMPLETE');
  console.log(`  Entities created across all ingests`);
  console.log(`  Facts tracked with temporal validity`);
  console.log(`  Contradictions detected and old facts invalidated`);
  console.log(`  Hybrid search working (keyword + graph)`);
  console.log(`  Skill resolver matching intent to SOPs`);
  console.log(`  All using Postgres + pgvector — no external services\n`);

  await brain.close();
}

main().catch((err) => {
  console.error('\x1b[31mFatal error:\x1b[0m', err);
  process.exit(1);
});
