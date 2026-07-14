/**
 * Canonical Agent Run Ledger contract.
 *
 * This module is deliberately independent from RuntimeTask and RuntimeMission:
 * Operator owns durable persistence, while producers exchange this bounded,
 * versioned, JSON-safe wire shape through an application-service boundary.
 */
import { createHash } from 'node:crypto';

import { redactText } from './redaction.js';
import type { JsonValue, RuntimeRiskLevel } from './types.js';

export const AGENT_RUN_LEDGER_SCHEMA_VERSION = '1.0' as const;
export const AGENT_RUN_LEDGER_SCOPE_HASH_DOMAIN = 'agent-run-ledger-scope-v1' as const;
export const AGENT_RUN_LEDGER_PAYLOAD_HASH_DOMAIN = 'agent-run-ledger-payload-v1' as const;

export type AgentRunLedgerStatus =
  | 'created'
  | 'approval_required'
  | 'approved'
  | 'running'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'reconciliation_required';

export type AgentRunLedgerOutcome =
  | 'pending'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'blocked'
  | 'reconciliation_required';

export type AgentRunLedgerApprovalStatus = 'not_required' | 'required' | 'approved' | 'rejected';
export type AgentRunLedgerValidationOutcome = 'not_run' | 'passed' | 'failed';
export type AgentRunLedgerEvidenceIntegrityStatus = 'not_present' | 'unverified' | 'verified' | 'invalid';
export type AgentRunLedgerActionOutcome = 'pending' | 'succeeded' | 'failed' | 'blocked' | 'not_applicable';
export type AgentRunLedgerEvidenceKind = 'file' | 'log' | 'artifact' | 'command_output' | 'url' | 'note';

export interface AgentRunLedgerCostEstimate {
  kind: 'known' | 'unknown' | 'not_applicable';
  /** Integer micros keep canonical JSON identical across TypeScript and Python. */
  amount_micros: number | null;
  currency: string | null;
}

export interface AgentRunLedgerAction {
  action_id: string;
  action_type: string;
  summary: string;
  outcome: AgentRunLedgerActionOutcome;
}

export interface AgentRunLedgerTool {
  tool_id: string;
  name: string;
  version: string | null;
}

export interface AgentRunLedgerEvidenceRef {
  evidence_id: string;
  kind: AgentRunLedgerEvidenceKind;
  /** Opaque reference. It is never trimmed or rewritten; unsafe references are rejected. */
  uri: string;
  sha256: string | null;
  captured_at: string;
}

/** Full materialized snapshot written for one ordered lifecycle transition. */
export interface AgentRunLedgerEntry {
  schema_version: typeof AGENT_RUN_LEDGER_SCHEMA_VERSION;
  run_id: string;
  event_id: string;
  /** Starts at 1 and increments by exactly one for every new transition. */
  sequence: number;
  product_id: string;
  workflow_id: string;
  agent_id: string;
  attempt_id: string;
  parent_run_id: string | null;
  trace_id: string | null;

  status: AgentRunLedgerStatus;
  outcome: AgentRunLedgerOutcome;
  started_at: string;
  completed_at: string | null;
  provider: string;
  model: string;
  input_summary: string;
  actions_taken: AgentRunLedgerAction[];
  tools_used: AgentRunLedgerTool[];
  latency_ms: number | null;
  cost_estimate: AgentRunLedgerCostEstimate;

  approval_status: AgentRunLedgerApprovalStatus;
  approval_actor: string | null;
  approval_timestamp: string | null;
  risk_level: RuntimeRiskLevel;
  production_impact: boolean;
  validation_result: AgentRunLedgerValidationOutcome;
  validation_summary: string | null;
  failure_reason: string | null;
  failure_code: string | null;

  evidence_refs: AgentRunLedgerEvidenceRef[];
  evidence_count: number;
  evidence_integrity_status: AgentRunLedgerEvidenceIntegrityStatus;

  payload_hash: string;
  scope_hash: string;
  created_at: string;
  updated_at: string;
  source_subsystem: string;
}

export type AgentRunLedgerEntryDraft = Omit<AgentRunLedgerEntry, 'payload_hash' | 'scope_hash'>;

export const AGENT_RUN_LEDGER_LIMITS = Object.freeze({
  opaque_id: 256,
  provider_or_model: 128,
  free_text: 4_096,
  action_or_tool_count: 64,
  evidence_count: 64,
  uri: 2_048,
  canonical_bytes: 131_072,
});

export type AgentRunLedgerValidationIssueCode =
  | 'INVALID_TYPE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_ENUM'
  | 'INVALID_INTEGER'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_OPAQUE_ID'
  | 'INVALID_TEXT'
  | 'FIELD_TOO_LARGE'
  | 'ARRAY_TOO_LARGE'
  | 'ENTRY_TOO_LARGE'
  | 'FREE_TEXT_REQUIRES_REDACTION'
  | 'SECRET_IN_OPAQUE_FIELD'
  | 'SIGNED_CREDENTIAL_URL'
  | 'INVALID_HASH'
  | 'SCOPE_HASH_MISMATCH'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'OUTCOME_STATUS_MISMATCH'
  | 'TIMESTAMP_ORDER_MISMATCH'
  | 'LATENCY_MISMATCH'
  | 'COST_SHAPE_MISMATCH'
  | 'APPROVAL_METADATA_MISMATCH'
  | 'VALIDATION_METADATA_MISMATCH'
  | 'FAILURE_METADATA_MISMATCH'
  | 'EVIDENCE_COUNT_MISMATCH'
  | 'EVIDENCE_INTEGRITY_MISMATCH'
  | 'COMPLETED_REQUIRES_EVIDENCE'
  | 'COMPLETED_REQUIRES_VALIDATION'
  | 'PRODUCTION_APPROVAL_REQUIRED';

export interface AgentRunLedgerValidationIssue {
  code: AgentRunLedgerValidationIssueCode;
  field: string;
  message: string;
}

