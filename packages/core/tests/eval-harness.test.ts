import { describe, expect, it } from 'vitest';
import type { EvalAdapter, EvalFixture, EpisodeInput, GroundedAnswer, SearchOptions, SearchResult } from '../src/index.js';
import { baselineEvalFixtures, pressureEvalFixtures, runEvalFixture, runEvalSuite, scoreQuery, summarizeEvalResults } from '../src/index.js';
import { canAccessVisibility } from '../src/security.js';

class MemoryEvalAdapter implements EvalAdapter {
  private episodes: EpisodeInput[] = [];

  async reset(): Promise<void> {
    this.episodes = [];
  }

  async ingest(input: EpisodeInput): Promise<{ entitiesCreated: number; factsCreated: number }> {
    this.episodes.push(input);
    return { entitiesCreated: 2, factsCreated: 2 };
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const accessible = this.episodes
      .filter(episode => canAccessVisibility(episode.visibility, options.access));
    if (!accessible.some(episode => matchesQuery(episode.content, options.query))) return [];

    return accessible.map((episode, index) => ({
        type: 'episode' as const,
        id: episode.sourceId || `${index}`,
        score: 1,
        content: episode.content,
        metadata: { sourceType: episode.sourceType },
      }));
  }

  async answer(options: SearchOptions): Promise<GroundedAnswer> {
    const results = await this.search(options);
    const citations = results.slice(0, 3).map((result, index) => ({
      id: `C${index + 1}`,
      resultId: result.id,
      type: result.type,
      content: result.content,
      confidence: result.score,
    }));
    return {
      query: options.query,
      answer: citations.map(citation => `${citation.content} [${citation.id}]`).join(' '),
      citations,
      inference: [],
      missing: [],
      confidence: citations.length > 0 ? 0.8 : 0,
      results,
    };
  }
}

describe('eval harness', () => {
  it('scores query expectations with required and forbidden terms', () => {
    const result = scoreQuery(
      {
        id: 'security',
        query: 'candidate feedback',
        mustInclude: ['onsite'],
        mustNotInclude: ['private_note'],
      },
      [{
        type: 'episode',
        id: '1',
        score: 1,
        content: 'Omar moved to onsite.',
        metadata: {},
      }],
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('runs baseline fixtures across multiple domains', async () => {
    const results = await runEvalSuite(new MemoryEvalAdapter(), baselineEvalFixtures);
    const summary = summarizeEvalResults(results);

    expect(results.map(result => result.domain).sort()).toEqual(['engineering', 'hiring', 'investment', 'product', 'security', 'support']);
    expect(summary.fixtureCount).toBe(6);
    expect(summary.score).toBeGreaterThan(0);
  });

  it('ships high-pressure messy fixtures for eval corpus stress testing', () => {
    expect(pressureEvalFixtures.length).toBeGreaterThanOrEqual(4);
    expect(pressureEvalFixtures.some(fixture => fixture.expectations.queries.some(query => query.requireCitations))).toBe(true);
    expect(pressureEvalFixtures.some(fixture => fixture.expectations.queries.some(query => query.access))).toBe(true);
    expect(pressureEvalFixtures.some(fixture => fixture.id === 'source-acl-pressure')).toBe(true);
    expect(pressureEvalFixtures.some(fixture => fixture.expectations.forbiddenFacts?.includes('pizza deploy root cause'))).toBe(true);
  });

  it('scores grounded answer expectations with citations', () => {
    const result = scoreQuery(
      {
        id: 'answer',
        query: 'what happened?',
        answerMustInclude: ['rotated token'],
        answerMustNotInclude: ['root cause was'],
        requireCitations: true,
        minAnswerConfidence: 0.5,
      },
      [{
        type: 'fact',
        id: 'f1',
        score: 1,
        content: 'Nora rotated token.',
        metadata: {},
      }],
      {
        query: 'what happened?',
        answer: 'Nora rotated token. [C1]',
        citations: [{
          id: 'C1',
          resultId: 'f1',
          type: 'fact',
          content: 'Nora rotated token.',
          confidence: 0.9,
        }],
        inference: [],
        missing: [],
        confidence: 0.9,
        results: [],
      },
    );

    expect(result.passed).toBe(true);
    expect(result.answer?.citationCount).toBe(1);
  });

  it('enforces fixture access expectations in the adapter contract', async () => {
    const fixture: EvalFixture = baselineEvalFixtures.find(f => f.id === 'hiring-ops-baseline')!;
    const result = await runEvalFixture(new MemoryEvalAdapter(), fixture);
    const hiddenFeedback = result.queryResults.find(q => q.id === 'restricted-feedback-hidden')!;
    const visibleFeedback = result.queryResults.find(q => q.id === 'restricted-feedback-visible')!;

    expect(hiddenFeedback.passed).toBe(true);
    expect(visibleFeedback.passed).toBe(true);
  });
});

function matchesQuery(content: string, query: string): boolean {
  const normalized = content.toLowerCase();
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(term => term.length > 3);

  return terms.some(term => normalized.includes(term));
}
