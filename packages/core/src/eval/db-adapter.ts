import type { Brain } from '../index.js';
import type { GroundedAnswer } from '../answer/index.js';
import type { EpisodeInput, SearchOptions, SearchResult } from '../types.js';
import type { EvalAdapter, EvalFixture, EvalRunResult } from './harness.js';
import { runEvalSuite } from './harness.js';

export class BrainEvalAdapter implements EvalAdapter {
  constructor(
    private brain: Brain,
    private options: { groupPrefix?: string; resetGroup?: (groupId: string) => Promise<void> } = {},
  ) {}

  private currentGroupId = 'eval';

  async reset(fixture: EvalFixture): Promise<void> {
    this.currentGroupId = `${this.options.groupPrefix || 'eval'}-${fixture.id}-${Date.now()}`;
    await this.options.resetGroup?.(this.currentGroupId);
  }

  async ingest(input: EpisodeInput): Promise<{ entitiesCreated: number; factsCreated: number }> {
    const result = await this.brain.ingest({
      ...input,
      groupId: this.currentGroupId,
    });
    return {
      entitiesCreated: result.entitiesCreated,
      factsCreated: result.factsCreated,
    };
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    return this.brain.search({
      ...options,
      groupId: this.currentGroupId,
    });
  }

  async answer(options: SearchOptions): Promise<GroundedAnswer> {
    return this.brain.answer({
      ...options,
      groupId: this.currentGroupId,
    });
  }
}

export async function runDbBackedEvalSuite(
  brain: Brain,
  fixtures: EvalFixture[],
  options?: { groupPrefix?: string },
): Promise<EvalRunResult[]> {
  const adapter = new BrainEvalAdapter(brain, options);
  return runEvalSuite(adapter, fixtures);
}
