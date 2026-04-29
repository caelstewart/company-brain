/**
 * Slack Connector.
 *
 * Fetches messages from Slack channels and ingests them as episodes.
 * Supports both polling (sync) and webhook (Events API) modes.
 *
 * Requires a Slack Bot Token with channels:history, channels:read scopes.
 */

import type { EpisodeInput } from '../types.js';
import type { Connector, SyncOptions } from './types.js';

export class SlackConnector implements Connector {
  id = 'slack';
  name = 'Slack';

  private token = '';
  private baseUrl = 'https://slack.com/api';
  private groupId?: string;

  async init(config: Record<string, unknown>): Promise<void> {
    this.token = config.token as string;
    if (!this.token) throw new Error('SlackConnector requires token (Bot User OAuth Token)');
    if (config.groupId) this.groupId = config.groupId as string;

    // Verify token
    const res = await this.slackApi('auth.test');
    if (!res.ok) throw new Error(`Slack auth failed: ${res.error}`);
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const channel = options?.resource;
    const limit = options?.limit ?? 100;
    const since = options?.since;
    const episodes: EpisodeInput[] = [];

    // Get channels to sync
    const channels = channel
      ? [{ id: channel, name: channel }]
      : await this.listChannels();

    for (const ch of channels) {
      const messages = await this.fetchMessages(ch.id, limit, since, options?.cursor);

      for (const msg of messages) {
        if (!msg.text || msg.subtype === 'channel_join') continue;

        episodes.push({
          content: msg.text,
          sourceType: 'slack_message',
          sourceId: `slack://${ch.name}/${msg.ts}`,
          validAt: new Date(Number(msg.ts) * 1000),
          groupId: this.groupId,
          metadata: {
            channel: ch.name,
            channelId: ch.id,
            userId: msg.user,
            threadTs: msg.thread_ts,
            timestamp: msg.ts,
          },
        });
      }
    }

    return episodes;
  }

  async handleWebhook(payload: unknown): Promise<EpisodeInput[]> {
    const body = payload as any;

    // URL verification challenge
    if (body.type === 'url_verification') return [];

    // Event callback
    if (body.type === 'event_callback' && body.event?.type === 'message') {
      const event = body.event;
      if (!event.text || event.subtype) return [];

      return [{
        content: event.text,
        sourceType: 'slack_message',
        sourceId: `slack://${event.channel}/${event.ts}`,
        validAt: new Date(Number(event.ts) * 1000),
        groupId: this.groupId,
        metadata: {
          channelId: event.channel,
          userId: event.user,
          threadTs: event.thread_ts,
          timestamp: event.ts,
        },
      }];
    }

    return [];
  }

  // ─── Slack API Helpers ───────────────────────────────────

  private async slackApi(method: string, params?: Record<string, string>): Promise<any> {
    const url = new URL(`${this.baseUrl}/${method}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.json();
  }

  private async listChannels(): Promise<Array<{ id: string; name: string }>> {
    const res = await this.slackApi('conversations.list', {
      types: 'public_channel,private_channel',
      limit: '200',
    });
    if (!res.ok) return [];

    return res.channels.map((ch: any) => ({ id: ch.id, name: ch.name }));
  }

  private async fetchMessages(
    channel: string,
    limit: number,
    since?: Date,
    cursor?: string,
  ): Promise<any[]> {
    const params: Record<string, string> = {
      channel,
      limit: String(Math.min(limit, 200)),
    };
    if (since) params.oldest = String(since.getTime() / 1000);
    if (cursor) params.cursor = cursor;

    const res = await this.slackApi('conversations.history', params);
    if (!res.ok) return [];
    return res.messages || [];
  }
}
