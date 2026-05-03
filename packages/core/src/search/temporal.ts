/**
 * Temporal Query Operators for the Company Brain knowledge graph.
 *
 * Enables time-aware queries:
 * - AS_OF:               "What was true as of March 15th?"
 * - CHANGED_SINCE:       "What changed since last month?"
 * - VALID_DURING:        "What facts were valid during Q1?"
 * - ENTITY_TIMELINE:     "Show me the full history of entity X"
 * - CONTRADICTIONS:      "What facts were recently invalidated?"
 */

import type postgres from 'postgres';
import type { AccessContext, SearchResult } from '../types.js';
import { visibilitySql } from '../security.js';

// ─── Options ──────────────────────────────────────────────────

export interface TemporalOptions {
  groupId: string;
  limit?: number;
  entityTypes?: string[];
  relations?: string[];
  access?: AccessContext;
}

// ─── Helpers ──────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;

/**
 * Map a joined fact row (with source/target entity names) to a SearchResult.
 */
function rowToSearchResult(
  row: Record<string, unknown>,
  extra?: Record<string, unknown>,
): SearchResult {
  return {
    type: 'fact',
    id: row.id as string,
    score: Number(row.confidence ?? 1),
    content: row.fact_text as string,
    relation: row.relation as string,
    validAt: row.valid_at as Date | undefined,
    invalidAt: (row.invalid_at as Date | null) ?? undefined,
    metadata: {
      sourceName: row.source_name as string,
      targetName: row.target_name as string,
      sourceEntityId: row.source_entity_id as string,
      targetEntityId: row.target_entity_id as string,
      confidence: Number(row.confidence ?? 1),
      evidence: row.evidence ?? {},
      extractor: row.extractor ?? 'unknown',
      grounding: {
        supported: true,
        confidence: Number(row.confidence ?? 1),
        quote: typeof (row.evidence as Record<string, unknown> | undefined)?.quote === 'string'
          ? (row.evidence as Record<string, unknown>).quote
          : undefined,
        instruction: 'Use this fact as support. Label interpretations beyond this text as inference.',
      },
      ...extra,
    },
  };
}

// ─── AS_OF ────────────────────────────────────────────────────

/**
 * What facts were true at a specific point in time?
 *
 * A fact is considered true at `timestamp` when:
 *   valid_at <= timestamp AND (invalid_at IS NULL OR invalid_at > timestamp)
 */
export async function asOf(
  db: postgres.Sql,
  timestamp: Date,
  options: TemporalOptions,
): Promise<SearchResult[]> {
  const { groupId, limit = DEFAULT_LIMIT, entityTypes, relations, access } = options;

  const rows = await db`
    SELECT
      f.id,
      f.fact_text,
      f.relation,
      f.valid_at,
      f.invalid_at,
      f.confidence,
      f.evidence,
      f.extractor,
      f.source_entity_id,
      f.target_entity_id,
      se.name  AS source_name,
      te.name  AS target_name
    FROM facts f
    JOIN entities se ON se.id = f.source_entity_id
    JOIN entities te ON te.id = f.target_entity_id
    WHERE f.group_id = ${groupId}
      AND f.valid_at <= ${timestamp}
      AND (f.invalid_at IS NULL OR f.invalid_at > ${timestamp})
      ${visibilitySql(db, db`f.visibility`, access)}
      ${visibilitySql(db, db`se.visibility`, access)}
      ${visibilitySql(db, db`te.visibility`, access)}
      ${entityTypes && entityTypes.length > 0
        ? db`AND (se.entity_type = ANY(${entityTypes}) OR te.entity_type = ANY(${entityTypes}))`
        : db``}
      ${relations && relations.length > 0
        ? db`AND f.relation = ANY(${relations})`
        : db``}
    ORDER BY f.valid_at DESC
    LIMIT ${limit}
  `;

  return rows.map(row => rowToSearchResult(row, { asOf: timestamp }));
}

// ─── CHANGED_SINCE ───────────────────────────────────────────

/**
 * What facts were created, invalidated, or updated since a timestamp?
 *
 * Returns a union of:
 *   1. Facts created since `since`  (changeType = 'created')
 *   2. Facts invalidated since `since` (changeType = 'invalidated')
 */
