/**
 * CHANTER Agent Runtime — AutoPoster HTTP operations port.
 *
 * Typed, bounded client for AutoPoster's token-guarded runtime control
 * routes (`/api/runtime/*`). Deliberately minimal:
 *
 *  - one attempt per call, no automatic retries (a retry could double-create
 *    a scheduled queue item);
 *  - hard per-call timeout via AbortController;
 *  - the service token is sent in a header and never included in errors,
 *    logs, or returned data;
 *  - every non-2xx / unreachable / malformed response maps into the stable
 *    AutoPosterPortErrorCode taxonomy — an unreachable AutoPoster is
 *    'unavailable', never an empty success.
 *
 * `fetchImpl` is injectable so tests never touch the network.
 */
import type {
  AutoPosterConnectedAccountListParams,
  AutoPosterConnectedAccountListSuccess,
  AutoPosterConnectedAccountValidationParams,
  AutoPosterConnectedAccountValidationSuccess,
  AutoPosterConnectedAccountView,
  AutoPosterConnectedAccountReasonCode,
  AutoPosterMediaValidationParams,
  AutoPosterMediaValidationSuccess,
  AutoPosterOperationsPort,
  AutoPosterCommercialDenialDetails,
  AutoPosterPortErrorCode,
  AutoPosterPortFailure,
  AutoPosterProviderMutationSummaryView,
  AutoPosterApprovedMediaIdentity,
  AutoPosterReconciliationLeaseView,
  AutoPosterProviderOperationState,
  AutoPosterProviderOperationView,
  AutoPosterProviderReconciliationParams,
  AutoPosterProviderReconciliationSuccess,
  AutoPosterProviderStatusReceiptView,
  AutoPosterProviderVerificationView,
  AutoPosterPostStatusHistoryEntryView,
  AutoPosterPostStatusLastResultView,
  AutoPosterPostStatusParams,
  AutoPosterPostStatusSuccess,
  AutoPosterPostStatusView,
  AutoPosterQueueListParams,
  AutoPosterQueueListSuccess,
  AutoPosterQueueStatus,
  AutoPosterScheduleParams,
  AutoPosterScheduleReconciliationParams,
  AutoPosterScheduleReconciliationSuccess,
  AutoPosterScheduleSuccess,
} from './autoPosterMissionAdapter.js';
import { redactText } from '../redaction.js';
import { createHash } from 'node:crypto';
import {
  containsForbiddenProviderMaterial,
  PROVIDER_DIAGNOSTIC_REDACTED_MESSAGE,
  safeProviderFailureMessage,
} from '../providerSafety.js';

