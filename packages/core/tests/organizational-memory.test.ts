import { describe, expect, it } from 'vitest';
import { deriveOrganizationalMemory } from '../src/index.js';

describe('organizational memory', () => {
  it('does not derive semantic memory without an LLM', async () => {
    const oldOpenAI = process.env.OPENAI_API_KEY;
    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const objects = await deriveOrganizationalMemory('Mina decided to keep the legacy read path. Samir owns the patch.', {
        groupId: 'default',
        episodeId: '00000000-0000-0000-0000-000000000001',
        sourceType: 'raw_dump',
        validAt: new Date('2026-01-01T00:00:00Z'),
      });

      expect(objects).toEqual([]);
    } finally {
      if (oldOpenAI) process.env.OPENAI_API_KEY = oldOpenAI;
      if (oldAnthropic) process.env.ANTHROPIC_API_KEY = oldAnthropic;
    }
  });
});
