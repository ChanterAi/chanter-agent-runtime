/**
 * CHANTER OS Temporal Authority v1.
 *
 * Runtime owns only the provider-agnostic vocabulary, validation, clock
 * semantics, deterministic hashing, and pure evaluation in this module.
 * Durable authority, claims, leases, attempts, evidence, and provider behavior
 * remain owned by the calling product.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  AGENT_RUN_LEDGER_LIMITS,
  canonicalizeAgentRunLedgerJson,
  redactAgentRunLedgerFreeText,
} from './agentRunLedger.js';
import type { JsonValue } from './types.js';

export const TEMPORAL_AUTHORITY_SCHEMA_VERSION = 'chanter.temporal.v1' as const;
export const TEMPORAL_POLICY_HASH_DOMAIN = 'chanter-temporal-policy-binding-v1' as const;

export const TEMPORAL_AUTHORITY_LIMITS = Object.freeze({
  opaqueIdentifier: AGENT_RUN_LEDGER_LIMITS.opaque_id,
});

const UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const POLICY_FIELDS = new Set([
  'schemaVersion',
  'submittedAt',
  'notBefore',
  'deadlineAt',
  'executionTimeoutMs',
  'maxAttempts',
  'leaseDurationMs',
]);
const POLICY_REQUIRED_FIELDS = new Set(['schemaVersion', 'submittedAt', 'maxAttempts']);
const AUTHORIZATION_FIELDS = new Set([
  'authorizationId',
  'authorizationVersion',
  'approvedAt',
  'approvalExpiresAt',
  'approvedPolicyHash',
]);
const STATE_FIELDS = new Set([
  'attemptCount',
  'nextAttemptAt',
  'leaseOwner',
  'leaseToken',
  'leaseExpiresAt',
  'terminalAt',
  'terminalReason',
]);
const COMPLETION_CONTEXT_FIELDS = new Set(['leaseOwner', 'leaseToken', 'attemptNumber']);

export interface TemporalMissionPolicyV1 {
  readonly schemaVersion: typeof TEMPORAL_AUTHORITY_SCHEMA_VERSION;
  readonly submittedAt: string;
  readonly notBefore?: string;
  readonly deadlineAt?: string;
  readonly executionTimeoutMs?: number;
  /** Absolute authorization-bound ceiling. This is never a decrementable allowance. */
  readonly maxAttempts: number;
  readonly leaseDurationMs?: number;
}

export interface TemporalAuthorizationV1 {
  readonly authorizationId: string;
  /** Authorization revision, not a schema discriminator. */
  readonly authorizationVersion: number;
  readonly approvedAt: string;
  readonly approvalExpiresAt: string;
  /** Domain-separated binding of the existing mission payload hash and temporal policy. */
  readonly approvedPolicyHash: string;
}

export type TemporalTerminalReasonV1 =
  | 'deadline_exceeded'
  | 'attempt_budget_exhausted'
  | 'terminal_success'
  | 'terminal_failure';

export interface DurableTemporalStateV1 {
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly terminalAt: string | null;
  readonly terminalReason: TemporalTerminalReasonV1 | null;
}

export type TemporalReasonCodeV1 =
  | 'not_before_pending'
  | 'approval_required'
  | 'approval_expired'
  | 'deadline_exceeded'
  | 'attempt_budget_exhausted'
  | 'lease_live'
  | 'lease_lost'
  | 'execution_timeout_before_mutation'
  | 'provider_outcome_unknown'
  | 'terminal_success'
  | 'terminal_failure';

export type TemporalAuthorityValidationIssueCode =
  | 'INVALID_TYPE'
  | 'UNKNOWN_FIELD'
  | 'MISSING_FIELD'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_INTEGER'
  | 'INVALID_IDENTIFIER'
  | 'FIELD_TOO_LARGE'
  | 'SECRET_IN_IDENTIFIER'
  | 'INVALID_HASH'
  | 'INVALID_ORDER'
  | 'ATTEMPT_BUDGET_EXCEEDED'
  | 'LEASE_TUPLE_MISMATCH'
  | 'TERMINAL_TUPLE_MISMATCH'
  | 'INVALID_TERMINAL_REASON'
  | 'INVALID_STATE_REVISION'
  | 'INVALID_COMPLETION_CONTEXT';

