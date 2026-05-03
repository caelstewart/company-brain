import type { InteractionRetention, InteractionTriageDecision, LLMConfig, TriageConfig } from '../types.js';
import { anthropicMaxOutputTokens, defaultLLMModel, defaultLLMProvider, llmChunkOverlapChars, llmInputCharBudget } from '../llm-limits.js';
import { withLLMTimeout } from '../llm-timeout.js';

const DEFAULT_EPHEMERAL_TTL_DAYS = 14;

export async function triageInteraction(
  content: string,
  options?: {
    sourceType?: string;
    metadata?: Record<string, unknown>;
    config?: TriageConfig;
    llmConfig?: LLMConfig;
  },
): Promise<InteractionTriageDecision> {
  return triageInteractionWithLLM(content, options);
}

export async function triageInteractionWithLLM(
  content: string,
  options?: {
    sourceType?: string;
    metadata?: Record<string, unknown>;
    config?: TriageConfig;
    llmConfig?: LLMConfig;
  },
): Promise<InteractionTriageDecision> {
  const config = options?.config || {};
  if (config.enabled === false) {
    return decisionFromRetention('durable', 1, {
      signals: ['triage_disabled'],
      reasons: ['Triage disabled by configuration.'],
      config,
    });
  }

  const llmEnabled = config.llmEnabled !== false;
  const hasLLM = Boolean(options?.llmConfig?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  if (!llmEnabled || !hasLLM) {
    return conservativeEphemeral(config, llmEnabled ? 'No LLM configured for triage.' : 'LLM triage disabled by configuration.');
  }

  const llmConfig = selectTriageLLMConfig(content, options?.llmConfig);
  const maxSinglePassChars = Math.max(1, config.maxSinglePassChars ?? llmInputCharBudget(llmConfig));
  if (content.length > maxSinglePassChars) {
    return triageLargeInteraction(content, { ...options, llmConfig }, config);
  }

  return triageSingleInteraction(content, { ...options, llmConfig }, config);
}

async function triageSingleInteraction(
  content: string,
  options: {
    sourceType?: string;
    metadata?: Record<string, unknown>;
    llmConfig?: LLMConfig;
  } = {},
  config: TriageConfig,
  chunkContext?: { chunkIndex: number; chunkCount: number; originalLength: number },
): Promise<InteractionTriageDecision> {
  const prompt = [
    'You are the memory admission controller for a company brain.',
    'Decide whether this source interaction should become durable organizational memory.',
    'Return ONLY valid JSON with keys: retention, durableMemoryScore, shouldStoreEpisode, shouldExtract, shouldStoreMemory, ttlDays, signals, reasons.',
    'Allowed retention values: drop, ephemeral, durable.',
    'Definitions:',
    '- drop: no meaningful future organizational utility.',
    '- ephemeral: useful short-lived context, but should not create durable graph facts or memory objects.',
    '- durable: should feed graph extraction and organizational memory.',
    'Use source-agnostic judgment. Do not rely on hardcoded phrases.',
    'Prefer durable for decisions, commitments, owners, blockers, risks, policies, workflow/process rules, exceptions, customer/product signals, or facts likely to help future agents.',
    'A product/customer/workflow signal can be durable even if no owner is assigned, if it captures concrete feedback about a named feature, reusable signal, user need, customer ask, operational friction, or future product opportunity.',
    'Significant named metric anomalies should be durable even when causality is not proven; preserve the caveat as part of the durable memory rather than dropping the signal.',
    'Source-restricted evaluative records are durable when they contain a named subject plus substantive assessment, concern, decision, or follow-up; access control belongs to the security layer. If retained, they should be extracted so authorized users can retrieve the details.',
    'Corrections and negations that prevent false organizational memory are durable when they name the false claim, incident, decision, customer, system, or owner they correct.',
    'Repeated status that confirms an open owner, blocker, or unfinished commitment remains unresolved is durable when it affects future work or agent planning, even if it adds no new resolution.',
    'Prefer ephemeral only for concrete named unresolved issues, active investigations, vendor watches, or near-term coordination that has a named customer/system/component and plausible follow-up, but is not yet durable fact.',
    'A named person alone is not a sufficient anchor. For ephemeral retention, the anchor should usually be a customer, account, product feature, system, component, incident, ticket, deal, or policy/workflow object.',
    'If source metadata includes explicit visibility, ACL, allowed groups, or allowed principals, do not drop sensitive HR/security/commercial content merely because it is sensitive; judge memory-worthiness and let the security layer enforce access.',
    'Unanswered questions about a policy, workflow, owner, or decision are ephemeral unless the answer/change is also present; do not promote uncertainty into durable policy.',
    'Use drop for acknowledgements, social chatter, reactions, scheduling/logistics even when people are named, negative repro checks where behavior appears normal and no explicit unresolved follow-up remains, vague issue mentions without a real component/customer/ticket, routine normal metrics, self-resolved one-off issues, local-only debug noise, test/drill alerts, false-positive alerts with no reusable policy, anonymous rumors with no concrete anchor, bare automated source-system churn with no named subject or notes, private/sensitive fragments without source permissions and without a clear identity/action/decision, or context-free messages with no plausible future organizational utility.',
    'If a thread first asks someone to reproduce a problem and later says they cannot reproduce it or everything works normally, treat the repro loop as closed and drop it unless there is a specific remaining customer/system/ticket follow-up.',
    'Do not keep something as ephemeral merely because it might be briefly useful; if it has no concrete named subject plus plausible future follow-up, drop it.',
    'A recovered vendor delay with no customer impact and no process change is ephemeral at most, not durable.',
    'Do not drop named unresolved issue context just because it lacks a root cause or owner; use ephemeral unless it is pure noise.',
    '',
    `Source type: ${options?.sourceType || 'unknown'}`,
    `Metadata keys: ${Object.keys(options?.metadata || {}).slice(0, 30).join(', ') || 'none'}`,
    `Visibility context: ${visibilitySummary(options?.metadata?.visibility)}`,
    chunkContext
      ? `Interaction part: ${chunkContext.chunkIndex + 1} of ${chunkContext.chunkCount} from a ${chunkContext.originalLength} character source. Classify this part on its own; a later aggregation step will combine all parts.`
      : 'Interaction part: complete source interaction.',
    '',
    'Interaction:',
    content,
  ].join('\n');

  const raw = await callTriageLLM(prompt, options?.llmConfig).catch(() => '');
  const parsed = parseTriagePayload(raw, config);
  return parsed || conservativeEphemeral(config, 'LLM triage response was invalid; held as ephemeral instead of promoting.');
}

async function triageLargeInteraction(
  content: string,
  options: {
    sourceType?: string;
    metadata?: Record<string, unknown>;
    config?: TriageConfig;
    llmConfig?: LLMConfig;
  } = {},
  config: TriageConfig,
): Promise<InteractionTriageDecision> {
  const chunks = splitLargeInteraction(content, config, options.llmConfig);
  const decisions: InteractionTriageDecision[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    decisions.push(
      await triageSingleInteraction(chunks[index], options, config, {
        chunkIndex: index,
        chunkCount: chunks.length,
        originalLength: content.length,
      }),
    );
  }

  return aggregateChunkDecisions(decisions, config, content.length);
}

function splitLargeInteraction(content: string, config: TriageConfig, llmConfig?: LLMConfig): string[] {
  const maxChunkChars = Math.max(1, config.maxChunkChars ?? llmInputCharBudget(llmConfig));
  const overlapChars = Math.max(0, Math.min(config.chunkOverlapChars ?? llmChunkOverlapChars(), maxChunkChars - 1));
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(content.length, start + maxChunkChars);
    chunks.push(content.slice(start, end));
    if (end >= content.length) break;
    start = end - overlapChars;
  }
  return chunks;
}

