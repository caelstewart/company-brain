import type postgres from 'postgres';
import type { AccessContext, EmbeddingConfig, LLMConfig, SearchMethod, SearchResult } from '../types.js';
import { anthropicMaxOutputTokens, defaultLLMModel, defaultLLMProvider } from '../llm-limits.js';
import { withLLMTimeout } from '../llm-timeout.js';
import { search } from '../search/index.js';
import { searchOrganizationalMemory } from '../memory/index.js';
import { visibilitySql } from '../security.js';

export interface AnswerOptions {
  query: string;
  groupId?: string;
  access?: AccessContext;
  limit?: number;
  methods?: SearchMethod[];
  asOf?: Date;
  minConfidence?: number;
  trace?: boolean;
}

export interface AnswerCitation {
  id: string;
  resultId: string;
  type: SearchResult['type'];
  content: string;
  quote?: string;
  confidence?: number;
  sourceEpisodeId?: string | null;
  relation?: string;
  validAt?: Date;
}

export interface GroundedAnswer {
  query: string;
  answer: string;
  citations: AnswerCitation[];
  inference: string[];
  missing: string[];
  confidence: number;
  results: SearchResult[];
  trace?: AnswerTrace;
}

export interface AnswerTrace {
  query: string;
  groupId: string;
  corpus: {
    storedEpisodes: TraceEpisode[];
    extractedFacts: TraceFact[];
    memoryObjects: TraceMemory[];
  };
  retrieval: {
    memoryResults: TraceSearchResult[];
    graphResults: TraceSearchResult[];
    sourceContextResults: TraceSearchResult[];
    fusedResults: TraceSearchResult[];
    citations: AnswerCitation[];
  };
  answerability: AnswerRelevanceAssessment;
  relevance: AnswerRelevanceAssessment;
  synthesis: {
    mode: 'llm' | 'extractive' | 'no_evidence' | 'blocked_by_answerability' | 'blocked_by_relevance';
    citedIds: string[];
    answer: string;
    missing: string[];
    confidence: number;
  };
}

export interface TraceEpisode {
  id: string;
  sourceType: string;
  sourceId: string | null;
  retention?: string;
  shouldExtract?: boolean;
  shouldStoreMemory?: boolean;
  visibility?: unknown;
  preview: string;
}

export interface TraceFact {
  id: string;
  relation: string;
  confidence: number;
  sourceEpisodeId?: string | null;
  quote?: string;
  text: string;
}

export interface TraceMemory {
  id: string;
  kind: string;
  status: string;
  subject?: string | null;
  owner?: string | null;
  sourceEpisodeId?: string | null;
  quote?: string;
  summary: string;
}

export interface TraceSearchResult {
  type: SearchResult['type'];
  id: string;
  score: number;
  method?: string;
  relation?: string;
  sourceEpisodeId?: string | null;
  quote?: string;
  content: string;
}

interface LLMAnswerPayload {
  answer?: string;
  citations?: string[];
  inference?: string[];
  missing?: string[];
  confidence?: number;
}

interface RelevancePayload {
  canAnswer?: boolean;
  missingSubject?: string;
  missing?: string[];
  reason?: string;
}

type CoverageSlot =
  | 'status'
  | 'customer_message'
  | 'workaround'
  | 'limits'
  | 'owner'
  | 'refund'
  | 'entity_separation'
  | 'location'
  | 'security'
  | 'timeline'
  | 'cause'
  | 'decision'
  | 'risk';

interface QueryFramePayload {
  subjectAliases?: string[][];
  requiredCoverage?: CoverageSlot[];
  strictSubjectRequired?: boolean;
  sensitiveObject?: boolean;
  reason?: string;
}

interface AnswerabilityAssessment extends AnswerRelevanceAssessment {
  queryFrame?: QueryFramePayload;
  supportedCitationIds?: string[];
}

export interface AnswerRelevanceAssessment {
  canAnswer: boolean;
  answer: string;
  missing: string[];
  missingSubject?: string;
  reason?: string;
}

