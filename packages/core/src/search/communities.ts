/**
 * Community Detection and Pre-computed Summaries.
 *
 * Implements label propagation for community detection on the Company Brain
 * knowledge graph, enabling answers to abstract/global questions like
 * "How is the system looking?" or "What are the main patterns across everything?".
 *
 * Label propagation supports incremental updates, as recommended by
 * Graphiti/Zep research for temporal knowledge graphs.
 */

import type postgres from 'postgres';
import type { AccessContext, SearchResult, LLMConfig, EmbeddingConfig } from '../types.js';
import { cosineSimilarity, embed, embedBatch } from '../embedding.js';
import { anthropicMaxOutputTokens, defaultLLMModel } from '../llm-limits.js';
import { visibilitySql } from '../security.js';

// ─── Types ───────────────────────────────────────────────────

export interface Community {
  id: number;
  memberIds: string[];    // entity IDs
  memberNames: string[];  // entity names
  summary: string;        // LLM-generated summary
  level: number;          // hierarchy level (0 = leaf)
  updatedAt: Date;
  /** Query-independent graph salience derived from community size and edge weight. */
  salience?: number;
  /** Embedding of the community representation used for semantic community retrieval. */
  embedding?: number[];
}

// ─── Label Propagation Community Detection ───────────────────

/**
 * Label propagation community detection (in-memory, no external deps).
 *
 * Initialize each node with its own community label, then iterate:
 * for each node (in random order), adopt the community label that is
 * most common among its neighbors (weighted by edge weight).
 *
 * Convergence: stop when no labels change or maxIterations reached.
 *
 * Exported for testing.
 */
export function detectCommunities(
  nodes: string[],
  edges: Array<{ source: string; target: string; weight: number }>,
  maxIterations: number = 10,
): Map<string, number> {
  // Initialize each node with its own unique community label
  const labels = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    labels.set(nodes[i], i);
  }

  // Build adjacency list with weights
  const adjacency = new Map<string, Array<{ neighbor: string; weight: number }>>();
  for (const node of nodes) {
    adjacency.set(node, []);
  }
  for (const edge of edges) {
    const sourceAdj = adjacency.get(edge.source);
    const targetAdj = adjacency.get(edge.target);
    if (sourceAdj) {
      sourceAdj.push({ neighbor: edge.target, weight: edge.weight });
    }
    if (targetAdj) {
      targetAdj.push({ neighbor: edge.source, weight: edge.weight });
    }
  }

  // Iterate until convergence or maxIterations
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changed = false;

    // Shuffle nodes for random order processing
    const shuffled = [...nodes];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (const node of shuffled) {
      const neighbors = adjacency.get(node);
      if (!neighbors || neighbors.length === 0) continue;

      // Accumulate weighted votes for each community label among neighbors
      const labelWeights = new Map<number, number>();
      for (const { neighbor, weight } of neighbors) {
        const neighborLabel = labels.get(neighbor)!;
        labelWeights.set(
          neighborLabel,
          (labelWeights.get(neighborLabel) ?? 0) + weight,
        );
      }

      // Find the label with the highest total weight
      let bestLabel = labels.get(node)!;
      let bestWeight = -Infinity;
      for (const [label, weight] of labelWeights) {
        if (weight > bestWeight) {
          bestWeight = weight;
          bestLabel = label;
        }
      }

      // Update label if changed
      const currentLabel = labels.get(node)!;
      if (bestLabel !== currentLabel) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return labels;
}

// ─── Build Communities from Database ─────────────────────────

/**
 * Load the entity graph and run community detection.
 *
 * Loads all entities in the group, loads all current facts
 * (invalid_at IS NULL), builds edges from facts, runs label propagation,
 * and groups entities by community label.
 */
