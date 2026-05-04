# Company Brain

**Open-source temporal knowledge graph engine for AI agents and knowledge workers.**

Company Brain turns messy company interactions and documents into a searchable, temporal knowledge graph and organizational memory layer. Feed it meeting transcripts, Slack messages, Notion pages, CRM notes, design files, Linear tickets, emails, call recordings, or anything else your team produces. It extracts entities, relationships, decisions, commitments, risks, policies, and workflow knowledge, keeps provenance and permissions attached, and answers questions with grounded citations.

Built by [Merge Labs](https://www.mergelabs.co/), an AI agency building practical AI infrastructure for growing companies.

Built by studying what works and what doesn't in systems like [gbrain](https://github.com/garrytan/gbrain) (skill-based agents), [Graphiti/Zep](https://github.com/getzep/graphiti) (temporal fact model, contradiction detection), GraphRAG-style retrieval systems, and modern memory products. Company Brain combines those ideas into a single Postgres-native engine.

## Status

Company Brain is ready to share publicly as an advanced open-source alpha / research prototype. It has real ingestion, triage, extraction, retrieval, permissions, grounded answer synthesis, evals, and pressure suites. It is not yet "enterprise production ready" in the sense of hardened auth, hosted deployment, migrations, SOC2 controls, observability dashboards, disaster recovery, and long-running customer-scale soak tests.

## The Problem

AI solved coding first because all the context already lives in one place: the git repo. Knowledge work is the opposite. Context is scattered across dozens of tools, stored in dozens of formats, and there is no unit test to tell you if your output is correct.

Building an enterprise brain means solving four problems at once.

### 1. Distributed

Your data lives in Slack, Notion, HubSpot, Figma, Linear, Granola, Google Docs, email, and whatever else your team adopted last quarter. None of these systems talk to each other.

Company Brain normalizes any source into timestamped episodes. Built-in connectors handle the filesystem, Nango-backed integrations, configurable REST APIs, and generic webhooks. Nango gives access to 700+ APIs without maintaining provider-specific connector code in this repo. For anything else, drop a JSON config file in `~/.company-brain/connectors/` to define a new REST API connector with no code. Incremental sync is native.

### 2. Unstructured

Raw transcripts, documents, and messages need to become structured knowledge: who, what, when, and how things relate. The brain has to self-organize into a schema that works for your specific business.

LLM-first extraction reads raw text and outputs typed entities, relationships, temporal metadata, and confidence scores. The schema is configurable per workspace with custom entity types and relation types. Entity resolution combines alias matching, trigram similarity, embeddings, and graph-level canonicalization proposals.

### 3. Unverifiable

Code either passes the test or it doesn't. Knowledge work is subjective. There is no unit test for "is this a good insight?"

Every fact and memory object has confidence, evidence, extractor metadata, source episode provenance, visibility policy, and temporal history so you can see what changed and when. Extraction logging, improvement proposals, answer traces, active canonicalization policy, DB-backed eval fixtures, pressure suites, and permission simulation provide a testable feedback loop. The eval corpus is designed to keep expanding with larger customer-specific gold datasets and long-running production telemetry.

### 4. Compaction

As the corpus grows, so does noise. Without cleanup, you end up searching for needles in a haystack of stale, redundant, or low-value facts.

LLM triage drops low-value noise, keeps ephemeral interactions with TTLs, and promotes durable operating knowledge. Temporal invalidation replaces stale facts (VP becomes CRO, old fact gets marked superseded). Queries return only current facts by default. Entity resolution prevents duplicate nodes, graph-level canonical clustering proposes entity/relation merges for review, and recency boost favors recent information.

## Quick Start

For a copy-pasteable local demo path, see [`QUICKSTART.md`](QUICKSTART.md).

```bash
# 1. Start local Postgres with pgvector and apply the schema
createdb company_brain 2>/dev/null || true
export DATABASE_URL=postgresql://localhost:5432/company_brain
psql "$DATABASE_URL" -f packages/core/src/schema.sql

# 2. Install dependencies
npm install

# 3. Build the packages
npm run build

# 4. Set environment variables
export OPENAI_API_KEY=sk-...          # embeddings + default LLM
export ANTHROPIC_API_KEY=sk-ant-...   # optional long-context/explicit Anthropic fallback

# 5. Run the operating-memory smoke suite
node tests/operating-memory-suite.mjs

# 6. Or start the REST API
npx company-brain --rest
```

Prefer Docker for Postgres? Use `docker compose up -d postgres` and set `DATABASE_URL=postgresql://brain:brain@localhost:5432/company_brain` instead.

## Usage

### TypeScript SDK

```typescript
import { Brain } from '@company-brain/core';

const brain = new Brain({
  database: 'postgresql://brain:brain@localhost:5432/company_brain',
  embedding: { provider: 'openai' },
  llm: { provider: 'openai' },
});

await brain.init();

// Ingest content: entities and facts are extracted automatically
await brain.ingest({
  content: `Meeting with Alice Chen from Acme Corp.
    They're upgrading from starter to enterprise plan.
    Alice mentioned their CTO Bob Zhang is evaluating competitors.
    Decision: offer 20% discount if they commit by end of month.`,
  sourceType: 'meeting_transcript',
});

// Search the knowledge graph
const results = await brain.search({
  query: "What's happening with Acme?",
});

// Point-in-time queries: what did we know on March 1st?
const marchState = await brain.search({
  query: 'Acme plan',
  asOf: new Date('2024-03-01'),
});

// Find entities by name (fuzzy matching via trigram similarity)
const alice = await brain.findEntity('Alice');

// Get entity with all connections
const full = await brain.getEntity(alice.id, {
  includeFacts: true,      // current facts
  includeRelated: true,    // connected entities (1-hop)
  includeTimeline: true,   // full history including invalidated facts
});
```

### MCP Server (Claude Code / Cursor)

```json
{
  "mcpServers": {
    "company-brain": {
      "command": "npx",
      "args": ["company-brain", "--mcp"],
      "env": {
        "DATABASE_URL": "postgresql://brain:brain@localhost:5432/company_brain",
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Exposes tools across six categories:

**Data:**
- `ingest` — ingest text content, extract entities and facts
- `search` — hybrid search (semantic + keyword + graph + temporal + community)
- `answer` — retrieve evidence and return a grounded answer with citations
- `search_memory` — search organizational memory objects such as decisions, commitments, risks, and open questions
- `list_memory` — list recent organizational memory objects with kind/status filters
- `get_entity` — get an entity by ID with facts, related entities, timeline
- `find_entity` — fuzzy-match an entity by name
- `get_facts` — get facts between entities, supports temporal queries
- `extraction_stats` — fail-improve loop statistics
- `improvement_proposals` — audited proposals for schema, extraction, canonicalization, and skill evolution
- `propose_canonical_clusters` — graph-level entity/relation cluster proposals
- `run_evals` — DB-backed baseline or pressure evals through live ingest, retrieval, and answer scoring

**Connectors:**
- `list_connectors` — show available connector types and configured instances
- `connect` — configure and authenticate a data source (filesystem, nango, or a custom REST connector)
- `sync_connector` — pull data from a connected source (incremental by default)
- `sync_all_connectors` — sync every configured connector at once
- `save_connector` — create a custom REST API connector from a JSON definition (no code)

**Skills:**
- `list_skills` — show all skills and the routing table
- `get_skill` — read a skill's full SOP content
- `save_skill` — create or update a skill (persists to `~/.company-brain/skills/`)
- `promote_skills` — draft, validate, and optionally promote skills from improvement proposals

**Security:**
- `simulate_permission` — explain whether an access context can see a visibility policy

**Meta:**
- `version` — server version

### REST API

```bash
# Start
DATABASE_URL=postgresql://brain:brain@localhost:5432/company_brain \
BRAIN_AUTH_TOKEN=my-secret-token \
npx company-brain --rest --port 3333

# Ingest
curl -X POST http://localhost:3333/api/ingest \
  -H "Authorization: Bearer my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"content": "Alice from Acme upgraded to enterprise", "sourceType": "crm_note"}'

# Search
curl -X POST http://localhost:3333/api/search \
  -H "Authorization: Bearer my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"query": "Acme deal"}'
```

Full endpoint list: `POST /api/ingest`, `POST /api/search`, `POST /api/answer`, `POST /api/memory/search`, `POST /api/memory/list`, `GET /api/entities/:id`, `GET /api/entities/find/:name`, `GET /api/facts/:sourceId`, `GET /api/graph`, `POST /api/schema`, `GET /api/stats`, `GET /api/stats/patterns`, `GET /api/improvement-proposals`, `POST /api/canonical-clusters`, `POST /api/skills/promote`, `POST /api/evals/run`, `POST /api/permissions/simulate`, `POST /api/connectors`, `POST /api/connectors/:id/sync`, `GET /api/connectors`, `GET /api/webhook-sources`, `POST /api/webhook-sources`, `POST /api/webhooks/receive/:source`, `POST /api/webhooks/ingest`, `POST /api/webhooks/:type`, `GET /api/skills`, `GET /api/skills/:id`, `POST /api/skills`, `GET /api/health`.

### Graph Visualization

Generate `graph.html` when you want a local interactive force-directed graph of all entities and relationships. The generated file is a local artifact and is not committed.

```bash
# Build, then generate and open graph.html
npm run build
npx tsx tools/visualize.ts --group default
```

For API-backed graph data, start the REST API and call `GET /api/graph`, which returns all visible entities and active facts as `{nodes, links}`.

---

## Architecture

```
                           ┌──────────────────────┐
                           │     Data Sources      │
                           │                       │
                           │  Slack  Notion  Files  │
                           │  Figma  CRM   Linear  │
                           │  REST   MCP    SDK    │
                           └──────────┬───────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                     Ingestion Pipeline                       │
│                                                             │
│  Raw Text ──▶ LLM Triage (drop / ephemeral / durable)        │
│      │                                                      │
│      ├──▶ Episode (immutable provenance, if retained)       │
│      │                                                      │
│      ├──▶ Structural Pre-scan                               │
│      │    (emails, @mentions, URLs, known entity matching)  │
│      │                                                      │
│      ├──▶ LLM Extraction (primary)                          │
│      │    (entities, relationships, temporal, decisions)     │
│      │    receives existing graph context ◀── Graph DB      │
│      │                                                      │
│      ├──▶ Merge (LLM + structured data)                     │
│      │                                                      │
│      ├──▶ Resolution                                        │
│      │    (entity dedup, fact contradiction, summary update) │
│      │                                                      │
│      └──▶ Logging (observability)                           │
├─────────────────────────────────────────────────────────────┤
│                    Knowledge Graph                          │
│                                                             │
│  ┌──────────┐   fact (temporal edge)   ┌──────────┐        │
│  │  Entity   │────────────────────────▶│  Entity   │        │
│  │          │   valid_at: 2024-03-15  │          │        │
│  │  Alice   │   invalid_at: null      │  Acme    │        │
│  │  (person)│   "Alice is CRO at Acme"│(company) │        │
│  └──────────┘   confidence: 0.95      └──────────┘        │
│                  source_episode: uuid                       │
│                                                             │
│  Tables: entities, facts, episodes, entity_aliases          │
│  Indexes: trigram, HNSW vector, tsvector, temporal          │
├─────────────────────────────────────────────────────────────┤
│                Three-Tier Search Engine                     │
│                                                             │
│  Query Router ──▶ classify intent ──▶ select tier           │
│                                                             │
│  Tier 1 (<100ms): Keyword + Graph entity lookup             │
│  Tier 2 (<500ms): Semantic + Keyword + Graph Traversal      │
│                   + Personalized PageRank + Communities      │
│  Tier 3 (1-5s):  Query Decomposition ──▶ Sub-query engine   │
│                                                             │
│     ──▶ Reciprocal Rank Fusion (k=60) ──▶ Recency Boost    │
│             └──▶ Source Context Expansion                   │
│                  (facts/memory pull parent episodes)        │
├─────────────────────────────────────────────────────────────┤
│                    Skill Resolver                           │
│                                                             │
│  User intent ──▶ trigger matching ──▶ Skill SOP (markdown)  │
│  "what do we know about Acme" ──▶ query skill               │
│  "meeting notes from today"   ──▶ ingest-meeting skill      │
│  (always-on: signal-detector, brain-ops)                    │
├─────────────────────────────────────────────────────────────┤
│                      Interfaces                             │
│                                                             │
│  MCP Server (stdio)  │  REST API (HTTP)  │  TypeScript SDK  │
│  Claude Code, Cursor  │  Web apps, bots   │  Direct import   │
└─────────────────────────────────────────────────────────────┘
```

---

## The Data Model

### Why Entities + Facts + Episodes

Most knowledge systems store either documents (RAG) or triples (traditional KG). Both have problems.

**Documents** lose structure. "Alice is CTO of Acme" is buried in paragraph 3 of a meeting transcript. Searching for "who works at Acme" requires the LLM to parse every document every time.

**Triples** (`Alice -> works_at -> Acme`) lose context. When did this become true? What is the evidence? What if she changed jobs?

Company Brain uses three primitives that solve both.

**Episodes** are raw data: the meeting transcript, the Slack message, the document. They are immutable and timestamped. This is your audit trail. Every fact traces back to an episode. Episodes also carry source-specific metadata and visibility policies inherited from Slack channels, CRM owners, analytics workspaces, call participants, or explicit ACLs. Normalization preserves the raw source text even when structured turns, replies, action items, or provider fields are available, so retrieval can recover adjacent context that extraction may not compress into a single fact.

**Entities** are the nodes: people, companies, projects, decisions, concepts. Each entity has a name, type, summary (auto-maintained from public facts), attributes (JSONB), visibility policy, and a vector embedding for semantic search. Entity deduplication uses trigram similarity (`pg_trgm`) plus an alias table that maps surface forms ("Bob", "Robert Smith", "bob@acme.com") to the canonical entity. Graph-level clustering proposes duplicate communities that pairwise resolution leaves behind.

**Facts** are the edges: temporal relationships between entities. This is the core innovation. A fact has:

| Field | Purpose |
|-------|---------|
| `source_entity_id` / `target_entity_id` | The two entities this fact connects |
| `relation` | Typed relationship (works_at, founded, decided, etc.) |
| `fact_text` | Natural language description ("Alice is CRO at Acme Corp") |
| `valid_at` | When this fact became true |
| `invalid_at` | When this fact was superseded (NULL = still true) |
| `confidence` | 0.0-1.0 extraction confidence |
| `evidence` | Quote, offsets, extractor, and confidence rationale |
| `visibility` | Row-level ACL inherited from source data |
| `source_episode_id` | Provenance: which raw data produced this fact |
| `fact_embedding` | Vector for semantic search |

When new information contradicts an existing fact, the old fact's `invalid_at` is set. It is never deleted. This is the **bi-temporal model** from Graphiti/Zep, and it is what lets you ask "what did we know about Alice on March 1st?" and get a different answer than "what do we know about Alice now?"

### The Schema

```sql
-- Entities: nodes in the graph
entities (
  id UUID, group_id TEXT, entity_type TEXT, name TEXT,
  summary TEXT, attributes JSONB, visibility JSONB,
  name_embedding vector(1536)
)

-- Facts: temporal edges
facts (
  id UUID, group_id TEXT,
  source_entity_id UUID, target_entity_id UUID,
  relation TEXT, fact_text TEXT, fact_embedding vector(1536),
  evidence JSONB, extractor TEXT, visibility JSONB,
  valid_at TIMESTAMPTZ, invalid_at TIMESTAMPTZ,
  confidence FLOAT, source_episode_id UUID, metadata JSONB
)

-- Episodes: raw provenance
episodes (
  id UUID, group_id TEXT, source_type TEXT, source_id TEXT,
  content TEXT, content_embedding vector(1536), metadata JSONB, visibility JSONB,
  valid_at TIMESTAMPTZ
)

-- Aliases: entity deduplication
entity_aliases (entity_id UUID, alias TEXT, alias_type TEXT)

-- Canonicalization + skill evolution
graph_review_queue (legacy audit table; not an operational inbox)
canonical_clusters (cluster_type TEXT, canonical_id TEXT, member_ids TEXT[], status TEXT)
skill_promotions (skill_id TEXT, status TEXT, proposal JSONB, test_results JSONB)
audit_log (actor TEXT, action TEXT, resource_type TEXT, metadata JSONB)
```

**Why these indexes matter:**
- `gin_trgm_ops` on entity names: fuzzy matching ("Alic" finds "Alice Chen") without LLM calls
- `HNSW` on embeddings: sub-millisecond semantic search via pgvector
- `tsvector` on fact_text: full-text keyword search with ranking
- `(valid_at, invalid_at)` composite: efficient temporal range queries

### Custom Ontology

The schema ships with defaults (person, company, project, decision, concept, document, event) but you can define your own:

```typescript
await brain.defineSchema({
  entityTypes: [
    { id: 'deal', label: 'Deal', description: 'A sales opportunity' },
    { id: 'feature_request', label: 'Feature Request' },
  ],
  relationTypes: [
    { id: 'requested', label: 'Requested', sourceTypes: ['person'], targetTypes: ['feature_request'] },
    { id: 'part_of_deal', label: 'Part Of Deal', sourceTypes: ['feature_request'], targetTypes: ['deal'] },
  ],
});
```

Entity types and relation types are stored in the database (not hardcoded), scoped by `group_id` for multi-tenant isolation. The `source_types` and `target_types` arrays on relation types enforce structural constraints.

### Multi-Tenancy

Every table has a `group_id` column. A group is a workspace: one brain can serve multiple teams, projects, or tenants. The default group is `'default'`. All queries are group-scoped. This is how you run one Postgres instance for an entire company without data leaking between teams.

In SDK/REST/MCP calls this appears as `groupId`. If you ingest with `groupId: 'acme'`, you must search/answer with `groupId: 'acme'` too. Otherwise the query reads the default group and may look empty even though another group has data.

Example:

```typescript
await brain.ingest({
  groupId: 'customer-success',
  content: 'Apex Health SSO is blocked on SCIM mapping.',
  sourceType: 'raw_note',
});

await brain.answer({
  groupId: 'customer-success',
  query: 'What is blocking Apex Health?',
});
```

For local manual testing, omit `groupId` everywhere and clear the database before each run. Custom group IDs are only useful when you need isolated test tenants without wiping the database.

### Security and Source Permissions

Episodes, entities, and facts include a `visibility` JSONB policy. That policy travels with extracted graph records, so if a private Slack message creates a fact, the fact remains private too.

The security model has four layers:

1. **Tenant isolation with `group_id`**: every table is scoped to a workspace/group. Queries only read from the requested group.
2. **Row-level visibility policies**: episodes, entities, and facts each carry allowed/denied principals, groups, source ACLs, and classification labels.
3. **Access-aware retrieval**: search, answer synthesis, graph traversal, PageRank, temporal queries, `getEntity`, `findEntity`, and `getFacts` all apply the same visibility filter.
4. **Permission simulation and audit**: `simulatePermission()` explains why an access context can or cannot see a policy, while `audit_log` records security-sensitive mutations and canonicalization decisions.

The most important default: **missing `access` is public-only**. If a row has `allowedGroups`, `allowedPrincipals`, or source ACL allow rules, it will not be returned unless the caller provides matching access. Internal/admin jobs must explicitly pass `access: { bypass: true }`.

Classification labels are descriptive only. They do not invent access rules. Durable access control must come from source-native ACL metadata, explicit `allowedGroups`/`allowedPrincipals`, or source connector permissions. MCP ingest returns `visibilityWarnings` when a classification looks restricted but has no explicit access policy.

Visibility can be supplied directly at ingest:

```typescript
await brain.ingest({
  content: 'SEC ONLY incident 42: token path was /legacy/ops/admin_token',
  sourceType: 'slack_message',
  visibility: {
    allowedGroups: ['security'],
    deniedGroups: ['product'],
    classification: 'security_incident',
  },
});
```

Then retrieval must include matching access:

```typescript
// Can see security-only facts
await brain.answer({
  query: 'What was the token path in incident 42?',
  access: { principalId: 'nora', groups: ['security'] },
});

// Public-only by default; restricted facts are hidden
await brain.answer({
  query: 'What was the token path in incident 42?',
});

// Explicit internal/admin bypass for maintenance jobs only
await brain.search({
  query: 'incident 42',
  access: { bypass: true },
});
```

Policies support:

| Field | Meaning |
|-------|---------|
| `allowedPrincipals` | Specific users/service principals that can read the row |
| `deniedPrincipals` | Specific users/service principals that are always blocked |
| `allowedGroups` | Groups/teams/roles that can read the row, e.g. `security` |
| `deniedGroups` | Groups/teams/roles that are always blocked |
| `classification` | Label such as `public`, `candidate_feedback`, `security_incident`, or `confidential` |
| `sourceSystem` | Provider that produced the ACL, e.g. `slack`, `hubspot`, `google_drive` |
| `sourceAcl` | Provider-native ACL entries for users, groups, channels, workspaces, roles, or accounts |
| `inheritedFrom` | Source record/channel/document ID that the policy came from |

Normalizers can also derive visibility from source payloads:

- Slack: workspace, channel, thread, user, files, reactions, blocks, channel groups
- Calls/meetings: participants, speaker IDs, transcript turns, action items, decisions
- Analytics: workspace/project, event identity, dimensions, properties
- CRM: owner, team, stage/status, associations, record fields

Source ACL examples:

```typescript
// Slack channel ACL derived from metadata
{
  sourceSystem: 'slack',
  sourceAcl: [
    { provider: 'slack', id: 'C_SEC', type: 'channel', access: 'allow' },
    { provider: 'slack', id: 'U_BAD', type: 'user', access: 'deny' },
  ],
}

// Matching access
{
  principalId: 'nora',
  groups: ['slack:channel:C_SEC', 'security'],
  sourceAccounts: { slack: 'U_NORA' },
}
```

Use `simulatePermission()` or `POST /api/permissions/simulate` when debugging access:

```typescript
brain.simulatePermission(
  { allowedGroups: ['security'] },
  { principalId: 'pm-user', groups: ['product'] },
);
// => { allowed: false, reason: 'No allow policy matched', ... }
```

This means the same data can safely support public answers, team-restricted answers, source-native ACL enforcement, and admin maintenance without relying on the calling agent to remember what should be hidden.

---

## The Extraction Pipeline

This is the most important architectural decision in the system. We studied three approaches and picked the one optimized for reliability.

### Why LLM-First (Not Regex-First)

gbrain uses regex-first extraction: hardcoded patterns like `([A-Z][a-zA-Z]+), CEO of ([A-Z][a-zA-Z\s]+)` catch structured relationships, and anything the regex misses is simply not extracted. This is fast and free, but fundamentally brittle:

- "Alice leads the engineering team at Acme": no regex catches "leads"
- "The deal with Acme fell through after Bob left": implicit relationship change
- "She mentioned they're evaluating competitors": "she" and "they" require coreference

Graphiti/Zep uses LLM-for-everything, which is reliable but expensive. Every piece of text hits an LLM even when the content is structured data the LLM adds no value to (email addresses, @mentions, dates).

**Company Brain's approach: LLM-first with deterministic augmentation.**

The LLM is the primary extraction engine. It handles nuance, paraphrase, implicit relationships, and context. The deterministic layer is a pre-scan that catches structured signals (emails, URLs, @mentions) and matches against known entities in the graph. These get merged into the LLM results, not used instead of them.

### The Pipeline in Detail

When you call `brain.ingest(input)`:

**Step 0: Episode storage.** The raw content is stored as an immutable episode with its embedding. This happens before extraction. Even if extraction fails, you have the raw data.

**Step 1: Source normalization + permissions.** Source-shaped payloads are rendered into extraction-ready text while preserving structured metadata. Slack threads/files/reactions, call diarization, analytics dimensions, and CRM associations are kept in metadata. Visibility policies are inferred from source permissions when available and inherited by extracted graph records.

**Step 2: Organizational memory derivation.** The episode is also converted into first-class organizational memory objects: interactions, decisions, rationale, commitments, open questions, risks, and value-creating objects. These are universal org primitives, not customer-domain hardcodes. Each object keeps source episode provenance, evidence quotes, confidence, timestamps, and inherited visibility.

**Step 3: Deterministic pre-scan.** Fast regex pass (~1ms) catches:
- Email addresses, which become person entities with `{ email }` attribute
- @mentions, which become person entities with `{ handle }` attribute
- Known entity matching: any entity name already in the graph (via alias table) gets flagged at 0.95 confidence

This is not the extraction engine. This is a metadata supplement.

**Step 4: LLM extraction.** The content is sent to Claude (Sonnet) or GPT with a structured output prompt. The prompt includes:
- Entity type definitions and relationship types
- Relation cardinality and invalidation policies
- Confidence calibration guidelines (0.95 for explicit, 0.8 for implied, 0.6 for inferred)
- Evidence quote and confidence rationale requirements
- **Existing graph context**: facts about known entities mentioned in the text, so the LLM can detect changes ("Alice was VP, now the text says CRO" means this is a role change, not a duplicate)

The LLM returns structured JSON with entities, facts, temporal information, evidence, and per-item confidence scores.

**Step 5: Merge.** LLM results are the authority. Deterministic results add structured attributes (email addresses, handles) to matching LLM entities. If the deterministic scan found something the LLM missed entirely (rare), it gets appended.

**Step 6: Resolution.** Each extracted entity is resolved against the existing graph:
1. Exact alias match (alias table, instant)
2. Type-aware trigram/embedding match
3. Ambiguous match: enqueue review instead of unsafe merge
4. No match: create new entity and register alias

Each extracted fact is checked for contradictions:
- Duplicate fact: **skip**
- Relation cardinality says one current fact should exist: **invalidate old fact** according to policy
- Non-exclusive relation: **create alongside** existing
- Missing/ambiguous entity grounding: **enqueue review**

**Step 7: Logging and improvement loop.** Every extraction is logged to `extraction_log` with method, entities/facts extracted, confidence, and duration. Review items, improvement proposals, canonical clusters, and skill promotions use this trail to improve the system over time.

### Fallback Mode

When no LLM API key is configured, triage fails closed to ephemeral retention and semantic graph/memory extraction is skipped. The system does not use regex or deterministic semantic fallbacks to pretend it understands organizational meaning.

### Graph-Aware Extraction

This is a key differentiator from both gbrain (no graph awareness) and basic RAG (no graph at all).

Before the LLM extracts from new text, we query the existing graph for any entities the deterministic pre-scan recognized. The LLM receives context like:

```
Known entities:
- Alice Chen (person): VP at Acme Corp; email alice@acme.com
- Acme Corp (company): Enterprise customer, evaluating upgrade
```

This means the LLM can:
1. Detect role changes (Alice was VP, now text says CRO)
2. Avoid creating duplicate entities (text says "Alice" and we already know "Alice Chen")
3. Connect new information to existing relationships

---

## The Search Engine

The search engine uses a three-tier architecture inspired by state-of-the-art graph RAG systems ([HippoRAG](https://arxiv.org/abs/2405.14831), [Microsoft GraphRAG](https://arxiv.org/abs/2404.16130), [LightRAG](https://arxiv.org/abs/2410.05779), [Zep/Graphiti](https://arxiv.org/abs/2501.13956)). Queries are automatically routed to the optimal retrieval strategy, using LLMs for understanding and synthesis, embeddings and SQL for retrieval.

### Design Philosophy: LLMs for Thinking, Embeddings for Finding

The key insight from SOTA graph RAG research is that **LLMs and embeddings serve different purposes in retrieval**. Using regex patterns or keyword matching for query understanding is fragile — it fails on lowercase names, abbreviations, informal language, non-English text. Using LLMs for vector search is wasteful — cosine similarity is faster and cheaper.

Company Brain splits the work accordingly:

| Component | Method | Why |
|-----------|--------|-----|
| **Query understanding** | LLM (Claude Sonnet 4.6 / GPT-5.4 mini) | "what's going on with that acme situation" can't be parsed by regex |
| **Entity extraction from queries** | LLM | Catches any casing, abbreviations, partial names, implied references |
| **Seed entity discovery** | Embedding similarity (primary) + trigram + FTS | Cosine similarity on entity `name_embedding` vectors — no hardcoded patterns |
| **Graph traversal** | PostgreSQL recursive CTEs | Pure graph algorithm, no LLM needed |
| **PageRank** | In-memory power iteration (Float64Array) | Pure math |
| **Community summaries** | LLM (generated once, cached 5 min) | Need to synthesize scattered facts into coherent descriptions |
| **Community matching** | Embedding similarity + graph salience | Handles abstract/global queries without lexical overlap rules |
| **Keyword search** | PostgreSQL `tsvector` FTS | Deterministic, fast, searches entities + facts + episodes |
| **Semantic search** | Embedding + pgvector HNSW | Vector math, not LLM reasoning |
| **Result fusion** | Reciprocal Rank Fusion (RRF) | Pure scoring formula |
| **Query decomposition** | LLM (for complex multi-hop only) | Breaking complex questions into sub-queries needs reasoning |

### Three-Tier Architecture

| Tier | Latency | When Used | Methods |
|------|---------|-----------|---------|
| **Tier 1** | <100ms | Simple lookups: "Who is Alice?" | Keyword + Graph + Semantic |
| **Tier 2** | <500ms | Relationship/analytical/temporal/global queries | Semantic + Keyword + Graph Traversal + PPR + Communities |
| **Tier 3** | 1-5s | Complex multi-hop reasoning | LLM Decomposition → Sub-query execution through Tier 1/2 |

### Query Router

When an LLM config is available, the router makes a single LLM call (Claude Sonnet 4.6 / GPT-5.4 mini, ~200 tokens, <300ms) that does three things at once:

1. **Intent classification** — categorizes the query into one of seven intents
2. **Entity extraction** — pulls out all entity names regardless of casing, abbreviations, or informal references
3. **Temporal parsing** — identifies time references ("since last month", "as of Q1")

This replaces the rule-based regex/stopword approach with a system that handles natural language reliably. If no LLM is configured, the router uses broad hybrid retrieval rather than semantic regex routing.

| Intent | Example | Tier | Methods |
|--------|---------|------|---------|
| `entity_lookup` | "Who is Alice Chen?" | 1 | keyword, graph, semantic |
| `relationship` | "Who does Alice work with?" | 2 | graph, pagerank, keyword, semantic |
| `temporal` | "What changed since last month?" | 2 | temporal, keyword |
| `analytical` | "How many deals in the pipeline?" | 2 | keyword, graph, semantic |
| `global` | "How's our pipeline looking?" | 2 | community, semantic, keyword |
| `similarity` | "Find companies similar to Acme" | 2 | semantic |
| `multi_hop` | "Which deals are at risk due to leadership changes?" | 3 | decompose |

### Retrieval Methods

**Semantic search** embeds the query via OpenAI `text-embedding-3-large` (1536 dimensions), then uses pgvector's HNSW index to find entities and facts with high cosine similarity. Threshold: 0.3 similarity minimum. Included in almost all query routes as a reliable fallback.

**Keyword search** uses PostgreSQL's built-in `tsvector` full-text search with `websearch_to_tsquery`. Searches entity name+summary, fact text, and episode content (raw ingested data). Score is `ts_rank` weighted by fact confidence. Episodes are capped at 5 results and scored at 0.7x to prioritize structured data.

**Graph traversal** uses a multi-signal approach to find seed entities, then walks the knowledge graph using PostgreSQL recursive CTEs. Seed entity discovery runs three strategies **in parallel**:

1. **Embedding similarity** (primary, like HippoRAG/GraphRAG): cosine similarity between the query embedding and entity `name_embedding` vectors. Catches semantic matches like "CTO" → "Chief Technology Officer".
2. **Trigram similarity** (supplementary): `pg_trgm` matching against entity names + the `entity_aliases` table for character-level fuzzy matching.
3. **Full-text search** (fallback): FTS with **OR semantics** on entity name + summary.

From the seed entities, a recursive CTE walks outward up to 3 hops. Each hop decays the score by 0.9 (`confidence * 0.9^hop`). Facts are deduplicated by keeping shortest-path occurrences.

**Personalized PageRank (PPR)** — inspired by [HippoRAG (NeurIPS 2024)](https://arxiv.org/abs/2405.14831). Seeds probability from query-relevant entities (found via the same multi-signal seed discovery) and lets it flow through the graph to surface non-obvious, multi-hop connections. Uses power iteration with configurable teleport probability (alpha=0.15), convergence via L1 norm, and handles dangling nodes. Implemented with Float64Array for performance.

**Community search** uses label propagation to detect clusters of related entities in the graph. Each community gets an LLM-generated summary (Claude Sonnet 4.6 / GPT-5.4 mini) describing what the group represents and its key relationships. Summaries are cached in memory for 5 minutes to avoid regeneration on every query. Queries are matched against embedded community representations, then lightly boosted by graph salience from community size and internal edge weight. Singleton entities are filtered out.

**Temporal operators** support five query types:
- `AS_OF(timestamp)`: What was true at a point in time?
- `CHANGED_SINCE(timestamp)`: What was created or invalidated recently?
- `VALID_DURING(start, end)`: What facts overlapped a time range?
- `ENTITY_TIMELINE(entityId)`: Full chronological history of an entity
- `RECENT_CONTRADICTIONS`: Pairs of old/new facts where the old was superseded

### Query Decomposition (Tier 3)

Complex multi-hop questions are broken into atomic sub-queries that can each be answered by Tier 1/2 retrieval. Decomposition is LLM-first; without an LLM it falls back to a single broad sub-query instead of regex templates.

Sub-queries have dependency tracking: if sub-query 2 depends on results from sub-query 0, it waits for sub-query 0 to complete and enriches its question with that context. Independent sub-queries run in parallel.

Example decomposition for "Which deals are at risk because of leadership changes?":
1. `Find all active deals` (entity_lookup)
2. `Find recent leadership changes` (temporal)
3. `Which entities from the deals are connected to entities affected by leadership changes?` (relationship, depends on 1+2)

### Reciprocal Rank Fusion

RRF combines ranked results from different retrieval methods without needing to normalize their incompatible score scales (cosine similarity vs. BM25 rank vs. graph distance vs. PPR probability).

For each result appearing in any list at rank `r`, its RRF score is: `1 / (k + r)` where `k = 60`. If a result appears in multiple lists, its scores are summed. This naturally boosts results that appear across multiple retrieval methods (high agreement = high relevance).

After fusion, a **recency boost** applies a logarithmic decay: `score *= 1 + 0.1 * max(0, 1 - log(ageInDays + 1) / log(365))`. Recent facts get a small bump; old facts are not penalized much.

### Grounded Answer Synthesis

`brain.answer()` and the MCP/REST `answer` tools retrieve evidence first, then synthesize prose from that evidence only. The returned object includes the final `answer`, cited snippets, separated `inference`, explicit `missing` gaps, and answer-level `confidence`.

Answer retrieval now includes first-class organizational memory objects and prefers them for questions about decisions, commitments, owners, blockers, risks, and uncertainty. This helps preserve literal operational details like owners, token paths, dates, and "no decision / not proven" caveats that generic summarization can otherwise wash out.

Answer retrieval also uses **small-to-big / parent-child retrieval**. Precise child results such as facts and memory objects are still ranked normally, but before relevance checking and synthesis the answer layer expands those hits back to their parent source episodes under the same ACL filter. This prevents atomized fact snippets from losing adjacent interaction context, such as the next line of a Slack thread, nearby transcript turns, action items, or caveats in the original call/document.

For debugging and evals, pass `trace: true` to `brain.answer()`. The returned `trace` shows the visible stored episodes, extracted facts/memory, retrieved evidence, source-context expansions, relevance gate decision, and final synthesis mode. This makes failures diagnosable as "dropped at triage", "lost in extraction", "not retrieved", "blocked by relevance", or "omitted during synthesis" instead of relying on brittle keyword checks.

When an LLM is configured, synthesis uses a strict JSON prompt that can only cite returned evidence. Without an LLM, the tool falls back to an extractive evidence summary, so callers still get grounded output instead of unsupported prose.

### Organizational Memory Layer

The temporal graph remains the flexible substrate, but organizational intelligence needs a stable spine. Each ingested episode derives universal memory objects into `organizational_memory`:

| Kind | Purpose |
|------|---------|
| `interaction` | Raw source interaction summary with provenance |
| `decision` | What was decided, rejected, parked, or left undecided |
| `rationale` | Why something happened or why a choice was made |
| `commitment` | Owner/action/next-step style obligations |
| `open_question` | Uncertainty, caveats, unresolved questions, and not-proven claims |
| `risk` | Incidents, blockers, regressions, concerns, and "do not" constraints |
| `value_object` | Products, customers, projects, incidents, deals, candidates, features, etc. |

These primitives are not domain-specific hardcodes. "Candidate", "investor", "incident", and "customer" remain dynamic graph concepts. The stable layer only captures how organizations think and operate.

Use it directly through SDK, MCP, or REST:

```typescript
await brain.searchMemory({
  query: 'Who owns the Blue Finch import fix?',
  kinds: ['commitment'],
});

await brain.listMemory({
  kinds: ['decision', 'commitment', 'open_question'],
  limit: 20,
});
```

### Cost per Query

| Scenario | LLM Calls | Embedding Calls | Approximate Cost |
|----------|-----------|-----------------|------------------|
| Tier 1 (no LLM config) | 0 | 1 | ~$0.0001 |
| Tier 1 (with LLM routing) | 1 (router) | 1 | ~$0.003 |
| Tier 2 (with LLM routing) | 1 (router) | 1 | ~$0.003 |
| Tier 2 global (first query, builds communities) | 1 (router) + N (summaries) | 1 | ~$0.01-0.05 |
| Tier 2 global (cached communities) | 1 (router) | 1 | ~$0.003 |
| Tier 3 (decomposition) | 1 (router) + 1 (decomposer) | 1 per sub-query | ~$0.01-0.02 |

### Search Module Map

```
packages/core/src/search/
├── index.ts           # Three-tier search engine, RRF fusion, method runner
├── router.ts          # LLM query understanding + broad hybrid fallback
├── decomposer.ts      # LLM query decomposition + broad single-query fallback
├── graph-traversal.ts # Multi-signal seed discovery + recursive CTE traversal
├── pagerank.ts        # Personalized PageRank (HippoRAG-inspired)
├── temporal.ts        # AS_OF, CHANGED_SINCE, VALID_DURING, timelines
└── communities.ts     # Label propagation + LLM summaries + cached search
```

### SOTA Influences

| System | What We Took | Reference |
|--------|-------------|-----------|
| **HippoRAG** (NeurIPS 2024) | Embedding similarity for seed entity discovery, Personalized PageRank for multi-hop reasoning | [Paper](https://arxiv.org/abs/2405.14831) |
| **Microsoft GraphRAG** | Community detection with LLM-generated summaries for global/abstract queries | [Paper](https://arxiv.org/abs/2404.16130) |
| **LightRAG** | Dual-level query analysis (entity keywords + conceptual themes), efficient subgraph retrieval | [Paper](https://arxiv.org/abs/2410.05779) |
| **Zep/Graphiti** | Bi-temporal fact model, multi-pipeline retrieval (semantic + keyword + graph), entity resolution | [Paper](https://arxiv.org/abs/2501.13956) |
| **RAG-Fusion** | Reciprocal Rank Fusion for combining retrieval methods without score normalization | [Paper](https://arxiv.org/abs/2402.03367) |
| **Small-to-big retrieval** | Retrieve precise facts/spans, then expand to parent source interactions for answer context | Common production RAG pattern |

---

## The Skill System

Skills are markdown SOPs (Standard Operating Procedures) that teach AI agents HOW to use the brain. This is the pattern from gbrain: intelligence lives in the skill files, not in hardcoded logic.

The idea is that this repo can be built on and adapted so the brain does not just store knowledge; it notices repeated bottlenecks and turns them into executable operating knowledge for agents. If the system repeatedly sees the same kind of source, review failure, workflow, customer process, or extraction gap, it can propose a new skill, validate that the resolver can route to it, and promote it to a markdown SOP. Over time, those skills can become the foundation for agents that automate full jobs and processes inside a business.

### Why Skills Matter

Without skills, an agent with access to `brain.search()` and `brain.ingest()` will use them naively, searching with bad queries, ingesting noise, missing the READ then ENRICH then WRITE loop. Skills encode operational knowledge:

| Skill | Type | What It Teaches |
|-------|------|-----------------|
| `signal-detector` | Always-on | Detect entities and facts in every message. Don't ingest greetings. Capture decisions. |
| `brain-ops` | Always-on | Search the brain BEFORE external sources. Write new knowledge back. Maintain backlinks. |
| `query` | On-demand | How to search effectively, enrich top results, synthesize answers with confidence levels. |
| `enrich` | On-demand | Build comprehensive entity profiles. Gap analysis by entity type. Cite sources. |
| `ingest-meeting` | On-demand | Extract attendees, decisions, action items. Verify extraction. Enrich new entities. |
| `timeline` | On-demand | Show temporal history. Group by period. Highlight contradictions. |
| `extraction-review` | On-demand | Review extraction stats. Evaluate schema, prompt, and eval improvement suggestions. |

### The Resolver

The `SkillResolver` matches user intent to the right skill using two-phase matching:

1. **Deterministic**: exact trigger match (1.0 confidence), then substring match (0.8-0.95), then keyword overlap (up to 0.7)
2. **Priority tiebreaking**: when confidence is equal, higher-priority skills win

The resolver also generates a markdown routing table (`resolver.toRoutingTable()`) that can be injected into an LLM's system prompt, giving it a menu of available operations.

### Custom Skills

Skills are markdown files stored in `~/.company-brain/skills/`. The 7 built-in skills work out of the box. You can add new skills or override built-in ones by creating files in this directory. No repo clone needed.

Each skill file has YAML frontmatter with metadata, followed by the markdown SOP:

```markdown
---
id: deal-tracker
name: Track Deal
description: Track a sales deal through the pipeline
triggers:
  - track deal
  - deal update
  - pipeline status
priority: 75
---
# Deal Tracker

## Protocol
1. Search for the deal entity: `brain.findEntity(dealName)`
2. Get full context: `brain.getEntity(id, { includeFacts: true, includeTimeline: true })`
3. Present current status, recent changes, and next steps
4. If deal info was updated, ingest the new information back

## What to Track
- Deal stage changes (lead, qualified, proposal, closed)
- Key contacts and their roles
- Competitor mentions
- Timeline and deadlines
```

Save that as `~/.company-brain/skills/deal-tracker.md`. It loads automatically on next startup.

You can also create or edit skills directly from Cursor/Claude Code. The MCP server exposes `save_skill`, `list_skills`, and `get_skill` tools. Ask Claude to "create a skill for triaging support tickets" and it will write the file for you.

To override a built-in skill, create a file with the same id. For example, `~/.company-brain/skills/query.md` replaces the default query skill with your team's custom search protocol.

### Automatic Skill Evolution

The skill-evolution path is wired through the same fail-improve loop as extraction and evals:

1. Ingest/extraction behavior is logged in `extraction_log`.
2. `getImprovementProposals()` turns repeated patterns and bottlenecks into proposals, including `kind: "skill"` proposals for recurring workflows.
3. `brain.promoteSkills()` takes high-confidence skill proposals, drafts a markdown SOP, validates that the resolver can route to it, and optionally writes it to the skills directory.
4. Every attempt is recorded in `skill_promotions` with the proposal, validation results, status, and file path.

The current implementation is intentionally conservative: it creates proposals and validates/promotes them when explicitly requested rather than silently changing agent behavior in the background. Expanding this into richer closed-loop skill creation is straightforward because the proposal, validation, persistence, and markdown skill-writing path already exists.

```typescript
const promotions = await brain.promoteSkills({
  skillsDir: process.env.BRAIN_SKILLS_DIR,
  minConfidence: 0.75,
  autoPromote: true,
});
```

Use `promote_skills` over MCP or `POST /api/skills/promote` over REST for the same flow.

Relevant wiring:

| File | Role |
|------|------|
| `packages/core/src/extraction/fail-improve.ts` | Detects recurring extraction/review bottlenecks and emits improvement proposals, including skill proposals. |
| `packages/core/src/skills/evolution.ts` | Converts skill proposals into markdown SOPs, validates resolver behavior, and writes promoted skills to disk. |
| `packages/core/src/schema.sql` | Stores promotion attempts in `skill_promotions` for auditability. |
| `packages/server/src/mcp.ts` | Exposes `improvement_proposals` and `promote_skills` to agents over MCP. |

**REST API:**

```bash
# List all skills
curl http://localhost:3333/api/skills -H "Authorization: Bearer $TOKEN"

# Get a skill
curl http://localhost:3333/api/skills/query -H "Authorization: Bearer $TOKEN"

# Create/update a skill
curl -X POST http://localhost:3333/api/skills \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "deal-tracker",
    "name": "Track Deal",
    "description": "Track a sales deal through the pipeline",
    "triggers": ["track deal", "deal update"],
    "content": "# Deal Tracker\n\n## Protocol\n1. Search for the deal...",
    "priority": 75
  }'
