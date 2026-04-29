/**
 * Configurable Connector.
 *
 * A generic REST API connector driven by a JSON definition file.
 * Handles authentication, pagination, and content mapping without code.
 *
 * Drop a JSON file in ~/.company-brain/connectors/ and it becomes
 * a connector type you can connect and sync like any built-in.
 *
 * Covers most REST APIs. For GraphQL, custom auth flows, or complex
 * data transformations, write a proper connector class or use a
 * standalone script that POSTs to /api/ingest.
 */

import { z } from 'zod';
import type { EpisodeInput } from '../types.js';
import type { Connector, SyncOptions } from './types.js';

// ─── Definition Schema (the JSON config file) ────────────

export const ConnectorDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),

  /** URL template. Use {{varName}} for values from instance config. */
  url: z.string().min(1),

  /** Authentication. */
  auth: z.object({
    type: z.enum(['bearer', 'header', 'query']),
    /** Header name for type 'header' (e.g. 'X-Figma-Token'). */
    header: z.string().optional(),
    /** Query param name for type 'query' (e.g. 'api_key'). */
    param: z.string().optional(),
    /** Value template (e.g. '{{token}}'). */
    value: z.string(),
  }).optional(),

  /** Extra headers to send on every request. */
  headers: z.record(z.string()).optional(),

  /** Dot-path to the records array in the response. Omit if response IS the array. */
  records: z.string().optional(),

  /** Pagination config. Omit for single-page APIs. */
  pagination: z.object({
    type: z.enum(['cursor', 'offset', 'page']),
    /** Response field containing next cursor (for cursor pagination). */
    cursorField: z.string().optional(),
    /** Query param to send cursor (default: 'cursor'). */
    cursorParam: z.string().optional(),
    /** Query param for page number (default: 'page'). */
    pageParam: z.string().optional(),
    /** Query param for offset (default: 'offset'). */
    offsetParam: z.string().optional(),
    /** Query param for page size (default: 'limit'). */
    limitParam: z.string().optional(),
    /** Page size (default: 100). */
    limit: z.number().optional(),
  }).optional(),

  /** Template for episode content. Uses {{fieldName}} from record. Nested: {{user.name}}. */
  content: z.string().optional(),
  /** Template for sourceId. Uses {{fieldName}} from record, {{_config.varName}} from instance config. */
  sourceId: z.string().optional(),
  /** sourceType on episodes. */
  sourceType: z.string(),
  /** Record field containing the timestamp (e.g. 'created_at'). */
  dateField: z.string().optional(),

  /** Query param name for incremental sync (e.g. 'since', 'updated_after'). */
  sinceParam: z.string().optional(),
  /** How to format the since date: 'iso' (default) or 'unix'. */
  sinceFormat: z.enum(['iso', 'unix']).optional(),

  /** Milliseconds between requests (default: 200). */
  rateLimitMs: z.number().optional(),
});

export type ConnectorDefinition = z.infer<typeof ConnectorDefinitionSchema>;

// ─── Configurable Connector ──────────────────────────────

export class ConfigurableConnector implements Connector {
  readonly id: string;
  readonly name: string;

  private definition: ConnectorDefinition;
  private instanceConfig: Record<string, string> = {};
  private groupId?: string;
  private lastRequestAt = 0;

  constructor(definition: ConnectorDefinition) {
    this.definition = definition;
    this.id = definition.id;
    this.name = definition.name;
  }

  async init(config: Record<string, unknown>): Promise<void> {
    // Store instance config (all values as strings for template interpolation)
    for (const [k, v] of Object.entries(config)) {
      if (k === 'groupId') {
        this.groupId = String(v);
      } else {
        this.instanceConfig[k] = String(v ?? '');
      }
    }

    // Verify we can build the URL (catches missing template vars early)
    try {
      this.buildUrl();
    } catch (err: any) {
      throw new Error(`[${this.id}] Config error: ${err.message}`);
    }

    // Make a test request to verify auth works
    const url = this.buildUrl();
    const headers = this.buildHeaders();
    const testUrl = this.applyAuthToUrl(url, headers);

    await this.rateLimitedFetch(testUrl, { headers });
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const limit = options?.limit ?? 500;
    const episodes: EpisodeInput[] = [];
    const def = this.definition;
    const pag = def.pagination;

    let page = 1;
    let offset = 0;
    let cursor: string | undefined = options?.cursor;

    while (episodes.length < limit) {
      // Build request URL
      let url = this.buildUrl();
      const params = new URL(url).searchParams;

      // Pagination params
      if (pag) {
        const limitParam = pag.limitParam || 'limit';
        const pageSize = pag.limit || 100;
        params.set(limitParam, String(Math.min(pageSize, limit - episodes.length)));

        if (pag.type === 'cursor' && cursor) {
          params.set(pag.cursorParam || 'cursor', cursor);
        } else if (pag.type === 'page') {
          params.set(pag.pageParam || 'page', String(page));
        } else if (pag.type === 'offset') {
          params.set(pag.offsetParam || 'offset', String(offset));
        }
      }

      // Since param for incremental sync
      if (options?.since && def.sinceParam) {
        const fmt = def.sinceFormat || 'iso';
        const value = fmt === 'unix'
          ? String(Math.floor(options.since.getTime() / 1000))
          : options.since.toISOString();
        params.set(def.sinceParam, value);
      }

      // Rebuild URL with params
      const urlObj = new URL(url);
      urlObj.search = params.toString();

      const headers = this.buildHeaders();
      const finalUrl = this.applyAuthToUrl(urlObj.toString(), headers);

      // Fetch
      const res = await this.rateLimitedFetch(finalUrl, { headers });
      if (!res.ok) {
        throw new Error(`[${this.id}] API returned ${res.status}: ${await res.text().catch(() => 'unknown')}`);
      }

      const body = await res.json();

      // Extract records
      const records = def.records ? getNestedValue(body, def.records) : body;
      if (!Array.isArray(records) || records.length === 0) break;

      // Convert records to episodes
      for (const record of records) {
        const content = this.recordToContent(record);
        if (!content.trim()) continue;

        episodes.push({
          content,
          sourceType: def.sourceType,
          sourceId: this.recordToSourceId(record),
          validAt: this.recordToDate(record),
          groupId: this.groupId,
          metadata: this.extractMetadata(record),
        });
      }

      // Advance pagination
      if (!pag) break;

      if (pag.type === 'cursor') {
        const nextCursor = pag.cursorField ? getNestedValue(body, pag.cursorField) : undefined;
        if (!nextCursor || typeof nextCursor !== 'string') break;
        cursor = nextCursor;
      } else if (pag.type === 'page') {
        page++;
        if (records.length < (pag.limit || 100)) break;
      } else if (pag.type === 'offset') {
        offset += records.length;
        if (records.length < (pag.limit || 100)) break;
      }
    }

    return episodes;
  }

