/**
 * Query Decomposer — breaks complex multi-hop questions into
 * atomic sub-queries that can each be answered by Tier 1/2 retrieval.
 *
 * This is the Tier 3 engine. Only invoked for complex queries that
 * the router classifies as 'multi_hop'.
 */

import type postgres from 'postgres';
import type { SearchResult, LLMConfig, EmbeddingConfig } from '../types.js';
import { anthropicMaxOutputTokens, defaultLLMModel } from '../llm-limits.js';

export interface SubQuery {
  question: string;
  intent: 'entity_lookup' | 'relationship' | 'temporal' | 'analytical';
  dependsOn?: number[];  // indices of sub-queries this depends on
}

export interface DecompositionPlan {
  original: string;
  subQueries: SubQuery[];
  synthesisHint: string;  // instruction for combining sub-answers
}

export function decomposeWithTemplates(query: string): DecompositionPlan | null {
  void query;
  return null;
}

// ─── LLM-based Decomposition (accurate, ~200-500ms) ─────────

export async function decomposeWithLLM(
  query: string,
  llmConfig: LLMConfig,
): Promise<DecompositionPlan> {
  const systemPrompt = `You are a query decomposition engine for a knowledge graph. Break complex questions into simple sub-queries.

Respond with ONLY valid JSON in this format:
{
  "subQueries": [
    {"question": "...", "intent": "entity_lookup|relationship|temporal|analytical", "dependsOn": []},
    ...
  ],
  "synthesisHint": "How to combine the sub-answers into a final answer"
}

Rules:
- Each sub-query should be answerable with a single graph lookup or search
- Mark dependencies: if sub-query 2 needs results from sub-query 0, set dependsOn: [0]
- intent types: entity_lookup (find an entity), relationship (find connections), temporal (time-based), analytical (count/aggregate)
- Keep sub-queries simple and specific
- Maximum 5 sub-queries`;

  let responseText = '';

  if (llmConfig.provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: llmConfig.apiKey });
    const msg = await client.messages.create({
      model: defaultLLMModel('anthropic', llmConfig),
      max_tokens: anthropicMaxOutputTokens(llmConfig),
      system: systemPrompt,
      messages: [{ role: 'user', content: query }],
    });
    responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
  } else if (llmConfig.provider === 'openai') {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: llmConfig.apiKey });
    const res = await client.chat.completions.create({
      model: defaultLLMModel('openai', llmConfig),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
    });
    responseText = res.choices[0]?.message?.content || '';
  }

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      original: query,
      subQueries: parsed.subQueries.map((sq: any) => ({
        question: String(sq.question),
        intent: sq.intent || 'entity_lookup',
        dependsOn: Array.isArray(sq.dependsOn) ? sq.dependsOn : undefined,
      })),
      synthesisHint: parsed.synthesisHint || 'Combine the sub-answers to address the original question.',
    };
  } catch {
    // Fallback: treat the whole query as a single sub-query
    return {
      original: query,
      subQueries: [{ question: query, intent: 'relationship' }],
      synthesisHint: 'Answer directly from the search results.',
    };
  }
}

// ─── Decompose (LLM-first) ────────────────────────────────────

export async function decompose(
  query: string,
  llmConfig?: LLMConfig,
): Promise<DecompositionPlan> {
  if (llmConfig) {
    return decomposeWithLLM(query, llmConfig);
  }

  // No templates matched and no LLM — return as single query
  return {
    original: query,
    subQueries: [{ question: query, intent: 'relationship' }],
    synthesisHint: 'Answer directly from the search results.',
  };
}

// ─── Execute Decomposed Plan ─────────────────────────────────

export async function executePlan(
  plan: DecompositionPlan,
  executeSubQuery: (question: string, intent: string) => Promise<SearchResult[]>,
): Promise<SearchResult[]> {
  const subResults: SearchResult[][] = new Array(plan.subQueries.length);

  // Execute sub-queries respecting dependencies
  // First pass: execute all queries with no dependencies
  const noDeps = plan.subQueries
    .map((sq, i) => ({ sq, i }))
    .filter(({ sq }) => !sq.dependsOn || sq.dependsOn.length === 0);

  await Promise.all(
    noDeps.map(async ({ sq, i }) => {
      subResults[i] = await executeSubQuery(sq.question, sq.intent);
    }),
  );

  // Second pass: execute dependent queries
  const withDeps = plan.subQueries
    .map((sq, i) => ({ sq, i }))
    .filter(({ sq }) => sq.dependsOn && sq.dependsOn.length > 0);

  for (const { sq, i } of withDeps) {
    // Enrich the sub-query with context from dependencies
    const depContext = (sq.dependsOn || [])
      .map(d => subResults[d]?.map(r => r.content).join('; ') || '')
      .filter(Boolean)
      .join(' | ');

    const enrichedQuestion = depContext
      ? `${sq.question} (Context: ${depContext.slice(0, 500)})`
      : sq.question;

    subResults[i] = await executeSubQuery(enrichedQuestion, sq.intent);
  }

  // Merge all results, deduplicating by ID
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const results of subResults) {
    if (!results) continue;
    for (const r of results) {
      const key = `${r.type}:${r.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(r);
      }
    }
  }

  // Sort by score descending
  merged.sort((a, b) => b.score - a.score);
  return merged;
}
