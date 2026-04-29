/**
 * Extraction Pipeline — LLM-first with deterministic augmentation.
 *
 * Architecture (reliability-optimized):
 *   1. Deterministic pre-scan: catch structured data (emails, URLs, @mentions)
 *   2. LLM extraction: the primary engine — handles nuance, paraphrase, context
 *   3. Merge: combine deterministic + LLM, preferring LLM for entity/relationship quality
 *   4. Resolution: dedup against existing graph, detect contradictions, update summaries
 *   5. Logging: track extraction methods for observability
 *
 * The deterministic layer is NOT a replacement for the LLM — it's a
 * supplement that catches structured signals the LLM might overlook
 * (email addresses, @handles, URLs) and provides known-entity matching
 * for faster resolution.
 */

import type postgres from 'postgres';
import type {
  ExtractionResult,
  ExtractionConfig,
  LLMConfig,
  EmbeddingConfig,
  ExtractedEntity,
  ExtractedFact,
} from '../types.js';
import {
  extractEntitiesDeterministic,
  extractFactsDeterministic,
  type DeterministicContext,
} from './deterministic.js';
import { extractWithLLM } from './llm.js';
import { resolveEntities, resolveFacts, updateEntitySummary } from './resolver.js';
import { logExtraction } from './fail-improve.js';
import { embed } from '../embedding.js';

export { getStats, suggestPatterns } from './fail-improve.js';
export { extractEntitiesDeterministic, extractFactsDeterministic } from './deterministic.js';
export { extractWithLLM } from './llm.js';
export { resolveEntities, resolveFacts } from './resolver.js';

// ─── Main Extraction Pipeline ─────────────────────────────────

export interface ExtractAndResolveOptions {
  groupId: string;
  episodeId?: string;
  config?: ExtractionConfig;
  llmConfig?: LLMConfig;
  embeddingConfig?: EmbeddingConfig;
  /** Pre-loaded context for deterministic matching */
  deterministicContext?: DeterministicContext;
  /** Skip LLM — use only deterministic extraction (for testing without API keys) */
  deterministicOnly?: boolean;
}

export interface ExtractAndResolveResult {
  extraction: ExtractionResult;
  entitiesCreated: number;
  entitiesUpdated: number;
  factsCreated: number;
  factsInvalidated: number;
}

/**
 * Run the full extraction pipeline on a piece of text.
 *
 * Default flow (LLM-first):
 *   1. Pre-scan with deterministic patterns (emails, @mentions, known entities)
 *   2. Run LLM extraction for entities + relationships
 *   3. Merge results (deterministic structured data + LLM semantic understanding)
 *   4. Resolve against existing graph (dedup, contradiction, summary update)
 *   5. Log for observability
 *
 * Fallback flow (deterministicOnly=true):
 *   Runs only deterministic extraction — useful for testing or when no API keys.
 */
