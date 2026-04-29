# Company Brain

**Open-source temporal knowledge graph engine for AI agents and knowledge workers.**

Company Brain turns unstructured text into a searchable, temporal knowledge graph. Feed it meeting transcripts, Slack messages, Notion pages, CRM notes, design files, Linear tickets, emails, call recordings, or anything else your team produces. It extracts entities and relationships, wires them into a graph, detects contradictions over time, and makes everything searchable through hybrid retrieval.

Built by studying what works and what doesn't in three systems: [gbrain](https://github.com/garrytan/gbrain) (deterministic extraction, skill-based agents), [Graphiti/Zep](https://github.com/getzep/graphiti) (temporal fact model, contradiction detection), and [Supermemory](https://github.com/supermemoryai/supermemory) (simple API, profile synthesis). Company Brain takes the best architectural decisions from each and combines them into a single Postgres-native engine.

## The Problem

AI solved coding first because all the context already lives in one place: the git repo. Knowledge work is the opposite. Context is scattered across dozens of tools, stored in dozens of formats, and there is no unit test to tell you if your output is correct.

Building an enterprise brain means solving four problems at once.

### 1. Distributed

Your data lives in Slack, Notion, HubSpot, Figma, Linear, Granola, Google Docs, email, and whatever else your team adopted last quarter. None of these systems talk to each other.

**Status: solved.** The connector framework normalizes any source into timestamped episodes. Built-in connectors handle Slack, Notion, and the filesystem. New connectors (Figma, HubSpot, Linear, etc.) are one class implementing `sync()`. Incremental sync is native.

### 2. Unstructured

Raw transcripts, documents, and messages need to become structured knowledge: who, what, when, and how things relate. The brain has to self-organize into a schema that works for your specific business.

**Status: solved.** LLM-first extraction reads raw text and outputs typed entities, relationships, temporal metadata, and confidence scores. The schema is configurable per workspace with custom entity types and relation types. Entity resolution (trigram similarity + alias table) deduplicates the same person or company across sources automatically.

### 3. Unverifiable

Code either passes the test or it doesn't. Knowledge work is subjective. There is no unit test for "is this a good insight?"

**Status: partial.** Every fact has a confidence score, traces back to its source text, and carries temporal history so you can see what changed and when. Extraction logging tracks every operation for human review. What is missing: user feedback loops where a human corrects an extraction and the system learns from it. This is an open problem.

### 4. Compaction

As the corpus grows, so does noise. Without cleanup, you end up searching for needles in a haystack of stale, redundant, or low-value facts.

**Status: partial.** Temporal invalidation replaces stale facts (VP becomes CRO, old fact gets marked superseded). Queries return only current facts by default. Entity resolution prevents duplicate nodes. Recency boost in search favors recent information. What is missing: automatic summary condensation, relevance decay for unreferenced facts, and corpus-wide cleanup jobs.

## Quick Start

```bash
# 1. Start Postgres with pgvector
docker compose up -d

# 2. Install dependencies
npm install

# 3. Set environment variables
export DATABASE_URL=postgresql://brain:brain@localhost:5432/company_brain
export OPENAI_API_KEY=sk-...          # for embeddings
export ANTHROPIC_API_KEY=sk-ant-...   # for LLM extraction

# 4. Run the demo
npx tsx tests/demo.ts

# 5. Or start the REST API
npx company-brain --rest
```

## Usage

### TypeScript SDK