export async function changedSince(
  db: postgres.Sql,
  since: Date,
  options: TemporalOptions,
): Promise<SearchResult[]> {
  const { groupId, limit = DEFAULT_LIMIT, entityTypes, relations, access } = options;

  const entityTypeFilter = entityTypes && entityTypes.length > 0
    ? db`AND (se.entity_type = ANY(${entityTypes}) OR te.entity_type = ANY(${entityTypes}))`
    : db``;

  const relationFilter = relations && relations.length > 0
    ? db`AND f.relation = ANY(${relations})`
    : db``;

  // New facts created since the timestamp
  const created = await db`
    SELECT
      f.id,
      f.fact_text,
      f.relation,
      f.valid_at,
      f.invalid_at,
      f.confidence,
      f.evidence,
      f.extractor,
      f.source_entity_id,
      f.target_entity_id,
      f.created_at,
      se.name  AS source_name,
      te.name  AS target_name,
      'created' AS change_type
    FROM facts f
    JOIN entities se ON se.id = f.source_entity_id
    JOIN entities te ON te.id = f.target_entity_id
    WHERE f.group_id = ${groupId}
      AND f.created_at >= ${since}
      ${visibilitySql(db, db`f.visibility`, access)}
      ${visibilitySql(db, db`se.visibility`, access)}
      ${visibilitySql(db, db`te.visibility`, access)}
      ${entityTypeFilter}
      ${relationFilter}
    ORDER BY f.created_at DESC
    LIMIT ${limit}
  `;

  // Facts invalidated since the timestamp
  const invalidated = await db`
    SELECT
      f.id,
      f.fact_text,
      f.relation,
      f.valid_at,
      f.invalid_at,
      f.confidence,
      f.evidence,
      f.extractor,
      f.source_entity_id,
      f.target_entity_id,
      f.created_at,
      se.name  AS source_name,
      te.name  AS target_name,
      'invalidated' AS change_type
    FROM facts f
    JOIN entities se ON se.id = f.source_entity_id
    JOIN entities te ON te.id = f.target_entity_id
    WHERE f.group_id = ${groupId}
      AND f.invalid_at IS NOT NULL
      AND f.invalid_at >= ${since}
      ${visibilitySql(db, db`f.visibility`, access)}
      ${visibilitySql(db, db`se.visibility`, access)}
      ${visibilitySql(db, db`te.visibility`, access)}
      ${entityTypeFilter}
      ${relationFilter}
    ORDER BY f.invalid_at DESC
    LIMIT ${limit}
  `;

  // Merge, deduplicate (a fact created AND invalidated since `since` appears
  // once with changeType 'created' taking priority), then sort by recency.
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const row of created) {
    seen.add(row.id as string);
    results.push(
      rowToSearchResult(row, {
        changeType: 'created',
        changedAt: row.created_at as Date,
      }),
    );
  }

  for (const row of invalidated) {
    if (seen.has(row.id as string)) continue;
    results.push(
      rowToSearchResult(row, {
        changeType: 'invalidated',
        changedAt: row.invalid_at as Date,
      }),
    );
  }

  // Sort by the most recent change timestamp
  results.sort((a, b) => {
    const aTime = (a.metadata.changedAt as Date).getTime();
    const bTime = (b.metadata.changedAt as Date).getTime();
    return bTime - aTime;
  });

  return results.slice(0, limit);
}

// ─── VALID_DURING ─────────────────────────────────────────────

/**
 * What facts were true during a time range [start, end]?
 *
 * A fact overlaps the range when:
 *   valid_at <= end AND (invalid_at IS NULL OR invalid_at >= start)
 */
export async function validDuring(
  db: postgres.Sql,
  start: Date,
  end: Date,
  options: TemporalOptions,
): Promise<SearchResult[]> {
  const { groupId, limit = DEFAULT_LIMIT, entityTypes, relations, access } = options;

  const rows = await db`
    SELECT
      f.id,
      f.fact_text,
      f.relation,
      f.valid_at,
      f.invalid_at,
      f.confidence,
      f.evidence,
      f.extractor,
      f.source_entity_id,
      f.target_entity_id,
      se.name  AS source_name,
      te.name  AS target_name
    FROM facts f
    JOIN entities se ON se.id = f.source_entity_id
    JOIN entities te ON te.id = f.target_entity_id
    WHERE f.group_id = ${groupId}
      AND f.valid_at <= ${end}
      AND (f.invalid_at IS NULL OR f.invalid_at >= ${start})
      ${visibilitySql(db, db`f.visibility`, access)}
      ${visibilitySql(db, db`se.visibility`, access)}
      ${visibilitySql(db, db`te.visibility`, access)}
      ${entityTypes && entityTypes.length > 0
        ? db`AND (se.entity_type = ANY(${entityTypes}) OR te.entity_type = ANY(${entityTypes}))`
        : db``}
      ${relations && relations.length > 0
        ? db`AND f.relation = ANY(${relations})`
        : db``}
    ORDER BY f.valid_at DESC
    LIMIT ${limit}
  `;

  return rows.map(row =>
    rowToSearchResult(row, {
      queryRange: { start, end },
    }),
  );
}

// ─── ENTITY_TIMELINE ──────────────────────────────────────────

/**
 * Get the full timeline of changes for a specific entity.
 *
 * Returns all facts (including invalidated/superseded ones) where the entity
 * appears as either source or target, sorted chronologically by valid_at.
 */
