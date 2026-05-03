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
  id          TEXT NOT NULL,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  description TEXT DEFAULT '',
  schema      JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(group_id, id)
);

DO $$
BEGIN
  IF to_regclass('public.entities') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entities_entity_type_fkey') THEN
      ALTER TABLE entities DROP CONSTRAINT entities_entity_type_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entities_group_entity_type_fkey') THEN
      ALTER TABLE entities DROP CONSTRAINT entities_group_entity_type_fkey;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_types_pkey') THEN
    ALTER TABLE entity_types DROP CONSTRAINT entity_types_pkey;
  END IF;

  ALTER TABLE entity_types ADD CONSTRAINT entity_types_pkey PRIMARY KEY(group_id, id);
END $$;

-- Default entity types
INSERT INTO entity_types (id, group_id, label) VALUES
  ('person', 'default', 'Person'),
  ('company', 'default', 'Company'),
  ('project', 'default', 'Project'),
  ('decision', 'default', 'Decision'),
  ('concept', 'default', 'Concept'),
  ('document', 'default', 'Document'),
  ('event', 'default', 'Event')
ON CONFLICT (group_id, id) DO NOTHING;

-- ============================================================
-- relation_types: developer-definable edge ontology
-- ============================================================
CREATE TABLE IF NOT EXISTS relation_types (
  id              TEXT NOT NULL,
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  source_types    TEXT[] DEFAULT '{}',
  target_types    TEXT[] DEFAULT '{}',
  description     TEXT DEFAULT '',
  cardinality     TEXT NOT NULL DEFAULT 'many'
                    CHECK (cardinality IN ('many', 'one_per_source', 'one_per_target', 'one_between_pair')),
  invalidation_policy TEXT NOT NULL DEFAULT 'llm'
                    CHECK (invalidation_policy IN ('never', 'always', 'llm')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(group_id, id)
);

ALTER TABLE relation_types ADD COLUMN IF NOT EXISTS cardinality TEXT NOT NULL DEFAULT 'many';
ALTER TABLE relation_types ADD COLUMN IF NOT EXISTS invalidation_policy TEXT NOT NULL DEFAULT 'llm';

DO $$
BEGIN
  IF to_regclass('public.facts') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facts_relation_fkey') THEN
      ALTER TABLE facts DROP CONSTRAINT facts_relation_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facts_group_relation_fkey') THEN
      ALTER TABLE facts DROP CONSTRAINT facts_group_relation_fkey;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'relation_types_pkey') THEN
    ALTER TABLE relation_types DROP CONSTRAINT relation_types_pkey;
  END IF;

  ALTER TABLE relation_types ADD CONSTRAINT relation_types_pkey PRIMARY KEY(group_id, id);
END $$;

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
ON CONFLICT (group_id, id) DO NOTHING;

UPDATE relation_types SET cardinality = 'one_per_source', invalidation_policy = 'always'
  WHERE group_id = 'default' AND id = 'works_at';
UPDATE relation_types SET cardinality = 'one_between_pair', invalidation_policy = 'llm'
  WHERE group_id = 'default' AND id IN ('owns', 'blocked_by');
UPDATE relation_types SET cardinality = 'many', invalidation_policy = 'never'
  WHERE group_id = 'default' AND id IN ('mentions', 'related_to', 'attended', 'contributes_to', 'advises', 'invested_in', 'founded', 'decided');