export interface TemporalAuthorityValidationIssue {
  readonly code: TemporalAuthorityValidationIssueCode;
  readonly field: string;
  readonly message: string;
}

export class TemporalAuthorityValidationError extends Error {
  readonly issues: readonly TemporalAuthorityValidationIssue[];

  constructor(issues: readonly TemporalAuthorityValidationIssue[]) {
    super(issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '));
    this.name = 'TemporalAuthorityValidationError';
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

export type TemporalStateRevisionV1 = string | number;

export interface TemporalCompletionContextV1 {
  readonly leaseOwner: string;
  readonly leaseToken: string;
  /** One-based attempt that acquired the lease. */
  readonly attemptNumber: number;
}

interface TemporalEvaluationInputBaseV1 {
  readonly policy: TemporalMissionPolicyV1;
  readonly authorizationRequired: boolean;
  readonly authorization?: TemporalAuthorizationV1;
  /** Existing mission identity hash; Temporal Authority never changes its calculation. */
  readonly missionPayloadHash?: string;
  readonly state: DurableTemporalStateV1;
  readonly stateRevision: TemporalStateRevisionV1;
  readonly evaluatedAt: string;
}

export interface TemporalClaimEvaluationInputV1 extends TemporalEvaluationInputBaseV1 {
  readonly operation: 'claim';
}

export interface TemporalCompletionEvaluationInputV1 extends TemporalEvaluationInputBaseV1 {
  readonly operation: 'completion';
  readonly completion: TemporalCompletionContextV1;
}

export type TemporalEligibilityEvaluationInputV1 =
  | TemporalClaimEvaluationInputV1
  | TemporalCompletionEvaluationInputV1;

interface TemporalEligibilityResultContextV1 {
  readonly operation: 'claim' | 'completion';
  readonly evaluatedAt: string;
  readonly stateRevision: TemporalStateRevisionV1;
  readonly authorizationId: string | null;
  readonly authorizationVersion: number | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
}

export interface TemporalEligibleResultV1 extends TemporalEligibilityResultContextV1 {
  readonly eligible: true;
  readonly reason: null;
}

export interface TemporalIneligibleResultV1 extends TemporalEligibilityResultContextV1 {
  readonly eligible: false;
  readonly reason: TemporalReasonCodeV1;
}

export type TemporalEligibilityResultV1 = TemporalEligibleResultV1 | TemporalIneligibleResultV1;

export interface TemporalClock {
  /** Wall-clock observation for durable instants; callers choose the durable authority. */
  nowInstant(): Date;
  /** Process-local elapsed measurement only. Raw values must never be persisted or hashed. */
  monotonicNowMs(): number;
}

export class SystemTemporalClock implements TemporalClock {
  nowInstant(): Date {
    return new Date();
  }

  monotonicNowMs(): number {
    return performance.now();
  }
}

export class FakeTemporalClock implements TemporalClock {
  #wallTimeMs: number;
  #monotonicTimeMs: number;

  constructor(initialInstant: string | Date, initialMonotonicMs = 0) {
    this.#wallTimeMs = wallTimeMilliseconds(initialInstant);
    assertFiniteNonnegativeNumber(initialMonotonicMs, 'initialMonotonicMs');
    this.#monotonicTimeMs = initialMonotonicMs;
  }

  nowInstant(): Date {
    return new Date(this.#wallTimeMs);
  }

  monotonicNowMs(): number {
    return this.#monotonicTimeMs;
  }

  setWallInstant(instant: string | Date): void {
    this.#wallTimeMs = wallTimeMilliseconds(instant);
  }

  advanceWallTimeMs(deltaMs: number): void {
    if (!Number.isFinite(deltaMs)) throw new RangeError('deltaMs must be finite.');
    const next = this.#wallTimeMs + deltaMs;
    if (!Number.isFinite(next) || Number.isNaN(new Date(next).getTime())) {
      throw new RangeError('The resulting wall-clock instant is invalid.');
    }
    this.#wallTimeMs = next;
  }

  advanceMonotonicMs(deltaMs: number): void {
    assertFiniteNonnegativeNumber(deltaMs, 'deltaMs');
    const next = this.#monotonicTimeMs + deltaMs;
    if (!Number.isFinite(next)) throw new RangeError('The resulting monotonic value is invalid.');
    this.#monotonicTimeMs = next;
  }
}

function snapshotPlainDataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function addIssue(
  issues: TemporalAuthorityValidationIssue[],
  code: TemporalAuthorityValidationIssueCode,
  field: string,
  message: string,
): void {
  issues.push({ code, field, message });
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
  issues: TemporalAuthorityValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) addIssue(issues, 'UNKNOWN_FIELD', `${field}.${key}`, `Unknown field "${key}".`);
  }
}

function requireFields(
  record: Record<string, unknown>,
  required: ReadonlySet<string>,
  field: string,
  issues: TemporalAuthorityValidationIssue[],
): void {
  for (const key of required) {
    if (!Object.hasOwn(record, key)) addIssue(issues, 'MISSING_FIELD', `${field}.${key}`, `Missing field "${key}".`);
  }
}

function requireIdentifier(
  value: unknown,
  field: string,
  issues: TemporalAuthorityValidationIssue[],
): value is string {
  if (typeof value !== 'string' || value.length === 0 || !/\S/.test(value) || CONTROL_CHARACTER_PATTERN.test(value)) {
    addIssue(issues, 'INVALID_IDENTIFIER', field, `${field} must be a nonblank string without control characters.`);
    return false;
  }
  if (value.length > TEMPORAL_AUTHORITY_LIMITS.opaqueIdentifier) {
    addIssue(
      issues,
      'FIELD_TOO_LARGE',
      field,
      `${field} exceeds ${TEMPORAL_AUTHORITY_LIMITS.opaqueIdentifier} characters.`,
    );
  }
  if (redactAgentRunLedgerFreeText(value) !== value) {
    addIssue(issues, 'SECRET_IN_IDENTIFIER', field, `${field} contains secret-like material.`);
  }
  return true;
}

function requireNullableIdentifier(
  value: unknown,
  field: string,
  issues: TemporalAuthorityValidationIssue[],
): value is string | null {
  if (value === null) return true;
  return requireIdentifier(value, field, issues);
}

function requireSafeInteger(
  value: unknown,
  field: string,
  minimum: number,
  issues: TemporalAuthorityValidationIssue[],
): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    addIssue(issues, 'INVALID_INTEGER', field, `${field} must be a safe integer >= ${minimum}.`);
    return false;
  }
  return true;
}