export async function answerQuestion(
  db: postgres.Sql,
  options: AnswerOptions,
  embeddingConfig?: EmbeddingConfig,
  llmConfig?: LLMConfig,
): Promise<GroundedAnswer> {
  const groupId = options.groupId || 'default';
  const trace = options.trace
    ? await buildAnswerTraceCorpus(db, groupId, options.access)
    : undefined;
  const [memoryResults, graphResults] = await Promise.all([
    searchOrganizationalMemory(db, {
      query: options.query,
      groupId,
      access: options.access,
      limit: Math.min(options.limit ?? 12, 8),
      embeddingConfig,
    }).catch(() => []),
    search(db, {
      query: options.query,
      groupId,
      access: options.access,
      limit: options.limit ?? 12,
      methods: options.methods,
      asOf: options.asOf,
      minConfidence: options.minConfidence,
      llmConfig,
    }, embeddingConfig),
  ]);
  const sourceContextResults = await loadSourceContextResults(
    db,
    groupId,
    options.access,
    [...memoryResults, ...graphResults],
    options.limit ?? 12,
  );
  const results = fuseAnswerEvidence(memoryResults, [...sourceContextResults, ...graphResults], options.limit ?? 12);
  const initialCitations = buildCitations(results);
  const answerability = await assessStructuredAnswerability(options.query, initialCitations, llmConfig);
  const citations = answerability.supportedCitationIds?.length
    ? initialCitations.filter(citation => answerability.supportedCitationIds?.includes(citation.id))
    : initialCitations;
  const initialRelevance: AnswerRelevanceAssessment = { canAnswer: true, answer: '', missing: [] };
  hydrateRetrievalTrace(trace, memoryResults, graphResults, sourceContextResults, results, citations, answerability, initialRelevance);

  if (!answerability.canAnswer) {
    const answer: GroundedAnswer = {
      query: options.query,
      answer: answerability.answer,
      citations: [],
      inference: [],
      missing: answerability.missing,
      confidence: 0,
      results,
    };
    return attachSynthesisTrace(answer, trace, 'blocked_by_answerability');
  }

  if (citations.length === 0) {
    const answer: GroundedAnswer = {
      query: options.query,
      answer: 'I could not find enough grounded evidence in the brain to answer this.',
      citations: [],
      inference: [],
      missing: ['No supporting search results were returned.'],
      confidence: 0,
      results,
    };
    return attachSynthesisTrace(answer, trace, 'no_evidence');
  }

  const relevance = shouldRunRelevanceCheck(answerability)
    ? await assessAnswerRelevance(options.query, citations, llmConfig)
    : {
      canAnswer: true,
      answer: '',
      missing: [],
      reason: 'Skipped separate relevance LLM because structured answerability bound the requested subject/coverage.',
    };
  hydrateRetrievalTrace(trace, memoryResults, graphResults, sourceContextResults, results, citations, answerability, relevance);

  if (!relevance.canAnswer) {
    const answer: GroundedAnswer = {
      query: options.query,
      answer: relevance.answer,
      citations: [],
      inference: [],
      missing: relevance.missing,
      confidence: 0,
      results,
    };
    return attachSynthesisTrace(answer, trace, 'blocked_by_relevance');
  }

  if (llmConfig?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    const llmAnswer = await synthesizeWithLLM(options.query, citations, llmConfig).catch(() => undefined);
    if (llmAnswer) return attachSynthesisTrace({ ...llmAnswer, results }, trace, 'llm');
  }

  return attachSynthesisTrace(synthesizeExtractive(options.query, citations, results), trace, 'extractive');
}

async function assessStructuredAnswerability(
  query: string,
  citations: AnswerCitation[],
  llmConfig?: LLMConfig,
): Promise<AnswerabilityAssessment> {
  if (citations.length === 0) {
    const queryFrame = buildFallbackQueryFrame(query);
    const subjectGroups = normalizeSubjectGroups(queryFrame.subjectAliases);
    const strictSubjectRequired = queryFrame.strictSubjectRequired !== false && subjectGroups.length > 0;
    if (strictSubjectRequired) {
      const target = subjectGroups.map(group => group[0]).join(' / ');
      return {
        canAnswer: false,
        answer: `I do not have accessible evidence for ${target}, so I cannot answer this without guessing.`,
        missing: [`No supporting search results were returned for ${target}.`],
        missingSubject: target,
        reason: 'Structured answerability failed: no citations were returned for a strict subject query.',
        supportedCitationIds: [],
        queryFrame,
      };
    }
    return { canAnswer: true, answer: '', missing: [], supportedCitationIds: [], queryFrame };
  }

  const queryFrame = await extractQueryFrame(query, llmConfig);
  const subjectGroups = normalizeSubjectGroups(queryFrame.subjectAliases);
  const requiredCoverage = normalizeCoverageSlots(queryFrame.requiredCoverage);
  const bindingGroups = queryFrame.sensitiveObject && subjectGroups.length > 0
    ? [subjectGroups[0]]
    : subjectGroups;
  const boundCitationIds = bindingGroups.length > 0
    ? citationIdsBoundToSubjects(citations, bindingGroups)
    : citations.map(citation => citation.id);
  const missingSubjectGroups = bindingGroups.filter(group => !citations.some(citation => citationBindsToSubjectGroup(citation, group)));
  const coverage = assessCoverage(citations, requiredCoverage);
  const strictSubjectRequired = queryFrame.strictSubjectRequired !== false && subjectGroups.length > 0;

  if (strictSubjectRequired && missingSubjectGroups.length > 0) {
    const target = missingSubjectGroups.map(group => group[0]).join(' / ') || 'the requested subject';
    return {
      canAnswer: false,
      answer: `I do not have accessible evidence for ${target}, so I cannot answer this without guessing.`,
      missing: [`No returned citation is explicitly bound to ${target} or a clear alias.`],
      missingSubject: target,
      reason: `Structured answerability failed: requested subject was not bound to any citation. ${queryFrame.reason || ''}`.trim(),
      queryFrame,
      supportedCitationIds: [],
    };
  }

  if (!strictSubjectRequired && bindingGroups.length > 0 && boundCitationIds.length === 0) {
    const target = bindingGroups.map(group => group[0]).join(' / ') || 'the requested subject';
    return {
      canAnswer: false,
      answer: `I do not have accessible evidence for ${target}, so I cannot answer this without guessing.`,
      missing: [`No returned citation is sufficiently bound to the requested process/object: ${target}.`],
      missingSubject: target,
      reason: `Structured answerability failed: generic nearby evidence did not bind to the requested process/object. ${queryFrame.reason || ''}`.trim(),
      queryFrame,
      supportedCitationIds: [],
    };
  }

  if (requiredCoverage.length > 0 && coverage.supported.length === 0) {
    const target = subjectGroups[0]?.[0] || 'the requested subject';
    return {
      canAnswer: false,
      answer: `I do not have accessible evidence for ${target}, so I cannot answer this without guessing.`,
      missing: [`No returned citation supports the requested coverage: ${requiredCoverage.join(', ')}.`],
      missingSubject: target,
      reason: 'Structured answerability failed: citations were nearby but did not support the requested answer shape.',
      queryFrame,
      supportedCitationIds: [],
    };
  }

  return {
    canAnswer: true,
    answer: '',
    missing: coverage.missing.map(slot => `Evidence did not clearly cover requested slot: ${slot}.`),
    reason: [
      subjectGroups.length > 0 ? `Subject-bound citations: ${boundCitationIds.join(', ') || 'none'}.` : 'No strict subject binding required.',
      requiredCoverage.length > 0 ? `Coverage supported: ${coverage.supported.join(', ') || 'none'}; missing: ${coverage.missing.join(', ') || 'none'}.` : 'No structured coverage slots required.',
    ].join(' '),
    queryFrame,
    supportedCitationIds: boundCitationIds.length > 0 ? boundCitationIds : citations.map(citation => citation.id),
  };
}

