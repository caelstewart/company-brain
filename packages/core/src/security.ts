import type postgres from 'postgres';
import type { AccessContext, PermissionSimulation, SourceAclEntry, VisibilityPolicy } from './types.js';

const EMPTY_VISIBILITY: VisibilityPolicy = {};

export function normalizeVisibility(input?: VisibilityPolicy | string | null): VisibilityPolicy {
  if (typeof input === 'string') {
    try {
      return normalizeVisibility(JSON.parse(input) as VisibilityPolicy);
    } catch {
      return EMPTY_VISIBILITY;
    }
  }
  if (!input || typeof input !== 'object') return EMPTY_VISIBILITY;
  const classification = typeof input.classification === 'string' ? input.classification : undefined;
  return {
    allowedPrincipals: cleanStringArray(input.allowedPrincipals),
    deniedPrincipals: cleanStringArray(input.deniedPrincipals),
    allowedGroups: cleanStringArray(input.allowedGroups),
    deniedGroups: cleanStringArray(input.deniedGroups),
    classification,
    inheritedFrom: typeof input.inheritedFrom === 'string' ? input.inheritedFrom : undefined,
    sourceSystem: typeof input.sourceSystem === 'string' ? input.sourceSystem : undefined,
    sourceAcl: Array.isArray(input.sourceAcl) ? input.sourceAcl.filter(isSourceAclEntry) : undefined,
  };
}

export function visibilityWarnings(visibility?: VisibilityPolicy | null): string[] {
  const policy = normalizeVisibility(visibility);
  const warnings: string[] = [];
  if (!policy.classification) return warnings;
  const normalized = normalizeClassification(policy.classification);
  const hasAcl = !isPublicVisibility(policy);

  if (looksRestrictedClassification(normalized) && !hasAcl) {
    warnings.push(`Classification "${policy.classification}" looks restricted but has no explicit allow/deny policy.`);
  }

  return warnings;
}

export function isPublicVisibility(visibility?: VisibilityPolicy | null): boolean {
  const normalized = normalizeVisibility(visibility);
  return (
    (normalized.allowedPrincipals?.length ?? 0) === 0 &&
    (normalized.deniedPrincipals?.length ?? 0) === 0 &&
    (normalized.allowedGroups?.length ?? 0) === 0 &&
    (normalized.deniedGroups?.length ?? 0) === 0 &&
    (normalized.sourceAcl?.length ?? 0) === 0
  );
}

export function accessPrincipals(access?: AccessContext): string[] {
  if (!access) return [];
  return cleanStringArray([
    access.principalId,
    ...(access.principalIds || []),
    ...(access.roles || []).map(role => `role:${role}`),
    ...Object.entries(access.sourceAccounts || {}).map(([provider, id]) => `${provider}:user:${id}`),
  ]);
}

export function accessGroups(access?: AccessContext): string[] {
  return cleanStringArray(access?.groups || []);
}

export function canAccessVisibility(visibility?: VisibilityPolicy | null, access?: AccessContext): boolean {
  return simulatePermission(visibility, access).allowed;
}

export function simulatePermission(
  visibility?: VisibilityPolicy | null,
  access?: AccessContext,
): PermissionSimulation {
  const policy = normalizeVisibility(visibility);

  if (access?.bypass) {
    return {
      allowed: true,
      reason: 'Bypass enabled',
      visibility: policy,
    };
  }

  if (!access) {
    const allowed = isPublicVisibility(policy);
    return {
      allowed,
      reason: allowed
        ? 'No access context supplied; public visibility only'
        : 'No access context supplied; restricted visibility requires matching access',
      visibility: policy,
    };
  }

  const principals = new Set(accessPrincipals(access));
  const groups = new Set(accessGroups(access));
  const sourceMatches = sourceAclMatches(policy.sourceAcl, access);
  const matchedDeny = [
    ...(policy.deniedPrincipals || []).filter(p => principals.has(p)),
    ...(policy.deniedGroups || []).filter(g => groups.has(g)),
    ...sourceMatches.denied,
  ];

  if (matchedDeny.length > 0) {
    return {
      allowed: false,
      reason: 'Matched explicit deny policy',
      matchedDeny,
      visibility: policy,
    };
  }

  const hasPrincipalAllowList = (policy.allowedPrincipals?.length ?? 0) > 0;
  const hasGroupAllowList = (policy.allowedGroups?.length ?? 0) > 0;
  const hasSourceAllowList = (policy.sourceAcl || []).some(entry => entry.access === 'allow');
  if (!hasPrincipalAllowList && !hasGroupAllowList && !hasSourceAllowList) {
    return {
      allowed: true,
      reason: 'No allow list present',
      visibility: policy,
    };
  }

  const matchedAllow = [
    ...(policy.allowedPrincipals || []).filter(p => principals.has(p)),
    ...(policy.allowedGroups || []).filter(g => groups.has(g)),
    ...sourceMatches.allowed,
  ];
  return {
    allowed: matchedAllow.length > 0,
    reason: matchedAllow.length > 0 ? 'Matched allow policy' : 'No allow policy matched',
    matchedAllow,
    visibility: policy,
  };
}

