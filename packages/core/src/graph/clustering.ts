import type postgres from 'postgres';

export interface ClusterOptions {
  groupId: string;
  minConfidence?: number;
  limit?: number;
  autoApplyThreshold?: number;
  ambiguousThreshold?: number;
  enqueueReview?: boolean;
}

export interface CanonicalCluster {
  id?: string;
  groupId: string;
  clusterType: 'entity' | 'relation';
  canonicalId: string;
  memberIds: string[];
  confidence: number;
  rationale: string;
  metadata: Record<string, unknown>;
}

export interface CanonicalizationPolicyResult {
  applied: CanonicalCluster[];
  ambiguous: CanonicalCluster[];
  telemetry: CanonicalCluster[];
  summary: {
    applied: number;
    ambiguous: number;
    telemetry: number;
    policy: {
      autoApplyThreshold: number;
      ambiguousThreshold: number;
    };
  };
}

interface EntityClusterRow {
  id: string;
  name: string;
  entity_type: string;
  aliases: string[];
}

export async function proposeEntityClusters(
  db: postgres.Sql,
  options: ClusterOptions,
): Promise<CanonicalCluster[]> {
  const { groupId, minConfidence = 0.82, limit = 100, enqueueReview = false } = options;
  const entities = await db<EntityClusterRow[]>`
    SELECT
      e.id,
      e.name,
      e.entity_type,
      COALESCE(array_agg(ea.alias) FILTER (WHERE ea.alias IS NOT NULL), '{}') AS aliases
    FROM entities e
    LEFT JOIN entity_aliases ea ON ea.entity_id = e.id
    WHERE e.group_id = ${groupId}
    GROUP BY e.id
    LIMIT ${limit * 5}
  `;

  const clusters: CanonicalCluster[] = [];
  const visited = new Set<string>();
  for (const entity of entities) {
    if (visited.has(entity.id)) continue;
    const candidates = entities
      .filter(candidate => candidate.id !== entity.id && candidate.entity_type === entity.entity_type)
      .map(candidate => ({
        candidate,
        score: entitySimilarity(entity, candidate),
      }))
      .filter(candidate => candidate.score >= minConfidence)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) continue;
    const members = [entity, ...candidates.map(candidate => candidate.candidate)];
    for (const member of members) visited.add(member.id);
    const canonical = chooseCanonicalEntity(members);
    const confidence = Math.min(0.99, candidates.reduce((sum, c) => sum + c.score, 0) / candidates.length);

    clusters.push({
      groupId,
      clusterType: 'entity',
      canonicalId: canonical.id,
      memberIds: members.map(member => member.id),
      confidence,
      rationale: `Clustered ${members.length} ${entity.entity_type} entities by normalized name/alias similarity.`,
      metadata: {
        entityType: entity.entity_type,
        memberNames: members.map(member => member.name),
        method: 'lexical_alias_connected_components',
      },
    });
  }

  const persisted = clusters.slice(0, limit);
  if (enqueueReview) {
    for (const cluster of persisted) {
      await persistCluster(db, cluster, 'proposed');
    }
  }
  return persisted;
}

export async function proposeRelationClusters(
  db: postgres.Sql,
  options: ClusterOptions,
): Promise<CanonicalCluster[]> {
  const { groupId, minConfidence = 0.78, limit = 100, enqueueReview = false } = options;
  const rows = await db<Array<{ relation: string; examples: string[] }>>`
    SELECT relation, array_agg(fact_text ORDER BY confidence DESC) AS examples
    FROM facts
    WHERE group_id = ${groupId}
    GROUP BY relation
    LIMIT ${limit * 5}
  `;

  const clusters: CanonicalCluster[] = [];
  const visited = new Set<string>();
  for (const row of rows) {
    if (visited.has(row.relation)) continue;
    const candidates = rows
      .filter(candidate => candidate.relation !== row.relation)
      .map(candidate => ({
        candidate,
        score: tokenSimilarity(row.relation, candidate.relation),
      }))
      .filter(candidate => candidate.score >= minConfidence)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) continue;
    const members = [row, ...candidates.map(candidate => candidate.candidate)];
    for (const member of members) visited.add(member.relation);
    const canonical = members.map(member => member.relation).sort((a, b) => a.length - b.length)[0];

    clusters.push({
      groupId,
      clusterType: 'relation',
      canonicalId: canonical,
      memberIds: members.map(member => member.relation),
      confidence: Math.min(0.99, candidates.reduce((sum, c) => sum + c.score, 0) / candidates.length),
      rationale: 'Clustered relation labels by lexical similarity for ontology cleanup.',
      metadata: {
        examples: Object.fromEntries(members.map(member => [member.relation, member.examples?.slice(0, 3) || []])),
        method: 'relation_label_similarity',
      },
    });
  }

  const persisted = clusters.slice(0, limit);
  if (enqueueReview) {
    for (const cluster of persisted) {
      await persistCluster(db, cluster, 'proposed');
    }
  }
  return persisted;
}

