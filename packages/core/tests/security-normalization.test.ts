import { describe, expect, it } from 'vitest';
import { normalizeEpisodeInput, simulatePermission, visibilityWarnings } from '../src/index.js';

describe('source normalization and permission mapping', () => {
  it('preserves Slack threads, files, reactions, and channel provenance without inventing ACLs', () => {
    const normalized = normalizeEpisodeInput({
      content: 'Please review the candidate packet.',
      sourceType: 'slack_message',
      metadata: {
        workspaceId: 'T1',
        channel: 'hiring-private',
        channelId: 'C1',
        userId: 'U1',
        threadMessages: [{ user: 'U2', ts: '123.4', text: 'Added notes.' }],
        files: [{ name: 'packet.pdf', mimetype: 'application/pdf', url_private: 'https://files.local/packet.pdf' }],
        reactions: [{ name: 'eyes', count: 2 }],
      },
    });

    expect(normalized.content).toContain('Thread replies');
    expect(normalized.content).toContain('packet.pdf');
    expect(normalized.content).toContain('eyes=2');
    expect(normalized.visibility.sourceSystem).toBe('slack');
    expect(normalized.visibility.sourceAcl).toEqual([]);
  });

  it('explains source ACL allow and deny decisions', () => {
    const visibility = {
      sourceSystem: 'slack',
      sourceAcl: [
        { provider: 'slack', id: 'C1', type: 'channel' as const, access: 'allow' as const },
        { provider: 'slack', id: 'U2', type: 'user' as const, access: 'deny' as const },
      ],
    };

    const allowed = simulatePermission(visibility, { groups: ['slack:channel:C1'] });
    const denied = simulatePermission(visibility, { sourceAccounts: { slack: 'U2' }, groups: ['slack:channel:C1'] });

    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toContain('allow');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('deny');
  });

  it('defaults missing access context to public-only visibility', () => {
    const restricted = simulatePermission({
      allowedGroups: ['security'],
      classification: 'security_incident',
    });
    const publicRecord = simulatePermission({ classification: 'public_note' });
    const bypass = simulatePermission({
      allowedGroups: ['security'],
      classification: 'security_incident',
    }, { bypass: true });

    expect(restricted.allowed).toBe(false);
    expect(restricted.reason).toContain('restricted visibility');
    expect(publicRecord.allowed).toBe(true);
    expect(bypass.allowed).toBe(true);
    expect(bypass.reason).toContain('Bypass');
  });

  it('does not invent ACLs from classification labels', () => {
    const securityOnly = normalizeEpisodeInput({
      content: 'PRIVATE LINE: token path = /prod/ci/deploy_token',
      sourceType: 'raw_dump',
      visibility: { classification: 'security-only' },
    });
    const recruitingOnly = normalizeEpisodeInput({
      content: 'Candidate feedback: weak product sense.',
      sourceType: 'raw_dump',
      visibility: { classification: 'recruiting-only' },
    });

    expect(securityOnly.visibility.allowedGroups).toEqual([]);
    expect(securityOnly.visibility.deniedGroups).toEqual([]);
    expect(simulatePermission(securityOnly.visibility).allowed).toBe(true);

    expect(recruitingOnly.visibility.allowedGroups).toEqual([]);
    expect(recruitingOnly.visibility.deniedGroups).toEqual([]);
    expect(simulatePermission(recruitingOnly.visibility).allowed).toBe(true);
    expect(visibilityWarnings(securityOnly.visibility)[0]).toContain('no explicit allow/deny policy');
  });

  it('enforces source-native ACLs instead of domain label mappings', () => {
    const normalized = normalizeEpisodeInput({
      content: 'private channel note copied exactly as received',
      sourceType: 'slack_message',
      metadata: {
        workspaceId: 'T1',
        channelId: 'C_SEC',
        visibleGroupIds: ['security-team'],
      },
    });

    expect(normalized.visibility.sourceAcl).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'slack', id: 'security-team', type: 'group', access: 'allow' }),
    ]));
    expect(simulatePermission(normalized.visibility).allowed).toBe(false);
    expect(simulatePermission(normalized.visibility, { groups: ['slack:security-team'] }).allowed).toBe(true);
  });

  it('does not treat owners or participants as permission allow-lists', () => {
    const crm = normalizeEpisodeInput({
      content: 'Apex Health is blocked. Elena owns escalation.',
      sourceType: 'crm_record',
      metadata: { ownerId: 'Elena', provider: 'crm' },
    });
    const call = normalizeEpisodeInput({
      content: 'Samir: Atlas blocked by replay/idempotency.',
      sourceType: 'call_transcript',
      metadata: { participantUserIds: ['Samir', 'Mina'] },
    });

    expect(crm.visibility.sourceAcl).toEqual([]);
    expect(call.visibility.sourceAcl).toEqual([]);
    expect(simulatePermission(crm.visibility).allowed).toBe(true);
    expect(simulatePermission(call.visibility).allowed).toBe(true);
  });

  it('does not treat legacy stringified visibility as public', () => {
    const stringified = JSON.stringify({
      sourceSystem: 'slack',
      sourceAcl: [{ provider: 'slack', id: 'security', type: 'group', access: 'allow' }],
    });

    expect(simulatePermission(stringified as any).allowed).toBe(false);
    expect(simulatePermission(stringified as any, { groups: ['product'] }).allowed).toBe(false);
    expect(simulatePermission(stringified as any, { groups: ['slack:security'] }).allowed).toBe(true);
  });
});