export interface AutoPosterHttpPortOptions {
  /** Base URL of the AutoPoster server, e.g. 'http://localhost:3010'. */
  baseUrl: string;
  /** Value for the x-chanter-runtime-token header. Never logged or echoed. */
  serviceToken: string;
  /** Per-call timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export const RUNTIME_CONTROL_TOKEN_HEADER = 'x-chanter-runtime-token';

const DEFAULT_TIMEOUT_MS = 10_000;

function containsProtectedValue(
  value: unknown,
  protectedValue: string,
  seen = new Set<object>()
): boolean {
  if (typeof value === 'string') return value.includes(protectedValue);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsProtectedValue(item, protectedValue, seen));
  }

  return Object.entries(value).some(
    ([key, item]) => key.includes(protectedValue) || containsProtectedValue(item, protectedValue, seen)
  );
}

// AutoPoster uses 409 for server-authoritative commercial refusals as well as
// ordinary request conflicts. Only these canonical domain decisions are
// promoted to `forbidden`; unrelated 409/404 responses retain their normal
// validation/not-found classification.
const COMMERCIAL_DENIAL_REASON_CODES = new Set([
  'workspace_not_found',
  'workspace_inactive',
  'subscription_inactive',
  'plan_not_found',
  'entitlement_configuration_invalid',
  'commercial_truth_unverified',
  'feature_not_available',
  'workspace_limit_reached',
  'provider_limit_reached',
  'connected_account_limit_reached',
  'monthly_post_limit_reached',
  'active_queue_limit_reached',
  'batch_size_limit_exceeded',
  'scheduling_horizon_exceeded',
  'runtime_scheduling_not_allowed',
]);

const CONNECTED_ACCOUNT_REASON_CODES = new Set<AutoPosterConnectedAccountReasonCode>([
  'unknown_account_id',
  'account_id_case_mismatch',
  'account_id_non_canonical',
  'account_workspace_mismatch',
  'provider_account_mismatch',
  'account_disconnected',
  'account_not_publishing_ready',
]);

const RECOVERY_REASON_CODES = new Set([
  'recovery_scope_mismatch',
  'reconciliation_required',
  'recovery_evidence_invalid',
]);

const CONNECTED_ACCOUNT_PROVIDERS = new Set(['tiktok', 'youtube']);
const CONNECTED_ACCOUNT_READINESS_BLOCKERS = new Set([
  'provider_not_active',
  'account_disconnected',
  'reauthorization_required',
  'missing_video_publish_scope',
]);

function failure(
  code: AutoPosterPortErrorCode,
  message: string,
  details?: AutoPosterCommercialDenialDetails
): AutoPosterPortFailure {
  return {
    ok: false,
    code,
    message,
    ...(details?.reasonCode ? { reasonCode: details.reasonCode } : {}),
    ...(details ? { details } : {}),
  };
}

function safeFailureDetails(record: Record<string, unknown>): AutoPosterCommercialDenialDetails | undefined {
  const details: AutoPosterCommercialDenialDetails = {};
  const candidateReasonCode =
    typeof record.reasonCode === 'string' && record.reasonCode.trim()
      ? record.reasonCode.trim()
      : typeof record.code === 'string' && record.code.trim() && !isPortErrorCode(record.code)
        ? record.code.trim()
        : '';
  const reasonCode = candidateReasonCode
    && (COMMERCIAL_DENIAL_REASON_CODES.has(candidateReasonCode)
      || CONNECTED_ACCOUNT_REASON_CODES.has(candidateReasonCode as AutoPosterConnectedAccountReasonCode)
      || RECOVERY_REASON_CODES.has(candidateReasonCode))
    ? candidateReasonCode
    : '';
  if (reasonCode) details.reasonCode = reasonCode;

  for (const field of ['current', 'limit', 'remaining'] as const) {
    const value = record[field];
    if (value === null || (typeof value === 'number' && Number.isFinite(value))) {
      details[field] = value;
    }
  }
  for (const field of ['planId', 'workspaceId'] as const) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) details[field] = value.trim();
  }
  if (CONNECTED_ACCOUNT_REASON_CODES.has(reasonCode as AutoPosterConnectedAccountReasonCode)) {
    const accountId = record.accountId;
    if (typeof accountId === 'string' && accountId.trim()) {
      // Opaque provider ids are case-sensitive. Preserve the exact safe value.
      details.accountId = accountId;
    }
    for (const field of ['provider', 'requestedProvider', 'accountProvider'] as const) {
      const value = record[field];
      if (typeof value === 'string' && CONNECTED_ACCOUNT_PROVIDERS.has(value)) details[field] = value;
    }
    if (Array.isArray(record.blockers)) {
      const blockers = record.blockers
        .filter((value): value is string => (
          typeof value === 'string' && CONNECTED_ACCOUNT_READINESS_BLOCKERS.has(value)
        ))
        .slice(0, CONNECTED_ACCOUNT_READINESS_BLOCKERS.size);
      if (blockers.length > 0) details.blockers = blockers;
    }
  }
  if (
    typeof record.evaluationTimestamp === 'string'
    && Number.isFinite(Date.parse(record.evaluationTimestamp))
  ) {
    details.evaluationTimestamp = new Date(record.evaluationTimestamp).toISOString();
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function isCommercialDenial(
  status: number,
  details: AutoPosterCommercialDenialDetails | undefined
): boolean {
  return (status === 403 || status === 404 || status === 409)
    && typeof details?.reasonCode === 'string'
    && COMMERCIAL_DENIAL_REASON_CODES.has(details.reasonCode);
}

function statusToErrorCode(status: number): AutoPosterPortErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 409 || status === 422) return 'validation_failed';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  return 'internal';
}

const CONNECTION_STATUSES = new Set<AutoPosterConnectedAccountView['connectionStatus']>([
  'connected',
  'reauthorization_required',
  'disconnected',
]);

function nonArrayRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Projects one HTTP response account through a strict allowlist. Identity
 * fields remain byte-exact; human-readable labels are defensively redacted.
 */
function connectedAccountView(value: unknown): AutoPosterConnectedAccountView | undefined {
  const record = nonArrayRecord(value);
  if (!record) return undefined;

  const provider = typeof record.provider === 'string' ? record.provider : '';
  const accountId = typeof record.accountId === 'string' ? record.accountId : '';
  const connectedAccountId = typeof record.connectedAccountId === 'string' ? record.connectedAccountId : '';
  const providerDisplayName = typeof record.providerDisplayName === 'string' ? record.providerDisplayName : '';
  const username = typeof record.username === 'string' ? record.username : '';
  const displayName = typeof record.displayName === 'string' ? record.displayName : '';
  const connectionStatus = record.connectionStatus;
  const publishingReady = record.publishingReady;
  const blockers = record.readinessBlockers;
  const lastVerifiedAt = record.lastVerifiedAt;

  if (
    !CONNECTED_ACCOUNT_PROVIDERS.has(provider)
    || !accountId
    || accountId !== accountId.trim()
    || connectedAccountId !== `${provider}:${accountId}`
    || !CONNECTION_STATUSES.has(connectionStatus as AutoPosterConnectedAccountView['connectionStatus'])
    || typeof publishingReady !== 'boolean'
    || !Array.isArray(blockers)
    || blockers.some((blocker) => (
      typeof blocker !== 'string' || !CONNECTED_ACCOUNT_READINESS_BLOCKERS.has(blocker)
    ))
    || (lastVerifiedAt !== null
      && (typeof lastVerifiedAt !== 'string' || !Number.isFinite(Date.parse(lastVerifiedAt))))
  ) {
    return undefined;
  }

  return {
    provider,
    providerDisplayName: redactText(providerDisplayName),
    accountId,
    connectedAccountId,
    username: redactText(username),
    displayName: redactText(displayName),
    connectionStatus: connectionStatus as AutoPosterConnectedAccountView['connectionStatus'],
    publishingReady,
    readinessBlockers: [...blockers] as string[],
    lastVerifiedAt: lastVerifiedAt === null ? null : new Date(lastVerifiedAt as string).toISOString(),
  };
}

function exactWorkspaceId(value: unknown): string | undefined {
  return typeof value === 'string' && Boolean(value) && value === value.trim() ? value : undefined;
}

// ---------------------------------------------------------------------------
// Phase 2E-B closed-world post-status parser
// ---------------------------------------------------------------------------

const POST_STATUS_QUEUE_STATUSES = new Set<AutoPosterQueueStatus>([
  'pending',
  'scheduled',
  'processing',
  'ready',
  'posted',
  'failed',
  'outcome_unknown',
]);
const POST_STATUS_HISTORY_LIMIT = 20;
const POST_STATUS_LAST_RESULT_KEYS = new Set([
  'mode',
  'code',
  'message',
  'completedAt',
  'willRetry',
  'outcomeUnknown',
  'providerMutationStarted',
  'failureBoundary',
]);
const POST_STATUS_HISTORY_ENTRY_KEYS = new Set(['at', 'event', 'detail']);
const PROVIDER_VERIFICATION_KEYS = new Set([
  'provider',
  'externalVideoId',
  'channelId',
  'channelTitle',
  'channelHandle',
  'title',
  'privacyStatus',
  'uploadStatus',
  'processingStatus',
  'verifiedAt',
  'uploadMethod',
]);
// Key names that must never appear anywhere in a status response body:
// credential-shaped names, worker lock ownership, and raw media/content
// fields. Exact-name checks come first; the pattern catches the rest.
const POST_STATUS_FORBIDDEN_KEYS = new Set([
  'lockedBy',
  'caption',
  'hashtags',
  'mediaUrl',
  'mediaPath',
  'publicMediaUrl',
  'publicImageUrl',
  'videoPath',
  'imagePath',
]);
const POST_STATUS_SECRET_KEY_PATTERN =
  /token|secret|credential|password|authorization|api[-_]?key|cookie|bearer/i;
const POST_STATUS_SECRET_VALUE_PATTERN =
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|https?:\/\/[^\s"']*(?:upload_id=|\/upload-session\/|resumable)/i;
const POST_STATUS_TOP_LEVEL_KEYS = new Set([
  'id', 'provider', 'connectedAccountId', 'accountId', 'username', 'workspaceId', 'status',
  'scheduledAt', 'approved', 'approvalState', 'approvedAt', 'approvedBy', 'mediaType',
  'captionSummary', 'createdAt', 'updatedAt', 'postedAt', 'publishId', 'providerStatus',
  'providerVerification', 'providerOperation', 'lockedAt', 'claimAttempts', 'publishAttemptBudget',
  'attemptBudgetExhausted', 'runtimeMissionId', 'runtimeIdempotencyKey', 'runtimeAction',
  'runtimePayloadHash', 'lastResult', 'history', 'lastErrorMessage',
]);
const PROVIDER_RECONCILIATION_CLASSIFICATIONS = new Set<AutoPosterProviderReconciliationSuccess['classification']>([
  'operation_pending', 'media_preflighted', 'session_persisted', 'uploading', 'resumable',
  'completed_private', 'provider_missing', 'contradictory_public', 'outcome_unknown', 'terminal_failure',
  'provider_operation_not_found', 'provider_operation_identity_mismatch', 'session_missing',
  'budget_exhausted', 'session_locator_decrypt_failed', 'session_locator_invalid',
  'provider_credentials_unavailable', 'media_unavailable', 'media_identity_drift',
  'provider_status_unavailable', 'provider_receipt_rejected',
]);

type PostStatusParse =
  | { ok: true; view: AutoPosterPostStatusView }
  | { ok: false; message: string; identityMismatch: boolean };

function statusParseError(message: string, identityMismatch = false): PostStatusParse {
  return { ok: false, message, identityMismatch };
}

/** Recursively finds a forbidden or secret-like key anywhere in the response post. */
function findUnsafeStatusKey(value: unknown, seen = new Set<object>()): string | undefined {
  if (typeof value === 'string' && POST_STATUS_SECRET_VALUE_PATTERN.test(value)) return '[secret-like value]';
  if (value === null || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const unsafe = findUnsafeStatusKey(item, seen);
      if (unsafe) return unsafe;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (POST_STATUS_FORBIDDEN_KEYS.has(key) || (
      key !== 'reconciliationFencingToken' && POST_STATUS_SECRET_KEY_PATTERN.test(key)
    )) {
      return key;
    }
    const unsafe = findUnsafeStatusKey(item, seen);
    if (unsafe) return unsafe;
  }
  return undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength) return undefined;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value) ? undefined : value;
}

/** null stays null; a string must be an exactly parseable timestamp and is kept byte-exact. */
function timestampOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 80) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function parseProviderVerification(
  value: unknown,
  provider: 'tiktok' | 'youtube',
  accountId: string,
  publishId: string
): { value: AutoPosterProviderVerificationView | null } | { error: string } {
  if (value === null || value === undefined) return { value: null };
  const record = nonArrayRecord(value);
  if (!record) return { error: 'providerVerification is not an object' };
  for (const key of Object.keys(record)) {
    if (!PROVIDER_VERIFICATION_KEYS.has(key)) {
      return { error: `providerVerification contains the unexpected field "${redactText(key).slice(0, 40)}"` };
    }
  }
  if (provider !== 'youtube') return { error: 'providerVerification is only valid for YouTube jobs' };
  const externalVideoId = boundedString(record.externalVideoId, 128);
  const channelId = boundedString(record.channelId, 256);
  const channelTitle = boundedString(record.channelTitle ?? '', 200);
  const channelHandle = boundedString(record.channelHandle ?? '', 200);
  const title = boundedString(record.title, 100);
  const uploadStatus = boundedString(record.uploadStatus ?? '', 120);
  const processingStatus = boundedString(record.processingStatus ?? '', 120);
  const verifiedAt = timestampOrNull(record.verifiedAt);
  if (
    record.provider !== 'youtube'
    || !externalVideoId
    || externalVideoId !== publishId
    || !channelId
    || channelId !== accountId
    || channelTitle === undefined
    || channelHandle === undefined
    || !title
    || record.privacyStatus !== 'private'
    || uploadStatus === undefined
    || processingStatus === undefined
    || verifiedAt === undefined
    || verifiedAt === null
    || record.uploadMethod !== 'resumable'
  ) {
    return { error: 'providerVerification does not match the exact YouTube artifact binding' };
  }
  return {
    value: {
      provider: 'youtube',
      externalVideoId,
      channelId,
      channelTitle: redactText(channelTitle),
      channelHandle: redactText(channelHandle),
      title: redactText(title),
      privacyStatus: 'private',
      uploadStatus: redactText(uploadStatus),
      processingStatus: redactText(processingStatus),
      verifiedAt,
      uploadMethod: 'resumable',
    },
  };
}

