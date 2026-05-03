/**
 * Layer 3: Resolution.
 *
 * After extraction (deterministic or LLM), this layer:
 * 1. Deduplicates entities against the existing graph using 3-tier resolution:
 *    - Tier 1: Exact alias match (fastest, no LLM/embedding)
 *    - Tier 2: Trigram + embedding similarity (hybrid fuzzy match)
 *    - Tier 3: Auto-create new entity (no match found)
 * 2. Invalidates contradicted facts (temporal model)
 * 3. Rewrites entity summaries when new info arrives
 * 4. Propagates backlinks
 *
 * Embedding-based resolution follows the SOTA 3-tier pattern:
 *   score >= 0.95 → auto-merge (no LLM needed)
 *   score 0.80-0.95 → merge with alias registration
 *   score < 0.80 → create new entity
 */

import type postgres from 'postgres';
import type {
  Entity,
  ExtractedEntity,
  ExtractedFact,
  Fact,
  FactInput,
  EmbeddingConfig,
  LLMConfig,
  RelationCardinality,
  RelationInvalidationPolicy,
} from '../types.js';
import { embed, embedBatch, cosineSimilarity } from '../embedding.js';
import { anthropicMaxOutputTokens, defaultLLMModel, defaultLLMProvider } from '../llm-limits.js';

// ─── Entity Resolution (Dedup) ───────────────────────────────

export interface ResolvedEntity {
  entity: ExtractedEntity;
  existingId: string | null;  // null = new entity to create
  matchConfidence: number;
  matchMethod?: 'alias' | 'trigram' | 'embedding' | 'none';
  ambiguity?: Record<string, unknown>;
}

/**
 * Resolve extracted entities against existing graph.
 * Uses a 3-tier approach: alias → trigram+embedding → create new.
 *
 * The embedding tier uses name_embedding vectors stored on entities,
 * catching semantic matches that trigram misses (e.g. "CTO" vs "Chief Technology Officer").
 */
export async function resolveEntities(
  db: postgres.Sql,
  extracted: ExtractedEntity[],
  groupId: string,
  embeddingConfig?: EmbeddingConfig,
): Promise<ResolvedEntity[]> {
  const resolved: ResolvedEntity[] = [];

  // Batch-embed all extracted entity names upfront (single API call)
  const namesToEmbed = extracted.map(e => `${e.name} (${e.entityType})`);
  let embeddings: number[][] | null = null;
  try {
    if (namesToEmbed.length > 0) {
      embeddings = await embedBatch(namesToEmbed, embeddingConfig);
    }
  } catch {
    // Embedding unavailable — fall back to alias + trigram only
  }

  for (let i = 0; i < extracted.length; i++) {
    const entity = extracted[i];
    const entityEmbedding = embeddings?.[i] ?? null;

    // Tier 1: Exact alias match (fastest, highest confidence)
    const aliasMatch = await db`
      SELECT ea.entity_id, e.name, e.entity_type
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE LOWER(ea.alias) = LOWER(${entity.name})
        AND e.group_id = ${groupId}
        AND e.entity_type = ${entity.entityType}
      LIMIT 1
    `;

    if (aliasMatch.length > 0) {
      resolved.push({
        entity,
        existingId: aliasMatch[0].entity_id,
        matchConfidence: 0.95,
        matchMethod: 'alias',
      });
      continue;
    }

    // Tier 2: Hybrid — trigram similarity + embedding similarity
    // Run both in parallel and pick the best match
    const [trigramCandidates, embeddingCandidates] = await Promise.all([
      // Trigram fuzzy match on name
      db`
        SELECT id, name, entity_type,
               similarity(name, ${entity.name}) AS sim
        FROM entities
        WHERE group_id = ${groupId}
          AND entity_type = ${entity.entityType}
          AND similarity(name, ${entity.name}) > 0.3
        ORDER BY sim DESC
        LIMIT 5
      `,
      // Embedding similarity on name_embedding (if we have an embedding)
      entityEmbedding
        ? db`
            SELECT id, name, entity_type, name_embedding,
                   1 - (name_embedding <=> ${`[${entityEmbedding.join(',')}]`}::vector) AS sim
            FROM entities
            WHERE group_id = ${groupId}
              AND entity_type = ${entity.entityType}
              AND name_embedding IS NOT NULL
            ORDER BY name_embedding <=> ${`[${entityEmbedding.join(',')}]`}::vector
            LIMIT 5
          `
        : Promise.resolve([]),
    ]);

    // Find the best candidate across both methods
    const bestMatch = pickBestMatch(entity, trigramCandidates, embeddingCandidates);

    if (bestMatch && bestMatch.score >= 0.90) {
      resolved.push({
        entity,
        existingId: bestMatch.id,
        matchConfidence: bestMatch.score,
        matchMethod: bestMatch.method,
      });

      // Register as alias for future fast lookups (if name differs)
      if (entity.name.toLowerCase() !== bestMatch.name.toLowerCase()) {
        await db`
          INSERT INTO entity_aliases (entity_id, alias, alias_type)
          VALUES (${bestMatch.id}, ${entity.name}, 'resolved')
          ON CONFLICT (entity_id, alias) DO NOTHING
        `.catch(() => {});
      }
      continue;
    }

    let ambiguity: Record<string, unknown> | undefined;
    if (bestMatch) {
      ambiguity = {
        reason: 'ambiguous_entity_match',
        extracted: entity,
        candidate: bestMatch,
        decision: 'created_new_entity_inline_ambiguity',
      };
      await recordInlineAmbiguity(db, groupId, 'entity_resolution', {
        ...ambiguity,
      });
    }

    // Tier 3: No match → new entity
    resolved.push({
      entity,
      existingId: null,
      matchConfidence: 0,
      matchMethod: 'none',
      ambiguity,
    });
  }

  return resolved;
}

