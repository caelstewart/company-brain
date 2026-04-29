/**
 * Notion Connector.
 *
 * Fetches pages from Notion databases and ingests them as episodes.
 * Requires a Notion integration token with read access to target databases.
 */

import type { EpisodeInput } from '../types.js';
import type { Connector, SyncOptions } from './types.js';

export class NotionConnector implements Connector {
  id = 'notion';
  name = 'Notion';

  private token = '';
  private baseUrl = 'https://api.notion.com/v1';
  private apiVersion = '2022-06-28';
  private groupId?: string;

  async init(config: Record<string, unknown>): Promise<void> {
    this.token = config.token as string;
    if (!this.token) throw new Error('NotionConnector requires token (Internal Integration Token)');
    if (config.groupId) this.groupId = config.groupId as string;

    // Verify token
    const res = await this.notionApi('GET', '/users/me');
    if (!res.object) throw new Error('Notion auth failed');
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const databaseId = options?.resource;
    const limit = options?.limit ?? 100;
    const since = options?.since;
    const episodes: EpisodeInput[] = [];

    if (databaseId) {
      // Sync specific database
      const pages = await this.queryDatabase(databaseId, limit, since, options?.cursor);
      for (const page of pages) {
        const episode = await this.pageToEpisode(page);
        if (episode) episodes.push(episode);
      }
    } else {
      // Search all accessible pages
      const pages = await this.searchPages(limit, since);
      for (const page of pages) {
        const episode = await this.pageToEpisode(page);
        if (episode) episodes.push(episode);
      }
    }

    return episodes;
  }

  // ─── Notion API Helpers ──────────────────────────────────

  private async notionApi(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Notion-Version': this.apiVersion,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  private async queryDatabase(
    databaseId: string,
    limit: number,
    since?: Date,
    cursor?: string,
  ): Promise<any[]> {
    const filter = since
      ? { filter: { timestamp: 'last_edited_time', last_edited_time: { after: since.toISOString() } } }
      : {};

    const res = await this.notionApi('POST', `/databases/${databaseId}/query`, {
      ...filter,
      page_size: Math.min(limit, 100),
      start_cursor: cursor,
    });

    return res.results || [];
  }

  private async searchPages(limit: number, since?: Date): Promise<any[]> {
    const filter = since
      ? { filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' } }
      : { filter: { property: 'object', value: 'page' } };

    const res = await this.notionApi('POST', '/search', {
      ...filter,
      page_size: Math.min(limit, 100),
    });

    return res.results || [];
  }

  private async pageToEpisode(page: any): Promise<EpisodeInput | null> {
    // Get page content as blocks
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
    const res = await this.notionApi('GET', `/blocks/${pageId}/children?page_size=100`);
    return res.results || [];
  }

  private blocksToText(blocks: any[]): string {
    const lines: string[] = [];

    for (const block of blocks) {
      const text = this.extractBlockText(block);
      if (text) lines.push(text);
    }

    return lines.join('\n');
  }

  private extractBlockText(block: any): string {
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
        case 'bulleted_list_item': return `- ${text}`;
        case 'numbered_list_item': return `1. ${text}`;
        case 'to_do': return `- [${data.checked ? 'x' : ' '}] ${text}`;
        case 'toggle': return `> ${text}`;
        case 'quote': return `> ${text}`;
        case 'code': return `\`\`\`\n${text}\n\`\`\``;
        default: return text;
      }
    }

    return '';
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