export async function proposeCanonicalClusters(
  db: postgres.Sql,
  options: ClusterOptions,
): Promise<CanonicalCluster[]> {
  const result = await processCanonicalClusters(db, options);
  return [...result.applied, ...result.ambiguous, ...result.telemetry];
}

export async function processCanonicalClusters(
  db: postgres.Sql,
  options: ClusterOptions,
): Promise<CanonicalizationPolicyResult> {
  const autoApplyThreshold = options.autoApplyThreshold ?? 0.92;
  const ambiguousThreshold = options.ambiguousThreshold ?? 0.75;
  const [entityClusters, relationClusters] = await Promise.all([
    proposeEntityClusters(db, { ...options, enqueueReview: false }),
    proposeRelationClusters(db, { ...options, enqueueReview: false }),
  ]);
  const clusters = [...entityClusters, ...relationClusters];
  const applied: CanonicalCluster[] = [];
  const ambiguous: CanonicalCluster[] = [];
  const telemetry: CanonicalCluster[] = [];

  for (const cluster of clusters) {
    if (cluster.confidence >= autoApplyThreshold) {
      await applyCanonicalCluster(db, cluster);
      await persistCluster(db, cluster, 'applied');
      applied.push(cluster);
    } else if (cluster.confidence >= ambiguousThreshold) {
      cluster.metadata = {
        ...cluster.metadata,
        decision: 'ambiguous_returned_inline',
        policy: { autoApplyThreshold, ambiguousThreshold },
      };
      ambiguous.push(cluster);
      await auditCanonicalization(db, cluster, 'ambiguous_inline');
    } else {
      cluster.metadata = {
        ...cluster.metadata,
        decision: 'telemetry_only',
        policy: { autoApplyThreshold, ambiguousThreshold },
      };
      telemetry.push(cluster);
      await auditCanonicalization(db, cluster, 'telemetry_only');
    }
  }

  return {
    applied,
    ambiguous,
    telemetry,
    summary: {
      applied: applied.length,
      ambiguous: ambiguous.length,
      telemetry: telemetry.length,
      policy: { autoApplyThreshold, ambiguousThreshold },
    },
  };
}

async function persistCluster(
  db: postgres.Sql,
  cluster: CanonicalCluster,
  statusOrEnqueueReview: 'proposed' | 'approved' | 'rejected' | 'applied' | boolean = 'proposed',
): Promise<void> {
  const status = typeof statusOrEnqueueReview === 'boolean' ? 'proposed' : statusOrEnqueueReview;
  const rows = await db`
    INSERT INTO canonical_clusters (
      group_id, cluster_type, canonical_id, member_ids, confidence, status, rationale, metadata
    )
    VALUES (
      ${cluster.groupId},
      ${cluster.clusterType},
      ${cluster.canonicalId},
      ${cluster.memberIds},
      ${cluster.confidence},
      ${status},
      ${cluster.rationale},
      ${JSON.stringify(cluster.metadata)}
    )
    RETURNING id
  `.catch(() => []);
  cluster.id = rows[0]?.id;
}

async function applyCanonicalCluster(db: postgres.Sql, cluster: CanonicalCluster): Promise<void> {
  if (cluster.clusterType === 'entity') {
    await applyEntityCluster(db, cluster);
  } else {
    await applyRelationCluster(db, cluster);
  }
  await auditCanonicalization(db, cluster, 'auto_applied');
}

