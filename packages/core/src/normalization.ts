import type { EpisodeInput, NormalizedEpisode, VisibilityPolicy } from './types.js';
import { mergeVisibilityPolicies, normalizeVisibility, visibilityFromSourcePermissions } from './security.js';

/**
 * Normalize source-shaped payloads into extraction-ready text while preserving
 * structured metadata. Connectors can pass rich metadata without teaching the
 * extractor every SaaS payload shape.
 */
export function normalizeEpisodeInput(input: EpisodeInput): NormalizedEpisode {
  const metadata = { ...(input.metadata || {}) };
  const normalizedContent = normalizeContent(input.sourceType, input.content, metadata);

  return {
    content: normalizedContent,
    sourceType: input.sourceType,
    metadata: {
      ...metadata,
      normalized: true,
      originalContentLength: input.content.length,
    },
    visibility: inferVisibility(input, metadata),
  };
}

function inferVisibility(input: EpisodeInput, metadata: Record<string, unknown>): VisibilityPolicy {
  const metadataVisibility = metadata.visibility && typeof metadata.visibility === 'object'
    ? metadata.visibility as VisibilityPolicy
    : undefined;

  return mergeVisibilityPolicies(sourceVisibility(input.sourceType, metadata), metadataVisibility, input.visibility);
}

function normalizeContent(
  sourceType: string,
  content: string,
  metadata: Record<string, unknown>,
): string {
  const type = sourceType.toLowerCase();

  if (type.includes('slack')) {
    return normalizeSlack(content, metadata);
  }

  if (type.includes('call') || type.includes('meeting') || type.includes('transcript')) {
    return normalizeTranscript(content, metadata);
  }

  if (type.includes('analytics') || type.includes('event') || type.includes('metric')) {
    return normalizeEvent(content, metadata);
  }

  if (type.includes('crm') || type.includes('record')) {
    return normalizeRecord(content, metadata);
  }

  return content;
}

function normalizeSlack(content: string, metadata: Record<string, unknown>): string {
  const thread = renderThread(metadata.threadMessages || metadata.replies);
  const attachments = renderAttachments(metadata.files || metadata.attachments);
  const reactions = renderReactions(metadata.reactions);
  const blocks = renderSlackBlocks(metadata.blocks);
  const parts = [
    metadata.workspaceId ? `Workspace: ${String(metadata.workspaceId)}` : undefined,
    metadata.channel ? `Channel: ${String(metadata.channel)}` : undefined,
    metadata.channelId ? `Channel ID: ${String(metadata.channelId)}` : undefined,
    metadata.userId ? `Sender: ${String(metadata.userId)}` : undefined,
    metadata.userName ? `Sender name: ${String(metadata.userName)}` : undefined,
    metadata.threadTs ? `Thread: ${String(metadata.threadTs)}` : undefined,
    `Message: ${content}`,
    thread ? `Thread replies:\n${thread}` : undefined,
    blocks ? `Structured blocks:\n${blocks}` : undefined,
    attachments ? `Attachments:\n${attachments}` : undefined,
    reactions ? `Reactions: ${reactions}` : undefined,
  ];
  return parts.filter(Boolean).join('\n');
}

function normalizeTranscript(content: string, metadata: Record<string, unknown>): string {
  const turns = metadata.turns || metadata.transcriptTurns;
  if (Array.isArray(turns) && turns.length > 0) {
    const renderedTurns = turns
      .map((turn) => {
        if (!turn || typeof turn !== 'object') return '';
        const record = turn as Record<string, unknown>;
        const speaker = record.speaker || record.name || record.user || 'Speaker';
        const text = record.text || record.content || record.message || '';
        const ts = record.timestamp || record.startTime || record.time;
        const confidence = record.confidence != null ? ` confidence=${String(record.confidence)}` : '';
        const speakerId = record.speakerId ? ` speakerId=${String(record.speakerId)}` : '';
        return `${ts ? `[${String(ts)}] ` : ''}${String(speaker)}${speakerId}${confidence}: ${String(text)}`;
      })
      .filter(Boolean)
      .join('\n');

    if (renderedTurns.trim()) {
      const title = metadata.title || metadata.meetingTitle || metadata.callTitle;
      const actionItems = renderList(metadata.actionItems, 'Action items');
      const decisions = renderList(metadata.decisions, 'Decisions');
      const participants = renderList(metadata.participants, 'Participants');
      return [
        title ? `Title: ${String(title)}` : undefined,
        participants,
        content ? `Transcript:\n${content}` : undefined,
        `Structured turns:\n${renderedTurns}`,
        decisions,
        actionItems,
      ].filter(Boolean).join('\n');
    }
  }

  const title = metadata.title || metadata.meetingTitle || metadata.callTitle;
  const participants = renderList(metadata.participants, 'Participants');
  const speakerMap = metadata.speakerMap && typeof metadata.speakerMap === 'object'
    ? `Speaker map: ${JSON.stringify(metadata.speakerMap)}`
    : undefined;
  return [title ? `Title: ${String(title)}` : undefined, participants, speakerMap, `Transcript:\n${content}`]
    .filter(Boolean)
    .join('\n');
}

function normalizeEvent(content: string, metadata: Record<string, unknown>): string {
  const eventName = metadata.event || metadata.eventName || metadata.name || metadata.metric;
  const actor = metadata.actor || metadata.userId || metadata.accountId;
  const value = metadata.value || metadata.count || metadata.amount;
  const dimensions = renderObject(metadata.dimensions, 'Dimensions');
  const identity = renderObject(metadata.identity || metadata.traits, 'Identity');
  const context = renderObject(metadata.context || metadata.properties, 'Properties');

  return [
    eventName ? `Event: ${String(eventName)}` : undefined,
    actor ? `Actor: ${String(actor)}` : undefined,
    value != null ? `Value: ${String(value)}` : undefined,
    content ? `Details: ${content}` : undefined,
    dimensions,
    identity,
    context,
  ].filter(Boolean).join('\n');
}