interface MatchCandidate {
  id: string;
  name: string;
  score: number;
  method: 'trigram' | 'embedding';
}

/**
 * Pick the best match from trigram and embedding candidates.
 * Uses a 3-tier threshold:
 *   >= 0.95 embedding sim → auto-merge (semantic near-identical)
 *   >= 0.80 combined score → merge with confidence
 *   < 0.80 → no match
 */
function pickBestMatch(
  entity: ExtractedEntity,
  trigramCandidates: any[],
  embeddingCandidates: any[],
): MatchCandidate | null {
  const candidates: MatchCandidate[] = [];

  // Score trigram candidates
  for (const tc of trigramCandidates) {
    candidates.push({
      id: tc.id,
      name: tc.name,
      score: Number(tc.sim),
      method: 'trigram',
    });
  }

  // Score embedding candidates
  for (const ec of embeddingCandidates) {
    const embScore = Number(ec.sim);
    // Check if this entity already has a trigram score
    const existing = candidates.find(c => c.id === ec.id);
    if (existing) {
      // Combine: 0.4 * trigram + 0.6 * embedding (embedding is more semantically aware)
      const combined = 0.4 * existing.score + 0.6 * embScore;
      if (combined > existing.score) {
        existing.score = combined;
        existing.method = 'embedding';
      }
    } else if (embScore >= 0.80) {
      // Pure embedding match — no trigram support needed if score is high
      candidates.push({
        id: ec.id,
        name: ec.name,
        score: embScore,
        method: 'embedding',
      });
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) return null;

  // Return plausible candidates; caller decides whether to auto-merge or review.
  if (best.score >= 0.75) {
    return best;
  }

  return null;
}

// ─── Fact Contradiction Detection ─────────────────────────────

export interface FactResolution {
  fact: ExtractedFact;
  action: 'create' | 'skip' | 'invalidate_existing';
  existingFactId?: string;
  existingFactIds?: string[];
  reason?: string;
}

interface RelationSemantics {
  cardinality: RelationCardinality;
  invalidationPolicy: RelationInvalidationPolicy;
}

const DEFAULT_RELATION_SEMANTICS: RelationSemantics = {
  cardinality: 'many',
  invalidationPolicy: 'llm',
};

/**
 * Detect contradictions between new facts and existing facts.
 *
 * Pipeline:
 *   1. Exact text match → skip (duplicate)
 *   2. Embedding similarity > 0.92 → skip (semantic duplicate)
 *   3. Existing facts with same (source, target, relation) → LLM conflict check
 *   4. LLM decides: additive (both can coexist) or contradiction (invalidate old)
 *
 * The LLM conflict check replaces hardcoded "exclusive relations" — it can
 * determine that "pricing is $99" contradicts "pricing is $149" without us
 * maintaining a list of which relations are exclusive.
 */
export async function resolveFacts(
  db: postgres.Sql,
  extractedFacts: ExtractedFact[],
  entityIdMap: Map<string, string>,  // name → entity UUID
  groupId: string,
  embeddingConfig?: EmbeddingConfig,
  llmConfig?: LLMConfig,
): Promise<FactResolution[]> {
  const resolutions: FactResolution[] = [];
  const relationSemantics = await loadRelationSemantics(
    db,
    groupId,
    extractedFacts.map(f => f.relation),
  );

  // Batch: collect facts that need LLM conflict detection
  const pendingConflictChecks: {
    fact: ExtractedFact;
    existing: { id: string; fact_text: string }[];
  }[] = [];

  for (const fact of extractedFacts) {
    const sourceId = entityIdMap.get(fact.sourceName.toLowerCase());
    const targetId = entityIdMap.get(fact.targetName.toLowerCase());

    if (!sourceId || !targetId) {
      resolutions.push({ fact, action: 'skip', reason: 'entity_not_resolved' });
      await recordInlineAmbiguity(db, groupId, 'fact_resolution', {
        reason: 'entity_not_resolved',
        fact,
        missingSource: !sourceId ? fact.sourceName : undefined,
        missingTarget: !targetId ? fact.targetName : undefined,
      });
      continue;
    }

    const semantics = relationSemantics.get(fact.relation) ?? DEFAULT_RELATION_SEMANTICS;
    const existing = await findCandidateFacts(
      db,
      groupId,
      fact,
      sourceId,
      targetId,
      semantics.cardinality,
    );

    if (existing.length === 0) {
      resolutions.push({ fact, action: 'create' });
      continue;
    }

    // Check for duplicate: exact text match
    const isDuplicate = existing.some(e =>
      e.fact_text.toLowerCase().trim() === fact.factText.toLowerCase().trim()
    );

    if (isDuplicate) {
      resolutions.push({ fact, action: 'skip', reason: 'duplicate' });
      continue;
    }

    // Check for semantic duplicate via embedding similarity
    let isSemanticDuplicate = false;
    try {
      const newFactEmbedding = await embed(fact.factText, embeddingConfig);
      for (const e of existing) {
        if (e.fact_embedding) {
          const sim = cosineSimilarity(newFactEmbedding, e.fact_embedding);
          if (sim > 0.92) {
            isSemanticDuplicate = true;
            break;
          }
        }
      }
    } catch {
      // Embedding unavailable — skip semantic dedup
    }

    if (isSemanticDuplicate) {
      resolutions.push({ fact, action: 'skip', reason: 'semantic_duplicate' });
      continue;
    }

    if (semantics.invalidationPolicy === 'never') {
      resolutions.push({ fact, action: 'create' });
      continue;
    }

    if (semantics.invalidationPolicy === 'always') {
      resolutions.push({
        fact,
        action: 'invalidate_existing',
        existingFactId: existing[0].id,
        existingFactIds: existing.map(e => e.id),
        reason: `relation_${semantics.cardinality}_superseded`,
      });
      continue;
    }

    // Not a duplicate, but existing facts exist → potential conflict
    pendingConflictChecks.push({
      fact,
      existing: existing.map(e => ({ id: e.id, fact_text: e.fact_text })),
    });
  }

  // Batch LLM conflict detection for all pending facts
  if (pendingConflictChecks.length > 0) {
    const conflictResults = await detectConflictsBatch(pendingConflictChecks, llmConfig);
    resolutions.push(...conflictResults);
  }

  return resolutions;
}

async function recordInlineAmbiguity(
  db: postgres.Sql,
  groupId: string,
  reviewType: 'entity_resolution' | 'fact_resolution' | 'schema' | 'skill',
  payload: Record<string, unknown>,
): Promise<void> {
  await db`
    INSERT INTO audit_log (group_id, action, resource_type, metadata)
    VALUES (
      ${groupId},
      ${`inline_${reviewType}_ambiguity`},
      ${reviewType},
      ${JSON.stringify(payload)}
    )
  `.catch(() => {});
}

async function loadRelationSemantics(
  db: postgres.Sql,
  groupId: string,
  relations: string[],
): Promise<Map<string, RelationSemantics>> {
  const uniqueRelations = [...new Set(relations)];
  const semantics = new Map<string, RelationSemantics>();
  if (uniqueRelations.length === 0) return semantics;

  const rows = await db`
    SELECT DISTINCT ON (id) id, cardinality, invalidation_policy, group_id
    FROM relation_types
    WHERE id = ANY(${uniqueRelations})
      AND (group_id = ${groupId} OR group_id = 'default')
    ORDER BY id, CASE WHEN group_id = ${groupId} THEN 0 ELSE 1 END
  `.catch(() => []);

  for (const row of rows) {
    semantics.set(row.id, {
      cardinality: normalizeCardinality(row.cardinality),
      invalidationPolicy: normalizeInvalidationPolicy(row.invalidation_policy),
    });
  }

  return semantics;
}

async function findCandidateFacts(
  db: postgres.Sql,
  groupId: string,
  fact: ExtractedFact,
  sourceId: string,
  targetId: string,
  cardinality: RelationCardinality,
): Promise<any[]> {
  if (cardinality === 'one_per_source') {
    return db`
      SELECT id, fact_text, fact_embedding, valid_at, invalid_at
      FROM facts
      WHERE group_id = ${groupId}
        AND source_entity_id = ${sourceId}
        AND relation = ${fact.relation}
        AND invalid_at IS NULL
      ORDER BY valid_at DESC
      LIMIT 10
    `;
  }

  if (cardinality === 'one_per_target') {
    return db`
      SELECT id, fact_text, fact_embedding, valid_at, invalid_at
      FROM facts
      WHERE group_id = ${groupId}
        AND target_entity_id = ${targetId}
        AND relation = ${fact.relation}
        AND invalid_at IS NULL
      ORDER BY valid_at DESC
      LIMIT 10
    `;
  }

  return db`
    SELECT id, fact_text, fact_embedding, valid_at, invalid_at
    FROM facts
    WHERE group_id = ${groupId}
      AND source_entity_id = ${sourceId}
      AND target_entity_id = ${targetId}
      AND relation = ${fact.relation}
      AND invalid_at IS NULL
    ORDER BY valid_at DESC
    LIMIT 10
  `;
}

function normalizeCardinality(value: unknown): RelationCardinality {
  return value === 'one_per_source' ||
    value === 'one_per_target' ||
    value === 'one_between_pair' ||
    value === 'many'
    ? value
    : DEFAULT_RELATION_SEMANTICS.cardinality;
}

function normalizeInvalidationPolicy(value: unknown): RelationInvalidationPolicy {
  return value === 'never' || value === 'always' || value === 'llm'
    ? value
    : DEFAULT_RELATION_SEMANTICS.invalidationPolicy;
}

// ─── LLM Conflict Detection ──────────────────────────────────

const CONFLICT_DETECTION_PROMPT = `You are a knowledge graph conflict resolver. Given a NEW fact and EXISTING facts between the same entities, determine if the new fact CONTRADICTS any existing fact or if they can COEXIST.

A contradiction means the new information REPLACES the old — they cannot both be true simultaneously. Examples:
- "Alice works at Acme" contradicts "Alice works at Beta Corp" (a person works at one company)
- "Pricing is $99/month" contradicts "Pricing is $149/month" (one current price)
- "Project uses React" contradicts "Project migrated to Vue" (current tech stack changed)
- "Q3 target is 10k users" contradicts "Q3 target revised to 15k users" (updated target)

Coexistence means both facts can be true at the same time. Examples:
- "Alice loves pizza" and "Alice loves burgers" (can love both)
- "Project has feature X" and "Project has feature Y" (can have both)
- "Company partners with A" and "Company partners with B" (can have multiple)

Return valid JSON: {"decisions": [{"action": "invalidate" | "coexist", "existing_fact_id": "id to invalidate or null"}]}

One decision per new fact, in order. Return ONLY the JSON.`;

interface ConflictCheckInput {
  fact: ExtractedFact;
  existing: { id: string; fact_text: string }[];
}

async function detectConflictsBatch(
  checks: ConflictCheckInput[],
  llmConfig?: LLMConfig,
): Promise<FactResolution[]> {
  // If no LLM available, fall back to conservative "just add" behavior
  if (!llmConfig && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return checks.map(c => ({ fact: c.fact, action: 'create' as const }));
  }

  // Build a single prompt with all conflict checks
  const lines = checks.map((c, i) => {
    const existingStr = c.existing.map(e => `  - [${e.id}] "${e.fact_text}"`).join('\n');
    return `Fact ${i + 1}:\n  NEW: "${c.fact.factText}" (${c.fact.relation})\n  EXISTING:\n${existingStr}`;
  });

  const userMessage = `Analyze these facts for contradictions:\n\n${lines.join('\n\n')}`;

  try {
    const response = await callLLMForConflicts(userMessage, llmConfig);
    const parsed = parseConflictResponse(response);

    return checks.map((c, i) => {
      const decision = parsed[i];
      if (decision?.action === 'invalidate' && decision.existing_fact_id) {
        // Verify the fact ID is actually one of the existing facts
        const validId = c.existing.find(e => e.id === decision.existing_fact_id);
        if (validId) {
          return {
            fact: c.fact,
            action: 'invalidate_existing' as const,
            existingFactId: decision.existing_fact_id,
            reason: 'llm_detected_contradiction',
          };
        }
      }
      // Default: coexist — add alongside existing
      return { fact: c.fact, action: 'create' as const };
    });
  } catch {
    // LLM failed — fall back to conservative "just add"
    return checks.map(c => ({ fact: c.fact, action: 'create' as const }));
  }
}

async function callLLMForConflicts(
  userMessage: string,
  config?: LLMConfig,
): Promise<string> {
  const provider = defaultLLMProvider(config);

  if (provider === 'anthropic') {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({
      apiKey: config?.apiKey || process.env.ANTHROPIC_API_KEY,
    });
    const response = await client.messages.create({
      model: defaultLLMModel('anthropic', config),
      max_tokens: anthropicMaxOutputTokens(config),
      system: CONFLICT_DETECTION_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    const content = response.content[0];
    return content.type === 'text' ? content.text : '';
  } else {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      apiKey: config?.apiKey || process.env.OPENAI_API_KEY,
    });
    const response = await client.chat.completions.create({
      model: defaultLLMModel('openai', config),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CONFLICT_DETECTION_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });
    return response.choices[0]?.message?.content || '';
  }
}

function parseConflictResponse(text: string): { action: string; existing_fact_id: string | null }[] {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const jsonStr = jsonMatch[1] || text;
    const parsed = JSON.parse(jsonStr.trim());
    return (parsed.decisions || []).map((d: any) => ({
      action: d.action || 'coexist',
      existing_fact_id: d.existing_fact_id || null,
    }));
  } catch {
    return [];
  }
}