```

---

## Connecting Data Sources

There are multiple ways to get data into the brain, from zero-code to full custom.

### Option 1: Direct Ingestion (any source, no connector needed)

If you just have text, POST it. No connector setup required. This works for any source you can get text out of.

```bash
# REST API
curl -X POST http://localhost:3333/api/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Meeting with Alice Chen from Acme. They want to upgrade to enterprise.",
    "sourceType": "meeting_transcript",
    "sourceId": "granola://meeting/abc123"
  }'
```

```typescript
// SDK
await brain.ingest({
  content: "Meeting with Alice Chen from Acme. They want to upgrade to enterprise.",
  sourceType: "meeting_transcript",
  sourceId: "granola://meeting/abc123",
});
```

This is the simplest path. If you can get the text, you can ingest it. The extraction pipeline handles the rest.

### Option 2: Built-in Connectors (Filesystem and Nango)

Connectors handle authentication, pagination, incremental sync, and data normalization for you. Connect a source with one call, then sync it whenever you want. The brain remembers where it left off between syncs (cursor and timestamp are persisted in Postgres).

Source-specific fidelity is preserved where possible. Slack sync includes thread replies, blocks, files, attachments, reactions, channel IDs, and channel-derived visibility. Nango records map common provider ACL fields (`permissions`, `acl`, `visibility`, user/group lists) into Brain visibility policies. Generic webhooks and JSON connectors preserve configured metadata fields so downstream normalizers can render them without losing provenance.

**Connect via MCP (Claude Code / Cursor):**

From any MCP chat, the agent can connect and sync data sources directly:

```
# Connect a local docs folder
Use company-brain connect with id "docs", type "filesystem", config {"rootDir": "/Users/me/notes"}

