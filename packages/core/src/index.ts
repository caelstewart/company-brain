/**
 * Company Brain: Open-source temporal knowledge graph engine.
 *
 * Combines the best of gbrain (deterministic extraction, fail-improve loop),
 * Graphiti/Zep (bi-temporal facts, contradiction detection), and
 * Supermemory (simple API, profile synthesis).
 *
 * @example
 * ```typescript
 * import { Brain } from '@company-brain/core';
 *
 * const brain = new Brain({
 *   database: 'postgresql://brain:brain@localhost:5432/company_brain',
 *   embedding: { provider: 'openai' },
 *   llm: { provider: 'anthropic' },
 * });
 *
 * await brain.ingest({
 *   content: "Meeting with Alice from Acme. They're upgrading to enterprise.",
 *   sourceType: 'meeting_transcript',
 *   validAt: new Date(),
 * });
 *
 * const results = await brain.search({ query: "What's happening with Acme?" });
 * ```
 */

import type postgres from 'postgres';
import type {
  BrainConfig,
  EpisodeInput,
  Episode,
  Entity,
  Fact,
  SearchOptions,
  SearchResult,
  SchemaDefinition,
} from './types.js';
import { connect, disconnect, initSchema, getDb } from './db.js';
import { extractAndResolve, getStats, suggestPatterns } from './extraction/index.js';
import { search } from './search/index.js';
import { embed } from './embedding.js';

export * from './types.js';
export { search } from './search/index.js';
export { extractAndResolve, getStats, suggestPatterns } from './extraction/index.js';
export { SkillResolver, DEFAULT_SKILLS } from './skills/index.js';
export type { Skill, SkillMatch, ResolverConfig } from './skills/index.js';
export { ConnectorRegistry, FilesystemConnector, SlackConnector, NotionConnector } from './connectors/index.js';
export type { Connector, SyncOptions, SyncResult, ConnectorConfig } from './connectors/index.js';

export class Brain {
  private db: postgres.Sql;
  private config: BrainConfig;
  private groupId: string;

  constructor(config: BrainConfig) {
    this.config = config;
    this.groupId = config.defaultGroupId || 'default';
    this.db = connect(config);
  }

  /**
   * Initialize the database schema. Run once on first setup.
   */
  async init(): Promise<void> {
    await initSchema(this.db);
  }

  /**
   * Ingest raw data into the brain.
   *
   * Creates an episode (raw provenance), then runs the extraction pipeline
   * to extract entities and facts, resolve them against the existing graph,
   * and store everything with full temporal tracking.
   */
  async ingest(input: EpisodeInput): Promise<{
    episodeId: string;
    entitiesCreated: number;
    entitiesUpdated: number;
    factsCreated: number;
    factsInvalidated: number;
  }> {
    const groupId = input.groupId || this.groupId;
    const validAt = input.validAt || new Date();

    // 1. Store the raw episode
    const contentEmbedding = await embed(input.content, this.config.embedding).catch(() => null);
    const episodeResult = await this.db`
      INSERT INTO episodes (group_id, source_type, source_id, content, content_embedding, metadata, valid_at)
      VALUES (
        ${groupId},
        ${input.sourceType},
        ${input.sourceId || null},
        ${input.content},
        ${contentEmbedding ? `[${contentEmbedding.join(',')}]` : null},
        ${JSON.stringify(input.metadata || {})},
        ${validAt}
      )
      RETURNING id
    `;
    const episodeId = episodeResult[0].id;

    // 2. Load known entities for deterministic matching
    const knownEntities = new Map<string, { id: string; type: string }>();
    const aliases = await this.db`
      SELECT ea.alias, ea.entity_id, e.entity_type
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE e.group_id = ${groupId}
    `;
    for (const row of aliases) {
      knownEntities.set(row.alias, { id: row.entity_id, type: row.entity_type });
    }

    // 3. Run extraction pipeline
    const result = await extractAndResolve(this.db, input.content, {
      groupId,
      episodeId,
      config: this.config.extraction,
      llmConfig: this.config.llm,
      embeddingConfig: this.config.embedding,
      deterministicContext: { knownEntities },
    });

    return {
      episodeId,
      entitiesCreated: result.entitiesCreated,
      entitiesUpdated: result.entitiesUpdated,
      factsCreated: result.factsCreated,
      factsInvalidated: result.factsInvalidated,
    };
  }