-- ============================================================
-- entities: nodes in the knowledge graph
-- ============================================================
CREATE TABLE IF NOT EXISTS entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL,
  name            TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  attributes      JSONB NOT NULL DEFAULT '{}',
  visibility      JSONB NOT NULL DEFAULT '{}',
  name_embedding  vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE entities ADD COLUMN IF NOT EXISTS visibility JSONB NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_group_entity_type_fkey'
  ) THEN
    ALTER TABLE entities
      ADD CONSTRAINT entities_group_entity_type_fkey
      FOREIGN KEY (group_id, entity_type)
      REFERENCES entity_types(group_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_entities_group ON entities(group_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm ON entities USING GIN(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_name_embedding ON entities USING hnsw (name_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_entities_attributes ON entities USING GIN(attributes);
CREATE INDEX IF NOT EXISTS idx_entities_visibility ON entities USING GIN(visibility);

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
  relation            TEXT NOT NULL,
  fact_text           TEXT NOT NULL,
  fact_embedding      vector(1536),
  evidence            JSONB NOT NULL DEFAULT '{}',
  extractor           TEXT NOT NULL DEFAULT 'unknown',
  visibility          JSONB NOT NULL DEFAULT '{}',
  valid_at            TIMESTAMPTZ NOT NULL,
  invalid_at          TIMESTAMPTZ,
  confidence          FLOAT NOT NULL DEFAULT 1.0,
  source_episode_id   UUID,
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE facts ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}';
ALTER TABLE facts ADD COLUMN IF NOT EXISTS extractor TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE facts ADD COLUMN IF NOT EXISTS visibility JSONB NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'facts_group_relation_fkey'
  ) THEN
    ALTER TABLE facts
      ADD CONSTRAINT facts_group_relation_fkey
      FOREIGN KEY (group_id, relation)
      REFERENCES relation_types(group_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_facts_group ON facts(group_id);
CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_target ON facts(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_relation ON facts(relation);
CREATE INDEX IF NOT EXISTS idx_facts_valid_at ON facts(valid_at);
CREATE INDEX IF NOT EXISTS idx_facts_temporal ON facts(valid_at, invalid_at);
CREATE INDEX IF NOT EXISTS idx_facts_embedding ON facts USING hnsw (fact_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_facts_evidence ON facts USING GIN(evidence);
CREATE INDEX IF NOT EXISTS idx_facts_visibility ON facts USING GIN(visibility);
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
  visibility      JSONB NOT NULL DEFAULT '{}',
  valid_at        TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE episodes ADD COLUMN IF NOT EXISTS visibility JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_episodes_group ON episodes(group_id);
CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_episodes_valid_at ON episodes(valid_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_visibility ON episodes USING GIN(visibility);
-- Prevent duplicate episodes from the same source
CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_dedup
  ON episodes(group_id, source_type, source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_episodes_embedding ON episodes USING hnsw (content_embedding vector_cosine_ops);
-- Full-text search on episode content
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS content_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS idx_episodes_fts ON episodes USING GIN(content_tsv);

-- ============================================================
-- organizational_memory: first-class derived org memory
-- ============================================================
-- Episodes are primary. This table stores universal organizational
-- memory objects derived from interactions: decisions, rationale,
-- commitments, open questions, risks, and value-creating objects.
CREATE TABLE IF NOT EXISTS organizational_memory (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id            TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('interaction', 'decision', 'rationale', 'commitment', 'open_question', 'risk', 'value_object', 'product_signal', 'workflow_signal', 'policy', 'exception')),
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'observed'
                        CHECK (status IN ('observed', 'proposed', 'decided', 'rejected', 'parked', 'open', 'in_progress', 'done', 'blocked', 'unknown')),
  owner               TEXT,
  subject             TEXT,
  value_object        TEXT,
  due_at              TIMESTAMPTZ,
  valid_at            TIMESTAMPTZ NOT NULL,
  resolved_at         TIMESTAMPTZ,
  confidence          FLOAT NOT NULL DEFAULT 0.7,
  evidence            JSONB NOT NULL DEFAULT '{}',
  source_episode_id   UUID REFERENCES episodes(id) ON DELETE CASCADE,
  visibility          JSONB NOT NULL DEFAULT '{}',
  metadata            JSONB NOT NULL DEFAULT '{}',
  content_embedding   vector(1536),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE organizational_memory ADD COLUMN IF NOT EXISTS visibility JSONB NOT NULL DEFAULT '{}';
ALTER TABLE organizational_memory ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE organizational_memory ADD COLUMN IF NOT EXISTS content_embedding vector(1536);

ALTER TABLE organizational_memory DROP CONSTRAINT IF EXISTS organizational_memory_kind_check;
ALTER TABLE organizational_memory ADD CONSTRAINT organizational_memory_kind_check
  CHECK (kind IN ('interaction', 'decision', 'rationale', 'commitment', 'open_question', 'risk', 'value_object', 'product_signal', 'workflow_signal', 'policy', 'exception'));

CREATE INDEX IF NOT EXISTS idx_org_memory_group_kind ON organizational_memory(group_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_org_memory_source_episode ON organizational_memory(source_episode_id);
CREATE INDEX IF NOT EXISTS idx_org_memory_owner ON organizational_memory(owner);
CREATE INDEX IF NOT EXISTS idx_org_memory_subject ON organizational_memory(subject);
CREATE INDEX IF NOT EXISTS idx_org_memory_valid_at ON organizational_memory(valid_at DESC);
CREATE INDEX IF NOT EXISTS idx_org_memory_visibility ON organizational_memory USING GIN(visibility);
CREATE INDEX IF NOT EXISTS idx_org_memory_embedding ON organizational_memory USING hnsw (content_embedding vector_cosine_ops);
ALTER TABLE organizational_memory ADD COLUMN IF NOT EXISTS memory_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || summary || ' ' || COALESCE(owner, '') || ' ' || COALESCE(subject, '') || ' ' || COALESCE(value_object, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_org_memory_fts ON organizational_memory USING GIN(memory_tsv);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_memory_episode_dedupe
  ON organizational_memory(source_episode_id, kind, md5(summary))
  WHERE source_episode_id IS NOT NULL;

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
-- graph_review_queue: audited review of uncertain graph changes
-- ============================================================
-- Ambiguous canonicalization, skipped facts, and proposed schema/skill
-- changes land here instead of silently mutating the graph.
CREATE TABLE IF NOT EXISTS graph_review_queue (
  id          SERIAL PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  review_type TEXT NOT NULL CHECK (review_type IN ('entity_resolution', 'fact_resolution', 'schema', 'skill')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_queue_group ON graph_review_queue(group_id, status);
CREATE INDEX IF NOT EXISTS idx_review_queue_type ON graph_review_queue(review_type);

-- ============================================================
-- audit_log: access/security and graph mutation audit trail
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGSERIAL PRIMARY KEY,
  group_id       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor          TEXT,
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_group_created ON audit_log(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

-- ============================================================
-- canonical_clusters: proposed/approved entity and relation clusters
-- ============================================================
CREATE TABLE IF NOT EXISTS canonical_clusters (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  cluster_type   TEXT NOT NULL CHECK (cluster_type IN ('entity', 'relation')),
  canonical_id   TEXT,
  member_ids     TEXT[] NOT NULL DEFAULT '{}',
  confidence     FLOAT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'applied')),
  rationale      TEXT NOT NULL DEFAULT '',
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_clusters_group ON canonical_clusters(group_id, cluster_type, status);

-- ============================================================
-- skill_promotions: closed-loop skill draft/test/promote records
-- ============================================================
CREATE TABLE IF NOT EXISTS skill_promotions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  skill_id       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'promoted', 'rejected')),
  proposal       JSONB NOT NULL DEFAULT '{}',
  test_results   JSONB NOT NULL DEFAULT '{}',
  filepath       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skill_promotions_group ON skill_promotions(group_id, status);

-- ============================================================
-- connector_sync_state: persistent cursor/timestamp for connectors
-- ============================================================
-- Tracks the last sync time and cursor per connector instance.
-- Survives process restarts so incremental sync works across sessions.
CREATE TABLE IF NOT EXISTS connector_sync_state (
  connector_id  TEXT NOT NULL,
  group_id      TEXT NOT NULL DEFAULT 'default',
  cursor        TEXT,
  last_sync_at  TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, group_id)
);

-- Repair legacy rows where JSONB payloads were inserted as JSON strings.
UPDATE episodes
SET visibility = (visibility #>> '{}')::jsonb
WHERE jsonb_typeof(visibility) = 'string';

UPDATE facts
SET visibility = (visibility #>> '{}')::jsonb
WHERE jsonb_typeof(visibility) = 'string';

UPDATE entities
SET visibility = (visibility #>> '{}')::jsonb
WHERE jsonb_typeof(visibility) = 'string';

UPDATE organizational_memory
SET visibility = (visibility #>> '{}')::jsonb
WHERE jsonb_typeof(visibility) = 'string';

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
