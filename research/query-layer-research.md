# Query Layer Research: Natural Language to Structured Graph Queries

## Research Date: 2026-04-29

This document covers modern approaches to decomposing complex natural language questions into structured graph queries and multi-step retrieval plans, specifically for building a query layer on top of a temporal knowledge graph for business data.

---

## 1. Query Decomposition Patterns

### How It Works

```
User Question (complex, multi-part)
        |
        v
+-------------------+
| LLM Decomposer    |  "Break this into sub-questions"
+-------------------+
        |
        v
+-------------------+
| Sub-Question List  |
| - Q1 (entity)     |
| - Q2 (temporal)   |
| - Q3 (aggregate)  |
+-------------------+
        |
   [parallel or sequential]
        |
   v         v         v
+------+  +------+  +------+
| Ret1 |  | Ret2 |  | Ret3 |   (different retrievers per sub-question)
+------+  +------+  +------+
        \    |    /
         v   v   v
   +------------------+
   | Synthesis LLM    |  Combine partial answers
   +------------------+
        |
        v
   Final Answer
```

### Key Implementations

**LangChain Query Decomposition** uses Pydantic structured output to generate sub-queries:
- System prompt instructs the LLM to decompose into "the most specific sub questions you can"
- Each sub-question maps to a concept/fact/idea
- Uses `PydanticToolsParser` with `ChatOpenAI` to produce structured sub-query lists
- Sub-queries can include a `sub_queries` field for recursive decomposition
- `MultiQueryRetriever` automates the multi-query workflow

**LlamaIndex Sub-Question Query Engine** combines:
- Recursive Retrieval with Document Agents
- Sub Question Query Decomposition
- Each sub-question delegated to specialized document agents with tools (vector query, summary query, knowledge graph query)

### When to Use

- Complex multi-part questions: "Which clients have champions who recently changed roles?"
  - Sub Q1: "Who are the champions for each client?" (graph traversal)
  - Sub Q2: "Which of these champions changed roles recently?" (temporal filter)
  - Sub Q3: "What clients do those champions belong to?" (join)
- Questions spanning multiple entity types or data sources
- Questions requiring both factual lookup and aggregation

### Latency & Cost

- Adds one LLM call for decomposition (~200-500ms)
- Each sub-question requires a retrieval step (50-300ms each)
- Sub-questions can run in parallel if independent
- Total: typically 500ms-2s for 2-4 sub-questions
- Risk: LLM may hallucinate during synthesis of sub-answers

### Application to Business KG

A question like "Which deals are at risk because their champion left the company?" decomposes to:
1. Find all active deals (graph query: `MATCH (d:Deal {status: 'active'})`)
2. Find their champions (traversal: `(d)-[:HAS_CHAMPION]->(p:Person)`)
3. Check for role changes (temporal: `WHERE p.role_changed_at > date() - duration('P90D')`)
4. Filter for departures (temporal + attribute: `WHERE p.current_company != d.company`)

---

## 2. ReAct / Chain-of-Thought for Graph Queries

### How It Works

```
User Question
     |
     v
+-----------+     +-----------+
| REASON    |<--->| GRAPH DB  |
| (LLM)     |     | (Neo4j)   |
+-----------+     +-----------+
     |                  ^
     v                  |
+-----------+           |
| INTERACT  |  Generate graph operations
+-----------+           |
     |                  |
     v                  |
+-----------+           |
| EXECUTE   |---------->+
+-----------+
     |
     v
[Loop until answer found or max iterations]
     |
     v
Final Answer
```

### Key Frameworks

**Graph-CoT (ACL 2024)** — State-of-the-art iterative Reasoning-Interaction-Execution framework:
- LLM proposes conclusions from current information and identifies what's needed
- LLM generates graph operations (find nodes, check neighbors)
- Operations execute on external graph; results returned
- Repeat until convergence
- GitHub: `PeterGriffinJin/Graph-CoT`

**Think-on-Graph 2.0 (ICLR 2025)** — Hybrid KG + text retrieval:
- Tight coupling of graph retrieval and context retrieval
- Alternates between graph retrieval and context retrieval
- Training-free, plug-and-play with various LLMs
- 14.6% improvement over ToG 1.0 on HotpotQA