  // ─── Helpers ──────────────────────────────────────────────

  private buildUrl(): string {
    return interpolate(this.definition.url, this.instanceConfig);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Extra headers from definition
    if (this.definition.headers) {
      for (const [k, v] of Object.entries(this.definition.headers)) {
        headers[k] = interpolate(v, this.instanceConfig);
      }
    }

    // Auth header
    const auth = this.definition.auth;
    if (auth) {
      const value = interpolate(auth.value, this.instanceConfig);
      if (auth.type === 'bearer') {
        headers['Authorization'] = `Bearer ${value}`;
      } else if (auth.type === 'header') {
        headers[auth.header || 'Authorization'] = value;
      }
    }

    return headers;
  }

  private applyAuthToUrl(url: string, _headers: Record<string, string>): string {
    const auth = this.definition.auth;
    if (auth?.type === 'query' && auth.param) {
      const urlObj = new URL(url);
      urlObj.searchParams.set(auth.param, interpolate(auth.value, this.instanceConfig));
      return urlObj.toString();
    }
    return url;
  }

  private recordToContent(record: any): string {
    if (this.definition.content) {
      return interpolateRecord(this.definition.content, record, this.instanceConfig);
    }

    // Auto-detect content fields (same priority as NangoConnector)
    const fields = ['content', 'text', 'body', 'description', 'message', 'summary', 'note'];
    for (const field of fields) {
      if (typeof record[field] === 'string' && record[field].trim()) {
        const title = record.title || record.name || record.subject;
        if (title) return `${title}\n\n${record[field]}`;
        return record[field];
      }
    }

    const titleField = record.title || record.name || record.subject;
    if (typeof titleField === 'string' && titleField.trim()) return titleField;

    return JSON.stringify(record, null, 2);
  }

  private recordToSourceId(record: any): string {
    if (this.definition.sourceId) {
      return interpolateRecord(this.definition.sourceId, record, this.instanceConfig);
    }
    const id = record.id || record.external_id || crypto.randomUUID();
    return `${this.id}://${id}`;
  }

  private recordToDate(record: any): Date {
    if (this.definition.dateField) {
      const val = getNestedValue(record, this.definition.dateField);
      if (val) return new Date(String(val));
    }

    // Auto-detect
    for (const field of ['created_at', 'date', 'timestamp', 'updated_at']) {
      if (record[field]) return new Date(record[field]);
    }

    return new Date();
  }

  private extractMetadata(record: any): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    const skip = new Set(['content', 'text', 'body', 'description', 'message']);

    for (const [k, v] of Object.entries(record)) {
      if (skip.has(k)) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        meta[k] = v;
      }
    }

    return meta;
  }

  private async rateLimitedFetch(url: string, init?: RequestInit): Promise<Response> {
    const rateMs = this.definition.rateLimitMs ?? 200;
    const wait = rateMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    this.lastRequestAt = Date.now();
    return fetch(url, init);
  }
}

// ─── Template Helpers ───────────────────────────────────────

/** Interpolate {{varName}} from a flat key-value map. Throws on missing required vars. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w[\w.]*)\}\}/g, (match, key) => {
    if (key in vars) return vars[key];
    throw new Error(`Missing required variable: {{${key}}}`);
  });
}

/** Interpolate {{field}} from record, {{_config.var}} from instance config. Nested fields supported. */
function interpolateRecord(template: string, record: any, config: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const trimmed = path.trim();
    if (trimmed.startsWith('_config.')) {
      const key = trimmed.slice(8);
      return config[key] ?? '';
    }
    const val = getNestedValue(record, trimmed);
    return val != null ? String(val) : '';
  });
}

/** Get a nested value by dot-path (e.g. 'user.name'). */
function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}
