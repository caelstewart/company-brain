/**
 * Webhook Receiver.
 *
 * Generic webhook receiver that accepts payloads from any source,
 * verifies signatures, normalizes content, and ingests into the brain.
 *
 * Designed for scale: register a source once, then point the external
 * service at your webhook URL. Incoming data flows through verification,
 * normalization, and straight into the knowledge graph.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Brain } from '../index.js';
import type { EpisodeInput } from '../types.js';
import type { WebhookSource, WebhookResult, RawWebhookPayload } from './types.js';

export class WebhookReceiver {
  private sources = new Map<string, WebhookSource>();
  private webhooksDir?: string;

  constructor(private brain: Brain, options?: { webhooksDir?: string }) {
    this.webhooksDir = options?.webhooksDir;
  }

  // ─── Source Management ──────────────────────────────────────

  registerSource(source: WebhookSource): void {
    if (!source.id || !source.sourceType) {
      throw new Error('Webhook source requires id and sourceType');
    }
    this.sources.set(source.id, source);
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  getSource(id: string): WebhookSource | undefined {
    return this.sources.get(id);
  }

  listSources(): WebhookSource[] {
    return Array.from(this.sources.values()).map(s => ({
      ...s,
      secret: s.secret ? '***' : undefined, // Never expose secrets
    }));
  }

  /**
   * Save a webhook source to disk and register it.
   * Persists as JSON in the webhooks directory.
   */
  async saveSource(source: WebhookSource): Promise<string> {
    this.registerSource(source);

    const dir = this.webhooksDir;
    if (!dir) throw new Error('No webhooks directory configured');

    await mkdir(dir, { recursive: true });
    const filepath = join(dir, `${source.id}.json`);
    await writeFile(filepath, JSON.stringify(source, null, 2));
    return filepath;
  }

  /**
   * Load all webhook sources from the webhooks directory.
   */
  async loadSources(): Promise<number> {
    const dir = this.webhooksDir;
    if (!dir) return 0;

    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return 0;
    }

    let loaded = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(join(dir, file), 'utf-8');
        const source = JSON.parse(content) as WebhookSource;
        if (source.id && source.sourceType) {
          this.registerSource(source);
          loaded++;
        }
      } catch (err) {
        console.error(`[webhooks] Failed to load ${file}:`, err);
      }
    }
    return loaded;
  }

  // ─── Webhook Handling ───────────────────────────────────────

  /**
   * Handle an incoming webhook for a registered source.
   *
   * Flow:
   * 1. Look up source config
   * 2. Verify signature (if configured)
   * 3. Check event type filter (if configured)
   * 4. Normalize payload to EpisodeInput
   * 5. Ingest into brain
   */
  async handle(
    sourceId: string,
    payload: unknown,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WebhookResult> {
    const source = this.sources.get(sourceId);
    if (!source) {
      return { source: sourceId, accepted: false, episodes: 0, errors: 0, reason: `Unknown webhook source: ${sourceId}` };
    }

    // 1. Verify signature
    if (source.secret && source.signatureHeader) {
      try {
        this.verifySignature(source, rawBody, headers);
      } catch (err: any) {
        return { source: sourceId, accepted: false, episodes: 0, errors: 0, reason: err.message };
      }
    }

    // 2. Check event type filter
    if (source.eventTypeHeader && source.allowedEvents?.length) {
      const eventType = headers[source.eventTypeHeader.toLowerCase()];
      if (eventType && !source.allowedEvents.includes(eventType)) {
        return { source: sourceId, accepted: true, episodes: 0, errors: 0, reason: `Event type "${eventType}" not in allowed list` };
      }
    }

    // 3. Normalize payload to episode(s)
    const episodes = this.normalize(source, payload);
    if (episodes.length === 0) {
      return { source: sourceId, accepted: true, episodes: 0, errors: 0, reason: 'No content extracted from payload' };
    }

    // 4. Ingest
    let ingested = 0;
    let errors = 0;
    for (const episode of episodes) {
      try {
        await this.brain.ingest(episode);
        ingested++;
      } catch (err) {
        errors++;
        console.error(`[webhooks:${sourceId}] Ingest error:`, err);
      }
    }

    return { source: sourceId, accepted: true, episodes: ingested, errors };
  }

  /**
   * Ingest a raw webhook payload directly.
   * No source config needed — the caller provides all fields inline.
   * Good for Zapier, custom scripts, one-off integrations.
   */
  async ingestRaw(payload: RawWebhookPayload): Promise<WebhookResult> {
    if (!payload.content || !payload.sourceType) {
      return { source: 'raw', accepted: false, episodes: 0, errors: 0, reason: 'content and sourceType are required' };
    }

    try {
      await this.brain.ingest({
        content: payload.content,
        sourceType: payload.sourceType,
        sourceId: payload.sourceId,
        validAt: payload.validAt ? new Date(payload.validAt) : new Date(),
        metadata: payload.metadata,
        groupId: payload.groupId,
      });
      return { source: 'raw', accepted: true, episodes: 1, errors: 0 };
    } catch (err: any) {
      console.error('[webhooks:raw] Ingest error:', err);
      return { source: 'raw', accepted: false, episodes: 0, errors: 1, reason: err.message };
    }
  }

  // ─── Signature Verification ─────────────────────────────────

  private verifySignature(
    source: WebhookSource,
    rawBody: string,
    headers: Record<string, string>,
  ): void {
    const header = source.signatureHeader!.toLowerCase();
    const receivedSig = headers[header];
    if (!receivedSig) {
      throw new Error(`Missing signature header: ${source.signatureHeader}`);
    }

    const algorithm = source.signatureAlgorithm || 'sha256';
    const prefix = source.signaturePrefix || '';

    const computed = prefix + createHmac(algorithm, source.secret!)
      .update(rawBody)
      .digest('hex');

    const sigBuf = Buffer.from(receivedSig);
    const computedBuf = Buffer.from(computed);

    if (sigBuf.length !== computedBuf.length || !timingSafeEqual(sigBuf, computedBuf)) {
      throw new Error('Invalid webhook signature');
    }
  }

  // ─── Payload Normalization ──────────────────────────────────

  private normalize(source: WebhookSource, payload: unknown): EpisodeInput[] {
    const data = payload as Record<string, unknown>;

    // Extract content
    const content = source.contentTemplate
      ? this.renderTemplate(source.contentTemplate, data)
      : this.autoExtractContent(data);

    if (!content || !content.trim()) return [];

    // Extract sourceId
    const sourceId = source.sourceIdTemplate
      ? this.renderTemplate(source.sourceIdTemplate, data)
      : undefined;

    // Extract timestamp
    const validAt = source.dateField
      ? this.parseDate(this.getNestedValue(data, source.dateField))
      : new Date();

    // Extract metadata
    const metadata: Record<string, unknown> = {};
    if (source.metadataFields) {
      for (const field of source.metadataFields) {
        const value = this.getNestedValue(data, field);
        if (value !== undefined) {
          metadata[field.replace(/\./g, '_')] = value;
        }
      }
    }

    return [{
      content,
      sourceType: source.sourceType,
      sourceId: sourceId || undefined,
      validAt,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      groupId: source.groupId,
    }];
  }

  /**
   * Render a template string with {{field}} and {{nested.field}} placeholders.
   */
  private renderTemplate(template: string, data: Record<string, unknown>): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
      const value = this.getNestedValue(data, path.trim());
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    });
  }

  /**
   * Get a value from a nested object using dot-path notation.
   * e.g., "event.user.name" → data.event.user.name
   */
  private getNestedValue(data: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = data;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /**
   * Auto-extract content when no template is provided.
   * Looks for common content fields and builds a reasonable text representation.
   */
  private autoExtractContent(data: Record<string, unknown>): string {
    // Try common content field names in priority order
    const contentFields = [
      'content', 'text', 'message', 'body', 'description',
      'summary', 'title', 'subject', 'note',
    ];

    const parts: string[] = [];

    // Check top-level fields
    for (const field of contentFields) {
      const value = data[field];
      if (typeof value === 'string' && value.trim()) {
        parts.push(value.trim());
      }
    }

    // If nothing found at top level, check common nested patterns
    if (parts.length === 0) {
      const nested = [
        'event.text', 'event.message', 'data.content', 'data.text',
        'payload.text', 'payload.message', 'record.content',
      ];
      for (const path of nested) {
        const value = this.getNestedValue(data, path);
        if (typeof value === 'string' && value.trim()) {
          parts.push(value.trim());
        }
      }
    }

    // Last resort: serialize the whole payload
    if (parts.length === 0) {
      return JSON.stringify(data, null, 2);
    }

    return parts.join('\n\n');
  }

  private parseDate(value: unknown): Date {
    if (!value) return new Date();
    if (value instanceof Date) return value;
    if (typeof value === 'number') {
      // Unix timestamp: if < 10 billion, assume seconds; otherwise ms
      return new Date(value < 1e10 ? value * 1000 : value);
    }
    if (typeof value === 'string') {
      const d = new Date(value);
      return isNaN(d.getTime()) ? new Date() : d;
    }
    return new Date();
  }
}