**StepChain GraphRAG** — Iterative CoT + graph:
- Updates KG with each sub-question and partial answer
- Clarifies evidence chain, curbs information overload
- 57.67/68.53 F1/EM on HotpotQA

**Knowledge Graph of Thoughts (KGoT)**:
- Components: Controller, Graph Store, Integrated Tools
- Dynamically constructs task-relevant KGs during reasoning
- Enhanced with external tools (math solvers, web crawlers, Python)
- GitHub: `spcl/knowledge-graph-of-thoughts`

### Scalability Warning

Graph-CoT exceeds **40,000 tokens per query** in complex cases. With GPT-4.5, this costs **>$3 per query**. Multi-agent Graph-CoT frameworks address this by decomposing into classification-reasoning-action modules, but complexity remains high.

### When to Use

- Multi-hop reasoning: "Who introduced us to the VP at Acme who later became our champion on the Series B deal?"
- Exploratory queries where the path through the graph isn't known in advance
- Questions requiring dynamic path discovery

### Application to Business KG

For iterative exploration: Start with a person entity, discover their company relationships, check deal involvement, trace introduction chains. The LLM decides at each step which relationships to follow, enabling open-ended exploration of the business graph.

---

## 3. Text-to-Cypher / Text-to-SPARQL / Text-to-SQL

### How It Works

```
User Question + Graph Schema
          |
          v
  +------------------+
  | LLM (fine-tuned   |
  | or prompted with  |
  | schema + examples)|
  +------------------+
          |
          v
  Cypher/SPARQL/SQL Query
          |
          v
  +------------------+
  | Validate & Fix    |  (regex, CyVer, parser)
  +------------------+
          |
          v
  +------------------+
  | Execute on DB     |
  +------------------+
          |
          v
  Results --> LLM --> Natural Language Answer
```

### Accuracy Benchmarks (2025-2026)

| Query Language | Zero-Shot Best | With Schema | 5-Shot | Fine-Tuned |
|---------------|---------------|-------------|--------|------------|
| SQL           | 47.05%        | ~60%+       | ~65%+  | 80%+       |
| Cypher        | 34.45%        | ~55%+       | ~60%+  | 69-72%     |
| MQL           | 21.55%        | ~40%+       | ~50%+  | —          |
| SPARQL        | 3.3%          | ~5%         | 30%    | —          |

Key findings from SM3-Text-to-Query benchmark (10K pairs across 4 query languages):
- Schema information doubles performance for Cypher and SQL
- Few-shot examples are critical for SPARQL (3.3% -> 30%)
- SQL significantly outperforms all graph query languages
- LLMs have far more SQL training data

### Key Implementations

**Neo4j Text2Cypher Pipeline**:
- Agent gathers graph schema via tool call
- LLM generates Cypher with schema + user input + few-shot examples
- Query validated (regex checks, CyVer library, parser-based correction)
- Self-healing loop: if execution fails, error + query sent back to LLM
- Libraries: Neo4j GraphRAG Python Package, LangChain Neo4j, Neo4j MCP servers
- Fine-tuned model: `neo4j/text2cypher-gemma-2-9b-it-finetuned-2024v1` (HuggingFace)
- Benchmarks: 94% exact match (Cypher QA) vs 72% (Pinecone vector RAG)
- Latency: 150ms end-to-end (80ms Cypher gen, 50ms execution, 20ms synthesis)

**Multi-Agent GraphRAG for Text-to-Cypher** (arXiv Nov 2025):
- Modular agents: subgoal parsing, retrieval, schema grounding, query synthesis, verification
- Improved generalizability and transparency

**Schema Management for Large Graphs**:
- Large schemas overload context and confuse LLMs
- Solution: vector-based similarity search on schema component descriptions
- Or: entity recognition -> find relevant schema nodes -> traverse n-hops for subgraph schema

### When to Use