# Connect a SaaS source via Nango (handles OAuth, rate limiting, pagination)
Use company-brain connect with id "team-crm", type "nango", config {"secretKey": "nango-sk-...", "providerConfigKey": "hubspot", "connectionId": "conn-1", "model": "companies"}

# Sync — pulls new data since last sync, extracts entities/facts, builds graph
Use company-brain sync_connector with id "docs"

# Sync everything at once
Use company-brain sync_all_connectors

# Create a custom connector for any REST API (no code, persists as JSON)
Use company-brain save_connector with definition {"id": "linear", "name": "Linear Issues", "url": "https://api.linear.app/v1/issues?{{query}}", "auth": {"type": "bearer", "value": "{{token}}"}, "records": "data.issues", "content": "{{title}}\n\n{{description}}", "sourceType": "linear_issue", "dateField": "createdAt", "pagination": {"type": "cursor", "cursorField": "data.pageInfo.endCursor"}}
```

**Connect via REST API:**

```bash
# Connect a Nango-backed SaaS source
curl -X POST http://localhost:3333/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "team-crm",
    "type": "nango",
    "config": {
      "secretKey": "nango-sk-...",
      "providerConfigKey": "hubspot",
      "connectionId": "conn-1",
      "model": "companies"
    }
  }'

# Connect a local docs folder
curl -X POST http://localhost:3333/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "docs",
    "type": "filesystem",
    "config": { "rootDir": "/path/to/docs" }
  }'