function shouldRunRelevanceCheck(answerability: AnswerabilityAssessment): boolean {
  const frame = answerability.queryFrame;
  if (!answerability.canAnswer) return false;
  if (!frame) return true;

  const subjectGroups = normalizeSubjectGroups(frame.subjectAliases);
  const coverageSlots = normalizeCoverageSlots(frame.requiredCoverage);
  const hasStructuredProof = subjectGroups.length > 0 || coverageSlots.length > 0 || frame.sensitiveObject === true;
  return !hasStructuredProof;
}

export async function assessAnswerRelevance(
  query: string,
  citations: AnswerCitation[],
  llmConfig?: LLMConfig,
): Promise<AnswerRelevanceAssessment> {
  if (citations.length === 0) {
    return { canAnswer: true, answer: '', missing: [] };
  }

  if (!(llmConfig?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)) {
    return {
      canAnswer: false,
      answer: 'I cannot safely determine whether the returned evidence answers this question because no LLM relevance checker is configured.',
      missing: ['No LLM relevance checker was configured.'],
    };
  }

  const payload = await judgeRelevanceWithLLM(query, citations, llmConfig).catch(() => undefined);
  const missingSubject = typeof payload?.missingSubject === 'string' ? payload.missingSubject : undefined;

  if (!payload || payload.canAnswer !== false) {
    return { canAnswer: true, answer: '', missing: [], reason: payload?.reason, missingSubject };
  }

  const target = missingSubject || 'the requested subject';
  return {
    canAnswer: false,
    answer: `I do not have accessible evidence for ${target}, so I cannot answer this without guessing.`,
    missing: normalizeStringList(payload.missing).length
      ? normalizeStringList(payload.missing)
      : [`No returned evidence directly matched the requested subject: ${target}.`],
    missingSubject,
    reason: payload.reason,
  };
}

async function judgeRelevanceWithLLM(
  query: string,
  citations: AnswerCitation[],
  llmConfig?: LLMConfig,
): Promise<RelevancePayload> {
  const prompt = [
    'Decide whether the cited evidence directly supports answering the user question.',
    'Return ONLY valid JSON with keys: canAnswer, missingSubject, missing, reason. missingSubject must be a string when present, never a boolean.',
    'Use canAnswer=false when the query asks about a specific subject, incident, person, company, system, path, metric, or object and the accessible evidence is only nearby/tangential.',
    'For questions about a named person, canAnswer MUST be false unless the evidence directly mentions that person, a clear alias for that person, or a directly linked role/title that identifies them.',
    'Do not answer a named-person question by summarizing nearby customer, incident, or project evidence that does not mention that person.',
    'Use canAnswer=false for secret/path/incident questions unless evidence includes the central incident/system/path subject, not just generic words like "path" or "token".',
    'Use canAnswer=true when evidence directly mentions the requested subject or clearly answers the question.',
    'Use canAnswer=true when evidence mentions the requested subject and supports a negative or cautious answer, such as "correlation only", "not proven", "root cause unknown", or "no decision".',
    'For causality questions, if evidence contains the asked variables and says causality is not proven or only correlated, canAnswer MUST be true because the supported answer is a caveat.',
    'Partial names can count as a direct match when the evidence context clearly identifies the same person, customer, candidate, system, or incident.',
    'For transcripts, threads, and debriefs, adjacent turns in the same cited source can answer a question about the named subject; do not require every line to repeat the full name.',
    '',
    `Question: ${query}`,
    '',
    'Evidence:',
    ...citations.map(formatCitationForLLM),
  ].join('\n');

  const provider = defaultLLMProvider(llmConfig);
  const raw = provider === 'anthropic'
    ? await callAnthropic(prompt, llmConfig)
    : await callOpenAI(prompt, llmConfig);
  return parseRelevancePayload(raw);
}

async function extractQueryFrame(query: string, llmConfig?: LLMConfig): Promise<QueryFramePayload> {
  const fallback = buildFallbackQueryFrame(query);
  if (!(llmConfig?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)) return fallback;

  const prompt = [
    'Extract a structured answerability frame for this question.',
    'Return ONLY valid JSON with keys: subjectAliases, requiredCoverage, strictSubjectRequired, sensitiveObject, reason.',
    'subjectAliases is an array of alias groups. Each group contains names/aliases for the same requested subject.',
    'Use separate subject groups when the question asks whether two entities are the same or different.',
    'requiredCoverage may include only these values: status, customer_message, workaround, limits, owner, refund, entity_separation, location, security, timeline, cause, decision, risk.',
    'strictSubjectRequired should be true when the question asks about a named person, company, incident, ticket, system, path, account, or object.',
    'sensitiveObject should be true for secrets, tokens, keys, credentials, private paths, compliance evidence, or access locations.',
    '',
    `Question: ${query}`,
  ].join('\n');

  const provider = defaultLLMProvider(llmConfig);
  const raw = provider === 'anthropic'
    ? await callAnthropic(prompt, llmConfig)
    : await callOpenAI(prompt, llmConfig);
  return mergeQueryFrames(fallback, parseQueryFramePayload(raw));
}