export class AgentRunLedgerValidationError extends Error {
  readonly category = 'AGENT_RUN_LEDGER_VALIDATION_FAILED' as const;
  readonly code: AgentRunLedgerValidationIssueCode;
  readonly issues: AgentRunLedgerValidationIssue[];

  constructor(issues: AgentRunLedgerValidationIssue[]) {
    super(`AgentRunLedgerEntry validation failed with ${issues.length} issue(s).`);
    this.name = 'AgentRunLedgerValidationError';
    this.code = issues[0]?.code ?? 'INVALID_TYPE';
    this.issues = issues.map((issue) => ({ ...issue }));
  }
}

export type AgentRunLedgerTransitionErrorCode =
  | 'AGENT_RUN_LEDGER_INITIAL_STATUS_MISMATCH'
  | 'AGENT_RUN_LEDGER_SEQUENCE_MISMATCH'
  | 'AGENT_RUN_LEDGER_RUN_MISMATCH'
  | 'AGENT_RUN_LEDGER_EVENT_ID_REUSED'
  | 'AGENT_RUN_LEDGER_SCOPE_MISMATCH'
  | 'AGENT_RUN_LEDGER_CREATED_AT_MISMATCH'
  | 'AGENT_RUN_LEDGER_STARTED_AT_MISMATCH'
  | 'AGENT_RUN_LEDGER_UPDATED_AT_MISMATCH'
  | 'AGENT_RUN_LEDGER_INVALID_TRANSITION'
  | 'AGENT_RUN_LEDGER_TERMINAL_REWRITE';

export class AgentRunLedgerTransitionError extends Error {
  readonly code: AgentRunLedgerTransitionErrorCode;
  readonly from_status: AgentRunLedgerStatus | null;
  readonly to_status: AgentRunLedgerStatus;

  constructor(
    code: AgentRunLedgerTransitionErrorCode,
    message: string,
    fromStatus: AgentRunLedgerStatus | null,
    toStatus: AgentRunLedgerStatus
  ) {
    super(message);
    this.name = 'AgentRunLedgerTransitionError';
    this.code = code;
    this.from_status = fromStatus;
    this.to_status = toStatus;
  }
}

export type AgentRunLedgerReplayMismatchCode =
  | 'AGENT_RUN_LEDGER_IDEMPOTENCY_MISMATCH'
  | 'AGENT_RUN_LEDGER_SCOPE_MISMATCH'
  | 'AGENT_RUN_LEDGER_PAYLOAD_MISMATCH';

/** Carries typed mismatch context only, never the prior entry or its evidence. */
export class AgentRunLedgerReplayMismatchError extends Error {
  readonly code: AgentRunLedgerReplayMismatchCode;

  constructor(code: AgentRunLedgerReplayMismatchCode, message: string) {
    super(message);
    this.name = 'AgentRunLedgerReplayMismatchError';
    this.code = code;
  }
}

export interface AgentRunLedgerHashVerification {
  valid: boolean;
  scope_hash_matches: boolean;
  payload_hash_matches: boolean;
  expected_scope_hash: string;
  expected_payload_hash: string;
}

const ENTRY_FIELDS = new Set<keyof AgentRunLedgerEntry>([
  'schema_version', 'run_id', 'event_id', 'sequence', 'product_id', 'workflow_id', 'agent_id',
  'attempt_id', 'parent_run_id', 'trace_id', 'status', 'outcome', 'started_at', 'completed_at',
  'provider', 'model', 'input_summary', 'actions_taken', 'tools_used', 'latency_ms',
  'cost_estimate', 'approval_status', 'approval_actor', 'approval_timestamp', 'risk_level',
  'production_impact', 'validation_result', 'validation_summary', 'failure_reason', 'failure_code',
  'evidence_refs', 'evidence_count', 'evidence_integrity_status', 'payload_hash', 'scope_hash',
  'created_at', 'updated_at', 'source_subsystem',
]);

const ACTION_FIELDS = new Set<keyof AgentRunLedgerAction>(['action_id', 'action_type', 'summary', 'outcome']);
const TOOL_FIELDS = new Set<keyof AgentRunLedgerTool>(['tool_id', 'name', 'version']);
const EVIDENCE_FIELDS = new Set<keyof AgentRunLedgerEvidenceRef>([
  'evidence_id', 'kind', 'uri', 'sha256', 'captured_at',
]);
const COST_FIELDS = new Set<keyof AgentRunLedgerCostEstimate>(['kind', 'amount_micros', 'currency']);

const STATUSES: ReadonlySet<AgentRunLedgerStatus> = new Set([
  'created', 'approval_required', 'approved', 'running', 'validating', 'completed', 'failed',
  'cancelled', 'blocked', 'reconciliation_required',
]);
const OUTCOMES: ReadonlySet<AgentRunLedgerOutcome> = new Set([
  'pending', 'success', 'failure', 'cancelled', 'blocked', 'reconciliation_required',
]);
const APPROVAL_STATUSES: ReadonlySet<AgentRunLedgerApprovalStatus> = new Set([
  'not_required', 'required', 'approved', 'rejected',
]);
const VALIDATION_OUTCOMES: ReadonlySet<AgentRunLedgerValidationOutcome> = new Set([
  'not_run', 'passed', 'failed',
]);
const EVIDENCE_INTEGRITY_STATUSES: ReadonlySet<AgentRunLedgerEvidenceIntegrityStatus> = new Set([
  'not_present', 'unverified', 'verified', 'invalid',
]);
const ACTION_OUTCOMES: ReadonlySet<AgentRunLedgerActionOutcome> = new Set([
  'pending', 'succeeded', 'failed', 'blocked', 'not_applicable',
]);
const EVIDENCE_KINDS: ReadonlySet<AgentRunLedgerEvidenceKind> = new Set([
  'file', 'log', 'artifact', 'command_output', 'url', 'note',
]);
const RISK_LEVELS: ReadonlySet<RuntimeRiskLevel> = new Set(['low', 'medium', 'high', 'critical']);