function aggregateChunkDecisions(
  decisions: InteractionTriageDecision[],
  config: TriageConfig,
  originalLength: number,
): InteractionTriageDecision {
  const durable = decisions.filter(decision => decision.retention === 'durable');
  if (durable.length > 0) {
    return decisionFromRetention('durable', Math.max(...durable.map(decision => decision.durableMemoryScore)), {
      signals: aggregateSignals(decisions, ['triage_chunked', 'durable_chunk_found']),
      reasons: aggregateReasons(decisions, [
        `Large interaction (${originalLength} chars) was triaged in ${decisions.length} connected chunks.`,
        `${durable.length} chunk(s) contained durable organizational memory, so the full source is eligible for extraction.`,
      ]),
      config,
    });
  }

  const ephemeral = decisions.filter(decision => decision.retention === 'ephemeral');
  if (ephemeral.length > 0) {
    return decisionFromRetention('ephemeral', Math.max(...ephemeral.map(decision => decision.durableMemoryScore)), {
      signals: aggregateSignals(decisions, ['triage_chunked', 'ephemeral_chunk_found']),
      reasons: aggregateReasons(decisions, [
        `Large interaction (${originalLength} chars) was triaged in ${decisions.length} connected chunks.`,
        `${ephemeral.length} chunk(s) contained short-lived context, but no chunk justified durable memory.`,
      ]),
      ttlDays: Math.max(...ephemeral.map(decision => decision.ttlDays ?? DEFAULT_EPHEMERAL_TTL_DAYS)),
      config,
    });
  }

  return decisionFromRetention('drop', Math.max(...decisions.map(decision => decision.durableMemoryScore), 0), {
    signals: aggregateSignals(decisions, ['triage_chunked', 'all_chunks_drop']),
    reasons: aggregateReasons(decisions, [
      `Large interaction (${originalLength} chars) was triaged in ${decisions.length} connected chunks.`,
      'All chunks were classified as low-value noise.',
    ]),
    config,
  });
}

