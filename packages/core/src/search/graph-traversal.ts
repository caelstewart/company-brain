/**
 * Multi-hop Graph Traversal Search.
 *
 * Walks the Company Brain knowledge graph using recursive CTEs in
 * PostgreSQL, starting from seed entities found via embedding similarity,
 * trigram matching, and full-text search (in that priority order).
 * Each hop decays the score by 0.9, so closer facts rank higher.
 */

import type postgres from 'postgres';
import type { SearchResult, EmbeddingConfig, AccessContext } from '../types.js';
import { embed } from '../embedding.js';
import { normalizeVisibility, visibilitySql } from '../security.js';

// ─── Options ──────────────────────────────────────────────────

export interface TraversalOptions {
  groupId: string;
  /** Maximum number of hops to traverse from seed entities (default 3). */
  maxHops?: number;
  /** Maximum number of results to return (default 50). */
  limit?: number;
  /** Point-in-time filter for temporal validity. */
  asOf?: Date;
  /** Only traverse edges with these relation types. */
  relations?: string[];
  /** Minimum fact confidence to include (default 0). */
  minConfidence?: number;
  /** Embedding config for semantic seed discovery. */
  embeddingConfig?: EmbeddingConfig;
  /** Optional access context used to enforce row-level visibility. */
  access?: AccessContext;
}

// ─── Seed Entity Discovery ────────────────────────────────────

/**
 * Find seed entities from query text.
 *
 * Uses a multi-signal approach inspired by SOTA graph RAG systems:
 *
 * 1. **Embedding similarity** (primary, like HippoRAG/GraphRAG):
 *    Embed the query and cosine-match against entity name_embeddings.
 *    Catches semantic matches (e.g. "CTO" → "Chief Technology Officer").
 *
 * 2. **Trigram similarity** (supplementary):
 *    pg_trgm matching on entity names + aliases for character-level fuzzy match.
 *
 * 3. **Full-text keyword search** (fallback):
 *    FTS with OR semantics on entity name + summary.
 *
 * Results from all strategies are merged, deduplicated by entity ID,
 * keeping the highest score per entity.
 */