const TERMINAL_STATUSES: ReadonlySet<AgentRunLedgerStatus> = new Set(['completed', 'failed', 'cancelled']);
const ALLOWED_TRANSITIONS: Readonly<Record<AgentRunLedgerStatus, readonly AgentRunLedgerStatus[]>> = {
  created: ['approval_required', 'approved', 'running', 'failed', 'cancelled', 'blocked'],
  approval_required: ['approved', 'failed', 'cancelled', 'blocked'],
  approved: ['running', 'failed', 'cancelled', 'blocked'],
  running: ['validating', 'failed', 'cancelled', 'blocked', 'reconciliation_required'],
  validating: ['completed', 'failed', 'cancelled', 'blocked', 'reconciliation_required'],
  completed: [],
  failed: [],
  cancelled: [],
  blocked: ['running', 'validating', 'failed', 'cancelled', 'reconciliation_required'],
  reconciliation_required: ['running', 'validating', 'completed', 'failed', 'cancelled', 'blocked'],
};

const UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const DANGEROUS_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SIGNED_QUERY_KEY_PATTERN = /(?:token|secret|password|credential|signature|sig|api[_-]?key|access[_-]?key|authorization|x-amz-)/i;
const AUTHORIZATION_HEADER_PATTERN = /\b((?:proxy-)?authorization["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi;
const COOKIE_HEADER_PATTERN = /\b((?:set-)?cookie["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi;
const CREDENTIAL_HEADER_PATTERN = /\b((?:x-)?(?:api-key|auth-token|access-token|refresh-token)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi;
const URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Compact recursive key-sort JSON used by both ledger hash domains. Array order is preserved. */
export function canonicalizeAgentRunLedgerJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeAgentRunLedgerJson(item)).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeAgentRunLedgerJson(item)}`)
    .join(',')}}`;
}

function sha256Domain(domain: string, value: JsonValue): string {
  return createHash('sha256')
    .update(`${domain}\n${canonicalizeAgentRunLedgerJson(value)}`, 'utf8')
    .digest('hex');
}

function credentialBearingUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return true;
    for (const key of parsed.searchParams.keys()) {
      if (SIGNED_QUERY_KEY_PATTERN.test(key)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Ledger-specific free-text redaction, including headers and signed URLs forbidden by the wire contract. */
export function redactAgentRunLedgerFreeText(value: string): string {
  let redacted = redactText(value);
  const redactHeader = (input: string, pattern: RegExp): string => input.replace(
    pattern,
    (match, prefix: string, headerValue: string) => (
      headerValue.startsWith('[REDACTED]') ? match : `${prefix}[REDACTED]`
    )
  );
  redacted = redactHeader(redacted, AUTHORIZATION_HEADER_PATTERN);
  redacted = redactHeader(redacted, COOKIE_HEADER_PATTERN);
  redacted = redactHeader(redacted, CREDENTIAL_HEADER_PATTERN);
  redacted = redacted.replace(URI_PATTERN, (url) => (
    credentialBearingUrl(url) ? '[REDACTED_CREDENTIAL_URL]' : url
  ));
  return redacted;
}

function scopeMaterial(entry: AgentRunLedgerEntry | AgentRunLedgerEntryDraft): JsonValue {
  return {
    schema_version: entry.schema_version,
    run_id: entry.run_id,
    product_id: entry.product_id,
    workflow_id: entry.workflow_id,
    agent_id: entry.agent_id,
    attempt_id: entry.attempt_id,
    parent_run_id: entry.parent_run_id,
    trace_id: entry.trace_id,
    provider: entry.provider,
    model: entry.model,
    production_impact: entry.production_impact,
    source_subsystem: entry.source_subsystem,
  };
}

function payloadMaterial(entry: AgentRunLedgerEntry | AgentRunLedgerEntryDraft): JsonValue {
  const { payload_hash: _payloadHash, scope_hash: _scopeHash, ...payload } = entry as AgentRunLedgerEntry;
  return payload as unknown as JsonValue;
}

export function createAgentRunLedgerScopeHash(
  entry: AgentRunLedgerEntry | AgentRunLedgerEntryDraft
): string {
  return sha256Domain(AGENT_RUN_LEDGER_SCOPE_HASH_DOMAIN, scopeMaterial(entry));
}

export function createAgentRunLedgerPayloadHash(
  entry: AgentRunLedgerEntry | AgentRunLedgerEntryDraft
): string {
  return sha256Domain(AGENT_RUN_LEDGER_PAYLOAD_HASH_DOMAIN, payloadMaterial(entry));
}

export function deriveAgentRunLedgerOutcome(status: AgentRunLedgerStatus): AgentRunLedgerOutcome {
  switch (status) {
    case 'completed': return 'success';
    case 'failed': return 'failure';
    case 'cancelled': return 'cancelled';
    case 'blocked': return 'blocked';
    case 'reconciliation_required': return 'reconciliation_required';
    case 'created':
    case 'approval_required':
    case 'approved':
    case 'running':
    case 'validating':
      return 'pending';
  }
}

function redactNullableText(value: string | null): string | null {
  return value === null ? null : redactAgentRunLedgerFreeText(value);
}

function normalizeDraft(entry: AgentRunLedgerEntryDraft): AgentRunLedgerEntryDraft {
  return {
    ...structuredClone(entry),
    input_summary: redactAgentRunLedgerFreeText(entry.input_summary),
    actions_taken: entry.actions_taken.map((action) => ({
      ...action,
      summary: redactAgentRunLedgerFreeText(action.summary),
    })),
    validation_summary: redactNullableText(entry.validation_summary),
    failure_reason: redactNullableText(entry.failure_reason),
  };
}

/** Redacts bounded free-text fields but preserves every opaque identity/reference and supplied hash exactly. */
export function normalizeAgentRunLedgerEntry(entry: AgentRunLedgerEntry): AgentRunLedgerEntry {
  const normalized = normalizeDraft(entry);
  return {
    ...normalized,
    payload_hash: entry.payload_hash,
    scope_hash: entry.scope_hash,
  };
}

/** Producer helper: redact free text first, then calculate both authoritative hashes and validate the result. */
export function createAgentRunLedgerEntry(input: AgentRunLedgerEntryDraft): AgentRunLedgerEntry {
  const normalized = normalizeDraft(input);
  const entry: AgentRunLedgerEntry = {
    ...normalized,
    payload_hash: createAgentRunLedgerPayloadHash(normalized),
    scope_hash: createAgentRunLedgerScopeHash(normalized),
  };
  return validateAgentRunLedgerEntry(entry);
}

function addIssue(
  issues: AgentRunLedgerValidationIssue[],
  code: AgentRunLedgerValidationIssueCode,
  field: string,
  message: string
): void {
  issues.push({ code, field, message });
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
  issues: AgentRunLedgerValidationIssue[]
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) addIssue(issues, 'UNKNOWN_FIELD', `${field}.${key}`, `Unknown field "${key}".`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) addIssue(issues, 'MISSING_FIELD', `${field}.${key}`, `Missing field "${key}".`);
  }
}

function requireString(
  value: unknown,
  field: string,
  max: number,
  issues: AgentRunLedgerValidationIssue[],
  allowEmpty = false
): value is string {
  if (typeof value !== 'string') {
    addIssue(issues, 'INVALID_TYPE', field, `${field} must be a string.`);
    return false;
  }
  if ((!allowEmpty && (value.length === 0 || !/\S/.test(value))) || CONTROL_CHARACTER_PATTERN.test(value)) {
    addIssue(issues, 'INVALID_OPAQUE_ID', field, `${field} must be nonempty and contain no control characters.`);
  }
  if (value.length > max) addIssue(issues, 'FIELD_TOO_LARGE', field, `${field} exceeds ${max} characters.`);
  return true;
}

function requireOpaque(
  value: unknown,
  field: string,
  max: number,
  issues: AgentRunLedgerValidationIssue[]
): value is string {
  if (!requireString(value, field, max, issues)) return false;
  if (redactAgentRunLedgerFreeText(value) !== value) {
    addIssue(issues, 'SECRET_IN_OPAQUE_FIELD', field, `${field} contains secret-like material and cannot be persisted.`);
  }
  return true;
}

function requireNullableOpaque(
  value: unknown,
  field: string,
  max: number,
  issues: AgentRunLedgerValidationIssue[]
): value is string | null {
  if (value === null) return true;
  return requireOpaque(value, field, max, issues);
}

function requireSafeFreeText(
  value: unknown,
  field: string,
  issues: AgentRunLedgerValidationIssue[]
): value is string {
  if (typeof value !== 'string') {
    addIssue(issues, 'INVALID_TYPE', field, `${field} must be a string.`);
    return false;
  }
  if (!/\S/.test(value) || DANGEROUS_CONTROL_CHARACTER_PATTERN.test(value)) {
    addIssue(issues, 'INVALID_TEXT', field, `${field} must be nonblank and contain no unsafe control characters.`);
  }
  if (value.length > AGENT_RUN_LEDGER_LIMITS.free_text) {
    addIssue(issues, 'FIELD_TOO_LARGE', field, `${field} exceeds ${AGENT_RUN_LEDGER_LIMITS.free_text} characters.`);
  }
  if (redactAgentRunLedgerFreeText(value) !== value) {
    addIssue(issues, 'FREE_TEXT_REQUIRES_REDACTION', field, `${field} must be redacted before hashing or persistence.`);
  }
  return true;
}

function requireNullableSafeFreeText(
  value: unknown,
  field: string,
  issues: AgentRunLedgerValidationIssue[]
): value is string | null {
  if (value === null) return true;
  return requireSafeFreeText(value, field, issues);
}

function requireInteger(
  value: unknown,
  field: string,
  issues: AgentRunLedgerValidationIssue[],
  minimum = 0
): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    addIssue(issues, 'INVALID_INTEGER', field, `${field} must be a safe integer >= ${minimum}.`);
    return false;
  }
  return true;
}