```typescript
import { Brain } from '@company-brain/core';

const brain = new Brain({
  database: 'postgresql://brain:brain@localhost:5432/company_brain',
  embedding: { provider: 'openai' },
  llm: { provider: 'anthropic' },
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

Exposes 6 tools: `ingest`, `search`, `get_entity`, `find_entity`, `get_facts`, `extraction_stats`.

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

Full endpoint list: `POST /api/ingest`, `POST /api/search`, `GET /api/entities/:id`, `GET /api/entities/find/:name`, `GET /api/facts/:sourceId`, `POST /api/schema`, `GET /api/stats`, `GET /api/stats/patterns`, `GET /api/health`.

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
│  Raw Text ──▶ Episode (immutable provenance)                │
│      │                                                      │
│      ├──▶ Deterministic Pre-scan                            │
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
│                     Hybrid Search                           │
│                                                             │
│  1. Semantic  (pgvector HNSW cosine on embeddings)          │
│  2. Keyword   (tsvector full-text with websearch_to_tsquery)│
│  3. Graph     (BFS from seed entities, 1-hop traversal)     │
│  4. Temporal  (point-in-time filtering via valid_at window) │
│     ──▶ Reciprocal Rank Fusion (k=60) ──▶ Recency Boost    │
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

**Episodes** are raw data: the meeting transcript, the Slack message, the document. They are immutable and timestamped. This is your audit trail. Every fact traces back to an episode.

**Entities** are the nodes: people, companies, projects, decisions, concepts. Each entity has a name, type, summary (auto-maintained from facts), attributes (JSONB), and a vector embedding for semantic search. Entity deduplication uses trigram similarity (`pg_trgm`) plus an alias table that maps surface forms ("Bob", "Robert Smith", "bob@acme.com") to the canonical entity.

**Facts** are the edges: temporal relationships between entities. This is the core innovation. A fact has:

| Field | Purpose |
|-------|---------|
| `source_entity_id` / `target_entity_id` | The two entities this fact connects |
| `relation` | Typed relationship (works_at, founded, decided, etc.) |
| `fact_text` | Natural language description ("Alice is CRO at Acme Corp") |
| `valid_at` | When this fact became true |
| `invalid_at` | When this fact was superseded (NULL = still true) |
| `confidence` | 0.0-1.0 extraction confidence |
| `source_episode_id` | Provenance: which raw data produced this fact |
| `fact_embedding` | Vector for semantic search |

When new information contradicts an existing fact, the old fact's `invalid_at` is set. It is never deleted. This is the **bi-temporal model** from Graphiti/Zep, and it is what lets you ask "what did we know about Alice on March 1st?" and get a different answer than "what do we know about Alice now?"

### The Schema

```sql
-- Entities: nodes in the graph
entities (
  id UUID, group_id TEXT, entity_type TEXT, name TEXT,
  summary TEXT, attributes JSONB, name_embedding vector(1536)
)

-- Facts: temporal edges
facts (
  id UUID, group_id TEXT,
  source_entity_id UUID, target_entity_id UUID,
  relation TEXT, fact_text TEXT, fact_embedding vector(1536),
  valid_at TIMESTAMPTZ, invalid_at TIMESTAMPTZ,
  confidence FLOAT, source_episode_id UUID
)

-- Episodes: raw provenance
episodes (
  id UUID, group_id TEXT, source_type TEXT, source_id TEXT,
  content TEXT, content_embedding vector(1536),
  valid_at TIMESTAMPTZ
)

-- Aliases: entity deduplication
entity_aliases (entity_id UUID, alias TEXT, alias_type TEXT)
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

**Step 1: Deterministic pre-scan.** Fast regex pass (~1ms) catches:
- Email addresses, which become person entities with `{ email }` attribute
- @mentions, which become person entities with `{ handle }` attribute
- Known entity matching: any entity name already in the graph (via alias table) gets flagged at 0.95 confidence

This is not the extraction engine. This is a metadata supplement.

**Step 2: LLM extraction.** The content is sent to Claude (Sonnet) or GPT with a structured output prompt. The prompt includes:
- Entity type definitions and relationship types
- Confidence calibration guidelines (0.95 for explicit, 0.8 for implied, 0.6 for inferred)
- **Existing graph context**: facts about known entities mentioned in the text, so the LLM can detect changes ("Alice was VP, now the text says CRO" means this is a role change, not a duplicate)

The LLM returns structured JSON with entities, facts, temporal information, and per-item confidence scores.

**Step 3: Merge.** LLM results are the authority. Deterministic results add structured attributes (email addresses, handles) to matching LLM entities. If the deterministic scan found something the LLM missed entirely (rare), it gets appended.

