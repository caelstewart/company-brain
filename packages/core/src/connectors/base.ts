/**
 * AbstractConnector: base class for all connectors.
 *
 * Provides config validation (Zod), rate-limited fetch with retry,
 * and structured logging. Extend this instead of implementing
 * Connector directly.
 */

import { z } from 'zod';
import type { EpisodeInput } from '../types.js';
import type { Connector, SyncOptions } from './types.js';

export interface ConnectorOptions {
  /** Minimum milliseconds between API requests. Default 100. */
  rateLimitMs?: number;
  /** Maximum retry attempts on transient failure. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Default 1000. */
  retryBaseMs?: number;
}

export abstract class AbstractConnector<TConfig = unknown> implements Connector {
  abstract readonly id: string;
  abstract readonly name: string;

  /** Zod schema for config validation. Parsed in init(). */
  abstract readonly configSchema: z.ZodType<TConfig>;

  protected config!: TConfig;
  protected groupId?: string;

  private lastRequestAt = 0;
  private rateLimitMs: number;
  private maxRetries: number;
  private retryBaseMs: number;

  constructor(options?: ConnectorOptions) {
    this.rateLimitMs = options?.rateLimitMs ?? 100;
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryBaseMs = options?.retryBaseMs ?? 1000;
  }

  /**
   * Validates config with the Zod schema, then calls setup().
   * Do not override this. Override setup() instead.
   */
  async init(rawConfig: Record<string, unknown>): Promise<void> {
    const result = this.configSchema.safeParse(rawConfig);
    if (!result.success) {
      const issues = result.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`[${this.id}] Invalid config: ${issues}`);
    }
    this.config = result.data;
    if ('groupId' in rawConfig && typeof rawConfig.groupId === 'string') {
      this.groupId = rawConfig.groupId;
    }
    await this.setup(this.config);
  }

  /**
   * Called after config validation passes. Authenticate, verify access, etc.
   * Override this in your connector.
   */
  abstract setup(config: TConfig): Promise<void>;

  /**
   * Fetch data from the source. Return episodes to ingest.
   * Override this in your connector.
   */
  abstract sync(options?: SyncOptions): Promise<EpisodeInput[]>;

  /**
   * Rate-limited fetch with automatic retry and exponential backoff.
   * Handles 429 responses by reading Retry-After header.
   * Use this for all external API calls in your connector.
   */
  protected async fetchWithRetry(url: string | URL, init?: RequestInit): Promise<Response> {
    const now = Date.now();
    const wait = this.rateLimitMs - (now - this.lastRequestAt);
    if (wait > 0) await sleep(wait);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        this.lastRequestAt = Date.now();
        const res = await fetch(url.toString(), init);

        if (res.status === 429) {
          const retryAfter = res.headers.get('retry-after');
          const delay = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : this.retryBaseMs * Math.pow(2, attempt);
          this.log('warn', `Rate limited (429), retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }

        return res;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries) {
          const delay = this.retryBaseMs * Math.pow(2, attempt);
          this.log('warn', `Request failed (attempt ${attempt + 1}/${this.maxRetries + 1}), retrying in ${delay}ms: ${lastError.message}`);
          await sleep(delay);
        }
      }
    }

    throw lastError ?? new Error(`[${this.id}] Request failed after ${this.maxRetries + 1} attempts`);
  }

  /**
   * Fetch JSON with rate limiting and retry.
   * Shorthand for fetchWithRetry + res.json().
   */
  protected async fetchJson<T = unknown>(url: string | URL, init?: RequestInit): Promise<T> {
    const res = await this.fetchWithRetry(url, init);
    return res.json() as Promise<T>;
  }

  /**
   * Structured logging with connector prefix.
   */
  protected log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    const prefix = `[connector:${this.id}]`;
    const args = data !== undefined ? [prefix, message, data] : [prefix, message];
    if (level === 'error') console.error(...args);
    else if (level === 'warn') console.warn(...args);
    else console.log(...args);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