  /**
   * Search the brain. Combines semantic, keyword, graph, and temporal search.
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const opts = { ...options, groupId: options.groupId || this.groupId };
    return search(this.db, opts, this.config.embedding);
  }

  /**
   * Get an entity by ID with all its current facts and connections.
   */
  async getEntity(id: string, options?: {
    includeFacts?: boolean;
    includeTimeline?: boolean;
    includeRelated?: boolean;
    depth?: number;
  }): Promise<{
    entity: Entity;
    facts: Fact[];
    related: Entity[];
    timeline: Fact[];
  } | null> {
    const rows = await this.db`SELECT * FROM entities WHERE id = ${id}`;
    if (rows.length === 0) return null;

    const entity = this.rowToEntity(rows[0]);
    let facts: Fact[] = [];
    let related: Entity[] = [];
    let timeline: Fact[] = [];

    if (options?.includeFacts !== false) {
      const factRows = await this.db`
        SELECT * FROM facts
        WHERE (source_entity_id = ${id} OR target_entity_id = ${id})
          AND invalid_at IS NULL
        ORDER BY valid_at DESC
      `;
      facts = factRows.map(this.rowToFact);
    }

    if (options?.includeTimeline) {
      const timelineRows = await this.db`
        SELECT * FROM facts
        WHERE (source_entity_id = ${id} OR target_entity_id = ${id})
        ORDER BY valid_at DESC
      `;
      timeline = timelineRows.map(this.rowToFact);
    }

    if (options?.includeRelated) {
      const depth = options?.depth || 1;
      const relatedIds = await this.db`
        SELECT DISTINCT
          CASE WHEN source_entity_id = ${id} THEN target_entity_id ELSE source_entity_id END AS related_id
        FROM facts
        WHERE (source_entity_id = ${id} OR target_entity_id = ${id})
          AND invalid_at IS NULL
        LIMIT 50
      `;
      if (relatedIds.length > 0) {
        const ids = relatedIds.map(r => r.related_id);
        const relatedRows = await this.db`SELECT * FROM entities WHERE id = ANY(${ids})`;
        related = relatedRows.map(this.rowToEntity);
      }
    }

    return { entity, facts, related, timeline };
  }

  /**
   * Find an entity by name (fuzzy matching).
   */
  async findEntity(name: string, groupId?: string): Promise<Entity | null> {
    const gid = groupId || this.groupId;
    const rows = await this.db`
      SELECT *, similarity(name, ${name}) AS sim
      FROM entities
      WHERE group_id = ${gid}
        AND similarity(name, ${name}) > 0.3
      ORDER BY sim DESC
      LIMIT 1
    `;
    return rows.length > 0 ? this.rowToEntity(rows[0]) : null;
  }

  /**
   * Get all current facts between two entities.
   */
  async getFacts(sourceId: string, targetId?: string, options?: {
    relation?: string;
    includeInvalidated?: boolean;
    asOf?: Date;
  }): Promise<Fact[]> {
    const includeInvalid = options?.includeInvalidated || false;
    const asOf = options?.asOf;

    let rows;
    if (targetId) {
      rows = await this.db`
        SELECT * FROM facts
        WHERE source_entity_id = ${sourceId}
          AND target_entity_id = ${targetId}
          ${options?.relation ? this.db`AND relation = ${options.relation}` : this.db``}
          ${!includeInvalid ? this.db`AND invalid_at IS NULL` : this.db``}
          ${asOf ? this.db`AND valid_at <= ${asOf}` : this.db``}
        ORDER BY valid_at DESC
      `;
    } else {
      rows = await this.db`
        SELECT * FROM facts
        WHERE (source_entity_id = ${sourceId} OR target_entity_id = ${sourceId})
          ${options?.relation ? this.db`AND relation = ${options.relation}` : this.db``}
          ${!includeInvalid ? this.db`AND invalid_at IS NULL` : this.db``}
          ${asOf ? this.db`AND valid_at <= ${asOf}` : this.db``}
        ORDER BY valid_at DESC
      `;
    }

    return rows.map(this.rowToFact);
  }

  /**
   * Define custom entity types and relation types for this brain.
   */
  async defineSchema(schema: SchemaDefinition): Promise<void> {
    if (schema.entityTypes) {
      for (const et of schema.entityTypes) {
        await this.db`
          INSERT INTO entity_types (id, group_id, label, description, schema)
          VALUES (${et.id}, ${this.groupId}, ${et.label}, ${et.description || ''}, ${JSON.stringify(et.schema || {})})
          ON CONFLICT (id) DO UPDATE SET label = ${et.label}, description = ${et.description || ''}
        `;
      }
    }

    if (schema.relationTypes) {
      for (const rt of schema.relationTypes) {
        await this.db`
          INSERT INTO relation_types (id, group_id, label, source_types, target_types, description)
          VALUES (${rt.id}, ${this.groupId}, ${rt.label}, ${rt.sourceTypes || []}, ${rt.targetTypes || []}, ${rt.description || ''})
          ON CONFLICT (id) DO UPDATE SET label = ${rt.label}, source_types = ${rt.sourceTypes || []}, target_types = ${rt.targetTypes || []}
        `;
      }
    }
  }

  /**
   * Get fail-improve statistics. Shows how the system is getting smarter.
   */
  async getExtractionStats(since?: Date) {
    return getStats(this.db, this.groupId, since);
  }

  /**
   * Get suggested patterns from the fail-improve loop.
   * These are recurring patterns the LLM handles that could be deterministic.
   */
  async getSuggestedPatterns(minOccurrences?: number) {
    return suggestPatterns(this.db, this.groupId, minOccurrences);
  }

  /**
   * Disconnect from the database.
   */
  async close(): Promise<void> {
    await disconnect();
  }

  // ─── Row Mappers ────────────────────────────────────────────

  private rowToEntity(row: any): Entity {
    return {
      id: row.id,
      groupId: row.group_id,
      entityType: row.entity_type,
      name: row.name,
      summary: row.summary || '',
      attributes: row.attributes || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToFact(row: any): Fact {
    return {
      id: row.id,
      groupId: row.group_id,
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      relation: row.relation,
      factText: row.fact_text,
      validAt: row.valid_at,
      invalidAt: row.invalid_at,
      confidence: Number(row.confidence),
      sourceEpisodeId: row.source_episode_id,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    };
  }
}
