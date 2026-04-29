/**
 * Unit tests for the skill resolver.
 * No database required.
 */

import { describe, it, expect } from 'vitest';
import { SkillResolver } from '../src/skills/resolver.js';
import { DEFAULT_SKILLS } from '../src/skills/defaults.js';

describe('SkillResolver', () => {
  it('loads default skills on construction', () => {
    const resolver = new SkillResolver();
    const skills = resolver.list();
    expect(skills.length).toBe(DEFAULT_SKILLS.length);
  });

  it('resolves "what do we know about Acme" to the query skill', () => {
    const resolver = new SkillResolver();
    const match = resolver.resolve('what do we know about Acme');
    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('query');
    expect(match!.confidence).toBeGreaterThan(0.5);
  });

  it('resolves "search for Alice" to the query skill', () => {
    const resolver = new SkillResolver();
    const match = resolver.resolve('search for Alice in the brain');
    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('query');
  });

  it('resolves "enrich this person" to the enrich skill', () => {
    const resolver = new SkillResolver();
    const match = resolver.resolve('enrich this person');
    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('enrich');
  });

  it('resolves "meeting notes from today" to the ingest-meeting skill', () => {
    const resolver = new SkillResolver();
    const match = resolver.resolve('here are the meeting notes from today');
    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('ingest-meeting');
  });

  it('resolves "show timeline for Acme" to the timeline skill', () => {
    const resolver = new SkillResolver();
    const match = resolver.resolve('show me the timeline for Acme');
    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('timeline');
  });

  it('resolves "extraction stats" to the extraction-review skill', () => {
    const resolver = new SkillResolver();
    const match = resolver.resolve('show me extraction stats');
    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('extraction-review');
  });

  it('returns low or no match for unrelated input', () => {
    const resolver = new SkillResolver();
    const match = resolver.resolve('the quick brown fox jumps over the lazy dog');
    // Completely unrelated input should have no match or very low confidence
    if (match) {
      expect(match.confidence).toBeLessThan(0.5);
    }
  });

  it('returns always-on skills', () => {
    const resolver = new SkillResolver();
    const alwaysOn = resolver.getAlwaysOn();
    expect(alwaysOn.length).toBe(2); // signal-detector and brain-ops
    expect(alwaysOn.map(s => s.id)).toContain('signal-detector');
    expect(alwaysOn.map(s => s.id)).toContain('brain-ops');
  });

  it('can register custom skills', () => {
    const resolver = new SkillResolver();
    resolver.register({
      id: 'custom-skill',
      name: 'Custom',
      description: 'A custom skill',
      triggers: ['do the custom thing'],
      content: 'Custom SOP here',
    });

    const match = resolver.resolve('do the custom thing');
    expect(match).not.toBeNull();
    expect(match!.skill.id).toBe('custom-skill');
    expect(match!.confidence).toBe(1.0); // exact match
  });

  it('can unregister skills', () => {
    const resolver = new SkillResolver();
    const before = resolver.list().length;
    resolver.unregister('query');
    expect(resolver.list().length).toBe(before - 1);
    expect(resolver.get('query')).toBeUndefined();
  });

  it('generates a routing table', () => {
    const resolver = new SkillResolver();
    const table = resolver.toRoutingTable();
    expect(table).toContain('| Skill |');
    expect(table).toContain('Signal Detector');
    expect(table).toContain('Query Brain');
  });

  it('resolves multiple matches sorted by confidence', () => {
    const resolver = new SkillResolver();
    const matches = resolver.resolveAll('search for information about this person');
    expect(matches.length).toBeGreaterThan(0);
    // Should be sorted by confidence desc
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(matches[i].confidence);
    }
  });
});
