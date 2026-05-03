/**
 * The Fail-Improve Loop.
 *
 * Logs extraction behavior so the system can improve prompts, schemas, evals,
 * and review policy over time. It does not generate deterministic semantic
 * regex rules; meaning extraction stays LLM-first.
 *
 * This is what makes the system get smarter over time without manual intervention.
 */

import type postgres from 'postgres';
import type { ExtractionResult, ImprovementProposal } from '../types.js';

export interface FailImproveStats {
  totalExtractions: number;
  deterministicHits: number;
  llmFallbacks: number;
  deterministicRate: number;
  topMissPatterns: Array<{ pattern: string; count: number }>;
}

/**
 * Log an extraction attempt to the database.
 */
export async function logExtraction(
  db: postgres.Sql,
  groupId: string,
  episodeId: string | null,
  result: ExtractionResult,
  inputPreview: string,
): Promise<void> {
  await db`
    INSERT INTO extraction_log (group_id, episode_id, method, input_preview, entities_extracted, facts_extracted, confidence, duration_ms)
    VALUES (
      ${groupId},
      ${episodeId},
      ${result.method},
      ${inputPreview.slice(0, 500)},
      ${JSON.stringify(result.entities)},
      ${JSON.stringify(result.facts)},
      ${result.entities.length > 0 ? result.entities.reduce((s, e) => s + e.confidence, 0) / result.entities.length : 0},
      ${result.durationMs}
    )
  `;
}

/**
 * Get fail-improve statistics for a group.
 */
export async function getStats(
  db: postgres.Sql,
  groupId: string,
  since?: Date,
): Promise<FailImproveStats> {
  const sinceDate = since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days

  const stats = await db`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE method = 'deterministic') AS deterministic,
      COUNT(*) FILTER (WHERE method = 'llm') AS llm,
      COUNT(*) FILTER (WHERE method = 'hybrid') AS hybrid
    FROM extraction_log
    WHERE group_id = ${groupId}
      AND created_at > ${sinceDate}
  `;

  const total = Number(stats[0].total);
  const deterministic = Number(stats[0].deterministic);
  const llm = Number(stats[0].llm);

  // Find common input clusters in LLM-only extractions (these are improvement opportunities).
  const missPatterns = await db`
    SELECT
      SUBSTRING(input_preview FROM 1 FOR 100) AS pattern,
      COUNT(*) AS cnt
    FROM extraction_log
    WHERE group_id = ${groupId}
      AND method = 'llm'
      AND created_at > ${sinceDate}
    GROUP BY SUBSTRING(input_preview FROM 1 FOR 100)
    ORDER BY cnt DESC
    LIMIT 10
  `;

  return {
    totalExtractions: total,
    deterministicHits: deterministic,
    llmFallbacks: llm,
    deterministicRate: total > 0 ? deterministic / total : 0,
    topMissPatterns: missPatterns.map(r => ({
      pattern: r.pattern,
      count: Number(r.cnt),
    })),
  };
}

/**
 * Analyze LLM extraction logs and suggest prompt/schema/eval improvements.
 */
export async function suggestPatterns(
  db: postgres.Sql,
  groupId: string,
  minOccurrences: number = 3,
): Promise<Array<{ entityType: string; suggestedImprovement: string; examples: string[]; occurrences: number }>> {
  const llmExtractions = await db`
    SELECT entities_extracted, input_preview
    FROM extraction_log
    WHERE group_id = ${groupId}
      AND method = 'llm'
      AND confidence > 0.7
    ORDER BY created_at DESC
    LIMIT 500
  `;

  const byType = new Map<string, string[]>();

  for (const row of llmExtractions) {
    const entities = row.entities_extracted as any[];
    for (const entity of entities) {
      if (!entity.name || !entity.entityType) continue;
      const type = entity.entityType;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(String(row.input_preview || '').slice(0, 300));
    }
  }

  const suggestions: Array<{ entityType: string; suggestedImprovement: string; examples: string[]; occurrences: number }> = [];
  for (const [entityType, examples] of byType) {
    if (examples.length >= minOccurrences) {
      suggestions.push({
        entityType,
        suggestedImprovement: `Review ontology description, examples, and eval coverage for entity type "${entityType}".`,
        examples: examples.slice(0, 5),
        occurrences: examples.length,
      });
    }
  }

  return suggestions.sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Generate audited improvement proposals from extraction logs and review queue
 * signals. These are suggestions only; callers should route them through human
 * or agent review before changing schemas or skills.
 */
export async function proposeImprovements(
  db: postgres.Sql,
  groupId: string,
): Promise<ImprovementProposal[]> {
  const proposals: ImprovementProposal[] = [];

  const [patterns, reviewCounts] = await Promise.all([
    suggestPatterns(db, groupId, 3).catch(() => []),
    db`
      SELECT review_type, payload->>'reason' AS reason, COUNT(*) AS cnt
      FROM graph_review_queue
      WHERE group_id = ${groupId}
        AND status = 'pending'
      GROUP BY review_type, payload->>'reason'
      ORDER BY cnt DESC
      LIMIT 20
    `.catch(() => []),
  ]);

  for (const pattern of patterns.slice(0, 10)) {
    proposals.push({
      id: `extraction-improvement:${pattern.entityType}`,
      kind: 'extraction',
      title: `Improve extraction guidance for ${pattern.entityType}`,
      rationale: `The LLM repeatedly extracted ${pattern.entityType} entities; improve schema descriptions, prompt examples, or eval coverage rather than adding regex rules.`,
      confidence: Math.min(0.9, 0.5 + pattern.occurrences / 20),
      evidence: {
        examples: pattern.examples,
        occurrences: pattern.occurrences,
      },
      proposedAction: {
        type: 'review_extraction_guidance',
        entityType: pattern.entityType,
        suggestion: pattern.suggestedImprovement,
      },
    });
  }

  for (const row of reviewCounts) {
    const count = Number(row.cnt);
    const reason = row.reason || 'unknown';
    const reviewType = row.review_type;

    if (reviewType === 'entity_resolution') {
      proposals.push({
        id: `canonicalization:${reason}`,
        kind: 'canonicalization',
        title: 'Review ambiguous entity canonicalization rules',
        rationale: `${count} pending entity resolution review item(s) share reason "${reason}".`,
        confidence: Math.min(0.85, 0.45 + count / 20),
        evidence: { reason, count },
        proposedAction: {
          type: 'review_entity_resolution_thresholds',
          reason,
        },
      });
    } else if (reviewType === 'fact_resolution') {
      proposals.push({
        id: `schema:${reason}`,
        kind: 'schema',
        title: 'Review schema coverage for unresolved facts',
        rationale: `${count} pending fact resolution review item(s) indicate extraction produced facts that could not be grounded.`,
        confidence: Math.min(0.85, 0.45 + count / 20),
        evidence: { reason, count },
        proposedAction: {
          type: 'review_schema_or_aliases',
          reason,
        },
      });
    }
  }

  return proposals.sort((a, b) => b.confidence - a.confidence);
}
