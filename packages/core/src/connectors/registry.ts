/**
 * Connector Registry.
 *
 * Manages connector instances and orchestrates sync operations.
 */

import type { Brain } from '../index.js';
import type { Connector, ConnectorConfig, SyncResult, SyncOptions } from './types.js';

export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();
  private configs = new Map<string, ConnectorConfig>();

  constructor(private brain: Brain) {}

  /**
   * Register a connector type.
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
      throw new Error(`Unknown connector type: ${config.type}. Register it first.`);
    }

    await connector.init(config.config);
    this.configs.set(config.id, config);
  }

  /**
   * Sync a specific connector and ingest results.
   */
  async sync(connectorId: string, options?: SyncOptions): Promise<SyncResult> {
    const config = this.configs.get(connectorId);
    if (!config) throw new Error(`Connector not configured: ${connectorId}`);

    const connector = this.connectors.get(config.type);
    if (!connector) throw new Error(`Connector type not registered: ${config.type}`);

    const episodes = await connector.sync(options);
    let ingested = 0;
    let errors = 0;

    for (const episode of episodes) {
      try {
        await this.brain.ingest({
          ...episode,
          groupId: episode.groupId || config.groupId,
        });
        ingested++;
      } catch (err) {
        errors++;
        console.error(`Connector ${connectorId} ingest error:`, err);
      }
    }

    return {
      connector: connectorId,
      episodes: ingested,
      errors,
    };
  }

  /**
   * Sync all configured connectors.
   */
  async syncAll(options?: SyncOptions): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const id of this.configs.keys()) {
      results.push(await this.sync(id, options));
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
    let ingested = 0;
    let errors = 0;

    for (const episode of episodes) {
      try {
        await this.brain.ingest(episode);
        ingested++;
      } catch (err) {
        errors++;
      }
    }

    return { connector: connectorType, episodes: ingested, errors };
  }

  /**
   * List all registered connector types.
   */
  listTypes(): string[] {
    return Array.from(this.connectors.keys());
  }

  /**
   * List all configured connector instances.
   */
  listConfigured(): ConnectorConfig[] {
    return Array.from(this.configs.values());
  }
}