# Sync a connector (fetches new data since last sync)
curl -X POST http://localhost:3333/api/connectors/team-crm/sync \
  -H "Authorization: Bearer $TOKEN"

# Sync a specific connector resource
curl -X POST http://localhost:3333/api/connectors/team-crm/sync \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "resource": "companies" }'

# List all connectors
curl http://localhost:3333/api/connectors \
  -H "Authorization: Bearer $TOKEN"
```

**Connect via SDK:**

```typescript
import { Brain, ConnectorRegistry, FilesystemConnector, NangoConnector } from '@company-brain/core';

const brain = new Brain(config);
await brain.init();

const registry = new ConnectorRegistry(brain);
registry.register(new FilesystemConnector());
registry.register(new NangoConnector());

// Connect sources
await registry.connect({ id: 'docs', type: 'filesystem', config: { rootDir: './docs' } });
await registry.connect({
  id: 'team-crm',
  type: 'nango',
  config: { secretKey: 'nango-sk-...', providerConfigKey: 'hubspot', connectionId: 'conn-1', model: 'companies' },
});

// First sync fetches everything
await registry.syncAll();

// Subsequent syncs only fetch new data (timestamps persisted in Postgres)
await registry.syncAll();
```

### Option 3: Webhooks (real-time push)

Webhooks are the primary way to get real-time data into the brain. Instead of polling APIs, external services push events directly to your brain server. The webhook receiver handles signature verification, payload normalization, and ingestion automatically.

**Architecture:**

```
External Service (GitHub, Slack, Linear, Stripe, etc.)
        │
        ▼  HTTP POST
