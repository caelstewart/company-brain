import type { LLMConfig } from './types.js';

const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const RESERVED_OUTPUT_AND_PROMPT_TOKENS = 16_000;
const APPROX_CHARS_PER_TOKEN = 3.5;
const CHUNK_OVERLAP_TOKENS = 3_000;

export function defaultLLMProvider(config?: LLMConfig): 'anthropic' | 'openai' {
  if (config?.provider) return config.provider;
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'anthropic';
}

export function defaultLLMModel(provider: 'anthropic' | 'openai', config?: LLMConfig): string {
  if (config?.model) return config.model;
  return provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL;
}

export function anthropicMaxOutputTokens(config?: LLMConfig): number {
  return config?.maxOutputTokens ?? modelMaxOutputTokens(defaultLLMModel('anthropic', config));
}

export function llmInputCharBudget(config?: LLMConfig): number {
  const provider = defaultLLMProvider(config);
  const model = defaultLLMModel(provider, config);
  const usableInputTokens = Math.max(1, modelContextWindowTokens(model, config) - RESERVED_OUTPUT_AND_PROMPT_TOKENS);
  return Math.floor(usableInputTokens * APPROX_CHARS_PER_TOKEN);
}

export function llmChunkOverlapChars(): number {
  return Math.floor(CHUNK_OVERLAP_TOKENS * APPROX_CHARS_PER_TOKEN);
}

export function modelContextWindowTokens(model: string, config?: LLMConfig): number {
  if (config?.contextWindowTokens) return config.contextWindowTokens;
  if (model.startsWith('gpt-5.4-mini') || model.startsWith('gpt-5.4-nano')) return 400_000;
  if (model === 'gpt-5.4' || model.startsWith('gpt-5.4-2026')) return 1_050_000;
  if (model.startsWith('claude-sonnet-4-6') || model.startsWith('claude-opus-4-7') || model.startsWith('claude-opus-4-6')) return 1_000_000;
  if (model.startsWith('claude-haiku-4-5')) return 200_000;
  return 200_000;
}

function modelMaxOutputTokens(model: string): number {
  if (model.startsWith('claude-opus-4-7') || model.startsWith('claude-opus-4-6')) return 128_000;
  if (model.startsWith('claude-sonnet-4-6') || model.startsWith('claude-haiku-4-5')) return 64_000;
  return 64_000;
}
