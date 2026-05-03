import type { GroundedAnswer } from '../answer/index.js';
import type { EpisodeInput, SearchOptions, SearchResult } from '../types.js';

export interface EvalFixture {
  id: string;
  domain: string;
  description: string;
  episodes: EpisodeInput[];
  expectations: EvalExpectations;
}

export interface EvalExpectations {
  minEntitiesCreated?: number;
  minFactsCreated?: number;
  requiredEntities?: string[];
  requiredFacts?: string[];
  forbiddenFacts?: string[];
  queries: EvalQueryExpectation[];
}

export interface EvalQueryExpectation {
  id: string;
  query: string;
  access?: SearchOptions['access'];
  minResults?: number;
  mustInclude?: string[];
  mustNotInclude?: string[];
  answerMustInclude?: string[];
  answerMustNotInclude?: string[];
  requireCitations?: boolean;
  minAnswerConfidence?: number;
}

export interface EvalAdapter {
  reset?(fixture: EvalFixture): Promise<void>;
  ingest(input: EpisodeInput): Promise<{ entitiesCreated: number; factsCreated: number }>;
  search(options: SearchOptions): Promise<SearchResult[]>;
  answer?(options: SearchOptions): Promise<GroundedAnswer>;
}

export interface EvalRunResult {
  fixtureId: string;
  domain: string;
  score: number;
  passed: boolean;
  metrics: {
    entitiesCreated: number;
    factsCreated: number;
    extractionPassRate: number;
    queryPassRate: number;
  };
  queryResults: EvalQueryResult[];
}

export interface EvalQueryResult {
  id: string;
  query: string;
  score: number;
  passed: boolean;
  resultCount: number;
  missingIncludes: string[];
  unexpectedIncludes: string[];
  answer?: {
    text: string;
    confidence: number;
    citationCount: number;
    missingIncludes: string[];
    unexpectedIncludes: string[];
  };
}

export async function runEvalFixture(adapter: EvalAdapter, fixture: EvalFixture): Promise<EvalRunResult> {
  await adapter.reset?.(fixture);

  let entitiesCreated = 0;
  let factsCreated = 0;
  const ingestionCorpus: string[] = [];
  for (const episode of fixture.episodes) {
    const result = await adapter.ingest(episode);
    entitiesCreated += result.entitiesCreated;
    factsCreated += result.factsCreated;
    ingestionCorpus.push(`${episode.content} ${JSON.stringify(episode.metadata || {})}`);
  }

  const queryResults: EvalQueryResult[] = [];
  for (const expectation of fixture.expectations.queries) {
    const results = await adapter.search({
      query: expectation.query,
      access: expectation.access,
      limit: Math.max(expectation.minResults || 5, 5),
    });
    const answer = adapter.answer && hasAnswerExpectations(expectation)
      ? await adapter.answer({
        query: expectation.query,
        access: expectation.access,
        limit: Math.max(expectation.minResults ?? 5, 5),
      })
      : undefined;
    queryResults.push(scoreQuery(expectation, results, answer));
  }

  const extractionScore = scoreExtraction(fixture.expectations, { entitiesCreated, factsCreated }, ingestionCorpus);
  const queryPassRate = queryResults.length === 0
    ? 1
    : queryResults.filter(result => result.passed).length / queryResults.length;
  const score = roundScore((extractionScore + queryPassRate) / 2);

  return {
    fixtureId: fixture.id,
    domain: fixture.domain,
    score,
    passed: score >= 0.8 && queryResults.every(result => result.passed),
    metrics: {
      entitiesCreated,
      factsCreated,
      extractionPassRate: extractionScore,
      queryPassRate,
    },
    queryResults,
  };
}

export async function runEvalSuite(adapter: EvalAdapter, fixtures: EvalFixture[]): Promise<EvalRunResult[]> {
  const results: EvalRunResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runEvalFixture(adapter, fixture));
  }
  return results;
}

export function summarizeEvalResults(results: EvalRunResult[]): {
  score: number;
  passed: boolean;
  fixtureCount: number;
  passedFixtures: number;
} {
  const fixtureCount = results.length;
  const passedFixtures = results.filter(result => result.passed).length;
  const score = fixtureCount === 0
    ? 1
    : roundScore(results.reduce((sum, result) => sum + result.score, 0) / fixtureCount);

  return {
    score,
    passed: fixtureCount > 0 && passedFixtures === fixtureCount,
    fixtureCount,
    passedFixtures,
  };
}

