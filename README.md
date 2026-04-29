# Company Brain

**Open-source temporal knowledge graph engine for AI agents and knowledge workers.**

Company Brain extracts entities and relationships from unstructured data, stores them as a bi-temporal knowledge graph, and makes them searchable via hybrid retrieval. It combines the best patterns from systems like [gbrain](https://github.com/garrytan/gbrain), [Graphiti/Zep](https://github.com/getzep/graphiti), and [Supermemory](https://github.com/supermemoryai/supermemory):

- **LLM-first extraction** - reliable, context-aware entity and relationship extraction with structured output. Deterministic pre-scan catches emails, @mentions, and URLs
- **Bi-temporal fact model** - facts are invalidated, not deleted, so you can query "what did we know on March 1st?"
- **Graph-aware** - the LLM receives existing graph context during extraction, so it detects changes and avoids duplicates
- **Hybrid search** - vector + keyword + graph traversal, fused via Reciprocal Rank Fusion
- **Postgres-native** - single database, no Neo4j/Redis/Pinecone. Just Postgres + pgvector

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Ingestion                            │
│  Raw Text → Episode (provenance) → Extraction Pipeline      │
│                                                             │
│  Step 1: Deterministic pre-scan (emails, @mentions, URLs)   │
│  Step 2: LLM extraction       (primary — entities + facts)  │
│  Step 3: Merge                (LLM + structured data)       │
│  Step 4: Resolution           (dedup, contradiction)        │
│  Step 5: Logging              (observability)               │
├─────────────────────────────────────────────────────────────┤
│                    Knowledge Graph                          │
│                                                             │
│  Entities ──facts──▶ Entities                               │
│  (nodes)   (temporal   (nodes)                              │
│             edges)                                          │
│                                                             │
│  Facts have: valid_at, invalid_at, confidence, provenance   │
│  Entities have: name, type, summary, attributes, aliases    │
├─────────────────────────────────────────────────────────────┤
│                     Hybrid Search                           │
│                                                             │
│  Semantic (pgvector cosine) + Keyword (tsvector BM25)       │
│  + Graph (BFS traversal) + Temporal (point-in-time)         │
│  → Reciprocal Rank Fusion → Recency Boost → Results        │
├─────────────────────────────────────────────────────────────┤
│                      Interfaces                             │
│                                                             │
│  MCP Server (stdio)  │  REST API (HTTP)  │  TypeScript SDK  │
│  Claude Code, Cursor  │  Web apps, bots   │  Direct import   │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Start Postgres with pgvector
docker compose up -d

# 2. Install dependencies
npm install

# 3. Set environment variables
export DATABASE_URL=postgresql://brain:brain@localhost:5432/company_brain
export OPENAI_API_KEY=sk-...          # for embeddings
export ANTHROPIC_API_KEY=sk-ant-...   # for LLM extraction (optional)

# 4. Start the REST API
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

// Ingest content — entities and facts are extracted automatically
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

// Point-in-time queries
const marchState = await brain.search({
  query: 'Acme plan',
  asOf: new Date('2024-03-01'),
});

// Find entities by name (fuzzy)
const alice = await brain.findEntity('Alice');

// Get entity with all connections
const entity = await brain.getEntity(alice.id, {
  includeFacts: true,
  includeRelated: true,
});

// Track how extraction is improving
const stats = await brain.getExtractionStats();
console.log(`Deterministic rate: ${(stats.deterministicRate * 100).toFixed(1)}%`);
```

### MCP Server (Claude Code / Cursor)

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "company-brain": {
      "command": "npx",
      "args": ["company-brain", "--mcp"],
      "env": {
        "DATABASE_URL": "postgresql://brain:brain@localhost:5432/company_brain",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Then in your AI editor:

```
> Search the brain for "Acme Corp deal status"
> Ingest this meeting transcript: ...
> What do we know about Alice Chen?
> Show extraction stats
```

### REST API

```bash
# Start the server
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

# Health check
curl http://localhost:3333/api/health
```

## How It Works

### The Extraction Pipeline

When you call `brain.ingest()`, content goes through an LLM-first pipeline:

1. **Deterministic pre-scan** - Catches structured data the LLM might miss: email addresses, @mentions, URLs, and matches against known entities already in the graph. This supplements the LLM, not replaces it.

2. **LLM extraction (primary)** - The main extraction engine. Uses Claude or GPT with a structured output prompt to extract entities, relationships, and temporal information. The LLM receives existing graph context so it can detect changes and avoid duplicates. Handles paraphrase, implicit relationships, and nuanced context that regex never could.

3. **Merge** - Combines LLM results with deterministic pre-scan. LLM is the authority for entities and relationships; deterministic adds structured metadata (emails, handles) that the LLM might skip.

4. **Resolution** - Extracted entities are deduplicated against existing ones (trigram similarity + alias matching). Facts are checked for contradictions — if Alice "works at Acme" but we already have "Alice works at BigCorp", the old fact is invalidated (not deleted) and the new one is created.

If no LLM API key is configured, the system falls back to deterministic-only mode (useful for testing).

### Observability

Every extraction is logged with its method, duration, and results:

```typescript
const stats = await brain.getExtractionStats();
// { totalExtractions: 142, deterministicHits: 0, llmFallbacks: 0,
//   deterministicRate: 0, topMissPatterns: [...] }
```

### Temporal Queries

Facts have `valid_at` and `invalid_at` timestamps. When a fact is contradicted, the old fact's `invalid_at` is set — it's not deleted. This lets you:

- Query the graph as it existed at any point in time
- See the full timeline of an entity's changes
- Track when information was learned vs. when it was true

### Custom Ontology

Define your own entity types and relation types:

```typescript
await brain.defineSchema({
  entityTypes: [
    { id: 'deal', label: 'Deal', description: 'A sales deal or opportunity' },
    { id: 'feature', label: 'Feature', description: 'A product feature' },
  ],
  relationTypes: [
    { id: 'requested', label: 'Requested', sourceTypes: ['person'], targetTypes: ['feature'] },
    { id: 'blocked_by', label: 'Blocked By', sourceTypes: ['deal'], targetTypes: ['feature'] },
  ],
});
```

## Project Structure

```
company-brain/
├── packages/
│   ├── core/                  # The engine
│   │   ├── src/
│   │   │   ├── index.ts       # Brain class (public API)
│   │   │   ├── types.ts       # All TypeScript interfaces
│   │   │   ├── schema.sql     # Postgres schema (pgvector + temporal)
│   │   │   ├── db.ts          # Connection management
│   │   │   ├── embedding.ts   # OpenAI embeddings
│   │   │   ├── extraction/
│   │   │   │   ├── deterministic.ts  # Layer 1: regex + patterns
│   │   │   │   ├── llm.ts            # Layer 2: LLM fallback
│   │   │   │   ├── resolver.ts       # Layer 3: dedup + contradictions
│   │   │   │   ├── fail-improve.ts   # Self-improvement loop
│   │   │   │   └── index.ts          # Pipeline orchestrator
│   │   │   └── search/
│   │   │       └── index.ts   # Hybrid search (semantic + keyword + graph)
│   │   └── package.json
│   └── server/                # MCP + REST interfaces
│       ├── src/
│       │   ├── index.ts       # CLI entry point
│       │   ├── mcp.ts         # MCP server (stdio)
│       │   └── rest.ts        # REST API (HTTP)
│       └── package.json
├── docker-compose.yml         # Postgres + pgvector
└── package.json               # Monorepo root
```

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
| Open source | Yes | Yes | Yes | Partial |
| Multi-tenant | Yes | No (personal) | No | Yes (SaaS) |

## Requirements

- Node.js 18+
- PostgreSQL 16+ with [pgvector](https://github.com/pgvector/pgvector) and [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html)
- OpenAI API key (for embeddings)
- Anthropic or OpenAI API key (for LLM extraction fallback, optional)

## License

MIT