┌──────────────────────────────────────┐
│  POST /api/webhooks/receive/:source  │  ← No bearer auth (uses HMAC signatures)
└──────────┬───────────────────────────┘
           │
     ┌─────▼─────┐
     │  Verify   │  HMAC signature check (if configured)
     │  Filter   │  Event type filtering (if configured)
     │  Normalize│  Template-based content extraction
     └─────┬─────┘
           │
     ┌─────▼─────┐
     │  Ingest   │  brain.ingest() → extraction → knowledge graph
     └───────────┘
```

**Step 1: Register a webhook source.** This tells the brain how to handle incoming payloads from a specific service.

```bash
# Register a GitHub webhook source
curl -X POST http://localhost:3333/api/webhook-sources \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "github-issues",
    "name": "GitHub Issues",
    "sourceType": "github_issue",
    "contentTemplate": "{{action}} issue #{{issue.number}}: {{issue.title}}\n\n{{issue.body}}",
    "sourceIdTemplate": "github://{{repository.full_name}}/issues/{{issue.number}}",
    "dateField": "issue.created_at",
    "secret": "your-github-webhook-secret",
    "signatureHeader": "x-hub-signature-256",
    "signatureAlgorithm": "sha256",
    "signaturePrefix": "sha256=",
    "eventTypeHeader": "x-github-event",
    "allowedEvents": ["issues", "issue_comment"],
    "metadataFields": ["action", "repository.full_name", "sender.login"]
  }'
