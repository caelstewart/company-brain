/**
 * Extraction Pipeline: The 3-layer hybrid approach.
 *
 * Layer 1: Deterministic (regex, patterns, known entity matching) — instant, $0
 * Layer 2: LLM fallback (when deterministic confidence < threshold) — ~1s, ~$0.001
 * Layer 3: Resolution (dedup, contradiction detection, summary rewrite)
 *
 * The fail-improve loop logs every LLM fallback so the system progressively
 * moves more work into the deterministic layer over time.
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
  assessExtractionConfidence,
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
  /** Skip LLM even if deterministic confidence is low */
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
 * 1. Try deterministic extraction
 * 2. If confidence < threshold, fall back to LLM
 * 3. Resolve against existing graph (dedup, contradiction, summary update)
 * 4. Log the extraction for fail-improve
 */
export async function extractAndResolve(
  db: postgres.Sql,
  text: string,
  options: ExtractAndResolveOptions,
): Promise<ExtractAndResolveResult> {
  const startTime = Date.now();
  const threshold = options.config?.llmFallbackThreshold ?? 0.6;

  // ─── Layer 1: Deterministic ─────────────────────────────────
  const deterEntities = extractEntitiesDeterministic(text, options.deterministicContext);
  const deterFacts = extractFactsDeterministic(text, deterEntities);
  const confidence = assessExtractionConfidence(text, deterEntities, deterFacts);

  let finalEntities: ExtractedEntity[] = deterEntities;
  let finalFacts: ExtractedFact[] = deterFacts;
  let method: 'deterministic' | 'llm' | 'hybrid' = 'deterministic';

  // ─── Layer 2: LLM Fallback ─────────────────────────────────
  if (confidence < threshold && !options.deterministicOnly) {
    const llmResult = await extractWithLLM(text, options.llmConfig);

    // Merge: LLM results supplement deterministic, not replace
    const deterNames = new Set(deterEntities.map(e => e.name.toLowerCase()));
    const newFromLLM = llmResult.entities.filter(e => !deterNames.has(e.name.toLowerCase()));
    finalEntities = [...deterEntities, ...newFromLLM];

    const deterFactKeys = new Set(deterFacts.map(f => `${f.sourceName}|${f.relation}|${f.targetName}`.toLowerCase()));
    const newFactsFromLLM = llmResult.facts.filter(f =>
      !deterFactKeys.has(`${f.sourceName}|${f.relation}|${f.targetName}`.toLowerCase())
    );
    finalFacts = [...deterFacts, ...newFactsFromLLM];

    method = deterEntities.length > 0 ? 'hybrid' : 'llm';
  }

  const durationMs = Date.now() - startTime;

  const extraction: ExtractionResult = {
    entities: finalEntities,
    facts: finalFacts,
    method,
    durationMs,
  };

  // ─── Layer 3: Resolution ────────────────────────────────────
  const resolved = await resolveEntities(db, finalEntities, options.groupId);

  // Create new entities
  let entitiesCreated = 0;
  let entitiesUpdated = 0;
  const entityIdMap = new Map<string, string>();

  for (const res of resolved) {
    if (res.existingId) {
      entityIdMap.set(res.entity.name.toLowerCase(), res.existingId);
      entitiesUpdated++;
    } else {
      // Create new entity
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

      // Register alias for future dedup
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
      // Fall through to create the new replacement fact
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

      // Update entity summaries with new facts
      await updateEntitySummary(db, sourceId, [res.fact.factText]);
    }
  }

  // ─── Log for fail-improve ───────────────────────────────────
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