function aggregateSignals(decisions: InteractionTriageDecision[], baseSignals: string[]): string[] {
  const signals = new Set(baseSignals);
  for (const decision of decisions) {
    for (const signal of decision.signals) signals.add(signal);
  }
  return [...signals].slice(0, 20);
}

function aggregateReasons(decisions: InteractionTriageDecision[], baseReasons: string[]): string[] {
  const reasons = [...baseReasons];
  for (const decision of decisions) {
    const prefix = `Chunk ${decisions.indexOf(decision) + 1} ${decision.retention}:`;
    for (const reason of decision.reasons.slice(0, 2)) reasons.push(`${prefix} ${reason}`);
  }
  return reasons.slice(0, 10);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

function parseTriagePayload(raw: string, config: TriageConfig): InteractionTriageDecision | null {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
  try {
    const parsed = JSON.parse((match[1] || raw).trim()) as Partial<InteractionTriageDecision>;
    const retention = parsed.retention;
    if (retention !== 'drop' && retention !== 'ephemeral' && retention !== 'durable') return null;
    const durableMemoryScore = clamp(typeof parsed.durableMemoryScore === 'number' ? parsed.durableMemoryScore : 0.5);
    return decisionFromRetention(retention, durableMemoryScore, {
      signals: Array.isArray(parsed.signals) ? parsed.signals.map(String).slice(0, 20) : ['llm_triage'],
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String).slice(0, 10) : ['LLM triage decision.'],
      ttlDays: typeof parsed.ttlDays === 'number' ? parsed.ttlDays : config.ephemeralTtlDays,
      config,
    });
  } catch {
    return null;
  }
}

function decisionFromRetention(
  retention: InteractionRetention,
  score: number,
  options: { signals: string[]; reasons: string[]; ttlDays?: number; config: TriageConfig },
): InteractionTriageDecision {
  if (retention === 'drop') {
    return {
      retention,
      durableMemoryScore: score,
      shouldStoreEpisode: options.config.archiveDropped === true,
      shouldExtract: false,
      shouldStoreMemory: false,
      signals: options.signals,
      reasons: options.reasons,
    };
  }

  if (retention === 'ephemeral') {
    return {
      retention,
      durableMemoryScore: score,
      shouldStoreEpisode: options.config.storeEphemeral !== false,
      shouldExtract: false,
      shouldStoreMemory: false,
      ttlDays: options.ttlDays ?? DEFAULT_EPHEMERAL_TTL_DAYS,
      signals: options.signals,
      reasons: options.reasons,
    };
  }

  return {
    retention,
    durableMemoryScore: score,
    shouldStoreEpisode: true,
    shouldExtract: true,
    shouldStoreMemory: true,
    signals: options.signals,
    reasons: options.reasons,
  };
}