```

**Step 2: Point the external service at your webhook URL.**

```
GitHub webhook URL:
  https://your-brain-server.com/api/webhooks/receive/github-issues

Webhook endpoints skip bearer token auth. Each source uses its own
signature verification (HMAC-SHA256, etc.) configured when registered.
```

That's it. When GitHub sends an event, the brain verifies the signature, extracts the issue content using your template, and ingests it into the knowledge graph.

**More examples:**

```bash
# Linear webhooks (no signature verification)
curl -X POST http://localhost:3333/api/webhook-sources \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "id": "linear",
    "sourceType": "linear_issue",
    "contentTemplate": "{{action}} {{type}}: {{data.title}}\n\n{{data.description}}",
    "sourceIdTemplate": "linear://{{data.id}}",
    "dateField": "data.createdAt"
  }'

# Slack Events API (with signing secret)
curl -X POST http://localhost:3333/api/webhook-sources \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "id": "slack-events",
    "sourceType": "slack_message",
    "contentTemplate": "{{event.text}}",
    "sourceIdTemplate": "slack://{{event.channel}}/{{event.ts}}",
    "dateField": "event.ts",
    "secret": "your-slack-signing-secret",
    "signatureHeader": "x-slack-signature",
    "signatureAlgorithm": "sha256"
  }'

# Stripe events
curl -X POST http://localhost:3333/api/webhook-sources \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "id": "stripe",
    "sourceType": "stripe_event",
    "contentTemplate": "{{type}}: {{data.object.description}}",
    "sourceIdTemplate": "stripe://{{id}}",
    "dateField": "created",
    "secret": "whsec_your-stripe-secret",
    "signatureHeader": "stripe-signature"
  }'
```

**Raw/open ingest endpoint.** For quick integrations, Zapier, or custom scripts, you can POST directly without registering a source:

```bash
curl -X POST http://localhost:3333/api/webhooks/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Customer called about billing issue with invoice #1234",
    "sourceType": "support_call",
    "sourceId": "call://2024-01-15/1234"
  }'
```

**Local development with ngrok.** External services like GitHub, Slack, and Stripe can't reach `localhost`. Use [ngrok](https://ngrok.com) to expose your local brain server with a public URL:

```bash
# Start your brain server
npx company-brain --rest --port 3333

# In another terminal, start ngrok
ngrok http 3333
```

ngrok gives you a public URL like `https://a1b2c3d4.ngrok-free.app`. Use that as your webhook base URL:

```
GitHub webhook URL:
  https://a1b2c3d4.ngrok-free.app/api/webhooks/receive/github-issues

Slack Events API request URL:
  https://a1b2c3d4.ngrok-free.app/api/webhooks/receive/slack-events

Raw ingest:
  https://a1b2c3d4.ngrok-free.app/api/webhooks/ingest
```

