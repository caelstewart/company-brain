/**
 * Embedding utilities. Currently supports OpenAI text-embedding-3-large.
 * Designed to be provider-agnostic via the EmbeddingConfig interface.
 */

import type { EmbeddingConfig } from './types.js';

const DEFAULT_MODEL = 'text-embedding-3-large';
const DIMENSIONS = 1536;

let openaiClient: any = null;

function getClient(config?: EmbeddingConfig) {
  if (openaiClient) return openaiClient;

  const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY required for embeddings');

  // Dynamic import to avoid hard dep when not using embeddings
  const OpenAI = require('openai').default;
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

export async function embed(
  text: string,
  config?: EmbeddingConfig,
): Promise<number[]> {
  const client = getClient(config);
  const model = config?.model || DEFAULT_MODEL;

  const response = await client.embeddings.create({
    model,
    input: text.slice(0, 8000), // Token limit safety
    dimensions: DIMENSIONS,
  });

  return response.data[0].embedding;
}

export async function embedBatch(
  texts: string[],
  config?: EmbeddingConfig,
): Promise<number[][]> {
  const client = getClient(config);
  const model = config?.model || DEFAULT_MODEL;

  // OpenAI supports up to 2048 inputs per batch
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += 2048) {
    batches.push(texts.slice(i, i + 2048).map(t => t.slice(0, 8000)));
  }

  const results: number[][] = [];
  for (const batch of batches) {
    const response = await client.embeddings.create({
      model,
      input: batch,
      dimensions: DIMENSIONS,
    });
    for (const item of response.data) {
      results.push(item.embedding);
    }
  }

  return results;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
