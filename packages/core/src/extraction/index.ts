/**
 * Extraction Pipeline — LLM-first with deterministic augmentation.
 *
 * Architecture (reliability-optimized):
 *   1. Structural pre-scan: catch source-shaped identifiers (emails, URLs, @mentions)
 *   2. Semantic context retrieval: embed pre-entities, search existing graph (RAKG pattern)
 *   3. LLM extraction: the primary engine — handles nuance, paraphrase, context
 *   4. Merge: combine deterministic + LLM, preferring LLM for entity/relationship quality
 *   5. Resolution: 3-tier entity dedup (alias → trigram+embedding → create), contradiction detection
 *   6. Logging: track extraction methods for observability
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
  FactEvidence,
  VisibilityPolicy,
} from '../types.js';
import {
  extractEntitiesDeterministic,
  extractFactsDeterministic,
  type DeterministicContext,
} from './deterministic.js';
import { extractWithLLM, type SchemaContext } from './llm.js';
import { resolveEntities, resolveFacts, updateEntitySummary } from './resolver.js';
import { logExtraction } from './fail-improve.js';
import { embed, embedBatch } from '../embedding.js';
import { isPublicVisibility, normalizeVisibility } from '../security.js';

export { getStats, suggestPatterns, proposeImprovements } from './fail-improve.js';
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
  /** Visibility inherited from the source episode. */
  visibility?: VisibilityPolicy;
}

export interface ExtractAndResolveResult {
  extraction: ExtractionResult;
  entitiesCreated: number;
  entitiesUpdated: number;
  factsCreated: number;
  factsInvalidated: number;
  ambiguities: Array<{
    type: 'entity_resolution' | 'fact_resolution';
    reason: string;
    payload: Record<string, unknown>;
  }>;
}