The ngrok URL changes each time you restart (unless you're on a paid plan with reserved domains), so update your webhook URLs in the external services accordingly. For production, deploy behind a stable domain with HTTPS.

**Auto-normalization.** If you don't provide a `contentTemplate`, the receiver automatically looks for common fields (`content`, `text`, `message`, `body`, `description`, `title`, `subject`) and builds a reasonable text representation. For truly unknown payloads, it serializes the entire JSON as content.

**Webhook source config reference:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique source ID |
| `name` | No | Human-readable name (defaults to id) |
| `sourceType` | Yes | Episode sourceType |
| `contentTemplate` | No | Content template with `{{field}}` placeholders |
| `sourceIdTemplate` | No | Source ID template (for dedup) |
| `dateField` | No | Dot-path to timestamp field |
| `secret` | No | HMAC secret for signature verification |
| `signatureHeader` | No | Header containing signature |
| `signatureAlgorithm` | No | `sha256` (default) or `sha1` |
| `signaturePrefix` | No | Prefix before hex digest (e.g., `sha256=`) |
| `eventTypeHeader` | No | Header containing event type |
| `allowedEvents` | No | Only process these event types |
| `metadataFields` | No | Dot-paths to extract into metadata |
| `groupId` | No | Workspace/tenant group |

**Legacy connector webhooks** still work at `POST /api/webhooks/:type` (e.g., `/api/webhooks/slack`) for connectors that implement `handleWebhook()`. The new webhook receiver at `/api/webhooks/receive/:source` is the recommended path for all new integrations.

### Custom Connectors (JSON config, no code)

Most REST APIs follow the same pattern: authenticate, paginate through records, extract content. You can define a connector for any REST API with a single JSON file. No code, no repo clone, no TypeScript.

Drop a `.json` file in `~/.company-brain/connectors/` and it becomes a connector type you can connect and sync like any built-in.

**Example: Figma comments**

```json
{
  "id": "figma-comments",
  "name": "Figma Comments",
  "url": "https://api.figma.com/v1/files/{{fileKey}}/comments",
  "auth": { "type": "header", "header": "X-Figma-Token", "value": "{{token}}" },
  "records": "comments",
  "content": "{{message}}",
  "sourceId": "figma://{{_config.fileKey}}/comment/{{id}}",
  "sourceType": "figma_comment",
  "dateField": "created_at"
}
```

Save that as `~/.company-brain/connectors/figma-comments.json`. Now connect and sync:

```bash
curl -X POST http://localhost:3333/api/connectors \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "id": "design-feedback",
    "type": "figma-comments",
    "config": { "token": "your-figma-token", "fileKey": "abc123" }
  }'

curl -X POST http://localhost:3333/api/connectors/design-feedback/sync \
  -H "Authorization: Bearer $TOKEN"
```

**Example: GitHub issues**

```json
{
  "id": "github-issues",
  "name": "GitHub Issues",
  "url": "https://api.github.com/repos/{{owner}}/{{repo}}/issues",
  "auth": { "type": "bearer", "value": "{{token}}" },
  "headers": { "Accept": "application/vnd.github.v3+json" },
  "pagination": { "type": "page", "pageParam": "page", "limitParam": "per_page", "limit": 100 },
  "content": "{{title}}\n\n{{body}}",
  "sourceId": "github://{{_config.owner}}/{{_config.repo}}/issues/{{number}}",
  "sourceType": "github_issue",
  "dateField": "created_at",
  "sinceParam": "since",
  "sinceFormat": "iso"
}
```

**Config reference:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Connector type ID |
| `name` | Yes | Human-readable name |
| `url` | Yes | URL template. `{{vars}}` are filled from instance config. |
| `auth` | No | Auth config: `type` (`bearer`, `header`, `query`), `value` template, `header`/`param` name |
| `headers` | No | Extra headers on every request |
| `records` | No | Dot-path to records array in response (e.g. `data.items`). Omit if response is the array. |
| `pagination` | No | `type` (`cursor`, `offset`, `page`), field/param names, `limit` |
| `content` | No | Template for episode content. `{{field}}` from record, `{{_config.var}}` from instance config. |
| `sourceId` | No | Template for episode sourceId |
| `sourceType` | Yes | Episode sourceType |
| `dateField` | No | Record field with timestamp |
| `sinceParam` | No | Query param for incremental sync |
| `sinceFormat` | No | `iso` (default) or `unix` |
| `rateLimitMs` | No | Milliseconds between requests (default: 200) |

This covers most REST APIs. For GraphQL, custom auth flows, or complex transformations, write a TypeScript connector class or a standalone script that POSTs to `/api/ingest`.

### Custom Connectors (TypeScript, full control)

For sources that need more than what the JSON config supports, write a connector class. Extend `AbstractConnector` and implement `setup()` and `sync()`.

```typescript
import { z } from 'zod';
import { AbstractConnector } from '@company-brain/core';
import type { SyncOptions, EpisodeInput } from '@company-brain/core';

const FigmaConfigSchema = z.object({
  token: z.string().min(1),
  fileKey: z.string().optional(),
});

export class FigmaConnector extends AbstractConnector<z.infer<typeof FigmaConfigSchema>> {
  readonly id = 'figma';
  readonly name = 'Figma';
  readonly configSchema = FigmaConfigSchema;

  async setup(config: z.infer<typeof FigmaConfigSchema>) {
    await this.fetchJson('https://api.figma.com/v1/me', {
      headers: { 'X-Figma-Token': config.token },
    });
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const comments = await this.fetchJson<any>(
      `https://api.figma.com/v1/files/${this.config.fileKey}/comments`,
      { headers: { 'X-Figma-Token': this.config.token } },
    );
    return (comments.comments || []).map((c: any) => ({
      content: c.message,
      sourceType: 'figma_comment',
      sourceId: `figma://${this.config.fileKey}/comment/${c.id}`,
      validAt: new Date(c.created_at),
    }));
  }
}
```

`AbstractConnector` gives you rate-limited fetch with retry (exponential backoff, 429 handling), Zod config validation, and structured logging for free. See [`docs/writing-connectors.md`](docs/writing-connectors.md) for the full guide.

---

## Observability

Every extraction is logged to the `extraction_log` table:

```typescript
const stats = await brain.getExtractionStats();
// {
//   totalExtractions: 847,
//   deterministicHits: 0,     // structural pre-scan hits only
//   llmFallbacks: 0,
//   deterministicRate: 0,
//   topMissPatterns: [...]    // recurring areas to review
// }
```

The `getSuggestedPatterns()` compatibility API analyzes recurring LLM extraction behavior and returns schema, prompt, and eval coverage suggestions:

```typescript
const suggestions = await brain.getSuggestedPatterns(5);
// [{ entityType: 'company', suggestion: 'Review ontology descriptions and add eval cases for acquisition language', examples: [...] }]
```

This is the **fail-improve loop** adapted for LLM-first extraction. It does not generate semantic regex rules; it points developers toward better ontology guidance, prompts, and evals.

Improvement proposals extend this into audited changes:

```typescript
const proposals = await brain.getImprovementProposals();
const clusters = await brain.proposeCanonicalClusters({ minConfidence: 0.85 });
const evalResults = await brain.runEvals(allEvalFixtures);
```

- `getImprovementProposals()` suggests schema, extraction, canonicalization, and skill changes.
- `proposeCanonicalClusters()` applies high-confidence graph-level canonicalization immediately, returns ambiguous clusters inline, and logs low-confidence candidates as telemetry.
- `runEvals()` runs DB-backed fixtures through live ingest, retrieval, permission checks, and answer scoring; built-in fixtures include baseline domains plus messy pressure cases for aliases, noisy source text, contradictions, and ACL leaks. For live debugging, answer traces expose the full path from retained episodes to extracted facts/memory, retrieved evidence, source-context expansion, relevance gating, and final answer synthesis.

---

## Design Decisions and Why

### Why Postgres-Only (No Neo4j)

Graphiti requires Neo4j for graph storage and Postgres for everything else. This means two databases to deploy, monitor, backup, and keep in sync. For most teams, the operational complexity is not worth it.

PostgreSQL with pgvector, pg_trgm, and standard indexes handles everything we need:
- **Graph traversal**: recursive CTEs or simple JOINs through the facts table (entities joined via source/target)
- **Vector search**: pgvector HNSW indexes, same cosine similarity as dedicated vector DBs
- **Full-text search**: built-in tsvector/tsquery, no Elasticsearch needed
- **Fuzzy matching**: pg_trgm similarity() for entity dedup
- **Temporal queries**: standard timestamp range filters on indexed columns

One database. One backup. One connection pool. For the scale most teams operate at (millions of facts, not billions), Postgres handles this with ease.

### Why LLM-First (Not Deterministic-First)

We initially built the system deterministic-first (like gbrain). It was fast and cheap but missed too much. Real-world text is messy:

- "The Acme folks said they're going with us": who are "the Acme folks"? Which "us"?
- "Alice is taking over Bob's accounts": this implies Bob had accounts AND Alice now has them
- "Decided to sunset the starter tier": this is a decision entity AND a fact about a product

Regex catches "Alice Chen, CEO of Acme Corp" but not the other 80% of how humans actually communicate information. For a system that needs to be reliable and smart, the LLM has to be the primary extractor.

The deterministic layer still adds value as a pre-scan: it catches structured data (email addresses, @handles) that the LLM might overlook, and it matches known entities from the alias table for faster resolution. But it supplements the LLM. It does not replace it.

### Why Bi-Temporal Facts (Not Append-Only)

gbrain uses an append-only timeline: new information is appended, old information stays as-is. This means when Alice changes roles from VP to CRO, you have two contradictory facts with no indication that one superseded the other.

Company Brain invalidates the old fact instead. The old fact's `invalid_at` timestamp is set, and a new fact is created. This means:

- `getFacts(aliceId, { includeInvalidated: true })` shows the full history
- `getFacts(aliceId, { asOf: new Date('2024-03-16') })` shows what was true on March 16
- `getFacts(aliceId)` shows only current facts

The contradiction detection happens during resolution using relation metadata. Each relation type can declare cardinality (`many`, `one_per_source`, `one_per_target`, `one_between_pair`) and an invalidation policy (`never`, `always`, `llm`). A relation like `works_at` can supersede older current facts for the same person, while non-exclusive relations like `mentions` and `related_to` coexist.

### Why Skills (Not Just an API)

An agent with access to `brain.search()` will call it. But it will not know to:
1. Check the brain before searching the web
2. Write new information back after learning it
3. Use temporal queries for historical questions
4. Verify extraction results after ingesting meeting notes
5. Check for contradictions in the timeline

Skills encode this operational knowledge as markdown SOPs. The always-on skills (`signal-detector`, `brain-ops`) run on every message. The on-demand skills (`query`, `enrich`, `ingest-meeting`) are activated by the resolver when the user's intent matches their trigger phrases.

This is the "thin harness, fat skills" pattern from gbrain: the runtime is minimal, the intelligence lives in the skill files.

### Why Structured Output (Not Free-Form LLM)

The LLM extraction prompt requires JSON output with a specific schema. Not natural language descriptions of entities, but structured data the pipeline can directly process. This means:

- Entity types are constrained to the ontology
- Relation types are constrained to defined types
- Confidence scores are explicit numbers, not vibes
- Temporal information is in ISO format, not "last week"
- Every fact has source and target entity names that match extracted entities

This is more expensive per-token than a free-form prompt (the LLM has to think harder about structure), but the downstream pipeline never has to guess what the LLM meant.

---

## Project Structure

```
company-brain/
├── packages/
│   ├── core/                           # The engine
│   │   ├── src/
│   │   │   ├── index.ts                # Brain class, public API surface
│   │   │   ├── types.ts                # All TypeScript interfaces
│   │   │   ├── schema.sql              # Postgres schema (pgvector + temporal + trgm)
│   │   │   ├── db.ts                   # Connection management (postgres.js)
│   │   │   ├── embedding.ts            # OpenAI embeddings + cosine similarity
│   │   │   ├── normalization.ts         # Source-specific normalization + ACL inheritance
│   │   │   ├── security.ts              # Visibility policies, permission simulation, SQL filters
│   │   │   ├── extraction/
│   │   │   │   ├── index.ts            # Pipeline orchestrator (LLM-first)
│   │   │   │   ├── deterministic.ts    # Pre-scan: emails, mentions, URLs, known entities
│   │   │   │   ├── llm.ts             # Primary extractor: GPT/Claude structured output
│   │   │   │   ├── resolver.ts         # Entity dedup + fact contradiction detection
│   │   │   │   └── fail-improve.ts     # Extraction logging + prompt/schema/eval suggestions
│   │   │   ├── search/
│   │   │   │   ├── index.ts            # Three-tier search engine + RRF
│   │   │   │   ├── router.ts           # LLM/rule query routing
│   │   │   │   ├── decomposer.ts       # Multi-hop query decomposition
│   │   │   │   ├── graph-traversal.ts  # Recursive CTE graph traversal
│   │   │   │   ├── pagerank.ts         # Personalized PageRank
│   │   │   │   ├── temporal.ts         # AS_OF, CHANGED_SINCE, timelines
│   │   │   │   └── communities.ts      # Label propagation + summaries
│   │   │   ├── answer/
│   │   │   │   ├── synthesis.ts        # Grounded answer synthesis + citations
│   │   │   │   └── index.ts
│   │   │   ├── memory/
│   │   │   │   └── index.ts            # Organizational memory derivation/search
│   │   │   ├── graph/
│   │   │   │   ├── clustering.ts       # Entity/relation canonical cluster proposals
│   │   │   │   └── index.ts
│   │   │   ├── eval/
│   │   │   │   ├── harness.ts          # Fixture scoring and suite runner
│   │   │   │   ├── db-adapter.ts       # Live Brain-backed eval adapter
│   │   │   │   ├── fixtures.ts         # Built-in multi-domain gold fixtures
│   │   │   │   └── index.ts
│   │   │   ├── skills/
│   │   │   │   ├── types.ts            # Skill, SkillMatch, ResolverConfig
│   │   │   │   ├── resolver.ts         # Intent to skill matching
│   │   │   │   ├── loader.ts           # Load/save skills from markdown files
│   │   │   │   ├── evolution.ts         # Draft/validate/promote skills from proposals
│   │   │   │   ├── defaults.ts         # 7 built-in skills (SOPs)
│   │   │   │   └── index.ts
│   │   │   └── connectors/
│   │   │       ├── types.ts            # Connector, SyncOptions, SyncResult
│   │   │       ├── base.ts             # AbstractConnector (rate limit, retry, Zod)
│   │   │       ├── configurable.ts     # JSON-defined REST API connector
│   │   │       ├── config-loader.ts    # Load connector definitions from directory
│   │   │       ├── registry.ts         # ConnectorRegistry orchestration
│   │   │       ├── filesystem.ts       # Markdown/text file connector
│   │   │       ├── nango.ts            # Nango (700+ integrations via REST API)
│   │   │       └── index.ts
│   │   │   └── webhooks/
│   │   │       ├── receiver.ts         # Configurable webhook receiver
│   │   │       ├── types.ts
│   │   │       └── index.ts
│   │   ├── tests/
│   │   │   ├── extraction.test.ts      # LLM-first extraction + structural pre-scan
│   │   │   ├── skills.test.ts          # 13 unit tests (no DB)
│   │   │   ├── eval-harness.test.ts    # Eval scoring + access expectations
│   │   │   ├── security-normalization.test.ts # ACL + source normalization
│   │   │   ├── skill-evolution.test.ts # Skill proposal validation
│   │   │   ├── answer-synthesis.test.ts # Grounded answers + answerability
│   │   │   ├── triage.test.ts          # LLM-first memory-worthiness triage
│   │   │   ├── search.test.ts          # 4 unit tests (no DB)
│   │   │   └── integration.test.ts     # 7 integration tests (needs Postgres)
│   │   └── package.json
│   └── server/                          # MCP + REST interfaces
│       ├── src/
│       │   ├── index.ts                # CLI entry: --mcp, --rest, --port
│       │   ├── mcp.ts                  # MCP tools via stdio transport
│       │   └── rest.ts                 # REST API with bearer auth + CORS
│       └── package.json
├── tests/
│   ├── demo.ts                         # Verbose walkthrough with colored logging
│   ├── messy-noise-suite.ts            # Noisy live pressure suite
│   └── operating-memory-suite.mjs      # Public launch smoke suite against dist
├── examples/
│   └── basic-usage.ts                  # Quick start example
├── docker-compose.yml                  # Postgres 16 + pgvector
├── Dockerfile                          # Production container
└── .env.example                        # Environment variable reference
```

### Key Files

| File | Purpose | Why It Matters |
|------|---------|----------------|
| `core/src/index.ts` | Brain class | The public API. Everything else is implementation detail. |
| `core/src/schema.sql` | Database schema | Defines entities, facts, episodes, aliases, ACLs, audit log, canonical clusters, skill promotions, and indexes. |
| `core/src/extraction/index.ts` | Pipeline orchestrator | The LLM-first extraction flow. Controls the merge strategy between deterministic and LLM results. |
| `core/src/extraction/llm.ts` | LLM extractor | The extraction prompt and response parsing. This is where extraction quality lives. |
| `core/src/extraction/resolver.ts` | Resolution | Type-aware entity dedup, inline ambiguity reporting, and relation-cardinality contradiction detection. |
| `core/src/search/index.ts` | Hybrid search | Three-tier search, method routing, RRF fusion, and recency boost. |
| `core/src/answer/synthesis.ts` | Answer synthesis | First-party grounded answers with citations, source-context expansion, separated inference, and optional eval traces. |
| `core/src/security.ts` | Security | Visibility policies, source ACL mapping, permission simulation, SQL filters. |
| `core/src/graph/clustering.ts` | Canonicalization | Graph-level entity/relation cluster proposals. |
| `core/src/eval/harness.ts` | Evaluation | Multi-domain fixture runner and scoring. |
| `core/src/skills/evolution.ts` | Skill evolution | Draft/validate/promote skills from improvement proposals. |
| `core/src/skills/defaults.ts` | Built-in skills | The 7 SOPs that teach agents how to use the brain. |
| `server/src/mcp.ts` | MCP server | How AI editors (Claude Code, Cursor) connect to the brain. |

---

## Comparison

| Feature | Company Brain | gbrain | Graphiti/Zep | Supermemory |
|---------|:---:|:---:|:---:|:---:|
| Temporal facts (valid_at/invalid_at) | Yes | No (append-only) | Yes | Partial |
| LLM-first extraction | Yes | No (regex-only) | Yes | Yes |
| Structured data pre-scan | Yes | Yes | No | No |
| Graph-aware extraction | Yes | No | Yes | No |
| Custom entity/relation types | Yes | Fixed | Yes (Pydantic) | No |
| Hybrid search (vector+keyword+graph) | Yes | Yes | Yes | Partial |
| Point-in-time queries | Yes | No | Yes | No |
| Contradiction detection | Yes | No | Yes | Partial |
| Postgres-only (no Neo4j) | Yes | Yes | No (Neo4j) | N/A (SaaS) |
| MCP server | Yes | Yes | No | No |
| REST API | Yes | No | No | Yes (SaaS) |
| Skill/SOP system | Yes | Yes | No | No |
| Automatic skill promotion | Yes | No | No | No |
| Connectors (Nango, filesystem, custom REST) | Yes | No | No | Partial |
| Source permission inheritance | Yes | No | Partial | Yes |
| DB-backed eval harness | Yes, with pressure corpus | No | No | Unknown |
| Grounded answer tool | Yes | No | Partial | Partial |
| Multi-tenant (group isolation) | Yes | No (personal) | No | Yes (SaaS) |
| Open source | MIT | MIT | Apache 2.0 | Partial |

---

## Coming Soon

- **Production hardening:** schema migrations, hosted deployment templates, auth provider integration, admin UI, metrics dashboards, backup/restore runbooks, and longer soak tests on customer-scale corpora.
- **Production-scale compaction:** automatic summary condensation and relevance decay for very large, long-lived corpora.
- **LLM-assisted skill routing:** the skill resolver still uses trigger phrases today. The next step is to let an LLM choose from the available skill routing table with evidence and confidence, while keeping trigger phrases as cheap hints rather than the source of truth.
- **Persistent community index:** community search now uses embedding similarity plus graph salience at query time. Persisting community embeddings/summaries in Postgres will make global/theme retrieval faster and easier to inspect.
- **More customer-shaped eval corpora:** keep expanding messy source-specific gold datasets for Slack-style threads, call transcripts, CRM records, support tickets, analytics streams, and agent traces.
- **Proactive memory digests:** move beyond prompt-driven answers by surfacing role-aware decisions, risks, commitments, and workflow changes before someone asks.

---

## Testing

```bash
# Unit and integration test suite
npm test