function mergeQueryFrames(fallback: QueryFramePayload, parsed: QueryFramePayload): QueryFramePayload {
  const parsedSubjects = normalizeSubjectGroups(parsed.subjectAliases);
  const fallbackSubjects = normalizeSubjectGroups(fallback.subjectAliases);
  const parsedCoverage = normalizeCoverageSlots(parsed.requiredCoverage);
  const fallbackCoverage = normalizeCoverageSlots(fallback.requiredCoverage);

  return {
    subjectAliases: parsedSubjects.length > 0 ? parsedSubjects : fallbackSubjects,
    requiredCoverage: parsedCoverage.length > 0 ? parsedCoverage : fallbackCoverage,
    strictSubjectRequired: parsed.strictSubjectRequired ?? fallback.strictSubjectRequired,
    sensitiveObject: parsed.sensitiveObject ?? fallback.sensitiveObject,
    reason: parsed.reason || fallback.reason,
  };
}

function buildFallbackQueryFrame(query: string): QueryFramePayload {
  const subjects = extractStructuralSubjectAliases(query);
  return {
    subjectAliases: subjects,
    requiredCoverage: inferCoverageSlots(query),
    strictSubjectRequired: subjects.length > 0 || isSensitiveObjectQuery(query),
    sensitiveObject: isSensitiveObjectQuery(query),
    reason: 'Fallback frame from structural query features.',
  };
}

function extractStructuralSubjectAliases(query: string): string[][] {
  const groups: string[][] = [];
  const titlePhrases = Array.from(query.matchAll(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+\b/g))
    .map(match => match[0])
    .map(phrase => phrase.replace(/^(What|Who|Where|When|Why|How|Is|Are|Does|Do|Did|Can|Could|Should)\s+/, ''))
    .filter(phrase => phrase.includes(' '));
  const acronyms = Array.from(query.matchAll(/\b[A-Z][A-Z0-9]{1,}\b/g)).map(match => match[0]);
  const usedAcronyms = new Set<string>();

  for (const phrase of titlePhrases) {
    const phraseIndex = query.indexOf(phrase);
    const nearbyAcronyms = acronyms.filter(acronym => {
      const acronymIndex = query.indexOf(acronym);
      return acronymIndex >= 0 && Math.abs(acronymIndex - phraseIndex) <= 28;
    });
    nearbyAcronyms.forEach(acronym => usedAcronyms.add(acronym));
    groups.push([phrase, ...nearbyAcronyms]);
  }

  for (const acronym of acronyms) {
    if (!usedAcronyms.has(acronym)) groups.push([acronym]);
  }

  const compact = Array.from(new Map(groups.map(group => [group.join('|').toLowerCase(), group])).values());
  return compact.slice(0, 4);
}

function inferCoverageSlots(query: string): CoverageSlot[] {
  const normalized = normalizeForMatch(query);
  const slots: CoverageSlot[] = [];
  if (containsAny(normalized, ['what is happening', 'status', 'current', 'issue', 'incident', 'what happened'])) slots.push('status');
  if (containsAny(normalized, ['tell the customer', 'customer facing', 'externally', 'should not be said', 'what should we tell'])) slots.push('customer_message');
  if (containsAny(normalized, ['workaround', 'mitigation', 'fallback'])) slots.push('workaround');
  if (containsAny(normalized, ['limit', 'limits', 'scope', 'risk', 'risks'])) slots.push('limits');
  if (containsAny(normalized, ['owner', 'owns', 'responsible', 'next steps'])) slots.push('owner');
  if (containsAny(normalized, ['refund', 'cash refund', 'service credit', 'credit approved'])) slots.push('refund');
  if (containsAny(normalized, ['same as', 'same customer', 'different', 'separate', 'confuse', 'merge'])) slots.push('entity_separation');
  if (containsAny(normalized, ['where is', 'stored', 'path', 'location', 'lives at'])) slots.push('location');
  if (containsAny(normalized, ['token', 'secret', 'credential', 'access key', 'password', 'compliance', 'soc2'])) slots.push('security');
  if (containsAny(normalized, ['timeline', 'when', 'by ', 'due'])) slots.push('timeline');
  if (containsAny(normalized, ['root cause', 'caused', 'why'])) slots.push('cause');
  if (containsAny(normalized, ['decision', 'decided', 'approved'])) slots.push('decision');
  if (containsAny(normalized, ['risk', 'blocker', 'concern', 'concerns', 'flag', 'flags'])) slots.push('risk');
  return Array.from(new Set(slots));
}

function isSensitiveObjectQuery(query: string): boolean {
  return containsAny(normalizeForMatch(query), ['token', 'secret', 'credential', 'access key', 'password', 'private path', '1password', 'soc2']);
}

function citationIdsBoundToSubjects(citations: AnswerCitation[], subjectGroups: string[][]): string[] {
  return citations
    .filter(citation => subjectGroups.some(group => citationBindsToSubjectGroup(citation, group)))
    .map(citation => citation.id);
}

