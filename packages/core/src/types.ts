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

// ─── Episode Types (Raw Data Provenance) ──────────────────────

export interface Episode {
  id: string;
  groupId: string;
  sourceType: string;
  sourceId: string | null;
  content: string;
  contentEmbedding?: number[];
  metadata: Record<string, unknown>;
  validAt: Date;
  createdAt: Date;
}

export interface EpisodeInput {
  content: string;
  sourceType: string;
  sourceId?: string;
  validAt?: Date;
  metadata?: Record<string, unknown>;
  groupId?: string;
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
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  method: 'deterministic' | 'llm' | 'hybrid';
  durationMs: number;
}

// ─── Search Types ─────────────────────────────────────────────

export interface SearchOptions {
  query: string;
  groupId?: string;
  limit?: number;
  offset?: number;
  asOf?: Date;
  entityTypes?: string[];
  relations?: string[];
  methods?: SearchMethod[];
  minConfidence?: number;
}

export type SearchMethod = 'semantic' | 'keyword' | 'graph' | 'temporal';

export interface SearchResult {
  type: 'entity' | 'fact' | 'episode';
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
}

export interface ExtractionHints {
  [entityType: string]: {
    patterns?: RegExp[];
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
}

export interface ExtractionConfig {
  /** Confidence threshold below which LLM fallback is triggered */
  llmFallbackThreshold?: number;
  /** Whether to log all extractions for the fail-improve loop */
  enableExtractionLog?: boolean;
  /** Custom deterministic patterns per entity type */
  patterns?: Record<string, RegExp[]>;
}
