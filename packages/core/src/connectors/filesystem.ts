/**
 * Filesystem / Markdown Connector.
 *
 * Watches a directory of markdown/text files and ingests them as episodes.
 * Supports incremental sync via file modification times.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { z } from 'zod';
import type { EpisodeInput } from '../types.js';
import type { SyncOptions } from './types.js';
import { AbstractConnector } from './base.js';

export const FilesystemConfigSchema = z.object({
  rootDir: z.string().min(1, 'rootDir is required'),
  extensions: z.array(z.string()).optional().default(['.md', '.txt', '.markdown']),
});

export type FilesystemConfig = z.infer<typeof FilesystemConfigSchema>;

export class FilesystemConnector extends AbstractConnector<FilesystemConfig> {
  readonly id = 'filesystem';
  readonly name = 'Filesystem / Markdown';
  readonly configSchema = FilesystemConfigSchema;

  async setup(config: FilesystemConfig): Promise<void> {
    try {
      const s = await stat(config.rootDir);
      if (!s.isDirectory()) {
        throw new Error(`${config.rootDir} is not a directory`);
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new Error(`Directory not found: ${config.rootDir}`);
      throw err;
    }
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const since = options?.since;
    const limit = options?.limit ?? 1000;
    const files = await this.walkDir(this.config.rootDir);
    const episodes: EpisodeInput[] = [];

    for (const file of files) {
      if (episodes.length >= limit) break;

      const ext = extname(file).toLowerCase();
      if (!this.config.extensions.includes(ext)) continue;

      let fileStat;
      try {
        fileStat = await stat(file);
      } catch (err) {
        this.log('warn', `Could not stat file: ${file}`, err);
        continue;
      }

      if (since && fileStat.mtime < since) continue;

      let content;
      try {
        content = await readFile(file, 'utf-8');
      } catch (err) {
        this.log('warn', `Could not read file: ${file}`, err);
        continue;
      }

      if (!content.trim()) continue;

      const relativePath = relative(this.config.rootDir, file);

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

    this.log('info', `Synced ${episodes.length} files from ${this.config.rootDir}`);
    return episodes;
  }

  private async walkDir(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      this.log('warn', `Could not read directory: ${dir}`, err);
      return [];
    }

    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.walkDir(full));
      } else if (entry.isFile()) {
        files.push(full);
      }
    }

    return files;
  }
}