- Precise, well-structured questions with clear entity types
- Questions that map cleanly to graph patterns
- When your schema is stable and well-documented
- NOT for vague, exploratory, or highly abstract questions

### Application to Business KG

```cypher
// "Which clients have champions who recently changed roles?"
MATCH (c:Company)-[:HAS_DEAL]->(d:Deal)-[:HAS_CHAMPION]->(p:Person)
WHERE p.role_changed_at > datetime() - duration('P90D')
RETURN c.name, p.name, p.current_role, p.previous_role, d.name
```

Provide the schema (Company, Person, Deal nodes; HAS_DEAL, HAS_CHAMPION, WORKS_AT relationships) plus temporal properties to the LLM for accurate generation.

---

## 4. Retrieval Planning Architectures

### How It Works

```
User Question
     |
     v
+-------------------+
| Query Classifier/  |
| Router (LLM)      |
+-------------------+
     |
     |--- Entity/Relationship question --> Graph Traversal (Cypher)
     |--- Semantic/similarity question --> Vector Search (embeddings)
     |--- Analytical question ----------> SQL / Aggregation
     |--- Temporal question ------------> Temporal Graph Query
     |--- Abstract/global question -----> Community Summaries
     |--- Multi-part question ----------> Decompose + Route Each
     |
     v
+-------------------+
| Execute Selected   |
| Strategy           |
+-------------------+
     |
     v
+-------------------+
| Rerank & Synthesize|
+-------------------+
     |
     v
Final Answer
```

### Key Frameworks

**RAGRouter (arXiv May 2025)**:
- Document encoder + cross encoder for document semantics
- Each LLM gets a learnable "RAG capability embedding"
- Accounts for how retrieved content changes model capabilities
- Surpasses best individual LLM performance

**SkewRoute** — Training-free routing for KG RAG:
- Uses score skewness of retrieved contexts for routing decisions
- No training required; works with any LLM
- Published at EMNLP 2025 Findings

**Pre-Route** — Route Before Retrieve:
- Performs structured reasoning before answering using lightweight metadata
- Task analysis, coverage estimation, information-need prediction
- Balances RAG (efficient, retrieval-quality constrained) vs. long-context (expensive, global reasoning)

**KA-RAG ToolPlanner**:
- Unified agent controller (ToolPlanner) recognizes query intent
- Routes to KG (Cypher queries) and/or vector DB (semantic search) in parallel
- Results fused using hybrid scoring mechanism

**Protocol-H** — Hierarchical Supervisor-Worker:
- Supervisor decomposes complex queries
- Workers execute modality-specific tasks (SQL worker, vector worker)
- Reflective retry for error handling
- Dedicated workers outperform general-purpose agents

### Practical Routing Logic

```python
# Simplified routing decision tree
def route_query(query, entities_detected, query_type):
    if query_type == "relationship":
        return "graph_traversal"   # Cypher query
    elif query_type == "similarity":
        return "vector_search"     # Embedding similarity
    elif query_type == "analytical":
        return "sql_aggregation"   # COUNT, SUM, AVG
    elif query_type == "temporal":
        return "temporal_graph"    # Time-windowed graph query
    elif query_type == "global":
        return "community_summary" # Pre-computed summaries
    elif len(entities_detected) > 1:
        return "decompose_and_route"
    else:
        return "hybrid"            # Vector + graph
```

### When to Use

