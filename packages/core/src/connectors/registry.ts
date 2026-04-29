/**
 * Connector Registry.
 *
 * Manages connector instances, orchestrates sync operations,
 * and persists sync state (cursors, timestamps) across restarts.
 */

import type { Brain } from '../index.js';
import type { Connector, ConnectorConfig, SyncResult, SyncOptions } from './types.js';

export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();
  private configs = new Map<string, ConnectorConfig>();

  constructor(private brain: Brain) {}

  /**
   * Register a connector type. Call this once per connector class.
   */
  register(connector: Connector): void {
    this.connectors.set(connector.id, connector);
  }

  /**
   * Configure and initialize a connector instance.
   */
  async connect(config: ConnectorConfig): Promise<void> {
    const connector = this.connectors.get(config.type);
    if (!connector) {
      throw new Error(`Unknown connector type: ${config.type}. Register it first with registry.register().`);
    }

    await connector.init(config.config);
    this.configs.set(config.id, config);
  }

  /**
   * Sync a connector and ingest results.
   *
   * If no `since` is provided in options, uses the last sync timestamp
   * from persistent state (stored in Postgres). After sync, saves the
   * new timestamp so the next sync only fetches new data.
   */
  async sync(connectorId: string, options?: SyncOptions): Promise<SyncResult> {
    const config = this.configs.get(connectorId);
    if (!config) throw new Error(`Connector not configured: ${connectorId}`);

    const connector = this.connectors.get(config.type);
    if (!connector) throw new Error(`Connector type not registered: ${config.type}`);

    // Load last sync state for incremental sync
    const syncOpts = { ...options };
    if (!syncOpts.since) {
      const state = await this.brain.getSyncState(connectorId);
      if (state?.lastSyncAt) {
        syncOpts.since = state.lastSyncAt;
      }
    }

    const episodes = await connector.sync(syncOpts);
    const result = await this.ingestEpisodes(connectorId, episodes, config.groupId);

    // Persist sync state
    await this.brain.setSyncState(connectorId, {
      lastSyncAt: new Date(),
      metadata: { episodes: result.episodes, errors: result.errors },
    });

    return result;
  }

  /**
   * Sync all configured connectors.
   */
  async syncAll(options?: SyncOptions): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const id of this.configs.keys()) {
      try {
        results.push(await this.sync(id, options));
      } catch (err) {
        console.error(`[registry] Failed to sync connector ${id}:`, err);
        results.push({ connector: id, episodes: 0, errors: 1 });
      }
    }
    return results;
  }

  /**
   * Handle a webhook from a connector.
   */
  async handleWebhook(
    connectorType: string,
    payload: unknown,
    headers?: Record<string, string>,
  ): Promise<SyncResult> {
    const connector = this.connectors.get(connectorType);
    if (!connector) throw new Error(`Unknown connector: ${connectorType}`);
    if (!connector.handleWebhook) throw new Error(`Connector ${connectorType} does not support webhooks`);

    const episodes = await connector.handleWebhook(payload, headers);
    return this.ingestEpisodes(connectorType, episodes);
  }

  listTypes(): string[] {
    return Array.from(this.connectors.keys());
  }

  listConfigured(): ConnectorConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Shared ingest loop. Episodes are ingested one at a time so that
   * a single failure does not block the rest.
   */
  private async ingestEpisodes(
    connectorId: string,
    episodes: import('../types.js').EpisodeInput[],
    groupId?: string,
  ): Promise<SyncResult> {
    let ingested = 0;
    let errors = 0;

    for (const episode of episodes) {
      try {
        await this.brain.ingest({
          ...episode,
          groupId: episode.groupId || groupId,
        });
        ingested++;
      } catch (err) {
        errors++;
        console.error(`[registry:${connectorId}] Ingest error:`, err);
      }
    }

    return { connector: connectorId, episodes: ingested, errors };
  }
}
