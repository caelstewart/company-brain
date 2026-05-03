/**
 * Layer 1: Deterministic extraction.
 *
 * Handles ONLY structural signal extraction — things identifiable by format,
 * not by content. Emails, @handles, URLs, and known-entity matching.
 *
 * All content interpretation (what entities mean, how they relate, what
 * roles/decisions/actions exist) is the LLM's job. This layer does NOT
 * try to understand content — it just extracts structural identifiers
 * and matches against entities already in the graph.
 */

import type { ExtractedEntity, ExtractedFact } from '../types.js';

// ─── Structural Format Patterns ──────────────────────────────
// These match by FORMAT (email syntax, URL syntax, @handle syntax),
// not by content. They work for any company, any language, any domain.

const EMAIL_RE = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;
const MENTION_RE = /@([a-zA-Z][a-zA-Z0-9_-]{1,38})\b/g;

// ─── Entity Extraction ────────────────────────────────────────

export interface DeterministicContext {
  /** Known entity names to match against */
  knownEntities?: Map<string, { id: string; type: string }>;
}

export function extractEntitiesDeterministic(
  text: string,
  context?: DeterministicContext,
): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  // 1. Match against known entities already in the graph (highest confidence)
  // This is the most valuable deterministic signal — if we already know
  // about an entity, we can recognize it instantly without the LLM.
  if (context?.knownEntities) {
    for (const [name, info] of context.knownEntities) {
      if (text.toLowerCase().includes(name.toLowerCase()) && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        entities.push({
          name,
          entityType: info.type,
          confidence: 0.95,
        });
      }
    }
  }

  // 2. Extract emails — structural format, not content interpretation
  for (const match of text.matchAll(EMAIL_RE)) {
    const email = match[1];
    const namePart = email.split('@')[0].replace(/[._-]/g, ' ');
    if (!seen.has(email.toLowerCase())) {
      seen.add(email.toLowerCase());
      entities.push({
        name: namePart,
        entityType: 'person',
        attributes: { email },
        confidence: 0.7,
      });
    }
  }

  // 3. Extract @mentions — structural format (platform handles)
  for (const match of text.matchAll(MENTION_RE)) {
    const handle = match[1];
    if (!seen.has(handle.toLowerCase())) {
      seen.add(handle.toLowerCase());
      entities.push({
        name: handle,
        entityType: 'person',
        attributes: { handle: `@${handle}` },
        confidence: 0.6,
      });
    }
  }

  return entities;
}

// ─── Fact Extraction ──────────────────────────────────────────

/**
 * Deterministic fact extraction. Currently returns empty — all relationship
 * extraction is handled by the LLM, which has the graph context needed
 * to correctly type and map relationships.
 *
 * The deterministic layer only provides entity candidates (emails, handles,
 * known entities) that seed the graph context retrieval for the LLM.
 */
export function extractFactsDeterministic(
  _text: string,
  _entities: ExtractedEntity[],
): ExtractedFact[] {
  return [];
}

// ─── Confidence Assessment ────────────────────────────────────

/**
 * Assess whether deterministic extraction was sufficient or if LLM
 * fallback is needed. Returns a confidence score for the overall extraction.
 */
export function assessExtractionConfidence(
  text: string,
  entities: ExtractedEntity[],
  _facts: ExtractedFact[],
): number {
  const wordCount = text.split(/\s+/).length;
  const entityDensity = entities.length / Math.max(wordCount / 100, 1);

  // Structured text (short, high entity density) → high confidence
  if (wordCount < 50 && entities.length > 0) return 0.9;

  // Very long text with few entities → probably missing things
  if (wordCount > 200 && entities.length < 2) return 0.3;

  const avgConfidence = entities.length > 0
    ? entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length
    : 0;

  return Math.min(0.95, (entityDensity * 0.3 + avgConfidence * 0.7));
}
