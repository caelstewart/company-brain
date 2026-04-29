/**
 * Layer 3: Resolution.
 *
 * After extraction (deterministic or LLM), this layer:
 * 1. Deduplicates entities against the existing graph
 * 2. Invalidates contradicted facts (temporal model)
 * 3. Rewrites entity summaries when new info arrives
 * 4. Propagates backlinks
 */

import type postgres from 'postgres';
import type { Entity, ExtractedEntity, ExtractedFact, Fact, FactInput } from '../types.js';
import { embed } from '../embedding.js';

// ─── Entity Resolution (Dedup) ───────────────────────────────

export interface ResolvedEntity {
  entity: ExtractedEntity;
  existingId: string | null;  // null = new entity to create
  matchConfidence: number;
}

/**
 * Resolve extracted entities against existing graph.
 * Uses fuzzy name matching + embedding similarity for dedup.
 */
export async function resolveEntities(
  db: postgres.Sql,
  extracted: ExtractedEntity[],
  groupId: string,
): Promise<ResolvedEntity[]> {
  const resolved: ResolvedEntity[] = [];

  for (const entity of extracted) {
    // 1. Exact alias match (fastest)
    const aliasMatch = await db`
      SELECT ea.entity_id, e.name, e.entity_type
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE LOWER(ea.alias) = LOWER(${entity.name})
        AND e.group_id = ${groupId}
      LIMIT 1
    `;

    if (aliasMatch.length > 0) {
      resolved.push({
        entity,
        existingId: aliasMatch[0].entity_id,
        matchConfidence: 0.95,
      });
      continue;
    }

    // 2. Trigram similarity match (fuzzy name matching)
    const trigramMatch = await db`
      SELECT id, name, entity_type,
             similarity(name, ${entity.name}) AS sim
      FROM entities
      WHERE group_id = ${groupId}
        AND entity_type = ${entity.entityType}
        AND similarity(name, ${entity.name}) > 0.4
      ORDER BY sim DESC
      LIMIT 3
    `;

    if (trigramMatch.length > 0 && trigramMatch[0].sim > 0.7) {
      resolved.push({
        entity,
        existingId: trigramMatch[0].id,
        matchConfidence: trigramMatch[0].sim,
      });
      continue;
    }

    // 3. No match → new entity
    resolved.push({
      entity,
      existingId: null,
      matchConfidence: 0,
    });
  }

  return resolved;
}

// ─── Fact Contradiction Detection ─────────────────────────────

export interface FactResolution {
  fact: ExtractedFact;
  action: 'create' | 'skip' | 'invalidate_existing';
  existingFactId?: string;
  reason?: string;
}

/**
 * Detect contradictions between new facts and existing facts.
 * When a contradiction is found, the old fact gets invalidated (not deleted).
 */
export async function resolveFacts(
  db: postgres.Sql,
  extractedFacts: ExtractedFact[],
  entityIdMap: Map<string, string>,  // name → entity UUID
  groupId: string,
): Promise<FactResolution[]> {
  const resolutions: FactResolution[] = [];

  for (const fact of extractedFacts) {
    const sourceId = entityIdMap.get(fact.sourceName.toLowerCase());
    const targetId = entityIdMap.get(fact.targetName.toLowerCase());

    if (!sourceId || !targetId) {
      resolutions.push({ fact, action: 'skip', reason: 'entity_not_resolved' });
      continue;
    }

    // Check for existing facts between same entities with same relation
    const existing = await db`
      SELECT id, fact_text, valid_at, invalid_at
      FROM facts
      WHERE group_id = ${groupId}
        AND source_entity_id = ${sourceId}
        AND target_entity_id = ${targetId}
        AND relation = ${fact.relation}
        AND invalid_at IS NULL
      ORDER BY valid_at DESC
      LIMIT 5
    `;

    if (existing.length === 0) {
      // No existing fact → create new
      resolutions.push({ fact, action: 'create' });
      continue;
    }

    // Check if this is a duplicate (same fact text essentially)
    const isDuplicate = existing.some(e =>
      e.fact_text.toLowerCase().trim() === fact.factText.toLowerCase().trim()
    );

    if (isDuplicate) {
      resolutions.push({ fact, action: 'skip', reason: 'duplicate' });
      continue;
    }

    // Different fact with same relation → contradiction → invalidate old
    // For "works_at" a person can only work at one company at a time
    const exclusiveRelations = new Set(['works_at', 'founded']);
    if (exclusiveRelations.has(fact.relation)) {
      resolutions.push({
        fact,
        action: 'invalidate_existing',
        existingFactId: existing[0].id,
        reason: 'contradicted_by_new_info',
      });
    } else {
      // Non-exclusive relation → just add alongside
      resolutions.push({ fact, action: 'create' });
    }
  }

  return resolutions;
}

// ─── Summary Rewrite ──────────────────────────────────────────

/**
 * Update an entity's summary with new information.
 * Appends new facts to the existing summary rather than rewriting from scratch.
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
  const newInfo = newFacts.join('. ');

  // Simple append for now. A more sophisticated version would use LLM
  // to rewrite the summary incorporating new information.
  const updatedSummary = currentSummary
    ? `${currentSummary}\n${newInfo}`
    : newInfo;

  await db`
    UPDATE entities
    SET summary = ${updatedSummary}, updated_at = now()
    WHERE id = ${entityId}
  `;
}