function requireTimestamp(value: unknown, field: string, issues: AgentRunLedgerValidationIssue[]): value is string {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (
    typeof value !== 'string'
    || !UTC_MILLIS_PATTERN.test(value)
    || Number.isNaN(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    addIssue(issues, 'INVALID_TIMESTAMP', field, `${field} must use canonical UTC milliseconds (YYYY-MM-DDTHH:mm:ss.sssZ).`);
    return false;
  }
  return true;
}

function requireNullableTimestamp(
  value: unknown,
  field: string,
  issues: AgentRunLedgerValidationIssue[]
): value is string | null {
  if (value === null) return true;
  return requireTimestamp(value, field, issues);
}

function validateCost(value: unknown, issues: AgentRunLedgerValidationIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, 'INVALID_TYPE', 'cost_estimate', 'cost_estimate must be an object.');
    return;
  }
  rejectUnknownFields(value, COST_FIELDS, 'cost_estimate', issues);
  if (value.kind !== 'known' && value.kind !== 'unknown' && value.kind !== 'not_applicable') {
    addIssue(issues, 'INVALID_ENUM', 'cost_estimate.kind', 'Unsupported cost kind.');
    return;
  }
  if (value.kind === 'known') {
    const amountOk = requireInteger(value.amount_micros, 'cost_estimate.amount_micros', issues);
    const currencyOk = requireString(value.currency, 'cost_estimate.currency', 3, issues);
    if (
      !amountOk
      || !currencyOk
      || typeof value.currency !== 'string'
      || !CURRENCY_PATTERN.test(value.currency)
    ) {
      addIssue(issues, 'COST_SHAPE_MISMATCH', 'cost_estimate', 'Known cost requires nonnegative integer micros and a three-letter uppercase currency.');
    }
  } else if (value.amount_micros !== null || value.currency !== null) {
    addIssue(issues, 'COST_SHAPE_MISMATCH', 'cost_estimate', 'Unknown/not_applicable cost must use null amount_micros and currency.');
  }
}

