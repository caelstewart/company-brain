/**
 * Three-Tier Search Engine.
 *
 * Tier 1: Direct lookup (<100ms, no LLM in retrieval)
 *   - Keyword search + graph entity lookup
 *
 * Tier 2: Hybrid retrieval + PPR (<500ms, LLM only for answer)
 *   - Semantic, keyword, graph traversal, Personalized PageRank, community summaries
 *   - Reciprocal Rank Fusion (RRF) to merge results
 *
 * Tier 3: Agentic decomposition (1-5s, LLM plans + executes)
 *   - Breaks complex queries into sub-queries via LLM planning
 *   - Executes sub-queries respecting dependency order
 *   - Merges sub-results
 *
 * The query router selects the tier based on query classification.
 */

import type postgres from 'postgres';
import type { SearchOptions, SearchResult, SearchMethod, EmbeddingConfig, LLMConfig, AccessContext } from '../types.js';
import { embed } from '../embedding.js';
import { visibilitySql } from '../security.js';
import { routeQuery, routeQueryWithLLM } from './router.js';
import type { QuerySchemaContext, RoutingDecision } from './router.js';
import { decompose, executePlan } from './decomposer.js';
import { findSeedEntities, traverseGraph, graphTraversalSearch } from './graph-traversal.js';
import { personalizedPageRank } from './pagerank.js';
import { asOf as temporalAsOf, changedSince, validDuring, entityTimeline } from './temporal.js';
import { buildAndSummarize, searchCommunities } from './communities.js';
import type { Community } from './communities.js';

const RRF_K = 60;

// Re-export sub-modules for direct access
export { routeQuery, routeQueryWithLLM } from './router.js';
export type { RoutingDecision, QueryIntent, QueryTier } from './router.js';
export { decomposeWithTemplates, decomposeWithLLM, decompose, executePlan } from './decomposer.js';
export type { SubQuery, DecompositionPlan } from './decomposer.js';
export { findSeedEntities, traverseGraph, graphTraversalSearch } from './graph-traversal.js';
export type { TraversalOptions } from './graph-traversal.js';
export { personalizedPageRank, computePPR } from './pagerank.js';
export type { PPROptions } from './pagerank.js';
export { asOf, changedSince, validDuring, entityTimeline, recentContradictions } from './temporal.js';
export type { TemporalOptions } from './temporal.js';
export { detectCommunities, buildCommunities, summarizeCommunity, buildAndSummarize, searchCommunities } from './communities.js';
// buildCommunities still available via direct import from communities.js
export type { Community } from './communities.js';

// ─── Main Search (Three-Tier) ────────────────────────────────

export interface SearchEngineOptions extends SearchOptions {
  llmConfig?: LLMConfig;
  /** Cached communities for community-based search (avoids re-computing). */
  communities?: Community[];
}

/**
 * Main search entry point. Routes queries through the three-tier system.
 *
 * Use this function for automatic tier selection and query routing.
 * For manual control, use the individual tier functions or sub-modules directly.
 */
export async function search(
  db: postgres.Sql,
  options: SearchOptions | SearchEngineOptions,
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
    minConfidence = 0,
    access,
  } = options;

  const llmConfig = (options as SearchEngineOptions).llmConfig;
  const cachedCommunities = (options as SearchEngineOptions).communities;

  // Determine methods: if caller specified, use those; otherwise auto-route
  let methods: string[];
  let routing: RoutingDecision | undefined;

  if (options.methods && options.methods.length > 0) {
    methods = options.methods;
  } else {
    // Use LLM-powered routing when available (better intent + entity extraction),
    // fall back to rule-based when no LLM config
    const querySchema = llmConfig ? await loadQuerySchemaContext(db, groupId) : undefined;
    routing = llmConfig
      ? await routeQueryWithLLM(query, llmConfig, querySchema)
      : routeQuery(query);
    methods = routing.methods;
  }

  // Tier 3: Decomposition
  if (methods.includes('decompose')) {
    return executeTier3(db, query, groupId, limit, embeddingConfig, llmConfig, asOf, access);
  }

  // Tier 1 & 2: Run search methods in parallel, then fuse
  const resultLists = await runSearchMethods(
    db, query, groupId, methods, limit, asOf, embeddingConfig, entityTypes, relations, cachedCommunities, llmConfig, access,
  );

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

  // Apply recency boost
  applyRecencyBoost(fused);

  // Sort by final score and paginate
  fused.sort((a, b) => b.score - a.score);
  return fused.slice(offset, offset + limit);
}

