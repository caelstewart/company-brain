import { describe, expect, it } from 'vitest';
import { triageInteraction } from '../src/index.js';

describe('interaction triage', () => {
  it('fails closed to ephemeral when no LLM is configured', async () => {
    const triage = await triageInteraction('yeah sounds good', {
      sourceType: 'chat_message',
      config: { llmEnabled: false },
    });

    expect(triage.retention).toBe('ephemeral');
    expect(triage.shouldStoreEpisode).toBe(true);
    expect(triage.shouldExtract).toBe(false);
    expect(triage.shouldStoreMemory).toBe(false);
    expect(triage.reasons[0]).toContain('disabled');
  });

  it('can bypass triage for trusted/admin imports', async () => {
    const triage = await triageInteraction('trusted historical import', {
      config: { enabled: false },
    });
    expect(triage.retention).toBe('durable');
    expect(triage.shouldStoreEpisode).toBe(true);
    expect(triage.shouldExtract).toBe(true);
  });

  it('respects storeEphemeral=false when LLM is unavailable', async () => {
    const triage = await triageInteraction('unclassified source text', {
      sourceType: 'chat_message',
      config: { llmEnabled: false, storeEphemeral: false },
    });

    expect(triage.retention).toBe('ephemeral');
    expect(triage.shouldStoreEpisode).toBe(false);
    expect(triage.shouldExtract).toBe(false);
  });
});