function validateActions(value: unknown, issues: AgentRunLedgerValidationIssue[]): void {
  if (!Array.isArray(value)) {
    addIssue(issues, 'INVALID_TYPE', 'actions_taken', 'actions_taken must be an array.');
    return;
  }
  if (value.length > AGENT_RUN_LEDGER_LIMITS.action_or_tool_count) {
    addIssue(issues, 'ARRAY_TOO_LARGE', 'actions_taken', 'actions_taken exceeds the bounded item count.');
    return;
  }
  value.forEach((item, index) => {
    const field = `actions_taken[${index}]`;
    if (!isRecord(item)) {
      addIssue(issues, 'INVALID_TYPE', field, `${field} must be an object.`);
      return;
    }
    rejectUnknownFields(item, ACTION_FIELDS, field, issues);
    requireOpaque(item.action_id, `${field}.action_id`, AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
    requireOpaque(item.action_type, `${field}.action_type`, AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
    requireSafeFreeText(item.summary, `${field}.summary`, issues);
    if (typeof item.outcome !== 'string' || !ACTION_OUTCOMES.has(item.outcome as AgentRunLedgerActionOutcome)) {
      addIssue(issues, 'INVALID_ENUM', `${field}.outcome`, 'Unsupported action outcome.');
    }
  });
}

function validateTools(value: unknown, issues: AgentRunLedgerValidationIssue[]): void {
  if (!Array.isArray(value)) {
    addIssue(issues, 'INVALID_TYPE', 'tools_used', 'tools_used must be an array.');
    return;
  }
  if (value.length > AGENT_RUN_LEDGER_LIMITS.action_or_tool_count) {
    addIssue(issues, 'ARRAY_TOO_LARGE', 'tools_used', 'tools_used exceeds the bounded item count.');
    return;
  }
  value.forEach((item, index) => {
    const field = `tools_used[${index}]`;
    if (!isRecord(item)) {
      addIssue(issues, 'INVALID_TYPE', field, `${field} must be an object.`);
      return;
    }
    rejectUnknownFields(item, TOOL_FIELDS, field, issues);
    requireOpaque(item.tool_id, `${field}.tool_id`, AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
    requireOpaque(item.name, `${field}.name`, AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
    requireNullableOpaque(item.version, `${field}.version`, AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  });
}

function hasSignedCredentialUrl(uri: string): boolean {
  if (!/^https?:\/\//i.test(uri)) return false;
  return credentialBearingUrl(uri);
}

function validateEvidence(value: unknown, issues: AgentRunLedgerValidationIssue[]): void {
  if (!Array.isArray(value)) {
    addIssue(issues, 'INVALID_TYPE', 'evidence_refs', 'evidence_refs must be an array.');
    return;
  }
  if (value.length > AGENT_RUN_LEDGER_LIMITS.evidence_count) {
    addIssue(issues, 'ARRAY_TOO_LARGE', 'evidence_refs', 'evidence_refs exceeds the bounded item count.');
    return;
  }
  value.forEach((item, index) => {
    const field = `evidence_refs[${index}]`;
    if (!isRecord(item)) {
      addIssue(issues, 'INVALID_TYPE', field, `${field} must be an object.`);
      return;
    }
    rejectUnknownFields(item, EVIDENCE_FIELDS, field, issues);
    requireOpaque(item.evidence_id, `${field}.evidence_id`, AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
    if (typeof item.kind !== 'string' || !EVIDENCE_KINDS.has(item.kind as AgentRunLedgerEvidenceKind)) {
      addIssue(issues, 'INVALID_ENUM', `${field}.kind`, 'Unsupported evidence kind.');
    }
    if (requireOpaque(item.uri, `${field}.uri`, AGENT_RUN_LEDGER_LIMITS.uri, issues) && hasSignedCredentialUrl(item.uri)) {
      addIssue(issues, 'SIGNED_CREDENTIAL_URL', `${field}.uri`, 'Signed or credential-bearing URLs cannot be persisted.');
    }
    if (item.sha256 !== null && (typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256))) {
      addIssue(issues, 'INVALID_HASH', `${field}.sha256`, 'Evidence sha256 must be lowercase hexadecimal or null.');
    }
    requireTimestamp(item.captured_at, `${field}.captured_at`, issues);
  });
}

function validateEnums(record: Record<string, unknown>, issues: AgentRunLedgerValidationIssue[]): void {
  if (record.status !== undefined && (typeof record.status !== 'string' || !STATUSES.has(record.status as AgentRunLedgerStatus))) {
    addIssue(issues, 'INVALID_ENUM', 'status', 'Unsupported ledger status.');
  }
  if (record.outcome !== undefined && (typeof record.outcome !== 'string' || !OUTCOMES.has(record.outcome as AgentRunLedgerOutcome))) {
    addIssue(issues, 'INVALID_ENUM', 'outcome', 'Unsupported ledger outcome.');
  }
  if (record.approval_status !== undefined && (typeof record.approval_status !== 'string' || !APPROVAL_STATUSES.has(record.approval_status as AgentRunLedgerApprovalStatus))) {
    addIssue(issues, 'INVALID_ENUM', 'approval_status', 'Unsupported approval status.');
  }
  if (record.validation_result !== undefined && (typeof record.validation_result !== 'string' || !VALIDATION_OUTCOMES.has(record.validation_result as AgentRunLedgerValidationOutcome))) {
    addIssue(issues, 'INVALID_ENUM', 'validation_result', 'Unsupported validation result.');
  }
  if (record.evidence_integrity_status !== undefined && (typeof record.evidence_integrity_status !== 'string' || !EVIDENCE_INTEGRITY_STATUSES.has(record.evidence_integrity_status as AgentRunLedgerEvidenceIntegrityStatus))) {
    addIssue(issues, 'INVALID_ENUM', 'evidence_integrity_status', 'Unsupported evidence integrity status.');
  }
  if (record.risk_level !== undefined && (typeof record.risk_level !== 'string' || !RISK_LEVELS.has(record.risk_level as RuntimeRiskLevel))) {
    addIssue(issues, 'INVALID_ENUM', 'risk_level', 'Unsupported risk level.');
  }
}

function validateSemanticRules(entry: AgentRunLedgerEntry, issues: AgentRunLedgerValidationIssue[]): void {
  if (entry.outcome !== deriveAgentRunLedgerOutcome(entry.status)) {
    addIssue(issues, 'OUTCOME_STATUS_MISMATCH', 'outcome', 'outcome must be the canonical value derived from status.');
  }

  const terminal = TERMINAL_STATUSES.has(entry.status);
  if (terminal !== (entry.completed_at !== null) || terminal !== (entry.latency_ms !== null)) {
    addIssue(issues, 'TIMESTAMP_ORDER_MISMATCH', 'completed_at', 'Terminal entries require completed_at and latency_ms; nonterminal entries require null.');
  }
  const started = Date.parse(entry.started_at);
  const created = Date.parse(entry.created_at);
  const updated = Date.parse(entry.updated_at);
  if (created > started || created > updated || started > updated) {
    addIssue(issues, 'TIMESTAMP_ORDER_MISMATCH', 'updated_at', 'Timestamps must satisfy created_at <= started_at <= updated_at.');
  }
  if (entry.completed_at !== null) {
    const completed = Date.parse(entry.completed_at);
    if (completed < started || completed > updated) {
      addIssue(issues, 'TIMESTAMP_ORDER_MISMATCH', 'completed_at', 'completed_at must be between started_at and updated_at.');
    }
    if (entry.latency_ms !== completed - started) {
      addIssue(issues, 'LATENCY_MISMATCH', 'latency_ms', 'latency_ms must equal completed_at minus started_at exactly.');
    }
  }
  if (entry.approval_timestamp !== null) {
    const approvalTimestamp = Date.parse(entry.approval_timestamp);
    if (approvalTimestamp < created || approvalTimestamp > updated) {
      addIssue(issues, 'TIMESTAMP_ORDER_MISMATCH', 'approval_timestamp', 'approval_timestamp must be between created_at and updated_at.');
    }
  }
  for (const [index, evidence] of entry.evidence_refs.entries()) {
    const capturedAt = Date.parse(evidence.captured_at);
    if (capturedAt < started || capturedAt > updated) {
      addIssue(issues, 'TIMESTAMP_ORDER_MISMATCH', `evidence_refs[${index}].captured_at`, 'Evidence capture must be between started_at and updated_at.');
    }
  }

  const decisionRecorded = entry.approval_status === 'approved' || entry.approval_status === 'rejected';
  const approvalMetadataComplete = entry.approval_actor !== null && entry.approval_timestamp !== null;
  const approvalMetadataAbsent = entry.approval_actor === null && entry.approval_timestamp === null;
  if ((decisionRecorded && !approvalMetadataComplete) || (!decisionRecorded && !approvalMetadataAbsent)) {
    addIssue(issues, 'APPROVAL_METADATA_MISMATCH', 'approval_status', 'Approved/rejected decisions require actor and timestamp; other statuses require null metadata.');
  }
  if (decisionRecorded && (entry.approval_actor === 'unknown' || entry.approval_actor === 'not_applicable')) {
    addIssue(issues, 'APPROVAL_METADATA_MISMATCH', 'approval_actor', 'A recorded approval decision requires an identified actor.');
  }
  if (entry.status === 'approval_required' && entry.approval_status !== 'required') {
    addIssue(issues, 'APPROVAL_METADATA_MISMATCH', 'approval_status', 'approval_required status requires approval_status=required.');
  }
  if (entry.status === 'approved' && entry.approval_status !== 'approved') {
    addIssue(issues, 'APPROVAL_METADATA_MISMATCH', 'approval_status', 'approved status requires approval_status=approved.');
  }
  if (
    ['running', 'validating', 'completed', 'reconciliation_required'].includes(entry.status)
    && entry.approval_status !== 'not_required'
    && entry.approval_status !== 'approved'
  ) {
    addIssue(issues, 'APPROVAL_METADATA_MISMATCH', 'approval_status', 'Execution states require approval_status=not_required or approved.');
  }
  if (
    entry.production_impact
    && ['running', 'validating', 'completed', 'reconciliation_required'].includes(entry.status)
    && entry.approval_status !== 'approved'
  ) {
    addIssue(issues, 'PRODUCTION_APPROVAL_REQUIRED', 'approval_status', 'Production-impact execution/completion requires recorded approval metadata.');
  }

  if (entry.validation_result === 'not_run' && entry.validation_summary !== null) {
    addIssue(issues, 'VALIDATION_METADATA_MISMATCH', 'validation_summary', 'not_run validation requires a null summary.');
  }
  if (entry.validation_result !== 'not_run' && entry.validation_summary === null) {
    addIssue(issues, 'VALIDATION_METADATA_MISMATCH', 'validation_summary', 'Passed/failed validation requires a summary.');
  }
  if (
    ['created', 'approval_required', 'approved', 'running'].includes(entry.status)
    && entry.validation_result !== 'not_run'
  ) {
    addIssue(issues, 'VALIDATION_METADATA_MISMATCH', 'validation_result', 'Validation cannot be reported before the validating state.');
  }

  if (entry.status === 'failed') {
    if (entry.failure_code === null || entry.failure_reason === null) {
      addIssue(issues, 'FAILURE_METADATA_MISMATCH', 'failure_code', 'Failed entries require typed failure_code and failure_reason.');
    }
  } else if (entry.failure_code !== null || entry.failure_reason !== null) {
    addIssue(issues, 'FAILURE_METADATA_MISMATCH', 'failure_code', 'Only failed entries may carry failure metadata.');
  }

  if (entry.evidence_count !== entry.evidence_refs.length) {
    addIssue(issues, 'EVIDENCE_COUNT_MISMATCH', 'evidence_count', 'evidence_count must equal evidence_refs.length.');
  }
  if (entry.evidence_refs.length === 0 && entry.evidence_integrity_status !== 'not_present') {
    addIssue(issues, 'EVIDENCE_INTEGRITY_MISMATCH', 'evidence_integrity_status', 'Empty evidence requires not_present integrity status.');
  }
  if (entry.evidence_refs.length > 0 && entry.evidence_integrity_status === 'not_present') {
    addIssue(issues, 'EVIDENCE_INTEGRITY_MISMATCH', 'evidence_integrity_status', 'Nonempty evidence cannot be marked not_present.');
  }
  if (
    entry.evidence_integrity_status === 'verified'
    && entry.evidence_refs.some((evidence) => evidence.sha256 === null)
  ) {
    addIssue(issues, 'EVIDENCE_INTEGRITY_MISMATCH', 'evidence_refs', 'Verified evidence requires a sha256 on every reference.');
  }
  if (entry.status === 'completed') {
    if (entry.validation_result !== 'passed') {
      addIssue(issues, 'COMPLETED_REQUIRES_VALIDATION', 'validation_result', 'Completed entries require passed validation.');
    }
    if (entry.evidence_refs.length === 0 || entry.evidence_integrity_status !== 'verified') {
      addIssue(issues, 'COMPLETED_REQUIRES_EVIDENCE', 'evidence_refs', 'Completed entries require nonempty verified evidence.');
    }
  }
}

/** Validate a complete, pre-hashed entry. Returns the same authoritative value or throws typed issues. */
export function validateAgentRunLedgerEntry(value: unknown): AgentRunLedgerEntry {
  const issues: AgentRunLedgerValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new AgentRunLedgerValidationError([{
      code: 'INVALID_TYPE', field: '$', message: 'AgentRunLedgerEntry must be an object.',
    }]);
  }
  rejectUnknownFields(value, ENTRY_FIELDS, '$', issues);

  if (value.schema_version !== AGENT_RUN_LEDGER_SCHEMA_VERSION) {
    addIssue(issues, 'UNSUPPORTED_SCHEMA_VERSION', 'schema_version', 'Only schema_version "1.0" is supported.');
  }
  requireOpaque(value.run_id, 'run_id', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  requireOpaque(value.event_id, 'event_id', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  requireInteger(value.sequence, 'sequence', issues, 1);
  requireOpaque(value.product_id, 'product_id', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  requireOpaque(value.workflow_id, 'workflow_id', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  requireOpaque(value.agent_id, 'agent_id', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  requireOpaque(value.attempt_id, 'attempt_id', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  requireNullableOpaque(value.parent_run_id, 'parent_run_id', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  requireNullableOpaque(value.trace_id, 'trace_id', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  validateEnums(value, issues);
  requireTimestamp(value.started_at, 'started_at', issues);
  requireNullableTimestamp(value.completed_at, 'completed_at', issues);
  requireOpaque(value.provider, 'provider', AGENT_RUN_LEDGER_LIMITS.provider_or_model, issues);
  requireOpaque(value.model, 'model', AGENT_RUN_LEDGER_LIMITS.provider_or_model, issues);
  requireSafeFreeText(value.input_summary, 'input_summary', issues);
  validateActions(value.actions_taken, issues);
  validateTools(value.tools_used, issues);
  if (value.latency_ms !== null) requireInteger(value.latency_ms, 'latency_ms', issues);
  validateCost(value.cost_estimate, issues);
  requireNullableOpaque(value.approval_actor, 'approval_actor', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  requireNullableTimestamp(value.approval_timestamp, 'approval_timestamp', issues);
  if (typeof value.production_impact !== 'boolean') {
    addIssue(issues, 'INVALID_TYPE', 'production_impact', 'production_impact must be boolean.');
  }
  requireNullableSafeFreeText(value.validation_summary, 'validation_summary', issues);
  requireNullableSafeFreeText(value.failure_reason, 'failure_reason', issues);
  requireNullableOpaque(value.failure_code, 'failure_code', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);
  validateEvidence(value.evidence_refs, issues);
  requireInteger(value.evidence_count, 'evidence_count', issues);
  if (typeof value.payload_hash !== 'string' || !SHA256_PATTERN.test(value.payload_hash)) {
    addIssue(issues, 'INVALID_HASH', 'payload_hash', 'payload_hash must be lowercase SHA-256 hex.');
  }
  if (typeof value.scope_hash !== 'string' || !SHA256_PATTERN.test(value.scope_hash)) {
    addIssue(issues, 'INVALID_HASH', 'scope_hash', 'scope_hash must be lowercase SHA-256 hex.');
  }
  requireTimestamp(value.created_at, 'created_at', issues);
  requireTimestamp(value.updated_at, 'updated_at', issues);
  requireOpaque(value.source_subsystem, 'source_subsystem', AGENT_RUN_LEDGER_LIMITS.opaque_id, issues);

  if (issues.length === 0) {
    const entry = value as unknown as AgentRunLedgerEntry;
    const canonicalBytes = Buffer.byteLength(canonicalizeAgentRunLedgerJson(entry as unknown as JsonValue), 'utf8');
    if (canonicalBytes > AGENT_RUN_LEDGER_LIMITS.canonical_bytes) {
      addIssue(issues, 'ENTRY_TOO_LARGE', '$', `Canonical entry exceeds ${AGENT_RUN_LEDGER_LIMITS.canonical_bytes} bytes.`);
    }
    validateSemanticRules(entry, issues);
    const verification = verifyAgentRunLedgerHashes(entry);
    if (!verification.scope_hash_matches) {
      addIssue(issues, 'SCOPE_HASH_MISMATCH', 'scope_hash', 'scope_hash does not match the canonical exact scope.');
    }
    if (!verification.payload_hash_matches) {
      addIssue(issues, 'PAYLOAD_HASH_MISMATCH', 'payload_hash', 'payload_hash does not match the canonical redacted payload.');
    }
  }

  if (issues.length > 0) throw new AgentRunLedgerValidationError(issues);
  return value as unknown as AgentRunLedgerEntry;
}

export function verifyAgentRunLedgerHashes(entry: AgentRunLedgerEntry): AgentRunLedgerHashVerification {
  const expectedScopeHash = createAgentRunLedgerScopeHash(entry);
  const expectedPayloadHash = createAgentRunLedgerPayloadHash(entry);
  const scopeMatches = entry.scope_hash === expectedScopeHash;
  const payloadMatches = entry.payload_hash === expectedPayloadHash;
  return {
    valid: scopeMatches && payloadMatches,
    scope_hash_matches: scopeMatches,
    payload_hash_matches: payloadMatches,
    expected_scope_hash: expectedScopeHash,
    expected_payload_hash: expectedPayloadHash,
  };
}

/**
 * Assert a new ordered transition. Exact replays must be handled first with
 * assertAgentRunLedgerExactReplay and therefore never append a second event.
 */
export function assertAgentRunLedgerTransition(
  previous: AgentRunLedgerEntry | null,
  next: AgentRunLedgerEntry
): void {
  validateAgentRunLedgerEntry(next);
  if (previous === null) {
    if (next.sequence !== 1 || next.status !== 'created') {
      throw new AgentRunLedgerTransitionError(
        'AGENT_RUN_LEDGER_INITIAL_STATUS_MISMATCH',
        'The first ledger transition must be sequence 1 with status created.',
        null,
        next.status
      );
    }
    return;
  }
  validateAgentRunLedgerEntry(previous);
  if (previous.run_id !== next.run_id) {
    throw new AgentRunLedgerTransitionError('AGENT_RUN_LEDGER_RUN_MISMATCH', 'A transition cannot change run_id.', previous.status, next.status);
  }
  if (next.sequence !== previous.sequence + 1) {
    throw new AgentRunLedgerTransitionError('AGENT_RUN_LEDGER_SEQUENCE_MISMATCH', 'sequence must increment by exactly one.', previous.status, next.status);
  }
  if (previous.event_id === next.event_id) {
    throw new AgentRunLedgerTransitionError('AGENT_RUN_LEDGER_EVENT_ID_REUSED', 'A new transition requires a new event_id.', previous.status, next.status);
  }
  if (previous.scope_hash !== next.scope_hash) {
    throw new AgentRunLedgerTransitionError('AGENT_RUN_LEDGER_SCOPE_MISMATCH', 'A transition cannot change the exact execution scope.', previous.status, next.status);
  }
  if (previous.created_at !== next.created_at) {
    throw new AgentRunLedgerTransitionError('AGENT_RUN_LEDGER_CREATED_AT_MISMATCH', 'A transition cannot change created_at.', previous.status, next.status);
  }
  if (previous.started_at !== next.started_at) {
    throw new AgentRunLedgerTransitionError('AGENT_RUN_LEDGER_STARTED_AT_MISMATCH', 'A transition cannot change started_at.', previous.status, next.status);
  }
  if (Date.parse(next.updated_at) < Date.parse(previous.updated_at)) {
    throw new AgentRunLedgerTransitionError('AGENT_RUN_LEDGER_UPDATED_AT_MISMATCH', 'updated_at must be nondecreasing.', previous.status, next.status);
  }
  if (TERMINAL_STATUSES.has(previous.status)) {
    throw new AgentRunLedgerTransitionError('AGENT_RUN_LEDGER_TERMINAL_REWRITE', `Status ${previous.status} is terminal.`, previous.status, next.status);
  }
  if (!ALLOWED_TRANSITIONS[previous.status].includes(next.status)) {
    throw new AgentRunLedgerTransitionError(
      'AGENT_RUN_LEDGER_INVALID_TRANSITION',
      `Invalid Agent Run Ledger transition ${previous.status} -> ${next.status}.`,
      previous.status,
      next.status
    );
  }
}

/**
 * Prove an incoming write is the exact already-authoritative event. Any
 * mismatch throws before callers are permitted to return the prior record.
 */
export function assertAgentRunLedgerExactReplay(
  existing: AgentRunLedgerEntry,
  candidate: AgentRunLedgerEntry
): void {
  validateAgentRunLedgerEntry(candidate);
  if (
    existing.run_id !== candidate.run_id
    || existing.event_id !== candidate.event_id
    || existing.sequence !== candidate.sequence
    || existing.status !== candidate.status
  ) {
    throw new AgentRunLedgerReplayMismatchError(
      'AGENT_RUN_LEDGER_IDEMPOTENCY_MISMATCH',
      'The ledger write identity does not match its authoritative binding.'
    );
  }
  if (existing.scope_hash !== candidate.scope_hash) {
    throw new AgentRunLedgerReplayMismatchError(
      'AGENT_RUN_LEDGER_SCOPE_MISMATCH',
      'The ledger write scope does not match its authoritative binding.'
    );
  }
  if (existing.payload_hash !== candidate.payload_hash) {
    throw new AgentRunLedgerReplayMismatchError(
      'AGENT_RUN_LEDGER_PAYLOAD_MISMATCH',
      'The ledger write payload does not match its authoritative binding.'
    );
  }
}
