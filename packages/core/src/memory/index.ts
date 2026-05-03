import type postgres from 'postgres';
import type {
  EmbeddingConfig,
  LLMConfig,
  OrganizationalMemoryInput,
  OrganizationalMemoryKind,
  OrganizationalMemoryObject,
  OrganizationalMemoryStatus,
  SearchResult,
  VisibilityPolicy,
} from '../types.js';
import { embed, embedBatch } from '../embedding.js';
import { anthropicMaxOutputTokens, defaultLLMModel, defaultLLMProvider } from '../llm-limits.js';
import { withLLMTimeout } from '../llm-timeout.js';
import { normalizeVisibility, visibilitySql } from '../security.js';

const MEMORY_KINDS: OrganizationalMemoryKind[] = [
  'interaction',
  'decision',
  'rationale',
  'commitment',
  'open_question',
  'risk',
  'value_object',
  'product_signal',
  'workflow_signal',
  'policy',
  'exception',
];

const MEMORY_STATUSES: OrganizationalMemoryStatus[] = [
  'observed',
  'proposed',
  'decided',
  'rejected',
  'parked',
  'open',
  'in_progress',
  'done',
  'blocked',
  'unknown',
];

export interface DeriveMemoryOptions {
  groupId: string;
  episodeId: string;
  sourceType: string;
  metadata?: Record<string, unknown>;
  visibility?: VisibilityPolicy;
  validAt: Date;
  llmConfig?: LLMConfig;
}

export interface StoreMemoryOptions {
  groupId: string;
  embeddingConfig?: EmbeddingConfig;
}

export interface MemorySearchOptions {
  query: string;
  groupId?: string;
  limit?: number;
  access?: import('../types.js').AccessContext;
  kinds?: OrganizationalMemoryKind[];
  statuses?: OrganizationalMemoryStatus[];
  embeddingConfig?: EmbeddingConfig;
}

export async function deriveOrganizationalMemory(
  text: string,
  options: DeriveMemoryOptions,
): Promise<OrganizationalMemoryInput[]> {
  if (!hasLLMConfig(options.llmConfig)) return [];

  const llmObjects = await deriveMemoryWithLLM(text, options).catch(() => []);
  return mergeMemoryInputs(llmObjects);
}