function conservativeEphemeral(config: TriageConfig, reason: string): InteractionTriageDecision {
  return decisionFromRetention('ephemeral', 0, {
    signals: ['llm_required'],
    reasons: [reason],
    config,
  });
}

async function callTriageLLM(prompt: string, llmConfig?: LLMConfig): Promise<string> {
  const provider = defaultLLMProvider(llmConfig);
  if (provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: llmConfig?.apiKey || process.env.ANTHROPIC_API_KEY });
    const response = await withLLMTimeout(client.messages.create({
      model: defaultLLMModel(provider, llmConfig),
      max_tokens: anthropicMaxOutputTokens(llmConfig),
      system: 'You classify enterprise interactions for memory retention. Return only valid JSON.',
      messages: [{ role: 'user', content: prompt }],
    }), 'triage anthropic request');
    const textBlock = response.content.find(block => block.type === 'text');
    return textBlock?.text || '{}';
  }

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: llmConfig?.apiKey || process.env.OPENAI_API_KEY });
  const response = await withLLMTimeout(client.chat.completions.create({
    model: defaultLLMModel(provider, llmConfig),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You classify enterprise interactions for memory retention. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
  }), 'triage openai request');
  return response.choices[0]?.message?.content || '{}';
}

function selectTriageLLMConfig(content: string, llmConfig?: LLMConfig): LLMConfig | undefined {
  if (llmConfig?.provider || llmConfig?.model || llmConfig?.contextWindowTokens) return llmConfig;
  if (!process.env.OPENAI_API_KEY) return llmConfig;

  const miniConfig: LLMConfig = { provider: 'openai', model: 'gpt-5.4-mini' };
  if (content.length <= llmInputCharBudget(miniConfig)) return miniConfig;

  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: 'claude-sonnet-4-6' };
  }

  return { provider: 'openai', model: 'gpt-5.4' };
}

function visibilitySummary(value: unknown): string {
  if (!value || typeof value !== 'object') return 'none';
  const visibility = value as {
    allowedGroups?: unknown[];
    allowedPrincipals?: unknown[];
    deniedGroups?: unknown[];
    deniedPrincipals?: unknown[];
    classification?: unknown;
    sourceSystem?: unknown;
    inheritedFrom?: unknown;
    sourceAcl?: unknown[];
  };
  const parts = [
    Array.isArray(visibility.allowedGroups) && visibility.allowedGroups.length > 0
      ? `allowedGroups=${visibility.allowedGroups.map(String).join(',')}`
      : undefined,
    Array.isArray(visibility.allowedPrincipals) && visibility.allowedPrincipals.length > 0
      ? `allowedPrincipals=${visibility.allowedPrincipals.map(String).join(',')}`
      : undefined,
    Array.isArray(visibility.deniedGroups) && visibility.deniedGroups.length > 0
      ? `deniedGroups=${visibility.deniedGroups.map(String).join(',')}`
      : undefined,
    Array.isArray(visibility.deniedPrincipals) && visibility.deniedPrincipals.length > 0
      ? `deniedPrincipals=${visibility.deniedPrincipals.map(String).join(',')}`
      : undefined,
    Array.isArray(visibility.sourceAcl) && visibility.sourceAcl.length > 0
      ? `sourceAclEntries=${visibility.sourceAcl.length}`
      : undefined,
    typeof visibility.classification === 'string' ? `classification=${visibility.classification}` : undefined,
    typeof visibility.sourceSystem === 'string' ? `sourceSystem=${visibility.sourceSystem}` : undefined,
    typeof visibility.inheritedFrom === 'string' ? `inheritedFrom=${visibility.inheritedFrom}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : 'public/no explicit restrictions';
}