function parseStatusLastResult(
  value: unknown
): { value: AutoPosterPostStatusLastResultView | null } | { error: string } {
  if (value === null || value === undefined) return { value: null };
  const record = nonArrayRecord(value);
  if (!record) return { error: 'lastResult is not an object' };
  for (const key of Object.keys(record)) {
    if (!POST_STATUS_LAST_RESULT_KEYS.has(key)) {
      return { error: `lastResult contains the unexpected field "${redactText(key).slice(0, 40)}"` };
    }
  }
  const view: AutoPosterPostStatusLastResultView = {};
  for (const [key, maxLength] of [
    ['mode', 40],
    ['code', 120],
    ['message', 300],
    ['failureBoundary', 120],
  ] as const) {
    if (record[key] !== undefined) {
      const parsed = boundedString(record[key], maxLength);
      if (parsed === undefined) return { error: `lastResult.${key} is malformed` };
      view[key] = redactText(parsed);
    }
  }
  if (record.completedAt !== undefined) {
    const parsed = timestampOrNull(record.completedAt);
    if (parsed === undefined || parsed === null) return { error: 'lastResult.completedAt is malformed' };
    view.completedAt = parsed;
  }
  for (const key of ['willRetry', 'outcomeUnknown', 'providerMutationStarted'] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'boolean') return { error: `lastResult.${key} is malformed` };
      view[key] = record[key];
    }
  }
  return { value: Object.keys(view).length > 0 ? view : null };
}

function parseStatusHistory(
  value: unknown
): { value: AutoPosterPostStatusHistoryEntryView[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'history is not an array' };
  if (value.length > POST_STATUS_HISTORY_LIMIT) {
    return { error: `history exceeds the ${POST_STATUS_HISTORY_LIMIT}-entry wire cap` };
  }
  const entries: AutoPosterPostStatusHistoryEntryView[] = [];
  for (const item of value) {
    const record = nonArrayRecord(item);
    if (!record) return { error: 'history contains a non-object entry' };
    for (const key of Object.keys(record)) {
      if (!POST_STATUS_HISTORY_ENTRY_KEYS.has(key)) {
        return { error: `history contains the unexpected field "${redactText(key).slice(0, 40)}"` };
      }
    }
    const event = boundedString(record.event, 64);
    if (!event || !event.trim()) return { error: 'history contains an entry without a valid event' };
    const at = record.at === undefined || record.at === null ? null : boundedString(record.at, 80);
    if (at === undefined) return { error: 'history contains an entry with a malformed timestamp' };
    const detail = record.detail === undefined ? '' : boundedString(record.detail, 300);
    if (detail === undefined) return { error: 'history contains an entry with a malformed detail' };
    entries.push({
      at: at === null ? null : redactText(at),
      event: redactText(event),
      detail: redactText(detail),
    });
  }
  return { value: entries };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_OPERATION_ID_PATTERN = /^ytop_[a-f0-9]{64}$/;
const PROVIDER_ATTEMPT_ID_PATTERN = /^ytatt_[a-f0-9]{64}$/;
const PROVIDER_OPERATION_STATES = new Set<AutoPosterProviderOperationState>([
  'operation_pending', 'media_preflighted', 'session_persisted', 'uploading', 'resumable',
  'completed_private', 'provider_missing', 'contradictory_public', 'outcome_unknown', 'terminal_failure',
]);
const PROVIDER_OPERATION_KEYS = new Set([
  'schemaVersion', 'providerOperationId', 'providerAttemptId', 'provider', 'operationState',
  'queueId', 'userId', 'workspaceId', 'accountId', 'connectedAccountId', 'approvalActorId',
  'approvalTimestamp', 'approvedAttemptNumber', 'runtimeMissionId', 'graphId', 'runtimeAction',
  'runtimePayloadHash', 'approvedMediaSha256', 'providerProofMode', 'approvedMedia',
  'bindingSha256', 'mediaSha256', 'mediaByteSize', 'mediaMimeType', 'mediaContainer',
  'mediaFileName', 'mediaSourceId', 'sessionCreatedAt', 'uploadStartedAt', 'uploadCompletedAt',
  'acceptedByteOffset', 'externalVideoId', 'providerResponseSha256', 'providerStatusReceiptSha256',
  'providerStatusReceipt', 'mutationSummary', 'reconciliationAttemptCount',
  'reconciliationAttemptBudget', 'reconciliationLease', 'reconciliationFencingToken',
  'lastReconciledAt', 'lastOperationErrorCode', 'eventCount',
  'eventDigestSha256',
]);
const PROVIDER_MUTATION_KEYS = new Set([
  'providerSessionInitiationCount', 'mediaUploadAttemptCount', 'confirmedVideoArtifactCount',
  'existingResourceUpdateCount', 'deleteCount', 'reconciliationStatusReadCount',
]);
const PROVIDER_RECEIPT_KEYS = new Set([
  'provider', 'queueId', 'providerOperationId', 'providerAttemptId', 'userId', 'workspaceId',
  'runtimeMissionId', 'graphId', 'mediaSha256', 'approvedMedia', 'providerProofMode',
  'configuredAccountId', 'connectedAccountId', 'verifiedChannelId', 'safeChannelTitle',
  'authenticatedChannelId',
  'safeChannelHandle', 'externalVideoId', 'expectedTitle', 'exactTitleMatch', 'artifactExists',
  'privacyStatus', 'uploadStatus', 'processingStatus', 'verificationMethod',
  'verificationTimestamp', 'canonicalResponseSha256',
]);
const COMPLETED_PRIVATE_UPLOAD_SUCCESS_STATUSES = new Set(['processed']);
const COMPLETED_PRIVATE_PROCESSING_SUCCESS_STATUSES = new Set(['succeeded']);

function normalizeProviderStatus(status: string): string {
  return status.trim().toLowerCase();
}

function completedPrivateStatusesAreCoherent(
  receipt: Pick<AutoPosterProviderStatusReceiptView, 'uploadStatus' | 'processingStatus'>,
  verification?: Pick<AutoPosterProviderVerificationView, 'uploadStatus' | 'processingStatus'>,
): boolean {
  const receiptUploadStatus = normalizeProviderStatus(receipt.uploadStatus);
  const receiptProcessingStatus = normalizeProviderStatus(receipt.processingStatus);
  if (
    !COMPLETED_PRIVATE_UPLOAD_SUCCESS_STATUSES.has(receiptUploadStatus)
    || !COMPLETED_PRIVATE_PROCESSING_SUCCESS_STATUSES.has(receiptProcessingStatus)
  ) return false;
  if (!verification) return true;
  return normalizeProviderStatus(verification.uploadStatus) === receiptUploadStatus
    && normalizeProviderStatus(verification.processingStatus) === receiptProcessingStatus;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [
    key,
    canonicalize((value as Record<string, unknown>)[key]),
  ]));
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function safeCount(value: unknown, maximum = 100_000): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
    ? value as number
    : undefined;
}