export async function storeOrganizationalMemory(
  db: postgres.Sql,
  objects: OrganizationalMemoryInput[],
  options: StoreMemoryOptions,
): Promise<number> {
  let created = 0;
  for (const object of objects) {
    const visibility = normalizeVisibility(object.visibility);
    const textForEmbedding = `${object.kind}: ${object.title}\n${object.summary}`;
    const embedding = await embed(textForEmbedding, options.embeddingConfig).catch(() => null);
    const result = await db`
      INSERT INTO organizational_memory (
        group_id,
        kind,
        title,
        summary,
        status,
        owner,
        subject,
        value_object,
        due_at,
        valid_at,
        resolved_at,
        confidence,
        evidence,
        source_episode_id,
        visibility,
        metadata,
        content_embedding
      )
      VALUES (
        ${options.groupId},
        ${object.kind},
        ${object.title},
        ${object.summary},
        ${object.status || 'observed'},
        ${object.owner || null},
        ${object.subject || null},
        ${object.valueObject || null},
        ${object.dueAt || null},
        ${object.validAt || new Date()},
        ${object.resolvedAt || null},
        ${object.confidence ?? 0.7},
        ${db.json((object.evidence || {}) as any)},
        ${object.sourceEpisodeId || null},
        ${db.json(visibility as any)},
        ${db.json((object.metadata || {}) as any)},
        ${embedding ? `[${embedding.join(',')}]` : null}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) created++;
  }
  return created;
}

export async function searchOrganizationalMemory(
  db: postgres.Sql,
  options: MemorySearchOptions,
): Promise<SearchResult[]> {
  const groupId = options.groupId || 'default';
  const limit = options.limit ?? 10;
  const kinds = options.kinds?.length ? options.kinds : MEMORY_KINDS;
  const statuses = options.statuses?.length ? options.statuses : MEMORY_STATUSES;
  const queryEmbedding = await embed(options.query, options.embeddingConfig).catch(() => null);
  const visibility = visibilitySql(db, db`visibility`, options.access);

  const keywordRows = await db`
    SELECT
      id,
      kind,
      title,
      summary,
      status,
      owner,
      subject,
      value_object,
      valid_at,
      confidence,
      evidence,
      source_episode_id,
      metadata,
      ts_rank(memory_tsv, plainto_tsquery('english', ${options.query})) AS score
    FROM organizational_memory
    WHERE group_id = ${groupId}
      AND kind = ANY(${kinds})
      AND status = ANY(${statuses})
      ${visibility}
      AND memory_tsv @@ plainto_tsquery('english', ${options.query})
    ORDER BY score DESC, valid_at DESC
    LIMIT ${limit}
  `.catch(() => []);

  const semanticRows = queryEmbedding
    ? await db`
        SELECT
          id,
          kind,
          title,
          summary,
          status,
          owner,
          subject,
          value_object,
          valid_at,
          confidence,
          evidence,
          source_episode_id,
          metadata,
          1 - (content_embedding <=> ${`[${queryEmbedding.join(',')}]`}::vector) AS score
        FROM organizational_memory
        WHERE group_id = ${groupId}
          AND kind = ANY(${kinds})
          AND status = ANY(${statuses})
          ${visibility}
          AND content_embedding IS NOT NULL
        ORDER BY content_embedding <=> ${`[${queryEmbedding.join(',')}]`}::vector
        LIMIT ${limit}
      `.catch(() => [])
    : [];

  return mergeMemorySearchRows([...keywordRows, ...semanticRows]).slice(0, limit);
}

export async function listOrganizationalMemory(
  db: postgres.Sql,
  options: Omit<MemorySearchOptions, 'query'> & { query?: string },
): Promise<OrganizationalMemoryObject[]> {
  const groupId = options.groupId || 'default';
  const limit = options.limit ?? 50;
  const kinds = options.kinds?.length ? options.kinds : MEMORY_KINDS;
  const statuses = options.statuses?.length ? options.statuses : MEMORY_STATUSES;
  const visibility = visibilitySql(db, db`visibility`, options.access);
  const rows = await db`
    SELECT *
    FROM organizational_memory
    WHERE group_id = ${groupId}
      AND kind = ANY(${kinds})
      AND status = ANY(${statuses})
      ${visibility}
    ORDER BY valid_at DESC, created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(rowToMemoryObject);
}

async function deriveMemoryWithLLM(text: string, options: DeriveMemoryOptions): Promise<OrganizationalMemoryInput[]> {
  const prompt = [
    'Extract universal organizational memory objects from this interaction.',
    'Return JSON: {"objects":[...]}',
    'Allowed kinds: interaction, decision, rationale, commitment, open_question, risk, value_object, product_signal, workflow_signal, policy, exception.',
    'Allowed statuses: observed, proposed, decided, rejected, parked, open, in_progress, done, blocked, unknown.',
    'Rules:',
    '- Interactions are source material; derived objects must cite exact quotes.',
    '- Preserve literal owners, paths, numbers, dates, blockers, and next steps.',
    '- Distinguish no_decision/parked from rejected. Do not strengthen uncertainty.',
    '- Extract commitments with owner/action if present.',
    '- Only set owner when the text says someone owns/is responsible for/must do the work. A requester, speaker, or customer is not automatically the owner.',
    '- Strip obvious correction prefixes and role labels from owners, while preserving the actual person name.',
    '- Use product_signal for customer/user/product feedback, feature requests, adoption friction, and product opportunities.',
    '- Use workflow_signal for repeatable process, handoff, escalation, approval, or operational how-to knowledge.',
    '- Use policy for durable rules, requirements, must/never/do-not guidance, and company operating constraints.',
    '- Use exception for one-off approvals, overrides, waivers, or special cases.',
    '- Extract open questions for uncertainty, caveats, and not-proven claims.',
    '- Do not invent access permissions or domain-specific labels.',
    '',
    text,
  ].join('\n');
  const provider = defaultLLMProvider(options.llmConfig);
  const raw = provider === 'openai'
    ? await callOpenAI(prompt, options.llmConfig)
    : await callAnthropic(prompt, options.llmConfig);
  const parsed = parseMemoryPayload(raw);
  return parsed.map(object => memoryInput({
    ...object,
    quote: typeof object.evidence?.quote === 'string' ? object.evidence.quote : object.summary,
    options,
  }));
}

function memoryInput(input: {
  kind: OrganizationalMemoryKind;
  title: string;
  summary: string;
  status?: OrganizationalMemoryStatus;
  owner?: string | null;
  subject?: string | null;
  valueObject?: string | null;
  confidence?: number;
  quote?: string;
  metadata?: Record<string, unknown>;
  options: DeriveMemoryOptions;
}): OrganizationalMemoryInput {
  return {
    kind: input.kind,
    title: input.title.slice(0, 180),
    summary: input.summary.slice(0, 2000),
    status: input.status || 'observed',
    owner: cleanOwner(input.owner || undefined),
    subject: input.subject || null,
    valueObject: input.valueObject || null,
    validAt: input.options.validAt,
    confidence: input.confidence ?? 0.7,
    evidence: {
      quote: input.quote || input.summary,
      sourceEpisodeId: input.options.episodeId,
      extractor: 'organizational_memory',
    },
    sourceEpisodeId: input.options.episodeId,
    visibility: input.options.visibility,
    metadata: {
      sourceType: input.options.sourceType,
      ...(input.options.metadata || {}),
      ...(input.metadata || {}),
    },
  };
}

function mergeMemoryInputs(objects: OrganizationalMemoryInput[]): OrganizationalMemoryInput[] {
  const seen = new Set<string>();
  const merged: OrganizationalMemoryInput[] = [];
  for (const object of objects) {
    if (!MEMORY_KINDS.includes(object.kind)) continue;
    const status = object.status && MEMORY_STATUSES.includes(object.status) ? object.status : 'observed';
    const key = `${object.kind}:${normalizeKey(object.summary)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      ...object,
      status,
      title: object.title || object.kind,
      confidence: Math.max(0, Math.min(1, object.confidence ?? 0.7)),
    });
  }
  return merged.slice(0, 32);
}

function mergeMemorySearchRows(rows: any[]): SearchResult[] {
  const byId = new Map<string, SearchResult>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    const score = Number(row.score || 0);
    if (existing && existing.score >= score) continue;
    byId.set(row.id, memoryRowToSearchResult(row, score));
  }
  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}

function memoryRowToSearchResult(row: any, score: number): SearchResult {
  const evidence = row.evidence && typeof row.evidence === 'object' ? row.evidence : {};
  return {
    type: 'memory',
    id: row.id,
    score,
    content: [
      `${String(row.kind)}: ${String(row.title)}`,
      `status=${String(row.status)}`,
      row.owner ? `owner=${String(row.owner)}` : undefined,
      row.value_object ? `value_object=${String(row.value_object)}` : undefined,
      String(row.summary),
    ].filter(Boolean).join('\n'),
    metadata: {
      kind: row.kind,
      status: row.status,
      owner: row.owner,
      subject: row.subject,
      valueObject: row.value_object,
      confidence: row.confidence,
      evidence,
      sourceEpisodeId: row.source_episode_id,
      ...(row.metadata || {}),
    },
    validAt: row.valid_at,
  };
}

function rowToMemoryObject(row: any): OrganizationalMemoryObject {
  return {
    id: row.id,
    groupId: row.group_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    status: row.status,
    owner: row.owner,
    subject: row.subject,
    valueObject: row.value_object,
    dueAt: row.due_at,
    validAt: row.valid_at,
    resolvedAt: row.resolved_at,
    confidence: row.confidence,
    evidence: row.evidence || {},
    sourceEpisodeId: row.source_episode_id,
    visibility: normalizeVisibility(row.visibility),
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanOwner(value?: string): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned || OWNER_STOPWORDS.has(cleaned.toLowerCase())) return null;
  return cleaned;
}

const OWNER_STOPWORDS = new Set([
  'owner',
  'someone',
  'customer',
  'candidate',
  'team',
]);

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 240);
}

function parseMemoryPayload(raw: string): OrganizationalMemoryInput[] {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
  try {
    const parsed = JSON.parse((match[1] || raw).trim()) as { objects?: OrganizationalMemoryInput[] };
    return Array.isArray(parsed.objects) ? parsed.objects : [];
  } catch {
    return [];
  }
}

async function callAnthropic(prompt: string, llmConfig?: LLMConfig): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: llmConfig?.apiKey || process.env.ANTHROPIC_API_KEY });
  const response = await withLLMTimeout(client.messages.create({
    model: defaultLLMModel('anthropic', llmConfig),
    max_tokens: anthropicMaxOutputTokens(llmConfig),
    system: 'You extract structured organizational memory. Return only valid JSON.',
    messages: [{ role: 'user', content: prompt }],
  }), 'memory anthropic request');
  const textBlock = response.content.find(block => block.type === 'text');
  return textBlock?.text || '{"objects":[]}';
}

async function callOpenAI(prompt: string, llmConfig?: LLMConfig): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: llmConfig?.apiKey || process.env.OPENAI_API_KEY });
  const response = await withLLMTimeout(client.chat.completions.create({
    model: defaultLLMModel('openai', llmConfig),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You extract structured organizational memory. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
  }), 'memory openai request');
  return response.choices[0]?.message?.content || '{"objects":[]}';
}

function hasLLMConfig(llmConfig?: LLMConfig): boolean {
  return Boolean(llmConfig?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}