export async function entityTimeline(
  db: postgres.Sql,
  entityId: string,
  options?: { limit?: number; since?: Date; until?: Date; access?: AccessContext },
): Promise<SearchResult[]> {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const since = options?.since;
  const until = options?.until;
  const access = options?.access;

  const rows = await db`
    SELECT
      f.id,
      f.fact_text,
      f.relation,
      f.valid_at,
      f.invalid_at,
      f.confidence,
      f.evidence,
      f.extractor,
      f.source_entity_id,
      f.target_entity_id,
      se.name  AS source_name,
      te.name  AS target_name
    FROM facts f
    JOIN entities se ON se.id = f.source_entity_id
    JOIN entities te ON te.id = f.target_entity_id
    WHERE (f.source_entity_id = ${entityId} OR f.target_entity_id = ${entityId})
      ${since ? db`AND f.valid_at >= ${since}` : db``}
      ${until ? db`AND f.valid_at <= ${until}` : db``}
      ${visibilitySql(db, db`f.visibility`, access)}
      ${visibilitySql(db, db`se.visibility`, access)}
      ${visibilitySql(db, db`te.visibility`, access)}
    ORDER BY f.valid_at ASC
    LIMIT ${limit}
  `;

  return rows.map(row =>
    rowToSearchResult(row, {
      status: row.invalid_at != null ? 'superseded' : 'current',
      entityId,
    }),
  );
}

// ─── RECENT CONTRADICTIONS ────────────────────────────────────

/**
 * Find facts that were recently invalidated (contradictions detected).
 *
 * For each invalidated fact, looks for a replacement: a newer fact with the
 * same source entity, target entity, and relation. Returns pairs of
 * { oldFact, newFact, invalidatedAt }.
 */
export async function recentContradictions(
  db: postgres.Sql,
  options: TemporalOptions & { since?: Date },
): Promise<Array<{
  oldFact: SearchResult;
  newFact: SearchResult;
  invalidatedAt: Date;
}>> {
  const { groupId, limit = DEFAULT_LIMIT, entityTypes, relations, since, access } = options;

  const rows = await db`
    SELECT
      old_f.id             AS old_id,
      old_f.fact_text       AS old_fact_text,
      old_f.relation        AS old_relation,
      old_f.valid_at        AS old_valid_at,
      old_f.invalid_at      AS old_invalid_at,
      old_f.confidence      AS old_confidence,
      old_f.source_entity_id AS old_source_entity_id,
      old_f.target_entity_id AS old_target_entity_id,

      new_f.id             AS new_id,
      new_f.fact_text       AS new_fact_text,
      new_f.relation        AS new_relation,
      new_f.valid_at        AS new_valid_at,
      new_f.invalid_at      AS new_invalid_at,
      new_f.confidence      AS new_confidence,
      new_f.source_entity_id AS new_source_entity_id,
      new_f.target_entity_id AS new_target_entity_id,

      se.name              AS source_name,
      te.name              AS target_name
    FROM facts old_f
    JOIN facts new_f
      ON  new_f.source_entity_id = old_f.source_entity_id
      AND new_f.target_entity_id = old_f.target_entity_id
      AND new_f.relation         = old_f.relation
      AND new_f.id              != old_f.id
      AND new_f.valid_at        >= old_f.valid_at
    JOIN entities se ON se.id = old_f.source_entity_id
    JOIN entities te ON te.id = old_f.target_entity_id
    WHERE old_f.group_id = ${groupId}
      AND old_f.invalid_at IS NOT NULL
      ${since ? db`AND old_f.invalid_at >= ${since}` : db``}
      ${visibilitySql(db, db`old_f.visibility`, access)}
      ${visibilitySql(db, db`new_f.visibility`, access)}
      ${visibilitySql(db, db`se.visibility`, access)}
      ${visibilitySql(db, db`te.visibility`, access)}
      ${entityTypes && entityTypes.length > 0
        ? db`AND (se.entity_type = ANY(${entityTypes}) OR te.entity_type = ANY(${entityTypes}))`
        : db``}
      ${relations && relations.length > 0
        ? db`AND old_f.relation = ANY(${relations})`
        : db``}
    ORDER BY old_f.invalid_at DESC
    LIMIT ${limit}
  `;

  return rows.map(row => ({
    oldFact: {
      type: 'fact' as const,
      id: row.old_id as string,
      score: Number(row.old_confidence ?? 1),
      content: row.old_fact_text as string,
      relation: row.old_relation as string,
      validAt: row.old_valid_at as Date,
      invalidAt: (row.old_invalid_at as Date | null) ?? undefined,
      metadata: {
        sourceName: row.source_name as string,
        targetName: row.target_name as string,
        sourceEntityId: row.old_source_entity_id as string,
        targetEntityId: row.old_target_entity_id as string,
        confidence: Number(row.old_confidence ?? 1),
        status: 'superseded',
      },
    },
    newFact: {
      type: 'fact' as const,
      id: row.new_id as string,
      score: Number(row.new_confidence ?? 1),
      content: row.new_fact_text as string,
      relation: row.new_relation as string,
      validAt: row.new_valid_at as Date,
      invalidAt: (row.new_invalid_at as Date | null) ?? undefined,
      metadata: {
        sourceName: row.source_name as string,
        targetName: row.target_name as string,
        sourceEntityId: row.new_source_entity_id as string,
        targetEntityId: row.new_target_entity_id as string,
        confidence: Number(row.new_confidence ?? 1),
        status: 'current',
      },
    },
    invalidatedAt: row.old_invalid_at as Date,
  }));
}
