/**
 * Slack Connector.
 *
 * Fetches messages from Slack channels and ingests them as episodes.
 * Supports both polling (sync) and webhook (Events API) modes.
 *
 * Requires a Slack Bot Token with channels:history, channels:read scopes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { EpisodeInput } from '../types.js';
import type { SyncOptions } from './types.js';
import { AbstractConnector } from './base.js';

export const SlackConfigSchema = z.object({
  token: z.string().min(1, 'Bot User OAuth Token is required'),
  /** Signing secret for webhook signature verification. Required for handleWebhook. */
  signingSecret: z.string().optional(),
});

export type SlackConfig = z.infer<typeof SlackConfigSchema>;

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class SlackConnector extends AbstractConnector<SlackConfig> {
  readonly id = 'slack';
  readonly name = 'Slack';
  readonly configSchema = SlackConfigSchema;

  private baseUrl = 'https://slack.com/api';

  constructor() {
    // Slack rate limit: ~50 req/min for most endpoints
    super({ rateLimitMs: 1200, maxRetries: 3 });
  }

  async setup(config: SlackConfig): Promise<void> {
    const res = await this.slackApi<SlackResponse>('auth.test');
    if (!res.ok) throw new Error(`Slack auth failed: ${res.error}`);
    this.log('info', `Authenticated as ${(res as any).user}`);
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const channel = options?.resource;
    const limit = options?.limit ?? 100;
    const since = options?.since;
    const episodes: EpisodeInput[] = [];

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

    this.log('info', `Synced ${episodes.length} messages from ${channels.length} channels`);
    return episodes;
  }

  async handleWebhook(payload: unknown, headers?: Record<string, string>): Promise<EpisodeInput[]> {
    const body = payload as any;

    // Verify signature if signing secret is configured
    if (this.config.signingSecret && headers) {
      this.verifySignature(body, headers);
    }

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

  private verifySignature(body: unknown, headers: Record<string, string>): void {
    const timestamp = headers['x-slack-request-timestamp'];
    const signature = headers['x-slack-signature'];
    if (!timestamp || !signature) {
      throw new Error('Missing Slack signature headers');
    }

    // Reject requests older than 5 minutes
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 300) {
      throw new Error('Slack request timestamp too old');
    }

    const sigBasestring = `v0:${timestamp}:${typeof body === 'string' ? body : JSON.stringify(body)}`;
    const mySignature = 'v0=' + createHmac('sha256', this.config.signingSecret!)
      .update(sigBasestring)
      .digest('hex');

    const sigBuffer = Buffer.from(signature);
    const myBuffer = Buffer.from(mySignature);
    if (sigBuffer.length !== myBuffer.length || !timingSafeEqual(sigBuffer, myBuffer)) {
      throw new Error('Invalid Slack webhook signature');
    }
  }

  private async slackApi<T = SlackResponse>(method: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}/${method}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }

    return this.fetchJson<T>(url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
    });
  }

  private async listChannels(): Promise<Array<{ id: string; name: string }>> {
    const res = await this.slackApi<any>('conversations.list', {
      types: 'public_channel,private_channel',
      limit: '200',
    });
    if (!res.ok) {
      this.log('error', 'Failed to list channels', res.error);
      return [];
    }
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

    const res = await this.slackApi<any>('conversations.history', params);
    if (!res.ok) {
      this.log('error', `Failed to fetch messages from ${channel}`, res.error);
      return [];
    }
    return res.messages || [];
  }
}