export function isCanonicalTemporalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_MILLIS_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function requireCanonicalTemporalInstant(
  value: unknown,
  field: string,
  issues: TemporalAuthorityValidationIssue[],
): value is string {
  if (!isCanonicalTemporalInstant(value)) {
    addIssue(
      issues,
      'INVALID_TIMESTAMP',
      field,
      `${field} must use canonical UTC milliseconds (YYYY-MM-DDTHH:mm:ss.SSSZ).`,
    );
    return false;
  }
  return true;
}

function requireNullableCanonicalTemporalInstant(
  value: unknown,
  field: string,
  issues: TemporalAuthorityValidationIssue[],
): value is string | null {
  if (value === null) return true;
  return requireCanonicalTemporalInstant(value, field, issues);
}

export function validateCanonicalTemporalInstant(value: unknown, field = 'instant'): string {
  const issues: TemporalAuthorityValidationIssue[] = [];
  requireCanonicalTemporalInstant(value, field, issues);
  if (issues.length > 0) throw new TemporalAuthorityValidationError(issues);
  return value as string;
}

export function validateTemporalMissionPolicyV1(value: unknown): TemporalMissionPolicyV1 {
  const issues: TemporalAuthorityValidationIssue[] = [];
  const record = snapshotPlainDataRecord(value);
  if (record === null) {
    throw new TemporalAuthorityValidationError([{
      code: 'INVALID_TYPE',
      field: '$',
      message: 'TemporalMissionPolicyV1 must be a plain enumerable data object.',
    }]);
  }

  rejectUnknownFields(record, POLICY_FIELDS, '$', issues);
  requireFields(record, POLICY_REQUIRED_FIELDS, '$', issues);
  if (record.schemaVersion !== TEMPORAL_AUTHORITY_SCHEMA_VERSION) {
    addIssue(
      issues,
      'UNSUPPORTED_SCHEMA_VERSION',
      'schemaVersion',
      `Only schemaVersion "${TEMPORAL_AUTHORITY_SCHEMA_VERSION}" is supported.`,
    );
  }

  const submittedAtValid = requireCanonicalTemporalInstant(record.submittedAt, 'submittedAt', issues);
  const notBeforeValid = !Object.hasOwn(record, 'notBefore')
    || requireCanonicalTemporalInstant(record.notBefore, 'notBefore', issues);
  const deadlineAtValid = !Object.hasOwn(record, 'deadlineAt')
    || requireCanonicalTemporalInstant(record.deadlineAt, 'deadlineAt', issues);
  requireSafeInteger(record.maxAttempts, 'maxAttempts', 1, issues);

  if (Object.hasOwn(record, 'executionTimeoutMs')) {
    requireSafeInteger(record.executionTimeoutMs, 'executionTimeoutMs', 1, issues);
  }
  if (Object.hasOwn(record, 'leaseDurationMs')) {
    requireSafeInteger(record.leaseDurationMs, 'leaseDurationMs', 1, issues);
  }

  if (submittedAtValid && notBeforeValid && typeof record.notBefore === 'string') {
    if (Date.parse(record.notBefore) < Date.parse(record.submittedAt as string)) {
      addIssue(issues, 'INVALID_ORDER', 'notBefore', 'notBefore must not precede submittedAt.');
    }
  }
  if (submittedAtValid && deadlineAtValid && typeof record.deadlineAt === 'string') {
    if (Date.parse(record.deadlineAt) <= Date.parse(record.submittedAt as string)) {
      addIssue(issues, 'INVALID_ORDER', 'deadlineAt', 'deadlineAt must be strictly later than submittedAt.');
    }
  }
  if (notBeforeValid && deadlineAtValid && typeof record.notBefore === 'string' && typeof record.deadlineAt === 'string') {
    if (Date.parse(record.deadlineAt) <= Date.parse(record.notBefore)) {
      addIssue(issues, 'INVALID_ORDER', 'deadlineAt', 'deadlineAt must be strictly later than notBefore.');
    }
  }

  if (issues.length > 0) throw new TemporalAuthorityValidationError(issues);
  return record as unknown as TemporalMissionPolicyV1;
}

