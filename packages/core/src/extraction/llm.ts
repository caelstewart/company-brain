/**
 * Layer 2: LLM-based extraction.
 *
 * Falls back to LLM when deterministic extraction confidence is below
 * threshold. Uses structured output to extract entities and relationships.
 *
 * Every LLM call is logged to the extraction_log for the fail-improve loop.
 */

import type { ExtractedEntity, ExtractedFact, LLMConfig } from '../types.js';

const EXTRACTION_PROMPT = `You are an entity and relationship extractor. Given text, extract:

1. ENTITIES: People, companies, projects, decisions, concepts, events mentioned.
   For each: name, type (person/company/project/decision/concept/event), and any attributes.

2. FACTS: Relationships between entities.
   For each: source entity name, target entity name, relation type, natural language description.

   Valid relation types: works_at, founded, advises, invested_in, owns, contributes_to,
   decided, blocked_by, attended, mentions, related_to

3. TEMPORAL: If dates or time references are mentioned, include them.

Respond with JSON only:
{
  "entities": [{"name": "...", "entityType": "...", "attributes": {...}, "confidence": 0.0-1.0}],
  "facts": [{"sourceName": "...", "targetName": "...", "relation": "...", "factText": "...", "validAt": "ISO date or null", "confidence": 0.0-1.0}]
}

Be precise. Only extract what is explicitly stated or strongly implied.
Set confidence lower for inferences vs explicit statements.`;

export interface LLMExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
}

export async function extractWithLLM(
  text: string,
  config?: LLMConfig,
  existingContext?: string,
): Promise<LLMExtractionResult> {
  const provider = config?.provider || 'anthropic';

  if (provider === 'anthropic') {
    return extractWithAnthropic(text, config, existingContext);
  } else {
    return extractWithOpenAI(text, config, existingContext);
  }
}

async function extractWithAnthropic(
  text: string,
  config?: LLMConfig,
  existingContext?: string,
): Promise<LLMExtractionResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({
    apiKey: config?.apiKey || process.env.ANTHROPIC_API_KEY,
  });

  const userMessage = existingContext
    ? `Context from existing knowledge graph:\n${existingContext}\n\nNew text to extract from:\n${text}`
    : text;

  const response = await client.messages.create({
    model: config?.model || 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

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
): Promise<LLMExtractionResult> {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({
    apiKey: config?.apiKey || process.env.OPENAI_API_KEY,
  });

  const userMessage = existingContext
    ? `Context from existing knowledge graph:\n${existingContext}\n\nNew text to extract from:\n${text}`
    : text;

  const response = await client.chat.completions.create({
    model: config?.model || 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return { entities: [], facts: [] };

  return parseExtractionResponse(content);
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
        validAt: f.validAt ? new Date(f.validAt) : undefined,
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.6,
      })),
    };
  } catch {
    // If JSON parsing fails, return empty
    return { entities: [], facts: [] };
  }
}