async function applyEntityCluster(db: postgres.Sql, cluster: CanonicalCluster): Promise<void> {
  const duplicateIds = cluster.memberIds.filter(id => id !== cluster.canonicalId);
  if (duplicateIds.length === 0) return;

  const duplicateRows = await db<Array<{ id: string; name: string; attributes: Record<string, unknown>; summary: string }>>`
    SELECT id, name, attributes, summary
    FROM entities
    WHERE group_id = ${cluster.groupId}
      AND id = ANY(${duplicateIds})
  `.catch(() => []);

  await db`
    UPDATE facts
    SET source_entity_id = ${cluster.canonicalId}
    WHERE group_id = ${cluster.groupId}
      AND source_entity_id = ANY(${duplicateIds})
  `.catch(() => {});

  await db`
    UPDATE facts
    SET target_entity_id = ${cluster.canonicalId}
    WHERE group_id = ${cluster.groupId}
      AND target_entity_id = ANY(${duplicateIds})
  `.catch(() => {});

  for (const row of duplicateRows) {
    await db`
      INSERT INTO entity_aliases (entity_id, alias, alias_type)
      VALUES (${cluster.canonicalId}, ${row.name}, 'canonicalized')
      ON CONFLICT (entity_id, alias) DO NOTHING
    `.catch(() => {});
  }

  const mergedAttributes = Object.assign(
    {},
    ...duplicateRows.map(row => row.attributes || {}),
    {
      canonicalizedFrom: duplicateRows.map(row => ({ id: row.id, name: row.name })),
    },
  );

  await db`
    UPDATE entities
    SET attributes = attributes || ${JSON.stringify(mergedAttributes)}::jsonb,
        updated_at = now()
    WHERE id = ${cluster.canonicalId}
      AND group_id = ${cluster.groupId}
  `.catch(() => {});

  await db`
    DELETE FROM entities
    WHERE group_id = ${cluster.groupId}
      AND id = ANY(${duplicateIds})
  `.catch(() => {});
}

async function applyRelationCluster(db: postgres.Sql, cluster: CanonicalCluster): Promise<void> {
  const duplicateRelations = cluster.memberIds.filter(id => id !== cluster.canonicalId);
  if (duplicateRelations.length === 0) return;

  await db`
    UPDATE facts
    SET relation = ${cluster.canonicalId},
        metadata = metadata || ${JSON.stringify({ canonicalizedRelationFrom: duplicateRelations })}::jsonb
    WHERE group_id = ${cluster.groupId}
      AND relation = ANY(${duplicateRelations})
  `.catch(() => {});
}

async function auditCanonicalization(
  db: postgres.Sql,
  cluster: CanonicalCluster,
  action: 'auto_applied' | 'ambiguous_inline' | 'telemetry_only',
): Promise<void> {
  await db`
    INSERT INTO audit_log (group_id, action, resource_type, resource_id, metadata)
    VALUES (
      ${cluster.groupId},
      ${`canonicalization_${action}`},
      ${cluster.clusterType},
      ${cluster.canonicalId},
      ${JSON.stringify({
        memberIds: cluster.memberIds,
        confidence: cluster.confidence,
        rationale: cluster.rationale,
        metadata: cluster.metadata,
      })}
    )
  `.catch(() => {});
}

function chooseCanonicalEntity(entities: EntityClusterRow[]): EntityClusterRow {
  return [...entities].sort((a, b) => {
    const aliasDelta = (b.aliases?.length || 0) - (a.aliases?.length || 0);
    if (aliasDelta !== 0) return aliasDelta;
    return a.name.length - b.name.length;
  })[0];
}

function entitySimilarity(a: EntityClusterRow, b: EntityClusterRow): number {
  const namesA = [a.name, ...(a.aliases || [])].map(normalizeName);
  const namesB = [b.name, ...(b.aliases || [])].map(normalizeName);
  let best = 0;
  for (const left of namesA) {
    for (const right of namesB) {
      best = Math.max(best, tokenSimilarity(left, right));
    }
  }
  return best;
}

function tokenSimilarity(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter(token => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  const jaccard = intersection / union;
  const exact = normalizeName(a) === normalizeName(b) ? 1 : 0;
  return Math.max(jaccard, exact);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenize(value: string): string[] {
  return normalizeName(value).split(/\s+/).filter(token => token.length > 1);
}