export async function buildCommunities(
  db: postgres.Sql,
  groupId: string,
  access?: AccessContext,
): Promise<Community[]> {
  // Load all entities in the group
  const entities = await db`
    SELECT id, name, entity_type, summary
    FROM entities
    WHERE group_id = ${groupId}
    ${visibilitySql(db, db`visibility`, access)}
  `;

  if (entities.length === 0) return [];

  // Load all current facts in the group
  const facts = await db`
    SELECT source_entity_id, target_entity_id, confidence
    FROM facts
    WHERE group_id = ${groupId}
      AND invalid_at IS NULL
      ${visibilitySql(db, db`visibility`, access)}
  `;

  // Build node list and edge list
  const nodes = entities.map(e => e.id as string);
  const nodeNameMap = new Map<string, string>();
  for (const entity of entities) {
    nodeNameMap.set(entity.id as string, entity.name as string);
  }

  const edges: Array<{ source: string; target: string; weight: number }> = [];
  for (const fact of facts) {
    edges.push({
      source: fact.source_entity_id as string,
      target: fact.target_entity_id as string,
      weight: Number(fact.confidence),
    });
  }

  // Run community detection
  const labels = detectCommunities(nodes, edges);

  // Group entities by community label
  const communityMap = new Map<number, { ids: string[]; names: string[] }>();
  for (const [nodeId, label] of labels) {
    if (!communityMap.has(label)) {
      communityMap.set(label, { ids: [], names: [] });
    }
    const community = communityMap.get(label)!;
    community.ids.push(nodeId);
    community.names.push(nodeNameMap.get(nodeId) ?? nodeId);
  }

  const labelByNode = new Map<string, number>();
  for (const [nodeId, label] of labels) {
    labelByNode.set(nodeId, label);
  }

  const salienceByLabel = new Map<number, number>();
  for (const edge of edges) {
    const sourceLabel = labelByNode.get(edge.source);
    const targetLabel = labelByNode.get(edge.target);
    if (sourceLabel == null || targetLabel == null || sourceLabel !== targetLabel) continue;
    salienceByLabel.set(sourceLabel, (salienceByLabel.get(sourceLabel) ?? 0) + edge.weight);
  }

  // Convert to Community[] with sequential IDs
  // Filter out singleton communities (not useful for global queries)
  const communities: Community[] = [];
  let communityId = 0;
  for (const [label, members] of communityMap) {
    if (members.ids.length < 2) continue; // skip isolated entities
    const internalEdgeWeight = salienceByLabel.get(label) ?? 0;
    communities.push({
      id: communityId++,
      memberIds: members.ids,
      memberNames: members.names,
      summary: '', // will be populated by summarizeCommunity or buildAndSummarize
      level: 0,
      updatedAt: new Date(),
      salience: Math.log1p(members.ids.length) + Math.log1p(internalEdgeWeight),
    });
  }

  return communities;
}

// ─── Community Summarization ─────────────────────────────────

/**
 * Generate an LLM summary for a community.
 *
 * Loads all facts between community members and builds a context string.
 * If llmConfig is provided, calls the LLM to generate a 2-3 sentence summary.
 * Otherwise, generates a simple deterministic summary listing members and
 * key relationships.
 */
export async function summarizeCommunity(
  db: postgres.Sql,
  community: Community,
  groupId: string,
  llmConfig?: LLMConfig,
  access?: AccessContext,
): Promise<string> {
  // Load all facts between community members
  const facts = await db`
    SELECT source_entity_id, target_entity_id, relation, fact_text
    FROM facts
    WHERE group_id = ${groupId}
      AND invalid_at IS NULL
      AND source_entity_id = ANY(${community.memberIds}::uuid[])
      AND target_entity_id = ANY(${community.memberIds}::uuid[])
      ${visibilitySql(db, db`visibility`, access)}
    ORDER BY confidence DESC
  `;

  // Build context string listing members and relationships
  const memberList = community.memberNames.join(', ');
  const relationships = facts.map(f => f.fact_text as string);

  // Build the context for summarization
  const context = [
    `Community members: ${memberList}`,
    '',
    'Key relationships:',
    ...relationships.map((r, i) => `${i + 1}. ${r}`),
  ].join('\n');

  // If no LLM config, generate a deterministic summary
  if (!llmConfig) {
    const relationSummary = relationships.length > 0
      ? ` Key relationships include: ${relationships.slice(0, 3).join('; ')}.`
      : '';
    return `This community consists of ${community.memberNames.length} entities: ${memberList}.${relationSummary}`;
  }

  // LLM-based summary
  const prompt = [
    'You are summarizing a community of related entities from a knowledge graph.',
    'Provide a concise 2-3 sentence summary describing what this group of entities represents and their key relationships.',
    'Be specific and informative.',
    '',
    context,
  ].join('\n');

  if (llmConfig.provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey: llmConfig.apiKey,
    });

    const response = await client.messages.create({
      model: defaultLLMModel('anthropic', llmConfig),
      max_tokens: anthropicMaxOutputTokens(llmConfig),
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock ? textBlock.text.trim() : '';
  } else if (llmConfig.provider === 'openai') {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey: llmConfig.apiKey,
    });

    const response = await client.chat.completions.create({
      model: defaultLLMModel('openai', llmConfig),
      messages: [{ role: 'user', content: prompt }],
    });

    return response.choices[0]?.message?.content?.trim() ?? '';
  }

  // Fallback if provider is not recognized
  const relationSummary = relationships.length > 0
    ? ` Key relationships include: ${relationships.slice(0, 3).join('; ')}.`
    : '';
  return `This community consists of ${community.memberNames.length} entities: ${memberList}.${relationSummary}`;
}

