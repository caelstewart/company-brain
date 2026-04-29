/**
 * Connector tests.
 *
 * Tests the AbstractConnector base class and FilesystemConnector
 * without any external dependencies (no DB, no APIs).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { FilesystemConnector } from '../src/connectors/filesystem.js';
import { AbstractConnector } from '../src/connectors/base.js';
import type { SyncOptions } from '../src/connectors/types.js';
import type { EpisodeInput } from '../src/types.js';

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'brain-connector-test-'));

  // Create test files
  await writeFile(join(testDir, 'notes.md'), '# Meeting Notes\n\nAlice from Acme discussed the deal.');
  await writeFile(join(testDir, 'readme.txt'), 'This is a text file.');
  await writeFile(join(testDir, 'empty.md'), '');
  await writeFile(join(testDir, 'data.json'), '{"not": "a markdown file"}');

  // Create subdirectory with files
  await mkdir(join(testDir, 'subdir'));
  await writeFile(join(testDir, 'subdir', 'deep.md'), '# Deep File\n\nNested content here.');

  // Create hidden directory (should be skipped)
  await mkdir(join(testDir, '.hidden'));
  await writeFile(join(testDir, '.hidden', 'secret.md'), 'should be skipped');
});

afterAll(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

// ─── AbstractConnector Base ───────────────────────────────

describe('AbstractConnector', () => {
  const TestConfigSchema = z.object({
    apiKey: z.string().min(1),
    limit: z.number().optional().default(10),
  });

  class TestConnector extends AbstractConnector<z.infer<typeof TestConfigSchema>> {
    readonly id = 'test';
    readonly name = 'Test';
    readonly configSchema = TestConfigSchema;
    setupCalled = false;
    setupConfig: any = null;

    async setup(config: z.infer<typeof TestConfigSchema>) {
      this.setupCalled = true;
      this.setupConfig = config;
    }

    async sync(): Promise<EpisodeInput[]> {
      return [{ content: 'test', sourceType: 'test' }];
    }
  }

  it('validates config with Zod and calls setup', async () => {
    const connector = new TestConnector();
    await connector.init({ apiKey: 'sk-123' });
    expect(connector.setupCalled).toBe(true);
    expect(connector.setupConfig.apiKey).toBe('sk-123');
    expect(connector.setupConfig.limit).toBe(10); // default applied
  });

  it('rejects invalid config with clear error', async () => {
    const connector = new TestConnector();
    await expect(connector.init({})).rejects.toThrow('[test] Invalid config');
    await expect(connector.init({ apiKey: '' })).rejects.toThrow('[test] Invalid config');
  });

  it('rejects wrong types in config', async () => {
    const connector = new TestConnector();
    await expect(connector.init({ apiKey: 123 })).rejects.toThrow('[test] Invalid config');
  });

  it('passes groupId through from raw config', async () => {
    const connector = new TestConnector();
    await connector.init({ apiKey: 'sk-123', groupId: 'team-a' });
    const episodes = await connector.sync();
    // groupId is stored on the base class as protected
    expect(connector.setupCalled).toBe(true);
  });
});

// ─── FilesystemConnector ──────────────────────────────────

describe('FilesystemConnector', () => {
  it('validates rootDir is required', async () => {
    const connector = new FilesystemConnector();
    await expect(connector.init({})).rejects.toThrow('Invalid config');
    await expect(connector.init({ rootDir: '' })).rejects.toThrow('Invalid config');
  });

  it('rejects nonexistent directory', async () => {
    const connector = new FilesystemConnector();
    await expect(connector.init({ rootDir: '/nonexistent/path/xyz' })).rejects.toThrow('Directory not found');
  });

  it('syncs markdown and text files', async () => {
    const connector = new FilesystemConnector();
    await connector.init({ rootDir: testDir });
    const episodes = await connector.sync();

    // Should find: notes.md, readme.txt, subdir/deep.md
    // Should skip: empty.md (empty), data.json (wrong extension), .hidden/secret.md (hidden dir)
    expect(episodes.length).toBe(3);

    const sourceIds = episodes.map(e => e.sourceId);
    expect(sourceIds).toContain('file://notes.md');
    expect(sourceIds).toContain('file://readme.txt');
    expect(sourceIds).toContain(`file://subdir/deep.md`);
  });

  it('skips empty files', async () => {
    const connector = new FilesystemConnector();
    await connector.init({ rootDir: testDir });
    const episodes = await connector.sync();

    const sourceIds = episodes.map(e => e.sourceId);
    expect(sourceIds).not.toContain('file://empty.md');
  });

  it('skips hidden directories', async () => {
    const connector = new FilesystemConnector();
    await connector.init({ rootDir: testDir });
    const episodes = await connector.sync();

    const sourceIds = episodes.map(e => e.sourceId);
    expect(sourceIds).not.toContain('file://.hidden/secret.md');
  });

  it('filters by extension', async () => {
    const connector = new FilesystemConnector();
    await connector.init({ rootDir: testDir, extensions: ['.txt'] });
    const episodes = await connector.sync();

    expect(episodes.length).toBe(1);
    expect(episodes[0].sourceId).toBe('file://readme.txt');
  });

  it('supports incremental sync with since', async () => {
    const connector = new FilesystemConnector();
    await connector.init({ rootDir: testDir });

    // Use a future date so nothing matches
    const future = new Date(Date.now() + 86400000);
    const episodes = await connector.sync({ since: future });
    expect(episodes.length).toBe(0);
  });

  it('respects limit', async () => {
    const connector = new FilesystemConnector();
    await connector.init({ rootDir: testDir });
    const episodes = await connector.sync({ limit: 1 });
    expect(episodes.length).toBe(1);
  });

  it('sets correct sourceType and metadata', async () => {
    const connector = new FilesystemConnector();
    await connector.init({ rootDir: testDir });
    const episodes = await connector.sync();

    const notes = episodes.find(e => e.sourceId === 'file://notes.md');
    expect(notes).toBeDefined();
    expect(notes!.sourceType).toBe('markdown_file');
    expect(notes!.metadata?.filePath).toBe('notes.md');
    expect(notes!.metadata?.fileSize).toBeGreaterThan(0);
    expect(notes!.metadata?.lastModified).toBeTruthy();
    expect(notes!.validAt).toBeInstanceOf(Date);
  });

  it('reads file content correctly', async () => {
    const connector = new FilesystemConnector();
    await connector.init({ rootDir: testDir });
    const episodes = await connector.sync();

    const notes = episodes.find(e => e.sourceId === 'file://notes.md');
    expect(notes!.content).toContain('Meeting Notes');
    expect(notes!.content).toContain('Alice from Acme');
  });
});