export function validateTemporalAuthorizationV1(value: unknown): TemporalAuthorizationV1 {
  const issues: TemporalAuthorityValidationIssue[] = [];
  const record = snapshotPlainDataRecord(value);
  if (record === null) {
    throw new TemporalAuthorityValidationError([{
      code: 'INVALID_TYPE',
      field: '$',
      message: 'TemporalAuthorizationV1 must be a plain enumerable data object.',
    }]);
  }

  rejectUnknownFields(record, AUTHORIZATION_FIELDS, '$', issues);
  requireFields(record, AUTHORIZATION_FIELDS, '$', issues);
  requireIdentifier(record.authorizationId, 'authorizationId', issues);
  requireSafeInteger(record.authorizationVersion, 'authorizationVersion', 1, issues);
  const approvedAtValid = requireCanonicalTemporalInstant(record.approvedAt, 'approvedAt', issues);
  const expiresAtValid = requireCanonicalTemporalInstant(record.approvalExpiresAt, 'approvalExpiresAt', issues);
  if (typeof record.approvedPolicyHash !== 'string' || !SHA256_PATTERN.test(record.approvedPolicyHash)) {
    addIssue(issues, 'INVALID_HASH', 'approvedPolicyHash', 'approvedPolicyHash must be lowercase SHA-256 hex.');
  }
  if (approvedAtValid && expiresAtValid) {
    if (Date.parse(record.approvalExpiresAt as string) <= Date.parse(record.approvedAt as string)) {
      addIssue(
        issues,
        'INVALID_ORDER',
        'approvalExpiresAt',
        'approvalExpiresAt must be strictly later than approvedAt.',
      );
    }
  }

  if (issues.length > 0) throw new TemporalAuthorityValidationError(issues);
  return record as unknown as TemporalAuthorizationV1;
}

