/**
 * The Fail-Improve Loop.
 *
 * Core insight from gbrain: try deterministic first, fall back to LLM,
 * and LOG every fallback. Over time, analyze the logs to generate better
 * deterministic rules, reducing LLM dependency and cost.
 *
 * This is what makes the system get smarter over time without manual intervention.
 */

import type postgres from 'postgres';
import type { ExtractionResult } from '../types.js';

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
 * Shows how the deterministic extraction rate is improving over time.
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

  // Find common patterns in LLM-only extractions (these are improvement opportunities)
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
 * Analyze LLM extraction logs and suggest new deterministic patterns.
 *
 * Looks for recurring patterns in LLM-successful extractions and
 * generates regex patterns that could handle them deterministically.
 *
 * Returns suggested patterns that a developer can review and approve.
 */
export async function suggestPatterns(
  db: postgres.Sql,
  groupId: string,
  minOccurrences: number = 3,
): Promise<Array<{ entityType: string; suggestedPattern: string; examples: string[]; occurrences: number }>> {
  // Find entity types that are consistently extracted by LLM
  const llmExtractions = await db`
    SELECT entities_extracted, input_preview
    FROM extraction_log
    WHERE group_id = ${groupId}
      AND method = 'llm'
      AND confidence > 0.7
    ORDER BY created_at DESC
    LIMIT 500
  `;

  // Group by entity type and look for common surrounding text patterns
  const typePatterns = new Map<string, Map<string, string[]>>();

  for (const row of llmExtractions) {
    const entities = row.entities_extracted as any[];
    for (const entity of entities) {
      if (!entity.name || !entity.entityType) continue;

      const type = entity.entityType;
      if (!typePatterns.has(type)) typePatterns.set(type, new Map());

      // Find the surrounding context of the entity mention in the input
      const input = row.input_preview as string;
      const idx = input.toLowerCase().indexOf(entity.name.toLowerCase());
      if (idx >= 0) {
        const before = input.slice(Math.max(0, idx - 30), idx).trim();
        const after = input.slice(idx + entity.name.length, idx + entity.name.length + 30).trim();
        const contextKey = `${before.slice(-15)}___${after.slice(0, 15)}`;

        const map = typePatterns.get(type)!;
        if (!map.has(contextKey)) map.set(contextKey, []);
        map.get(contextKey)!.push(entity.name);
      }
    }
  }

  // Filter to patterns with enough occurrences
  const suggestions: Array<{ entityType: string; suggestedPattern: string; examples: string[]; occurrences: number }> = [];

  for (const [entityType, patterns] of typePatterns) {
    for (const [context, examples] of patterns) {
      if (examples.length >= minOccurrences) {
        const [before, after] = context.split('___');
        const escapedBefore = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedAfter = after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        suggestions.push({
          entityType,
          suggestedPattern: `/${escapedBefore}([A-Z][a-zA-Z\\s]+)${escapedAfter}/g`,
          examples: examples.slice(0, 5),
          occurrences: examples.length,
        });
      }
    }
  }

  return suggestions.sort((a, b) => b.occurrences - a.occurrences);
}