async function loadQuerySchemaContext(
  db: postgres.Sql,
  groupId: string,
): Promise<QuerySchemaContext | undefined> {
  try {
    let [entityTypes, relationTypes] = await Promise.all([
      db`
        SELECT id, label, description FROM entity_types
        WHERE group_id = ${groupId}
        ORDER BY id
      `,
      db`
        SELECT id, label, description FROM relation_types
        WHERE group_id = ${groupId}
        ORDER BY id
      `,
    ]);

    if (groupId !== 'default' && entityTypes.length === 0 && relationTypes.length === 0) {
      [entityTypes, relationTypes] = await Promise.all([
        db`
          SELECT id, label, description FROM entity_types
          WHERE group_id = 'default'
          ORDER BY id
        `,
        db`
          SELECT id, label, description FROM relation_types
          WHERE group_id = 'default'
          ORDER BY id
        `,
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
        description: t.description || undefined,
      })),
    };
  } catch {
    return undefined;
  }
}

// ─── Tier 3: Decomposition Engine ────────────────────────────

async function executeTier3(
  db: postgres.Sql,
  query: string,
  groupId: string,
  limit: number,
  embeddingConfig?: EmbeddingConfig,
  llmConfig?: LLMConfig,
  asOf?: Date,
  access?: AccessContext,
): Promise<SearchResult[]> {
  const plan = await decompose(query, llmConfig);

  const results = await executePlan(plan, async (subQuestion, intent) => {
    // Map sub-query intent to search methods
    const subMethods = intentToSearchMethods(intent);
    const subLists = await runSearchMethods(
      db, subQuestion, groupId, subMethods, limit, asOf, embeddingConfig,
      undefined, undefined, undefined, llmConfig, access,
    );
    return rrfFusion(subLists);
  });

  // Sort and limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function intentToSearchMethods(intent: string): string[] {
  switch (intent) {
    case 'entity_lookup': return ['keyword', 'graph', 'semantic'];
    case 'relationship': return ['graph', 'pagerank', 'keyword', 'semantic'];
    case 'temporal': return ['temporal', 'keyword'];
    case 'analytical': return ['keyword', 'graph', 'semantic'];
    default: return ['semantic', 'keyword', 'graph'];
  }
}

// ─── Search Method Runner ────────────────────────────────────