export function scoreQuery(
  expectation: EvalQueryExpectation,
  results: SearchResult[],
  answer?: GroundedAnswer,
): EvalQueryResult {
  const corpus = results.map(result => `${result.content} ${JSON.stringify(result.metadata)}`).join('\n').toLowerCase();
  const missingIncludes = (expectation.mustInclude || []).filter(term => !corpus.includes(term.toLowerCase()));
  const unexpectedIncludes = (expectation.mustNotInclude || []).filter(term => corpus.includes(term.toLowerCase()));
  const hasEnoughResults = results.length >= (expectation.minResults ?? 1);
  const answerScore = answer ? scoreAnswer(expectation, answer) : undefined;
  const passed = hasEnoughResults &&
    missingIncludes.length === 0 &&
    unexpectedIncludes.length === 0 &&
    (answerScore?.passed ?? true);

  const checks = [
    hasEnoughResults,
    ...(expectation.mustInclude || []).map(term => !missingIncludes.includes(term)),
    ...(expectation.mustNotInclude || []).map(term => !unexpectedIncludes.includes(term)),
    ...(answerScore ? [answerScore.passed] : []),
  ];
  const score = checks.length === 0
    ? 1
    : checks.filter(Boolean).length / checks.length;

  return {
    id: expectation.id,
    query: expectation.query,
    score: roundScore(score),
    passed,
    resultCount: results.length,
    missingIncludes,
    unexpectedIncludes,
    answer: answerScore?.summary,
  };
}

function scoreAnswer(expectation: EvalQueryExpectation, answer: GroundedAnswer): {
  passed: boolean;
  summary: EvalQueryResult['answer'];
} {
  const answerText = `${answer.answer} ${answer.inference.join(' ')} ${answer.missing.join(' ')}`.toLowerCase();
  const missingIncludes = (expectation.answerMustInclude || []).filter(term => !answerText.includes(term.toLowerCase()));
  const unexpectedIncludes = (expectation.answerMustNotInclude || []).filter(term => answerText.includes(term.toLowerCase()));
  const hasCitations = !expectation.requireCitations || answer.citations.length > 0;
  const confidenceOk = answer.confidence >= (expectation.minAnswerConfidence ?? 0);
  return {
    passed: missingIncludes.length === 0 && unexpectedIncludes.length === 0 && hasCitations && confidenceOk,
    summary: {
      text: answer.answer,
      confidence: answer.confidence,
      citationCount: answer.citations.length,
      missingIncludes,
      unexpectedIncludes,
    },
  };
}

function hasAnswerExpectations(expectation: EvalQueryExpectation): boolean {
  return Boolean(
    expectation.answerMustInclude?.length ||
    expectation.answerMustNotInclude?.length ||
    expectation.requireCitations ||
    expectation.minAnswerConfidence != null,
  );
}

function scoreExtraction(
  expectations: EvalExpectations,
  counts: { entitiesCreated: number; factsCreated: number },
  ingestionCorpus: string[],
): number {
  const checks: boolean[] = [];
  if (expectations.minEntitiesCreated != null) checks.push(counts.entitiesCreated >= expectations.minEntitiesCreated);
  if (expectations.minFactsCreated != null) checks.push(counts.factsCreated >= expectations.minFactsCreated);

  const corpus = ingestionCorpus.join('\n').toLowerCase();
  for (const entity of expectations.requiredEntities || []) {
    checks.push(corpus.includes(entity.toLowerCase()));
  }
  for (const fact of expectations.requiredFacts || []) {
    checks.push(corpus.includes(fact.toLowerCase()));
  }
  for (const fact of expectations.forbiddenFacts || []) {
    checks.push(!corpus.includes(fact.toLowerCase()));
  }

  if (checks.length === 0) return 1;
  return checks.filter(Boolean).length / checks.length;
}

function scoreMinimums(
  actual: { entitiesCreated: number; factsCreated: number },
  minimums: { entitiesCreated?: number; factsCreated?: number },
): number {
  const checks: boolean[] = [];
  if (minimums.entitiesCreated != null) checks.push(actual.entitiesCreated >= minimums.entitiesCreated);
  if (minimums.factsCreated != null) checks.push(actual.factsCreated >= minimums.factsCreated);
  if (checks.length === 0) return 1;
  return checks.filter(Boolean).length / checks.length;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
