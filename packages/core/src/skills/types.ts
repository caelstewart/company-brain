/**
 * Skill system types.
 *
 * Skills are markdown SOPs that teach agents HOW to use the brain.
 * The resolver matches user intent to the right skill.
 */

export interface Skill {
  /** Unique skill ID (e.g., 'query', 'enrich', 'ingest-meeting') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description for the resolver */
  description: string;
  /** Trigger phrases/patterns that activate this skill */
  triggers: string[];
  /** The full markdown SOP content */
  content: string;
  /** Whether this skill runs on every message (ambient) */
  alwaysOn?: boolean;
  /** Priority for resolver conflicts (higher = preferred) */
  priority?: number;
}

export interface SkillMatch {
  skill: Skill;
  confidence: number;
  matchedTrigger: string;
}

export interface ResolverConfig {
  /** Directory containing skill markdown files */
  skillsDir?: string;
  /** Additional skills loaded programmatically */
  skills?: Skill[];
  /** Minimum confidence to match a skill */
  minConfidence?: number;
}
