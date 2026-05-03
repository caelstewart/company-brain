/**
 * Query Router — classifies incoming queries and selects the optimal
 * retrieval strategy (tier) to minimize cost and latency.
 *
 * Tier 1: Direct lookup (<100ms, no LLM in retrieval)
 * Tier 2: Hybrid retrieval + PPR (<500ms, LLM only for answer)
 * Tier 3: Agentic decomposition (1-5s, LLM plans + executes)
 */

import type { LLMConfig } from '../types.js';
import { anthropicMaxOutputTokens, defaultLLMModel } from '../llm-limits.js';

export type QueryIntent =
  | 'entity_lookup'    // "What is X?"
  | 'relationship'     // "How is X connected to Y?"
  | 'temporal'         // "What changed since last month?"
  | 'analytical'       // "How many X are there?"
  | 'global'           // "What are the main themes?"
  | 'multi_hop'        // "Which X are affected by Y?"
  | 'similarity'       // "Find entities similar to X"
  ;

export type QueryTier = 1 | 2 | 3;

export interface RoutingDecision {
  tier: QueryTier;
  intent: QueryIntent;
  methods: string[];       // which search methods to invoke
  confidence: number;      // 0-1, how confident the router is
  entities: string[];      // entities detected in query
  temporalHint?: {         // parsed temporal references
    type: 'as_of' | 'changed_since' | 'valid_during';
    date?: Date;
    start?: Date;
    end?: Date;
  };
}
export interface QuerySchemaContext {
  entityTypes: { id: string; label: string; description?: string }[];
  relationTypes: { id: string; label: string; description?: string }[];
}

export function routeQuery(query: string): RoutingDecision {
  void query;
  return {
    tier: 2,
    intent: 'relationship',
    methods: ['semantic', 'keyword', 'graph', 'pagerank'],
    confidence: 0.5,
    entities: [],
  };
}

// ─── LLM-based Router (higher accuracy, ~100-200ms) ──────────

/**
 * LLM-powered query understanding.
 *
 * A single LLM call (Claude Sonnet 4.6 / GPT-5.4 mini) that does everything
 * the regex/pattern approach tries to do but can't:
 * - Intent classification (entity_lookup, relationship, temporal, etc.)
 * - Entity extraction (any casing, abbreviations, partial names)
 * - Temporal reference parsing (relative dates, named periods)
 *
 * This is the approach used by SOTA systems (HippoRAG, LightRAG):
 * use an LLM for query understanding, use embeddings/SQL for retrieval.
 *
 * Falls back to broad hybrid retrieval if no LLM config or on error.
 */
export async function routeQueryWithLLM(
  query: string,
  llmConfig?: LLMConfig,
  schema?: QuerySchemaContext,
): Promise<RoutingDecision> {
  if (!llmConfig) return routeQuery(query);

  try {
    const parsed = await parseQueryWithLLM(query, llmConfig, schema);
    if (parsed) {
      return {
        tier: intentToTier(parsed.intent),
        intent: parsed.intent,
        methods: intentToMethods(parsed.intent),
        confidence: 0.9,
        entities: parsed.entities,
        temporalHint: parsed.temporalHint,
      };
    }
  } catch {
    // LLM failed — use broad hybrid retrieval rather than semantic regex routing.
  }

  return routeQuery(query);
}

interface ParsedQuery {
  intent: QueryIntent;
  entities: string[];
  temporalHint?: RoutingDecision['temporalHint'];
}

function buildQueryParsePrompt(schema?: QuerySchemaContext): string {
  const schemaContext = schema && (schema.entityTypes.length > 0 || schema.relationTypes.length > 0)
    ? `

Current ontology:
Entity types:
${schema.entityTypes.length ? schema.entityTypes.map(t => `- ${t.id}: ${t.description || t.label}`).join('\n') : '- none defined'}

Relation types:
${schema.relationTypes.length ? schema.relationTypes.map(t => `- ${t.id}: ${t.description || t.label}`).join('\n') : '- none defined'}

Use this ontology as guidance for identifying entity names and relation intent, but do not assume any fixed business domain.`
    : '';

  return `You are a query analyzer for a dynamic knowledge graph search engine. Parse the user's query and respond with ONLY valid JSON.

{
  "intent": "entity_lookup|relationship|temporal|analytical|global|multi_hop|similarity",
  "entities": ["entity names mentioned or implied in the query"],
  "temporal": null or {"type": "as_of|changed_since|valid_during", "reference": "the time reference as written"}
}

Intent definitions:
- entity_lookup: Questions about a specific entity ("who is X", "tell me about X")
- relationship: Questions about connections between entities ("how is X connected to Y")
- temporal: Questions about changes over time ("what changed since", "what was true when")
- analytical: Questions needing counts/comparisons ("how many", "top 5", "compare")
- global: Questions about overall patterns/status/themes across the graph
- multi_hop: Complex questions requiring reasoning across multiple relationships or cause/effect chains
- similarity: Finding entities similar to another entity or description

Entity extraction rules:
- Extract ALL entity names mentioned or implied using the current ontology when provided
- Include partial names, abbreviations, lowercase mentions
- Include named groups, systems, records, places, topics, or domain objects when they appear to be graph entities${schemaContext}

Respond with ONLY the JSON object. No explanation.`;
}

async function parseQueryWithLLM(
  query: string,
  config: LLMConfig,
  schema?: QuerySchemaContext,
): Promise<ParsedQuery | null> {
  let responseText = '';
  const systemPrompt = buildQueryParsePrompt(schema);

  if (config.provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: config.apiKey });
    const msg = await client.messages.create({
      model: defaultLLMModel('anthropic', config),
      max_tokens: anthropicMaxOutputTokens(config),
      system: systemPrompt,
      messages: [{ role: 'user', content: query }],
    });
    responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
  } else if (config.provider === 'openai') {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: config.apiKey });
    const res = await client.chat.completions.create({
      model: defaultLLMModel('openai', config),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
    });
    responseText = res.choices[0]?.message?.content || '';
  }

  if (!responseText) return null;

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const intent = String(parsed.intent || '').toLowerCase();
    if (!isValidIntent(intent)) return null;

    const result: ParsedQuery = {
      intent,
      entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
    };

    if (parsed.temporal && parsed.temporal.type) {
      const tType = parsed.temporal.type;
      if (['as_of', 'changed_since', 'valid_during'].includes(tType)) {
        result.temporalHint = { type: tType };
      }
    }

    return result;
  } catch {
    return null;
  }
}
function isValidIntent(text: string): text is QueryIntent {
  return ['entity_lookup', 'relationship', 'temporal', 'analytical', 'global', 'multi_hop', 'similarity'].includes(text);
}

function intentToTier(intent: QueryIntent): QueryTier {
  switch (intent) {
    case 'entity_lookup': return 1;
    case 'multi_hop': return 3;
    default: return 2;
  }
}

function intentToMethods(intent: QueryIntent): string[] {
  switch (intent) {
    case 'entity_lookup': return ['keyword', 'graph', 'semantic'];
    case 'relationship': return ['graph', 'pagerank', 'keyword', 'semantic'];
    case 'temporal': return ['temporal', 'keyword'];
    case 'analytical': return ['keyword', 'graph', 'semantic'];
    case 'global': return ['community', 'semantic', 'keyword'];
    case 'multi_hop': return ['decompose'];
    case 'similarity': return ['semantic'];
    default: return ['semantic', 'keyword', 'graph'];
  }
}