**Step 4: Resolution.** Each extracted entity is resolved against the existing graph:
1. Exact alias match (alias table, instant)
2. Trigram similarity match (pg_trgm, `similarity() > 0.7`)
3. No match: create new entity and register alias

Each extracted fact is checked for contradictions:
- Same source/target/relation, same text: **skip** (duplicate)
- Same source/target, exclusive relation (works_at, founded), different text: **invalidate old fact**, create new one
- Same source/target, non-exclusive relation: **create alongside** existing

**Step 5: Logging.** Every extraction is logged to `extraction_log` with method, entities/facts extracted, confidence, and duration. This powers the observability system.

### Fallback Mode

When no LLM API key is configured, the system falls back to deterministic-only extraction. This is useful for testing and development. The deterministic layer catches enough structured data to be functional, but it will miss nuanced relationships.

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

Search uses four retrieval methods run in parallel, then fused via Reciprocal Rank Fusion.

### Why Four Methods

No single retrieval method works for everything:

| Query | Best Method | Why |
|-------|-------------|-----|
| "enterprise SaaS deals" | Semantic | Conceptual similarity, not exact keywords |
| "alice@acme.com" | Keyword | Exact string match, no semantic meaning |
| "What's connected to Acme?" | Graph | Follow edges from a known entity |
| "What did we know in March?" | Temporal | Filter by validity window |

Running all four and fusing results means no query type falls through the cracks.

### How Each Method Works

**Semantic search** embeds the query via OpenAI `text-embedding-3-large` (1536 dimensions), then uses pgvector's HNSW index to find entities and facts with high cosine similarity. Threshold: 0.3 similarity minimum.

**Keyword search** uses PostgreSQL's built-in `tsvector` full-text search with `websearch_to_tsquery` (supports natural language queries, not just exact terms). Searches both entity name+summary and fact_text. Score is `ts_rank` weighted by fact confidence.

**Graph search** first finds "seed entities" that match the query (via fuzzy name matching or full-text), then traverses outward via BFS through connected facts. Returns facts 1 hop away from the seed entities, scored by confidence with a 0.9 discount (slightly lower than direct matches).

**Temporal filtering** is applied post-fusion. If `asOf` is set, facts are filtered to only those valid at that point in time (`valid_at <= asOf AND (invalid_at IS NULL OR invalid_at > asOf)`).

### Reciprocal Rank Fusion

RRF is how we combine ranked results from different retrieval methods without needing to normalize their scores (which are on incompatible scales: cosine similarity vs. BM25 rank vs. graph distance).

For each result appearing in any list at rank `r`, its RRF score is: `1 / (k + r)` where `k = 60`. If a result appears in multiple lists, its scores are summed. This naturally boosts results that appear across multiple retrieval methods (high agreement = high relevance).

After fusion, a **recency boost** applies a logarithmic decay: `score *= 1 + 0.1 * max(0, 1 - log(ageInDays + 1) / log(365))`. Recent facts get a small bump; old facts are not penalized much. This means "Alice is CRO at Acme" (1 week old) scores slightly higher than "Alice joined Acme" (2 years old), which matches how knowledge workers think about relevance.

---

## The Skill System

Skills are markdown SOPs (Standard Operating Procedures) that teach AI agents HOW to use the brain. This is the pattern from gbrain: intelligence lives in the skill files, not in hardcoded logic.

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
| `extraction-review` | On-demand | Review extraction stats. Evaluate pattern suggestions. Target >70% deterministic rate. |

### The Resolver

The `SkillResolver` matches user intent to the right skill using two-phase matching:

1. **Deterministic**: exact trigger match (1.0 confidence), then substring match (0.8-0.95), then keyword overlap (up to 0.7)
2. **Priority tiebreaking**: when confidence is equal, higher-priority skills win

The resolver also generates a markdown routing table (`resolver.toRoutingTable()`) that can be injected into an LLM's system prompt, giving it a menu of available operations.

