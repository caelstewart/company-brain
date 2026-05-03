import type postgres from 'postgres';
import type { ImprovementProposal } from '../types.js';
import type { Skill } from './types.js';
import { SkillResolver } from './resolver.js';
import { saveSkillToDir } from './loader.js';

export interface SkillPromotionOptions {
  groupId: string;
  skillsDir?: string;
  minConfidence?: number;
  autoPromote?: boolean;
}

export interface SkillPromotionResult {
  skill: Skill;
  status: 'draft' | 'validated' | 'promoted' | 'rejected';
  score: number;
  tests: Array<{ name: string; passed: boolean; message: string }>;
  filepath?: string;
}

export async function promoteSkillsFromProposals(
  db: postgres.Sql,
  proposals: ImprovementProposal[],
  options: SkillPromotionOptions,
): Promise<SkillPromotionResult[]> {
  const results: SkillPromotionResult[] = [];
  const resolver = new SkillResolver({ skillsDir: options.skillsDir });
  await resolver.loadFromDir();

  for (const proposal of proposals.filter(p => p.kind === 'skill')) {
    if (proposal.confidence < (options.minConfidence ?? 0.7)) continue;
    const skill = skillFromProposal(proposal);
    const validation = validateSkill(skill, resolver);
    const shouldPromote = options.autoPromote !== false && validation.score >= 0.8 && Boolean(options.skillsDir);
    const filepath = shouldPromote ? await saveSkillToDir(options.skillsDir!, skill) : undefined;
    if (shouldPromote) resolver.register(skill);

    const result: SkillPromotionResult = {
      skill,
      status: shouldPromote ? 'promoted' : validation.score >= 0.8 ? 'validated' : 'rejected',
      score: validation.score,
      tests: validation.tests,
      filepath,
    };
    results.push(result);
    await persistPromotion(db, options.groupId, proposal, result);
  }

  return results;
}

export function skillFromProposal(proposal: ImprovementProposal): Skill {
  const proposed = proposal.proposedAction || {};
  const id = slug(String(proposed.id || proposal.title || proposal.id));
  const triggers = Array.isArray(proposed.triggers)
    ? proposed.triggers.map(String)
    : deriveTriggers(proposal);
  const content = typeof proposed.content === 'string' && proposed.content.trim()
    ? proposed.content
    : renderSkillContent(proposal, triggers);

  return {
    id,
    name: String(proposed.name || proposal.title || id),
    description: proposal.rationale || `Skill generated from proposal ${proposal.id}`,
    triggers,
    content,
    priority: typeof proposed.priority === 'number' ? proposed.priority : 60,
  };
}

export function validateSkill(skill: Skill, resolver?: SkillResolver): {
  score: number;
  tests: Array<{ name: string; passed: boolean; message: string }>;
} {
  const tests = [
    {
      name: 'has_required_metadata',
      passed: Boolean(skill.id && skill.name && skill.description && skill.triggers.length > 0),
      message: 'Skill must include id, name, description, and triggers.',
    },
    {
      name: 'has_operational_sop',
      passed: /steps|procedure|workflow|when to use/i.test(skill.content) && skill.content.length > 200,
      message: 'Skill content must contain an operational SOP with enough detail.',
    },
    {
      name: 'resolver_matches_trigger',
      passed: !resolver || skill.triggers.some(trigger => {
        const testResolver = new SkillResolver({ skills: [...resolver.list(), skill], minConfidence: 0.1 });
        return testResolver.resolve(trigger)?.skill.id === skill.id;
      }),
      message: 'At least one trigger must resolve back to the generated skill.',
    },
  ];
  return {
    score: tests.filter(test => test.passed).length / tests.length,
    tests,
  };
}

async function persistPromotion(
  db: postgres.Sql,
  groupId: string,
  proposal: ImprovementProposal,
  result: SkillPromotionResult,
): Promise<void> {
  await db`
    INSERT INTO skill_promotions (group_id, skill_id, status, proposal, test_results, filepath)
    VALUES (
      ${groupId},
      ${result.skill.id},
      ${result.status},
      ${JSON.stringify(proposal)},
      ${JSON.stringify({ score: result.score, tests: result.tests })},
      ${result.filepath || null}
    )
  `.catch(() => {});
}

function deriveTriggers(proposal: ImprovementProposal): string[] {
  const terms = [proposal.title, proposal.kind, ...(Object.values(proposal.evidence || {}).map(String))]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(term => term.length > 4)
    .slice(0, 6);
  return Array.from(new Set([
    proposal.title.toLowerCase(),
    ...terms.map(term => `handle ${term}`),
  ]));
}

function renderSkillContent(proposal: ImprovementProposal, triggers: string[]): string {
  return [
    `# ${proposal.title}`,
    '',
    '## When To Use',
    proposal.rationale,
    '',
    '## Triggers',
    ...triggers.map(trigger => `- ${trigger}`),
    '',
    '## Procedure',
    '1. Inspect the current user request and source context.',
    '2. Identify the relevant entities, facts, source records, or workflow artifacts.',
    '3. Apply the proposed action below conservatively and preserve provenance.',
    '4. If confidence is low, return the ambiguity inline and log telemetry instead of silently mutating durable state.',
    '',
    '## Proposed Action',
    '```json',
    JSON.stringify(proposal.proposedAction || {}, null, 2),
    '```',
    '',
    '## Evidence',
    '```json',
    JSON.stringify(proposal.evidence || {}, null, 2),
    '```',
  ].join('\n');
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || `skill-${Date.now()}`;
}