const APPROVED_MEDIA_KEYS = new Set(['sha256', 'byteSize', 'mimeType', 'fileName', 'container']);
function parseApprovedMedia(value: unknown): AutoPosterApprovedMediaIdentity | null | undefined {
  if (value === null) return null;
  const record = nonArrayRecord(value);
  if (!record || !hasOnlyKeys(record, APPROVED_MEDIA_KEYS) || Object.keys(record).length !== APPROVED_MEDIA_KEYS.size) {
    return undefined;
  }
  const fileName = boundedString(record.fileName, 255);
  if (
    typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)
    || !Number.isSafeInteger(record.byteSize) || (record.byteSize as number) <= 0
    || record.mimeType !== 'video/mp4' || record.container !== 'mp4'
    || !fileName || !/\.mp4$/i.test(fileName) || /[\\/<>:"|?*]/.test(fileName)
  ) return undefined;
  return {
    sha256: record.sha256,
    byteSize: record.byteSize as number,
    mimeType: 'video/mp4',
    fileName,
    container: 'mp4',
  };
}

function parseReconciliationLease(
  value: unknown,
  operationId: string,
): AutoPosterReconciliationLeaseView | null | undefined {
  if (value === null) return null;
  const record = nonArrayRecord(value);
  if (!record || !hasOnlyKeys(record, new Set([
    'ownerId', 'acquiredAt', 'expiresAt', 'attemptNumber', 'operationId', 'fencingToken',
  ]))) return undefined;
  const ownerId = boundedString(record.ownerId, 256);
  const acquiredAt = timestampOrNull(record.acquiredAt);
  const expiresAt = timestampOrNull(record.expiresAt);
  const attemptNumber = safeCount(record.attemptNumber, 3);
  const fencingToken = safeCount(record.fencingToken, Number.MAX_SAFE_INTEGER);
  if (!ownerId || !acquiredAt || !expiresAt || Date.parse(expiresAt) <= Date.parse(acquiredAt)
    || !attemptNumber || !fencingToken || record.operationId !== operationId) return undefined;
  return { ownerId, acquiredAt, expiresAt, attemptNumber, operationId, fencingToken };
}

function parseProviderMutationSummary(value: unknown): AutoPosterProviderMutationSummaryView | undefined {
  const record = nonArrayRecord(value);
  if (!record || !hasOnlyKeys(record, PROVIDER_MUTATION_KEYS)) return undefined;
  const result = {} as AutoPosterProviderMutationSummaryView;
  for (const key of PROVIDER_MUTATION_KEYS as Set<keyof AutoPosterProviderMutationSummaryView>) {
    const count = safeCount(record[key]);
    if (count === undefined) return undefined;
    result[key] = count;
  }
  return result;
}

function parseProviderReceipt(
  value: unknown,
  identity: {
    queueId: string;
    providerOperationId: string;
    providerAttemptId: string;
    mediaSha256: string;
    approvedMedia: AutoPosterApprovedMediaIdentity | null;
    providerProofMode: boolean;
    userId: string;
    workspaceId: string;
    runtimeMissionId: string;
    graphId: string;
    accountId: string;
    connectedAccountId: string;
  }
): AutoPosterProviderStatusReceiptView | undefined {
  const record = nonArrayRecord(value);
  if (!record || !hasOnlyKeys(record, PROVIDER_RECEIPT_KEYS)) return undefined;
  const expectedTitle = boundedString(record.expectedTitle, 100);
  const verifiedChannelId = boundedString(record.verifiedChannelId, 256);
  const externalVideoId = boundedString(record.externalVideoId, 128);
  const safeChannelTitle = boundedString(record.safeChannelTitle, 200);
  const safeChannelHandle = boundedString(record.safeChannelHandle, 200);
  const privacyStatus = boundedString(record.privacyStatus, 40);
  const uploadStatus = boundedString(record.uploadStatus, 120);
  const processingStatus = boundedString(record.processingStatus, 120);
  const verificationTimestamp = timestampOrNull(record.verificationTimestamp);
  const artifactExists = record.artifactExists;
  const approvedMedia = parseApprovedMedia(record.approvedMedia ?? null);
  const providerProofMode = record.providerProofMode === true;
  if (
    record.provider !== 'youtube'
    || record.queueId !== identity.queueId
    || record.providerOperationId !== identity.providerOperationId
    || record.providerAttemptId !== identity.providerAttemptId
    || record.mediaSha256 !== identity.mediaSha256
    || record.userId !== identity.userId
    || record.workspaceId !== identity.workspaceId
    || record.runtimeMissionId !== identity.runtimeMissionId
    || record.graphId !== identity.graphId
    || approvedMedia === undefined
    || providerProofMode !== identity.providerProofMode
    || JSON.stringify(approvedMedia) !== JSON.stringify(identity.approvedMedia)
    || record.configuredAccountId !== identity.accountId
    || record.connectedAccountId !== identity.connectedAccountId
    || record.authenticatedChannelId !== record.verifiedChannelId
    || record.verificationMethod !== 'youtube.videos.list+youtube.channels.list'
    || typeof record.exactTitleMatch !== 'boolean'
    || typeof artifactExists !== 'boolean'
    || !expectedTitle
    || verifiedChannelId === undefined
    || externalVideoId === undefined
    || safeChannelTitle === undefined
    || safeChannelHandle === undefined
    || privacyStatus === undefined
    || uploadStatus === undefined
    || processingStatus === undefined
    || verificationTimestamp === undefined
    || verificationTimestamp === null
    || typeof record.canonicalResponseSha256 !== 'string'
    || !SHA256_PATTERN.test(record.canonicalResponseSha256)
    || (artifactExists && (!verifiedChannelId || !externalVideoId))
  ) return undefined;
  return {
    provider: 'youtube',
    queueId: identity.queueId,
    providerOperationId: identity.providerOperationId,
    providerAttemptId: identity.providerAttemptId,
    mediaSha256: identity.mediaSha256,
    userId: identity.userId,
    workspaceId: identity.workspaceId,
    runtimeMissionId: identity.runtimeMissionId,
    graphId: identity.graphId,
    approvedMedia,
    providerProofMode,
    configuredAccountId: identity.accountId,
    connectedAccountId: identity.connectedAccountId,
    verifiedChannelId,
    authenticatedChannelId: verifiedChannelId,
    safeChannelTitle: redactText(safeChannelTitle),
    safeChannelHandle: redactText(safeChannelHandle),
    externalVideoId,
    expectedTitle: redactText(expectedTitle),
    exactTitleMatch: record.exactTitleMatch,
    artifactExists,
    privacyStatus,
    uploadStatus: redactText(uploadStatus),
    processingStatus: redactText(processingStatus),
    verificationMethod: 'youtube.videos.list+youtube.channels.list',
    verificationTimestamp,
    canonicalResponseSha256: record.canonicalResponseSha256,
  };
}

