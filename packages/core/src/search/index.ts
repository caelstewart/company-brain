/**
 * Hybrid Search Engine.
 *
 * Combines four retrieval methods:
 * 1. Semantic (vector cosine similarity via pgvector)
 * 2. Keyword (tsvector full-text search)
 * 3. Graph (BFS traversal from entity nodes)
 * 4. Temporal (filter by valid_at/invalid_at windows)
 *
 * Results are fused via Reciprocal Rank Fusion (RRF) with additional
 * boosts for graph distance, recency, and confidence.
 */

import type postgres from 'postgres';
import type { SearchOptions, SearchResult, SearchMethod, EmbeddingConfig } from '../types.js';
import { embed } from '../embedding.js';

const RRF_K = 60;

// ─── Main Search ──────────────────────────────────────────────

export async function search(
  db: postgres.Sql,
  options: SearchOptions,
  embeddingConfig?: EmbeddingConfig,
): Promise<SearchResult[]> {
  const {
    query,
    groupId = 'default',
    limit = 20,
    offset = 0,
    asOf,
    entityTypes,
    relations,
    methods = ['semantic', 'keyword', 'graph'],
    minConfidence = 0,
  } = options;

  const resultLists: SearchResult[][] = [];

  // Run enabled search methods in parallel
  const searches: Promise<SearchResult[]>[] = [];

  if (methods.includes('keyword')) {
    searches.push(keywordSearch(db, query, groupId, limit * 2, asOf, entityTypes, relations));
  }

  if (methods.includes('semantic')) {
    searches.push(semanticSearch(db, query, groupId, limit * 2, asOf, embeddingConfig));
  }

  if (methods.includes('graph')) {
    searches.push(graphSearch(db, query, groupId, limit * 2, asOf));
  }

  const results = await Promise.all(searches);
  resultLists.push(...results);

  // Fuse results via RRF
  let fused = rrfFusion(resultLists);

  // Apply temporal filter
  if (asOf) {
    fused = fused.filter(r => {
      if (r.validAt && r.validAt > asOf) return false;
      if (r.invalidAt && r.invalidAt <= asOf) return false;
      return true;
    });
  }

  // Apply confidence filter
  if (minConfidence > 0) {
    fused = fused.filter(r => r.score >= minConfidence);
  }

  // Apply recency boost (more recent facts score higher)
  applyRecencyBoost(fused);

  // Sort by final score and paginate
  fused.sort((a, b) => b.score - a.score);
  return fused.slice(offset, offset + limit);
}

// ─── Keyword Search (tsvector) ────────────────────────────────

async function keywordSearch(
  db: postgres.Sql,
  query: string,
  groupId: string,
  limit: number,
  asOf?: Date,
  entityTypes?: string[],
  relations?: string[],
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  // Search entities
  const entityResults = await db`
    SELECT id, name, entity_type, summary, attributes, created_at, updated_at,
           ts_rank(to_tsvector('english', name || ' ' || summary), websearch_to_tsquery('english', ${query})) AS rank
    FROM entities
    WHERE group_id = ${groupId}
      AND to_tsvector('english', name || ' ' || summary) @@ websearch_to_tsquery('english', ${query})
      ${entityTypes && entityTypes.length > 0 ? db`AND entity_type = ANY(${entityTypes})` : db``}
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  for (const row of entityResults) {
    results.push({
      type: 'entity',
      id: row.id,
      score: Number(row.rank),
      content: `${row.name}: ${row.summary}`,
      metadata: { entityType: row.entity_type, attributes: row.attributes },
    });
  }

  // Search facts
  const temporalFilter = asOf
    ? db`AND valid_at <= ${asOf} AND (invalid_at IS NULL OR invalid_at > ${asOf})`
    : db`AND invalid_at IS NULL`;

  const factResults = await db`
    SELECT f.id, f.fact_text, f.relation, f.valid_at, f.invalid_at, f.confidence,
           f.source_entity_id, f.target_entity_id,
           ts_rank(f.fact_tsv, websearch_to_tsquery('english', ${query})) AS rank
    FROM facts f
    WHERE f.group_id = ${groupId}
      AND f.fact_tsv @@ websearch_to_tsquery('english', ${query})
      ${temporalFilter}
      ${relations && relations.length > 0 ? db`AND f.relation = ANY(${relations})` : db``}
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  for (const row of factResults) {
    results.push({
      type: 'fact',
      id: row.id,
      score: Number(row.rank) * Number(row.confidence),
      content: row.fact_text,
      metadata: { confidence: row.confidence },
      relation: row.relation,
      validAt: row.valid_at,
      invalidAt: row.invalid_at,
    });
  }

  return results;
}

// ─── Semantic Search (vector cosine) ──────────────────────────