export async function findSeedEntities(
  db: postgres.Sql,
  query: string,
  groupId: string,
  limit: number = 10,
  embeddingConfig?: EmbeddingConfig,
  access?: AccessContext,
): Promise<Array<{ id: string; name: string; score: number }>> {
  const seen = new Map<string, { id: string; name: string; score: number }>();

  function addResult(id: string, name: string, score: number) {
    if (!seen.has(id) || seen.get(id)!.score < score) {
      seen.set(id, { id, name, score });
    }
  }

  // Run all strategies in parallel for speed
  const strategies: Promise<void>[] = [];

  // Strategy 1: Embedding similarity (best for semantic matching)
  strategies.push((async () => {
    try {
      const queryEmbedding = await embed(query, embeddingConfig);
      const embeddingStr = `[${queryEmbedding.join(',')}]`;
      const rows = await db`
        SELECT id, name,
               1 - (name_embedding <=> ${embeddingStr}::vector) AS similarity
        FROM entities
        WHERE group_id = ${groupId}
          AND name_embedding IS NOT NULL
          ${visibilitySql(db, db`visibility`, access)}
        ORDER BY name_embedding <=> ${embeddingStr}::vector
        LIMIT ${limit}
      `;
      for (const r of rows) {
        const sim = Number(r.similarity);
        if (sim > 0.3) {
          addResult(r.id as string, r.name as string, sim);
        }
      }
    } catch {
      // Embedding not available — skip this strategy
    }
  })());

  // Strategy 2: Trigram similarity on entity names + aliases
  // Match the full query AND individual words to catch both exact and partial matches
  strategies.push((async () => {
    const rows = await db`
      SELECT DISTINCT ON (e.id)
        e.id,
        e.name,
        GREATEST(
          similarity(e.name, ${query}),
          COALESCE((
            SELECT MAX(similarity(ea.alias, ${query}))
            FROM entity_aliases ea
            WHERE ea.entity_id = e.id
          ), 0)
        ) AS score
      FROM entities e
      WHERE e.group_id = ${groupId}
        ${visibilitySql(db, db`e.visibility`, access)}
        AND (
          similarity(e.name, ${query}) > 0.2
          OR EXISTS (
            SELECT 1 FROM entity_aliases ea
            WHERE ea.entity_id = e.id
              AND similarity(ea.alias, ${query}) > 0.2
          )
        )
      ORDER BY e.id, score DESC
      LIMIT ${limit}
    `;
    for (const r of rows) {
      addResult(r.id as string, r.name as string, Number(r.score) * 0.9);
    }
  })());

  // Strategy 3: Full-text search with OR semantics on name+summary
  strategies.push((async () => {
    const contentWords = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    if (contentWords.length === 0) return;

    const tsQuery = contentWords.join(' | ');
    const rows = await db`
      SELECT
        id,
        name,
        ts_rank(to_tsvector('english', name || ' ' || summary), to_tsquery('english', ${tsQuery})) AS score
      FROM entities
      WHERE group_id = ${groupId}
        AND to_tsvector('english', name || ' ' || summary) @@ to_tsquery('english', ${tsQuery})
        ${visibilitySql(db, db`visibility`, access)}
      ORDER BY score DESC
      LIMIT ${limit}
    `;
    for (const r of rows) {
      addResult(r.id as string, r.name as string, Number(r.score) * 0.5);
    }
  })());

  await Promise.all(strategies);

  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── Multi-hop BFS Traversal ──────────────────────────────────

/**
 * Perform a multi-hop BFS traversal from the given seed entity IDs.
 *
 * Uses a recursive CTE to walk entity -> fact -> entity edges up to
 * `maxHops` levels deep.  Scores decay exponentially per hop
 * (`confidence * 0.9 ^ hop`).  Facts are deduplicated by ID, keeping
 * the shortest-path (lowest-hop) occurrence.
 */
export async function traverseGraph(
  db: postgres.Sql,
  seedIds: string[],
  options: TraversalOptions,
): Promise<SearchResult[]> {
  if (seedIds.length === 0) return [];

  const {
    groupId,
    maxHops = 3,
    limit = 50,
    asOf,
    relations,
    minConfidence = 0,
    access,
  } = options;

  // Build temporal clause
  const temporalClause = asOf
    ? db`AND f.valid_at <= ${asOf} AND (f.invalid_at IS NULL OR f.invalid_at > ${asOf})`
    : db`AND f.invalid_at IS NULL`;

  // Build relation filter clause
  const relationClause =
    relations && relations.length > 0
      ? db`AND f.relation = ANY(${relations})`
      : db``;

  // Build confidence clause
  const confidenceClause =
    minConfidence > 0
      ? db`AND f.confidence >= ${minConfidence}`
      : db``;

  const rows = await db`
    WITH RECURSIVE traversal AS (
      -- Base case: facts directly connected to seed entities (hop 1)
      SELECT
        f.id              AS fact_id,
        f.fact_text,
        f.relation,
        f.valid_at,
        f.invalid_at,
        f.confidence,
        f.evidence,
        f.extractor,
        f.source_entity_id,
        f.target_entity_id,
        CASE
          WHEN f.source_entity_id = ANY(${seedIds}::uuid[]) THEN f.target_entity_id
          ELSE f.source_entity_id
        END AS next_entity_id,
        1 AS hop
      FROM facts f
      WHERE f.group_id = ${groupId}
        AND (
          f.source_entity_id = ANY(${seedIds}::uuid[])
          OR f.target_entity_id = ANY(${seedIds}::uuid[])
        )
        ${temporalClause}
        ${relationClause}
        ${confidenceClause}
        ${visibilitySql(db, db`f.visibility`, access)}

      UNION ALL

      -- Recursive case: follow edges from discovered entities
      SELECT
        f.id              AS fact_id,
        f.fact_text,
        f.relation,
        f.valid_at,
        f.invalid_at,
        f.confidence,
        f.evidence,
        f.extractor,
        f.source_entity_id,
        f.target_entity_id,
        CASE
          WHEN f.source_entity_id = t.next_entity_id THEN f.target_entity_id
          ELSE f.source_entity_id
        END AS next_entity_id,
        t.hop + 1 AS hop
      FROM traversal t
      JOIN facts f ON (
        f.source_entity_id = t.next_entity_id
        OR f.target_entity_id = t.next_entity_id
      )
      WHERE f.group_id = ${groupId}
        AND f.id != t.fact_id
        AND t.hop < ${maxHops}
        ${temporalClause}
        ${relationClause}
        ${confidenceClause}
        ${visibilitySql(db, db`f.visibility`, access)}
    ),

    -- Deduplicate facts by keeping shortest hop
    ranked AS (
      SELECT DISTINCT ON (fact_id)
        fact_id,
        fact_text,
        relation,
        valid_at,
        invalid_at,
        confidence,
        evidence,
        extractor,
        source_entity_id,
        target_entity_id,
        hop,
        confidence * POWER(0.9, hop) AS score
      FROM traversal
      ORDER BY fact_id, hop ASC
    )

    SELECT
      r.fact_id,
      r.fact_text,
      r.relation,
      r.valid_at,
      r.invalid_at,
      r.confidence,
      r.evidence,
      r.extractor,
      r.hop,
      r.score,
      se.id   AS source_id,
      se.name AS source_name,
      se.entity_type AS source_type,
      se.summary AS source_summary,
      se.attributes AS source_attributes,
      se.visibility AS source_visibility,
      se.created_at AS source_created_at,
      se.updated_at AS source_updated_at,
      te.id   AS target_id,
      te.name AS target_name,
      te.entity_type AS target_type,
      te.summary AS target_summary,
      te.attributes AS target_attributes,
      te.visibility AS target_visibility,
      te.created_at AS target_created_at,
      te.updated_at AS target_updated_at
    FROM ranked r
    JOIN entities se ON se.id = r.source_entity_id
    JOIN entities te ON te.id = r.target_entity_id
    WHERE true
      ${visibilitySql(db, db`se.visibility`, access)}
      ${visibilitySql(db, db`te.visibility`, access)}
    ORDER BY r.score DESC
    LIMIT ${limit}
  `;

  return rows.map(row => ({
    type: 'fact' as const,
    id: row.fact_id as string,
    score: Number(row.score),
    content: row.fact_text as string,
    metadata: {
      graphHop: Number(row.hop),
      sourceName: row.source_name as string,
      targetName: row.target_name as string,
      confidence: Number(row.confidence),
      evidence: row.evidence ?? {},
      extractor: row.extractor ?? 'unknown',
      grounding: {
        supported: true,
        confidence: Number(row.confidence),
        quote: typeof row.evidence?.quote === 'string' ? row.evidence.quote : undefined,
        instruction: 'Use this fact as support. Label interpretations beyond this text as inference.',
      },
    },
    sourceEntity: {
      id: row.source_id as string,
      groupId,
      entityType: row.source_type as string,
      name: row.source_name as string,
      summary: (row.source_summary ?? '') as string,
      attributes: (row.source_attributes ?? {}) as Record<string, unknown>,
      visibility: normalizeVisibility(row.source_visibility),
      createdAt: row.source_created_at as Date,
      updatedAt: row.source_updated_at as Date,
    },
    targetEntity: {
      id: row.target_id as string,
      groupId,
      entityType: row.target_type as string,
      name: row.target_name as string,
      summary: (row.target_summary ?? '') as string,
      attributes: (row.target_attributes ?? {}) as Record<string, unknown>,
      visibility: normalizeVisibility(row.target_visibility),
      createdAt: row.target_created_at as Date,
      updatedAt: row.target_updated_at as Date,
    },
    relation: row.relation as string,
    validAt: row.valid_at as Date,
    invalidAt: (row.invalid_at as Date | null) ?? undefined,
  }));
}

// ─── Convenience: Seeds + Traversal ───────────────────────────

/**
 * Find seed entities matching the query, then traverse the graph from
 * those seeds.  A single-call convenience wrapper around
 * `findSeedEntities` + `traverseGraph`.
 */
export async function graphTraversalSearch(
  db: postgres.Sql,
  query: string,
  options: TraversalOptions,
): Promise<SearchResult[]> {
  const seeds = await findSeedEntities(db, query, options.groupId, 10, options.embeddingConfig, options.access);

  if (seeds.length === 0) return [];

  const seedIds = seeds.map(s => s.id);
  return traverseGraph(db, seedIds, options);
}