export function visibilityFromSourcePermissions(input: {
  provider: string;
  workspaceId?: string;
  channelId?: string;
  channelName?: string;
  userIds?: string[];
  groupIds?: string[];
  deniedUserIds?: string[];
  deniedGroupIds?: string[];
  classification?: string;
  inheritedFrom?: string;
}): VisibilityPolicy {
  const sourceAcl: SourceAclEntry[] = [];
  for (const id of input.userIds || []) {
    sourceAcl.push({ provider: input.provider, id, type: 'user', access: 'allow' });
  }
  for (const id of input.groupIds || []) {
    sourceAcl.push({ provider: input.provider, id, type: 'group', access: 'allow' });
  }
  for (const id of input.deniedUserIds || []) {
    sourceAcl.push({ provider: input.provider, id, type: 'user', access: 'deny' });
  }
  for (const id of input.deniedGroupIds || []) {
    sourceAcl.push({ provider: input.provider, id, type: 'group', access: 'deny' });
  }
  if (input.channelId) {
    sourceAcl.push({
      provider: input.provider,
      id: input.channelId,
      type: 'channel',
      access: 'allow',
      name: input.channelName,
    });
  }
  if (input.workspaceId) {
    sourceAcl.push({ provider: input.provider, id: input.workspaceId, type: 'workspace', access: 'allow' });
  }

  return normalizeVisibility({
    classification: input.classification,
    inheritedFrom: input.inheritedFrom,
    sourceSystem: input.provider,
    sourceAcl,
  });
}

export function mergeVisibilityPolicies(...policies: Array<VisibilityPolicy | undefined | null>): VisibilityPolicy {
  const normalized = policies.map(normalizeVisibility);
  return normalizeVisibility({
    allowedPrincipals: unique(normalized.flatMap(p => p.allowedPrincipals || [])),
    deniedPrincipals: unique(normalized.flatMap(p => p.deniedPrincipals || [])),
    allowedGroups: unique(normalized.flatMap(p => p.allowedGroups || [])),
    deniedGroups: unique(normalized.flatMap(p => p.deniedGroups || [])),
    classification: normalized.find(p => p.classification)?.classification,
    inheritedFrom: normalized.find(p => p.inheritedFrom)?.inheritedFrom,
    sourceSystem: normalized.find(p => p.sourceSystem)?.sourceSystem,
    sourceAcl: normalized.flatMap(p => p.sourceAcl || []),
  });
}

function sourceAclMatches(sourceAcl: SourceAclEntry[] | undefined, access: AccessContext): {
  allowed: string[];
  denied: string[];
} {
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const entry of sourceAcl || []) {
    if (!matchesSourceAcl(entry, access)) continue;
    const key = `${entry.provider}:${entry.type}:${entry.id}`;
    if (entry.access === 'deny') denied.push(key);
    else allowed.push(key);
  }
  return { allowed, denied };
}

function matchesSourceAcl(entry: SourceAclEntry, access: AccessContext): boolean {
  const sourceAccount = access.sourceAccounts?.[entry.provider];
  if (entry.type === 'user' && sourceAccount === entry.id) return true;
  if (entry.type === 'group' && access.groups?.includes(`${entry.provider}:${entry.id}`)) return true;
  if (entry.type === 'channel' && access.groups?.includes(`${entry.provider}:channel:${entry.id}`)) return true;
  if (entry.type === 'workspace' && access.groups?.includes(`${entry.provider}:workspace:${entry.id}`)) return true;
  if (entry.type === 'role' && access.roles?.includes(entry.id)) return true;
  if (entry.type === 'account' && sourceAccount === entry.id) return true;
  return false;
}

function isSourceAclEntry(value: unknown): value is SourceAclEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.provider === 'string' &&
    typeof record.id === 'string' &&
    typeof record.type === 'string' &&
    (record.access === 'allow' || record.access === 'deny')
  );
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function looksRestrictedClassification(normalizedClassification: string): boolean {
  return normalizedClassification.includes('private') ||
    normalizedClassification.includes('confidential') ||
    normalizedClassification.includes('restricted') ||
    normalizedClassification.includes('only') ||
    normalizedClassification.includes('sensitive');
}