/**
 * Run the full extraction pipeline on a piece of text.
 *
 * Default flow (LLM-first with semantic graph context):
 *   1. Pre-scan structured identifiers (emails, @mentions, known entities)
 *   2. Retrieve semantic graph context — embed pre-entities, search existing graph
 *   3. Run LLM extraction for entities + relationships (with graph context)
 *   4. Merge results (deterministic structured data + LLM semantic understanding)
 *   5. Resolve against existing graph (3-tier dedup, contradiction, summary update)
 *   6. Log for observability
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
  const visibility = normalizeVisibility(options.visibility);

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
    // ─── Step 2: Load schema + semantic graph context in parallel ──
    const [existingContext, schema] = await Promise.all([
      // Semantic graph context retrieval (RAKG pattern)
      buildGraphContext(db, options.groupId, text, deterEntities, options.embeddingConfig),
      // Load entity/relation types from DB so the prompt is dynamic
      loadSchemaContext(db, options.groupId),
    ]);

    // ─── Step 3: LLM extraction (primary engine) ─────────────
    const llmResult = await extractWithLLM(text, options.llmConfig, existingContext, schema);

    // ─── Step 4: Merge deterministic + LLM results ───────────
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

  // ─── Step 4.5: Ensure all entity/relation types exist in DB ──
  // The LLM may return types not in the schema — auto-register them
  // so FK constraints don't block insertion.
  await ensureTypesExist(db, options.groupId, finalEntities, finalFacts);

  // ─── Step 5: Resolution (3-tier entity dedup) ────────────
  const resolved = await resolveEntities(db, finalEntities, options.groupId, options.embeddingConfig);
  const ambiguities: ExtractAndResolveResult['ambiguities'] = resolved
    .filter(res => res.ambiguity)
    .map(res => ({
      type: 'entity_resolution' as const,
      reason: String(res.ambiguity?.reason || 'ambiguous_entity_match'),
      payload: res.ambiguity || {},
    }));

  let entitiesCreated = 0;
  let entitiesUpdated = 0;
  const entityIdMap = new Map<string, string>();

  for (const res of resolved) {
    if (res.existingId) {
      entityIdMap.set(res.entity.name.toLowerCase(), res.existingId);

      // Merge new attributes into existing entity
      if (isPublicVisibility(visibility) && res.entity.attributes && Object.keys(res.entity.attributes).length > 0) {
        await db`
          UPDATE entities
          SET attributes = attributes || ${JSON.stringify(res.entity.attributes)}::jsonb,
              updated_at = now()
          WHERE id = ${res.existingId}
        `.catch(() => {});
      }
      entitiesUpdated++;
    } else {
      const nameEmbedding = await embed(`${res.entity.name} (${res.entity.entityType})`, options.embeddingConfig).catch(() => null);
      const result = await db`
        INSERT INTO entities (group_id, entity_type, name, attributes, visibility, name_embedding)
        VALUES (
          ${options.groupId},
          ${res.entity.entityType},
          ${res.entity.name},
          ${db.json((res.entity.attributes || {}) as any)},
          ${db.json(visibility as any)},
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

  // Resolve and create facts (with LLM conflict detection)
  const factResolutions = await resolveFacts(db, finalFacts, entityIdMap, options.groupId, options.embeddingConfig, options.llmConfig);
  ambiguities.push(
    ...factResolutions
      .filter(res => res.action === 'skip' && res.reason === 'entity_not_resolved')
      .map(res => ({
        type: 'fact_resolution' as const,
        reason: res.reason || 'entity_not_resolved',
        payload: {
          fact: res.fact,
          decision: 'skipped_inline_ambiguity',
        },
      })),
  );
  let factsCreated = 0;
  let factsInvalidated = 0;

  for (const res of factResolutions) {
    const sourceId = entityIdMap.get(res.fact.sourceName.toLowerCase());
    const targetId = entityIdMap.get(res.fact.targetName.toLowerCase());

    if (!sourceId || !targetId) continue;

    if (res.action === 'invalidate_existing' && res.existingFactId) {
      const idsToInvalidate = res.existingFactIds?.length ? res.existingFactIds : [res.existingFactId];
      await db`
        UPDATE facts SET invalid_at = now()
        WHERE id = ANY(${idsToInvalidate}::uuid[])
      `;
      factsInvalidated += idsToInvalidate.length;
    }

    if (res.action === 'create' || res.action === 'invalidate_existing') {
      const factEmbedding = await embed(res.fact.factText, options.embeddingConfig).catch(() => null);
      const evidence = buildFactEvidence(res.fact, text, {
        episodeId: options.episodeId || null,
        method,
      });
      await db`
        INSERT INTO facts (
          group_id, source_entity_id, target_entity_id, relation, fact_text,
          fact_embedding, evidence, extractor, visibility, valid_at, confidence, source_episode_id
        )
        VALUES (
          ${options.groupId},
          ${sourceId},
          ${targetId},
          ${res.fact.relation},
          ${res.fact.factText},
          ${factEmbedding ? `[${factEmbedding.join(',')}]` : null},
          ${db.json(evidence as any)},
          ${method},
          ${db.json({
            ...visibility,
            inheritedFrom: options.episodeId || visibility.inheritedFrom,
          } as any)},
          ${res.fact.validAt || new Date()},
          ${res.fact.confidence},
          ${options.episodeId || null}
        )
      `;
      factsCreated++;

      if (isPublicVisibility(visibility)) {
        await updateEntitySummary(db, sourceId, [res.fact.factText]);
      }
    }
  }

  // ─── Step 6: Log for observability ─────────────────────────
  if (options.config?.enableExtractionLog !== false) {
    await logExtraction(db, options.groupId, options.episodeId || null, extraction, text).catch(() => {});
  }

  return {
    extraction,
    entitiesCreated,
    entitiesUpdated,
    factsCreated,
    factsInvalidated,
    ambiguities,
  };
}

function buildFactEvidence(
  fact: ExtractedFact,
  sourceText: string,
  context: { episodeId: string | null; method: ExtractionResult['method'] },
): FactEvidence {
  const quote = fact.evidence?.quote || findEvidenceQuote(fact, sourceText);
  const evidence: FactEvidence = {
    ...fact.evidence,
    quote,
    sourceEpisodeId: context.episodeId,
    extractor: context.method,
  };

  if (quote) {
    const idx = sourceText.toLowerCase().indexOf(quote.toLowerCase());
    if (idx >= 0) {
      evidence.startOffset = idx;
      evidence.endOffset = idx + quote.length;
    }
  }

  return evidence;
}

function findEvidenceQuote(fact: ExtractedFact, sourceText: string): string | undefined {
  const candidates = [
    fact.factText,
    fact.sourceName,
    fact.targetName,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const idx = sourceText.toLowerCase().indexOf(candidate.toLowerCase());
    if (idx >= 0) {
      return sourceText.slice(idx, Math.min(sourceText.length, idx + Math.max(candidate.length, 160))).trim();
    }
  }

  return undefined;
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
 * Ensure all entity types and relation types from extraction results
 * exist in the database. Auto-creates missing types so FK constraints
 * don't block fact/entity insertion.
 */
