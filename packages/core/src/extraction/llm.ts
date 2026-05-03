/**
 * LLM-powered extraction — the primary extraction engine.
 *
 * The extraction prompt is fully dynamic — entity types and relation types
 * are loaded from the database schema, not hardcoded. This means the system
 * works for ANY company's data without code changes.
 */

import type { ExtractedEntity, ExtractedFact, LLMConfig } from '../types.js';
import { anthropicMaxOutputTokens, defaultLLMModel, defaultLLMProvider } from '../llm-limits.js';
import { withLLMTimeout } from '../llm-timeout.js';

/**
 * Schema context loaded from the database.
 * Passed to the LLM so it knows what entity/relation types are available.
 */
export interface SchemaContext {
  entityTypes: { id: string; label: string; description?: string }[];
  relationTypes: {
    id: string;
    label: string;
    sourceTypes?: string[];
    targetTypes?: string[];
    description?: string;
    cardinality?: string;
    invalidationPolicy?: string;
  }[];
}

function buildSystemPrompt(schema?: SchemaContext): string {
  const hasEntitySchema = Boolean(schema?.entityTypes?.length);
  const hasRelationSchema = Boolean(schema?.relationTypes?.length);
  const entityTypeInstruction = hasEntitySchema
    ? `Use one of: ${schema!.entityTypes.map(t => t.id).join('|')}`
    : 'Infer a concise lower_snake_case entity type from the source text and metadata.';

  const relationTypeInstruction = hasRelationSchema
    ? `Use one of: ${schema!.relationTypes.map(t => t.id).join('|')}`
    : 'Infer a concise lower_snake_case relation type from the source text and metadata.';

  // Build entity type descriptions if available
  const entityTypeDesc = schema?.entityTypes?.length
    ? '\n\nAvailable entity types:\n' + schema.entityTypes
        .map(t => `- ${t.id}: ${t.description || t.label}`)
        .join('\n')
    : '';

  // Build relation type descriptions if available
  const relationTypeDesc = schema?.relationTypes?.length
    ? '\n\nAvailable relation types:\n' + schema.relationTypes
        .map(t => {
          let desc = `- ${t.id}: ${t.description || t.label}`;
          if (t.sourceTypes?.length) desc += ` (from: ${t.sourceTypes.join(', ')})`;
          if (t.targetTypes?.length) desc += ` (to: ${t.targetTypes.join(', ')})`;
          if (t.cardinality && t.cardinality !== 'many') desc += ` (current fact cardinality: ${t.cardinality})`;
          return desc;
        })
        .join('\n')
    : '';

  return `You are a precise knowledge graph extraction engine. Your job is to extract structured entities and relationships from text and integrate them into an existing knowledge graph.

You must return valid JSON with this exact schema:

{
  "entities": [
    {
      "name": "Full proper name",
      "entityType": "${entityTypeInstruction}",
      "attributes": {"key": "value"},
      "confidence": 0.0-1.0
    }
  ],
  "facts": [
    {
      "sourceName": "Entity name (must match an entity above)",
      "targetName": "Entity name (must match an entity above)",
      "relation": "${relationTypeInstruction}",
      "factText": "Natural language description of this relationship",
      "evidenceQuote": "Exact quote or compact source phrase supporting this fact",
      "confidenceReason": "Brief reason for the confidence score",
      "validAt": "ISO date if mentioned, null otherwise",
      "confidence": 0.0-1.0
    }
  ]
}${entityTypeDesc}${relationTypeDesc}

Rules:
- Extract ALL entities mentioned in the text
- Extract ALL relationships between entities
- Use the FULL proper name for entities — not abbreviations or first names alone
- CRITICAL: If existing entities are provided as context, REUSE their exact names instead of creating variants
- Set confidence based on how explicit the statement is:
  - 0.95: explicitly stated
  - 0.8: strongly implied
  - 0.6: inferred from context
- For temporal info, include ISO dates in validAt
- Include a short evidenceQuote copied from the source text for every fact
- Include confidenceReason for every fact
- If ontology types are provided, use the closest available type. If no ontology is provided, infer neutral lower_snake_case types without assuming a fixed business domain.
- Do NOT hallucinate entities or relationships not present in the text
- Return ONLY the JSON, no markdown fences or explanation`;
}

export interface LLMExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
}

/**
 * Extract entities and relationships using an LLM.
 * This is the primary extraction method — reliable, context-aware,
 * handles nuance, paraphrase, and implicit relationships.
 */
export async function extractWithLLM(
  text: string,
  config?: LLMConfig,
  existingContext?: string,
  schema?: SchemaContext,
): Promise<LLMExtractionResult> {
  const provider = defaultLLMProvider(config);

  if (provider === 'anthropic') {
    return extractWithAnthropic(text, config, existingContext, schema);
  } else {
    return extractWithOpenAI(text, config, existingContext, schema);
  }
}

async function extractWithAnthropic(
  text: string,
  config?: LLMConfig,
  existingContext?: string,
  schema?: SchemaContext,
): Promise<LLMExtractionResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({
    apiKey: config?.apiKey || process.env.ANTHROPIC_API_KEY,
  });

  const systemPrompt = buildSystemPrompt(schema);
  const userMessage = buildUserMessage(text, existingContext);

  const response = await withLLMTimeout(client.messages.create({
    model: defaultLLMModel('anthropic', config),
    max_tokens: anthropicMaxOutputTokens(config),
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  }), 'extraction anthropic request');

  const content = response.content[0];
  if (content.type !== 'text') {
    return { entities: [], facts: [] };
  }

  return parseExtractionResponse(content.text);
}

async function extractWithOpenAI(
  text: string,
  config?: LLMConfig,
  existingContext?: string,
  schema?: SchemaContext,
): Promise<LLMExtractionResult> {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({
    apiKey: config?.apiKey || process.env.OPENAI_API_KEY,
  });

  const systemPrompt = buildSystemPrompt(schema);
  const userMessage = buildUserMessage(text, existingContext);

  const response = await withLLMTimeout(client.chat.completions.create({
    model: defaultLLMModel('openai', config),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  }), 'extraction openai request');

  const content = response.choices[0]?.message?.content;
  if (!content) return { entities: [], facts: [] };

  return parseExtractionResponse(content);
}

function buildUserMessage(text: string, existingContext?: string): string {
  let msg = '';

  if (existingContext) {
    msg += `${existingContext}\n\n`;
  }

  msg += `TEXT TO EXTRACT FROM:\n${text}`;
  return msg;
}

function parseExtractionResponse(text: string): LLMExtractionResult {
  // Extract JSON from the response (handle markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = jsonMatch[1] || text;

  try {
    const parsed = JSON.parse(jsonStr.trim());
    return {
      entities: (parsed.entities || []).map((e: any) => ({
        name: e.name || '',
        entityType: e.entityType || e.type || 'concept',
        attributes: e.attributes || {},
        confidence: typeof e.confidence === 'number' ? e.confidence : 0.7,
      })),
      facts: (parsed.facts || []).map((f: any) => ({
        sourceName: f.sourceName || f.source || '',
        targetName: f.targetName || f.target || '',
        relation: f.relation || 'related_to',
        factText: f.factText || f.fact || '',
        validAt: parseOptionalDate(f.validAt),
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.6,
        evidence: {
          quote: f.evidenceQuote || f.evidence?.quote || undefined,
          confidenceReason: f.confidenceReason || f.evidence?.confidenceReason || undefined,
        },
      })),
    };
  } catch {
    return { entities: [], facts: [] };
  }
}

function parseOptionalDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