function normalizeClassification(classification?: string): string {
  return (classification || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}

/**
 * SQL visibility predicate.
 *
 * Security default:
 * - access.bypass=true is the only internal/admin read path.
 * - missing access sees public/unrestricted rows only.
 * - explicit access must match allow lists/source ACLs and must not hit denies.
 */
export function visibilitySql(
  db: postgres.Sql,
  column: postgres.PendingQuery<any>,
  access?: AccessContext,
): postgres.PendingQuery<any> {
  if (access?.bypass) return db``;

  if (!access) {
    return db`
      AND jsonb_array_length(COALESCE(${column}->'allowedPrincipals', '[]'::jsonb)) = 0
      AND jsonb_array_length(COALESCE(${column}->'deniedPrincipals', '[]'::jsonb)) = 0
      AND jsonb_array_length(COALESCE(${column}->'allowedGroups', '[]'::jsonb)) = 0
      AND jsonb_array_length(COALESCE(${column}->'deniedGroups', '[]'::jsonb)) = 0
      AND jsonb_array_length(COALESCE(${column}->'sourceAcl', '[]'::jsonb)) = 0
    `;
  }

  const principals = accessPrincipals(access);
  const groups = accessGroups(access);
  const roles = cleanStringArray(access.roles);
  const sourceAclKeys = sourceAclAccessKeys(access);
  const noPrincipals = principals.length === 0;
  const noGroups = groups.length === 0;
  const noSourceAclKeys = sourceAclKeys.length === 0;
  const noRoles = roles.length === 0;

  return db`
    AND NOT (COALESCE(${column}->'deniedPrincipals', '[]'::jsonb) ?| ${principals})
    AND NOT (COALESCE(${column}->'deniedGroups', '[]'::jsonb) ?| ${groups})
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(${column}->'sourceAcl', '[]'::jsonb)) AS acl(entry)
      WHERE acl.entry->>'access' = 'deny'
        AND (
          (${noSourceAclKeys} = false AND CONCAT(acl.entry->>'provider', ':', acl.entry->>'type', ':', acl.entry->>'id') = ANY(${sourceAclKeys}))
          OR (${noRoles} = false AND acl.entry->>'type' = 'role' AND acl.entry->>'id' = ANY(${roles}))
        )
    )
    AND (
      (
        jsonb_array_length(COALESCE(${column}->'allowedPrincipals', '[]'::jsonb)) = 0
        AND jsonb_array_length(COALESCE(${column}->'allowedGroups', '[]'::jsonb)) = 0
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(${column}->'sourceAcl', '[]'::jsonb)) AS acl(entry)
          WHERE acl.entry->>'access' = 'allow'
        )
      )
      OR (${noPrincipals} = false AND COALESCE(${column}->'allowedPrincipals', '[]'::jsonb) ?| ${principals})
      OR (${noGroups} = false AND COALESCE(${column}->'allowedGroups', '[]'::jsonb) ?| ${groups})
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(${column}->'sourceAcl', '[]'::jsonb)) AS acl(entry)
        WHERE acl.entry->>'access' = 'allow'
          AND (
            (${noSourceAclKeys} = false AND CONCAT(acl.entry->>'provider', ':', acl.entry->>'type', ':', acl.entry->>'id') = ANY(${sourceAclKeys}))
            OR (${noRoles} = false AND acl.entry->>'type' = 'role' AND acl.entry->>'id' = ANY(${roles}))
          )
      )
    )
  `;
}

function sourceAclAccessKeys(access: AccessContext): string[] {
  const keys: string[] = [];
  for (const [provider, id] of Object.entries(access.sourceAccounts || {})) {
    keys.push(`${provider}:user:${id}`);
    keys.push(`${provider}:account:${id}`);
  }
  for (const group of access.groups || []) {
    const parts = group.split(':');
    if (parts.length === 2) {
      keys.push(`${parts[0]}:group:${parts[1]}`);
    } else if (parts.length >= 3) {
      keys.push(`${parts[0]}:${parts[1]}:${parts.slice(2).join(':')}`);
    }
  }
  return unique(keys);
}

function cleanStringArray(values: Array<string | undefined> | undefined): string[] {
  return Array.from(new Set((values || []).filter((value): value is string => typeof value === 'string' && value.length > 0)));
}