export function validateDurableTemporalStateV1(
  value: unknown,
  policy: TemporalMissionPolicyV1,
): DurableTemporalStateV1 {
  const validatedPolicy = validateTemporalMissionPolicyV1(policy);
  const issues: TemporalAuthorityValidationIssue[] = [];
  const record = snapshotPlainDataRecord(value);
  if (record === null) {
    throw new TemporalAuthorityValidationError([{
      code: 'INVALID_TYPE',
      field: '$',
      message: 'DurableTemporalStateV1 must be a plain enumerable data object.',
    }]);
  }

  rejectUnknownFields(record, STATE_FIELDS, '$', issues);
  requireFields(record, STATE_FIELDS, '$', issues);
  const attemptCountValid = requireSafeInteger(record.attemptCount, 'attemptCount', 0, issues);
  if (attemptCountValid && (record.attemptCount as number) > validatedPolicy.maxAttempts) {
    addIssue(
      issues,
      'ATTEMPT_BUDGET_EXCEEDED',
      'attemptCount',
      'attemptCount must not exceed policy.maxAttempts.',
    );
  }
  requireNullableCanonicalTemporalInstant(record.nextAttemptAt, 'nextAttemptAt', issues);
  requireNullableIdentifier(record.leaseOwner, 'leaseOwner', issues);
  requireNullableIdentifier(record.leaseToken, 'leaseToken', issues);
  requireNullableCanonicalTemporalInstant(record.leaseExpiresAt, 'leaseExpiresAt', issues);
  requireNullableCanonicalTemporalInstant(record.terminalAt, 'terminalAt', issues);

  const leaseValues = [record.leaseOwner, record.leaseToken, record.leaseExpiresAt];
  const populatedLeaseFields = leaseValues.filter((item) => item !== null).length;
  if (populatedLeaseFields !== 0 && populatedLeaseFields !== leaseValues.length) {
    addIssue(
      issues,
      'LEASE_TUPLE_MISMATCH',
      'leaseOwner',
      'leaseOwner, leaseToken, and leaseExpiresAt must be all null or all populated.',
    );
  }
  if (populatedLeaseFields === leaseValues.length && attemptCountValid && (record.attemptCount as number) < 1) {
    addIssue(issues, 'LEASE_TUPLE_MISMATCH', 'attemptCount', 'A populated lease requires attemptCount >= 1.');
  }

  const terminalAtPresent = record.terminalAt !== null;
  const terminalReasonPresent = record.terminalReason !== null;
  if (terminalAtPresent !== terminalReasonPresent) {
    addIssue(
      issues,
      'TERMINAL_TUPLE_MISMATCH',
      'terminalAt',
      'terminalAt and terminalReason must be both null or both populated.',
    );
  }
  if (
    record.terminalReason !== null
    && record.terminalReason !== 'deadline_exceeded'
    && record.terminalReason !== 'attempt_budget_exhausted'
    && record.terminalReason !== 'terminal_success'
    && record.terminalReason !== 'terminal_failure'
  ) {
    addIssue(
      issues,
      'INVALID_TERMINAL_REASON',
      'terminalReason',
      'terminalReason must be a durable deadline/attempt exhaustion or terminal success/failure code.',
    );
  }

  if (issues.length > 0) throw new TemporalAuthorityValidationError(issues);
  return record as unknown as DurableTemporalStateV1;
}

export function canonicalizeTemporalAuthorityJson(value: JsonValue): string {
  return canonicalizeAgentRunLedgerJson(value);
}

function validateSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TemporalAuthorityValidationError([{
      code: 'INVALID_HASH',
      field,
      message: `${field} must be lowercase SHA-256 hex.`,
    }]);
  }
  return value;
}

/**
 * Binds the unchanged mission payload identity to the immutable temporal policy.
 * This separate hash deliberately does not alter existing mission/idempotency hashes.
 */
export function createTemporalPolicyBindingHash(
  missionPayloadHash: string,
  policy: TemporalMissionPolicyV1,
): string {
  const validatedMissionPayloadHash = validateSha256(missionPayloadHash, 'missionPayloadHash');
  const validatedPolicy = validateTemporalMissionPolicyV1(policy);
  const material: JsonValue = {
    missionPayloadHash: validatedMissionPayloadHash,
    policy: validatedPolicy as unknown as JsonValue,
  };
  return createHash('sha256')
    .update(`${TEMPORAL_POLICY_HASH_DOMAIN}\n${canonicalizeTemporalAuthorityJson(material)}`, 'utf8')
    .digest('hex');
}