function citationBindsToSubjectGroup(citation: AnswerCitation, subjectGroup: string[]): boolean {
  const text = normalizeForMatch(formatCitationForLLM(citation));
  return subjectGroup.some(alias => {
    const normalizedAlias = normalizeForMatch(alias);
    if (normalizedAlias.length < 2) return false;
    if (text.includes(normalizedAlias)) return true;

    const tokens = significantTokens(normalizedAlias);
    if (tokens.length < 2) return false;
    const matched = tokens.filter(token => text.includes(token));
    return matched.length >= Math.max(2, Math.ceil(tokens.length * 0.6));
  });
}

function assessCoverage(citations: AnswerCitation[], requiredCoverage: CoverageSlot[]): { supported: CoverageSlot[]; missing: CoverageSlot[] } {
  if (requiredCoverage.length === 0) return { supported: [], missing: [] };
  const evidence = normalizeForMatch(citations.map(formatCitationForLLM).join('\n'));
  const supported = requiredCoverage.filter(slot => containsAny(evidence, coveragePatterns(slot)));
  return {
    supported,
    missing: requiredCoverage.filter(slot => !supported.includes(slot)),
  };
}

function coveragePatterns(slot: CoverageSlot): string[] {
  switch (slot) {
    case 'status': return ['issue', 'incident', 'missing', 'blocked', 'affected', 'running', 'ongoing', 'current'];
    case 'customer_message': return ['customer facing', 'tell', 'do not say', 'externally', 'update', 'customer'];
    case 'workaround': return ['workaround', 'mitigation', 'fallback', 'enable', 'temporary', 'until'];
    case 'limits': return ['limit', 'scope', 'only', 'risk', 'slower', 'does not include', 'not available', 'do not'];
    case 'owner': return ['owner', 'owns', 'responsible', 'assigned', 'next update', 'on-call', 'on call'];
    case 'refund': return ['refund', 'cash refund', 'service credit', 'finance', 'legal', 'approved'];
    case 'entity_separation': return ['not related', 'separate', 'do not confuse', 'do not merge', 'not the same', 'is not', 'prospect'];
    case 'location': return ['stored', 'lives at', 'path', 'location', '1password', 'item'];
    case 'security': return ['token', 'secret', 'credential', 'restricted', 'security', 'access', 'compliance', 'soc2'];
    case 'timeline': return ['by', 'due', 'today', 'tomorrow', 'monday', 'friday', 'eod', 'pt'];
    case 'cause': return ['root cause', 'caused', 'because', 'suspected', 'confirmed', 'not established'];
    case 'decision': return ['decision', 'decided', 'approved', 'not approved', 'no decision'];
    case 'risk': return ['risk', 'blocker', 'blocked', 'concern', 'weak', 'flag', 'issue'];
  }
}

function normalizeSubjectGroups(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value
    .map(group => Array.isArray(group) ? group.map(String) : [String(group)])
    .map(group => group.map(item => item.trim()).filter(isUsableSubjectAlias))
    .filter(group => group.length > 0)
    .slice(0, 6);
}

function isUsableSubjectAlias(value: string): boolean {
  const normalized = normalizeForMatch(value);
  if (normalized.length < 2) return false;
  return !new Set([
    'who',
    'what',
    'where',
    'when',
    'why',
    'how',
    'it',
    'they',
    'them',
    'this',
    'that',
    'these',
    'those',
  ]).has(normalized);
}

function normalizeCoverageSlots(value: unknown): CoverageSlot[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<CoverageSlot>([
    'status',
    'customer_message',
    'workaround',
    'limits',
    'owner',
    'refund',
    'entity_separation',
    'location',
    'security',
    'timeline',
    'cause',
    'decision',
    'risk',
  ]);
  return Array.from(new Set(value.map(String).filter((slot): slot is CoverageSlot => allowed.has(slot as CoverageSlot))));
}