- When you have multiple data stores (graph DB, vector DB, SQL)
- When query types vary widely (some relational, some semantic, some analytical)
- When cost optimization matters (don't use expensive retrieval for simple queries)

### Latency & Cost

- Router classification: ~100-200ms (single LLM call, or classifier model)
- Can use a smaller/cheaper model for routing decisions
- Savings: avoid expensive graph traversals for simple semantic queries
- Bad routing wastes far more compute than the router costs

### Application to Business KG

Route "How is our pipeline looking this quarter?" to community summaries (global/abstract).
Route "Who introduced us to Jane at Acme?" to graph traversal (specific path finding).
Route "Find me companies similar to our best customers" to vector search (semantic similarity).
Route "What's the average deal size for enterprise clients?" to SQL aggregation.

---

## 5. Entity-Centric Retrieval (Zep/Graphiti Architecture)

### How It Works

```
User Question: "What did we discuss with Jane about the Acme deal?"
     |
     v
+---------------------+
| Entity Recognition  |  Extract: Jane (Person), Acme (Company)
+---------------------+
     |
     v
+---------------------+
| Multi-Modal Search  |
| 1. Cosine (phi_cos) |  Embedding similarity on entity names + facts
| 2. BM25 (phi_bm25)  |  Keyword match on node names + fact strings
| 3. BFS (phi_bfs)    |  Graph traversal from matched nodes (n-hops)
+---------------------+
     |
     v
+---------------------+
| Reciprocal Rank     |
| Fusion (RRF)        |  Combine ranked lists from all 3 searches
+---------------------+
     |
     v
+---------------------+
| Rerankers           |
| - Episode mentions  |  Frequency in recent conversations
| - Node distance     |  Proximity to centroid node
| - Cross-encoder     |  Deep relevance scoring
+---------------------+
     |
     v
Context for LLM
```

### Zep/Graphiti Architecture Deep Dive

**Graph Schema**: G = (N, E, phi) with three-tier subgraph hierarchy:

1. **Episode Subgraph**: Raw input data (messages, text, JSON). Non-lossy store from which entities and relations are extracted. Bidirectional indices between episodes and semantic edges.

2. **Semantic Entity Subgraph**: Extracted entities as nodes, facts as edges. Each edge carries:
   - `fact`: natural language description of the relationship
   - `t_valid`, `t_invalid`: when the fact was true (event time T)
   - `t'_created`, `t'_expired`: when the fact entered/left the system (ingestion time T')
   - Embedding vector for semantic search

3. **Community Subgraph**: Entities clustered via dynamic label propagation. Community summaries maintained for higher-level retrieval.

**Temporal (Bi-Temporal) Model**:
- Event Time (T): when a fact actually occurred
- Ingestion Time (T'): when information was observed/added
- Enables: retroactive data handling, corrections, fact supersession
- Facts are invalidated, never deleted — preserving historical accuracy

**Conflict Resolution**:
- New knowledge checked against existing via semantic + keyword + graph search
- Temporal metadata used to update or invalidate (not discard) outdated information
- No large-scale recomputation needed

**Retrieval Performance**:
- P95 latency: **300ms**
- No LLM calls during retrieval (all embedding + BM25 + graph traversal)
- DMR benchmark: 94.8% (vs MemGPT 93.4%)
- LongMemEval: up to 18.5% accuracy improvement, 90% latency reduction vs baselines

**Technology**:
- Neo4j 5.26 / FalkorDB / Kuzu / Neptune backends
- OpenAI default for LLM + embeddings (supports Anthropic, Gemini, Groq, Ollama)
- Python (graphiti-core on PyPI)
- Open-source: `github.com/getzep/graphiti`
- TypeScript port: `github.com/aexy-io/graphzep`
- MCP server available for Claude Desktop, Cursor integration

### When to Use

- Conversational AI with memory across sessions
- Business data that changes over time (people change roles, deals progress)
- Need to track WHEN facts were true, not just what's true now
- Entity-relationship queries with temporal constraints

### Application to Business KG

This is the most directly applicable architecture for a business temporal KG:
- **People** change companies, roles, titles (bi-temporal tracking)
- **Deals** progress through stages (temporal edges)
- **Companies** have evolving relationships (partnerships, acquisitions)
- Query "Who was the champion on the Acme deal when we closed it?" requires temporal graph traversal with validity windows

---

## 6. Summarization Hierarchies

### Microsoft GraphRAG

```
Source Documents
     |
     v (LLM extraction)
Entity Knowledge Graph (nodes = entities, edges = relationships)
     |
     v (Leiden algorithm, hierarchical)
Community Hierarchy
     |
     v (LLM summarization, bottom-up)
+---------------------------+
| Level 2: High-level themes |  "AI initiatives across tech sector"
+---------------------------+
     |
+---------------------------+
| Level 1: Topic clusters    |  "Enterprise AI adoption patterns"
+---------------------------+
     |
+---------------------------+
| Level 0: Fine-grained      |  "Acme Corp's ML platform migration"
+---------------------------+

Query Answering (Map-Reduce):
1. MAP: Each community summary generates a partial answer (parallel)
2. REDUCE: All partial answers combined into final global answer
```

**Key Details**:
- Uses Leiden algorithm (via graspologic library) for hierarchical community detection
- Community summaries generated bottom-up: leaf communities from element summaries, higher levels recursively incorporate lower-level summaries
- Outperforms naive RAG on comprehensiveness (70-80% win rate)
- Root-level community summaries achieve competitive performance at **2-3% token cost** of full source text summarization
- Official implementation: `github.com/microsoft/graphrag`

### RAPTOR (Recursive Abstractive Processing for Tree-Organized Retrieval)

```
Source Documents
     |
     v (chunk)
Text Chunks (leaf nodes)
     |
     v (embed + cluster)
Clusters of Related Chunks
     |
     v (LLM summarize each cluster)
Summary Nodes (level 1)
     |
     v (embed + cluster again)
Higher-Level Clusters
     |
     v (LLM summarize)
Summary Nodes (level 2)
     |
     ... (recursive)
     |
     v
Root Summary Nodes
```

- Builds a tree by clustering embeddings of text chunks, then summarizing clusters
- Each level provides progressively more abstract representations
- Retrieval can enter the tree at any level depending on query specificity
- GitHub: `github.com/parthsarthi03/raptor`

### LightRAG (EMNLP 2025)

Simpler, faster, cheaper alternative to GraphRAG:
- **Dual-Level Retrieval**: low-level (specific entities) + high-level (abstract themes)
- **Incremental Updates**: new documents integrated without full reprocessing
- Outperforms GraphRAG across agriculture, CS, legal, mixed domains
- Supports multimodal via RAG-Anything integration
- GitHub: `github.com/hkuds/lightrag`

### nano-graphrag

Minimal, readable implementation of GraphRAG concepts:
- Clean code, easy to understand
- Three query modes: naive (vector), local (entity relationships), global (community summaries)
- Good starting point for understanding the architecture

### When to Use

- **Global/abstract questions**: "What are the main risks across our portfolio?"
- **Thematic analysis**: "What patterns do we see in our enterprise deals?"
- **Corpus-level summarization**: Questions that can't be answered from any single document
- NOT for specific entity lookups or precise factual queries

### Latency & Cost

- GraphRAG: High upfront cost (many LLM calls for extraction + summarization during indexing)
- Query time: map-reduce over community summaries adds latency
- LightRAG: Significantly lower construction cost, comparable query performance
- Root-level summaries: very fast queries (small context) at the expense of detail

### Application to Business KG

Pre-compute community summaries at multiple levels:
- Level 0: Individual deal/company summaries
- Level 1: Industry/segment clusters ("Enterprise SaaS deals", "Healthcare clients")
- Level 2: Portfolio-wide themes ("Overall pipeline health", "Key risk factors")

Query "How is our enterprise pipeline looking?" hits Level 1 summaries. "What are the biggest risks across all deals?" hits Level 2.

---

## 7. Concrete Code Architectures & Reference Implementations

### Production-Ready Systems

| System | What It Does | GitHub | Language |
|--------|-------------|--------|----------|
| **Graphiti** | Temporal KG for AI agents, hybrid search | `getzep/graphiti` | Python |
| **LightRAG** | Lightweight GraphRAG alternative | `hkuds/lightrag` | Python |
| **Microsoft GraphRAG** | Community-based graph summarization | `microsoft/graphrag` | Python |
| **RAPTOR** | Tree-structured recursive summarization | `parthsarthi03/raptor` | Python |
| **Neo4j Text2Cypher** | NL-to-Cypher datasets + fine-tuning | `neo4j-labs/text2cypher` | Python |
| **Neo4j GenAI Agents** | Multi-tool agent with Cypher + templates | `neo4j-field/ps-genai-agents` | Python |
| **Graph-CoT** | Iterative reasoning over graphs | `PeterGriffinJin/Graph-CoT` | Python |
| **KGoT** | Knowledge Graph of Thoughts | `spcl/knowledge-graph-of-thoughts` | Python |
| **GraphZep** | TypeScript port of Graphiti/Zep | `aexy-io/graphzep` | TypeScript |
| **FalkorDB Text2Cypher** | MCP server for NL graph queries | FalkorDB open source | Python |
| **nickzren/text-to-cypher** | Lightweight NL-to-Cypher web UI | `nickzren/text-to-cypher` | Python |

### Recommended Architecture for Business Temporal KG

Based on this research, the recommended architecture combines multiple approaches:

```
                    User Question
                         |
                         v
              +---------------------+
              | Query Router (LLM)  |
              | Classify intent:    |
              | - entity lookup     |
              | - relationship      |
              | - temporal          |
              | - analytical        |
              | - global/abstract   |
              | - multi-part        |
              +---------------------+
                    |
        +-----------+-----------+-----------+
        |           |           |           |
        v           v           v           v
   +---------+ +---------+ +---------+ +---------+
   | Text2   | | Hybrid  | | Temporal| | Community|
   | Cypher  | | Search  | | Graph   | | Summary |
   | (precise| | (vector | | Query   | | (global |
   | graph   | | + BM25  | | (Zep-   | | themes) |
   | queries)| | + graph | | style   | |         |
   |         | | traverse| | bi-temp)| |         |
   +---------+ +---------+ +---------+ +---------+
        |           |           |           |
        +-----------+-----------+-----------+
                         |
                         v
              +---------------------+
              | Reranker            |
              | (RRF + cross-encoder|
              |  + node distance)   |
              +---------------------+
                         |
                         v
              +---------------------+
              | Synthesis LLM       |
              | Generate answer     |
              | with citations      |
              +---------------------+
                         |
                         v
                    Final Answer
```

### Implementation Stack

Based on what works in production (2025-2026):

1. **Graph Database**: Neo4j 5.26+ (best ecosystem for Text2Cypher, community detection, vector indexes, BM25)
2. **Temporal Model**: Graphiti-style bi-temporal edges (valid_at, invalid_at, created_at, expired_at)
3. **Entity Extraction**: LLM-based with Pydantic schemas (Graphiti approach)
4. **Search Layer**:
   - Cosine similarity via Neo4j vector indexes
   - BM25 via Neo4j full-text indexes (Lucene)
   - BFS graph traversal for neighborhood expansion
   - RRF for rank fusion
5. **Query Router**: LLM classifier (can be small model) that routes to appropriate retrieval strategy
6. **Text2Cypher**: Few-shot prompted LLM with schema injection + validation/correction loop
7. **Community Summaries**: Leiden community detection + LLM summarization at multiple hierarchy levels
8. **Reranking**: Cross-encoder for final relevance scoring + graph distance weighting
9. **LLM**: Claude/GPT-4o for synthesis; smaller models for routing and Cypher generation

### Cost/Latency Budget (per query)

| Step | Latency | Cost (est.) |
|------|---------|-------------|
| Query routing | 100-200ms | $0.001-0.005 |
| Entity recognition | 50-100ms | (included in routing) |
| Hybrid search (vector+BM25+BFS) | 50-150ms | ~$0 (no LLM) |
| Text2Cypher generation | 200-500ms | $0.005-0.02 |
| Cypher execution | 50-100ms | ~$0 |
| Reranking | 50-200ms | $0.001-0.01 |
| Answer synthesis | 300-800ms | $0.01-0.05 |
| **Total (simple query)** | **300-600ms** | **$0.01-0.03** |
| **Total (complex multi-hop)** | **1-3s** | **$0.05-0.15** |
| **Total (iterative Graph-CoT)** | **5-15s** | **$0.50-3.00** |

---

## Key Takeaways

1. **Start with Graphiti/Zep's architecture** for the temporal KG layer. It solves the hardest problems (bi-temporal modeling, conflict resolution, incremental updates) and has proven production performance at 300ms P95 latency.

2. **Use a query router** rather than one-size-fits-all retrieval. Simple entity lookups don't need Graph-CoT. Global questions don't need Text2Cypher. Match the retrieval strategy to the query type.

3. **Text2Cypher is reliable enough for production** with proper schema injection, few-shot examples, and validation/correction loops. Neo4j's fine-tuned models achieve 69-72% execution accuracy; with retry loops this reaches 90%+.

4. **Avoid full Graph-CoT for routine queries** — the token cost (40K+ tokens, $3+/query) is prohibitive. Reserve iterative reasoning for genuinely complex multi-hop exploration.

5. **Pre-compute community summaries** (GraphRAG-style) for global/abstract questions. This is the only practical way to answer "What are the themes across our portfolio?" without scanning every entity.

6. **Hybrid search (vector + BM25 + graph traversal) with RRF** is the sweet spot for most retrieval. This is what Graphiti does, and it avoids LLM calls during retrieval entirely.

7. **LightRAG over Microsoft GraphRAG** for most cases — simpler, cheaper, supports incremental updates, comparable or better performance.

---

## Sources

### Query Decomposition
- [LlamaIndex Knowledge Graph Query Engine](https://docs.llamaindex.ai/en/stable/examples/query_engine/knowledge_graph_query_engine/)
- [LlamaIndex Knowledge Graph RAG Query Engine](https://developers.llamaindex.ai/python/examples/query_engine/knowledge_graph_rag_query_engine/)
- [LlamaIndex Sub-Question Query Decomposition](https://medium.com/@sauravjoshi23/complex-query-resolution-through-llamaindex-utilizing-recursive-retrieval-document-agents-and-sub-d4861ecd54e6)
- [LangChain Decomposition Docs](https://python.langchain.com/v0.1/docs/use_cases/query_analysis/techniques/decomposition/)
- [LangChain Query Transformations Blog](https://www.langchain.com/blog/query-transformations)
- [NVIDIA Query Decomposition Agent](https://nvidia.github.io/GenerativeAIExamples/0.5.0/query-decomposition.html)
- [LlamaIndex Property Graph Index](https://www.llamaindex.ai/blog/introducing-the-property-graph-index-a-powerful-new-way-to-build-knowledge-graphs-with-llms)

### ReAct / Chain-of-Thought for Graph Queries
- [Neo4j: Multi-Hop Reasoning with KGs and LLMs](https://neo4j.com/blog/genai/knowledge-graph-llm-multi-hop-reasoning/)
- [StepChain GraphRAG (arXiv)](https://arxiv.org/html/2510.02827v1)
- [Graph-CoT Multi-Agent Scaling (arXiv)](https://arxiv.org/html/2511.01633v1)
- [Graph-CoT GitHub](https://github.com/PeterGriffinJin/Graph-CoT)
- [Think-on-Graph 2.0 (ICLR 2025)](https://arxiv.org/abs/2407.10805)
- [Knowledge Graph of Thoughts GitHub](https://github.com/spcl/knowledge-graph-of-thoughts)
- [KG-LLM Papers List](https://github.com/zjukg/KG-LLM-Papers)

### Text-to-Cypher / Text-to-SPARQL
- [Text2Cypher Pipeline with LLMs (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S0306457325002213)
- [Text2Cypher: Bridging NL and Graph DBs (ACL)](https://aclanthology.org/2025.genaik-1.11.pdf)
- [Text2GQL-Bench (arXiv Feb 2026)](https://arxiv.org/html/2602.11745)
- [SM3-Text-to-Query Benchmark (TDS)](https://towardsdatascience.com/can-llms-talk-sql-sparql-cypher-and-mongodb-query-language-mql-equally-well-a478f64cc769/)
- [Neo4j Text2Cypher Guide](https://neo4j.com/blog/genai/text2cypher-guide/)
- [Neo4j Text2Cypher GitHub](https://github.com/neo4j-labs/text2cypher)
- [Neo4j Text2Cypher Fine-Tuned Model (HuggingFace)](https://huggingface.co/neo4j/text2cypher-gemma-2-9b-it-finetuned-2024v1)
- [FalkorDB Text-to-Cypher](https://www.falkordb.com/blog/text-to-cypher-natural-language-graph-queries/)
- [Multi-Agent GraphRAG for Text-to-Cypher (arXiv)](https://arxiv.org/html/2511.08274v1)
- [Instruct-to-SPARQL (ACM SIGIR 2025)](https://dl.acm.org/doi/10.1145/3698204.3716476)

### Retrieval Planning & Routing
- [RAGRouter (arXiv)](https://arxiv.org/html/2505.23052v1)
- [SkewRoute: Training-Free KG RAG Routing (EMNLP)](https://aclanthology.org/2025.findings-emnlp.606.pdf)
- [GraphRAG Field Guide (Neo4j)](https://neo4j.com/blog/developer/graphrag-field-guide-rag-patterns/)
- [KA-RAG: KG + Agentic RAG](https://www.mdpi.com/2076-3417/15/23/12547)
- [Graph Memory-Augmented Agentic Routing (OpenReview)](https://openreview.net/pdf?id=ZdGB7MNQDT)
- [GraphRAG Implementation Guide 2026 (PremAI)](https://blog.premai.io/graphrag-implementation-guide-entity-extraction-query-routing-when-it-beats-vector-rag-2026/)
- [Google Cloud Multimodal GraphRAG Architecture](https://docs.cloud.google.com/architecture/agentic-ai-multimodal-graph-rag-resource-orchestration)

### Entity-Centric Retrieval (Zep/Graphiti)
- [Zep Paper (arXiv)](https://arxiv.org/abs/2501.13956)
- [Zep Paper HTML](https://arxiv.org/html/2501.13956v1)
- [Graphiti GitHub](https://github.com/getzep/graphiti)
- [Graphiti: KG Memory for an Agentic World (Neo4j Blog)](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Zep Blog](https://blog.getzep.com/)
- [GraphZep TypeScript Port](https://github.com/aexy-io/graphzep)
- [Graphiti vs Mem0 Benchmark](https://dev.to/juandastic/i-benchmarked-graphiti-vs-mem0-the-hidden-cost-of-context-blindness-in-ai-memory-4le3)
- [Graphiti Quick Start](https://help.getzep.com/graphiti/getting-started/quick-start)

### Summarization Hierarchies
- [GraphRAG Paper (arXiv)](https://arxiv.org/abs/2404.16130)
- [GraphRAG Official Site](https://microsoft.github.io/graphrag/)
- [GraphRAG Global Community Summary Retriever](https://graphrag.com/reference/graphrag/global-community-summary-retriever/)
- [RAPTOR GitHub](https://github.com/parthsarthi03/raptor)
- [LightRAG GitHub (EMNLP 2025)](https://github.com/hkuds/lightrag)
- [Implementing GraphRAG with Neo4j + LangChain](https://neo4j.com/blog/developer/global-graphrag-neo4j-langchain/)
- [Tiny GraphRAG](https://www.stephendiehl.com/posts/graphrag1/)

### Code Architectures & Implementations
- [Neo4j GenAI Agents GitHub](https://github.com/neo4j-field/ps-genai-agents)
- [Agentic RAG + KG (pgvector + Neo4j + Graphiti)](https://github.com/Alejandro-Candela/agentic-rag-knowledge-graph)
- [Awesome-GraphRAG Curated List](https://github.com/DEEP-PolyU/Awesome-GraphRAG)
- [Graph RAG in 2026: Practitioner's Guide](https://medium.com/graph-praxis/graph-rag-in-2026-a-practitioners-guide-to-what-actually-works-dca4962e7517)
- [nickzren/text-to-cypher](https://github.com/nickzren/text-to-cypher)
- [Building KG RAG on Databricks](https://www.databricks.com/blog/building-improving-and-deploying-knowledge-graph-rag-systems-databricks)
- [Graph Memory for LLM Agents](https://tianpan.co/blog/2026-04-10-graph-memory-llm-agents-relational-reasoning)
