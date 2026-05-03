/**
 * Embedding utilities. Currently supports OpenAI text-embedding-3-large.
 * Designed to be provider-agnostic via the EmbeddingConfig interface.
 */

import type { EmbeddingConfig } from './types.js';
import { withLLMTimeout } from './llm-timeout.js';

const DEFAULT_MODEL = 'text-embedding-3-large';
const DIMENSIONS = 1536;
const EMBEDDING_CONTEXT_TOKENS = 8191;
const EMBEDDING_RESERVED_TOKENS = 256;
const APPROX_CHARS_PER_TOKEN = 3.5;
const EMBEDDING_CHUNK_CHARS = Math.floor((EMBEDDING_CONTEXT_TOKENS - EMBEDDING_RESERVED_TOKENS) * APPROX_CHARS_PER_TOKEN);
const EMBEDDING_CHUNK_OVERLAP_CHARS = Math.floor(256 * APPROX_CHARS_PER_TOKEN);

let openaiClient: any = null;

async function getClient(config?: EmbeddingConfig) {
  if (openaiClient) return openaiClient;

  const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY required for embeddings');

  const { default: OpenAI } = await import('openai');
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

export async function embed(
  text: string,
  config?: EmbeddingConfig,
): Promise<number[]> {
  const [embedding] = await embedBatch([text], config);
  return embedding;
}

export async function embedBatch(
  texts: string[],
  config?: EmbeddingConfig,
): Promise<number[][]> {
  const client = await getClient(config);
  const model = config?.model || DEFAULT_MODEL;

  const chunkRequests: { text: string; sourceIndex: number; weight: number }[] = [];
  for (let sourceIndex = 0; sourceIndex < texts.length; sourceIndex += 1) {
    const chunks = chunkForEmbedding(texts[sourceIndex]);
    for (const chunk of chunks) {
      chunkRequests.push({ text: chunk, sourceIndex, weight: Math.max(1, chunk.length) });
    }
  }

  const chunkEmbeddings: { embedding: number[]; sourceIndex: number; weight: number }[] = [];
  for (let i = 0; i < chunkRequests.length; i += 2048) {
    const batch = chunkRequests.slice(i, i + 2048);
    const response = await withLLMTimeout(client.embeddings.create({
      model,
      input: batch.map(item => item.text),
      dimensions: DIMENSIONS,
    }), 'embedding openai request') as { data: Array<{ embedding: number[] }> };
    for (let j = 0; j < response.data.length; j += 1) {
      chunkEmbeddings.push({
        embedding: response.data[j].embedding,
        sourceIndex: batch[j].sourceIndex,
        weight: batch[j].weight,
      });
    }
  }

  return texts.map((_, sourceIndex) => weightedAverage(
    chunkEmbeddings.filter(item => item.sourceIndex === sourceIndex),
  ));
}

function chunkForEmbedding(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [''];
  if (normalized.length <= EMBEDDING_CHUNK_CHARS) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + EMBEDDING_CHUNK_CHARS);
    chunks.push(normalized.slice(start, end));
    if (end >= normalized.length) break;
    start = end - EMBEDDING_CHUNK_OVERLAP_CHARS;
  }
  return chunks;
}

function weightedAverage(items: { embedding: number[]; weight: number }[]): number[] {
  if (items.length === 0) return Array.from({ length: DIMENSIONS }, () => 0);
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const output = Array.from({ length: items[0].embedding.length }, () => 0);
  for (const item of items) {
    const weight = item.weight / totalWeight;
    for (let i = 0; i < item.embedding.length; i += 1) {
      output[i] += item.embedding[i] * weight;
    }
  }
  return output;
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
