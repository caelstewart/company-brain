import { describe, expect, it } from 'vitest';
import { processCanonicalClusters } from '../src/index.js';

describe('active canonicalization policy', () => {
  it('auto-applies high-confidence clusters without queueing review items', async () => {
    const calls: string[] = [];
    const db = fakeDb(calls);

    const result = await processCanonicalClusters(db, {
      groupId: 'test',
      minConfidence: 0.8,
      autoApplyThreshold: 0.9,
    });

    expect(result.summary.applied).toBe(1);
    expect(result.applied[0].confidence).toBe(0.99);
    expect(calls.some(sql => sql.includes('UPDATE facts'))).toBe(true);
    expect(calls.some(sql => sql.includes('DELETE FROM entities'))).toBe(true);
    expect(calls.some(sql => sql.includes('graph_review_queue'))).toBe(false);
  });

  it('returns ambiguous clusters inline instead of persisting a passive backlog', async () => {
    const calls: string[] = [];
    const db = fakeDb(calls);

    const result = await processCanonicalClusters(db, {
      groupId: 'test',
      minConfidence: 0.8,
      autoApplyThreshold: 1.1,
      ambiguousThreshold: 0.9,
    });

    expect(result.summary.applied).toBe(0);
    expect(result.summary.ambiguous).toBe(1);
    expect(result.ambiguous[0].metadata.decision).toBe('ambiguous_returned_inline');
    expect(calls.some(sql => sql.includes('graph_review_queue'))).toBe(false);
    expect(calls.some(sql => sql.includes('INSERT INTO audit_log'))).toBe(true);
  });

  it('logs low-confidence clusters as telemetry only', async () => {
    const calls: string[] = [];
    const db = fakeDb(calls);

    const result = await processCanonicalClusters(db, {
      groupId: 'test',
      minConfidence: 0.8,
      autoApplyThreshold: 1.1,
      ambiguousThreshold: 1.1,
    });

    expect(result.summary.telemetry).toBe(1);
    expect(result.telemetry[0].metadata.decision).toBe('telemetry_only');
    expect(calls.some(sql => sql.includes('INSERT INTO audit_log'))).toBe(true);
    expect(calls.some(sql => sql.includes('graph_review_queue'))).toBe(false);
  });
});

function fakeDb(calls: string[]) {
  return (async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    calls.push(sql);

    if (sql.includes('LEFT JOIN entity_aliases')) {
      return [
        { id: 'e1', name: 'Acme Corp', entity_type: 'company', aliases: [] },
        { id: 'e2', name: 'Acme Corp', entity_type: 'company', aliases: [] },
      ];
    }

    if (sql.includes('SELECT relation, array_agg')) {
      return [];
    }

    if (sql.includes('SELECT id, name, attributes, summary')) {
      return [
        { id: 'e2', name: 'Acme Corp', attributes: { source: 'duplicate' }, summary: '' },
      ];
    }

    if (sql.includes('RETURNING id')) {
      return [{ id: 'cluster-1' }];
    }

    return [];
  }) as any;
}