function significantTokens(value: string): string[] {
  const stopwords = new Set([
    'the',
    'and',
    'or',
    'for',
    'with',
    'about',
    'into',
    'from',
    'that',
    'this',
    'what',
    'where',
    'when',
    'who',
    'how',
    'why',
  ]);
  return value
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 2 && !stopwords.has(token));
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some(term => text.includes(normalizeForMatch(term)));
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"']/g, '')
    .replace(/[^a-z0-9_.$/\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCitations(results: SearchResult[]): AnswerCitation[] {
  return results
    .filter(result => result.type === 'fact' || result.type === 'episode' || result.type === 'memory')
    .slice(0, 12)
    .map((result, index) => {
      const evidence = result.metadata.evidence && typeof result.metadata.evidence === 'object'
        ? result.metadata.evidence as Record<string, unknown>
        : {};
      return {
        id: `C${index + 1}`,
        resultId: result.id,
        type: result.type,
        content: result.content,
        quote: typeof evidence.quote === 'string' ? evidence.quote : undefined,
        confidence: typeof result.metadata.confidence === 'number'
          ? result.metadata.confidence
          : typeof result.score === 'number' ? result.score : undefined,
        sourceEpisodeId: typeof evidence.sourceEpisodeId === 'string' ? evidence.sourceEpisodeId : null,
        relation: result.relation,
        validAt: result.validAt,
      };
    });
}

async function synthesizeWithLLM(
  query: string,
  citations: AnswerCitation[],
  llmConfig?: LLMConfig,
): Promise<Omit<GroundedAnswer, 'results'>> {
  const prompt = [
    'Answer the user question using ONLY the cited evidence.',
    'Return valid JSON with keys: answer, citations, inference, missing, confidence.',
    'Rules:',
    '- Every factual sentence in answer must be supported by at least one citation id.',
    '- Use citation ids inline like [C1].',
    '- Put interpretation beyond a direct quote in inference, not answer.',
    '- If evidence is missing or uncertain, say so in missing.',
    '- Do not invent status, root cause, owner, timing, or next step.',
    '- Preserve literal values from evidence when directly asked: paths, numbers, owners, dates, statuses, and object names.',
    '- For "what happened", blocker, next-step, concern, risk, or incident questions, include the material concrete details present in evidence rather than only a high-level summary.',
    '- For transcripts, threads, and debriefs, use adjacent turns from the same source as shared context when they refer to the same subject under discussion.',
    '- For workflow, policy, procedure, or operating-memory questions, include approval thresholds, recording/audit requirements, exceptions, owners, and constraints when present in evidence.',
    '- Preserve explicit caveats using neutral wording: say "root cause is unknown/not established" rather than "root cause was ..." unless the evidence identifies an actual root cause.',
    '- Do not turn "parked", "no decision", or "not proven" into stronger claims like rejected, ruled out, or caused.',
    '- Prefer memory evidence for decisions, commitments, owners, blockers, risks, and uncertainty.',
    '',
    `Question: ${query}`,
    '',
    'Evidence:',
    ...citations.map(citation => [
      formatCitationForLLM(citation),
      citation.confidence != null ? `confidence=${citation.confidence}` : undefined,
      citation.relation ? `relation=${citation.relation}` : undefined,
    ].filter(Boolean).join(' | ')),
  ].join('\n');

  const provider = defaultLLMProvider(llmConfig);
  const raw = provider === 'anthropic'
    ? await callAnthropic(prompt, llmConfig)
    : await callOpenAI(prompt, llmConfig);
  const parsed = parseAnswerPayload(raw);
  const validCitationIds = new Set(citations.map(citation => citation.id));
  const citedIds = (parsed.citations || []).filter(id => validCitationIds.has(id));

  return {
    query,
    answer: normalizeUncertaintyWording(ensureCitationText(parsed.answer || '', citedIds)),
    citations: citations.filter(citation => citedIds.includes(citation.id)),
    inference: Array.isArray(parsed.inference) ? parsed.inference.map(String) : [],
    missing: Array.isArray(parsed.missing) ? parsed.missing.map(String) : [],
    confidence: clampConfidence(parsed.confidence),
  };
}

function synthesizeExtractive(
  query: string,
  citations: AnswerCitation[],
  results: SearchResult[],
): GroundedAnswer {
  const cited = citations.slice(0, 5);
  const answer = cited
    .map(citation => `${citation.quote || citation.content} [${citation.id}]`)
    .join(' ');
  const averageConfidence = cited.reduce((sum, citation) => sum + (citation.confidence ?? 0.5), 0) / cited.length;

  return {
    query,
    answer,
    citations: cited,
    inference: [],
    missing: ['No LLM answer synthesizer was configured; returned extractive evidence summary.'],
    confidence: Math.round(averageConfidence * 1000) / 1000,
    results,
  };
}

async function callAnthropic(prompt: string, llmConfig?: LLMConfig): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: llmConfig?.apiKey || process.env.ANTHROPIC_API_KEY });
  const response = await withLLMTimeout(client.messages.create({
    model: defaultLLMModel('anthropic', llmConfig),
    max_tokens: anthropicMaxOutputTokens(llmConfig),
    system: 'You are a grounded answer synthesizer. Return only valid JSON.',
    messages: [{ role: 'user', content: prompt }],
  }), 'answer anthropic request');
  const textBlock = response.content.find(block => block.type === 'text');
  return textBlock?.text || '{}';
}

async function callOpenAI(prompt: string, llmConfig?: LLMConfig): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: llmConfig?.apiKey || process.env.OPENAI_API_KEY });
  const response = await withLLMTimeout(client.chat.completions.create({
    model: defaultLLMModel('openai', llmConfig),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a grounded answer synthesizer. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
  }), 'answer openai request');
  return response.choices[0]?.message?.content || '{}';
}