### Custom Skills

Register your own skills:

```typescript
import { SkillResolver } from '@company-brain/core';

const resolver = new SkillResolver();
resolver.register({
  id: 'deal-tracker',
  name: 'Track Deal',
  description: 'Track a sales deal through the pipeline',
  triggers: ['track deal', 'deal update', 'pipeline status'],
  content: `# Deal Tracker\n\n## Protocol\n1. Search for the deal entity...\n2. ...`,
  priority: 75,
});
```

---

## Connectors

Connectors pull data from external sources, normalize it into episodes, and feed it through the extraction pipeline. Each connector implements:

```typescript
interface Connector {
  id: string;
  name: string;
  init(config: Record<string, unknown>): Promise<void>;
  sync(options?: SyncOptions): Promise<EpisodeInput[]>;
  handleWebhook?(payload: unknown): Promise<EpisodeInput[]>;
}
```

### Built-in Connectors

**Filesystem.** Watches a directory of markdown/text files. Incremental sync via file modification time. Useful for wikis, knowledge bases, and local documentation.

```typescript
import { Brain, ConnectorRegistry, FilesystemConnector } from '@company-brain/core';

const brain = new Brain(config);
const registry = new ConnectorRegistry(brain);
registry.register(new FilesystemConnector());

await registry.connect({
  id: 'docs', type: 'filesystem',
  config: { rootDir: './docs' },
});

await registry.sync('docs'); // ingests all .md files
```

**Slack.** Fetches messages from channels via `conversations.history` API. Supports both polling (sync) and push (Events API webhooks). Requires `channels:history` and `channels:read` scopes.

**Notion.** Fetches pages from databases via Notion API. Converts block structure to markdown for extraction. Supports incremental sync via `last_edited_time`.

### Adding Your Own Connectors

The connector interface is designed to be extended. A Figma connector would fetch design file metadata and comments. A HubSpot connector would pull deal records and contact notes. A Linear connector would sync issue descriptions and comments. A Google Docs connector would pull document content. Each one normalizes its data into `EpisodeInput[]` and the rest of the pipeline (extraction, resolution, search indexing) happens automatically.

The `ConnectorRegistry` orchestrates sync operations, handles errors per-episode (one failure does not block others), and supports `syncAll()` for batch operations.

---

## Observability

Every extraction is logged to the `extraction_log` table:

```typescript
const stats = await brain.getExtractionStats();
// {
//   totalExtractions: 847,
//   deterministicHits: 0,     // in LLM-first mode, these are rare
//   llmFallbacks: 0,
//   deterministicRate: 0,
//   topMissPatterns: [...]
// }
```

The `suggestPatterns()` function analyzes successful LLM extractions to find recurring patterns that could be added as deterministic pre-scan rules:

```typescript
const patterns = await brain.getSuggestedPatterns(5);
// [{ entityType: 'company', suggestedPattern: '/acquired ([A-Z][\w\s]+)/g',
//    examples: ['Acme Corp', 'BigTech Inc'], occurrences: 12 }]
```

This is the **fail-improve loop** from gbrain. The system identifies what the LLM handles repeatedly and suggests deterministic shortcuts a developer can review and approve.

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

The contradiction detection happens during resolution: for **exclusive relations** (works_at, founded, where a person can only work at one company at a time), a new fact with the same relation type automatically invalidates the old one. For **non-exclusive relations** (mentions, related_to), new facts are added alongside existing ones.

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
│   │   │   ├── extraction/
│   │   │   │   ├── index.ts            # Pipeline orchestrator (LLM-first)
│   │   │   │   ├── deterministic.ts    # Pre-scan: regex for emails, mentions, roles
│   │   │   │   ├── llm.ts             # Primary extractor: Claude/GPT structured output
│   │   │   │   ├── resolver.ts         # Entity dedup + fact contradiction detection
│   │   │   │   └── fail-improve.ts     # Extraction logging + pattern suggestion
│   │   │   ├── search/
│   │   │   │   └── index.ts            # Hybrid search: semantic+keyword+graph+temporal
│   │   │   ├── skills/
│   │   │   │   ├── types.ts            # Skill, SkillMatch, ResolverConfig
│   │   │   │   ├── resolver.ts         # Intent to skill matching
│   │   │   │   ├── defaults.ts         # 7 built-in skills (SOPs)
│   │   │   │   └── index.ts
│   │   │   └── connectors/
│   │   │       ├── types.ts            # Connector, SyncOptions, SyncResult
│   │   │       ├── registry.ts         # ConnectorRegistry orchestration
│   │   │       ├── filesystem.ts       # Markdown/text file connector
│   │   │       ├── slack.ts            # Slack messages + Events API
│   │   │       ├── notion.ts           # Notion pages + databases
│   │   │       └── index.ts
│   │   ├── tests/
│   │   │   ├── extraction.test.ts      # 12 unit tests (no DB)
│   │   │   ├── skills.test.ts          # 13 unit tests (no DB)
│   │   │   ├── search.test.ts          # 4 unit tests (no DB)
│   │   │   └── integration.test.ts     # 7 integration tests (needs Postgres)
│   │   └── package.json
│   └── server/                          # MCP + REST interfaces
│       ├── src/
│       │   ├── index.ts                # CLI entry: --mcp, --rest, --port
│       │   ├── mcp.ts                  # 6 MCP tools via stdio transport
│       │   └── rest.ts                 # REST API with bearer auth + CORS
│       └── package.json
├── tests/
│   └── demo.ts                         # Verbose walkthrough with colored logging
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
| `core/src/schema.sql` | Database schema | Defines the data model: entities, facts, episodes, aliases, extraction_log. All indexes. |
| `core/src/extraction/index.ts` | Pipeline orchestrator | The LLM-first extraction flow. Controls the merge strategy between deterministic and LLM results. |
| `core/src/extraction/llm.ts` | LLM extractor | The extraction prompt and response parsing. This is where extraction quality lives. |
| `core/src/extraction/resolver.ts` | Resolution | Entity dedup (trigram + aliases) and fact contradiction detection (exclusive relations). |
| `core/src/search/index.ts` | Hybrid search | Four retrieval methods + RRF fusion + recency boost. |
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
| Connectors (Slack, Notion, etc.) | Yes | No | No | Partial |
| Multi-tenant (group isolation) | Yes | No (personal) | No | Yes (SaaS) |
| Open source | MIT | MIT | Apache 2.0 | Partial |

---

## Testing

```bash
# Unit tests (no database needed): 33 tests
npm test

