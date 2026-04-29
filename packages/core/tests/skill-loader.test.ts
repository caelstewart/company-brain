/**
 * Skill loader tests.
 *
 * Tests loading skills from markdown files with YAML frontmatter,
 * saving skills back to files, and the resolver's directory integration.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkillsFromDir, saveSkillToDir, skillToMarkdown } from '../src/skills/loader.js';
import { SkillResolver } from '../src/skills/resolver.js';
import type { Skill } from '../src/skills/types.js';

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'brain-skill-test-'));
});

afterAll(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

// ─── Frontmatter Parsing ──────────────────────────────────

describe('loadSkillsFromDir', () => {
  it('loads a skill with full frontmatter', async () => {
    const dir = join(testDir, 'full');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'my-skill.md'), `---
id: my-skill
name: My Skill
description: Does something useful
triggers:
  - do the thing
  - run my skill
priority: 75
alwaysOn: false
---
# My Skill

## Protocol
1. Do the thing
2. Check the result
`);

    const skills = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('my-skill');
    expect(skills[0].name).toBe('My Skill');
    expect(skills[0].description).toBe('Does something useful');
    expect(skills[0].triggers).toEqual(['do the thing', 'run my skill']);
    expect(skills[0].priority).toBe(75);
    expect(skills[0].alwaysOn).toBe(false);
    expect(skills[0].content).toContain('# My Skill');
    expect(skills[0].content).toContain('Do the thing');
  });

  it('uses filename as id when id is missing', async () => {
    const dir = join(testDir, 'no-id');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'deal-tracker.md'), `---
name: Deal Tracker
description: Track deals
triggers:
  - track deal
---
# Deal Tracker

Follow up on deals.
`);

    const skills = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('deal-tracker');
  });

  it('handles minimal frontmatter', async () => {
    const dir = join(testDir, 'minimal');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'simple.md'), `---
id: simple
name: Simple
---
Just some content.
`);

    const skills = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('simple');
    expect(skills[0].triggers).toEqual([]);
    expect(skills[0].content).toBe('Just some content.');
  });

  it('skips files without .md extension', async () => {
    const dir = join(testDir, 'mixed');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'good.md'), `---
id: good
name: Good
---
Content.
`);
    await writeFile(join(dir, 'ignored.txt'), 'Not a skill.');
    await writeFile(join(dir, 'also-ignored.json'), '{}');

    const skills = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('good');
  });

  it('skips files with empty content', async () => {
    const dir = join(testDir, 'empty-content');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'empty.md'), `---
id: empty
name: Empty
---
`);

    const skills = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(0);
  });

  it('handles files without frontmatter', async () => {
    const dir = join(testDir, 'no-front');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'raw.md'), `# Just Markdown

No frontmatter here, just content.
`);

    const skills = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('raw');
    expect(skills[0].content).toContain('Just Markdown');
  });

  it('returns empty array for nonexistent directory', async () => {
    const skills = await loadSkillsFromDir('/nonexistent/path/xyz');
    expect(skills).toHaveLength(0);
  });

  it('loads multiple skills', async () => {
    const dir = join(testDir, 'multi');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), '---\nid: a\nname: A\n---\nContent A.');
    await writeFile(join(dir, 'b.md'), '---\nid: b\nname: B\n---\nContent B.');
    await writeFile(join(dir, 'c.md'), '---\nid: c\nname: C\n---\nContent C.');

    const skills = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(3);
    const ids = skills.map(s => s.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('parses alwaysOn: true correctly', async () => {
    const dir = join(testDir, 'always-on');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'ambient.md'), `---
id: ambient
name: Ambient
alwaysOn: true
priority: 100
---
Always running.
`);

    const skills = await loadSkillsFromDir(dir);
    expect(skills[0].alwaysOn).toBe(true);
    expect(skills[0].priority).toBe(100);
  });
});

// ─── Save to Directory ────────────────────────────────────

describe('saveSkillToDir', () => {
  it('saves a skill as markdown with frontmatter', async () => {
    const dir = join(testDir, 'save-test');
    const skill: Skill = {
      id: 'test-save',
      name: 'Test Save',
      description: 'A test skill',
      triggers: ['save test', 'test saving'],
      content: '# Test\n\nDo the test.',
      priority: 60,
      alwaysOn: false,
    };

    const filepath = await saveSkillToDir(dir, skill);
    expect(filepath).toContain('test-save.md');

    const raw = await readFile(filepath, 'utf-8');
    expect(raw).toContain('id: test-save');
    expect(raw).toContain('name: Test Save');
    expect(raw).toContain('description: A test skill');
    expect(raw).toContain('  - save test');
    expect(raw).toContain('  - test saving');
    expect(raw).toContain('priority: 60');
    expect(raw).toContain('alwaysOn: false');
    expect(raw).toContain('# Test');
    expect(raw).toContain('Do the test.');
  });

  it('creates directory if it does not exist', async () => {
    const dir = join(testDir, 'new-dir', 'nested');
    const skill: Skill = {
      id: 'nested',
      name: 'Nested',
      description: '',
      triggers: [],
      content: 'Content.',
    };

    const filepath = await saveSkillToDir(dir, skill);
    const raw = await readFile(filepath, 'utf-8');
    expect(raw).toContain('id: nested');
  });

  it('round-trips a skill through save and load', async () => {
    const dir = join(testDir, 'roundtrip');
    const original: Skill = {
      id: 'roundtrip',
      name: 'Round Trip',
      description: 'Test round trip',
      triggers: ['round trip', 'test roundtrip'],
      content: '# Round Trip\n\n1. Save it\n2. Load it\n3. Compare',
      priority: 80,
      alwaysOn: true,
    };

    await saveSkillToDir(dir, original);
    const loaded = await loadSkillsFromDir(dir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(original.id);
    expect(loaded[0].name).toBe(original.name);
    expect(loaded[0].description).toBe(original.description);
    expect(loaded[0].triggers).toEqual(original.triggers);
    expect(loaded[0].priority).toBe(original.priority);
    expect(loaded[0].alwaysOn).toBe(original.alwaysOn);
    expect(loaded[0].content).toContain('Save it');
  });
});

// ─── skillToMarkdown ──────────────────────────────────────

describe('skillToMarkdown', () => {
  it('produces valid frontmatter format', () => {
    const md = skillToMarkdown({
      id: 'test',
      name: 'Test',
      description: 'Desc',
      triggers: ['go'],
      content: '# Content',
      priority: 50,
    });

    expect(md).toContain('---\n');
    expect(md).toContain('id: test');
    expect(md).toContain('# Content');
  });
});

// ─── Resolver Integration ─────────────────────────────────

describe('SkillResolver with directory', () => {
  it('loads user skills and merges with defaults', async () => {
    const dir = join(testDir, 'resolver-merge');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'custom.md'), `---
id: custom-skill
name: Custom Skill
description: A user-created skill
triggers:
  - do custom thing
priority: 60
---
# Custom Skill

Custom protocol here.
`);

    const resolver = new SkillResolver();
    const defaultCount = resolver.list().length;

    const loaded = await resolver.loadFromDir(dir);
    expect(loaded).toBe(1);

    const allSkills = resolver.list();
    expect(allSkills.length).toBe(defaultCount + 1);

    const custom = resolver.get('custom-skill');
    expect(custom).toBeDefined();
    expect(custom!.name).toBe('Custom Skill');
  });

  it('user skill overrides default with same id', async () => {
    const dir = join(testDir, 'resolver-override');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'query.md'), `---
id: query
name: Custom Query
description: My custom query behavior
triggers:
  - what do we know about
  - search for
priority: 90
---
# Custom Query

My team's custom query protocol.
`);

    const resolver = new SkillResolver();
    const loaded = await resolver.loadFromDir(dir);
    expect(loaded).toBe(1);

    const query = resolver.get('query');
    expect(query).toBeDefined();
    expect(query!.name).toBe('Custom Query');
    expect(query!.content).toContain('custom query protocol');
  });

  it('save() persists and registers a skill', async () => {
    const dir = join(testDir, 'resolver-save');
    const resolver = new SkillResolver({ skillsDir: dir });

    await resolver.save({
      id: 'saved-skill',
      name: 'Saved Skill',
      description: 'Persisted',
      triggers: ['save it'],
      content: '# Saved\n\nThis was saved via resolver.',
      priority: 55,
    });

    // Should be registered immediately
    expect(resolver.get('saved-skill')).toBeDefined();

    // Should be loadable from disk
    const loaded = await loadSkillsFromDir(dir);
    expect(loaded.find(s => s.id === 'saved-skill')).toBeDefined();
  });

  it('save() throws without skillsDir configured', async () => {
    const resolver = new SkillResolver();
    await expect(resolver.save({
      id: 'x',
      name: 'X',
      description: '',
      triggers: [],
      content: 'content',
    })).rejects.toThrow('No skills directory configured');
  });
});