function validateStateRevision(value: unknown): TemporalStateRevisionV1 {
  const issues: TemporalAuthorityValidationIssue[] = [];
  if (typeof value === 'number') {
    requireSafeInteger(value, 'stateRevision', 0, issues);
  } else if (typeof value === 'string') {
    requireIdentifier(value, 'stateRevision', issues);
  } else {
    addIssue(
      issues,
      'INVALID_STATE_REVISION',
      'stateRevision',
      'stateRevision must be a nonnegative safe integer or opaque string.',
    );
  }
  if (issues.length > 0) throw new TemporalAuthorityValidationError(issues);
  return value as TemporalStateRevisionV1;
}

function validateCompletionContext(value: unknown): TemporalCompletionContextV1 {
  const issues: TemporalAuthorityValidationIssue[] = [];
  const record = snapshotPlainDataRecord(value);
  if (record === null) {
    throw new TemporalAuthorityValidationError([{
      code: 'INVALID_COMPLETION_CONTEXT',
      field: 'completion',
      message: 'completion must be an object for completion evaluation.',
    }]);
  }
  rejectUnknownFields(record, COMPLETION_CONTEXT_FIELDS, 'completion', issues);
  requireFields(record, COMPLETION_CONTEXT_FIELDS, 'completion', issues);
  requireIdentifier(record.leaseOwner, 'completion.leaseOwner', issues);
  requireIdentifier(record.leaseToken, 'completion.leaseToken', issues);
  requireSafeInteger(record.attemptNumber, 'completion.attemptNumber', 1, issues);
  if (issues.length > 0) throw new TemporalAuthorityValidationError(issues);
  return record as unknown as TemporalCompletionContextV1;
}

function resultContext(
  operation: 'claim' | 'completion',
  evaluatedAt: string,
  stateRevision: TemporalStateRevisionV1,
  policy: TemporalMissionPolicyV1,
  state: DurableTemporalStateV1,
  authorization: TemporalAuthorizationV1 | undefined,
): TemporalEligibilityResultContextV1 {
  return {
    operation,
    evaluatedAt,
    stateRevision,
    authorizationId: authorization?.authorizationId ?? null,
    authorizationVersion: authorization?.authorizationVersion ?? null,
    attemptCount: state.attemptCount,
    maxAttempts: policy.maxAttempts,
    leaseOwner: state.leaseOwner,
    leaseToken: state.leaseToken,
    leaseExpiresAt: state.leaseExpiresAt,
  };
}

function eligible(context: TemporalEligibilityResultContextV1): TemporalEligibleResultV1 {
  return { ...context, eligible: true, reason: null };
}

function ineligible(
  context: TemporalEligibilityResultContextV1,
  reason: TemporalReasonCodeV1,
): TemporalIneligibleResultV1 {
  return { ...context, eligible: false, reason };
}

/**
 * Pure deterministic temporal evaluation.
 *
 * Claim precedence is intentionally closed and ordered:
 * terminal state -> deadline -> authorization presence/binding -> authorization
 * expiry -> attempt ceiling -> policy/retry not-before -> live lease -> eligible.
 *
 * Completion is a separate fencing mode. Terminal state wins first; otherwise
 * exact owner + token + attempt and an unexpired lease are required. A matching
 * already-started attempt is not retroactively invalidated by a later approval
 * or deadline expiry. The function never reads a clock or mutates input state.
 */
