-- Company Brain: Temporal Knowledge Graph Schema
-- Postgres 16 + pgvector + pg_trgm

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- groups: workspace/tenant isolation
-- ============================================================
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO groups (id, name) VALUES ('default', 'Default')
  ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- entity_types: developer-definable ontology
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_types (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  description TEXT DEFAULT '',
  schema      JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, id)
);

-- Default entity types
INSERT INTO entity_types (id, group_id, label) VALUES
  ('person', 'default', 'Person'),
  ('company', 'default', 'Company'),
  ('project', 'default', 'Project'),
  ('decision', 'default', 'Decision'),
  ('concept', 'default', 'Concept'),
  ('document', 'default', 'Document'),
  ('event', 'default', 'Event')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- relation_types: developer-definable edge ontology
-- ============================================================
CREATE TABLE IF NOT EXISTS relation_types (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  source_types    TEXT[] DEFAULT '{}',
  target_types    TEXT[] DEFAULT '{}',
  description     TEXT DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, id)
);

-- Default relation types
INSERT INTO relation_types (id, group_id, label, source_types, target_types) VALUES
  ('works_at',     'default', 'Works At',     '{person}', '{company}'),
  ('founded',      'default', 'Founded',      '{person}', '{company}'),
  ('advises',      'default', 'Advises',      '{person}', '{company}'),
  ('invested_in',  'default', 'Invested In',  '{person,company}', '{company}'),
  ('owns',         'default', 'Owns',         '{person}', '{project}'),
  ('contributes_to','default','Contributes To','{person}', '{project}'),
  ('decided',      'default', 'Decided',      '{person}', '{decision}'),
  ('blocked_by',   'default', 'Blocked By',   '{project,decision}', '{decision}'),
  ('attended',     'default', 'Attended',     '{person}', '{event}'),
  ('mentions',     'default', 'Mentions',     '{}', '{}'),
  ('related_to',   'default', 'Related To',   '{}', '{}')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- entities: nodes in the knowledge graph
-- ============================================================
CREATE TABLE IF NOT EXISTS entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL REFERENCES entity_types(id),
  name            TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  attributes      JSONB NOT NULL DEFAULT '{}',
  name_embedding  vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entities_group ON entities(group_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm ON entities USING GIN(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_name_embedding ON entities USING hnsw (name_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_entities_attributes ON entities USING GIN(attributes);

-- ============================================================
-- facts: temporal edges (relationships with validity windows)
-- ============================================================
-- A fact is a typed relationship between two entities with a time window.
-- When new information contradicts an existing fact, the old fact gets
-- invalid_at set (not deleted). This preserves full history.
CREATE TABLE IF NOT EXISTS facts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id            TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  source_entity_id    UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id    UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation            TEXT NOT NULL REFERENCES relation_types(id),
  fact_text           TEXT NOT NULL,
  fact_embedding      vector(1536),
  valid_at            TIMESTAMPTZ NOT NULL,
  invalid_at          TIMESTAMPTZ,
  confidence          FLOAT NOT NULL DEFAULT 1.0,
  source_episode_id   UUID,
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_facts_group ON facts(group_id);
CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_target ON facts(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_relation ON facts(relation);
CREATE INDEX IF NOT EXISTS idx_facts_valid_at ON facts(valid_at);
CREATE INDEX IF NOT EXISTS idx_facts_temporal ON facts(valid_at, invalid_at);
CREATE INDEX IF NOT EXISTS idx_facts_embedding ON facts USING hnsw (fact_embedding vector_cosine_ops);
-- Full-text search on fact_text
ALTER TABLE facts ADD COLUMN IF NOT EXISTS fact_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', fact_text)) STORED;
CREATE INDEX IF NOT EXISTS idx_facts_fts ON facts USING GIN(fact_tsv);

-- ============================================================
-- episodes: raw ingested data (ground truth, provenance)
-- ============================================================
-- Every piece of data that enters the system is stored as an episode.
-- Facts trace back to episodes for full provenance.
CREATE TABLE IF NOT EXISTS episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL,
  source_id       TEXT,
  content         TEXT NOT NULL,
  content_embedding vector(1536),
  metadata        JSONB NOT NULL DEFAULT '{}',
  valid_at        TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episodes_group ON episodes(group_id);
CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_episodes_valid_at ON episodes(valid_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_embedding ON episodes USING hnsw (content_embedding vector_cosine_ops);
-- Full-text search on episode content
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS content_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS idx_episodes_fts ON episodes USING GIN(content_tsv);

-- ============================================================
-- extraction_log: fail-improve loop tracking
-- ============================================================
-- Every extraction attempt is logged. When deterministic extraction
-- fails and LLM succeeds, we log the input/output so we can later
-- generate better deterministic rules.
CREATE TABLE IF NOT EXISTS extraction_log (
  id                  SERIAL PRIMARY KEY,
  group_id            TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  episode_id          UUID REFERENCES episodes(id) ON DELETE SET NULL,
  method              TEXT NOT NULL CHECK (method IN ('deterministic', 'llm', 'hybrid')),
  input_preview       TEXT NOT NULL,
  entities_extracted  JSONB DEFAULT '[]',
  facts_extracted     JSONB DEFAULT '[]',
  confidence          FLOAT,
  duration_ms         INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extraction_log_method ON extraction_log(method);
CREATE INDEX IF NOT EXISTS idx_extraction_log_group ON extraction_log(group_id);

-- ============================================================
-- entity_mentions: fast lookup for deduplication
-- ============================================================
-- Maps surface forms ("Bob", "Robert Smith", "bob@acme.com") to entities.
-- Used by deterministic extraction to resolve known entities without LLM.
CREATE TABLE IF NOT EXISTS entity_aliases (
  id          SERIAL PRIMARY KEY,
  entity_id   UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  alias_type  TEXT NOT NULL DEFAULT 'name',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(entity_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_aliases_alias_trgm ON entity_aliases USING GIN(alias gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);

-- ============================================================
-- Views for common queries
-- ============================================================

-- Current facts (not invalidated)
CREATE OR REPLACE VIEW current_facts AS
  SELECT * FROM facts WHERE invalid_at IS NULL;

-- Entity with fact counts
CREATE OR REPLACE VIEW entity_summary AS
  SELECT
    e.*,
    COUNT(DISTINCT f.id) FILTER (WHERE f.invalid_at IS NULL) AS active_fact_count,
    COUNT(DISTINCT f.id) AS total_fact_count,
    MAX(f.valid_at) AS last_fact_at
  FROM entities e
  LEFT JOIN facts f ON (f.source_entity_id = e.id OR f.target_entity_id = e.id)
  GROUP BY e.id;
