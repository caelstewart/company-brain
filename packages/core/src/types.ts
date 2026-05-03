/**
 * Core types for the Company Brain engine.
 */

// ─── Entity Types ─────────────────────────────────────────────

export interface Entity {
  id: string;
  groupId: string;
  entityType: string;
  name: string;
  summary: string;
  attributes: Record<string, unknown>;
  visibility: VisibilityPolicy;
  nameEmbedding?: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EntityInput {
  name: string;
  entityType: string;
  groupId?: string;
  summary?: string;
  attributes?: Record<string, unknown>;
}

// ─── Fact Types (Temporal Edges) ──────────────────────────────

export interface Fact {
  id: string;
  groupId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relation: string;
  factText: string;
  factEmbedding?: number[];
  evidence: FactEvidence;
  extractor: string;
  visibility: VisibilityPolicy;
  validAt: Date;
  invalidAt: Date | null;
  confidence: number;
  sourceEpisodeId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface FactInput {
  sourceEntityId: string;
  targetEntityId: string;
  relation: string;
  factText: string;
  validAt: Date;
  confidence?: number;
  sourceEpisodeId?: string;
  metadata?: Record<string, unknown>;
  groupId?: string;
}

export interface FactEvidence {
  quote?: string;
  startOffset?: number;
  endOffset?: number;
  sourceEpisodeId?: string | null;
  extractor?: string;
  confidenceReason?: string;
}

// ─── Episode Types (Raw Data Provenance) ──────────────────────

export interface Episode {
  id: string;
  groupId: string;
  sourceType: string;
  sourceId: string | null;
  content: string;
  contentEmbedding?: number[];
  metadata: Record<string, unknown>;
  visibility: VisibilityPolicy;
  validAt: Date;
  createdAt: Date;
}

export interface EpisodeInput {
  content: string;
  sourceType: string;
  sourceId?: string;
  validAt?: Date;
  metadata?: Record<string, unknown>;
  visibility?: VisibilityPolicy;
  groupId?: string;
}

export interface AccessContext {
  principalId?: string;
  principalIds?: string[];
  groups?: string[];
  roles?: string[];
  sourceAccounts?: Record<string, string>;
  /** Internal/admin reads can explicitly bypass row-level visibility filters. */
  bypass?: boolean;
}

export interface VisibilityPolicy {
  allowedPrincipals?: string[];
  deniedPrincipals?: string[];
  allowedGroups?: string[];
  deniedGroups?: string[];
  classification?: string;
  inheritedFrom?: string;
  sourceSystem?: string;
  sourceAcl?: SourceAclEntry[];
}

export interface SourceAclEntry {
  provider: string;
  id: string;
  type: 'user' | 'group' | 'channel' | 'workspace' | 'role' | 'account' | 'unknown';
  access: 'allow' | 'deny';
  name?: string;
}

export interface PermissionSimulation {
  allowed: boolean;
  reason: string;
  matchedAllow?: string[];
  matchedDeny?: string[];
  visibility: VisibilityPolicy;
}

export interface NormalizedEpisode {
  content: string;
  sourceType: string;
  metadata: Record<string, unknown>;
  visibility: VisibilityPolicy;
}

export type InteractionRetention = 'drop' | 'ephemeral' | 'durable';

export interface InteractionTriageDecision {
  retention: InteractionRetention;
  durableMemoryScore: number;
  shouldStoreEpisode: boolean;
  shouldExtract: boolean;
  shouldStoreMemory: boolean;
  ttlDays?: number;
  signals: string[];
  reasons: string[];
}

// ─── Organizational Memory Types ───────────────────────────────

export type OrganizationalMemoryKind =
  | 'interaction'
  | 'decision'
  | 'rationale'
  | 'commitment'
  | 'open_question'
  | 'risk'
  | 'value_object'
  | 'product_signal'
  | 'workflow_signal'
  | 'policy'
  | 'exception';

export type OrganizationalMemoryStatus =
  | 'observed'
  | 'proposed'
  | 'decided'
  | 'rejected'
  | 'parked'
  | 'open'
  | 'in_progress'
  | 'done'
  | 'blocked'
  | 'unknown';

export interface OrganizationalMemoryObject {
  id: string;
  groupId: string;
  kind: OrganizationalMemoryKind;
  title: string;
  summary: string;
  status: OrganizationalMemoryStatus;
  owner?: string | null;
  subject?: string | null;
  valueObject?: string | null;
  dueAt?: Date | null;
  validAt: Date;
  resolvedAt?: Date | null;
  confidence: number;
  evidence: FactEvidence;
  sourceEpisodeId?: string | null;
  visibility: VisibilityPolicy;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationalMemoryInput {
  kind: OrganizationalMemoryKind;
  title: string;
  summary: string;
  status?: OrganizationalMemoryStatus;
  owner?: string | null;
  subject?: string | null;
  valueObject?: string | null;
  dueAt?: Date | null;
  validAt?: Date;
  resolvedAt?: Date | null;
  confidence?: number;
  evidence?: FactEvidence;
  sourceEpisodeId?: string | null;
  visibility?: VisibilityPolicy;
  metadata?: Record<string, unknown>;
}

// ─── Extraction Types ─────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  entityType: string;
  attributes?: Record<string, unknown>;
  confidence: number;
}

export interface ExtractedFact {
  sourceName: string;
  targetName: string;
  relation: string;
  factText: string;
  validAt?: Date;
  confidence: number;
  evidence?: FactEvidence;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  method: 'deterministic' | 'llm' | 'hybrid';
  durationMs: number;
}

export interface ReviewItem {
  id: number;
  groupId: string;
  reviewType: 'entity_resolution' | 'fact_resolution' | 'schema' | 'skill';
  status: 'pending' | 'approved' | 'rejected';
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ImprovementProposal {
  id: string;
  kind: 'schema' | 'skill' | 'extraction' | 'canonicalization';
  title: string;
  rationale: string;
  confidence: number;
  evidence: Record<string, unknown>;
  proposedAction: Record<string, unknown>;
}

// ─── Search Types ─────────────────────────────────────────────

export interface SearchOptions {
  query: string;
  groupId?: string;
  access?: AccessContext;
  limit?: number;
  offset?: number;
  asOf?: Date;
  entityTypes?: string[];
  relations?: string[];
  methods?: SearchMethod[];
  minConfidence?: number;
}

export type SearchMethod = 'semantic' | 'keyword' | 'graph' | 'temporal' | 'pagerank' | 'community' | 'decompose';

export interface SearchResult {
  type: 'entity' | 'fact' | 'episode' | 'memory';
  id: string;
  score: number;
  content: string;
  metadata: Record<string, unknown>;
  // Populated for facts
  sourceEntity?: Entity;
  targetEntity?: Entity;
  relation?: string;
  validAt?: Date;
  invalidAt?: Date | null;
}

// ─── Schema Definition Types ──────────────────────────────────

export interface SchemaDefinition {
  entityTypes?: EntityTypeDefinition[];
  relationTypes?: RelationTypeDefinition[];
  extractionHints?: ExtractionHints;
}

export interface EntityTypeDefinition {
  id: string;
  label: string;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface RelationTypeDefinition {
  id: string;
  label: string;
  sourceTypes?: string[];
  targetTypes?: string[];
  description?: string;
  /**
   * Cardinality controls which existing facts are candidates for supersession.
   * - many: facts generally coexist unless exact/semantic duplicates.
   * - one_per_source: one current target per source for this relation.
   * - one_per_target: one current source per target for this relation.
   * - one_between_pair: one current fact for the source/target pair.
   */
  cardinality?: RelationCardinality;
  /**
   * Invalidation policy decides how candidate superseded facts are handled.
   * - never: candidates are only used for duplicate detection.
   * - always: candidates are invalidated without an LLM call.
   * - llm: candidates are sent to the conflict resolver when available.
   */
  invalidationPolicy?: RelationInvalidationPolicy;
}

export type RelationCardinality = 'many' | 'one_per_source' | 'one_per_target' | 'one_between_pair';
export type RelationInvalidationPolicy = 'never' | 'always' | 'llm';

export interface ExtractionHints {
  [entityType: string]: {
    keywords?: string[];
    examples?: string[];
  };
}

// ─── Configuration ────────────────────────────────────────────

export interface BrainConfig {
  database: string | DatabaseConfig;
  embedding?: EmbeddingConfig;
  llm?: LLMConfig;
  defaultGroupId?: string;
  extraction?: ExtractionConfig;
  triage?: TriageConfig;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

export interface EmbeddingConfig {
  provider: 'openai';
  model?: string;
  apiKey?: string;
}

export interface LLMConfig {
  provider: 'anthropic' | 'openai';
  model?: string;
  apiKey?: string;
  /** Context window size for input budgeting/chunking. Defaults to the provider/model family default. */
  contextWindowTokens?: number;
  /** Optional output cap for providers that require one, such as Anthropic Messages. */
  maxOutputTokens?: number;
}

export interface ExtractionConfig {
  /** Whether to log all extractions for observability */
  enableExtractionLog?: boolean;
}

export interface TriageConfig {
  /** Enable pre-extraction interaction triage. Defaults to true. */
  enabled?: boolean;
  /** Prefer LLM triage when an LLM config exists. Defaults to true. */
  llmEnabled?: boolean;
  /** Maximum characters to send in one triage call before chunking. */
  maxSinglePassChars?: number;
  /** Maximum characters per chunk for very large interactions. */
  maxChunkChars?: number;
  /** Overlap characters between large interaction chunks. */
  chunkOverlapChars?: number;
  /** Store dropped source episodes for audit instead of discarding them. Defaults to false. */
  archiveDropped?: boolean;
  /** Store ephemeral source episodes but skip graph/memory extraction. Defaults to true. */
  storeEphemeral?: boolean;
  /** TTL marker for ephemeral episodes. Defaults to 14 days. */
  ephemeralTtlDays?: number;
}