export function evaluateTemporalEligibilityV1(
  input: TemporalEligibilityEvaluationInputV1,
): TemporalEligibilityResultV1 {
  const operation = input.operation;
  const policy = validateTemporalMissionPolicyV1(input.policy);
  const state = validateDurableTemporalStateV1(input.state, policy);
  const evaluatedAt = validateCanonicalTemporalInstant(input.evaluatedAt, 'evaluatedAt');
  const stateRevision = validateStateRevision(input.stateRevision);
  if (operation !== 'claim' && operation !== 'completion') {
    throw new TemporalAuthorityValidationError([{
      code: 'INVALID_TYPE',
      field: 'operation',
      message: 'operation must be claim or completion.',
    }]);
  }
  const authorizationRequired = input.authorizationRequired;
  if (typeof authorizationRequired !== 'boolean') {
    throw new TemporalAuthorityValidationError([{
      code: 'INVALID_TYPE',
      field: 'authorizationRequired',
      message: 'authorizationRequired must be boolean.',
    }]);
  }
  const authorizationInput = input.authorization;
  const authorization = authorizationInput === undefined
    ? undefined
    : validateTemporalAuthorizationV1(authorizationInput);
  const missionPayloadHash = input.missionPayloadHash;
  if (missionPayloadHash !== undefined) validateSha256(missionPayloadHash, 'missionPayloadHash');
  const completion = operation === 'completion'
    ? validateCompletionContext((input as TemporalCompletionEvaluationInputV1).completion)
    : undefined;

  const context = resultContext(operation, evaluatedAt, stateRevision, policy, state, authorization);
  if (state.terminalAt !== null && state.terminalReason !== null) {
    return ineligible(context, state.terminalReason === 'terminal_success' ? 'terminal_success' : 'terminal_failure');
  }

  const evaluatedMs = Date.parse(evaluatedAt);
  if (operation === 'completion' && completion !== undefined) {
    const leaseMatches = state.leaseOwner !== null
      && state.leaseToken !== null
      && state.leaseExpiresAt !== null
      && state.leaseOwner === completion.leaseOwner
      && state.leaseToken === completion.leaseToken
      && state.attemptCount === completion.attemptNumber
      && evaluatedMs < Date.parse(state.leaseExpiresAt);
    return leaseMatches ? eligible(context) : ineligible(context, 'lease_lost');
  }

  if (policy.deadlineAt !== undefined && evaluatedMs >= Date.parse(policy.deadlineAt)) {
    return ineligible(context, 'deadline_exceeded');
  }

  if (authorizationRequired) {
    if (authorization === undefined) return ineligible(context, 'approval_required');
    if (missionPayloadHash === undefined) {
      throw new TemporalAuthorityValidationError([{
        code: 'MISSING_FIELD',
        field: 'missionPayloadHash',
        message: 'missionPayloadHash is required when authorization is evaluated.',
      }]);
    }
    const expectedPolicyHash = createTemporalPolicyBindingHash(missionPayloadHash, policy);
    if (authorization.approvedPolicyHash !== expectedPolicyHash) {
      return ineligible(context, 'approval_required');
    }
    if (evaluatedMs >= Date.parse(authorization.approvalExpiresAt)) {
      return ineligible(context, 'approval_expired');
    }
  }

  if (state.attemptCount >= policy.maxAttempts) {
    return ineligible(context, 'attempt_budget_exhausted');
  }

  if (policy.notBefore !== undefined && evaluatedMs < Date.parse(policy.notBefore)) {
    return ineligible(context, 'not_before_pending');
  }
  if (state.nextAttemptAt !== null && evaluatedMs < Date.parse(state.nextAttemptAt)) {
    return ineligible(context, 'not_before_pending');
  }

  if (state.leaseExpiresAt !== null && evaluatedMs < Date.parse(state.leaseExpiresAt)) {
    return ineligible(context, 'lease_live');
  }

  return eligible(context);
}