function fuseAnswerEvidence(memoryResults: SearchResult[], graphResults: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const fused: SearchResult[] = [];
  for (const result of [...memoryResults, ...graphResults]) {
    const key = `${result.type}:${result.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fused.push(result);
  }
  return fused
    .sort((a, b) => answerEvidenceScore(b) - answerEvidenceScore(a))
    .slice(0, limit);
}

function answerEvidenceScore(result: SearchResult): number {
  const typeBoost = result.type === 'memory'
    ? 0.2
    : result.type === 'episode'
      ? 0.28
      : result.type === 'fact'
        ? 0.08
        : 0;
  return (result.score || 0) + typeBoost;
}

function formatCitationForLLM(citation: AnswerCitation): string {
  if (citation.quote && citation.quote.trim() && citation.quote.trim() !== citation.content.trim()) {
    return `[${citation.id}] ${citation.content}\nQuote: ${citation.quote}`;
  }
  return `[${citation.id}] ${citation.content}`;
}

async function loadSourceContextResults(
  db: postgres.Sql,
  groupId: string,
  access: AccessContext | undefined,
  results: SearchResult[],
  limit: number,
): Promise<SearchResult[]> {
  const byEpisodeId = new Map<string, number>();
  const snippetsByEpisodeId = new Map<string, Array<{ quote?: string; startOffset?: number; endOffset?: number; text: string }>>();

  for (const result of results) {
    const episodeId = sourceEpisodeIdForResult(result);
    if (!episodeId) continue;
    byEpisodeId.set(episodeId, Math.max(byEpisodeId.get(episodeId) ?? 0, result.score || 0));
    const evidence = evidenceForResult(result);
    const snippets = snippetsByEpisodeId.get(episodeId) || [];
    snippets.push({
      quote: typeof evidence.quote === 'string' ? evidence.quote : undefined,
      startOffset: typeof evidence.startOffset === 'number' ? evidence.startOffset : undefined,
      endOffset: typeof evidence.endOffset === 'number' ? evidence.endOffset : undefined,
      text: result.content,
    });
    snippetsByEpisodeId.set(episodeId, snippets);
  }

  const ids = Array.from(byEpisodeId.keys()).slice(0, Math.max(limit, 12));
  if (ids.length === 0) return [];

  const rows = await db`
    SELECT id, content, source_type, source_id, metadata, valid_at
    FROM episodes
    WHERE group_id = ${groupId}
      AND id = ANY(${ids}::uuid[])
      ${visibilitySql(db, db`visibility`, access)}
  `;

  return rows.map(row => {
    const id = String(row.id);
    const sourceScore = byEpisodeId.get(id) ?? 0;
    return {
      type: 'episode' as const,
      id,
      score: sourceScore + 0.35,
      content: focusedEpisodeContext(String(row.content || ''), snippetsByEpisodeId.get(id) || []),
      metadata: {
        sourceType: row.source_type,
        sourceId: row.source_id,
        method: 'source_context',
        parentContext: true,
        grounding: {
          supported: true,
          confidence: Math.min(1, sourceScore),
          instruction: 'Use this parent interaction as source context for nearby retrieved facts from the same episode.',
        },
      },
      validAt: row.valid_at,
    };
  });
}

function sourceEpisodeIdForResult(result: SearchResult): string | null {
  if (result.type === 'episode') return result.id;

  const evidence = evidenceForResult(result);
  if (typeof evidence.sourceEpisodeId === 'string') return evidence.sourceEpisodeId;

  if (typeof result.metadata.sourceEpisodeId === 'string') return result.metadata.sourceEpisodeId;
  return null;
}

function evidenceForResult(result: SearchResult): Record<string, unknown> {
  return result.metadata.evidence && typeof result.metadata.evidence === 'object'
    ? result.metadata.evidence as Record<string, unknown>
    : {};
}

function focusedEpisodeContext(
  content: string,
  snippets: Array<{ quote?: string; startOffset?: number; endOffset?: number; text: string }>,
): string {
  const windows: string[] = [];
  for (const snippet of snippets.slice(0, 8)) {
    const located = locateSnippet(content, snippet);
    if (located) windows.push(located);
  }

  const uniqueWindows = Array.from(new Set(windows));
  if (uniqueWindows.length > 0) {
    return uniqueWindows
      .map((window, index) => `Source context window ${index + 1}:\n${window}`)
      .join('\n\n');
  }

  return truncate(content, 2400);
}

function locateSnippet(
  content: string,
  snippet: { quote?: string; startOffset?: number; endOffset?: number; text: string },
): string | null {
  const start = typeof snippet.startOffset === 'number'
    ? snippet.startOffset
    : findSnippetIndex(content, snippet.quote || snippet.text);
  if (start < 0) return null;

  const end = typeof snippet.endOffset === 'number'
    ? snippet.endOffset
    : start + (snippet.quote || snippet.text).length;
  const radius = 1200;
  return content
    .slice(Math.max(0, start - radius), Math.min(content.length, end + radius))
    .trim();
}

function findSnippetIndex(content: string, snippet: string): number {
  if (!snippet.trim()) return -1;
  const normalizedContent = content.toLowerCase();
  const normalizedSnippet = snippet.toLowerCase();
  const direct = normalizedContent.indexOf(normalizedSnippet);
  if (direct >= 0) return direct;

  const compactSnippet = normalizedSnippet
    .split(/\s+/)
    .filter(token => token.length > 3)
    .slice(0, 8)
    .join(' ');
  return compactSnippet ? normalizedContent.indexOf(compactSnippet) : -1;
}

async function buildAnswerTraceCorpus(
  db: postgres.Sql,
  groupId: string,
  access?: AccessContext,
): Promise<AnswerTrace> {
  const [episodeRows, factRows, memoryRows] = await Promise.all([
    db`
      SELECT id, source_type, source_id, content, metadata, visibility
      FROM episodes
      WHERE group_id = ${groupId}
        ${visibilitySql(db, db`visibility`, access)}
      ORDER BY valid_at DESC, created_at DESC
      LIMIT 40
    `,
    db`
      SELECT id, relation, fact_text, confidence, evidence
      FROM facts
      WHERE group_id = ${groupId}
        AND invalid_at IS NULL
        ${visibilitySql(db, db`visibility`, access)}
      ORDER BY valid_at DESC, created_at DESC
      LIMIT 60
    `,
    db`
      SELECT id, kind, status, subject, owner, summary, evidence, source_episode_id
      FROM organizational_memory
      WHERE group_id = ${groupId}
        ${visibilitySql(db, db`visibility`, access)}
      ORDER BY valid_at DESC, created_at DESC
      LIMIT 60
    `,
  ]);

  return {
    query: '',
    groupId,
    corpus: {
      storedEpisodes: episodeRows.map(row => {
        const triage = row.metadata?.triage && typeof row.metadata.triage === 'object'
          ? row.metadata.triage as Record<string, unknown>
          : {};
        return {
          id: String(row.id),
          sourceType: String(row.source_type),
          sourceId: typeof row.source_id === 'string' ? row.source_id : null,
          retention: typeof triage.retention === 'string' ? triage.retention : undefined,
          shouldExtract: typeof triage.shouldExtract === 'boolean' ? triage.shouldExtract : undefined,
          shouldStoreMemory: typeof triage.shouldStoreMemory === 'boolean' ? triage.shouldStoreMemory : undefined,
          visibility: row.visibility,
          preview: truncate(String(row.content || ''), 500),
        };
      }),
      extractedFacts: factRows.map(row => {
        const evidence = row.evidence && typeof row.evidence === 'object'
          ? row.evidence as Record<string, unknown>
          : {};
        return {
          id: String(row.id),
          relation: String(row.relation),
          confidence: Number(row.confidence),
          sourceEpisodeId: typeof evidence.sourceEpisodeId === 'string' ? evidence.sourceEpisodeId : null,
          quote: typeof evidence.quote === 'string' ? evidence.quote : undefined,
          text: truncate(String(row.fact_text || ''), 500),
        };
      }),
      memoryObjects: memoryRows.map(row => {
        const evidence = row.evidence && typeof row.evidence === 'object'
          ? row.evidence as Record<string, unknown>
          : {};
        return {
          id: String(row.id),
          kind: String(row.kind),
          status: String(row.status),
          subject: typeof row.subject === 'string' ? row.subject : null,
          owner: typeof row.owner === 'string' ? row.owner : null,
          sourceEpisodeId: typeof row.source_episode_id === 'string' ? row.source_episode_id : null,
          quote: typeof evidence.quote === 'string' ? evidence.quote : undefined,
          summary: truncate(String(row.summary || ''), 500),
        };
      }),
    },
    retrieval: {
      memoryResults: [],
      graphResults: [],
      sourceContextResults: [],
      fusedResults: [],
      citations: [],
    },
    answerability: { canAnswer: true, answer: '', missing: [] },
    relevance: { canAnswer: true, answer: '', missing: [] },
    synthesis: {
      mode: 'no_evidence',
      citedIds: [],
      answer: '',
      missing: [],
      confidence: 0,
    },
  };
}

function hydrateRetrievalTrace(
  trace: AnswerTrace | undefined,
  memoryResults: SearchResult[],
  graphResults: SearchResult[],
  sourceContextResults: SearchResult[],
  fusedResults: SearchResult[],
  citations: AnswerCitation[],
  answerability: AnswerRelevanceAssessment,
  relevance: AnswerRelevanceAssessment,
): void {
  if (!trace) return;
  trace.retrieval = {
    memoryResults: memoryResults.map(traceSearchResult),
    graphResults: graphResults.map(traceSearchResult),
    sourceContextResults: sourceContextResults.map(traceSearchResult),
    fusedResults: fusedResults.map(traceSearchResult),
    citations,
  };
  trace.answerability = answerability;
  trace.relevance = relevance;
}

function attachSynthesisTrace(
  answer: GroundedAnswer,
  trace: AnswerTrace | undefined,
  mode: AnswerTrace['synthesis']['mode'],
): GroundedAnswer {
  if (!trace) return answer;
  trace.query = answer.query;
  trace.synthesis = {
    mode,
    citedIds: answer.citations.map(citation => citation.id),
    answer: answer.answer,
    missing: answer.missing,
    confidence: answer.confidence,
  };
  return { ...answer, trace };
}

function traceSearchResult(result: SearchResult): TraceSearchResult {
  const evidence = result.metadata.evidence && typeof result.metadata.evidence === 'object'
    ? result.metadata.evidence as Record<string, unknown>
    : {};
  return {
    type: result.type,
    id: result.id,
    score: result.score,
    method: typeof result.metadata.method === 'string' ? result.metadata.method : undefined,
    relation: result.relation,
    sourceEpisodeId: typeof evidence.sourceEpisodeId === 'string' ? evidence.sourceEpisodeId : null,
    quote: typeof evidence.quote === 'string' ? evidence.quote : undefined,
    content: truncate(result.content, 500),
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function parseAnswerPayload(raw: string): LLMAnswerPayload {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
  try {
    return JSON.parse((match[1] || raw).trim()) as LLMAnswerPayload;
  } catch {
    return { answer: '', citations: [], inference: [], missing: ['Answer model returned invalid JSON.'], confidence: 0 };
  }
}

function parseRelevancePayload(raw: string): RelevancePayload {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
  try {
    return JSON.parse((match[1] || raw).trim()) as RelevancePayload;
  } catch {
    return { canAnswer: true };
  }
}

function parseQueryFramePayload(raw: string): QueryFramePayload {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
  try {
    return JSON.parse((match[1] || raw).trim()) as QueryFramePayload;
  } catch {
    return {};
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

function ensureCitationText(answer: string, citationIds: string[]): string {
  if (!answer.trim()) return 'I could not synthesize a grounded answer from the returned evidence.';
  if (citationIds.length === 0 || /\[C\d+\]/.test(answer)) return answer;
  return `${answer} ${citationIds.map(id => `[${id}]`).join(' ')}`;
}

function normalizeUncertaintyWording(answer: string): string {
  return answer
    .replace(/\broot cause was still unknown\b/gi, 'root cause is still unknown')
    .replace(/\broot cause was unknown\b/gi, 'root cause is unknown');
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}