# Integration tests (needs Postgres)
docker compose up -d
npm test

# Verbose demo with colored logging
npx tsx tests/demo.ts
```

The test suite covers:
- **Extraction**: entity extraction from emails, @mentions, role patterns, known entities, custom hints. Fact extraction from role patterns, decisions. Confidence assessment heuristics.
- **Skills**: resolver matching for all 7 skills, custom skill registration, routing table generation, always-on skill detection.
- **Search**: cosine similarity correctness.
- **Integration**: full pipeline (ingest, extract, resolve, search), contradiction detection, temporal queries, extraction stats.

---

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | | PostgreSQL connection string |
| `OPENAI_API_KEY` | For search | | Embeddings (text-embedding-3-large) |
| `ANTHROPIC_API_KEY` | For extraction | | LLM extraction (Claude Sonnet) |
| `BRAIN_AUTH_TOKEN` | No | | REST API bearer token |
| `BRAIN_GROUP_ID` | No | `default` | Default workspace/tenant |
| `BRAIN_REST_PORT` | No | `3333` | REST API port |
| `BRAIN_REST_HOST` | No | `127.0.0.1` | REST API bind address |

## Requirements

- Node.js 18+
- PostgreSQL 16+ with [pgvector](https://github.com/pgvector/pgvector) and [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html)
- OpenAI API key (for embeddings)
- Anthropic or OpenAI API key (for LLM extraction)

## License

MIT
