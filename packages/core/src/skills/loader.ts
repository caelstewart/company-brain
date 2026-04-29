/**
 * Skill Loader.
 *
 * Reads skill files from a directory. Each skill is a markdown file
 * with YAML frontmatter containing metadata (id, name, triggers, etc.).
 *
 * File format:
 * ```markdown
 * ---
 * id: my-skill
 * name: My Skill
 * description: What this skill does
 * triggers:
 *   - trigger phrase one
 *   - trigger phrase two
 * priority: 70
 * alwaysOn: false
 * ---
 * # My Skill
 *
 * The full markdown SOP content goes here...
 * ```
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { Skill } from './types.js';

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns the frontmatter fields and the remaining content.
 */
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; content: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) {
    return { meta: {}, content: raw };
  }

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { meta: {}, content: raw };
  }

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const content = trimmed.slice(endIdx + 4).trim();

  const meta: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of yamlBlock.split('\n')) {
    // Array item
    if (currentKey && /^\s+-\s+/.test(line)) {
      if (!currentArray) currentArray = [];
      currentArray.push(line.replace(/^\s+-\s+/, '').trim());
      continue;
    }

    // Flush previous array
    if (currentKey && currentArray) {
      meta[currentKey] = currentArray;
      currentArray = null;
      currentKey = null;
    }

    // Key: value pair
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.*)/);
    if (match) {
      const key = match[1];
      const value = match[2].trim();

      if (value === '') {
        // Next lines might be array items
        currentKey = key;
        currentArray = null;
        continue;
      }

      // Parse booleans and numbers
      if (value === 'true') meta[key] = true;
      else if (value === 'false') meta[key] = false;
      else if (/^\d+$/.test(value)) meta[key] = parseInt(value, 10);
      else meta[key] = value;
    }
  }

  // Flush final array
  if (currentKey && currentArray) {
    meta[currentKey] = currentArray;
  }

  return { meta, content };
}

/**
 * Convert parsed frontmatter + content into a Skill object.
 * Returns null if required fields are missing.
 */
function toSkill(meta: Record<string, unknown>, content: string, filename: string): Skill | null {
  const id = (meta.id as string) || filename.replace(/\.md$/, '');
  const name = (meta.name as string) || id;
  const description = (meta.description as string) || '';
  const triggers = Array.isArray(meta.triggers) ? (meta.triggers as string[]) : [];
  const priority = typeof meta.priority === 'number' ? meta.priority : undefined;
  const alwaysOn = typeof meta.alwaysOn === 'boolean' ? meta.alwaysOn : undefined;

  if (!content.trim()) return null;

  return { id, name, description, triggers, content, priority, alwaysOn };
}

/**
 * Load all skill files from a directory.
 * Returns an array of Skill objects. Skips files that fail to parse.
 */
export async function loadSkillsFromDir(dir: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const skills: Skill[] = [];

  for (const entry of entries) {
    if (extname(entry) !== '.md') continue;

    try {
      const raw = await readFile(join(dir, entry), 'utf-8');
      const { meta, content } = parseFrontmatter(raw);
      const skill = toSkill(meta, content, entry);
      if (skill) skills.push(skill);
    } catch {
      // Skip unreadable files
    }
  }

  return skills;
}

/**
 * Save a skill as a markdown file with YAML frontmatter.
 * Creates the directory if it doesn't exist.
 */
export async function saveSkillToDir(dir: string, skill: Skill): Promise<string> {
  await mkdir(dir, { recursive: true });

  const lines: string[] = ['---'];
  lines.push(`id: ${skill.id}`);
  lines.push(`name: ${skill.name}`);
  if (skill.description) lines.push(`description: ${skill.description}`);
  if (skill.triggers.length > 0) {
    lines.push('triggers:');
    for (const t of skill.triggers) lines.push(`  - ${t}`);
  }
  if (skill.priority !== undefined) lines.push(`priority: ${skill.priority}`);
  if (skill.alwaysOn !== undefined) lines.push(`alwaysOn: ${skill.alwaysOn}`);
  lines.push('---');
  lines.push('');
  lines.push(skill.content);

  const filename = `${skill.id}.md`;
  const filepath = join(dir, filename);
  await writeFile(filepath, lines.join('\n'), 'utf-8');
  return filepath;
}

/**
 * Serialize a Skill to its markdown file format (for previewing without saving).
 */
export function skillToMarkdown(skill: Skill): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${skill.id}`);
  lines.push(`name: ${skill.name}`);
  if (skill.description) lines.push(`description: ${skill.description}`);
  if (skill.triggers.length > 0) {
    lines.push('triggers:');
    for (const t of skill.triggers) lines.push(`  - ${t}`);
  }
  if (skill.priority !== undefined) lines.push(`priority: ${skill.priority}`);
  if (skill.alwaysOn !== undefined) lines.push(`alwaysOn: ${skill.alwaysOn}`);
  lines.push('---');
  lines.push('');
  lines.push(skill.content);
  return lines.join('\n');
}
