# Intelligent Query Systems Over Knowledge Graphs: State of the Art (2024-2026)

## Research for Company Brain — Temporal Knowledge Graph Engine

*Compiled April 2026. Focused on approaches proven to work at scale for reasoning-heavy, multi-hop queries over entity-relationship graphs built from unstructured business data.*

---

## Table of Contents

1. [GraphRAG / Graph-Based Retrieval-Augmented Generation](#1-graphrag--graph-based-retrieval-augmented-generation)
2. [Multi-Hop Reasoning Over Knowledge Graphs (KGQA)](#2-multi-hop-reasoning-over-knowledge-graphs-kgqa)
3. [Agentic RAG / Query Planning](#3-agentic-rag--query-planning)
4. [Temporal Knowledge Graphs](#4-temporal-knowledge-graphs)
5. [Hybrid Retrieval Architectures](#5-hybrid-retrieval-architectures)
6. [Production Systems at Scale](#6-production-systems-at-scale)
7. [LightRAG, HippoRAG, RAPTOR, and Other Recent Approaches](#7-lightrag-hipporag-raptor-and-other-recent-approaches)
8. [Synthesis: Recommended Architecture for Company Brain](#8-synthesis-recommended-architecture-for-company-brain)

---

## 1. GraphRAG / Graph-Based Retrieval-Augmented Generation

### Core Problem Solved

Traditional vector RAG retrieves text chunks by semantic similarity, which fails for queries requiring synthesis across an entire corpus ("What are the top themes?") or multi-hop reasoning ("Which deals are at risk because of leadership changes?"). GraphRAG uses a knowledge graph as the retrieval layer instead of a flat vector index, enabling connected knowledge retrieval.

### Microsoft GraphRAG — The Reference Architecture

**Paper:** "From Local to Global: A Graph RAG Approach to Query-Focused Summarization" (April 2024, arXiv:2404.16130)
**Code:** github.com/microsoft/graphrag (10K+ stars)

#### Indexing Pipeline

1. **Chunking:** Input corpus sliced into TextUnits
2. **Entity/Relationship Extraction:** LLM extracts entities, relationships, and claims from each TextUnit. Uses unconstrained schema — no Pydantic models — relying on downstream clustering to handle extraction variation
3. **Graph Construction:** Entities become nodes, relationships become edges
4. **Community Detection (Leiden Algorithm):** Hierarchical clustering using the Leiden algorithm (via graspologic library). Produces multi-level communities:
   - Level 0: Fine-grained communities (few highly-related entities)
   - Level 1+: Progressively larger aggregations
   - Leiden chosen over Louvain because it guarantees well-connected communities
5. **Community Summarization:** LLM generates natural language summaries for each community, bottom-up (lower summaries feed into higher ones). These are pre-computed before any queries arrive
6. **Output:** Parquet files: `entities.parquet`, `relationships.parquet`, `communities.parquet`, `community_reports.parquet`, plus LanceDB vector embeddings

#### Query Modes

**Global Search (Map-Reduce):**
- Map phase: Each community summary independently generates a partial answer to the query, in parallel
- Reduce phase: Partial answers synthesized into a comprehensive global answer
- Resource-intensive but handles "understand the whole dataset" queries
- Achieves 72-83% comprehensiveness vs. traditional RAG

**Local Search:**
- Vector similarity search on entity descriptions to find relevant nodes
- Graph traversal from those nodes to collect linked text chunks, relationships, community summaries
- Faster, cheaper, good for entity-specific queries

**DRIFT Search (Dynamic Reasoning and Inference with Flexible Traversal):**
- Hybrid of global and local: compares query to top-K community reports for broad initial answer
- Generates follow-up questions, uses local search to refine
- Better cost-quality balance than pure global search

#### Trade-offs

| Dimension | Assessment |
|-----------|------------|
| **Accuracy** | 80% vs. 50% for traditional RAG on complex queries; 3.4x improvement on enterprise benchmarks |
| **Indexing Cost** | $20-500 for typical corpora vs. $2-5 for vector RAG. A 5GB legal corpus estimated at $33K |
| **Query Latency** | Global search: tens of seconds (map-reduce over all communities). Local search: seconds |
| **Update Cost** | Poor — updates can trigger recomputation of entire graph. Not suitable for streaming data |
| **Scale** | Proven on corpora of thousands of documents. Community detection scales well |

### LazyGraphRAG — Cost-Efficient Alternative

**Blog:** Microsoft Research, November 2024

The breakthrough insight: defer LLM summarization from indexing time to query time. No pre-computed community summaries.

**How it works:**
- Indexing cost identical to vector RAG (0.1% of full GraphRAG cost)
- At query time, dynamically builds graph structures and uses iterative deepening to explore
- Single parameter (relevance test budget) controls cost-quality tradeoff
- Won 96/96 head-to-head comparisons against 8 competing methods in AP News benchmark

**Key numbers:**
- 0.1% of GraphRAG indexing cost
- 700x lower query cost for global queries
- At 4% of GraphRAG global search query cost, significantly outperforms all competing methods on both local and global queries

**Ideal for:** One-off queries, exploratory analysis, streaming data where pre-indexing is impractical.

### Relevance to Company Brain

GraphRAG's community detection and hierarchical summarization are directly applicable to Company Brain's use case. A question like "which deals are at risk because of leadership changes" requires global reasoning across communities of related entities. However, the high indexing cost and poor update characteristics of full GraphRAG make LazyGraphRAG or a Graphiti-style incremental approach more practical for continuously-ingested business data.

---

## 2. Multi-Hop Reasoning Over Knowledge Graphs (KGQA)

### Core Problem

Questions like "what companies in our pipeline had recent reorgs that could affect our champion" require chaining multiple facts: (1) find pipeline companies, (2) detect leadership/org changes at those companies, (3) identify our champion contacts there, (4) assess whether the changes affect our champion's authority/role. This is multi-hop KGQA.

### Architectural Patterns

#### Pattern A: Question Decomposition + Atomic Retrieval

Decompose complex questions into sub-questions, each answerable by a single graph lookup, then compose answers.

**DRKG (2025):** Uses LLMs to generate intermediate reasoning steps that mirror human problem decomposition. Ablation experiments confirm both the question decomposition and reasoning analysis modules are essential.

**Key insight:** A "compositionality gap" exists — LLMs correctly answer simple sub-queries but fail on their composition. This gap widens non-linearly with query complexity, making decomposition not just helpful but essential.

#### Pattern B: Path Reasoning / Dynamic Path Generation

**RDPG (2025) — Reasoning via Dynamic Planning on Graph:**
- LLM dynamically generates, corrects, and expands reasoning paths over the KG
- Path correction handles hallucination caused by irrelevant noise or missing information
- Chain-of-Thought reasoning combines built-in LLM knowledge with retrieved external KG knowledge
- Plug-and-play: applicable to different LLMs and KGs

**RPR-KGQA (2024):** Relational path reasoning for multi-hop QA, addressing incomplete KGs and weakly-supervised situations through relational path extraction.

#### Pattern C: Tree Search (MCTS)

**Reasoning with Trees (COLING 2025):** Formulates KGQA as a discrete decision-making problem, using Monte Carlo Tree Search to iteratively refine reasoning paths. Each node in the search tree represents a state in the reasoning process; edges represent graph traversal decisions.

#### Pattern D: Generate-on-Graph (EMNLP 2024)

Addresses incomplete KGs by treating the LLM as both Agent and KG: it can generate new factual triples while exploring the KG. Uses a Thinking-Searching-Generating framework.

### Trade-offs for Company Brain

| Approach | Latency | Accuracy | KG Completeness Tolerance | Implementation Complexity |
|----------|---------|----------|--------------------------|--------------------------|
| Question Decomposition | Medium (multiple LLM calls) | High | Moderate | Low-Medium |
| Dynamic Path Generation | Medium-High | Very High | High (self-correcting) | Medium-High |
| MCTS | High (iterative) | Very High | High | High |
| Generate-on-Graph | Medium | Good | Very High (generates missing) | Medium |

### Recommendation for Company Brain

**Question Decomposition + Atomic Retrieval** is the most practical pattern for sub-second latency requirements. Pre-compute decomposition templates for common query patterns. For novel queries, use LLM decomposition with cached sub-query results. Dynamic path generation (RDPG-style) is the fallback for queries that decomposition cannot handle.

---

## 3. Agentic RAG / Query Planning

### Core Pattern: LLM as Query Orchestrator

Instead of a single retrieve-then-generate pass, an LLM agent plans a sequence of retrieval and reasoning operations, evaluates results, and iterates.

### The Agentic RAG Evolution (from survey arXiv:2501.09136)

1. **Naive RAG** (2020-2022): Single-pass retrieve + generate
2. **Advanced RAG** (2022-2024): Query rewriting, re-ranking, iterative retrieval
3. **Modular RAG** (2023-2024): Pluggable components (retrievers, re-rankers, generators)
4. **Graph RAG** (2024): Knowledge graph as retrieval substrate
5. **Agentic RAG** (2025+): Autonomous agents with reflection, planning, tool use, multi-agent collaboration

### Key Agentic Design Patterns

#### Think-Then-Retrieve (Self-Correcting Loop)

**Pattern:** Agent → Plan → Retrieve → Evaluate → Refine → Retrieve again → Synthesize

**Agentic Graph RAG for Clinical Decision Support (2025):**
- State-driven agentic system with "retrieve-evaluate-refine" loop
- Agents dynamically generate, semantically validate, assess, and iteratively optimize graph search strategies
- Achieved faithfulness 0.94, context recall 0.92, answer relevancy 0.91
- Significantly outperformed GPT-4, standard RAG, and Graph RAG baselines

#### Query Decomposition + Parallel Execution

**Azure AI Search — Agentic Retrieval (Production, 2025):**
- LLM breaks compound questions into focused sub-queries based on user question, chat history, and parameters
- Sub-queries run simultaneously against the index
- Results merged, semantically ranked, returned with grounding data + activity plan
- Three-part response: grounding data, reference data for source inspection, activity plan showing execution steps
- Supported models: GPT-4o, GPT-4.1, GPT-5 series

#### Multi-Agent Coordination

**KA-RAG Framework:**
Five-stage pipeline: Query → Intent Recognition → KG Retrieval (Cypher) → Vector Retrieval (Embedding Search) → Evidence Fusion. Combines symbolic graph reasoning with dense semantic retrieval.

**INRAExplorer:**
LLM-based agent with multi-tool architecture. Dynamically engages knowledge base through iterative, targeted queries. Performs multi-hop reasoning via tool orchestration.

### RAG-Gym: Training Retrieval Agents

Formulates knowledge-intensive QA as a nested Markov Decision Process. Enables process supervision with rewards at each step of the information search process. Allows principled training of retrieval agents using reinforcement learning.

### Trade-offs

| Dimension | Assessment |
|-----------|------------|
| **Accuracy** | Highest among all approaches (0.91-0.94 relevancy in benchmarks) |
| **Latency** | High — multiple LLM calls per query (3-10+ round trips). 2-15 seconds typical |
| **Cost** | Expensive — each planning step costs tokens. $0.05-0.50 per complex query |
| **Determinism** | Low — different runs may produce different plans |
| **Implementation** | Moderate with frameworks (LangGraph, CrewAI, AutoGen) |

### Recommendation for Company Brain

Use a **tiered approach**: simple queries (single-entity lookups) go through direct graph traversal (no LLM planning). Medium queries use single-pass decomposition. Complex queries ("which deals are at risk...") trigger the full agentic loop. Route based on query complexity classification (itself an LLM call, but cacheable by query template).

---

## 4. Temporal Knowledge Graphs

### Why This Matters for Company Brain

Every fact in Company Brain has temporal validity: "Alice is VP of Sales at TechCorp" was true from 2023-01 to 2024-06. "Bob replaced Alice as VP" became true 2024-06. Queries like "what changed since last month?" or "who was our champion when we started this deal?" require temporal reasoning.

### Zep / Graphiti — The Most Relevant Production System

**Paper:** "Zep: A Temporal Knowledge Graph Architecture for Agent Memory" (arXiv:2501.13956, January 2025)
**Code:** github.com/getzep/graphiti (open source)
**Backend:** Neo4j (also supports FalkorDB, Kuzu, Amazon Neptune)

#### Architecture: Three-Layer Subgraph Hierarchy

```
G = (N, E, phi) where N=nodes, E=edges, phi=incidence function

Layer 1: EPISODIC SUBGRAPH
  - Raw input data (messages, text, JSON) stored as episode nodes
  - Non-lossy data store — nothing is thrown away
  - Episodic edges connect episodes to extracted entities

Layer 2: SEMANTIC ENTITY SUBGRAPH
  - Entity nodes extracted from episodes and resolved with existing entities
  - Fact edges carry temporal metadata
  - Represents the "current understanding" of the world

Layer 3: COMMUNITY SUBGRAPH
  - Community detection via label propagation (not Leiden)
  - Label propagation chosen because it supports dynamic, incremental updates
  - Communities represent thematic clusters of entities
```

#### Bi-Temporal Model (Critical for Company Brain)

Every entity edge carries **two independent time axes**:

- **Event time (T):** When the fact was true in the real world
  - `t_valid`: When the fact became true
  - `t_invalid`: When the fact stopped being true
- **Ingestion time (T'):** When the system learned about it
  - `t'_created`: When the edge was created in the system
  - `t'_expired`: When the edge was invalidated in the system

**Edge Invalidation Process:**
When new information contradicts existing facts, old edges are **invalidated, not deleted**. If a new episode says "Alice left TechCorp," the system sets `invalid_at` on the old "Alice works at TechCorp" edge. This preserves full history.

The system identifies temporally overlapping contradictions and invalidates affected edges by setting their `t_invalid` to the `t_valid` of the invalidating edge, consistently prioritizing new information.

**Temporal date extraction:** Zep accurately parses relative/partial dates: "next Thursday," "in two weeks," "last summer."

#### Entity Resolution

Graphiti continuously ingests new data episodes, extracting and immediately resolving entities against existing nodes. Supports both:
- **Prescribed schema:** User defines entity/edge types via Pydantic models
- **Learned schema:** Structure emerges from data automatically

De-duplicates nodes and labels edge relationships consistently. Uses rule-based entity resolution.

#### Hybrid Search (No LLM at Query Time)

Three search functions, no LLM calls during retrieval:
1. **Cosine semantic similarity search** (vector embeddings)
2. **Okapi BM25 full-text search** (keyword matching via Lucene)
3. **Breadth-first search (BFS)** (graph traversal)

Results from all three are merged and reranked.

**Performance:** P95 latency of 300ms. Vector and BM25 indexes offer near-constant time access regardless of graph size.

#### Benchmarks

- DMR Benchmark: 94.8% vs. MemGPT's 93.4%
- LongMemEval: Up to 18.5% accuracy improvement, 90% latency reduction vs. baselines
- Excels on: cross-session information synthesis, long-term context maintenance, temporal reasoning, knowledge update tasks

### Academic TKG Research (2024-2025)

For completeness, the academic TKG landscape:

**Temporal Knowledge Graph Completion (TKGC):**
- Methods: time-included tensor decomposition, time-based transformation, dynamic embedding, graph snapshots, temporal logical rules
- Leading models: DynaGen (diffusion-based, +1.45-2.61 MRR), DiMNet (+22.7% MRR on ICEWS05-15), RLGNet (ensemble local/global/repeating modules)
- Evolution: 5 stages from static to LLM-augmented TKGC

**Temporal Question Answering (TKGQA):**
- MCTQA (2025): Handles multi-granularity temporal questions (both day-level and month-level). Up to 6% improvement in Hits@1 on MULTITQ
- MuSTQ (ACL 2024): Benchmark for multi-step temporal reasoning

### Recommendation for Company Brain

**Adopt Graphiti's bi-temporal model directly.** It is the most production-ready approach to temporal knowledge graphs, specifically designed for the use case of ingesting business data streams. Key decisions:

1. Use the bi-temporal `(t_valid, t_invalid, t'_created, t'_expired)` model for all edges
2. Implement edge invalidation (not deletion) for fact changes
3. Use label propagation for communities (supports incremental updates, unlike Leiden)
4. Parse temporal expressions from unstructured text during ingestion
5. Build temporal query operators: `AS_OF(timestamp)`, `CHANGED_SINCE(timestamp)`, `VALID_DURING(range)`

---

## 5. Hybrid Retrieval Architectures

### The Core Insight

No single retrieval method handles all query types. Vector search finds semantically similar text but cannot trace relationships. Graph traversal follows connections but may miss semantically relevant but unlinked content. Keyword search handles exact matches that embedding models miss. The production answer is to combine all three.

### Architecture Pattern: Retriever Orchestration Engine

```
User Query
    |
    v
[Query Router / Classifier]
    |
    +--> [Vector Search] --> semantically similar chunks/entities
    +--> [BM25 Keyword Search] --> exact match results
    +--> [Graph Traversal] --> connected entities/paths
    |
    v
[Result Fusion (Reciprocal Rank Fusion or learned reranker)]
    |
    v
[Context Compressor (optional small LLM)]
    |
    v
[Generator LLM]
```

### Result Fusion Approaches

**Reciprocal Rank Fusion (RRF):**
- Maintains separate embeddings for entities, chunks, and relations
- Fuses results from vector and graph retrieval using RRF scoring
- 15% improvement over vanilla vector retrieval on enterprise datasets

**Cross-Encoder Reranking:**
- Cohere Rerank or similar processes query-document pairs through BERT-like architecture
- 5-10% improvements in precision@3
- Adds 200-500ms latency per query

**Learned Fusion:**
- Train a small model to weight results from different retrievers based on query type
- Highest quality but requires training data

### HybridRAG (arXiv:2408.04948)

Integrates knowledge graphs and vector retrieval. Initial retrieval uses vector search to identify relevant document regions, then graph queries explore relationships between mentioned entities to discover additional context.

Benchmarks: GraphRAG + Hybrid outperform Vector RAG on complex reasoning. Hybrid demonstrates higher factual correctness but increased redundancy and computational cost.

### Production Performance Numbers

| System | Approach | Latency | Accuracy Gain |
|--------|----------|---------|---------------|
| FalkorDB GraphRAG | Native graph + vector | Sub-50ms graph queries | 90% hallucination reduction |
| Graphiti/Zep | Semantic + BM25 + BFS, no LLM at retrieval | 300ms P95 | 18.5% accuracy improvement |
| Smart Manufacturing Hybrid | KG metadata + vector retrieval | Not reported | 77.8% exact match, 76.5% context precision |
| Cross-encoder reranking | Add-on reranker | +200-500ms | +5-10% precision@3 |

### Caching for Sub-Second Latency

**SubGCache (AAAI 2026):**
- Clusters queries based on subgraph embeddings
- Pre-computes KV cache for representative subgraphs per cluster
- Reuses KV cache for similar queries, avoiding redundant LLM inference
- Cost drops to $0.02/1K queries post-caching (75% below uncached)

### Recommendation for Company Brain

Implement a three-tier retrieval system:
1. **Fast path (sub-100ms):** Direct graph lookup for entity-specific queries. Neo4j/FalkorDB graph traversal + vector index search. No LLM involved.
2. **Medium path (100-500ms):** Hybrid retrieval (vector + BM25 + 1-hop graph traversal) with RRF fusion and reranking. No LLM involved in retrieval; LLM generates final answer from fused context.
3. **Slow path (1-5s):** Agentic decomposition for complex multi-hop queries. LLM plans retrieval strategy, executes sub-queries via fast/medium paths, synthesizes.

Cache aggressively: query embeddings, sub-query results, community summaries, and (via SubGCache-style approach) LLM KV caches for common subgraph patterns.

---

## 6. Production Systems at Scale

### Zep / Graphiti (Detailed in Section 4)

The most directly relevant production system. YC W24 company. Temporal KG for agent memory. Neo4j backend. Open-source core. 300ms P95 latency. Handles continuous data ingestion with incremental graph updates.

### Graphlit

**Focus:** Context layer for AI agents. Ingestion + extraction + enrichment platform.

**Architecture:**
- Ingests diverse data types (PDFs, audio, images, JSON) and extracts entities as knowledge graph
- Hybrid storage: vector database + cloud object storage + graph database
- Powers GraphRAG via entity-to-content and entity-to-entity relationships
- Enriches entities by integrating with external services (Crunchbase, Wikipedia)
- Integrates data sources: Slack, GitHub, Jira via real-time sync
- API-first design, zero ops

**Differentiation:** Turnkey semantic processing. Higher-level abstraction than Graphiti. Less control but faster time-to-production.

### WhyHow.AI

**Focus:** Deterministic, controlled knowledge graphs for RAG with guardrails.

**Key Architectural Decisions:**
- **Small, specialized graphs** instead of monolithic KGs. Each graph scoped to a specific domain or use case
- Graphs populated only with user-deemed-relevant nodes and edges (not every possible extraction)
- **Three graph creation modes:**
  1. User-defined schema (Pydantic-style entity/relationship type definitions)
  2. Seed question-driven (extract entities relevant to specific questions)
  3. Deterministic from structured CSV
- **No Text2Cypher** — custom query engine that is 2x more accurate than Text2Cypher approaches
- Rule-based entity resolution and retrieval guardrails
- Built on MongoDB (combining relational data, vector storage, flexible schemas)
- Open-source Knowledge Graph Studio

**Trade-offs:** High accuracy and determinism, but requires more upfront schema design. Lower automation than Graphiti/LightRAG. Best for regulated industries needing explainability.

### Cognee

**Focus:** Open-source AI memory engine for agents. Production-grade.

**Architecture:**
- Graph-vector hybrid unifying three storage layers
- **Session memory** (short-term): loads relevant embeddings + graph fragments into runtime context
- **Permanent memory** (long-term): user data, interaction traces, documents, derived relationships
- Three core operations: `.add()`, `.cognify()`, `.search()`
- Flexible backends: Neo4j, FalkorDB, KuzuDB, NetworkX (graph); Redis, Qdrant, Weaviate (vector); SQLite, Postgres (relational)
- Custom ontology support, agent-scoped memory layers

**Performance:** 92.5% accuracy vs. traditional RAG's 60%. Over 1M pipelines/month. 70+ companies including Bayer. $7.5M seed.

### FalkorDB

**Focus:** Ultra-fast graph database for GraphRAG.

**Performance:** Sub-50ms query latency. 90% hallucination reduction vs. traditional RAG. Native graph operations at scale. Used as backend by Cognee and others.

**Positioning:** Performance-critical deployments where latency matters most.

### Google Knowledge Graph / Knowledge Vault

**Scale:** 570M+ references, 18B factual connections (original). Added 10B entities in 4 days (July 2023), 4B in a single day (March 2024). Person entities grew 22x in 4 years.

**Architecture:**
- Knowledge Vault uses probabilistic knowledge fusion: population of extractors mine facts from web
- Link prediction determines likely additional edges
- Entity Reconciliation API: RDF triple extraction → graph clustering → entity deduplication
- Handles graphs with billions of nodes and trillions of edges
- Query annotation enriches search queries with entity metadata for disambiguation

**Relevance to Company Brain:** The scale is aspirational but the entity reconciliation and probabilistic fact fusion patterns are applicable. Company Brain likely starts at thousands-to-millions of entities, not billions.

### LinkedIn Knowledge Graph

**Impact:** Reduced ticket resolution time from 40 hours to 15 hours (63% improvement). Demonstrates real-world production impact at enterprise scale.

### Palantir Foundry Ontology

**Architecture layers:** Semantic (objects/links), Kinetic (actions), Dynamic (AI/simulation). Community has requested Neo4j-like true knowledge graph capabilities. More of an ontology system than a dynamic KG.

### Key Production Lessons

1. **Start with hybrid search, not pure graph:** Graphiti's combination of vector + BM25 + BFS without LLM at retrieval time achieves 300ms P95. Pure graph traversal or pure vector search alone is insufficient.

2. **Incremental updates are non-negotiable:** Full GraphRAG re-indexing is impractical for streaming business data. Graphiti's episode-based ingestion with entity resolution is the proven pattern.

3. **Schema flexibility matters:** Both prescribed (WhyHow) and emergent (Graphiti) schemas have production track records. For business data, start with a prescribed core schema (Company, Person, Deal, Meeting, etc.) and allow learned extensions.

4. **Cost at scale:** LightRAG achieves 65-80% cost savings over GraphRAG for 1500+ documents/month. FalkorDB's specialized graph DB reduces infrastructure costs 40% vs. scaling larger LLMs.

---

## 7. LightRAG, HippoRAG, RAPTOR, and Other Recent Approaches

### LightRAG (EMNLP 2025 Findings)

**Paper:** arXiv:2410.05779 (October 2024)
**Code:** github.com/HKUDS/LightRAG

**Core Architecture: Graph-Enhanced Text Indexing + Dual-Level Retrieval**

**Indexing Pipeline (3 stages):**
1. **Entity/Relationship Extraction:** LLM extracts entities and relationships from document chunks
2. **Key-Value Pair Generation:** LLM profiles each entity and relation, generating retrieval keys (for matching) and descriptive values (for context). Dual representation enables efficient matching while preserving richness.
3. **Deduplication:** Merges redundant entities/relationships

**Dual-Level Retrieval:**
- **Low-Level (Specific):** Targets individual nodes and edges for entity-specific, detail-oriented queries. Example: "What is Company X's revenue?"
- **High-Level (Abstract):** Aggregates across multiple entities and relationships for thematic queries. Example: "How does AI influence modern education?"
- **Hybrid Mode:** Combines both — broad relationship retrieval + deep entity exploration

**Retrieval Mechanism:**
1. LLM extracts dual-level keywords from query (high-level themes + low-level entities)
2. Vector similarity search + graph traversal for each level
3. Results merged for comprehensive context

**Key Advantage:** No community summarization layer (unlike GraphRAG). Achieves comparable accuracy with:
- 6,000x token efficiency improvement (<100 tokens vs. 610K for complex retrieval)
- 10x token reduction overall
- 65-80% cost savings for high-volume processing
- Supports incremental updates (new documents added without full re-index)

**Requirements:** Needs LLM with 32B+ parameters and 32KB+ context (64KB recommended).

**Trade-offs:** Simpler than GraphRAG (no community structure = less global reasoning capability). Better for entity-centric and relationship-centric queries than for true corpus-wide synthesis.

### HippoRAG (NeurIPS 2024) + HippoRAG 2 (ICML 2025)

**Paper:** arXiv:2405.14831
**Code:** github.com/OSU-NLP-Group/HippoRAG

**Core Insight:** Models the hippocampus's role in human memory. The neocortex processes perceptual input (LLM extracts entities), the hippocampal index connects memories (knowledge graph), and pattern completion recalls related memories (Personalized PageRank).

**Offline Indexing:**
1. LLM extracts named entities from each passage (1-shot prompting)
2. OpenIE extracts triples (subject-predicate-object), including concepts beyond named entities
3. Builds schemaless knowledge graph

**Online Retrieval (the key innovation):**
1. **Query Processing:** LLM extracts salient named entities from query ("query named entities")
2. **Node Linking:** Query entities linked to KG nodes via embedding similarity
3. **Personalized PageRank (PPR):** Run PPR algorithm with query nodes as seeds. PPR distributes probability across the graph only from user-defined source nodes, mimicking hippocampal pattern completion
4. **Node Specificity:** Modulates query node probabilities based on document frequency (neurobiologically plausible mechanism — rare entities get higher weight)
5. **Document Ranking:** PPR node probabilities aggregated over indexed passages to rank them

**Why PPR is powerful:** Performs multi-hop reasoning in a single retrieval step. No iterative LLM calls needed. A query about "leadership changes at Company X" would activate Company X, spread activation to connected Person entities, their Role edges, and temporal change events — all in one PPR computation.

**Performance:**
- Up to 20% improvement over SOTA RAG on multi-hop QA
- 10-30x cheaper than iterative retrieval (IRCoT)
- 6-13x faster than iterative retrieval

**HippoRAG 2 Improvements:**
- Adds conceptual (phrase-level) AND contextual (passage-level) nodes
- Deeper passage integration
- Uses fewer resources for offline indexing than GraphRAG, RAPTOR, or LightRAG
- Accepted at ICML 2025

**Relevance to Company Brain:** HippoRAG's PPR-based retrieval is extremely well-suited for Company Brain's multi-hop queries. "Which deals are at risk because of leadership changes" would seed PPR with deal entities and leadership-change entities, and PPR would find connecting paths through the graph. Fast, cheap, and handles multi-hop naturally.

### RAPTOR (ICLR 2024)

**Paper:** arXiv:2401.18059
**Code:** github.com/parthsarthi03/raptor

**Architecture: Recursive Abstractive Processing for Tree-Organized Retrieval**

1. Embed text chunks
2. Cluster chunks using Gaussian Mixture Models (GMM) — allows soft clustering (a chunk can belong to multiple clusters)
3. LLM generates abstractive summary for each cluster
4. Recursively repeat: embed summaries → cluster → summarize → ...
5. Result: tree with leaves = original chunks, internal nodes = increasingly abstract summaries

**Retrieval Methods:**
- **Tree Traversal:** Select top-K root nodes by cosine similarity → traverse to children → select top-K at each level
- **Collapsed Tree:** Flatten hierarchy, embed everything in one space, retrieve by similarity across all levels

**Performance:** 20% absolute accuracy improvement on QuALITY benchmark (coupled with GPT-4). Outperforms BM25 and DPR across all tested LLMs.

**Scalability:** Tree construction scales linearly with document length (up to 80K tokens tested).

**Trade-offs:** Pre-computes summaries (like GraphRAG), so updates require partial re-computation. GMM clustering is less interpretable than graph community detection. No explicit entity/relationship modeling — works at the text level, not the knowledge level.

### Newer Approaches (2025)

**PathRAG (February 2025):**
- Addresses redundancy in graph-based retrieval by extracting high-value relational paths
- Flow-based pruning algorithm selects most critical paths with least noise
- 44% context reduction while maintaining accuracy
- Path-centric prompting converts paths to coherent text (not flat lists)
- Best on large-scale datasets (Legal, History, Biology) with 65% win rates

**ArchRAG (February 2025):**
- Attributed community detection + LLM summarization for hierarchical graphs
- C-HNSW index enables hierarchical traversal from abstract to specific
- 250x lower query token cost than flat GraphRAG
- 10-18 point accuracy gain

**KET-RAG (KDD 2025):**
- Multi-granular indexing: KG skeleton + text-keyword bipartite graph
- Skeleton-RAG: selects core chunks via PageRank centrality, extracts KG from those
- Keyword-RAG: lightweight bipartite graph as fallback
- Outperforms 13 competitors on 3 datasets
- 10x+ cheaper indexing than GraphRAG, 32.4% quality improvement

**HyperGraphRAG (2025):**
- First graph-based RAG using hypergraph structure
- Handles n-ary relations (more than 2 entities per edge)
- Standard graphs are limited to binary relations; hypergraphs represent meetings with 5 attendees as a single hyperedge

**LinearRAG (2025):**
- Designed for large-scale corpora
- Linear graph structure for efficient retrieval

### Summary Comparison

| System | Graph Type | Query Approach | Indexing Cost | Query Latency | Multi-hop | Incremental Updates |
|--------|-----------|---------------|---------------|---------------|-----------|-------------------|
| GraphRAG | Community hierarchy | Map-reduce global / vector local | Very High | Seconds-minutes | Good (global) | Poor |
| LazyGraphRAG | Dynamic at query time | Iterative deepening | Very Low | Seconds | Good | N/A (no pre-index) |
| LightRAG | Entity-relation KV pairs | Dual-level (specific/abstract) | Low | Sub-second | Moderate | Good |
| HippoRAG | Schemaless KG | Personalized PageRank | Low | Sub-second | Excellent | Moderate |
| RAPTOR | Recursive summary tree | Tree traversal / collapsed | Medium | Sub-second | Moderate | Poor |
| Graphiti/Zep | Temporal 3-layer KG | Hybrid (vector+BM25+BFS) | Low (incremental) | 300ms P95 | Good | Excellent |
| PathRAG | Pruned relational paths | Flow-based path selection | Low | Sub-second | Good | Moderate |
| KET-RAG | Skeleton + bipartite | Multi-granular | Very Low | Sub-second | Good | Moderate |

---

## 8. Synthesis: Recommended Architecture for Company Brain

Based on this research, here is the recommended architectural approach for Company Brain's query system.

### Core Architecture: Graphiti-Inspired Temporal KG + HippoRAG-Style Retrieval + Agentic Planning

```
                    ┌─────────────────────────────────────┐
                    │          User Query                  │
                    └─────────────┬───────────────────────┘
                                  │
                                  v
                    ┌─────────────────────────────────────┐
                    │    Query Complexity Classifier       │
                    │    (LLM or rule-based)               │
                    │    Routes to appropriate tier        │
                    └──┬──────────┬──────────────┬────────┘
                       │          │              │
                  Simple     Medium         Complex
                       │          │              │
                       v          v              v
                ┌──────────┐ ┌──────────┐ ┌──────────────┐
                │ Direct   │ │ Hybrid   │ │ Agentic      │
                │ Graph    │ │ Retrieval│ │ Decomposition│
                │ Lookup   │ │ + PPR    │ │ + Planning   │
                │ <100ms   │ │ <500ms   │ │ 1-5s         │
                └──────────┘ └──────────┘ └──────────────┘
                       │          │              │
                       v          v              v
                    ┌─────────────────────────────────────┐
                    │       Temporal Knowledge Graph       │
                    │   (Graphiti bi-temporal model)       │
                    │                                     │
                    │  Episodes → Entities → Communities  │
                    │  Bi-temporal edges (valid/invalid)   │
                    │  Neo4j/FalkorDB backend              │
                    │  Vector + BM25 + Graph indexes       │
                    └─────────────────────────────────────┘
```

### Knowledge Graph Layer (Indexing)

1. **Ingestion:** Continuously ingest meetings, emails, Slack, CRM as episodes (Graphiti pattern)
2. **Extraction:** LLM extracts entities (Person, Company, Deal, Team, Product) and relationships with temporal metadata
3. **Entity Resolution:** Match extracted entities against existing nodes (embedding similarity + rule-based). Prescribed core schema + learned extensions.
4. **Temporal Edges:** All relationships carry bi-temporal metadata `(t_valid, t_invalid, t_created, t_expired)`
5. **Edge Invalidation:** New contradicting facts invalidate old edges (not delete). Full history preserved.
6. **Community Detection:** Label propagation (incremental-friendly) for thematic clustering of related entities
7. **Storage:** Neo4j or FalkorDB with vector indexes (entity embeddings), BM25 indexes (entity/relationship text), and native graph indexes

### Query Layer (Three Tiers)

**Tier 1 — Direct Lookup (<100ms):**
- Pattern match on query: "Tell me about Company X", "Who is Alice?"
- Direct graph traversal: find entity → return node + 1-hop relationships + temporal validity
- No LLM involved in retrieval. LLM only formats the response.

**Tier 2 — Hybrid Retrieval with PPR (<500ms):**
- For queries needing moderate reasoning: "What happened at Company X recently?"
- Extract query entities and keywords
- Run in parallel: vector search on entity embeddings + BM25 on relationship text + Personalized PageRank from query entities
- Fuse results with RRF
- Apply temporal filters (AS_OF, CHANGED_SINCE)
- LLM generates answer from fused context

**Tier 3 — Agentic Decomposition (1-5s):**
- For complex multi-hop queries: "Which deals are at risk because of leadership changes?"
- LLM decomposes into sub-queries:
  1. "Find all active deals in pipeline" → Tier 1 graph query
  2. "Find recent leadership changes at those companies" → Tier 2 with temporal filter
  3. "Identify our champion contacts at those companies" → Tier 1 graph query
  4. "Assess overlap between champions and leadership changes" → LLM reasoning over collected evidence
- Sub-query results cached for reuse
- Self-correcting loop: if sub-query results are insufficient, agent refines and retries

### Critical Implementation Details

**For sub-second latency (Tiers 1-2):**
- No LLM calls during retrieval. LLM only at final answer generation.
- Pre-compute entity embeddings and community summaries at ingestion time
- Use FalkorDB (sub-50ms graph queries) or Neo4j with proper indexing
- Cache frequently-accessed subgraphs and query results
- SubGCache-style KV caching for common query patterns

**For accuracy on complex queries (Tier 3):**
- Question decomposition templates for common patterns (pre-defined, not generated each time)
- Dynamic path generation (RDPG-style) as fallback for novel query patterns
- Evidence fusion with source attribution (every fact traceable to an episode)

**For temporal reasoning:**
- Temporal query operators: `AS_OF(date)`, `CHANGED_SINCE(date)`, `VALID_DURING(start, end)`
- Relative date parsing at ingestion time ("last Thursday" → concrete timestamp)
- Temporal filters applied at the graph query level, before LLM sees the data

**For cost management:**
- LightRAG-style dual-level keyword extraction to minimize tokens sent to LLM
- Pre-computed community summaries (refreshed incrementally, not from scratch)
- Cached decomposition plans for recurring query patterns
- Target: $0.01-0.05 per query average across all tiers

### Technology Stack Recommendation

| Component | Recommended | Alternative |
|-----------|-------------|-------------|
| Graph Database | Neo4j 5.26+ (mature, Graphiti-compatible) | FalkorDB (faster, sub-50ms) |
| Vector Index | Built-in Neo4j vector index or Qdrant | Weaviate, Pinecone |
| BM25 Search | Neo4j Lucene integration | Elasticsearch |
| LLM (Reasoning) | Claude Sonnet/Opus (via API) | GPT-4o, GPT-4.1 |
| LLM (Extraction) | Claude Haiku or GPT-4o-mini (cost-efficient) | Llama 3.1 70B+ (self-hosted) |
| Embedding Model | text-embedding-3-large or NV-Embed-v2 | Cohere embed-v3 |
| Framework | Graphiti (open source) as foundation | Custom on Neo4j driver |
| Caching | Redis for query results + SubGCache patterns | Memcached |
| Orchestration | LangGraph for agentic tier | Custom state machine |

### Key Papers and Projects to Reference

| Resource | Relevance |
|----------|-----------|
| Zep/Graphiti paper (arXiv:2501.13956) | Bi-temporal KG architecture — direct blueprint |
| Microsoft GraphRAG paper (arXiv:2404.16130) | Community detection, map-reduce querying |
| HippoRAG paper (arXiv:2405.14831) | PPR-based multi-hop retrieval |
| LightRAG paper (arXiv:2410.05779) | Dual-level retrieval, cost efficiency |
| LazyGraphRAG blog (Microsoft Research) | Deferred summarization, cost optimization |
| RAPTOR paper (arXiv:2401.18059) | Hierarchical summarization tree |
| PathRAG paper (arXiv:2502.14902) | Flow-based path pruning |
| KET-RAG paper (arXiv:2502.09304) | Multi-granular skeleton indexing |
| Agentic RAG survey (arXiv:2501.09136) | Comprehensive framework taxonomy |
| SubGCache (AAAI 2026) | KV cache reuse for graph RAG |
| RDPG (2025) | Dynamic path generation for multi-hop QA |

---

## Sources

### GraphRAG / Microsoft
- [Microsoft Research — GraphRAG Project](https://www.microsoft.com/en-us/research/project/graphrag/)
- [From Local to Global: A GraphRAG Approach (arXiv)](https://arxiv.org/abs/2404.16130)
- [Microsoft GraphRAG GitHub](https://github.com/microsoft/graphrag)
- [GraphRAG — Improving global search via dynamic community selection](https://www.microsoft.com/en-us/research/blog/graphrag-improving-global-search-via-dynamic-community-selection/)
- [LazyGraphRAG — Setting a new standard for quality and cost](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- [DRIFT Search — Combining global and local search methods](https://www.microsoft.com/en-us/research/blog/introducing-drift-search-combining-global-and-local-search-methods-to-improve-quality-and-efficiency/)
- [Tiny GraphRAG Implementation Walkthrough](https://www.stephendiehl.com/posts/graphrag1/)

### Multi-Hop KGQA
- [DRKG: Faithful Multi-Hop KGQA via LLM-Guided Reasoning Plans](https://www.mdpi.com/2076-3417/15/12/6722)
- [RDPG: Adaptive Path Generation with LLMs](https://link.springer.com/article/10.1007/s10844-025-00945-5)
- [RPR-KGQA: Relational Path Reasoning (ACM 2024)](https://dl.acm.org/doi/10.1145/3675249.3675353)
- [KGQA Tutorials and Papers (GitHub)](https://github.com/heathersherry/Knowledge-Graph-Tutorials-and-Papers/blob/master/topics/Knowledge%20Graph%20Question%20Answering%20(KGQA).md)

### Agentic RAG
- [Agentic RAG Survey (arXiv:2501.09136)](https://arxiv.org/html/2501.09136v4)
- [Agentic RAG with KGs for Multi-Hop Reasoning (arXiv:2507.16507)](https://arxiv.org/abs/2507.16507)
- [Azure AI Search — Agentic Retrieval Overview](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-overview)
- [KA-RAG: Knowledge Graphs + Agentic RAG](https://www.mdpi.com/2076-3417/15/23/12547)
- [GraphRAG and Agentic Architecture with Neo4j](https://neo4j.com/blog/developer/graphrag-and-agentic-architecture-with-neoconverse/)
- [Self-correcting Agentic Graph RAG for Clinical Decision Support](https://pmc.ncbi.nlm.nih.gov/articles/PMC12748213/)

### Temporal Knowledge Graphs
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory (arXiv:2501.13956)](https://arxiv.org/abs/2501.13956)
- [Graphiti GitHub Repository](https://github.com/getzep/graphiti)
- [Graphiti: Knowledge Graph Memory for an Agentic World (Neo4j Blog)](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Awesome-TKGC GitHub Repository](https://github.com/jiapuwang/Awesome-TKGC)
- [EmergentMind — Temporal Knowledge Graph Reasoning](https://www.emergentmind.com/topics/temporal-knowledge-graph-reasoning-tkgr)
- [Complete Guide to Knowledge & Context Graphs via Zep & Graphiti](https://medium.com/@whynesspower/complete-guide-to-knowledge-context-graphs-via-zep-graphiti-c6da7ce8b13b)

### Hybrid Retrieval
- [HybridRAG: Integrating Knowledge Graphs and Vector RAG (arXiv:2408.04948)](https://arxiv.org/html/2408.04948v1)
- [From Vectors to Knowledge Graphs — Comprehensive Analysis (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S1574013726000341)
- [SubGCache: Accelerating Graph-based RAG (AAAI)](https://ojs.aaai.org/index.php/AAAI/article/view/40827)
- [Achieving Sub-Second Latency Real-Time RAG Pipelines](https://www.rtinsights.com/real-time-rag-pipelines-achieving-sub-second-latency-in-enterprise-ai/)

### LightRAG, HippoRAG, RAPTOR
- [LightRAG Paper (arXiv:2410.05779)](https://www.alphaxiv.org/overview/2410.05779v1)
- [LightRAG GitHub](https://github.com/hkuds/lightrag)
- [HippoRAG Paper (arXiv:2405.14831)](https://arxiv.org/abs/2405.14831)
- [HippoRAG GitHub](https://github.com/osu-nlp-group/hipporag)
- [HippoRAG — From Retrieval to Reasoning (Graphwise)](https://graphwise.ai/blog/from-retrieval-to-reasoning-enhancing-hipporag-with-graph-based-semantics/)
- [RAPTOR Paper (arXiv:2401.18059)](https://arxiv.org/abs/2401.18059)
- [RAPTOR GitHub](https://github.com/parthsarthi03/raptor)
- [PathRAG Paper (arXiv:2502.14902)](https://arxiv.org/html/2502.14902v1)
- [KET-RAG Paper (arXiv:2502.09304)](https://arxiv.org/abs/2502.09304)
- [HyperGraphRAG Paper](https://arxiv.org/html/2503.21322v3)
- [Graph RAG Survey (ACM TOIS)](https://dl.acm.org/doi/10.1145/3777378)
- [Awesome-GraphRAG Repository](https://github.com/DEEP-PolyU/Awesome-GraphRAG)

### Production Systems
- [Graphlit — Building Knowledge Graphs](https://www.graphlit.com/guides/building-knowledge-graphs)
- [WhyHow.AI Knowledge Graph Studio (GitHub)](https://github.com/whyhow-ai/knowledge-graph-studio)
- [WhyHow.AI SDK (GitHub)](https://github.com/whyhow-ai/whyhow)
- [Cognee — AI Memory Engine (GitHub)](https://github.com/topoteretes/cognee)
- [FalkorDB — Data Retrieval & GraphRAG](https://www.falkordb.com/news-updates/data-retrieval-graphrag-ai-agents/)
- [From LLMs to Knowledge Graphs: Production-Ready Graph Systems in 2025](https://medium.com/@claudiubranzan/from-llms-to-knowledge-graphs-building-production-ready-graph-systems-in-2025-2b4aff1ec99a)

### Text-to-Query
- [Text2Cypher Pipeline (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S0306457325002213)
- [SPARQL-LLM: Production-Ready Text-to-SPARQL](https://devnavigator.com/2025/12/19/sparql-llm-knowledge-graph-queries/)
- [Knowledge Graph of Thoughts (ETH Zurich)](http://htor.ethz.ch/publications/img/besta-kgot.pdf)