function assertFiniteNonnegativeNumber(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be finite and nonnegative.`);
}

function wallTimeMilliseconds(value: string | Date): number {
  if (typeof value === 'string') return Date.parse(validateCanonicalTemporalInstant(value, 'instant'));
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new RangeError('instant must be a valid Date.');
  return milliseconds;
}

function deepFreezeFixture<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeFixture(child);
    Object.freeze(value);
  }
  return value;
}

export interface TemporalAuthorityFixturesV1 {
  readonly missionPayloadHash: string;
  readonly valid: {
    readonly minimalPolicy: TemporalMissionPolicyV1;
    readonly fullPolicy: TemporalMissionPolicyV1;
    readonly authorization: TemporalAuthorizationV1;
    readonly readyState: DurableTemporalStateV1;
    readonly leasedState: DurableTemporalStateV1;
    readonly terminalSuccessState: DurableTemporalStateV1;
    readonly terminalFailureState: DurableTemporalStateV1;
    readonly terminalDeadlineState: DurableTemporalStateV1;
  };
  readonly invalid: {
    readonly nonCanonicalPolicy: unknown;
    readonly unknownFieldPolicy: unknown;
    readonly partialLeaseState: unknown;
    readonly attemptOverBudgetState: unknown;
  };
}

const FIXTURE_MISSION_PAYLOAD_HASH = 'ab6a4aa67dc455b1653d0a81dd589f739c5321638670a58563ee00b297c259a3';
const FIXTURE_MINIMAL_POLICY: TemporalMissionPolicyV1 = {
  schemaVersion: TEMPORAL_AUTHORITY_SCHEMA_VERSION,
  submittedAt: '2026-07-18T10:00:00.000Z',
  maxAttempts: 1,
};
const FIXTURE_FULL_POLICY: TemporalMissionPolicyV1 = {
  schemaVersion: TEMPORAL_AUTHORITY_SCHEMA_VERSION,
  submittedAt: '2026-07-18T10:00:00.000Z',
  notBefore: '2026-07-18T10:05:00.000Z',
  deadlineAt: '2026-07-18T11:00:00.000Z',
  executionTimeoutMs: 30_000,
  maxAttempts: 3,
  leaseDurationMs: 60_000,
};
const FIXTURE_READY_STATE: DurableTemporalStateV1 = {
  attemptCount: 0,
  nextAttemptAt: null,
  leaseOwner: null,
  leaseToken: null,
  leaseExpiresAt: null,
  terminalAt: null,
  terminalReason: null,
};

export const TEMPORAL_AUTHORITY_FIXTURES_V1: TemporalAuthorityFixturesV1 = deepFreezeFixture({
  missionPayloadHash: FIXTURE_MISSION_PAYLOAD_HASH,
  valid: {
    minimalPolicy: FIXTURE_MINIMAL_POLICY,
    fullPolicy: FIXTURE_FULL_POLICY,
    authorization: {
      authorizationId: 'authorization-fixture-001',
      authorizationVersion: 1,
      approvedAt: '2026-07-18T10:01:00.000Z',
      approvalExpiresAt: '2026-07-18T10:45:00.000Z',
      approvedPolicyHash: createTemporalPolicyBindingHash(FIXTURE_MISSION_PAYLOAD_HASH, FIXTURE_FULL_POLICY),
    },
    readyState: FIXTURE_READY_STATE,
    leasedState: {
      ...FIXTURE_READY_STATE,
      attemptCount: 1,
      leaseOwner: 'worker-fixture-a',
      leaseToken: 'lease-fixture-001',
      leaseExpiresAt: '2026-07-18T10:10:00.000Z',
    },
    terminalSuccessState: {
      ...FIXTURE_READY_STATE,
      attemptCount: 1,
      terminalAt: '2026-07-18T10:06:00.000Z',
      terminalReason: 'terminal_success',
    },
    terminalFailureState: {
      ...FIXTURE_READY_STATE,
      attemptCount: 1,
      terminalAt: '2026-07-18T10:06:00.000Z',
      terminalReason: 'terminal_failure',
    },
    terminalDeadlineState: {
      ...FIXTURE_READY_STATE,
      terminalAt: '2026-07-18T11:00:00.000Z',
      terminalReason: 'deadline_exceeded',
    },
  },
  invalid: {
    nonCanonicalPolicy: {
      ...FIXTURE_MINIMAL_POLICY,
      submittedAt: '2026-07-18T10:00:00Z',
    },
    unknownFieldPolicy: {
      ...FIXTURE_MINIMAL_POLICY,
      retryWindowMs: 60_000,
    },
    partialLeaseState: {
      ...FIXTURE_READY_STATE,
      attemptCount: 1,
      leaseOwner: 'worker-fixture-a',
    },
    attemptOverBudgetState: {
      ...FIXTURE_READY_STATE,
      attemptCount: 2,
    },
  },
});

export const TEMPORAL_AUTHORITY_FIXTURES_V1_SERIALIZATION = canonicalizeTemporalAuthorityJson(
  TEMPORAL_AUTHORITY_FIXTURES_V1 as unknown as JsonValue,
);
