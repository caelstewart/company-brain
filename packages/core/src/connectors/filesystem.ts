/**
 * Filesystem / Markdown Connector.
 *
 * Watches a directory of markdown files and ingests them as episodes.
 * Supports incremental sync via file modification times.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import type { EpisodeInput } from '../types.js';
import type { Connector, SyncOptions } from './types.js';

export class FilesystemConnector implements Connector {
  id = 'filesystem';
  name = 'Filesystem / Markdown';

  private rootDir = '';
  private extensions = ['.md', '.txt', '.markdown'];
  private groupId?: string;

  async init(config: Record<string, unknown>): Promise<void> {
    this.rootDir = config.rootDir as string;
    if (!this.rootDir) throw new Error('FilesystemConnector requires rootDir');

    if (config.extensions) this.extensions = config.extensions as string[];
    if (config.groupId) this.groupId = config.groupId as string;

    // Verify directory exists
    await stat(this.rootDir);
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const since = options?.since;
    const limit = options?.limit ?? 1000;
    const files = await this.walkDir(this.rootDir);
    const episodes: EpisodeInput[] = [];

    for (const file of files) {
      if (episodes.length >= limit) break;

      const fileStat = await stat(file);
      if (since && fileStat.mtime < since) continue;

      const ext = extname(file).toLowerCase();
      if (!this.extensions.includes(ext)) continue;

      const content = await readFile(file, 'utf-8');
      if (!content.trim()) continue;

      const relativePath = relative(this.rootDir, file);

      episodes.push({
        content,
        sourceType: 'markdown_file',
        sourceId: `file://${relativePath}`,
        validAt: fileStat.mtime,
        groupId: this.groupId,
        metadata: {
          filePath: relativePath,
          fileSize: fileStat.size,
          lastModified: fileStat.mtime.toISOString(),
        },
      });
    }

    return episodes;
  }

  private async walkDir(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      if (entry.isDirectory()) {
        files.push(...await this.walkDir(full));
      } else if (entry.isFile()) {
        files.push(full);
      }
    }

    return files;
  }
}
