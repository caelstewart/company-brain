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
 *   llm: { provider: 'openai' },
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
  AccessContext,
  SearchOptions,
  SearchResult,
  SchemaDefinition,
  OrganizationalMemoryKind,
  OrganizationalMemoryStatus,
} from './types.js';
import { connect, disconnect, initSchema, getDb } from './db.js';
import { extractAndResolve, getStats, proposeImprovements, suggestPatterns } from './extraction/index.js';
import { search } from './search/index.js';
import { embed } from './embedding.js';
import { normalizeEpisodeInput } from './normalization.js';
import { normalizeVisibility, simulatePermission, visibilitySql } from './security.js';
import { processCanonicalClusters } from './graph/index.js';
import { promoteSkillsFromProposals } from './skills/index.js';
import { answerQuestion } from './answer/index.js';
import { runDbBackedEvalSuite, runTriageEvalSuite, summarizeTriageEvalResults, type EvalFixture } from './eval/index.js';
import { deriveOrganizationalMemory, listOrganizationalMemory, searchOrganizationalMemory, storeOrganizationalMemory } from './memory/index.js';
import { triageInteraction, triageInteractionWithLLM } from './triage/index.js';

export * from './types.js';
export { getDb, disconnect } from './db.js';
export { search, rrfFusion, routeQuery, routeQueryWithLLM, decompose, executePlan, graphTraversalSearch, findSeedEntities, traverseGraph, personalizedPageRank, computePPR, detectCommunities, buildCommunities, searchCommunities, buildAndSummarize } from './search/index.js';
export { asOf, changedSince, validDuring, entityTimeline, recentContradictions } from './search/temporal.js';
export type { RoutingDecision, QueryIntent, QueryTier } from './search/router.js';
export type { SubQuery, DecompositionPlan } from './search/decomposer.js';
export type { TraversalOptions } from './search/graph-traversal.js';
export type { PPROptions } from './search/pagerank.js';
export type { TemporalOptions } from './search/temporal.js';
export type { Community } from './search/communities.js';
export { extractAndResolve, getStats, proposeImprovements, suggestPatterns } from './extraction/index.js';
export { SkillResolver, DEFAULT_SKILLS, loadSkillsFromDir, saveSkillToDir, skillToMarkdown, promoteSkillsFromProposals, skillFromProposal, validateSkill } from './skills/index.js';
export type { Skill, SkillMatch, ResolverConfig, SkillPromotionOptions, SkillPromotionResult } from './skills/index.js';
export { AbstractConnector, ConnectorRegistry, FilesystemConnector, NangoConnector, ConfigurableConnector, loadConnectorsFromDir, validateDefinition, ConnectorDefinitionSchema } from './connectors/index.js';
export type { ConnectorOptions, Connector, SyncOptions, SyncResult, ConnectorConfig, ConnectorDefinition } from './connectors/index.js';
export { WebhookReceiver } from './webhooks/index.js';
export type { WebhookSource, WebhookResult, RawWebhookPayload } from './webhooks/index.js';
export { normalizeEpisodeInput } from './normalization.js';
export { canAccessVisibility, isPublicVisibility, normalizeVisibility, simulatePermission, visibilityFromSourcePermissions, mergeVisibilityPolicies, visibilityWarnings } from './security.js';
export { answerQuestion } from './answer/index.js';
export type { AnswerCitation, AnswerOptions, GroundedAnswer } from './answer/index.js';
export { deriveOrganizationalMemory, listOrganizationalMemory, searchOrganizationalMemory, storeOrganizationalMemory } from './memory/index.js';
export { triageInteraction, triageInteractionWithLLM } from './triage/index.js';
export { runEvalFixture, runEvalSuite, scoreQuery, summarizeEvalResults, allEvalFixtures, baselineEvalFixtures, pressureEvalFixtures, BrainEvalAdapter, runDbBackedEvalSuite, triagePressureFixtures, runTriageEvalSuite, summarizeTriageEvalResults } from './eval/index.js';
export type { EvalAdapter, EvalFixture, EvalExpectations, EvalQueryExpectation, EvalQueryResult, EvalRunResult, TriageEvalCase, TriageEvalResult } from './eval/index.js';
export { proposeCanonicalClusters, proposeEntityClusters, proposeRelationClusters, processCanonicalClusters } from './graph/index.js';
export type { CanonicalCluster, CanonicalizationPolicyResult, ClusterOptions } from './graph/index.js';

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
   *
   * If the episode has a sourceId that already exists, it is skipped (dedup).
   */
  async ingest(input: EpisodeInput): Promise<{
    episodeId: string;
    entitiesCreated: number;
    entitiesUpdated: number;
    factsCreated: number;
    factsInvalidated: number;
    memoryCreated: number;
    ambiguities: Array<{
      type: 'entity_resolution' | 'fact_resolution';
      reason: string;
      payload: Record<string, unknown>;
    }>;
    skipped?: boolean;
    skipReason?: string;
  }> {
    const groupId = input.groupId || this.groupId;
    const validAt = input.validAt || new Date();
    const normalized = normalizeEpisodeInput(input);
    const triage = await triageInteractionWithLLM(normalized.content, {
      sourceType: input.sourceType,
      metadata: { ...normalized.metadata, visibility: normalized.visibility },
      config: this.config.triage,
      llmConfig: this.config.llm,
    });
    const episodeMetadata = { ...normalized.metadata, triage };

    // 0. Ensure group exists
    await this.db`
      INSERT INTO groups (id, name) VALUES (${groupId}, ${groupId})
      ON CONFLICT (id) DO NOTHING
    `;

    if (!triage.shouldStoreEpisode) {
      await this.auditLog(groupId, 'ingest_triage_drop', 'episode', null, {
        sourceType: input.sourceType,
        sourceId: input.sourceId || null,
        triage,
      });
      return {
        episodeId: '',
        entitiesCreated: 0,
        entitiesUpdated: 0,
        factsCreated: 0,
        factsInvalidated: 0,
        memoryCreated: 0,
        ambiguities: [],
        skipped: true,
        skipReason: 'triage_drop',
      };
    }

    // 1. Store the raw episode (with dedup on source_id)
    const contentEmbedding = await embed(normalized.content, this.config.embedding).catch(() => null);
    let episodeId: string;
    try {
      const episodeResult = await this.db`
        INSERT INTO episodes (group_id, source_type, source_id, content, content_embedding, metadata, visibility, valid_at)
        VALUES (
          ${groupId},
          ${input.sourceType},
          ${input.sourceId || null},
          ${normalized.content},
          ${contentEmbedding ? `[${contentEmbedding.join(',')}]` : null},
          ${this.db.json(episodeMetadata as any)},
          ${this.db.json(normalized.visibility as any)},
          ${validAt}
        )
        ON CONFLICT (group_id, source_type, source_id) WHERE source_id IS NOT NULL
        DO NOTHING
        RETURNING id
      `;
      if (episodeResult.length === 0) {
        // Episode already exists — skip extraction entirely
        const existing = await this.db`
          SELECT id FROM episodes
          WHERE group_id = ${groupId} AND source_type = ${input.sourceType} AND source_id = ${input.sourceId || null}
          LIMIT 1
        `;
        return {
          episodeId: existing[0]?.id ?? '',
          entitiesCreated: 0,
          entitiesUpdated: 0,
          factsCreated: 0,
          factsInvalidated: 0,
          memoryCreated: 0,
          ambiguities: [],
          skipped: true,
        };
      }
      episodeId = episodeResult[0].id;
    } catch {
      // Fallback for DBs without the unique index yet
      const episodeResult = await this.db`
        INSERT INTO episodes (group_id, source_type, source_id, content, content_embedding, metadata, visibility, valid_at)
        VALUES (
          ${groupId},
          ${input.sourceType},
          ${input.sourceId || null},
          ${normalized.content},
          ${contentEmbedding ? `[${contentEmbedding.join(',')}]` : null},
          ${this.db.json(episodeMetadata as any)},
          ${this.db.json(normalized.visibility as any)},
          ${validAt}
        )
        RETURNING id
      `;
      episodeId = episodeResult[0].id;
    }

    if (!triage.shouldExtract && !triage.shouldStoreMemory) {
      await this.auditLog(groupId, 'ingest_triage_ephemeral', 'episode', episodeId, {
        sourceType: input.sourceType,
        sourceId: input.sourceId || null,
        triage,
      });
      return {
        episodeId,
        entitiesCreated: 0,
        entitiesUpdated: 0,
        factsCreated: 0,
        factsInvalidated: 0,
        memoryCreated: 0,
        ambiguities: [],
        skipped: true,
        skipReason: 'triage_ephemeral',
      };
    }

    // 2. Load known entities for deterministic matching
    const knownEntities = await this.loadKnownEntities(groupId);

    // 3. Run extraction pipeline
    const result = await extractAndResolve(this.db, normalized.content, {
      groupId,
      episodeId,
      config: this.config.extraction,
      llmConfig: this.config.llm,
      embeddingConfig: this.config.embedding,
      deterministicContext: { knownEntities },
      visibility: normalized.visibility,
    });

    const memoryObjects = await deriveOrganizationalMemory(normalized.content, {
      groupId,
      episodeId,
      sourceType: input.sourceType,
      metadata: episodeMetadata,
      visibility: normalized.visibility,
      validAt,
      llmConfig: this.config.llm,
    });
    const memoryCreated = await storeOrganizationalMemory(this.db, memoryObjects, {
      groupId,
      embeddingConfig: this.config.embedding,
    });

    await this.auditLog(groupId, 'ingest', 'episode', episodeId, {
      sourceType: input.sourceType,
      sourceId: input.sourceId || null,
      visibility: normalized.visibility,
      triage,
      memoryCreated,
    });

    return {
      episodeId,
      entitiesCreated: result.entitiesCreated,
      entitiesUpdated: result.entitiesUpdated,
      factsCreated: result.factsCreated,
      factsInvalidated: result.factsInvalidated,
      memoryCreated,
      ambiguities: result.ambiguities,
    };
  }

  /**
   * Batch ingest multiple episodes efficiently.
   *
   * Shares the known-entity cache across all episodes in the batch,
   * deduplicates episodes by source_id, and refreshes the cache
   * after each episode so later episodes in the batch can resolve
   * entities created by earlier ones.
   */
  async ingestBatch(inputs: EpisodeInput[]): Promise<{
    total: number;
    ingested: number;
    skipped: number;
    entitiesCreated: number;
    entitiesUpdated: number;
    factsCreated: number;
    factsInvalidated: number;
    memoryCreated: number;
    ambiguities: Array<{
      sourceId?: string;
      type: 'entity_resolution' | 'fact_resolution';
      reason: string;
      payload: Record<string, unknown>;
    }>;
  }> {
    if (inputs.length === 0) {
      return { total: 0, ingested: 0, skipped: 0, entitiesCreated: 0, entitiesUpdated: 0, factsCreated: 0, factsInvalidated: 0, memoryCreated: 0, ambiguities: [] };
    }

    const groupId = inputs[0].groupId || this.groupId;

    // Ensure group exists once
    await this.db`
      INSERT INTO groups (id, name) VALUES (${groupId}, ${groupId})
      ON CONFLICT (id) DO NOTHING
    `;

    // Load known entities once for the whole batch
    let knownEntities = await this.loadKnownEntities(groupId);

    let ingested = 0;
    let skipped = 0;
    let totalEntitiesCreated = 0;
    let totalEntitiesUpdated = 0;
    let totalFactsCreated = 0;
    let totalFactsInvalidated = 0;
    let totalMemoryCreated = 0;
    const ambiguities: Array<{
      sourceId?: string;
      type: 'entity_resolution' | 'fact_resolution';
      reason: string;
      payload: Record<string, unknown>;
    }> = [];

    for (const input of inputs) {
      const validAt = input.validAt || new Date();
      const normalized = normalizeEpisodeInput(input);
      const triage = await triageInteractionWithLLM(normalized.content, {
        sourceType: input.sourceType,
        metadata: { ...normalized.metadata, visibility: normalized.visibility },
        config: this.config.triage,
        llmConfig: this.config.llm,
      });
      const episodeMetadata = { ...normalized.metadata, triage };

      if (!triage.shouldStoreEpisode) {
        await this.auditLog(groupId, 'ingest_triage_drop', 'episode', null, {
          sourceType: input.sourceType,
          sourceId: input.sourceId || null,
          triage,
        });
        skipped++;
        continue;
      }

      // Store episode with dedup
      const contentEmbedding = await embed(normalized.content, this.config.embedding).catch(() => null);
      let episodeId: string;
      try {
        const episodeResult = await this.db`
          INSERT INTO episodes (group_id, source_type, source_id, content, content_embedding, metadata, visibility, valid_at)
          VALUES (
            ${groupId},
            ${input.sourceType},
            ${input.sourceId || null},
            ${normalized.content},
            ${contentEmbedding ? `[${contentEmbedding.join(',')}]` : null},
            ${this.db.json(episodeMetadata as any)},
            ${this.db.json(normalized.visibility as any)},
            ${validAt}
          )
          ON CONFLICT (group_id, source_type, source_id) WHERE source_id IS NOT NULL
          DO NOTHING
          RETURNING id
        `;
        if (episodeResult.length === 0) {
          skipped++;
          continue;
        }
        episodeId = episodeResult[0].id;
      } catch {
        const episodeResult = await this.db`
          INSERT INTO episodes (group_id, source_type, source_id, content, content_embedding, metadata, visibility, valid_at)
          VALUES (
            ${groupId},
            ${input.sourceType},
            ${input.sourceId || null},
            ${normalized.content},
            ${contentEmbedding ? `[${contentEmbedding.join(',')}]` : null},
            ${this.db.json(episodeMetadata as any)},
            ${this.db.json(normalized.visibility as any)},
            ${validAt}
          )
          RETURNING id
        `;
        episodeId = episodeResult[0].id;
      }

      if (!triage.shouldExtract && !triage.shouldStoreMemory) {
        await this.auditLog(groupId, 'ingest_triage_ephemeral', 'episode', episodeId, {
          sourceType: input.sourceType,
          sourceId: input.sourceId || null,
          triage,
        });
        skipped++;
        continue;
      }

      // Run extraction with shared entity cache
      const result = await extractAndResolve(this.db, normalized.content, {
        groupId,
        episodeId,
        config: this.config.extraction,
        llmConfig: this.config.llm,
        embeddingConfig: this.config.embedding,
        deterministicContext: { knownEntities },
        visibility: normalized.visibility,
      });

      const memoryObjects = await deriveOrganizationalMemory(normalized.content, {
        groupId,
        episodeId,
        sourceType: input.sourceType,
        metadata: episodeMetadata,
        visibility: normalized.visibility,
        validAt,
        llmConfig: this.config.llm,
      });
      const memoryCreated = await storeOrganizationalMemory(this.db, memoryObjects, {
        groupId,
        embeddingConfig: this.config.embedding,
      });

      totalEntitiesCreated += result.entitiesCreated;
      totalEntitiesUpdated += result.entitiesUpdated;
      totalFactsCreated += result.factsCreated;
      totalFactsInvalidated += result.factsInvalidated;
      totalMemoryCreated += memoryCreated;
      ambiguities.push(...result.ambiguities.map(ambiguity => ({
        sourceId: input.sourceId,
        ...ambiguity,
      })));
      ingested++;

      // Refresh known entities cache if new entities were created
      // so subsequent episodes in the batch can resolve them
      if (result.entitiesCreated > 0) {
        knownEntities = await this.loadKnownEntities(groupId);
      }
    }

    return {
      total: inputs.length,
      ingested,
      skipped,
      entitiesCreated: totalEntitiesCreated,
      entitiesUpdated: totalEntitiesUpdated,
      factsCreated: totalFactsCreated,
      factsInvalidated: totalFactsInvalidated,
      memoryCreated: totalMemoryCreated,
      ambiguities,
    };
  }

  /**
   * Load all known entity aliases for a group into a Map for deterministic matching.
   */
  private async loadKnownEntities(groupId: string): Promise<Map<string, { id: string; type: string }>> {
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
    return knownEntities;
  }

  /**
   * Search the brain. Combines semantic, keyword, graph, and temporal search.
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const opts = {
      ...options,
      groupId: options.groupId || this.groupId,
      llmConfig: this.config.llm,
    };
    return search(this.db, opts, this.config.embedding);
  }

  /**
   * Answer a question with citations from retrieved graph evidence.
   */
  async answer(options: SearchOptions & { trace?: boolean }) {
    return answerQuestion(this.db, {
      ...options,
      groupId: options.groupId || this.groupId,
    }, this.config.embedding, this.config.llm);
  }

  async searchMemory(options: {
    query: string;
    groupId?: string;
    limit?: number;
    access?: AccessContext;
    kinds?: OrganizationalMemoryKind[];
    statuses?: OrganizationalMemoryStatus[];
  }): Promise<SearchResult[]> {
    return searchOrganizationalMemory(this.db, {
      ...options,
      groupId: options.groupId || this.groupId,
      embeddingConfig: this.config.embedding,
    });
  }

  async listMemory(options: {
    groupId?: string;
    limit?: number;
    access?: AccessContext;
    kinds?: OrganizationalMemoryKind[];
    statuses?: OrganizationalMemoryStatus[];
  } = {}) {
    return listOrganizationalMemory(this.db, {
      ...options,
      groupId: options.groupId || this.groupId,
    });
  }

  async cleanupEphemeralEpisodes(options?: {
    groupId?: string;
    olderThanDays?: number;
    limit?: number;
  }): Promise<{ deleted: number; episodeIds: string[] }> {
    const groupId = options?.groupId || this.groupId;
    const olderThanDays = options?.olderThanDays ?? this.config.triage?.ephemeralTtlDays ?? 14;
    const limit = options?.limit ?? 1000;
    const rows = await this.db`
      WITH expired AS (
        SELECT id
        FROM episodes e
        WHERE e.group_id = ${groupId}
          AND e.metadata #>> '{triage,retention}' = 'ephemeral'
          AND e.valid_at < now() - (${olderThanDays} * interval '1 day')
          AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.source_episode_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM organizational_memory m WHERE m.source_episode_id = e.id)
        ORDER BY e.valid_at ASC
        LIMIT ${limit}
      )
      DELETE FROM episodes
      WHERE id IN (SELECT id FROM expired)
      RETURNING id
    `;
    const episodeIds = rows.map(row => String(row.id));
    if (episodeIds.length > 0) {
      await this.auditLog(groupId, 'cleanup_ephemeral_episodes', 'episode', null, {
        olderThanDays,
        deleted: episodeIds.length,
      });
    }
    return { deleted: episodeIds.length, episodeIds };
  }

  /**
   * Get an entity by ID with all its current facts and connections.
   */
  async getEntity(id: string, options?: {
    includeFacts?: boolean;
    includeTimeline?: boolean;
    includeRelated?: boolean;
    depth?: number;
    access?: AccessContext;
  }): Promise<{
    entity: Entity;
    facts: Fact[];
    related: Entity[];
    timeline: Fact[];
  } | null> {
    const rows = await this.db`
      SELECT * FROM entities
      WHERE id = ${id}
      ${visibilitySql(this.db, this.db`visibility`, options?.access)}
    `;
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
          ${visibilitySql(this.db, this.db`visibility`, options?.access)}
        ORDER BY valid_at DESC
      `;
      facts = factRows.map(this.rowToFact);
    }

    if (options?.includeTimeline) {
      const timelineRows = await this.db`
        SELECT * FROM facts
        WHERE (source_entity_id = ${id} OR target_entity_id = ${id})
        ${visibilitySql(this.db, this.db`visibility`, options?.access)}
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
          ${visibilitySql(this.db, this.db`visibility`, options?.access)}
        LIMIT 50
      `;
      if (relatedIds.length > 0) {
        const ids = relatedIds.map(r => r.related_id);
        const relatedRows = await this.db`
          SELECT * FROM entities
          WHERE id = ANY(${ids})
          ${visibilitySql(this.db, this.db`visibility`, options?.access)}
        `;
        related = relatedRows.map(this.rowToEntity);
      }
    }

    return { entity, facts, related, timeline };
  }

  /**
   * Find an entity by name (fuzzy matching).
   */
  async findEntity(name: string, groupId?: string, access?: AccessContext): Promise<Entity | null> {
    const gid = groupId || this.groupId;
    const rows = await this.db`
      SELECT *, similarity(name, ${name}) AS sim
      FROM entities
      WHERE group_id = ${gid}
        AND similarity(name, ${name}) > 0.3
        ${visibilitySql(this.db, this.db`visibility`, access)}
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
    access?: AccessContext;
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
          ${visibilitySql(this.db, this.db`visibility`, options?.access)}
        ORDER BY valid_at DESC
      `;
    } else {
      rows = await this.db`
        SELECT * FROM facts
        WHERE (source_entity_id = ${sourceId} OR target_entity_id = ${sourceId})
          ${options?.relation ? this.db`AND relation = ${options.relation}` : this.db``}
          ${!includeInvalid ? this.db`AND invalid_at IS NULL` : this.db``}
          ${asOf ? this.db`AND valid_at <= ${asOf}` : this.db``}
          ${visibilitySql(this.db, this.db`visibility`, options?.access)}
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
          ON CONFLICT (group_id, id) DO UPDATE SET
            label = ${et.label},
            description = ${et.description || ''},
            schema = ${JSON.stringify(et.schema || {})}
        `;
      }
    }

    if (schema.relationTypes) {
      for (const rt of schema.relationTypes) {
        await this.db`
          INSERT INTO relation_types (
            id, group_id, label, source_types, target_types, description,
            cardinality, invalidation_policy
          )
          VALUES (
            ${rt.id},
            ${this.groupId},
            ${rt.label},
            ${rt.sourceTypes || []},
            ${rt.targetTypes || []},
            ${rt.description || ''},
            ${rt.cardinality || 'many'},
            ${rt.invalidationPolicy || 'llm'}
          )
          ON CONFLICT (group_id, id) DO UPDATE SET
            label = ${rt.label},
            source_types = ${rt.sourceTypes || []},
            target_types = ${rt.targetTypes || []},
            description = ${rt.description || ''},
            cardinality = ${rt.cardinality || 'many'},
            invalidation_policy = ${rt.invalidationPolicy || 'llm'}
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
   * Get suggested extraction guidance improvements from the fail-improve loop.
   */
  async getSuggestedPatterns(minOccurrences?: number) {
    return suggestPatterns(this.db, this.groupId, minOccurrences);
  }

  /**
   * Get audited improvement proposals from extraction logs and review signals.
   * These are suggestions for schema, extraction, canonicalization, or skill
   * changes. They should be reviewed before being applied.
   */
  async getImprovementProposals() {
    return proposeImprovements(this.db, this.groupId);
  }

  /**
   * Propose graph-level canonical clusters across entities and relations.
   * This catches duplicate communities that pairwise resolution leaves behind.
   */
  async proposeCanonicalClusters(options?: {
    groupId?: string;
    minConfidence?: number;
    limit?: number;
    autoApplyThreshold?: number;
    ambiguousThreshold?: number;
    enqueueReview?: boolean;
  }) {
    return processCanonicalClusters(this.db, {
      groupId: options?.groupId || this.groupId,
      minConfidence: options?.minConfidence,
      limit: options?.limit,
      autoApplyThreshold: options?.autoApplyThreshold,
      ambiguousThreshold: options?.ambiguousThreshold,
      enqueueReview: options?.enqueueReview,
    });
  }

  /**
   * Closed-loop skill evolution: draft skills from improvement proposals,
   * validate resolver behavior, and optionally promote them to disk.
   */
  async promoteSkills(options?: {
    skillsDir?: string;
    minConfidence?: number;
    autoPromote?: boolean;
  }) {
    const proposals = await this.getImprovementProposals();
    return promoteSkillsFromProposals(this.db, proposals, {
      groupId: this.groupId,
      skillsDir: options?.skillsDir,
      minConfidence: options?.minConfidence,
      autoPromote: options?.autoPromote,
    });
  }

  /**
   * Run DB-backed evals through the real ingest/search path.
   */
  async runEvals(fixtures: EvalFixture[], options?: { groupPrefix?: string }) {
    return runDbBackedEvalSuite(this, fixtures, options);
  }

  /**
   * Explain whether an access context can see a visibility policy.
   */
  simulatePermission(visibility: unknown, access?: AccessContext) {
    return simulatePermission(normalizeVisibility(visibility as any), access);
  }

  /**
   * Load persistent sync state for a connector.
   * Used by ConnectorRegistry for incremental sync across restarts.
   */
  async getSyncState(connectorId: string): Promise<{
    cursor?: string;
    lastSyncAt?: Date;
    metadata?: Record<string, unknown>;
  } | null> {
    const rows = await this.db`
      SELECT cursor, last_sync_at, metadata
      FROM connector_sync_state
      WHERE connector_id = ${connectorId} AND group_id = ${this.groupId}
    `.catch(() => []);
    if (rows.length === 0) return null;
    return {
      cursor: rows[0].cursor ?? undefined,
      lastSyncAt: rows[0].last_sync_at ?? undefined,
      metadata: rows[0].metadata ?? {},
    };
  }

  /**
   * Save persistent sync state for a connector.
   * Upserts so repeated calls just update the existing row.
   */
  async setSyncState(connectorId: string, state: {
    cursor?: string;
    lastSyncAt?: Date;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db`
      INSERT INTO connector_sync_state (connector_id, group_id, cursor, last_sync_at, metadata, updated_at)
      VALUES (
        ${connectorId},
        ${this.groupId},
        ${state.cursor ?? null},
        ${state.lastSyncAt ?? new Date()},
        ${JSON.stringify(state.metadata || {})},
        now()
      )
      ON CONFLICT (connector_id, group_id) DO UPDATE SET
        cursor = EXCLUDED.cursor,
        last_sync_at = EXCLUDED.last_sync_at,
        metadata = EXCLUDED.metadata,
        updated_at = now()
    `.catch(() => {});
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
      visibility: normalizeVisibility(row.visibility),
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
      evidence: row.evidence || {},
      extractor: row.extractor || 'unknown',
      visibility: normalizeVisibility(row.visibility),
      validAt: row.valid_at,
      invalidAt: row.invalid_at,
      confidence: Number(row.confidence),
      sourceEpisodeId: row.source_episode_id,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    };
  }

  private async auditLog(
    groupId: string,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: Record<string, unknown> = {},
    actor?: string,
  ): Promise<void> {
    await this.db`
      INSERT INTO audit_log (group_id, actor, action, resource_type, resource_id, metadata)
      VALUES (${groupId}, ${actor || null}, ${action}, ${resourceType}, ${resourceId}, ${this.db.json(metadata as any)})
    `.catch(() => {});
  }
}