export async function extractAndResolve(
  db: postgres.Sql,
  text: string,
  options: ExtractAndResolveOptions,
): Promise<ExtractAndResolveResult> {
  const startTime = Date.now();

  // ─── Step 1: Deterministic pre-scan ──────────────────────
  // Catches structured data: emails, @mentions, URLs, known entity matches
  const deterEntities = extractEntitiesDeterministic(text, options.deterministicContext);
  const deterFacts = extractFactsDeterministic(text, deterEntities);

  let finalEntities: ExtractedEntity[];
  let finalFacts: ExtractedFact[];
  let method: 'deterministic' | 'llm' | 'hybrid';

  if (options.deterministicOnly || !hasLLMConfig(options.llmConfig)) {
    // ─── Deterministic-only mode ─────────────────────────────
    finalEntities = deterEntities;
    finalFacts = deterFacts;
    method = 'deterministic';
  } else {
    // ─── Step 2: LLM extraction (primary engine) ─────────────
    // Build existing graph context for the LLM to reference
    const existingContext = await buildGraphContext(db, options.groupId, deterEntities);
    const llmResult = await extractWithLLM(text, options.llmConfig, existingContext);

    // ─── Step 3: Merge deterministic + LLM results ───────────
    // LLM is the authority for entity names and relationships.
    // Deterministic adds structured data (emails, handles) the LLM might miss.
    finalEntities = mergeEntities(llmResult.entities, deterEntities);
    finalFacts = mergeFacts(llmResult.facts, deterFacts);
    method = deterEntities.length > 0 ? 'hybrid' : 'llm';
  }

  const durationMs = Date.now() - startTime;

  const extraction: ExtractionResult = {
    entities: finalEntities,
    facts: finalFacts,
    method,
    durationMs,
  };

  // ─── Step 4: Resolution ────────────────────────────────────
  const resolved = await resolveEntities(db, finalEntities, options.groupId);

  let entitiesCreated = 0;
  let entitiesUpdated = 0;
  const entityIdMap = new Map<string, string>();

  for (const res of resolved) {
    if (res.existingId) {
      entityIdMap.set(res.entity.name.toLowerCase(), res.existingId);
      entitiesUpdated++;
    } else {
      const nameEmbedding = await embed(res.entity.name, options.embeddingConfig).catch(() => null);
      const result = await db`
        INSERT INTO entities (group_id, entity_type, name, attributes, name_embedding)
        VALUES (
          ${options.groupId},
          ${res.entity.entityType},
          ${res.entity.name},
          ${JSON.stringify(res.entity.attributes || {})},
          ${nameEmbedding ? `[${nameEmbedding.join(',')}]` : null}
        )
        RETURNING id
      `;
      const newId = result[0].id;
      entityIdMap.set(res.entity.name.toLowerCase(), newId);

      await db`
        INSERT INTO entity_aliases (entity_id, alias, alias_type)
        VALUES (${newId}, ${res.entity.name}, 'name')
        ON CONFLICT (entity_id, alias) DO NOTHING
      `;
      entitiesCreated++;
    }
  }

  // Resolve and create facts
  const factResolutions = await resolveFacts(db, finalFacts, entityIdMap, options.groupId);
  let factsCreated = 0;
  let factsInvalidated = 0;

  for (const res of factResolutions) {
    const sourceId = entityIdMap.get(res.fact.sourceName.toLowerCase());
    const targetId = entityIdMap.get(res.fact.targetName.toLowerCase());

    if (!sourceId || !targetId) continue;

    if (res.action === 'invalidate_existing' && res.existingFactId) {
      await db`
        UPDATE facts SET invalid_at = now()
        WHERE id = ${res.existingFactId}
      `;
      factsInvalidated++;
    }

    if (res.action === 'create' || res.action === 'invalidate_existing') {
      const factEmbedding = await embed(res.fact.factText, options.embeddingConfig).catch(() => null);
      await db`
        INSERT INTO facts (group_id, source_entity_id, target_entity_id, relation, fact_text, fact_embedding, valid_at, confidence, source_episode_id)
        VALUES (
          ${options.groupId},
          ${sourceId},
          ${targetId},
          ${res.fact.relation},
          ${res.fact.factText},
          ${factEmbedding ? `[${factEmbedding.join(',')}]` : null},
          ${res.fact.validAt || new Date()},
          ${res.fact.confidence},
          ${options.episodeId || null}
        )
      `;
      factsCreated++;

      await updateEntitySummary(db, sourceId, [res.fact.factText]);
    }
  }

  // ─── Step 5: Log for observability ─────────────────────────
  if (options.config?.enableExtractionLog !== false) {
    await logExtraction(db, options.groupId, options.episodeId || null, extraction, text).catch(() => {});
  }

  return {
    extraction,
    entitiesCreated,
    entitiesUpdated,
    factsCreated,
    factsInvalidated,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function hasLLMConfig(config?: LLMConfig): boolean {
  if (!config) {
    // Check env vars
    return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  }
  return !!config.apiKey;
}

/**
 * Build context about existing entities for the LLM to reference.
 * This helps the LLM avoid creating duplicate entities and detect
 * when new information contradicts existing facts.
 */
async function buildGraphContext(
  db: postgres.Sql,
  groupId: string,
  deterEntities: ExtractedEntity[],
): Promise<string | undefined> {
  if (deterEntities.length === 0) return undefined;

  const names = deterEntities.map(e => e.name);
  const existingEntities = await db`
    SELECT e.name, e.entity_type, e.summary,
           array_agg(DISTINCT f.fact_text) FILTER (WHERE f.id IS NOT NULL AND f.invalid_at IS NULL) AS facts
    FROM entities e
    LEFT JOIN facts f ON (f.source_entity_id = e.id OR f.target_entity_id = e.id)
    WHERE e.group_id = ${groupId}
      AND e.name = ANY(${names})
    GROUP BY e.id
    LIMIT 20
  `.catch(() => []);

  if (existingEntities.length === 0) return undefined;

  const lines = existingEntities.map((e: any) => {
    const facts = e.facts?.filter(Boolean)?.join('; ') || 'no known facts';
    return `- ${e.name} (${e.entity_type}): ${e.summary || facts}`;
  });

  return `Known entities:\n${lines.join('\n')}`;
}

/**
 * Merge LLM and deterministic entities.
 * LLM entities are the primary source. Deterministic entities add
 * structured data (emails, handles) that the LLM might miss.
 */
function mergeEntities(
  llmEntities: ExtractedEntity[],
  deterEntities: ExtractedEntity[],
): ExtractedEntity[] {
  const merged = [...llmEntities];
  const llmNames = new Set(llmEntities.map(e => e.name.toLowerCase()));

  for (const de of deterEntities) {
    const llmMatch = llmEntities.find(le =>
      le.name.toLowerCase().includes(de.name.toLowerCase()) ||
      de.name.toLowerCase().includes(le.name.toLowerCase())
    );

    if (llmMatch && de.attributes) {
      // Merge attributes (email, handle) into the LLM entity
      llmMatch.attributes = { ...llmMatch.attributes, ...de.attributes };
    } else if (!llmNames.has(de.name.toLowerCase())) {
      // Deterministic found something LLM missed — add it
      merged.push(de);
    }
  }

  return merged;
}

/**
 * Merge LLM and deterministic facts.
 * LLM facts are primary. Deterministic facts fill gaps.
 */
function mergeFacts(
  llmFacts: ExtractedFact[],
  deterFacts: ExtractedFact[],
): ExtractedFact[] {
  const merged = [...llmFacts];
  const llmKeys = new Set(llmFacts.map(f =>
    `${f.sourceName}|${f.relation}|${f.targetName}`.toLowerCase()
  ));

  for (const df of deterFacts) {
    const key = `${df.sourceName}|${df.relation}|${df.targetName}`.toLowerCase();
    if (!llmKeys.has(key)) {
      merged.push(df);
    }
  }

  return merged;
}