# Integration tests use Postgres when available.
# For local Postgres:
createdb company_brain 2>/dev/null || true
export DATABASE_URL=postgresql://localhost:5432/company_brain
psql "$DATABASE_URL" -f packages/core/src/schema.sql
npm test

# Public launch smoke: mixed interactions, docs, Figma-style notes, ACLs, and no-answer cases
npm run build
node tests/operating-memory-suite.mjs

# Bigger noisy pressure test
npx tsx tests/messy-noise-suite.ts

# Verbose SDK walkthrough
npx tsx tests/demo.ts
```

The test suite covers:
- **Extraction** (15 tests): structural pre-scan, known entity matching, confidence assessment, and LLM-first fallback behavior.
- **Skills** (13 tests): resolver matching for all 7 skills, custom skill registration, routing table generation, always-on skill detection.
- **Skill loader** (17 tests): frontmatter parsing, directory loading, save/load round-trip, resolver integration, user overrides.
- **Skill evolution** (1 test): proposal-to-skill drafting and validation.
- **Connectors** (14 tests): AbstractConnector validation, FilesystemConnector file discovery, incremental sync, extension filtering.
- **Nango** (41 tests): config validation, content mapping, pagination, date extraction, metadata extraction, sync end-to-end.
- **Configurable connectors** (31 tests): definition validation, auth types, template interpolation, pagination modes, since params, directory loading.
- **Three-tier search** (32 tests): routing, decomposition, graph traversal helpers, PageRank, communities, RRF.
- **Search** (4 tests): cosine similarity correctness.
- **Eval harness** (5 tests): fixture scoring, multi-domain baselines, pressure corpus coverage, answer citation scoring, permission-sensitive expectations.
- **Organizational memory** (1 test): universal memory object derivation, owner/action preservation, literal value preservation.
- **Answer synthesis** (1 test): grounded answer generation, citations, and answerability gating.
- **Triage** (3 tests): LLM-first keep/drop/ephemeral decisions and fail-closed behavior.
- **Graph canonicalization** (3 tests): auto-apply, inline ambiguity, and telemetry-only policy behavior.
- **Security/normalization** (7 tests): secure public-only defaults, source ACL simulation, Slack metadata rendering, and classification-label safety.
- **Integration** (7 tests): full pipeline (ingest, extract, resolve, search), contradiction detection, temporal queries, extraction stats.
- **Live pressure suites**: `tests/operating-memory-suite.mjs` is the recommended public demo for operating knowledge across interactions, docs, Figma-style notes, runbooks, ACLs, and no-answer behavior. `tests/messy-noise-suite.ts` is a larger noisy ingestion pressure test. `tests/demo.ts` is a verbose SDK walkthrough.

---

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | | PostgreSQL connection string |
| `OPENAI_API_KEY` | For search + default LLM | | Embeddings (`text-embedding-3-large`) and OpenAI-first extraction/triage |
| `ANTHROPIC_API_KEY` | Optional | | Anthropic fallback or explicit Anthropic model configuration |
| `BRAIN_AUTH_TOKEN` | No | | REST API bearer token |
| `BRAIN_GROUP_ID` | No | `default` | Default workspace/tenant |
| `BRAIN_REST_PORT` | No | `3333` | REST API port |
| `BRAIN_REST_HOST` | No | `127.0.0.1` | REST API bind address |
| `BRAIN_SKILLS_DIR` | No | `~/.company-brain/skills` | Directory for user skill files |
| `BRAIN_CONNECTORS_DIR` | No | `~/.company-brain/connectors` | Directory for custom connector JSON definitions |
| `BRAIN_WEBHOOKS_DIR` | No | `~/.company-brain/webhooks` | Directory for webhook source configs |

## Requirements

- Node.js 18+
- PostgreSQL 16+ with [pgvector](https://github.com/pgvector/pgvector) and [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html)
- OpenAI API key (for embeddings)
- Anthropic or OpenAI API key (for LLM extraction)

## Built By

Company Brain is built by [Merge Labs](https://www.mergelabs.co/), an AI agency that helps companies implement AI and develops AI technology for teams that want to move faster. Merge Labs is one of the top 141 OpenAI companies by usage globally, and also incubates and scales SaaS products for fun, including products used by millions of people.

If your company wants help implementing Company Brain or adapting it to your internal systems, reach out to Cael at [cael@mergelabs.co](mailto:cael@mergelabs.co).

Cael

## License

MIT