async function ensureTypesExist(
  db: postgres.Sql,
  groupId: string,
  entities: ExtractedEntity[],
  facts: ExtractedFact[],
): Promise<void> {
  const entityTypes = new Set(entities.map(e => e.entityType));
  const relationTypes = new Set(facts.map(f => f.relation));

  for (const et of entityTypes) {
    await db`
      INSERT INTO entity_types (id, group_id, label, description, schema)
      VALUES (
        ${et},
        ${groupId},
        COALESCE((SELECT label FROM entity_types WHERE group_id = 'default' AND id = ${et}), ${humanizeTypeId(et)}),
        COALESCE((SELECT description FROM entity_types WHERE group_id = 'default' AND id = ${et}), ''),
        COALESCE((SELECT schema FROM entity_types WHERE group_id = 'default' AND id = ${et}), '{}'::jsonb)
      )
      ON CONFLICT (group_id, id) DO NOTHING
    `.catch(() => {});
  }

  for (const rt of relationTypes) {
    await db`
      INSERT INTO relation_types (
        id, group_id, label, source_types, target_types, description,
        cardinality, invalidation_policy
      )
      VALUES (
        ${rt},
        ${groupId},
        COALESCE((SELECT label FROM relation_types WHERE group_id = 'default' AND id = ${rt}), ${humanizeTypeId(rt)}),
        COALESCE((SELECT source_types FROM relation_types WHERE group_id = 'default' AND id = ${rt}), '{}'),
        COALESCE((SELECT target_types FROM relation_types WHERE group_id = 'default' AND id = ${rt}), '{}'),
        COALESCE((SELECT description FROM relation_types WHERE group_id = 'default' AND id = ${rt}), ''),
        COALESCE((SELECT cardinality FROM relation_types WHERE group_id = 'default' AND id = ${rt}), 'many'),
        COALESCE((SELECT invalidation_policy FROM relation_types WHERE group_id = 'default' AND id = ${rt}), 'llm')
      )
      ON CONFLICT (group_id, id) DO NOTHING
    `.catch(() => {});
  }
}

