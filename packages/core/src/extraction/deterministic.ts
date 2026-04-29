/**
 * Layer 1: Deterministic extraction.
 *
 * Extracts entities and relationships using regex, structured data parsing,
 * and known-entity matching. Zero LLM calls. Runs in <10ms.
 *
 * This is the "fast path" that handles 80%+ of extractions once the system
 * has learned common patterns via the fail-improve loop.
 */

import type { ExtractedEntity, ExtractedFact, ExtractionHints } from '../types.js';

// ─── Built-in Patterns ────────────────────────────────────────

const EMAIL_RE = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;
const MENTION_RE = /@([a-zA-Z][a-zA-Z0-9_-]{1,38})\b/g;
const URL_RE = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
const PHONE_RE = /\b(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b/g;

// Role/title patterns that imply person + company relationships
const ROLE_PATTERNS = [
  /(?:(?:CEO|CTO|CFO|COO|VP|Director|Head|Lead|Manager|Engineer|Designer|Founder|Co-founder)\s+(?:of|at)\s+)([A-Z][a-zA-Z0-9\s&.-]+)/g,
  /([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*)\s*,\s*(?:CEO|CTO|CFO|COO|VP|Director|Head|Lead|Manager|Engineer|Designer|Founder|Co-founder)\s+(?:of|at)\s+([A-Z][a-zA-Z0-9\s&.-]+)/g,
];

// Decision/action patterns
const DECISION_RE = /(?:we\s+)?(?:decided|agreed|resolved|committed)\s+(?:to\s+)?(.{10,100}?)(?:\.|$)/gi;
const ACTION_RE = /(?:TODO|Action|Next step|Follow.up)[\s:]+(.{10,100}?)(?:\.|$)/gi;

// Date patterns for temporal inference
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const RELATIVE_DATE_RE = /\b(today|yesterday|last\s+(?:week|month|year)|this\s+(?:week|month|year))\b/gi;

// ─── Entity Extraction ────────────────────────────────────────

export interface DeterministicContext {
  /** Known entity names to match against */
  knownEntities?: Map<string, { id: string; type: string }>;
  /** Custom extraction hints from schema definition */
  hints?: ExtractionHints;
  /** Custom patterns registered via fail-improve loop */
  learnedPatterns?: Map<string, RegExp[]>;
}

export function extractEntitiesDeterministic(
  text: string,
  context?: DeterministicContext,
): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  // 1. Match against known entities (highest confidence)
  if (context?.knownEntities) {
    for (const [name, info] of context.knownEntities) {
      // Case-insensitive word boundary match
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(text) && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        entities.push({
          name,
          entityType: info.type,
          confidence: 0.95,
        });
      }
    }
  }

  // 2. Extract emails → person entities
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

  // 3. Extract @mentions → person entities
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

  // 4. Role/title patterns → person + company
  for (const pattern of ROLE_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.length >= 3) {
        const personName = match[1].trim();
        const companyName = match[2].trim();
        if (!seen.has(personName.toLowerCase())) {
          seen.add(personName.toLowerCase());
          entities.push({ name: personName, entityType: 'person', confidence: 0.8 });
        }
        if (!seen.has(companyName.toLowerCase())) {
          seen.add(companyName.toLowerCase());
          entities.push({ name: companyName, entityType: 'company', confidence: 0.8 });
        }
      }
    }
  }

  // 5. Apply custom hints
  if (context?.hints) {
    for (const [entityType, hint] of Object.entries(context.hints)) {
      if (hint.patterns) {
        for (const pattern of hint.patterns) {
          const re = new RegExp(pattern.source, pattern.flags || 'g');
          for (const match of text.matchAll(re)) {
            const name = match[1] || match[0];
            if (!seen.has(name.toLowerCase())) {
              seen.add(name.toLowerCase());
              entities.push({ name, entityType, confidence: 0.75 });
            }
          }
        }
      }
    }
  }

  // 6. Apply learned patterns from fail-improve loop
  if (context?.learnedPatterns) {
    for (const [entityType, patterns] of context.learnedPatterns) {
      for (const pattern of patterns) {
        const re = new RegExp(pattern.source, pattern.flags || 'g');
        for (const match of text.matchAll(re)) {
          const name = match[1] || match[0];
          if (!seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            entities.push({ name, entityType, confidence: 0.7 });
          }
        }
      }
    }
  }

  return entities;
}

// ─── Fact Extraction ──────────────────────────────────────────

export function extractFactsDeterministic(
  text: string,
  entities: ExtractedEntity[],
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // Extract role-based relationships (person works_at company)
  const roleRe = /([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*)\s*(?:,\s*)?(?:CEO|CTO|CFO|COO|VP|Director|Head|Lead|Manager|Engineer|Designer|Founder|Co-founder)\s+(?:of|at)\s+([A-Z][a-zA-Z0-9\s&.-]+)/g;
  for (const match of text.matchAll(roleRe)) {
    const personName = match[1].trim();
    const companyName = match[2].trim();
    const role = match[0].match(/(?:CEO|CTO|CFO|COO|VP|Director|Head|Lead|Manager|Engineer|Designer|Founder|Co-founder)/i)?.[0] || '';

    const relation = role.toLowerCase().includes('founder') ? 'founded' : 'works_at';
    facts.push({
      sourceName: personName,
      targetName: companyName,
      relation,
      factText: `${personName} is ${role} at ${companyName}`,
      confidence: 0.85,
    });
  }

  // Extract decisions
  DECISION_RE.lastIndex = 0;
  for (const match of text.matchAll(DECISION_RE)) {
    const decision = match[1].trim();
    if (decision.length > 10) {
      facts.push({
        sourceName: '__context__',
        targetName: decision,
        relation: 'decided',
        factText: `Decision: ${decision}`,
        confidence: 0.6,
      });
    }
  }

  return facts;
}

// ─── Confidence Assessment ────────────────────────────────────

/**
 * Assess whether deterministic extraction was sufficient or if LLM
 * fallback is needed. Returns a confidence score for the overall extraction.
 */
export function assessExtractionConfidence(
  text: string,
  entities: ExtractedEntity[],
  facts: ExtractedFact[],
): number {
  // Heuristics for when deterministic is insufficient:
  // - Long text with few entities found → likely missing things
  // - Narrative text (many sentences) vs structured (emails, tickets)
  // - Low average confidence across found entities

  const wordCount = text.split(/\s+/).length;
  const sentenceCount = text.split(/[.!?]+/).length;
  const entityDensity = entities.length / Math.max(wordCount / 100, 1);

  // Structured text (short, high entity density) → high confidence
  if (wordCount < 50 && entities.length > 0) return 0.9;

  // Very long narrative with few entities → probably missing things
  if (wordCount > 200 && entities.length < 2) return 0.3;

  // Average entity confidence
  const avgConfidence = entities.length > 0
    ? entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length
    : 0;

  // Blend: entity density + average confidence
  return Math.min(0.95, (entityDensity * 0.3 + avgConfidence * 0.7));
}
