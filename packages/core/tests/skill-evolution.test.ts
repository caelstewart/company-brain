import { describe, expect, it } from 'vitest';
import { skillFromProposal, validateSkill } from '../src/index.js';
import type { ImprovementProposal } from '../src/index.js';

describe('skill evolution', () => {
  it('turns a skill proposal into a valid SOP skill', () => {
    const proposal: ImprovementProposal = {
      id: 'p1',
      kind: 'skill',
      title: 'Handle hiring debriefs',
      rationale: 'Hiring debriefs appear repeatedly and need a repeatable extraction workflow.',
      confidence: 0.9,
      evidence: { occurrences: 4 },
      proposedAction: {
        triggers: ['hiring debrief', 'candidate feedback'],
      },
    };

    const skill = skillFromProposal(proposal);
    const validation = validateSkill(skill);

    expect(skill.id).toBe('handle-hiring-debriefs');
    expect(skill.triggers).toContain('hiring debrief');
    expect(skill.content).toContain('Procedure');
    expect(validation.score).toBe(1);
  });
});