function normalizeRecord(content: string, metadata: Record<string, unknown>): string {
  const recordType = metadata.recordType || metadata.objectType || metadata.type;
  const recordId = metadata.recordId || metadata.id || metadata.externalId;
  const owner = metadata.owner || metadata.ownerId || metadata.accountOwner;
  const stage = metadata.stage || metadata.status || metadata.lifecycleStage;
  const associations = renderObject(metadata.associations || metadata.relatedRecords, 'Associations');
  const fields = renderObject(metadata.fields || metadata.properties, 'Fields');
  return [
    recordType ? `Record type: ${String(recordType)}` : undefined,
    recordId ? `Record ID: ${String(recordId)}` : undefined,
    owner ? `Owner: ${String(owner)}` : undefined,
    stage ? `Stage/status: ${String(stage)}` : undefined,
    associations,
    fields,
    `Record content: ${content}`,
  ].filter(Boolean).join('\n');
}

function sourceVisibility(sourceType: string, metadata: Record<string, unknown>): VisibilityPolicy {
  const type = sourceType.toLowerCase();
  if (type.includes('slack')) {
    return visibilityFromSourcePermissions({
      provider: 'slack',
      userIds: stringArray(metadata.visibleUserIds || metadata.allowedUserIds),
      groupIds: stringArray(metadata.visibleGroupIds || metadata.allowedGroupIds),
      deniedUserIds: stringArray(metadata.deniedUserIds),
      deniedGroupIds: stringArray(metadata.deniedGroupIds),
      classification: stringValue(metadata.classification),
      inheritedFrom: stringValue(metadata.channelId || metadata.sourceId),
    });
  }

  if (type.includes('call') || type.includes('meeting') || type.includes('transcript')) {
    return visibilityFromSourcePermissions({
      provider: stringValue(metadata.provider) || 'call',
      userIds: stringArray(metadata.visibleUserIds || metadata.allowedUserIds),
      groupIds: stringArray(metadata.visibleGroupIds || metadata.allowedGroupIds),
      deniedUserIds: stringArray(metadata.deniedUserIds),
      deniedGroupIds: stringArray(metadata.deniedGroupIds),
      classification: stringValue(metadata.classification),
      inheritedFrom: stringValue(metadata.callId || metadata.meetingId || metadata.recordingId),
    });
  }

  if (type.includes('analytics') || type.includes('event') || type.includes('metric')) {
    return visibilityFromSourcePermissions({
      provider: stringValue(metadata.provider) || 'analytics',
      userIds: stringArray(metadata.visibleUserIds || metadata.allowedUserIds),
      groupIds: stringArray(metadata.visibleGroupIds || metadata.allowedGroupIds),
      deniedUserIds: stringArray(metadata.deniedUserIds),
      deniedGroupIds: stringArray(metadata.deniedGroupIds),
      classification: stringValue(metadata.classification) || 'analytics',
      inheritedFrom: stringValue(metadata.eventId || metadata.eventName),
    });
  }

  if (type.includes('crm') || type.includes('record')) {
    return visibilityFromSourcePermissions({
      provider: stringValue(metadata.provider) || 'crm',
      userIds: stringArray(metadata.visibleUserIds || metadata.allowedUserIds),
      groupIds: stringArray(metadata.visibleGroupIds || metadata.allowedGroupIds),
      deniedUserIds: stringArray(metadata.deniedUserIds),
      deniedGroupIds: stringArray(metadata.deniedGroupIds),
      classification: stringValue(metadata.classification),
      inheritedFrom: stringValue(metadata.recordId || metadata.id || metadata.externalId),
    });
  }

  return {};
}

function renderThread(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((reply) => {
    if (!reply || typeof reply !== 'object') return String(reply);
    const record = reply as Record<string, unknown>;
    return `${record.user || record.userId || 'user'} @ ${record.ts || record.timestamp || 'unknown'}: ${record.text || record.content || ''}`;
  }).join('\n');
}

function renderAttachments(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((attachment) => {
    if (!attachment || typeof attachment !== 'object') return String(attachment);
    const record = attachment as Record<string, unknown>;
    return [
      record.name || record.title || record.filename || 'attachment',
      record.mimetype || record.filetype,
      record.url_private || record.url || record.permalink,
      record.text || record.summary,
    ].filter(Boolean).map(String).join(' | ');
  }).join('\n');
}

function renderSlackBlocks(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((block) => {
    if (!block || typeof block !== 'object') return String(block);
    const record = block as Record<string, unknown>;
    const text = record.text && typeof record.text === 'object'
      ? (record.text as Record<string, unknown>).text
      : record.text;
    return [record.type, text].filter(Boolean).map(String).join(': ');
  }).filter(Boolean).join('\n');
}

function renderReactions(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((reaction) => {
    if (!reaction || typeof reaction !== 'object') return String(reaction);
    const record = reaction as Record<string, unknown>;
    return `${record.name || 'reaction'}=${record.count || 1}`;
  }).join(', ');
}

function renderList(value: unknown, label: string): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return `${label}: ${value.map(String).join(', ')}`;
}

function renderObject(value: unknown, label: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return `${label}: ${JSON.stringify(value)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
