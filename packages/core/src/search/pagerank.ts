/**
 * Personalized PageRank (PPR) for multi-hop reasoning over the knowledge graph.
 *
 * Inspired by HippoRAG (NeurIPS 2024), this module seeds probability from
 * query-relevant entities and lets it flow through the graph to surface
 * non-obvious, multi-hop connections that keyword/semantic search would miss.
 *
 * The algorithm:
 *   1. Load the subgraph (entities + facts) for a group from Postgres.
 *   2. Build a bidirectional adjacency list weighted by fact confidence.
 *   3. Run power-iteration PPR seeded on the query-relevant entity IDs.
 *   4. Return top-scored entities with their connected facts as SearchResult[].
 */

import type postgres from 'postgres';
import type { AccessContext, SearchResult } from '../types.js';
import { normalizeVisibility, visibilitySql } from '../security.js';

// ─── Types ───────────────────────────────────────────────────

export interface PPROptions {
  groupId: string;
  /** Teleport (damping) probability: chance of jumping back to seed nodes each step. */
  alpha?: number;
  /** Maximum power-iteration rounds. */
  maxIterations?: number;
  /** L1-norm convergence threshold. */
  tolerance?: number;
  /** Maximum results to return. */
  limit?: number;
  /** Temporal filter: only consider facts valid at this point in time. */
  asOf?: Date;
  /** Optional access context used to enforce row-level visibility. */
  access?: AccessContext;
}

// ─── Internal row types ──────────────────────────────────────

interface EntityRow {
  id: string;
  name: string;
  entity_type: string;
  summary: string;
  visibility: Record<string, unknown>;
}

interface FactRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation: string;
  fact_text: string;
  valid_at: Date;
  invalid_at: Date | null;
  confidence: number;
  evidence: Record<string, unknown>;
  extractor: string;
}

// ─── Personalized PageRank (DB-backed) ───────────────────────

/**
 * Run Personalized PageRank from seed entity IDs.
 * Returns entities ranked by PPR score with their connected facts.
 */