async function runSearchMethods(
  db: postgres.Sql,
  query: string,
  groupId: string,
  methods: string[],
  limit: number,
  asOf?: Date,
  embeddingConfig?: EmbeddingConfig,
  entityTypes?: string[],
  relations?: string[],
  cachedCommunities?: Community[],
  llmConfig?: LLMConfig,
  access?: AccessContext,
): Promise<SearchResult[][]> {
  const searches: Promise<SearchResult[]>[] = [];

  if (methods.includes('keyword')) {
    searches.push(keywordSearch(db, query, groupId, limit * 2, asOf, entityTypes, relations, access));
  }

  if (methods.includes('semantic')) {
    searches.push(semanticSearch(db, query, groupId, limit * 2, asOf, embeddingConfig, access));
  }

  if (methods.includes('graph')) {
    searches.push(graphTraversalSearch(db, query, { groupId, limit: limit * 2, asOf, relations, embeddingConfig, access }));
  }

  if (methods.includes('pagerank')) {
    searches.push(pagerankSearch(db, query, groupId, limit * 2, asOf, embeddingConfig, access));
  }

  if (methods.includes('temporal')) {
    searches.push(temporalSearch(db, query, groupId, limit * 2, asOf, access));
  }

  if (methods.includes('community')) {
    searches.push(communitySearch(db, query, groupId, limit * 2, cachedCommunities, llmConfig, access, embeddingConfig));
  }

  const results = await Promise.all(searches);
  return results;
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
  access?: AccessContext,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const broadTsQuery = buildBroadTsQuery(query);

  // Search entities
  const entityResults = await db`
    SELECT id, name, entity_type, summary, attributes, created_at, updated_at,
           ts_rank(to_tsvector('english', name || ' ' || summary), websearch_to_tsquery('english', ${query})) AS rank
    FROM entities
    WHERE group_id = ${groupId}
      AND to_tsvector('english', name || ' ' || summary) @@ websearch_to_tsquery('english', ${query})
      ${entityTypes && entityTypes.length > 0 ? db`AND entity_type = ANY(${entityTypes})` : db``}
      ${visibilitySql(db, db`visibility`, access)}
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  for (const row of entityResults) {
    results.push({
      type: 'entity',
      id: row.id,
      score: Number(row.rank),
      content: `${row.name}: ${row.summary}`,
      metadata: { entityType: row.entity_type, attributes: row.attributes, method: 'keyword' },
    });
  }

  // Search facts
  const temporalFilter = asOf
    ? db`AND valid_at <= ${asOf} AND (invalid_at IS NULL OR invalid_at > ${asOf})`
    : db`AND invalid_at IS NULL`;

  const factResults = await db`
    SELECT f.id, f.fact_text, f.relation, f.valid_at, f.invalid_at, f.confidence,
           f.source_entity_id, f.target_entity_id, f.evidence, f.extractor,
           GREATEST(
             ts_rank(f.fact_tsv, websearch_to_tsquery('english', ${query})),
             ${broadTsQuery ? db`ts_rank(f.fact_tsv, to_tsquery('english', ${broadTsQuery})) * 0.65` : db`0`}
           ) AS rank
    FROM facts f
    WHERE f.group_id = ${groupId}
      AND (
        f.fact_tsv @@ websearch_to_tsquery('english', ${query})
        OR ${broadTsQuery ? db`f.fact_tsv @@ to_tsquery('english', ${broadTsQuery})` : db`false`}
      )
      ${temporalFilter}
      ${relations && relations.length > 0 ? db`AND f.relation = ANY(${relations})` : db``}
      ${visibilitySql(db, db`f.visibility`, access)}
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  for (const row of factResults) {
    results.push({
      type: 'fact',
      id: row.id,
      score: Number(row.rank) * Number(row.confidence),
      content: row.fact_text,
      metadata: {
        confidence: row.confidence,
        evidence: row.evidence,
        extractor: row.extractor,
        method: 'keyword',
        grounding: {
          supported: true,
          confidence: Number(row.confidence),
          quote: typeof row.evidence?.quote === 'string' ? row.evidence.quote : undefined,
          instruction: 'Use this fact as support. Label interpretations beyond this text as inference.',
        },
      },
      relation: row.relation,
      validAt: row.valid_at,
      invalidAt: row.invalid_at,
    });
  }

  // Search episodes (raw ingested content) for broader recall
  const episodeResults = await db`
    SELECT id, content, source_type, valid_at,
           GREATEST(
             ts_rank(content_tsv, websearch_to_tsquery('english', ${query})),
             ${broadTsQuery ? db`ts_rank(content_tsv, to_tsquery('english', ${broadTsQuery})) * 0.65` : db`0`}
           ) AS rank
    FROM episodes
    WHERE group_id = ${groupId}
      AND (
        content_tsv @@ websearch_to_tsquery('english', ${query})
        OR ${broadTsQuery ? db`content_tsv @@ to_tsquery('english', ${broadTsQuery})` : db`false`}
      )
      ${visibilitySql(db, db`visibility`, access)}
    ORDER BY rank DESC
    LIMIT ${Math.min(limit, 5)}
  `;

  for (const row of episodeResults) {
    results.push({
      type: 'episode',
      id: row.id,
      score: Number(row.rank) * 0.7, // discount episodes vs structured data
      content: (row.content as string).slice(0, 500),
      metadata: { sourceType: row.source_type, method: 'keyword' },
      validAt: row.valid_at,
    });
  }

  return results;
}

function buildBroadTsQuery(query: string): string | null {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(term => term.replace(/^-+|-+$/g, ''))
    .filter(term => term.length > 2)
    .slice(0, 12);
  if (terms.length === 0) return null;
  return Array.from(new Set(terms)).join(' | ');
}

// ─── Semantic Search (vector cosine) ──────────────────────────