function parseProviderOperation(
  value: unknown,
  post: {
    id: string;
    provider: 'tiktok' | 'youtube';
    workspaceId: string;
    accountId: string;
    connectedAccountId: string;
    runtimeMissionId: string;
    runtimeAction: string;
    runtimePayloadHash: string;
    userId: string;
  }
): { value: AutoPosterProviderOperationView | null } | { error: string } {
  if (value === null || value === undefined) return { value: null };
  const record = nonArrayRecord(value);
  if (!record || !hasOnlyKeys(record, PROVIDER_OPERATION_KEYS)) {
    return { error: 'providerOperation contains an unknown field or is not an object' };
  }
  const providerOperationId = boundedString(record.providerOperationId, 96);
  const providerAttemptId = boundedString(record.providerAttemptId, 96);
  const operationState = record.operationState;
  const graphId = boundedString(record.graphId ?? '', 256);
  const approvalActorId = boundedString(record.approvalActorId, 256);
  const approvalTimestamp = timestampOrNull(record.approvalTimestamp);
  const approvedAttemptNumber = safeCount(record.approvedAttemptNumber, 1000);
  if (
    post.provider !== 'youtube'
    || record.schemaVersion !== 'chanter.autoposter.youtube-provider-operation.v1'
    || record.provider !== 'youtube'
    || !providerOperationId || !PROVIDER_OPERATION_ID_PATTERN.test(providerOperationId)
    || !providerAttemptId || !PROVIDER_ATTEMPT_ID_PATTERN.test(providerAttemptId)
    || typeof operationState !== 'string'
    || !PROVIDER_OPERATION_STATES.has(operationState as AutoPosterProviderOperationState)
    || record.queueId !== post.id
    || record.userId !== post.userId
    || record.workspaceId !== post.workspaceId
    || record.accountId !== post.accountId
    || record.connectedAccountId !== post.connectedAccountId
    || record.runtimeMissionId !== post.runtimeMissionId
    || record.runtimeAction !== post.runtimeAction
    || record.runtimePayloadHash !== post.runtimePayloadHash
    || graphId === undefined
    || !approvalActorId
    || !approvalTimestamp
    || !approvedAttemptNumber
  ) return { error: 'providerOperation does not match the exact post identity' };

  const nullableHash = (candidate: unknown): string | null | undefined => (
    candidate === null ? null : typeof candidate === 'string' && SHA256_PATTERN.test(candidate) ? candidate : undefined
  );
  const bindingSha256 = nullableHash(record.bindingSha256);
  const approvedMediaSha256 = nullableHash(record.approvedMediaSha256);
  const approvedMedia = parseApprovedMedia(record.approvedMedia ?? null);
  const providerProofMode = record.providerProofMode === true;
  const mediaSha256 = nullableHash(record.mediaSha256);
  const providerResponseSha256 = nullableHash(record.providerResponseSha256);
  const providerStatusReceiptSha256 = nullableHash(record.providerStatusReceiptSha256);
  const mediaByteSize = record.mediaByteSize === null
    ? null
    : safeCount(record.mediaByteSize, Number.MAX_SAFE_INTEGER);
  const mediaMimeType = record.mediaMimeType === null ? null : boundedString(record.mediaMimeType, 120);
  const mediaContainer = record.mediaContainer === null ? null : boundedString(record.mediaContainer, 24);
  const mediaFileName = record.mediaFileName === null ? null : boundedString(record.mediaFileName, 255);
  const mediaSourceId = record.mediaSourceId === null ? null : boundedString(record.mediaSourceId, 512);
  const mediaFields = [bindingSha256, mediaSha256, mediaByteSize, mediaMimeType, mediaContainer, mediaFileName, mediaSourceId];
  const hasMedia = mediaFields.every((item) => item !== null && item !== undefined);
  const noMedia = mediaFields.every((item) => item === null);
  if (
    bindingSha256 === undefined || approvedMediaSha256 === undefined || approvedMedia === undefined
    || mediaSha256 === undefined || mediaByteSize === undefined
    || mediaMimeType === undefined || mediaContainer === undefined || mediaFileName === undefined || mediaSourceId === undefined
    || (!hasMedia && !noMedia)
    || (hasMedia && (!(mediaByteSize as number) || mediaMimeType !== 'video/mp4' || mediaContainer !== 'mp4'))
    || (providerProofMode && (!approvedMedia || approvedMediaSha256 !== approvedMedia.sha256))
    || (providerProofMode && hasMedia && (
      approvedMedia!.sha256 !== mediaSha256 || approvedMedia!.byteSize !== mediaByteSize
      || approvedMedia!.mimeType !== mediaMimeType || approvedMedia!.container !== mediaContainer
    ))
    || providerResponseSha256 === undefined
    || providerStatusReceiptSha256 === undefined
  ) return { error: 'providerOperation contains malformed media or digest evidence' };

  const sessionCreatedAt = timestampOrNull(record.sessionCreatedAt);
  const uploadStartedAt = timestampOrNull(record.uploadStartedAt);
  const uploadCompletedAt = timestampOrNull(record.uploadCompletedAt);
  const lastReconciledAt = timestampOrNull(record.lastReconciledAt);
  const acceptedByteOffset = safeCount(record.acceptedByteOffset, Number.MAX_SAFE_INTEGER);
  const reconciliationAttemptCount = safeCount(record.reconciliationAttemptCount, 3);
  const reconciliationAttemptBudget = safeCount(record.reconciliationAttemptBudget, 3);
  const reconciliationFencingToken = safeCount(record.reconciliationFencingToken, Number.MAX_SAFE_INTEGER);
  const reconciliationLease = parseReconciliationLease(record.reconciliationLease, providerOperationId);
  const eventCount = safeCount(record.eventCount);
  const externalVideoId = record.externalVideoId === null ? null : boundedString(record.externalVideoId, 128);
  const lastOperationErrorCode = record.lastOperationErrorCode === null
    ? null
    : boundedString(record.lastOperationErrorCode, 120);
  if (
    sessionCreatedAt === undefined || uploadStartedAt === undefined || uploadCompletedAt === undefined
    || lastReconciledAt === undefined || acceptedByteOffset === undefined
    || reconciliationAttemptCount === undefined || reconciliationAttemptBudget === undefined
    || reconciliationAttemptBudget !== 3
    || reconciliationAttemptCount > reconciliationAttemptBudget
    || reconciliationFencingToken === undefined || reconciliationLease === undefined
    || (reconciliationLease !== null && reconciliationLease.fencingToken !== reconciliationFencingToken)
    || (hasMedia && (acceptedByteOffset as number) > (mediaByteSize as number))
    || eventCount === undefined || externalVideoId === undefined || lastOperationErrorCode === undefined
    || typeof record.eventDigestSha256 !== 'string' || !SHA256_PATTERN.test(record.eventDigestSha256)
  ) return { error: 'providerOperation contains malformed lifecycle evidence' };
  const mutationSummary = parseProviderMutationSummary(record.mutationSummary);
  if (!mutationSummary) return { error: 'providerOperation contains malformed mutation accounting' };
  let providerStatusReceipt: AutoPosterProviderStatusReceiptView | null = null;
  if (record.providerStatusReceipt !== null) {
    if (!hasMedia || typeof mediaSha256 !== 'string') return { error: 'providerOperation receipt has no media binding' };
    providerStatusReceipt = parseProviderReceipt(record.providerStatusReceipt, {
      queueId: post.id,
      providerOperationId,
      providerAttemptId,
      mediaSha256,
      approvedMedia: approvedMedia as AutoPosterApprovedMediaIdentity | null,
      providerProofMode,
      userId: post.userId,
      workspaceId: post.workspaceId,
      runtimeMissionId: post.runtimeMissionId,
      graphId: boundedString(record.graphId ?? '', 256) ?? '',
      accountId: post.accountId,
      connectedAccountId: post.connectedAccountId,
    }) ?? null;
    if (!providerStatusReceipt || !providerStatusReceiptSha256) {
      return { error: 'providerOperation contains an unsafe provider receipt' };
    }
    if (canonicalSha256(providerStatusReceipt) !== providerStatusReceiptSha256) {
      return { error: 'providerOperation receipt digest does not match the normalized receipt' };
    }
  } else if (providerStatusReceiptSha256 !== null) {
    return { error: 'providerOperation contains a receipt hash without a receipt' };
  }
  if (
    operationState === 'completed_private'
    && (!providerStatusReceipt
      || !providerStatusReceipt.artifactExists
      || !providerStatusReceipt.exactTitleMatch
      || providerStatusReceipt.privacyStatus !== 'private'
      || providerStatusReceipt.verifiedChannelId !== post.accountId
      || !completedPrivateStatusesAreCoherent(providerStatusReceipt))
  ) return { error: 'providerOperation private completion is not proven by its receipt' };
  if (
    operationState === 'contradictory_public'
    && (!providerStatusReceipt || !['public', 'unlisted'].includes(providerStatusReceipt.privacyStatus))
  ) return { error: 'providerOperation visibility contradiction is not proven by its receipt' };

  return {
    value: {
      schemaVersion: 'chanter.autoposter.youtube-provider-operation.v1',
      providerOperationId,
      providerAttemptId,
      provider: 'youtube',
      operationState: operationState as AutoPosterProviderOperationState,
      queueId: post.id,
      userId: post.userId,
      workspaceId: post.workspaceId,
      accountId: post.accountId,
      connectedAccountId: post.connectedAccountId,
      approvalActorId: boundedString(record.approvalActorId, 256) ?? '',
      approvalTimestamp,
      approvedAttemptNumber,
      runtimeMissionId: post.runtimeMissionId,
      graphId,
      runtimeAction: post.runtimeAction,
      runtimePayloadHash: post.runtimePayloadHash,
      approvedMediaSha256: approvedMediaSha256 as string | null,
      providerProofMode,
      approvedMedia: approvedMedia as AutoPosterApprovedMediaIdentity | null,
      bindingSha256: bindingSha256 as string | null,
      mediaSha256: mediaSha256 as string | null,
      mediaByteSize: mediaByteSize as number | null,
      mediaMimeType: mediaMimeType as string | null,
      mediaContainer: mediaContainer as string | null,
      mediaFileName: mediaFileName as string | null,
      mediaSourceId: mediaSourceId as string | null,
      sessionCreatedAt, uploadStartedAt, uploadCompletedAt,
      acceptedByteOffset,
      externalVideoId,
      providerResponseSha256,
      providerStatusReceiptSha256,
      providerStatusReceipt,
      mutationSummary,
      reconciliationAttemptCount,
      reconciliationAttemptBudget,
      reconciliationLease: reconciliationLease as AutoPosterReconciliationLeaseView | null,
      reconciliationFencingToken,
      lastReconciledAt,
      lastOperationErrorCode,
      eventCount,
      eventDigestSha256: record.eventDigestSha256,
    },
  };
}

