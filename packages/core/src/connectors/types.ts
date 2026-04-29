/**
 * Connector framework types.
 *
 * Connectors normalize external data sources into episodes
 * for the brain to ingest.
 */

import type { EpisodeInput } from '../types.js';

export interface Connector {
  /** Unique connector ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Initialize the connector (authenticate, validate config) */
  init(config: Record<string, unknown>): Promise<void>;
  /** Sync data from the source. Returns episodes to ingest. */
  sync(options?: SyncOptions): Promise<EpisodeInput[]>;
  /** Handle a webhook payload from the source. Returns episodes to ingest. */
  handleWebhook?(payload: unknown, headers?: Record<string, string>): Promise<EpisodeInput[]>;
  /** Disconnect / cleanup */
  close?(): Promise<void>;
}

export interface SyncOptions {
  /** Only sync data after this date */
  since?: Date;
  /** Maximum items to sync */
  limit?: number;
  /** Cursor for pagination */
  cursor?: string;
  /** Specific channel/folder/resource to sync */
  resource?: string;
}

export interface SyncResult {
  connector: string;
  episodes: number;
  errors: number;
  cursor?: string;
  nextSyncAt?: Date;
}

export interface ConnectorConfig {
  id: string;
  type: string;
  config: Record<string, unknown>;
  /** Cron-like sync schedule */
  schedule?: string;
  /** Group to ingest into */
  groupId?: string;
}
