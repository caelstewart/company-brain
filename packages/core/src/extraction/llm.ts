/**
 * LLM-powered extraction — the primary extraction engine.
 *
 * Uses structured output (tool_use / JSON schema) for reliable extraction.
 * Multi-pass approach:
 *   Pass 1: Extract entities from raw text
 *   Pass 2: Extract relationships with entity context
 *   Pass 3: Detect contradictions against existing graph (in resolver)
 *
 * The deterministic layer is now a pre-filter that catches obvious
 * structured data (emails, URLs) before the LLM sees the text.
 */

import type { ExtractedEntity, ExtractedFact, LLMConfig } from '../types.js';

const EXTRACTION_SYSTEM_PROMPT = `You are a precise knowledge graph extraction engine. Your job is to extract structured entities and relationships from text.

You must return valid JSON with this exact schema:

{
  "entities": [
    {
      "name": "Full proper name",
      "entityType": "person|company|project|decision|concept|event|document",
      "attributes": {"key": "value"},
      "confidence": 0.0-1.0
    }
  ],
  "facts": [
    {
      "sourceName": "Entity name (must match an entity above)",
      "targetName": "Entity name (must match an entity above)",
      "relation": "works_at|founded|advises|invested_in|owns|contributes_to|decided|blocked_by|attended|mentions|related_to",
      "factText": "Natural language description of this relationship",
      "validAt": "ISO date if mentioned, null otherwise",
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- Extract ALL entities mentioned — people, companies, projects, products, decisions, events
- Extract ALL relationships — employment, ownership, decisions, dependencies, mentions
- Use the FULL proper name (e.g., "Alice Chen" not "Alice")
- Set confidence based on how explicit the statement is:
  - 0.95: explicitly stated ("Alice is CTO of Acme")
  - 0.8: strongly implied ("Alice from Acme" implies works_at)
  - 0.6: inferred ("they discussed Acme" — who are "they"?)
- For temporal info, include ISO dates in validAt
- Capture decisions as entities (type: "decision") AND as facts (relation: "decided")
- When someone's role/title is mentioned, create a works_at fact with the role in factText
- Do NOT hallucinate entities or relationships not present in the text
- Return ONLY the JSON, no markdown fences or explanation`;

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

  const userMessage = buildUserMessage(text, existingContext);

  const response = await client.messages.create({
    model: config?.model || 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: EXTRACTION_SYSTEM_PROMPT,
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

  const userMessage = buildUserMessage(text, existingContext);

  const response = await client.chat.completions.create({
    model: config?.model || 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return { entities: [], facts: [] };

  return parseExtractionResponse(content);
}

function buildUserMessage(text: string, existingContext?: string): string {
  let msg = '';

  if (existingContext) {
    msg += `EXISTING KNOWLEDGE GRAPH CONTEXT (use this to avoid duplicates and detect changes):\n${existingContext}\n\n`;
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
        validAt: f.validAt ? new Date(f.validAt) : undefined,
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.6,
      })),
    };
  } catch {
    return { entities: [], facts: [] };
  }
}
