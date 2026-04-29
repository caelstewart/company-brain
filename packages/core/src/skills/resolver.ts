/**
 * Skill Resolver.
 *
 * Matches user intent to the right skill using trigger phrases.
 * Inspired by gbrain's RESOLVER.md pattern — the LLM reads a routing
 * table and picks the best skill for the job.
 *
 * Two-phase matching:
 * 1. Deterministic: exact/substring trigger matching
 * 2. Fuzzy: keyword overlap scoring
 */

import type { Skill, SkillMatch, ResolverConfig } from './types.js';
import { DEFAULT_SKILLS } from './defaults.js';
import { loadSkillsFromDir, saveSkillToDir } from './loader.js';

export class SkillResolver {
  private skills: Skill[] = [];
  private minConfidence: number;
  private skillsDir?: string;

  constructor(config?: ResolverConfig) {
    this.minConfidence = config?.minConfidence ?? 0.3;
    this.skillsDir = config?.skillsDir;
    this.skills = [...DEFAULT_SKILLS, ...(config?.skills || [])];
  }

  /**
   * Load user skills from the skills directory.
   * User skills override defaults with the same id.
   * Call this after construction if skillsDir is set.
   */
  async loadFromDir(dir?: string): Promise<number> {
    const skillsDir = dir || this.skillsDir;
    if (!skillsDir) return 0;
    this.skillsDir = skillsDir;

    const userSkills = await loadSkillsFromDir(skillsDir);
    for (const skill of userSkills) {
      this.register(skill);
    }
    return userSkills.length;
  }

  /**
   * Save a skill to the skills directory and register it.
   * Creates or overwrites the file. Returns the file path.
   */
  async save(skill: Skill): Promise<string> {
    if (!this.skillsDir) {
      throw new Error('No skills directory configured. Set skillsDir in ResolverConfig or BRAIN_SKILLS_DIR env var.');
    }
    this.register(skill);
    return saveSkillToDir(this.skillsDir, skill);
  }

  /**
   * Register a skill.
   */
  register(skill: Skill): void {
    const existing = this.skills.findIndex(s => s.id === skill.id);
    if (existing >= 0) {
      this.skills[existing] = skill;
    } else {
      this.skills.push(skill);
    }
  }

  /**
   * Remove a skill by ID.
   */
  unregister(id: string): void {
    this.skills = this.skills.filter(s => s.id !== id);
  }

  /**
   * Resolve user input to the best matching skill.
   */
  resolve(input: string): SkillMatch | null {
    const matches = this.resolveAll(input);
    return matches.length > 0 ? matches[0] : null;
  }

  /**
   * Get all matching skills, sorted by confidence.
   */
  resolveAll(input: string): SkillMatch[] {
    const normalized = input.toLowerCase().trim();
    const matches: SkillMatch[] = [];

    for (const skill of this.skills) {
      const match = this.matchSkill(skill, normalized);
      if (match && match.confidence >= this.minConfidence) {
        matches.push(match);
      }
    }

    // Sort by confidence desc, then priority desc
    matches.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return (b.skill.priority || 0) - (a.skill.priority || 0);
    });

    return matches;
  }

  /**
   * Get all always-on skills (run on every message).
   */
  getAlwaysOn(): Skill[] {
    return this.skills.filter(s => s.alwaysOn);
  }

  /**
   * Get a skill by ID.
   */
  get(id: string): Skill | undefined {
    return this.skills.find(s => s.id === id);
  }

  /**
   * List all registered skills.
   */
  list(): Skill[] {
    return [...this.skills];
  }

  /**
   * Generate a routing table (markdown) for LLM context.
   */
  toRoutingTable(): string {
    const lines = [
      '| Skill | Triggers | Description |',
      '|-------|----------|-------------|',
    ];

    for (const skill of this.skills) {
      const triggers = skill.triggers.slice(0, 3).join(', ');
      lines.push(`| ${skill.name} | ${triggers} | ${skill.description} |`);
    }

    return lines.join('\n');
  }

  // ─── Private ──────────────────────────────────────────────

  private matchSkill(skill: Skill, input: string): SkillMatch | null {
    let bestConfidence = 0;
    let bestTrigger = '';

    for (const trigger of skill.triggers) {
      const triggerLower = trigger.toLowerCase();

      // Exact match
      if (input === triggerLower) {
        return { skill, confidence: 1.0, matchedTrigger: trigger };
      }

      // Substring match (input contains trigger or trigger contains input)
      if (input.includes(triggerLower)) {
        const confidence = 0.8 + (0.2 * triggerLower.length / input.length);
        if (confidence > bestConfidence) {
          bestConfidence = Math.min(confidence, 0.95);
          bestTrigger = trigger;
        }
        continue;
      }

      // Keyword overlap
      const triggerWords = triggerLower.split(/\s+/);
      const inputWords = input.split(/\s+/);
      const overlap = triggerWords.filter(w => inputWords.some(iw => iw.includes(w) || w.includes(iw)));

      if (overlap.length > 0) {
        const confidence = (overlap.length / triggerWords.length) * 0.7;
        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestTrigger = trigger;
        }
      }
    }

    if (bestConfidence > 0) {
      return { skill, confidence: bestConfidence, matchedTrigger: bestTrigger };
    }

    return null;
  }
}
