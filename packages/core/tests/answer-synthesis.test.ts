import { describe, expect, it } from 'vitest';
import { assessAnswerRelevance } from '../src/answer/synthesis.js';

describe('answer synthesis relevance gate', () => {
  it('fails closed when no LLM relevance checker is configured', async () => {
    const oldOpenAI = process.env.OPENAI_API_KEY;
    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const relevance = await assessAnswerRelevance('What happened in incident 77?', [
        {
          id: 'C1',
          resultId: 'atlas',
          type: 'memory',
          content: 'Project Atlas is blocked by replay tests and idempotency work.',
        },
        {
          id: 'C2',
          resultId: 'apex',
          type: 'memory',
          content: 'Apex Health is blocked by SSO provisioning.',
        },
      ]);

      expect(relevance.canAnswer).toBe(false);
      expect(relevance.missing).toContain('No LLM relevance checker was configured.');
    } finally {
      if (oldOpenAI) process.env.OPENAI_API_KEY = oldOpenAI;
      if (oldAnthropic) process.env.ANTHROPIC_API_KEY = oldAnthropic;
    }
  });
});