async function semanticSearch(
  db: postgres.Sql,
  query: string,
  groupId: string,
  limit: number,
  asOf?: Date,
  embeddingConfig?: EmbeddingConfig,
  access?: AccessContext,
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
      ${visibilitySql(db, db`visibility`, access)}
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
        metadata: { entityType: row.entity_type, attributes: row.attributes, method: 'semantic' },
      });
    }
  }

  // Search fact embeddings
  const temporalFilter = asOf
    ? db`AND valid_at <= ${asOf} AND (invalid_at IS NULL OR invalid_at > ${asOf})`
    : db`AND invalid_at IS NULL`;

  const factResults = await db`
    SELECT id, fact_text, relation, valid_at, invalid_at, confidence, evidence, extractor,
           source_entity_id, target_entity_id,
           1 - (fact_embedding <=> ${embeddingStr}::vector) AS similarity
    FROM facts
    WHERE group_id = ${groupId}
      AND fact_embedding IS NOT NULL
      ${temporalFilter}
      ${visibilitySql(db, db`visibility`, access)}
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
        metadata: {
          confidence: row.confidence,
          evidence: row.evidence,
          extractor: row.extractor,
          method: 'semantic',
          grounding: {
            supported: true,
            confidence: Number(row.confidence),
            quote: typeof row.evidence?.quote === 'string' ? row.evidence.quote : undefined,
            instruction: 'Use this fact as support. Label interpretations beyond this text as inference.',
          },
        },
        relation: row.relation,
        validAt: row.valid_at,
        invalidAt: row.invalid_at,
      });
    }
  }

  const episodeResults = await db`
    SELECT id, content, source_type, valid_at,
           1 - (content_embedding <=> ${embeddingStr}::vector) AS similarity
    FROM episodes
    WHERE group_id = ${groupId}
      AND content_embedding IS NOT NULL
      ${visibilitySql(db, db`visibility`, access)}
    ORDER BY content_embedding <=> ${embeddingStr}::vector
    LIMIT ${Math.min(limit, 8)}
  `;

  for (const row of episodeResults) {
    if (Number(row.similarity) > 0.28) {
      results.push({
        type: 'episode',
        id: row.id,
        score: Number(row.similarity) * 0.8,
        content: (row.content as string).slice(0, 1200),
        metadata: { sourceType: row.source_type, method: 'semantic' },
        validAt: row.valid_at,
      });
    }
  }

  return results;
}

// ─── PageRank Search ──────────────────────────────────────────

async function pagerankSearch(
  db: postgres.Sql,
  query: string,
  groupId: string,
  limit: number,
  asOf?: Date,
  embeddingConfig?: EmbeddingConfig,
  access?: AccessContext,
): Promise<SearchResult[]> {
  // Find seed entities from the query
  const seeds = await findSeedEntities(db, query, groupId, 10, embeddingConfig, access);
  if (seeds.length === 0) return [];

  const seedIds = seeds.map(s => s.id);
  return personalizedPageRank(db, seedIds, { groupId, limit, asOf, access });
}

// ─── Temporal Search ──────────────────────────────────────────

async function temporalSearch(
  db: postgres.Sql,
  query: string,
  groupId: string,
  limit: number,
  asOf?: Date,
  access?: AccessContext,
): Promise<SearchResult[]> {
  if (asOf) {
    return temporalAsOf(db, asOf, { groupId, limit, access });
  }
  // Default: show changes from the last 30 days
  const since = new Date();
  since.setDate(since.getDate() - 30);
  return changedSince(db, since, { groupId, limit, access });
}

// ─── Community Search ─────────────────────────────────────────

// In-memory community cache. Communities are expensive to build+summarize,
// so we cache per groupId with a TTL. Invalidated after 5 minutes or
// when the caller provides explicit cachedCommunities.
const communityCache = new Map<string, { communities: Community[]; builtAt: number }>();
const COMMUNITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function communitySearch(
  db: postgres.Sql,
  query: string,
  groupId: string,
  limit: number,
  cachedCommunities?: Community[],
  llmConfig?: LLMConfig,
  access?: AccessContext,
  embeddingConfig?: EmbeddingConfig,
): Promise<SearchResult[]> {
  // Use caller-provided cache first
  if (cachedCommunities) {
    return searchCommunities(cachedCommunities, query, limit, embeddingConfig);
  }

  // Check in-memory cache
  const cacheKey = access ? `${groupId}:${JSON.stringify(access)}` : groupId;
  const cached = communityCache.get(cacheKey);
  if (cached && Date.now() - cached.builtAt < COMMUNITY_CACHE_TTL_MS) {
    return searchCommunities(cached.communities, query, limit, embeddingConfig);
  }

  // Build fresh communities with summaries
  const communities = await buildAndSummarize(db, groupId, llmConfig, access, embeddingConfig);
  communityCache.set(cacheKey, { communities, builtAt: Date.now() });
  return searchCommunities(communities, query, limit, embeddingConfig);
}

// ─── Reciprocal Rank Fusion ───────────────────────────────────

export function rrfFusion(resultLists: SearchResult[][]): SearchResult[] {
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
