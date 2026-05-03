import type { LLMConfig, TriageConfig } from '../types.js';
import { triageInteractionWithLLM } from '../triage/index.js';
import { triagePressureFixtures, type TriageEvalCase } from './triage-fixtures.js';

export interface TriageEvalResult {
  id: string;
  expectedRetention: TriageEvalCase['expectedRetention'];
  actualRetention: TriageEvalCase['expectedRetention'];
  passed: boolean;
  score: number;
  reasons: string[];
  signals: string[];
}

export async function runTriageEvalSuite(options?: {
  fixtures?: TriageEvalCase[];
  llmConfig?: LLMConfig;
  triageConfig?: TriageConfig;
}): Promise<TriageEvalResult[]> {
  const fixtures = options?.fixtures || triagePressureFixtures;
  const results: TriageEvalResult[] = [];
  for (const fixture of fixtures) {
    const decision = await triageInteractionWithLLM(fixture.content, {
      sourceType: fixture.sourceType,
      llmConfig: options?.llmConfig,
      config: options?.triageConfig,
    });
    results.push({
      id: fixture.id,
      expectedRetention: fixture.expectedRetention,
      actualRetention: decision.retention,
      passed: decision.retention === fixture.expectedRetention,
      score: decision.durableMemoryScore,
      reasons: decision.reasons,
      signals: decision.signals,
    });
  }
  return results;
}

export function summarizeTriageEvalResults(results: TriageEvalResult[]): {
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
} {
  const passed = results.filter(result => result.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    accuracy: results.length === 0 ? 0 : Math.round((passed / results.length) * 1000) / 1000,
  };
}