// ─── Build + Summarize All ───────────────────────────────────

/**
 * Build communities and generate summaries for all of them.
 */
export async function buildAndSummarize(
  db: postgres.Sql,
  groupId: string,
  llmConfig?: LLMConfig,
  access?: AccessContext,
  embeddingConfig?: EmbeddingConfig,
): Promise<Community[]> {
  const communities = await buildCommunities(db, groupId, access);

  // Generate summaries for all communities
  for (const community of communities) {
    community.summary = await summarizeCommunity(db, community, groupId, llmConfig, access);
  }

  await hydrateCommunityEmbeddings(communities, embeddingConfig);

  return communities;
}

// ─── Search Community Summaries ──────────────────────────────

/**
 * Search community summaries for a query.
 *
 * Uses semantic similarity over a compact community representation plus a
 * small graph-salience prior. If embeddings are unavailable, it returns no
 * community results rather than falling back to brittle lexical overlap.
 */
export async function searchCommunities(
  communities: Community[],
  query: string,
  limit: number = 10,
  embeddingConfig?: EmbeddingConfig,
): Promise<SearchResult[]> {
  if (!query.trim() || communities.length === 0) return [];

  try {
    await hydrateCommunityEmbeddings(communities, embeddingConfig);
    const queryEmbedding = await embed(query, embeddingConfig);
    const maxSalience = Math.max(...communities.map(c => c.salience ?? 0), 0);
    const scored: Array<{ community: Community; score: number; semanticScore: number; graphPrior: number }> = [];

    for (const community of communities) {
      if (!community.embedding) continue;
      const semanticScore = cosineSimilarity(queryEmbedding, community.embedding);
      if (!Number.isFinite(semanticScore) || semanticScore < 0.12) continue;

      const graphPrior = maxSalience > 0 ? (community.salience ?? 0) / maxSalience : 0;
      const score = (semanticScore * 0.9) + (graphPrior * 0.1);
      scored.push({ community, score, semanticScore, graphPrior });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Return top results
    return scored.slice(0, limit).map(({ community, score, semanticScore, graphPrior }) => ({
      type: 'entity' as const,
      id: String(community.id),
      score,
      content: community.summary || `Community: ${community.memberNames.join(', ')}`,
      metadata: {
        memberNames: community.memberNames,
        memberIds: community.memberIds,
        communityLevel: community.level,
        semanticScore,
        graphPrior,
        communitySalience: community.salience ?? 0,
      },
    }));
  } catch {
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────

async function hydrateCommunityEmbeddings(
  communities: Community[],
  embeddingConfig?: EmbeddingConfig,
): Promise<void> {
  const missing = communities.filter(community => !community.embedding);
  if (missing.length === 0) return;
  const embeddings = await embedBatch(missing.map(communityRepresentation), embeddingConfig);
  for (let i = 0; i < missing.length; i += 1) {
    missing[i].embedding = embeddings[i];
  }
}

function communityRepresentation(community: Community): string {
  return [
    community.summary ? `Summary: ${community.summary}` : undefined,
    `Members: ${community.memberNames.join(', ')}`,
    `Graph size: ${community.memberIds.length} entities`,
  ].filter(Boolean).join('\n');
}