async function semanticSearch(
  db: postgres.Sql,
  query: string,
  groupId: string,
  limit: number,
  asOf?: Date,
  embeddingConfig?: EmbeddingConfig,
): Promise<SearchResult[]> {
  const queryEmbedding = await embed(query, embeddingConfig);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;
  const results: SearchResult[] = [];

  // Search entity name embeddings
  const entityResults = await db`
    SELECT id, name, entity_type, summary, attributes,
           1 - (name_embedding <=> ${embeddingStr}::vector) AS similarity
    FROM entities
    WHERE group_id = ${groupId}
      AND name_embedding IS NOT NULL
    ORDER BY name_embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `;

  for (const row of entityResults) {
    if (Number(row.similarity) > 0.3) {
      results.push({
        type: 'entity',
        id: row.id,
        score: Number(row.similarity),
        content: `${row.name}: ${row.summary}`,
        metadata: { entityType: row.entity_type, attributes: row.attributes },
      });
    }
  }

  // Search fact embeddings
  const temporalFilter = asOf
    ? db`AND valid_at <= ${asOf} AND (invalid_at IS NULL OR invalid_at > ${asOf})`
    : db`AND invalid_at IS NULL`;

  const factResults = await db`
    SELECT id, fact_text, relation, valid_at, invalid_at, confidence,
           source_entity_id, target_entity_id,
           1 - (fact_embedding <=> ${embeddingStr}::vector) AS similarity
    FROM facts
    WHERE group_id = ${groupId}
      AND fact_embedding IS NOT NULL
      ${temporalFilter}
    ORDER BY fact_embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `;

  for (const row of factResults) {
    if (Number(row.similarity) > 0.3) {
      results.push({
        type: 'fact',
        id: row.id,
        score: Number(row.similarity) * Number(row.confidence),
        content: row.fact_text,
        metadata: { confidence: row.confidence },
        relation: row.relation,
        validAt: row.valid_at,
        invalidAt: row.invalid_at,
      });
    }
  }

  return results;
}

// ─── Graph Search (BFS from mentioned entities) ───────────────

async function graphSearch(
  db: postgres.Sql,
  query: string,
  groupId: string,
  limit: number,
  asOf?: Date,
): Promise<SearchResult[]> {
  // First find entities mentioned in the query
  const seedEntities = await db`
    SELECT id, name FROM entities
    WHERE group_id = ${groupId}
      AND (
        similarity(name, ${query}) > 0.3
        OR to_tsvector('english', name) @@ websearch_to_tsquery('english', ${query})
      )
    ORDER BY similarity(name, ${query}) DESC
    LIMIT 5
  `;

  if (seedEntities.length === 0) return [];

  const seedIds = seedEntities.map(e => e.id);
  const results: SearchResult[] = [];

  // BFS: find facts connected to seed entities (1-2 hops)
  const temporalFilter = asOf
    ? db`AND f.valid_at <= ${asOf} AND (f.invalid_at IS NULL OR f.invalid_at > ${asOf})`
    : db`AND f.invalid_at IS NULL`;

  // Hop 1: direct connections
  const hop1 = await db`
    SELECT f.id, f.fact_text, f.relation, f.valid_at, f.invalid_at, f.confidence,
           f.source_entity_id, f.target_entity_id,
           se.name AS source_name, te.name AS target_name
    FROM facts f
    JOIN entities se ON se.id = f.source_entity_id
    JOIN entities te ON te.id = f.target_entity_id
    WHERE f.group_id = ${groupId}
      AND (f.source_entity_id = ANY(${seedIds}) OR f.target_entity_id = ANY(${seedIds}))
      ${temporalFilter}
    ORDER BY f.confidence DESC, f.valid_at DESC
    LIMIT ${limit}
  `;

  for (const row of hop1) {
    results.push({
      type: 'fact',
      id: row.id,
      score: Number(row.confidence) * 0.9, // Slightly discount vs direct matches
      content: row.fact_text,
      metadata: {
        confidence: row.confidence,
        sourceName: row.source_name,
        targetName: row.target_name,
        graphHop: 1,
      },
      relation: row.relation,
      validAt: row.valid_at,
      invalidAt: row.invalid_at,
    });
  }

  return results;
}

// ─── Reciprocal Rank Fusion ───────────────────────────────────

function rrfFusion(resultLists: SearchResult[][]): SearchResult[] {
  const scores = new Map<string, { score: number; result: SearchResult }>();

  for (const list of resultLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      const key = `${result.type}:${result.id}`;
      const rrfScore = 1 / (RRF_K + rank);

      if (scores.has(key)) {
        scores.get(key)!.score += rrfScore;
      } else {
        scores.set(key, { score: rrfScore, result });
      }
    }
  }

  // Normalize scores and attach
  const fused = Array.from(scores.values());
  const maxScore = Math.max(...fused.map(f => f.score), 0.001);

  return fused.map(f => ({
    ...f.result,
    score: f.score / maxScore,
  }));
}

// ─── Recency Boost ────────────────────────────────────────────

function applyRecencyBoost(results: SearchResult[]): void {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (const r of results) {
    if (r.validAt) {
      const ageInDays = (now - r.validAt.getTime()) / dayMs;
      // Logarithmic decay: recent facts get a boost, old ones aren't penalized much
      const recencyFactor = 1 + 0.1 * Math.max(0, 1 - Math.log(ageInDays + 1) / Math.log(365));
      r.score *= recencyFactor;
    }
  }
}