function humanizeTypeId(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Build context about the existing knowledge graph for the LLM.
 *
 * Uses the RAKG (Retrieval-Augmented Knowledge Graph) pattern:
 *   1. Exact name matches from deterministic pre-scan (fast, precise)
 *   2. Semantic search — embed the input text and find related entities by vector similarity
 *   3. Retrieve matched entities + their recent facts from the graph
 *   4. Format as structured context for the extraction LLM
 *
 * This ensures the LLM always has relevant graph context, even when
 * deterministic extraction finds nothing — which is the common case
 * with messy, unstructured data from diverse sources.
 */
async function buildGraphContext(
  db: postgres.Sql,
  groupId: string,
  text: string,
  deterEntities: ExtractedEntity[],
  embeddingConfig?: EmbeddingConfig,
): Promise<string | undefined> {

  // Strategy 1: Exact name matches from deterministic pre-scan
  const nameMatchPromise = deterEntities.length > 0
    ? db`
        SELECT e.id, e.name, e.entity_type, e.summary
        FROM entities e
        WHERE e.group_id = ${groupId}
          AND e.name = ANY(${deterEntities.map(e => e.name)})
        LIMIT 10
      `.catch(() => [])
    : Promise.resolve([]);

  // Strategy 2: Semantic vector search — embed the text and find related entities
  const semanticPromise = (async () => {
    try {
      const queryEmbedding = await embed(text.slice(0, 500), embeddingConfig);
      const vecLiteral = `[${queryEmbedding.join(',')}]`;
      return await db`
        SELECT e.id, e.name, e.entity_type, e.summary,
               1 - (e.name_embedding <=> ${vecLiteral}::vector) AS sim
        FROM entities e
        WHERE e.group_id = ${groupId}
          AND e.name_embedding IS NOT NULL
        ORDER BY e.name_embedding <=> ${vecLiteral}::vector
        LIMIT 15
      `;
    } catch {
      return [];
    }
  })();

  const [nameMatches, semanticMatches] = await Promise.all([
    nameMatchPromise,
    semanticPromise,
  ]);

  // Deduplicate by entity ID, preferring name matches over semantic
  const entityMap = new Map<string, any>();
  for (const e of semanticMatches) {
    if (Number(e.sim) >= 0.30) {
      entityMap.set(e.id, e);
    }
  }
  for (const e of nameMatches) entityMap.set(e.id, e);

  if (entityMap.size === 0) return undefined;

  // Fetch recent facts for matched entities (single batch query)
  const entityIds = [...entityMap.keys()];
  const factsForEntities = await db`
    SELECT f.source_entity_id, f.target_entity_id, f.relation, f.fact_text,
           se.name AS source_name, te.name AS target_name
    FROM facts f
    JOIN entities se ON se.id = f.source_entity_id
    JOIN entities te ON te.id = f.target_entity_id
    WHERE f.group_id = ${groupId}
      AND f.invalid_at IS NULL
      AND (f.source_entity_id = ANY(${entityIds}::uuid[]) OR f.target_entity_id = ANY(${entityIds}::uuid[]))
    ORDER BY f.valid_at DESC
    LIMIT 50
  `.catch(() => []);

  // Group facts by entity
  const factsByEntity = new Map<string, string[]>();
  for (const f of factsForEntities) {
    const factLine = `${f.source_name} → ${f.relation} → ${f.target_name}: ${f.fact_text}`;
    for (const key of [f.source_entity_id, f.target_entity_id]) {
      if (!factsByEntity.has(key)) factsByEntity.set(key, []);
      factsByEntity.get(key)!.push(factLine);
    }
  }

  // Format context
  const lines: string[] = [];
  for (const [id, e] of entityMap) {
    const facts = factsByEntity.get(id)?.slice(0, 3) ?? [];
    const factStr = facts.length > 0 ? `\n    Facts: ${facts.join('; ')}` : '';
    lines.push(`- ${e.name} (${e.entity_type}): ${e.summary || 'No summary yet'}${factStr}`);
  }

  return `EXISTING ENTITIES IN KNOWLEDGE GRAPH (use these names when referring to known entities — do NOT create duplicates):
${lines.join('\n')}`;
}

/**
 * Load entity types and relation types from the database.
 * These are passed to the LLM prompt so it knows what types are valid
 * for this particular knowledge graph — no hardcoded types.
 */
async function loadSchemaContext(
  db: postgres.Sql,
  groupId: string,
): Promise<SchemaContext | undefined> {
  try {
    let [entityTypes, relationTypes] = await Promise.all([
      loadEntityTypesForGroup(db, groupId),
      loadRelationTypesForGroup(db, groupId),
    ]);

    // The starter ontology is only a bootstrap fallback for empty workspaces.
    // Once a group defines or auto-creates any ontology, prompts use the group-owned schema only.
    if (groupId !== 'default' && entityTypes.length === 0 && relationTypes.length === 0) {
      [entityTypes, relationTypes] = await Promise.all([
        loadEntityTypesForGroup(db, 'default'),
        loadRelationTypesForGroup(db, 'default'),
      ]);
    }

    if (entityTypes.length === 0 && relationTypes.length === 0) return undefined;

    return {
      entityTypes: entityTypes.map((t: any) => ({
        id: t.id,
        label: t.label,
        description: t.description || undefined,
      })),
      relationTypes: relationTypes.map((t: any) => ({
        id: t.id,
        label: t.label,
        sourceTypes: t.source_types?.length ? t.source_types : undefined,
        targetTypes: t.target_types?.length ? t.target_types : undefined,
        description: t.description || undefined,
        cardinality: t.cardinality || undefined,
        invalidationPolicy: t.invalidation_policy || undefined,
      })),
    };
  } catch {
    return undefined;
  }
}

async function loadEntityTypesForGroup(db: postgres.Sql, groupId: string): Promise<any[]> {
  return db`
    SELECT id, label, description FROM entity_types
    WHERE group_id = ${groupId}
    ORDER BY id
  `;
}

async function loadRelationTypesForGroup(db: postgres.Sql, groupId: string): Promise<any[]> {
  return db`
    SELECT id, label, source_types, target_types, description, cardinality, invalidation_policy FROM relation_types
    WHERE group_id = ${groupId}
    ORDER BY id
  `;
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
