/**
 * Default skills that ship with Company Brain.
 *
 * These are the core SOPs that teach agents how to use the brain
 * effectively. Users can override or extend these.
 */

import type { Skill } from './types.js';

export const DEFAULT_SKILLS: Skill[] = [
  // ─── Always-On Skills ────────────────────────────────────

  {
    id: 'signal-detector',
    name: 'Signal Detector',
    description: 'Ambient capture — detects entities, facts, and signals in every message.',
    triggers: [],
    alwaysOn: true,
    priority: 100,
    content: `# Signal Detector

## Purpose
Run on EVERY message. Detect entities, facts, and signals worth capturing.

## Protocol

### Phase 1: Entity Detection
1. Scan for named entities (people, companies, projects, products)
2. For each entity found, search the brain: \`search({ query: entityName })\`
3. If entity exists: note it for context enrichment
4. If entity is new: flag for creation

### Phase 2: Fact Detection
1. Identify statements of fact (X works at Y, X decided Z, X uses Y)
2. Check if these are new information or updates to existing facts
3. For updates: the old fact will be automatically invalidated

### Phase 3: Signal Logging
1. If any entities or facts were detected, ingest the content
2. Use appropriate sourceType (conversation, observation, etc.)
3. Let the extraction pipeline handle entity/fact creation

## Rules
- Do NOT ingest trivial messages (greetings, acknowledgments)
- Do NOT ingest messages that are purely questions with no factual content
- DO capture decisions, plans, opinions, and relationship changes
- When in doubt, capture — the brain can handle noise better than lost signals
`,
  },

  {
    id: 'brain-ops',
    name: 'Brain Operations',
    description: 'Brain-first lookup protocol. Always check the brain before external sources.',
    triggers: [],
    alwaysOn: true,
    priority: 90,
    content: `# Brain Operations

## Purpose
Enforce the brain-first lookup protocol on every knowledge request.

## Protocol

### The Iron Law
Before searching the web, calling an API, or guessing:
1. Search the brain first
2. If the brain has relevant context, use it
3. If the brain is missing context, note the gap after answering

### READ → ENRICH → WRITE Loop
1. **READ**: Search the brain for relevant entities and facts
2. **ENRICH**: If external lookup is needed, do it, but always come back
3. **WRITE**: Ingest any new information learned back into the brain

### Back-linking
When creating or updating entities, always ensure bidirectional relationships:
- If "Alice works at Acme", both Alice and Acme should reference each other
- The extraction pipeline handles this automatically via facts

## Rules
- Never answer a factual question without checking the brain first
- Never learn something new without writing it back
- Trust brain content over general knowledge when there's a conflict
`,
  },

  // ─── On-Demand Skills ────────────────────────────────────

  {
    id: 'query',
    name: 'Query Brain',
    description: 'Search and retrieve information from the knowledge graph.',
    triggers: [
      'what do we know about',
      'search for',
      'find information on',
      'look up',
      'query the brain',
      'what is',
      'who is',
      'tell me about',
      'brain search',
    ],
    priority: 80,
    content: `# Query Brain

## Purpose
Search the knowledge graph and synthesize results into a clear answer.

## Protocol

1. **Parse the query** — identify the core question and any filters
2. **Search** — use \`brain.search()\` with appropriate options:
   - Include entity type filters if the question is about a specific type
   - Use \`asOf\` for historical queries ("what did we know last month?")
   - Adjust \`limit\` based on expected result density
3. **Enrich** — for the top entities found, get their full profiles:
   - \`brain.getEntity(id, { includeFacts: true, includeRelated: true })\`
4. **Synthesize** — combine facts into a coherent narrative
   - Lead with the most confident, most recent facts
   - Note any contradictions or timeline changes
   - Flag low-confidence information
   - Separate directly supported facts from inference
   - Cite evidence quotes when search results include them

## Search Strategy
- Start broad: \`search({ query, methods: ['semantic', 'keyword', 'graph'] })\`
- If too few results: try with just 'semantic' (more recall)
- If too many results: add entity type or relation filters
- For temporal queries: always set \`asOf\`

## Output Format
Present results as a structured, evidence-grounded summary:
- Answer: concise direct answer from retrieved facts only
- Evidence: cite supporting fact text or evidence quotes, with confidence when available
- Inference: only include interpretation that is logically implied by retrieved evidence, labeled as inference
- Uncertain or missing: say what is low-confidence, contradicted, or not present in the brain

## Grounding Rules
- Do NOT add plausible details that are not present in retrieved results.
- Do NOT state incident status, root cause, owner, timing, or next step unless a retrieved fact explicitly supports it.
- If the answer requires interpretation, label it: "Inference:".
- If search results include \`metadata.evidence.quote\`, prefer quoting that over paraphrase.
- If confidence is below 0.8 or the source text used hedging ("maybe", "sounds like", "likely"), caveat it.
`,
  },

  {
    id: 'enrich',
    name: 'Enrich Entity',
    description: 'Deep enrichment of an entity with external data and cross-references.',
    triggers: [
      'enrich',
      'research',
      'deep dive on',
      'learn more about',
      'update profile for',
      'build profile',
      'who is this person',
      'what is this company',
    ],
    priority: 70,
    content: `# Enrich Entity

## Purpose
Build a comprehensive profile for an entity by combining brain knowledge
with external research.

## Protocol

### Step 1: Brain Lookup
1. \`brain.findEntity(name)\` — find the entity
2. \`brain.getEntity(id, { includeFacts: true, includeRelated: true, includeTimeline: true })\`
3. Review what we already know

### Step 2: Gap Analysis
Identify what's missing based on entity type:

**Person**: role, company, location, expertise, recent activity
**Company**: industry, size, funding, products, key people
**Project**: status, owner, blockers, timeline, dependencies
**Decision**: context, rationale, alternatives considered, outcome

### Step 3: External Research
Fill gaps using available tools (web search, API calls, etc.)

### Step 4: Write Back
Ingest the enriched information:
\`\`\`
brain.ingest({
  content: "Enrichment: [entity name] - [new facts found]...",
  sourceType: 'enrichment',
  sourceId: entityId,
})
\`\`\`

## Rules
- Always check the brain FIRST — don't re-research known facts
- Cite sources when adding external information
- Set appropriate confidence levels (external research = 0.7-0.8)
- Update, don't duplicate — the resolver handles dedup automatically
`,
  },

  {
    id: 'ingest-meeting',
    name: 'Ingest Meeting',
    description: 'Process and ingest a meeting transcript or notes.',
    triggers: [
      'meeting notes',
      'meeting transcript',
      'ingest meeting',
      'process meeting',
      'we just had a meeting',
      'meeting with',
      'sync notes',
      'standup notes',
    ],
    priority: 70,
    content: `# Ingest Meeting

## Purpose
Process meeting transcripts/notes to extract all entities, decisions,
action items, and relationship changes.

## Protocol

### Step 1: Identify Metadata
- Meeting date/time (use for validAt)
- Attendees
- Meeting type (standup, sync, review, etc.)

### Step 2: Pre-check Attendees
For each attendee mentioned:
1. \`brain.findEntity(name)\`
2. Note which are known vs. new

### Step 3: Ingest
\`\`\`
brain.ingest({
  content: fullTranscript,
  sourceType: 'meeting_transcript',
  validAt: meetingDate,
  metadata: {
    meetingType: 'sync',
    attendees: ['Alice Chen', 'Bob Zhang'],
  },
})
\`\`\`

### Step 4: Verify Extraction
After ingestion, search for the key entities to verify they were captured:
- Were all attendees created/linked?
- Were decisions captured as facts?
- Were action items captured?

### Step 5: Enrich New Entities
For any newly created entities, run the enrich skill to build their profiles.

## What to Extract
- **People**: names, roles, companies
- **Decisions**: what was decided, by whom, rationale
- **Action items**: who, what, by when
- **Status updates**: project/deal progress changes
- **Relationship changes**: new roles, new companies, new projects
`,
  },

  {
    id: 'timeline',
    name: 'Entity Timeline',
    description: 'Show the full history of changes for an entity over time.',
    triggers: [
      'timeline',
      'history of',
      'what changed',
      'show changes',
      'evolution of',
      'track changes',
    ],
    priority: 60,
    content: `# Entity Timeline

## Purpose
Show the full temporal history of an entity — all facts, including
invalidated ones, ordered chronologically.

## Protocol

1. Find the entity: \`brain.findEntity(name)\`
2. Get full timeline: \`brain.getEntity(id, { includeTimeline: true })\`
3. Present chronologically:
   - Group facts by time period (day/week/month)
   - Show fact creation and invalidation
   - Highlight contradictions (fact A superseded by fact B)

## Output Format
\`\`\`
[Entity Name] Timeline
========================

March 15, 2024:
  + Alice works at Acme Corp (VP Sales)
  + Acme evaluating enterprise plan

March 22, 2024:
  - Alice works at Acme Corp (VP Sales) [invalidated]
  + Alice works at Acme Corp (Chief Revenue Officer)
  + Acme signed enterprise deal
\`\`\`
`,
  },

  {
    id: 'extraction-review',
    name: 'Review Extraction',
    description: 'Review extraction stats and suggested prompt/schema improvements.',
    triggers: [
      'extraction stats',
      'how is extraction',
      'extraction suggestions',
      'improve extraction',
      'extraction quality',
      'llm usage',
    ],
    priority: 50,
    content: `# Review Extraction

## Purpose
Review the fail-improve loop statistics and act on suggested prompt, schema, and eval improvements.

## Protocol

1. Get stats: \`brain.getExtractionStats()\`
2. Present key metrics:
   - LLM extraction count
   - Total extractions
   - Hybrid structural identifier count
3. Get extraction guidance suggestions: \`brain.getSuggestedPatterns()\`
4. For each suggestion, evaluate:
   - Should the ontology description change?
   - Should the extraction prompt include a better generic instruction?
   - Should an eval case be added?

## Goal
Extraction quality should improve without adding brittle semantic regex.
A healthy system has grounded extractions with clear evidence, low duplicate drift, and improving eval coverage.
`,
  },
];
