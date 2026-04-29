/**
 * Notion Connector.
 *
 * Fetches pages from Notion databases and ingests them as episodes.
 * Requires a Notion integration token with read access to target databases.
 */

import { z } from 'zod';
import type { EpisodeInput } from '../types.js';
import type { SyncOptions } from './types.js';
import { AbstractConnector } from './base.js';

export const NotionConfigSchema = z.object({
  token: z.string().min(1, 'Internal Integration Token is required'),
});

export type NotionConfig = z.infer<typeof NotionConfigSchema>;

export class NotionConnector extends AbstractConnector<NotionConfig> {
  readonly id = 'notion';
  readonly name = 'Notion';
  readonly configSchema = NotionConfigSchema;

  private baseUrl = 'https://api.notion.com/v1';
  private apiVersion = '2022-06-28';

  constructor() {
    // Notion rate limit: 3 requests/sec
    super({ rateLimitMs: 350, maxRetries: 3 });
  }

  async setup(config: NotionConfig): Promise<void> {
    const res = await this.notionApi<any>('GET', '/users/me');
    if (!res.object) throw new Error('Notion auth failed');
    this.log('info', `Authenticated as ${res.name || res.id}`);
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const databaseId = options?.resource;
    const limit = options?.limit ?? 100;
    const since = options?.since;
    const episodes: EpisodeInput[] = [];

    const pages = databaseId
      ? await this.queryDatabase(databaseId, limit, since, options?.cursor)
      : await this.searchPages(limit, since);

    for (const page of pages) {
      try {
        const episode = await this.pageToEpisode(page);
        if (episode) episodes.push(episode);
      } catch (err) {
        this.log('warn', `Failed to convert page ${page.id}`, err);
      }
    }

    this.log('info', `Synced ${episodes.length} pages`);
    return episodes;
  }

  private async notionApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.fetchJson<T>(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Notion-Version': this.apiVersion,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private async queryDatabase(
    databaseId: string,
    limit: number,
    since?: Date,
    cursor?: string,
  ): Promise<any[]> {
    const body: any = {
      page_size: Math.min(limit, 100),
    };
    if (cursor) body.start_cursor = cursor;
    if (since) {
      body.filter = {
        timestamp: 'last_edited_time',
        last_edited_time: { after: since.toISOString() },
      };
    }

    const res = await this.notionApi<any>('POST', `/databases/${databaseId}/query`, body);
    return res.results || [];
  }

  private async searchPages(limit: number, since?: Date): Promise<any[]> {
    const body: any = {
      filter: { property: 'object', value: 'page' },
      page_size: Math.min(limit, 100),
    };
    if (since) {
      body.sort = { direction: 'descending', timestamp: 'last_edited_time' };
    }

    const res = await this.notionApi<any>('POST', '/search', body);
    return res.results || [];
  }

  private async pageToEpisode(page: any): Promise<EpisodeInput | null> {
    const blocks = await this.getPageBlocks(page.id);
    const content = this.blocksToText(blocks);
    if (!content.trim()) return null;

    const title = this.getPageTitle(page);

    return {
      content: title ? `# ${title}\n\n${content}` : content,
      sourceType: 'notion_page',
      sourceId: `notion://${page.id}`,
      validAt: new Date(page.last_edited_time),
      groupId: this.groupId,
      metadata: {
        notionId: page.id,
        title,
        url: page.url,
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
      },
    };
  }

  private async getPageBlocks(pageId: string): Promise<any[]> {
    const allBlocks: any[] = [];
    let cursor: string | undefined;

    // Paginate through all blocks
    do {
      const params = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
      const res = await this.notionApi<any>('GET', `/blocks/${pageId}/children${params}`);
      allBlocks.push(...(res.results || []));
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);

    // Fetch children of blocks that have them (toggles, etc.)
    for (const block of allBlocks) {
      if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
        try {
          const children = await this.getPageBlocks(block.id);
          block._children = children;
        } catch {
          // Skip blocks we can't access
        }
      }
    }

    return allBlocks;
  }

  private blocksToText(blocks: any[], indent = ''): string {
    const lines: string[] = [];

    for (const block of blocks) {
      const text = this.extractBlockText(block, indent);
      if (text) lines.push(text);
      if (block._children) {
        lines.push(this.blocksToText(block._children, indent + '  '));
      }
    }

    return lines.join('\n');
  }

  private extractBlockText(block: any, indent: string): string {
    const type = block.type;
    const data = block[type];
    if (!data) return '';

    // Rich text blocks
    if (data.rich_text) {
      const text = data.rich_text.map((t: any) => t.plain_text).join('');
      switch (type) {
        case 'heading_1': return `# ${text}`;
        case 'heading_2': return `## ${text}`;
        case 'heading_3': return `### ${text}`;
        case 'bulleted_list_item': return `${indent}- ${text}`;
        case 'numbered_list_item': return `${indent}1. ${text}`;
        case 'to_do': return `${indent}- [${data.checked ? 'x' : ' '}] ${text}`;
        case 'toggle': return `${indent}> ${text}`;
        case 'quote': return `${indent}> ${text}`;
        case 'code': return `\`\`\`${data.language || ''}\n${text}\n\`\`\``;
        case 'callout': return `> ${data.icon?.emoji || ''} ${text}`;
        default: return `${indent}${text}`;
      }
    }

    // Non-rich-text blocks
    switch (type) {
      case 'divider': return '---';
      case 'table_of_contents': return '';
      case 'breadcrumb': return '';
      case 'image': return `![image](${data.file?.url || data.external?.url || ''})`;
      case 'video': return `[video](${data.file?.url || data.external?.url || ''})`;
      case 'file': return `[file](${data.file?.url || data.external?.url || ''})`;
      case 'bookmark': return `[bookmark](${data.url || ''})`;
      case 'embed': return `[embed](${data.url || ''})`;
      case 'equation': return `$$${data.expression || ''}$$`;
      default: return '';
    }
  }

  private getPageTitle(page: any): string {
    const props = page.properties || {};
    for (const prop of Object.values(props) as any[]) {
      if (prop.type === 'title' && prop.title?.length > 0) {
        return prop.title.map((t: any) => t.plain_text).join('');
      }
    }
    return '';
  }
}