/**
 * Closed-world validation of one AutoPoster post-status response against the
 * exact request identity. Every field the view carries is validated and
 * copied explicitly — nothing is spread through — so unknown response fields
 * can never reach a caller, and a contradiction fails typed instead of being
 * silently normalized.
 */
function parsePostStatusView(value: unknown, params: AutoPosterPostStatusParams): PostStatusParse {
  const post = nonArrayRecord(value);
  if (!post) return statusParseError('AutoPoster returned a status response without a post object.');

  const unsafeKey = findUnsafeStatusKey(post);
  if (unsafeKey) {
    return statusParseError(
      `AutoPoster returned a status response containing the unsafe field "${redactText(unsafeKey).slice(0, 40)}".`
    );
  }
  for (const key of Object.keys(post)) {
    if (!POST_STATUS_TOP_LEVEL_KEYS.has(key)) {
      return statusParseError(
        `AutoPoster returned a status response containing the unexpected field "${redactText(key).slice(0, 40)}".`
      );
    }
  }

  const id = boundedString(post.id, 256);
  if (!id || !id.trim() || id !== id.trim()) {
    return statusParseError('AutoPoster returned a status response without an exact post id.');
  }
  if (id !== params.postId) {
    return statusParseError(
      'AutoPoster returned status for a different post than the requested queue job id.',
      true
    );
  }

  const provider = post.provider;
  if (provider !== 'tiktok' && provider !== 'youtube') {
    return statusParseError('AutoPoster returned an unsupported or missing provider.');
  }
  const accountId = boundedString(post.accountId, 256);
  if (!accountId || !accountId.trim() || accountId !== accountId.trim()) {
    return statusParseError('AutoPoster returned a status response without an exact account id.');
  }
  if (params.accountId !== undefined && accountId !== params.accountId) {
    return statusParseError(
      'AutoPoster returned status for a different account than the requested scope.',
      true
    );
  }
  const connectedAccountId = boundedString(post.connectedAccountId, 512);
  if (connectedAccountId === undefined || connectedAccountId !== `${provider}:${accountId}`) {
    return statusParseError('AutoPoster returned a non-canonical connected-account identity.');
  }
  const workspaceId = boundedString(post.workspaceId, 160);
  if (workspaceId === undefined || workspaceId !== workspaceId.trim()) {
    return statusParseError('AutoPoster returned a malformed workspace identity.');
  }
  if (params.workspaceId !== undefined && workspaceId !== params.workspaceId) {
    return statusParseError(
      'AutoPoster returned status for a different workspace than the requested scope.',
      true
    );
  }

  const status = post.status;
  if (typeof status !== 'string' || !POST_STATUS_QUEUE_STATUSES.has(status as AutoPosterQueueStatus)) {
    return statusParseError('AutoPoster returned an unknown queue lifecycle status.');
  }

  const approved = post.approved;
  const approvalState = post.approvalState;
  const approvedAt = timestampOrNull(post.approvedAt ?? null);
  const approvedBy = boundedString(post.approvedBy ?? '', 200);
  if (
    typeof approved !== 'boolean'
    || (approvalState !== 'approved' && approvalState !== 'unapproved')
    || approvedAt === undefined
    || approvedBy === undefined
  ) {
    return statusParseError('AutoPoster returned malformed approval evidence.');
  }
  if (approved !== (approvalState === 'approved') || approved !== (approvedAt !== null)) {
    return statusParseError('AutoPoster returned contradictory approval evidence.');
  }
  if (status === 'processing' && !approved) {
    return statusParseError('AutoPoster returned a processing job without publish approval.');
  }

  const scheduledAt = timestampOrNull(post.scheduledAt ?? null);
  const createdAt = timestampOrNull(post.createdAt ?? null);
  const postedAt = timestampOrNull(post.postedAt ?? null);
  const lockedAt = timestampOrNull(post.lockedAt ?? null);
  if (
    scheduledAt === undefined
    || createdAt === undefined
    || postedAt === undefined
    || lockedAt === undefined
  ) {
    return statusParseError('AutoPoster returned a malformed lifecycle timestamp.');
  }
  const updatedAt = timestampOrNull(post.updatedAt ?? null);
  if (updatedAt === undefined || updatedAt === null) {
    return statusParseError('AutoPoster returned a status response without a valid source revision (updatedAt).');
  }

  const claimAttempts = post.claimAttempts;
  if (!Number.isSafeInteger(claimAttempts) || (claimAttempts as number) < 0 || (claimAttempts as number) > 1000) {
    return statusParseError('AutoPoster returned a malformed claim-attempt count.');
  }
  const publishAttemptBudget = post.publishAttemptBudget;
  const attemptBudgetExhausted = post.attemptBudgetExhausted;
  if (
    !Number.isSafeInteger(publishAttemptBudget)
    || (publishAttemptBudget as number) < 0
    || (publishAttemptBudget as number) > 1000
    || typeof attemptBudgetExhausted !== 'boolean'
    || attemptBudgetExhausted !== ((claimAttempts as number) >= (publishAttemptBudget as number))
  ) {
    return statusParseError('AutoPoster returned contradictory publish-attempt budget evidence.');
  }

  const publishId = boundedString(post.publishId ?? '', 500);
  const providerStatus = boundedString(post.providerStatus ?? '', 120);
  const mediaType = boundedString(post.mediaType ?? '', 40);
  const username = boundedString(post.username ?? '', 200);
  const captionSummary = boundedString(post.captionSummary ?? '', 200);
  const lastErrorMessage = boundedString(post.lastErrorMessage ?? '', 300);
  if (
    publishId === undefined
    || providerStatus === undefined
    || mediaType === undefined
    || username === undefined
    || captionSummary === undefined
    || lastErrorMessage === undefined
  ) {
    return statusParseError('AutoPoster returned a malformed status evidence field.');
  }

  const providerVerification = parseProviderVerification(
    post.providerVerification ?? null,
    provider,
    accountId,
    publishId
  );
  if ('error' in providerVerification) {
    return statusParseError(`AutoPoster returned unsafe provider verification evidence: ${providerVerification.error}.`);
  }

  const runtimeMissionId = boundedString(post.runtimeMissionId ?? '', 256);
  const runtimeIdempotencyKey = boundedString(post.runtimeIdempotencyKey ?? '', 256);
  const runtimeAction = boundedString(post.runtimeAction ?? '', 128);
  const runtimePayloadHash = boundedString(post.runtimePayloadHash ?? '', 64);
  if (
    runtimeMissionId === undefined
    || runtimeIdempotencyKey === undefined
    || runtimeAction === undefined
    || runtimePayloadHash === undefined
    || (runtimePayloadHash !== '' && !/^[0-9a-f]{64}$/.test(runtimePayloadHash))
  ) {
    return statusParseError('AutoPoster returned malformed Runtime mission correlation metadata.');
  }

  const lastResult = parseStatusLastResult(post.lastResult ?? null);
  if ('error' in lastResult) {
    return statusParseError(`AutoPoster returned unsafe lastResult evidence: ${lastResult.error}.`);
  }
  const history = parseStatusHistory(post.history ?? []);
  if ('error' in history) {
    return statusParseError(`AutoPoster returned unsafe history evidence: ${history.error}.`);
  }
  const providerOperation = parseProviderOperation(post.providerOperation ?? null, {
    id,
    userId: params.userId,
    provider,
    workspaceId,
    accountId,
    connectedAccountId,
    runtimeMissionId,
    runtimeAction,
    runtimePayloadHash,
  });
  if ('error' in providerOperation) {
    return statusParseError(`AutoPoster returned unsafe provider-operation evidence: ${providerOperation.error}.`);
  }
  const operation = providerOperation.value;
  if (provider === 'youtube' && operation) {
    const receipt = operation.providerStatusReceipt;
    if (operation.providerProofMode && (
      !operation.approvedMedia
      || !operation.graphId
      || !operation.workspaceId
      || !operation.runtimeMissionId
      || !operation.runtimePayloadHash
    )) return statusParseError('AutoPoster returned an incomplete provider-proof identity binding.');
    if (operation.operationState === 'completed_private') {
      if (
        status !== 'posted'
        || providerStatus !== 'uploaded_private'
        || !publishId
        || !receipt
        || receipt.externalVideoId !== publishId
        || operation.externalVideoId !== publishId
        || !providerVerification.value
        || providerVerification.value.externalVideoId !== publishId
        || providerVerification.value.channelId !== receipt.verifiedChannelId
        || providerVerification.value.title !== receipt.expectedTitle
        || !completedPrivateStatusesAreCoherent(receipt, providerVerification.value)
      ) return statusParseError('AutoPoster returned contradictory completed-private artifact identities.');
    }
    if (operation.operationState === 'contradictory_public' && (
      status === 'posted' || providerStatus === 'uploaded_private'
    )) return statusParseError('AutoPoster classified a visibility contradiction as success.');
    if (operation.operationState === 'provider_missing' && (
      status === 'posted' || providerStatus === 'uploaded_private' || Boolean(providerVerification.value)
    )) return statusParseError('AutoPoster returned positive artifact proof for a provider-missing operation.');
  }

  return {
    ok: true,
    view: {
      id,
      provider,
      connectedAccountId,
      accountId,
      username: redactText(username),
      workspaceId,
      status: status as AutoPosterQueueStatus,
      scheduledAt,
      approved,
      approvalState,
      approvedAt,
      approvedBy: redactText(approvedBy),
      mediaType,
      captionSummary: redactText(captionSummary),
      createdAt,
      updatedAt,
      postedAt,
      publishId,
      providerStatus,
      providerVerification: providerVerification.value,
      providerOperation: operation,
      lockedAt,
      claimAttempts: claimAttempts as number,
      publishAttemptBudget: publishAttemptBudget as number,
      attemptBudgetExhausted,
      runtimeMissionId,
      runtimeIdempotencyKey,
      runtimeAction,
      runtimePayloadHash,
      lastResult: lastResult.value,
      history: history.value,
      lastErrorMessage: redactText(lastErrorMessage),
    },
  };
}