// ─── Summary Rewrite ──────────────────────────────────────────

const MAX_SUMMARY_LENGTH = 2000;

/**
 * Update an entity's summary with new information.
 * Deduplicates against existing summary content and caps length
 * to prevent unbounded growth.
 */
export async function updateEntitySummary(
  db: postgres.Sql,
  entityId: string,
  newFacts: string[],
): Promise<void> {
  if (newFacts.length === 0) return;

  const entity = await db`SELECT summary FROM entities WHERE id = ${entityId}`;
  if (entity.length === 0) return;

  const currentSummary = entity[0].summary || '';
  const existingLines = new Set(
    currentSummary.split('\n').map((l: string) => l.toLowerCase().trim()).filter(Boolean),
  );

  // Only add facts not already present in the summary
  const dedupedFacts = newFacts.filter(
    f => !existingLines.has(f.toLowerCase().trim()),
  );
  if (dedupedFacts.length === 0) return;

  let updatedSummary = currentSummary
    ? `${currentSummary}\n${dedupedFacts.join('\n')}`
    : dedupedFacts.join('\n');

  // Cap summary length — keep the most recent lines
  if (updatedSummary.length > MAX_SUMMARY_LENGTH) {
    const lines = updatedSummary.split('\n');
    while (lines.length > 1 && lines.join('\n').length > MAX_SUMMARY_LENGTH) {
      lines.shift();
    }
    updatedSummary = lines.join('\n');
  }

  await db`
    UPDATE entities
    SET summary = ${updatedSummary}, updated_at = now()
    WHERE id = ${entityId}
  `;
}