export async function personalizedPageRank(
  db: postgres.Sql,
  seedIds: string[],
  options: PPROptions,
): Promise<SearchResult[]> {
  const {
    groupId,
    alpha = 0.15,
    maxIterations = 20,
    tolerance = 1e-6,
    limit = 30,
    asOf,
    access,
  } = options;

  if (seedIds.length === 0) return [];

  // ── 1. Load subgraph ────────────────────────────────────────

  const temporalFilter = asOf
    ? db`AND f.valid_at <= ${asOf} AND (f.invalid_at IS NULL OR f.invalid_at > ${asOf})`
    : db`AND f.invalid_at IS NULL`;

  const [entities, facts] = await Promise.all([
    db<EntityRow[]>`
      SELECT id, name, entity_type, summary, visibility
      FROM entities
      WHERE group_id = ${groupId}
      ${visibilitySql(db, db`visibility`, access)}
    `,
    db<FactRow[]>`
      SELECT f.id, f.source_entity_id, f.target_entity_id,
             f.relation, f.fact_text, f.valid_at, f.invalid_at, f.confidence,
             f.evidence, f.extractor
      FROM facts f
      WHERE f.group_id = ${groupId}
        ${temporalFilter}
        ${visibilitySql(db, db`f.visibility`, access)}
    `,
  ]);

  if (entities.length === 0) return [];

  // ── 2. Build adjacency from facts ───────────────────────────

  const nodeIds = entities.map(e => e.id);
  const nodeSet = new Set(nodeIds);

  // Filter seed IDs to only those present in the subgraph
  const validSeedIds = seedIds.filter(id => nodeSet.has(id));
  if (validSeedIds.length === 0) return [];

  const edges: Array<{ source: string; target: string; weight: number }> = [];
  for (const fact of facts) {
    // Only include edges whose endpoints exist in the entity set
    if (nodeSet.has(fact.source_entity_id) && nodeSet.has(fact.target_entity_id)) {
      const weight = Number(fact.confidence);
      // Bidirectional: A->B and B->A
      edges.push({ source: fact.source_entity_id, target: fact.target_entity_id, weight });
      edges.push({ source: fact.target_entity_id, target: fact.source_entity_id, weight });
    }
  }

  // ── 3. Compute PPR ──────────────────────────────────────────

  const scores = computePPR(nodeIds, edges, validSeedIds, alpha, maxIterations, tolerance);

  // ── 4. Rank entities and build results ──────────────────────

  const entityMap = new Map<string, EntityRow>();
  for (const e of entities) {
    entityMap.set(e.id, e);
  }

  // Sort entities by score descending, take top `limit`
  const rankedIds = Array.from(scores.entries())
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (rankedIds.length === 0) return [];

  // Build a set of top entity IDs for fast lookup
  const topIdSet = new Set(rankedIds.map(([id]) => id));

  // Build a lookup of facts connected to each top entity
  const entityFacts = new Map<string, FactRow[]>();
  for (const fact of facts) {
    const srcInTop = topIdSet.has(fact.source_entity_id);
    const tgtInTop = topIdSet.has(fact.target_entity_id);
    if (srcInTop) {
      if (!entityFacts.has(fact.source_entity_id)) {
        entityFacts.set(fact.source_entity_id, []);
      }
      entityFacts.get(fact.source_entity_id)!.push(fact);
    }
    if (tgtInTop) {
      if (!entityFacts.has(fact.target_entity_id)) {
        entityFacts.set(fact.target_entity_id, []);
      }
      entityFacts.get(fact.target_entity_id)!.push(fact);
    }
  }

  // ── 5. Assemble SearchResult[] ──────────────────────────────

  const results: SearchResult[] = [];

  for (const [entityId, score] of rankedIds) {
    const entity = entityMap.get(entityId);
    if (!entity) continue;

    // Entity result
    results.push({
      type: 'entity',
      id: entity.id,
      score,
      content: `${entity.name}: ${entity.summary}`,
      metadata: {
        entityType: entity.entity_type,
        pprScore: score,
        method: 'pagerank',
      },
    });

    // Connected fact results (deduplicated globally)
    const connectedFacts = entityFacts.get(entityId) || [];
    for (const fact of connectedFacts) {
      // Avoid duplicate fact entries: only emit a fact from the higher-scored endpoint
      const otherEntityId =
        fact.source_entity_id === entityId ? fact.target_entity_id : fact.source_entity_id;
      const otherScore = scores.get(otherEntityId) ?? 0;

      // Emit from this entity only if it has a higher (or equal) score than the other end,
      // or the other end is not in the top set
      if (!topIdSet.has(otherEntityId) || score >= otherScore) {
        // If both scores are equal, break tie by entity ID to ensure determinism
        if (topIdSet.has(otherEntityId) && score === otherScore && entityId > otherEntityId) {
          continue;
        }

        const sourceEntity = entityMap.get(fact.source_entity_id);
        const targetEntity = entityMap.get(fact.target_entity_id);

        results.push({
          type: 'fact',
          id: fact.id,
          score: score * Number(fact.confidence),
          content: fact.fact_text,
          metadata: {
            confidence: Number(fact.confidence),
            evidence: fact.evidence ?? {},
            extractor: fact.extractor ?? 'unknown',
            pprScore: score,
            method: 'pagerank',
            grounding: {
              supported: true,
              confidence: Number(fact.confidence),
              quote: typeof fact.evidence?.quote === 'string' ? fact.evidence.quote : undefined,
              instruction: 'Use this fact as support. Label interpretations beyond this text as inference.',
            },
          },
          sourceEntity: sourceEntity
            ? {
                id: sourceEntity.id,
                groupId: options.groupId,
                entityType: sourceEntity.entity_type,
                name: sourceEntity.name,
                summary: sourceEntity.summary,
                attributes: {},
                visibility: normalizeVisibility(sourceEntity.visibility),
                createdAt: new Date(),
                updatedAt: new Date(),
              }
            : undefined,
          targetEntity: targetEntity
            ? {
                id: targetEntity.id,
                groupId: options.groupId,
                entityType: targetEntity.entity_type,
                name: targetEntity.name,
                summary: targetEntity.summary,
                attributes: {},
                visibility: normalizeVisibility(targetEntity.visibility),
                createdAt: new Date(),
                updatedAt: new Date(),
              }
            : undefined,
          relation: fact.relation,
          validAt: fact.valid_at,
          invalidAt: fact.invalid_at,
        });
      }
    }
  }

  // Final sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ─── Pure PPR Computation ────────────────────────────────────

/**
 * In-memory Personalized PageRank via power iteration.
 *
 * @param nodes      - All node IDs in the graph.
 * @param edges      - Directed edges with weights (caller should provide both
 *                     directions for undirected graphs).
 * @param seedIds    - Seed node IDs (teleport targets).
 * @param alpha      - Teleport probability (default 0.15).
 * @param maxIterations - Max iterations (default 20).
 * @param tolerance  - L1-norm convergence threshold (default 1e-6).
 * @returns Map of nodeId to PPR score.
 */
export function computePPR(
  nodes: string[],
  edges: Array<{ source: string; target: string; weight: number }>,
  seedIds: string[],
  alpha: number = 0.15,
  maxIterations: number = 20,
  tolerance: number = 1e-6,
): Map<string, number> {
  const nodeCount = nodes.length;
  if (nodeCount === 0) return new Map();

  // Map node IDs to indices for faster computation
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < nodeCount; i++) {
    idToIndex.set(nodes[i], i);
  }

  // ── Build adjacency list with normalized weights ────────────
  // For each node, store its outgoing edges as { targetIndex, normalizedWeight }

  // First, collect raw outgoing weights per node
  const outEdges = new Array<Array<{ target: number; weight: number }>>(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    outEdges[i] = [];
  }

  for (const edge of edges) {
    const srcIdx = idToIndex.get(edge.source);
    const tgtIdx = idToIndex.get(edge.target);
    if (srcIdx !== undefined && tgtIdx !== undefined) {
      outEdges[srcIdx].push({ target: tgtIdx, weight: edge.weight });
    }
  }

  // Compute total outgoing weight per node for normalization
  const outWeightSum = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    let sum = 0;
    for (const e of outEdges[i]) {
      sum += e.weight;
    }
    outWeightSum[i] = sum;
  }

  // Build incoming adjacency: for each node, who points to it and with what normalized weight?
  const inEdges = new Array<Array<{ source: number; normalizedWeight: number }>>(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    inEdges[i] = [];
  }

  for (let srcIdx = 0; srcIdx < nodeCount; srcIdx++) {
    const totalOut = outWeightSum[srcIdx];
    if (totalOut === 0) continue;
    for (const e of outEdges[srcIdx]) {
      inEdges[e.target].push({
        source: srcIdx,
        normalizedWeight: e.weight / totalOut,
      });
    }
  }

  // ── Seed probability vector ─────────────────────────────────

  const seedProbability = new Float64Array(nodeCount); // all zeros
  const validSeedIndices: number[] = [];
  for (const seedId of seedIds) {
    const idx = idToIndex.get(seedId);
    if (idx !== undefined) {
      validSeedIndices.push(idx);
    }
  }

  if (validSeedIndices.length === 0) {
    // No valid seeds: return zero scores
    const result = new Map<string, number>();
    for (const node of nodes) {
      result.set(node, 0);
    }
    return result;
  }

  const seedWeight = 1 / validSeedIndices.length;
  for (const idx of validSeedIndices) {
    seedProbability[idx] = seedWeight;
  }

  // ── Initialize scores ───────────────────────────────────────
  // Seed nodes start with equal probability

  let scores = new Float64Array(nodeCount);
  for (const idx of validSeedIndices) {
    scores[idx] = seedWeight;
  }

  // ── Power iteration ─────────────────────────────────────────

  for (let iter = 0; iter < maxIterations; iter++) {
    const newScores = new Float64Array(nodeCount);

    for (let i = 0; i < nodeCount; i++) {
      // Teleport component
      let score = alpha * seedProbability[i];

      // Propagation component: sum of incoming contributions
      for (const incoming of inEdges[i]) {
        score += (1 - alpha) * scores[incoming.source] * incoming.normalizedWeight;
      }

      newScores[i] = score;
    }

    // Handle dangling nodes: redistribute their probability mass to seeds.
    // A dangling node has no outgoing edges, so its probability "leaks" out.
    let danglingMass = 0;
    for (let i = 0; i < nodeCount; i++) {
      if (outWeightSum[i] === 0) {
        danglingMass += scores[i];
      }
    }

    if (danglingMass > 0) {
      const danglingRedistribution = (1 - alpha) * danglingMass * seedWeight;
      for (const idx of validSeedIndices) {
        newScores[idx] += danglingRedistribution;
      }
    }

    // Check convergence: L1 norm of difference
    let diff = 0;
    for (let i = 0; i < nodeCount; i++) {
      diff += Math.abs(newScores[i] - scores[i]);
    }

    scores = newScores;

    if (diff < tolerance) {
      break;
    }
  }

  // ── Build result map ────────────────────────────────────────

  const result = new Map<string, number>();
  for (let i = 0; i < nodeCount; i++) {
    result.set(nodes[i], scores[i]);
  }

  return result;
}