/** Builds the real HTTP-backed operations port. Throws immediately on missing wiring — fail closed at construction. */
export function createAutoPosterHttpPort(options: AutoPosterHttpPortOptions): AutoPosterOperationsPort {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const serviceToken = options.serviceToken;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (!baseUrl) throw new Error('createAutoPosterHttpPort: baseUrl is required.');
  if (!serviceToken) throw new Error('createAutoPosterHttpPort: serviceToken is required.');
  if (typeof fetchImpl !== 'function') throw new Error('createAutoPosterHttpPort: no fetch implementation available.');

  async function call<TSuccess extends { ok: true }>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    correlationId?: string
  ): Promise<TSuccess | AutoPosterPortFailure> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const normalizedCorrelationId = correlationId?.trim();
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          [RUNTIME_CONTROL_TOKEN_HEADER]: serviceToken,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(normalizedCorrelationId ? { 'x-correlation-id': normalizedCorrelationId } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      // Timeout, DNS failure, connection refused — AutoPoster is unreachable.
      const reason = error instanceof Error && error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : 'is unreachable';
      return failure('unavailable', `AutoPoster ${reason} (${method} ${path}).`);
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failure(
        response.ok ? 'internal' : statusToErrorCode(response.status),
        `AutoPoster returned a non-JSON response (HTTP ${response.status}) for ${method} ${path}.`
      );
    }

    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return failure(
        response.ok ? 'internal' : statusToErrorCode(response.status),
        `AutoPoster returned a malformed JSON response (HTTP ${response.status}) for ${method} ${path}.`
      );
    }
    if (containsProtectedValue(payload, serviceToken)) {
      return failure(
        'internal',
        `AutoPoster returned a response containing protected credentials for ${method} ${path}.`
      );
    }

    const record = payload as Record<string, unknown>;
    if (!response.ok || record?.ok !== true) {
      if (containsForbiddenProviderMaterial(record, [serviceToken])) {
        const safeDetails = safeFailureDetails(record);
        const safeCode = isCommercialDenial(response.status, safeDetails)
          ? 'forbidden'
          : typeof record?.code === 'string' && isPortErrorCode(record.code)
            ? record.code
            : statusToErrorCode(response.status);
        return failure(safeCode, PROVIDER_DIAGNOSTIC_REDACTED_MESSAGE, safeDetails);
      }
      const reason =
        typeof record?.reason === 'string'
          ? record.reason
          : typeof record?.message === 'string'
            ? record.message
            : `HTTP ${response.status}`;
      const details = safeFailureDetails(record);
      const code = isCommercialDenial(response.status, details)
        ? 'forbidden'
        : typeof record?.code === 'string' && isPortErrorCode(record.code)
          ? record.code
          : statusToErrorCode(response.status);
      return failure(code, safeProviderFailureMessage(
        redactText(`AutoPoster refused ${method} ${path}: ${reason}`).slice(0, 500),
        [serviceToken]
      ), details);
    }
    return record as unknown as TSuccess;
  }

  return {
    listQueue(params: AutoPosterQueueListParams) {
      const query = new URLSearchParams();
      if (params.accountId) query.set('accountId', params.accountId);
      if (params.workspaceId) query.set('workspaceId', params.workspaceId);
      query.set('limit', String(params.limit));
      return call<AutoPosterQueueListSuccess>('GET', `/api/runtime/queue?${query.toString()}`);
    },
    async getPostStatus(params: AutoPosterPostStatusParams) {
      const query = new URLSearchParams();
      if (params.accountId) query.set('accountId', params.accountId);
      if (params.workspaceId) query.set('workspaceId', params.workspaceId);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      const result = await call<{ ok: true; post?: unknown }>(
        'GET',
        `/api/runtime/posts/${encodeURIComponent(params.postId)}/status${suffix}`
      );
      if (!result.ok) return result;

      const parsed = parsePostStatusView(result.post, params);
      if (!parsed.ok) {
        return failure('invalid_response', parsed.message, {
          reasonCode: parsed.identityMismatch
            ? 'status_identity_mismatch'
            : 'status_contract_violation',
        });
      }
      return { ok: true, post: parsed.view } satisfies AutoPosterPostStatusSuccess;
    },
    async reconcileProviderOperation(params: AutoPosterProviderReconciliationParams) {
      const result = await call<{ ok: true; classification?: unknown; post?: unknown }>(
        'POST',
        `/api/runtime/posts/${encodeURIComponent(params.postId)}/provider/reconcile`,
        {
          accountId: params.accountId,
          ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        }
      );
      if (!result.ok) return result;
      const resultRecord = result as unknown as Record<string, unknown>;
      if (
        !Object.keys(resultRecord).every((key) => ['ok', 'classification', 'post'].includes(key))
        || typeof result.classification !== 'string'
        || !PROVIDER_RECONCILIATION_CLASSIFICATIONS.has(
          result.classification as AutoPosterProviderReconciliationSuccess['classification']
        )
      ) {
        return failure('invalid_response', 'AutoPoster returned an invalid provider reconciliation envelope.');
      }
      const parsed = parsePostStatusView(result.post, params);
      if (!parsed.ok) {
        return failure('invalid_response', parsed.message, {
          reasonCode: parsed.identityMismatch
            ? 'status_identity_mismatch'
            : 'status_contract_violation',
        });
      }
      if (
        PROVIDER_OPERATION_STATES.has(result.classification as AutoPosterProviderOperationState)
        && parsed.view.providerOperation?.operationState !== result.classification
      ) {
        return failure('invalid_response', 'AutoPoster reconciliation classification contradicts the provider-operation state.', {
          reasonCode: 'status_contract_violation',
        });
      }
      return {
        ok: true,
        classification: result.classification as AutoPosterProviderReconciliationSuccess['classification'],
        post: parsed.view,
      } satisfies AutoPosterProviderReconciliationSuccess;
    },
    validateMedia(params: AutoPosterMediaValidationParams) {
      return call<AutoPosterMediaValidationSuccess>('POST', '/api/runtime/media/validate', { ...params });
    },
    schedulePost(params: AutoPosterScheduleParams) {
      return call<AutoPosterScheduleSuccess>('POST', '/api/runtime/schedule', {
        accountId: params.accountId,
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        ...(params.provider ? { provider: params.provider } : {}),
        mediaUrl: params.mediaUrl,
        caption: params.caption,
        hashtags: params.hashtags,
        ...(params.title ? { title: params.title } : {}),
        ...(params.description ? { description: params.description } : {}),
        scheduledAt: params.scheduledAt,
        idempotencyKey: params.idempotencyKey,
        requestedBy: params.requestedBy,
        missionId: params.missionId,
        action: params.action,
        missionPayloadHash: params.missionPayloadHash,
        ...(params.graphId ? { graphId: params.graphId } : {}),
        ...(params.providerProofMode ? {
          providerProofMode: true,
          approvedMedia: params.approvedMedia,
        } : {}),
      }, params.traceId);
    },
    async reconcileSchedule(params: AutoPosterScheduleReconciliationParams) {
      const result = await call<AutoPosterScheduleReconciliationSuccess>(
        'POST',
        '/api/runtime/schedule/reconcile',
        {
          workspaceId: params.workspaceId,
          accountId: params.accountId,
          provider: params.provider,
          scheduledAt: params.scheduledAt,
          idempotencyKey: params.idempotencyKey,
          missionId: params.missionId,
          action: params.action,
          missionPayloadHash: params.missionPayloadHash,
        },
        params.traceId
      );
      if (!result.ok) return result;

      const validCommon = Number.isInteger(result.count)
        && result.count >= 0
        && typeof result.unique === 'boolean'
        && typeof result.safeToReuse === 'boolean'
        && ['not_started', 'required', 'approved', 'unknown'].includes(result.approvalState)
        && [
          'not_started',
          'blocked_until_human_approval',
          'processing',
          'posted',
          'failed',
          'unknown',
        ].includes(result.publishingState)
        && [
          'not_found',
          'authoritative',
          'conflict',
          'invalid',
          'scope_mismatch',
          'idempotency_mismatch',
          'payload_mismatch',
        ].includes(result.evidenceStatus);
      if (!validCommon) {
        return failure('internal', 'AutoPoster returned an invalid reconciliation response.');
      }

      if (result.outcome === 'not_found') {
        if (result.count !== 0 || !result.unique || result.safeToReuse || result.post) {
          return failure('internal', 'AutoPoster returned contradictory not-found reconciliation truth.');
        }
        return result;
      }
      if (result.outcome === 'conflict') {
        const ids = result.conflictingPostIds;
        if (
          result.count < 2
          || result.unique
          || result.safeToReuse
          || result.post
          || !Array.isArray(ids)
          || ids.length !== result.count
          || ids.some((id) => typeof id !== 'string' || !id || id !== id.trim())
        ) {
          return failure('internal', 'AutoPoster returned contradictory conflict reconciliation truth.');
        }
        return result;
      }
      if (
        result.outcome === 'scope_mismatch'
        || result.outcome === 'idempotency_mismatch'
        || result.outcome === 'payload_mismatch'
      ) {
        if (result.count < 1 || result.safeToReuse || result.post) {
          return failure('internal', 'AutoPoster returned contradictory mismatch reconciliation truth.');
        }
        return result;
      }
      if (result.outcome !== 'unique' || result.count !== 1 || !result.unique) {
        return failure('internal', 'AutoPoster returned an unknown reconciliation outcome.');
      }
      if (!result.safeToReuse) {
        if (result.post) {
          return failure('internal', 'AutoPoster exposed queue evidence it marked unsafe to reuse.');
        }
        return result;
      }
      const post = result.post;
      const postId = typeof post?.id === 'string' ? post.id : '';
      const scheduledAt = typeof post?.scheduledAt === 'string' ? post.scheduledAt : '';
      if (
        !post
        || !postId
        || postId !== postId.trim()
        || post.accountId !== params.accountId
        || post.provider !== params.provider
        || post.status !== 'scheduled'
        || post.approved !== false
        || !scheduledAt
        || scheduledAt !== params.scheduledAt
      ) {
        return failure('internal', 'AutoPoster returned unsafe recovered queue evidence.');
      }
      return result;
    },
    async listConnectedAccounts(params: AutoPosterConnectedAccountListParams) {
      const query = new URLSearchParams();
      if (params.workspaceId) query.set('workspaceId', params.workspaceId);
      if (params.provider) query.set('provider', params.provider);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      const result = await call<{
        ok: true;
        workspaceId?: unknown;
        count?: unknown;
        accounts?: unknown;
      }>('GET', `/api/runtime/connected-accounts${suffix}`);
      if (!result.ok) return result;

      const workspaceId = exactWorkspaceId(result.workspaceId);
      if (
        !workspaceId
        || (params.workspaceId !== undefined && workspaceId !== params.workspaceId)
        || !Array.isArray(result.accounts)
      ) {
        return failure('internal', 'AutoPoster returned a malformed connected-account list response.');
      }
      const accounts = result.accounts.map(connectedAccountView);
      if (
        accounts.some((account) => account === undefined)
        || !Number.isInteger(result.count)
        || result.count !== accounts.length
      ) {
        return failure('internal', 'AutoPoster returned an unsafe connected-account list response.');
      }
      return {
        ok: true,
        workspaceId,
        count: accounts.length,
        accounts: accounts as AutoPosterConnectedAccountView[],
      } satisfies AutoPosterConnectedAccountListSuccess;
    },
    async validateConnectedAccount(params: AutoPosterConnectedAccountValidationParams) {
      const result = await call<{
        ok: true;
        workspaceId?: unknown;
        account?: unknown;
      }>('POST', '/api/runtime/connected-accounts/validate', {
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        provider: params.provider,
        accountId: params.accountId,
      });
      if (!result.ok) return result;

      const workspaceId = exactWorkspaceId(result.workspaceId);
      const account = connectedAccountView(result.account);
      if (
        !workspaceId
        || (params.workspaceId !== undefined && workspaceId !== params.workspaceId)
        || !account
      ) {
        return failure('internal', 'AutoPoster returned an unsafe connected-account validation response.');
      }
      if (account.provider !== params.provider || account.accountId !== params.accountId) {
        return failure(
          'internal',
          'AutoPoster validation did not confirm the exact requested provider and account id.'
        );
      }
      if (
        account.connectionStatus !== 'connected'
        || account.publishingReady !== true
        || account.readinessBlockers.length > 0
      ) {
        return failure(
          'internal',
          'AutoPoster validation returned an account that is not publishing-ready.'
        );
      }
      return { ok: true, workspaceId, account } satisfies AutoPosterConnectedAccountValidationSuccess;
    },
  };
}

function isPortErrorCode(value: string): value is AutoPosterPortErrorCode {
  return ['unauthorized', 'forbidden', 'not_found', 'validation_failed', 'unavailable', 'internal'].includes(value);
}
