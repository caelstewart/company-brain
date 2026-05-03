/**
 * Comprehensive test suite for the three-tier search system.
 *
 * Tests all pure-function modules (no database required):
 * - Query Router
 * - Query Decomposer
 * - Personalized PageRank (computePPR)
 * - Community Detection (detectCommunities)
 * - Community Search (searchCommunities)
 * - RRF Fusion
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/embedding.js', () => {
  const vectorFor = (text: string): number[] => {
    const lower = text.toLowerCase();
    if (lower.includes('ingest') || lower.includes('parser') || lower.includes('document') || lower.includes('normalized')) {
      return [1, 0, 0];
    }
    if (lower.includes('search') || lower.includes('rank') || lower.includes('retrieval') || lower.includes('query')) {
      return [0, 1, 0];
    }
    if (lower.includes('analytics') || lower.includes('metric') || lower.includes('telemetry')) {
      return [0, 0, 1];
    }
    return [0, 0, 0];
  };
  return {
    embed: vi.fn(async (text: string) => vectorFor(text)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(vectorFor)),
    cosineSimilarity: (a: number[], b: number[]) => {
      const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
      const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
      const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
      return normA && normB ? dot / (normA * normB) : Number.NaN;
    },
  };
});

// ─── Decomposer Tests ────────────────────────────────────────

import { executePlan } from '../src/search/decomposer.js';
import type { DecompositionPlan, SubQuery } from '../src/search/decomposer.js';

describe('Query Decomposer', () => {
  describe('executePlan', () => {
    it('executes independent sub-queries in parallel', async () => {
      const plan: DecompositionPlan = {
        original: 'test',
        subQueries: [
          { question: 'Q1', intent: 'entity_lookup' },
          { question: 'Q2', intent: 'entity_lookup' },
        ],
        synthesisHint: 'Combine results',
      };

      const callOrder: string[] = [];
      const results = await executePlan(plan, async (q) => {
        callOrder.push(q);
        return [{ type: 'entity', id: q, score: 1, content: q, metadata: {} }];
      });

      expect(results.length).toBe(2);
      // Both should have been called (order may vary due to parallel execution)
      expect(callOrder).toContain('Q1');
      expect(callOrder).toContain('Q2');
    });

    it('executes dependent sub-queries after their dependencies', async () => {
      const plan: DecompositionPlan = {
        original: 'test',
        subQueries: [
          { question: 'Q1', intent: 'entity_lookup' },
          { question: 'Q2', intent: 'relationship', dependsOn: [0] },
        ],
        synthesisHint: 'Combine results',
      };

      const callOrder: string[] = [];
      const results = await executePlan(plan, async (q) => {
        callOrder.push(q);
        return [{ type: 'entity', id: q.slice(0, 2), score: 1, content: q, metadata: {} }];
      });

      expect(results.length).toBe(2);
      // Q1 must be called before Q2
      expect(callOrder.indexOf('Q1')).toBeLessThan(
        callOrder.findIndex(c => c.startsWith('Q2')),
      );
    });

    it('enriches dependent sub-queries with dependency context', async () => {
      const plan: DecompositionPlan = {
        original: 'test',
        subQueries: [
          { question: 'Find Orion', intent: 'entity_lookup' },
          { question: 'What about Orion?', intent: 'relationship', dependsOn: [0] },
        ],
        synthesisHint: 'Combine results',
      };

      let dependentQuestion = '';
      await executePlan(plan, async (q) => {
        if (q.includes('Context:')) {
          dependentQuestion = q;
        }
        return [{ type: 'entity', id: 'e1', score: 1, content: 'Orion Service', metadata: {} }];
      });

      expect(dependentQuestion).toContain('Context:');
      expect(dependentQuestion).toContain('Orion Service');
    });

    it('deduplicates results by type:id', async () => {
      const plan: DecompositionPlan = {
        original: 'test',
        subQueries: [
          { question: 'Q1', intent: 'entity_lookup' },
          { question: 'Q2', intent: 'entity_lookup' },
        ],
        synthesisHint: 'Combine results',
      };

      const results = await executePlan(plan, async () => {
        return [{ type: 'entity', id: 'same-id', score: 1, content: 'Orion', metadata: {} }];
      });

      expect(results.length).toBe(1);
    });

    it('sorts results by score descending', async () => {
      const plan: DecompositionPlan = {
        original: 'test',
        subQueries: [
          { question: 'Q1', intent: 'entity_lookup' },
          { question: 'Q2', intent: 'entity_lookup' },
        ],
        synthesisHint: 'Combine results',
      };

      const results = await executePlan(plan, async (q) => {
        const score = q === 'Q1' ? 0.5 : 0.9;
        return [{ type: 'entity', id: q, score, content: q, metadata: {} }];
      });

      expect(results[0].score).toBeGreaterThan(results[1].score);
    });
  });
});

// ─── PPR Tests ───────────────────────────────────────────────

import { computePPR } from '../src/search/pagerank.js';

describe('Personalized PageRank (computePPR)', () => {
  it('returns empty map for empty graph', () => {
    const result = computePPR([], [], []);
    expect(result.size).toBe(0);
  });

  it('concentrates probability on seed node in disconnected graph', () => {
    const nodes = ['A', 'B', 'C'];
    const edges: Array<{ source: string; target: string; weight: number }> = [];
    const result = computePPR(nodes, edges, ['A']);

    expect(result.get('A')).toBeGreaterThan(0);
    // With no edges, all probability stays on seed via teleport
    expect(result.get('A')!).toBeGreaterThan(result.get('B')!);
    expect(result.get('A')!).toBeGreaterThan(result.get('C')!);
  });

  it('propagates probability through edges', () => {
    const nodes = ['A', 'B', 'C'];
    const edges = [
      { source: 'A', target: 'B', weight: 1 },
      { source: 'B', target: 'A', weight: 1 },
      { source: 'B', target: 'C', weight: 1 },
      { source: 'C', target: 'B', weight: 1 },
    ];
    const result = computePPR(nodes, edges, ['A']);

    // A should have highest score (seed + teleport)
    expect(result.get('A')!).toBeGreaterThan(result.get('C')!);
    // B should be higher than C (directly connected to seed)
    expect(result.get('B')!).toBeGreaterThan(result.get('C')!);
    // C should still get some score via propagation through B
    expect(result.get('C')!).toBeGreaterThan(0);
  });

  it('scores sum to approximately 1.0', () => {
    const nodes = ['A', 'B', 'C', 'D'];
    const edges = [
      { source: 'A', target: 'B', weight: 1 },
      { source: 'B', target: 'A', weight: 1 },
      { source: 'B', target: 'C', weight: 1 },
      { source: 'C', target: 'B', weight: 1 },
      { source: 'C', target: 'D', weight: 1 },
      { source: 'D', target: 'C', weight: 1 },
    ];
    const result = computePPR(nodes, edges, ['A']);

    let total = 0;
    for (const score of result.values()) {
      total += score;
    }
    expect(total).toBeCloseTo(1.0, 2);
  });

  it('handles multiple seed nodes', () => {
    const nodes = ['A', 'B', 'C'];
    const edges = [
      { source: 'A', target: 'B', weight: 1 },
      { source: 'B', target: 'A', weight: 1 },
      { source: 'B', target: 'C', weight: 1 },
      { source: 'C', target: 'B', weight: 1 },
    ];
    const result = computePPR(nodes, edges, ['A', 'C']);

    // Both seeds should have meaningful probability
    expect(result.get('A')!).toBeGreaterThan(0.1);
    expect(result.get('C')!).toBeGreaterThan(0.1);
  });

  it('respects edge weights', () => {
    const nodes = ['A', 'B', 'C'];
    const edges = [
      { source: 'A', target: 'B', weight: 10 },
      { source: 'B', target: 'A', weight: 10 },
      { source: 'A', target: 'C', weight: 1 },
      { source: 'C', target: 'A', weight: 1 },
    ];
    const result = computePPR(nodes, edges, ['A']);

    // B should get more score than C (higher edge weight)
    expect(result.get('B')!).toBeGreaterThan(result.get('C')!);
  });

  it('converges with different alpha values', () => {
    // Use a larger graph where alpha differences are more pronounced
    const nodes = ['A', 'B', 'C', 'D'];
    const edges = [
      { source: 'A', target: 'B', weight: 1 },
      { source: 'B', target: 'A', weight: 1 },
      { source: 'B', target: 'C', weight: 1 },
      { source: 'C', target: 'B', weight: 1 },
      { source: 'C', target: 'D', weight: 1 },
      { source: 'D', target: 'C', weight: 1 },
    ];

    const lowAlpha = computePPR(nodes, edges, ['A'], 0.05);
    const highAlpha = computePPR(nodes, edges, ['A'], 0.5);

    // Higher alpha = more teleport = more probability stays on seed
    expect(highAlpha.get('A')!).toBeGreaterThan(lowAlpha.get('A')!);
    // Lower alpha = more propagation = distant nodes get more score
    expect(lowAlpha.get('D')!).toBeGreaterThan(highAlpha.get('D')!);
  });

  it('returns zero scores for invalid seed IDs', () => {
    const nodes = ['A', 'B'];
    const edges = [
      { source: 'A', target: 'B', weight: 1 },
      { source: 'B', target: 'A', weight: 1 },
    ];
    const result = computePPR(nodes, edges, ['nonexistent']);

    for (const score of result.values()) {
      expect(score).toBe(0);
    }
  });

  it('handles star topology correctly', () => {
    // Hub A connected to spokes B, C, D, E
    const nodes = ['A', 'B', 'C', 'D', 'E'];
    const edges = [
      { source: 'A', target: 'B', weight: 1 },
      { source: 'B', target: 'A', weight: 1 },
      { source: 'A', target: 'C', weight: 1 },
      { source: 'C', target: 'A', weight: 1 },
      { source: 'A', target: 'D', weight: 1 },
      { source: 'D', target: 'A', weight: 1 },
      { source: 'A', target: 'E', weight: 1 },
      { source: 'E', target: 'A', weight: 1 },
    ];
    const result = computePPR(nodes, edges, ['B']);

    // A (hub) should get high score since it's the only connection from B
    expect(result.get('A')!).toBeGreaterThan(result.get('C')!);
    // C, D, E should all get similar (lower) scores
    expect(result.get('C')!).toBeCloseTo(result.get('D')!, 4);
    expect(result.get('D')!).toBeCloseTo(result.get('E')!, 4);
  });
});

// ─── Community Detection Tests ───────────────────────────────

import { detectCommunities, searchCommunities } from '../src/search/communities.js';
import type { Community } from '../src/search/communities.js';

describe('Community Detection (detectCommunities)', () => {
  it('assigns each node its own community when no edges', () => {
    const nodes = ['A', 'B', 'C'];
    const labels = detectCommunities(nodes, []);

    // Each node should have a unique label
    const uniqueLabels = new Set(labels.values());
    expect(uniqueLabels.size).toBe(3);
  });

  it('merges fully connected clique into one community', () => {
    const nodes = ['A', 'B', 'C'];
    const edges = [
      { source: 'A', target: 'B', weight: 1 },
      { source: 'B', target: 'C', weight: 1 },
      { source: 'A', target: 'C', weight: 1 },
    ];
    const labels = detectCommunities(nodes, edges);

    // All nodes should share the same label
    expect(labels.get('A')).toBe(labels.get('B'));
    expect(labels.get('B')).toBe(labels.get('C'));
  });

  it('detects two separate communities', () => {
    const nodes = ['A', 'B', 'C', 'D', 'E', 'F'];
    const edges = [
      // Community 1: A-B-C (strongly connected)
      { source: 'A', target: 'B', weight: 5 },
      { source: 'B', target: 'C', weight: 5 },
      { source: 'A', target: 'C', weight: 5 },
      // Community 2: D-E-F (strongly connected)
      { source: 'D', target: 'E', weight: 5 },
      { source: 'E', target: 'F', weight: 5 },
      { source: 'D', target: 'F', weight: 5 },
      // Weak bridge between communities
      { source: 'C', target: 'D', weight: 0.1 },
    ];
    const labels = detectCommunities(nodes, edges);

    // A, B, C should share a label
    expect(labels.get('A')).toBe(labels.get('B'));
    expect(labels.get('B')).toBe(labels.get('C'));

    // D, E, F should share a label
    expect(labels.get('D')).toBe(labels.get('E'));
    expect(labels.get('E')).toBe(labels.get('F'));

    // The two communities should have different labels
    expect(labels.get('A')).not.toBe(labels.get('D'));
  });

  it('handles single node', () => {
    const labels = detectCommunities(['A'], []);
    expect(labels.get('A')).toBe(0);
  });

  it('handles empty input', () => {
    const labels = detectCommunities([], []);
    expect(labels.size).toBe(0);
  });
});

describe('Community Search (searchCommunities)', () => {
  const testCommunities: Community[] = [
    {
      id: 0,
      memberIds: ['e1', 'e2'],
      memberNames: ['Ingest Worker', 'Parser Service'],
      summary: 'This community contains ingestion components that process documents and produce normalized records.',
      level: 0,
      updatedAt: new Date(),
    },
    {
      id: 1,
      memberIds: ['e3', 'e4'],
      memberNames: ['Search API', 'Ranking Service'],
      summary: 'This community represents retrieval components that rank search results and serve query responses.',
      level: 0,
      updatedAt: new Date(),
    },
    {
      id: 2,
      memberIds: ['e5'],
      memberNames: ['Analytics Event Stream'],
      summary: 'Analytics event stream focused on usage metrics and product telemetry.',
      level: 0,
      updatedAt: new Date(),
    },
  ];

  it('returns semantically matching communities', async () => {
    const results = await searchCommunities(testCommunities, 'normalized records');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('normalized');
  });

  it('ranks more relevant communities higher', async () => {
    const results = await searchCommunities(testCommunities, 'rank query responses');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('query responses');
  });

  it('returns empty for unrelated query', async () => {
    const results = await searchCommunities(testCommunities, 'xyzzy qwerty');
    expect(results.length).toBe(0);
  });

  it('respects limit parameter', async () => {
    const results = await searchCommunities(testCommunities, 'service', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('includes community metadata in results', async () => {
    const results = await searchCommunities(testCommunities, 'ingestion documents');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].metadata.memberNames).toBeDefined();
    expect(results[0].metadata.memberIds).toBeDefined();
    expect(results[0].type).toBe('entity');
  });
});

// ─── RRF Fusion Tests ────────────────────────────────────────

import { rrfFusion } from '../src/search/index.js';
import type { SearchResult } from '../src/types.js';

describe('Reciprocal Rank Fusion (rrfFusion)', () => {
  it('returns empty array for empty input', () => {
    const result = rrfFusion([]);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty result lists', () => {
    const result = rrfFusion([[], []]);
    expect(result).toEqual([]);
  });

  it('passes through single list results', () => {
    const list: SearchResult[] = [
      { type: 'entity', id: '1', score: 0.9, content: 'A', metadata: {} },
      { type: 'entity', id: '2', score: 0.8, content: 'B', metadata: {} },
    ];
    const result = rrfFusion([list]);
    expect(result.length).toBe(2);
    // Rank 0 gets score 1/(60+0) = 0.01667, rank 1 gets 1/(60+1) = 0.01639
    // After normalization, first should be 1.0
    expect(result.find(r => r.id === '1')!.score).toBeCloseTo(1.0, 2);
  });

  it('boosts items appearing in multiple lists', () => {
    const list1: SearchResult[] = [
      { type: 'entity', id: 'shared', score: 0.9, content: 'Shared', metadata: {} },
      { type: 'entity', id: 'only1', score: 0.8, content: 'Only1', metadata: {} },
    ];
    const list2: SearchResult[] = [
      { type: 'entity', id: 'shared', score: 0.7, content: 'Shared', metadata: {} },
      { type: 'entity', id: 'only2', score: 0.6, content: 'Only2', metadata: {} },
    ];
    const result = rrfFusion([list1, list2]);

    const sharedScore = result.find(r => r.id === 'shared')!.score;
    const only1Score = result.find(r => r.id === 'only1')!.score;
    const only2Score = result.find(r => r.id === 'only2')!.score;

    // Shared item appears in both lists so should score higher
    expect(sharedScore).toBeGreaterThan(only1Score);
    expect(sharedScore).toBeGreaterThan(only2Score);
  });

  it('normalizes scores to 0-1 range', () => {
    const list: SearchResult[] = [
      { type: 'entity', id: '1', score: 0.9, content: 'A', metadata: {} },
      { type: 'entity', id: '2', score: 0.5, content: 'B', metadata: {} },
      { type: 'entity', id: '3', score: 0.1, content: 'C', metadata: {} },
    ];
    const result = rrfFusion([list]);

    for (const r of result) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    // Best result should be normalized to 1.0
    const maxScore = Math.max(...result.map(r => r.score));
    expect(maxScore).toBeCloseTo(1.0, 2);
  });

  it('deduplicates by type:id key', () => {
    const list1: SearchResult[] = [
      { type: 'fact', id: 'f1', score: 0.9, content: 'Fact 1', metadata: {} },
    ];
    const list2: SearchResult[] = [
      { type: 'fact', id: 'f1', score: 0.8, content: 'Fact 1 again', metadata: {} },
    ];
    const result = rrfFusion([list1, list2]);

    expect(result.length).toBe(1);
    expect(result[0].id).toBe('f1');
  });

  it('distinguishes items with same ID but different type', () => {
    const list: SearchResult[] = [
      { type: 'entity', id: 'x1', score: 0.9, content: 'Entity X1', metadata: {} },
      { type: 'fact', id: 'x1', score: 0.8, content: 'Fact X1', metadata: {} },
    ];
    const result = rrfFusion([list]);

    expect(result.length).toBe(2);
  });

  it('fuses three lists correctly', () => {
    const lists: SearchResult[][] = [
      [{ type: 'entity', id: 'a', score: 1, content: 'A', metadata: {} }],
      [{ type: 'entity', id: 'a', score: 1, content: 'A', metadata: {} }],
      [{ type: 'entity', id: 'a', score: 1, content: 'A', metadata: {} }],
    ];
    const result = rrfFusion(lists);

    expect(result.length).toBe(1);
    // Item appears in all 3 lists at rank 0, so score = 3 * 1/(60+0) normalized to 1.0
    expect(result[0].score).toBeCloseTo(1.0, 2);
  });
});
