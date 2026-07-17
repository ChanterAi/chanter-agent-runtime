/**
 * CHANTER Agent Runtime — AutoPoster mission adapter (P1B activation).
 *
 * Executes the four canonical AutoPoster control actions through an injected
 * AutoPosterOperationsPort. The port is the only thing that talks to
 * AutoPoster (see autoPosterHttpPort.ts for the real HTTP implementation);
 * AutoPoster's own routes/storage/mediaPolicy stay the business-logic
 * authority — this adapter validates mission input, maps it onto port
 * operations, and reports the downstream outcome truthfully. It never
 * publishes: `autoposter.post.schedule` only creates a queue item that
 * AutoPoster's existing human approval gate must still release.
 *
 * Canonical actions:
 *   autoposter.queue.list        read   — bounded queue listing
 *   autoposter.post.get_status   read   — one post's normalized status
 *   autoposter.media.validate    read   — video-only TikTok media policy check
 *   autoposter.post.schedule     write  — approval-gated, idempotent scheduling
 */
import type { JsonValue } from '../types.js';
import type {
  RuntimeMissionActionSpec,
  RuntimeMissionAdapter,
  RuntimeMissionAdapterOutcome,
  RuntimeMissionError,
  RuntimeMissionRequest,
} from '../missions.js';
import { createRuntimeMissionPayloadHash } from '../missions.js';

// ---------------------------------------------------------------------------
// Operations port contract
// ---------------------------------------------------------------------------

/**
 * Stable downstream error taxonomy every port implementation must map into.
 * 'invalid_response' is minted only by the Runtime itself when AutoPoster's
 * response contradicts the request identity or the closed-world status
 * contract — it is never adopted from a downstream body.
 */
export type AutoPosterPortErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'unavailable'
  | 'invalid_response'
  | 'internal';

/**
 * Safe, stable connected-account refusals emitted by AutoPoster. The HTTP
 * port preserves these as `reasonCode`; the mission adapter maps them onto
 * exact Runtime error codes without trusting arbitrary downstream strings.
 */
export type AutoPosterConnectedAccountReasonCode =
  | 'unknown_account_id'
  | 'account_id_case_mismatch'
  | 'account_id_non_canonical'
  | 'account_workspace_mismatch'
  | 'provider_account_mismatch'
  | 'account_disconnected'
  | 'account_not_publishing_ready';

/**
 * Safe server-authoritative refusal facts returned by AutoPoster. The shape
 * is a strict allowlist for commercial and connected-account decisions.
 */
export interface AutoPosterCommercialDenialDetails {
  reasonCode?: string;
  current?: number | null;
  limit?: number | null;
  remaining?: number | null;
  planId?: string;
  workspaceId?: string;
  evaluationTimestamp?: string;
  accountId?: string;
  provider?: string;
  requestedProvider?: string;
  accountProvider?: string;
  blockers?: string[];
}

export interface AutoPosterPortFailure {
  ok: false;
  code: AutoPosterPortErrorCode;
  message: string;
  /** Stable downstream domain code, when one survived the safe allowlist. */
  reasonCode?: string;
  /** Allowlisted refusal facts, when AutoPoster supplied them. */
  details?: AutoPosterCommercialDenialDetails;
}

/**
 * Safe connected-account projection. Deliberately excludes owner ids,
 * tokens, authorization scopes, provider payloads, and internal config.
 */
export interface AutoPosterConnectedAccountView {
  provider: string;
  providerDisplayName: string;
  /** Exact canonical opaque provider id. Never case-normalized or trimmed. */
  accountId: string;
  /** Canonical provider/account composite (`provider:accountId`). */
  connectedAccountId: string;
  username: string;
  displayName: string;
  connectionStatus: 'connected' | 'reauthorization_required' | 'disconnected';
  publishingReady: boolean;
  readinessBlockers: string[];
  lastVerifiedAt: string | null;
}

export interface AutoPosterConnectedAccountListParams {
  userId: string;
  workspaceId?: string;
  provider?: string;
}

export interface AutoPosterConnectedAccountListSuccess {
  ok: true;
  workspaceId: string;
  count: number;
  accounts: AutoPosterConnectedAccountView[];
}

export interface AutoPosterConnectedAccountValidationParams {
  userId: string;
  workspaceId?: string;
  provider: string;
  /** Exact selected canonical id. Never case-normalized or trimmed. */
  accountId: string;
}

export interface AutoPosterConnectedAccountValidationSuccess {
  ok: true;
  workspaceId: string;
  account: AutoPosterConnectedAccountView;
}

/** Safe, normalized queue item view — never tokens, credentials, or raw provider payloads. */
export interface AutoPosterQueueItemView {
  id: string;
  accountId: string;
  username: string;
  status: string;
  scheduledAt: string | null;
  approved: boolean;
  mediaType: string;
  captionSummary: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AutoPosterQueueListSuccess {
  ok: true;
  items: AutoPosterQueueItemView[];
  count: number;
  scope: { accountId: string | 'all' };
}

/** Canonical AutoPoster queue lifecycle statuses (closed world; 'ready' is a legacy-but-accepted state). */
export type AutoPosterQueueStatus =
  | 'pending'
  | 'scheduled'
  | 'processing'
  | 'ready'
  | 'posted'
  | 'failed'
  | 'outcome_unknown';

/**
 * Bounded, sanitized subset of a job's lastResult. Exactly these keys are
 * permitted — a provider response object, attempt payloads, or any other
 * field fails the closed-world status parse.
 */
export interface AutoPosterPostStatusLastResultView {
  mode?: string;
  code?: string;
  message?: string;
  completedAt?: string;
  willRetry?: boolean;
  outcomeUnknown?: boolean;
}

/** One capped, scrubbed canonical evidence entry ({ at, event, detail } only). */
export interface AutoPosterPostStatusHistoryEntryView {
  at: string | null;
  event: string;
  detail: string;
}

/**
 * Phase 2E-B strict post-status projection. Built exclusively by the
 * closed-world parser in autoPosterHttpPort.ts: identity fields are byte
 * exact, lifecycle evidence is bounded and allowlisted, and nothing outside
 * this shape (raw provider payloads, lock ownership, media, captions,
 * tokens) can pass through.
 */
export interface AutoPosterPostStatusView {
  id: string;
  provider: 'tiktok' | 'youtube';
  connectedAccountId: string;
  accountId: string;
  username: string;
  workspaceId: string;
  status: AutoPosterQueueStatus;
  scheduledAt: string | null;
  approved: boolean;
  approvalState: 'approved' | 'unapproved';
  approvedAt: string | null;
  approvedBy: string;
  mediaType: string;
  captionSummary: string;
  createdAt: string | null;
  updatedAt: string;
  postedAt: string | null;
  publishId: string;
  providerStatus: string;
  lockedAt: string | null;
  claimAttempts: number;
  runtimeMissionId: string;
  runtimeIdempotencyKey: string;
  runtimeAction: string;
  runtimePayloadHash: string;
  lastResult: AutoPosterPostStatusLastResultView | null;
  history: AutoPosterPostStatusHistoryEntryView[];
  lastErrorMessage: string;
}

export interface AutoPosterPostStatusSuccess {
  ok: true;
  post: AutoPosterPostStatusView;
}

export interface AutoPosterMediaValidationSuccess {
  ok: true;
  valid: boolean;
  classification: 'video' | 'rejected';
  rejectionCode?: string;
  reason?: string;
  policy: { videoOnly: boolean; allowedExtensions: string[] };
}

export interface AutoPosterScheduleSuccess {
  ok: true;
  duplicate: boolean;
  post: {
    id: string;
    accountId: string;
    provider?: string;
    status: string;
    scheduledAt: string | null;
    approved: boolean;
  };
}

export type AutoPosterScheduleReconciliationOutcome =
  | 'not_found'
  | 'unique'
  | 'conflict'
  | 'scope_mismatch'
  | 'idempotency_mismatch'
  | 'payload_mismatch';

export interface AutoPosterScheduleReconciliationSuccess {
  ok: true;
  outcome: AutoPosterScheduleReconciliationOutcome;
  count: number;
  unique: boolean;
  safeToReuse: boolean;
  approvalState: 'not_started' | 'required' | 'approved' | 'unknown';
  publishingState:
    | 'not_started'
    | 'blocked_until_human_approval'
    | 'processing'
    | 'posted'
    | 'failed'
    | 'unknown';
  evidenceStatus:
    | 'not_found'
    | 'authoritative'
    | 'conflict'
    | 'invalid'
    | 'scope_mismatch'
    | 'idempotency_mismatch'
    | 'payload_mismatch';
  post?: AutoPosterScheduleSuccess['post'];
  conflictingPostIds?: string[];
}

export interface AutoPosterQueueListParams {
  userId: string;
  workspaceId?: string;
  accountId?: string;
  limit: number;
}

export interface AutoPosterPostStatusParams {
  userId: string;
  workspaceId?: string;
  postId: string;
  accountId?: string;
}

export interface AutoPosterMediaValidationParams {
  fileName?: string;
  mimeType?: string;
  mediaUrl?: string;
}

export interface AutoPosterScheduleParams {
  userId: string;
  workspaceId?: string;
  accountId: string;
  /**
   * Optional publishing provider ('tiktok' | 'youtube'). Omitted means
   * TikTok (full backward compatibility). AutoPoster's application service
   * stays the authority on provider validity, account readiness, and
   * provider metadata rules.
   */
  provider?: string;
  mediaUrl: string;
  caption: string;
  hashtags: string;
  /** YouTube-only metadata: required title and optional description. */
  title?: string;
  description?: string;
  scheduledAt: string;
  /** Mission correlation id forwarded to AutoPoster without changing scheduling semantics. */
  traceId?: string;
  idempotencyKey: string;
  requestedBy: string;
  missionId?: string;
  action?: typeof AUTOPOSTER_ACTIONS.postSchedule;
  missionPayloadHash?: string;
}

export interface AutoPosterScheduleReconciliationParams {
  userId: string;
  workspaceId: string;
  accountId: string;
  provider: 'tiktok' | 'youtube';
  scheduledAt: string;
  idempotencyKey: string;
  missionId: string;
  action: typeof AUTOPOSTER_ACTIONS.postSchedule;
  missionPayloadHash: string;
  traceId?: string;
}

/**
 * The boundary the adapter executes through. Implementations must enforce
 * nothing themselves — AutoPoster's server enforces tenant/ownership/media
 * policy — but must map every downstream refusal or failure truthfully.
 */
export interface AutoPosterOperationsPort {
  listQueue(params: AutoPosterQueueListParams): Promise<AutoPosterQueueListSuccess | AutoPosterPortFailure>;
  getPostStatus(params: AutoPosterPostStatusParams): Promise<AutoPosterPostStatusSuccess | AutoPosterPortFailure>;
  validateMedia(
    params: AutoPosterMediaValidationParams
  ): Promise<AutoPosterMediaValidationSuccess | AutoPosterPortFailure>;
  schedulePost(params: AutoPosterScheduleParams): Promise<AutoPosterScheduleSuccess | AutoPosterPortFailure>;
  /** Exact, read-only durable lookup used after an uncertain schedule boundary. */
  reconcileSchedule?(
    params: AutoPosterScheduleReconciliationParams
  ): Promise<AutoPosterScheduleReconciliationSuccess | AutoPosterPortFailure>;
  /** Additive preflight capability; optional for legacy read/schedule-only ports. */
  listConnectedAccounts?(
    params: AutoPosterConnectedAccountListParams
  ): Promise<AutoPosterConnectedAccountListSuccess | AutoPosterPortFailure>;
  /** Additive preflight capability; optional for legacy read/schedule-only ports. */
  validateConnectedAccount?(
    params: AutoPosterConnectedAccountValidationParams
  ): Promise<AutoPosterConnectedAccountValidationSuccess | AutoPosterPortFailure>;
}

// ---------------------------------------------------------------------------
// Action specs
// ---------------------------------------------------------------------------

export const AUTOPOSTER_ACTIONS = {
  queueList: 'autoposter.queue.list',
  postGetStatus: 'autoposter.post.get_status',
  mediaValidate: 'autoposter.media.validate',
  postSchedule: 'autoposter.post.schedule',
} as const;

const QUEUE_LIST_MAX_LIMIT = 100;
const QUEUE_LIST_DEFAULT_LIMIT = 25;

function canonicalScheduleProviderScope(value: JsonValue | undefined): string {
  return value === undefined ? 'tiktok' : typeof value === 'string' ? value : '';
}

function validateScheduleIdempotencyScope(request: RuntimeMissionRequest): RuntimeMissionError[] {
  const errors: RuntimeMissionError[] = [];
  if (request.action !== AUTOPOSTER_ACTIONS.postSchedule) {
    errors.push({
      code: 'ACTION_SCOPE_MISMATCH',
      message: `Replay scope requires the exact action "${AUTOPOSTER_ACTIONS.postSchedule}".`,
    });
  }

  const workspaceId = request.tenant.workspaceId;
  if (
    workspaceId !== undefined
    && (typeof workspaceId !== 'string' || !workspaceId || workspaceId !== workspaceId.trim())
  ) {
    errors.push({
      code: 'WORKSPACE_SCOPE_MISMATCH',
      message: 'tenant.workspaceId must be a nonblank canonical workspace id with no surrounding whitespace.',
    });
  }

  const provider = request.input.provider;
  if (provider !== undefined && provider !== 'tiktok' && provider !== 'youtube') {
    errors.push({
      code: 'PROVIDER_SCOPE_MISMATCH',
      message: 'input.provider must be the exact canonical provider id "tiktok" or "youtube".',
    });
  }

  const inputAccountId = typeof request.input.accountId === 'string' ? request.input.accountId : '';
  const tenantAccountId = typeof request.tenant.accountId === 'string' ? request.tenant.accountId : '';
  if (!inputAccountId.trim() || !tenantAccountId.trim()) {
    errors.push({
      code: 'MISSING_ACCOUNT_ID',
      message: 'Both input.accountId and tenant.accountId are required and must be nonblank for scheduling.',
    });
  } else if (
    inputAccountId !== tenantAccountId
    || inputAccountId !== inputAccountId.trim()
    || tenantAccountId !== tenantAccountId.trim()
  ) {
    errors.push({
      code: 'ACCOUNT_SCOPE_MISMATCH',
      message: 'input.accountId and tenant.accountId must be the same exact canonical opaque account id.',
    });
  }
  return errors;
}

const ACTION_SPECS: RuntimeMissionActionSpec[] = [
  {
    action: AUTOPOSTER_ACTIONS.queueList,
    description: 'List AutoPoster queue items visible to the tenant/account scope (bounded).',
    policyActionType: 'read',
    riskLevel: 'low',
    executionPolicy: 'local_only',
    requiresIdempotencyKey: false,
  },
  {
    action: AUTOPOSTER_ACTIONS.postGetStatus,
    description: 'Read the normalized queue/publishing status of one AutoPoster post.',
    policyActionType: 'read',
    riskLevel: 'low',
    executionPolicy: 'local_only',
    requiresIdempotencyKey: false,
  },
  {
    action: AUTOPOSTER_ACTIONS.mediaValidate,
    description: 'Validate media against the real AutoPoster video-only TikTok policy.',
    policyActionType: 'read',
    riskLevel: 'low',
    executionPolicy: 'local_only',
    requiresIdempotencyKey: false,
  },
  {
    action: AUTOPOSTER_ACTIONS.postSchedule,
    description:
      'Schedule one video into the AutoPoster queue (creates an unapproved queue item only; never publishes).',
    policyActionType: 'write',
    riskLevel: 'high',
    executionPolicy: 'requires_approval',
    requiresIdempotencyKey: true,
    validateIdempotencyScope: validateScheduleIdempotencyScope,
    resolveIdempotencyScope: (request) => `provider:${canonicalScheduleProviderScope(request.input.provider)}`,
    resolveReplayProvider: (request) => canonicalScheduleProviderScope(request.input.provider),
    downstreamOperationType: 'autoposter.queue.create_unapproved_draft',
  },
];

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function asTrimmedString(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function validationFailure(errors: RuntimeMissionError[]): RuntimeMissionAdapterOutcome {
  return { ok: false, status: 'validation_failed', errors };
}

const ACCOUNT_REASON_TO_RUNTIME_ERROR: Readonly<Record<string, string>> = {
  unknown_account_id: 'AUTOPOSTER_UNKNOWN_ACCOUNT_ID',
  account_id_case_mismatch: 'AUTOPOSTER_ACCOUNT_ID_CASE_MISMATCH',
  account_id_non_canonical: 'AUTOPOSTER_ACCOUNT_ID_NON_CANONICAL',
  account_workspace_mismatch: 'AUTOPOSTER_ACCOUNT_WORKSPACE_MISMATCH',
  provider_account_mismatch: 'AUTOPOSTER_PROVIDER_ACCOUNT_MISMATCH',
  account_disconnected: 'AUTOPOSTER_ACCOUNT_DISCONNECTED',
  account_not_publishing_ready: 'AUTOPOSTER_ACCOUNT_NOT_PUBLISHING_READY',
};

function portFailureOutcome(action: string, failure: AutoPosterPortFailure): RuntimeMissionAdapterOutcome {
  const status: RuntimeMissionAdapterOutcome['status'] =
    failure.code === 'unavailable'
      ? 'unavailable'
      : failure.code === 'validation_failed'
        ? 'validation_failed'
        : failure.code === 'unauthorized' || failure.code === 'forbidden'
          ? 'denied'
          : 'failed';
  return {
    ok: false,
    status,
    ...(failure.details ? { output: { ...failure.details } as JsonValue } : {}),
    errors: [{
      code:
        (failure.reasonCode && ACCOUNT_REASON_TO_RUNTIME_ERROR[failure.reasonCode])
        || (failure.details?.reasonCode && ACCOUNT_REASON_TO_RUNTIME_ERROR[failure.details.reasonCode])
        || `AUTOPOSTER_${failure.code.toUpperCase()}`,
      message: failure.message,
    }],
    evidence: [
      {
        type: 'note',
        label: `autoposter-${failure.code}`,
        detail: `${action} failed downstream: ${failure.message}`,
      },
    ],
  };
}

function invalidScheduleResponseOutcome(
  code: 'AUTOPOSTER_INVALID_SCHEDULE_RESPONSE' | 'AUTOPOSTER_UNSAFE_SCHEDULE_RESPONSE',
  message: string
): RuntimeMissionAdapterOutcome {
  return {
    ok: false,
    status: 'failed',
    errors: [{ code, message }],
    evidence: [
      {
        type: 'note',
        label: 'autoposter-schedule-response-rejected',
        detail: `${message} The runtime did not accept the operation as a successful queue draft.`,
      },
    ],
  };
}

/**
 * `scheduledAt` must be ISO-8601 with an explicit timezone (Z or ±HH:MM) so
 * normalization to UTC is deterministic regardless of the host's local zone.
 */
const ISO_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function normalizeScheduledAt(value: string, now: Date = new Date()): { iso: string } | { error: RuntimeMissionError } {
  if (!ISO_WITH_ZONE_PATTERN.test(value)) {
    return {
      error: {
        code: 'INVALID_SCHEDULED_AT',
        message:
          'scheduledAt must be an ISO-8601 timestamp with an explicit timezone, e.g. 2026-07-11T09:00:00Z or 2026-07-11T12:00:00+03:00.',
      },
    };
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return { error: { code: 'INVALID_SCHEDULED_AT', message: 'scheduledAt is not a parseable timestamp.' } };
  }
  if (parsed <= now.getTime()) {
    return {
      error: {
        code: 'PAST_SCHEDULED_AT',
        message: 'scheduledAt must be in the future; past or current times cannot be scheduled.',
      },
    };
  }
  return { iso: new Date(parsed).toISOString() };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const AUTOPOSTER_MISSION_ADAPTER_ID = 'autoposter-mission-adapter';

/**
 * Builds the AutoPoster mission adapter around an injected operations port.
 * Pure wiring: no I/O happens here beyond calling the port.
 */
export function createAutoPosterMissionAdapter(port: AutoPosterOperationsPort): RuntimeMissionAdapter {
  async function executeQueueList(request: RuntimeMissionRequest): Promise<RuntimeMissionAdapterOutcome> {
    const accountId = asTrimmedString(request.input.accountId) || request.tenant.accountId?.trim() || '';
    const workspaceId = request.tenant.workspaceId?.trim() || '';
    const rawLimit = request.input.limit;
    let limit = QUEUE_LIST_DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) {
        return validationFailure([
          { code: 'INVALID_LIMIT', message: `limit must be an integer between 1 and ${QUEUE_LIST_MAX_LIMIT}.` },
        ]);
      }
      limit = Math.min(rawLimit, QUEUE_LIST_MAX_LIMIT);
    }

    const result = await port.listQueue({
      userId: request.tenant.userId,
      ...(workspaceId ? { workspaceId } : {}),
      ...(accountId ? { accountId } : {}),
      limit,
    });
    if (!result.ok) return portFailureOutcome(AUTOPOSTER_ACTIONS.queueList, result);

    return {
      ok: true,
      output: {
        items: result.items as unknown as JsonValue,
        count: result.count,
        scope: { accountId: result.scope.accountId },
        empty: result.count === 0,
      },
      evidence: [
        {
          type: 'note',
          label: 'autoposter-queue-list',
          detail: `Returned ${result.count} queue item(s) for account scope "${result.scope.accountId}".`,
        },
      ],
    };
  }

  async function executePostGetStatus(request: RuntimeMissionRequest): Promise<RuntimeMissionAdapterOutcome> {
    const postId = asTrimmedString(request.input.postId);
    if (!postId) {
      return validationFailure([{ code: 'MISSING_POST_ID', message: 'postId is required.' }]);
    }
    const accountId = asTrimmedString(request.input.accountId) || request.tenant.accountId?.trim() || '';
    const workspaceId = request.tenant.workspaceId?.trim() || '';

    const result = await port.getPostStatus({
      userId: request.tenant.userId,
      ...(workspaceId ? { workspaceId } : {}),
      postId,
      ...(accountId ? { accountId } : {}),
    });
    if (!result.ok) return portFailureOutcome(AUTOPOSTER_ACTIONS.postGetStatus, result);

    return {
      ok: true,
      output: { post: result.post as unknown as JsonValue },
      evidence: [
        {
          type: 'note',
          label: 'autoposter-post-status',
          detail: `Post ${result.post.id} status="${result.post.status}" approved=${result.post.approved}.`,
        },
      ],
    };
  }

  async function executeMediaValidate(request: RuntimeMissionRequest): Promise<RuntimeMissionAdapterOutcome> {
    const fileName = asTrimmedString(request.input.fileName);
    const mimeType = asTrimmedString(request.input.mimeType);
    const mediaUrl = asTrimmedString(request.input.mediaUrl);
    if (!mediaUrl && !fileName && !mimeType) {
      return validationFailure([
        {
          code: 'MISSING_MEDIA_INPUT',
          message: 'Provide mediaUrl, or fileName/mimeType, to validate media.',
        },
      ]);
    }

    const result = await port.validateMedia({
      ...(fileName ? { fileName } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(mediaUrl ? { mediaUrl } : {}),
    });
    if (!result.ok) return portFailureOutcome(AUTOPOSTER_ACTIONS.mediaValidate, result);

    return {
      ok: true,
      output: {
        valid: result.valid,
        classification: result.classification,
        ...(result.rejectionCode !== undefined ? { rejectionCode: result.rejectionCode } : {}),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        policy: {
          videoOnly: result.policy.videoOnly,
          allowedExtensions: result.policy.allowedExtensions,
        },
      },
      evidence: [
        {
          type: 'note',
          label: 'autoposter-media-validation',
          detail: result.valid
            ? 'Media accepted by the AutoPoster video-only policy.'
            : `Media rejected by the AutoPoster video-only policy: ${result.rejectionCode ?? 'rejected'}.`,
        },
      ],
    };
  }

  async function executePostSchedule(request: RuntimeMissionRequest): Promise<RuntimeMissionAdapterOutcome> {
    const errors = validateScheduleIdempotencyScope(request);
    const tenantAccountId = typeof request.tenant.accountId === 'string' ? request.tenant.accountId : '';
    // Preserve the selected opaque id byte-for-byte. Whitespace/case
    // normalization here could silently redirect a mission to another id.
    const accountId = tenantAccountId;
    const workspaceId = typeof request.tenant.workspaceId === 'string' ? request.tenant.workspaceId : '';
    const mediaUrl = asTrimmedString(request.input.mediaUrl);
    const scheduledAtRaw = asTrimmedString(request.input.scheduledAt);
    const caption = asTrimmedString(request.input.caption);
    const hashtags = asTrimmedString(request.input.hashtags);
    // Optional provider selection (Part 3: YouTube). AutoPoster remains the
    // authority; this only rejects the one KNOWN-missing field early so a
    // mission gets a precise error instead of a downstream refusal.
    const provider = typeof request.input.provider === 'string' ? request.input.provider : '';
    const title = asTrimmedString(request.input.title);
    const description = asTrimmedString(request.input.description);

    if (!mediaUrl) errors.push({ code: 'MISSING_MEDIA_URL', message: 'mediaUrl is required for scheduling.' });
    if (provider === 'youtube' && !title) {
      errors.push({ code: 'MISSING_YOUTUBE_TITLE', message: 'title is required when provider is youtube.' });
    }
    if (!scheduledAtRaw) {
      errors.push({ code: 'MISSING_SCHEDULED_AT', message: 'scheduledAt is required for scheduling.' });
    }
    let scheduledAtIso = '';
    if (scheduledAtRaw) {
      const normalized = normalizeScheduledAt(scheduledAtRaw);
      if ('error' in normalized) {
        errors.push(normalized.error);
      } else {
        scheduledAtIso = normalized.iso;
      }
    }
    if (errors.length > 0) return validationFailure(errors);

    const result = await port.schedulePost({
      userId: request.tenant.userId,
      ...(workspaceId ? { workspaceId } : {}),
      accountId,
      ...(provider ? { provider } : {}),
      mediaUrl,
      caption,
      hashtags,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      scheduledAt: scheduledAtIso,
      traceId: request.traceId?.trim() || request.missionId,
      // executeMission guarantees this is present for requiresIdempotencyKey actions.
      idempotencyKey: request.idempotencyKey!,
      requestedBy: request.actor.id,
      missionId: request.missionId,
      action: AUTOPOSTER_ACTIONS.postSchedule,
      missionPayloadHash: createRuntimeMissionPayloadHash(request),
    });
    if (!result.ok) return portFailureOutcome(AUTOPOSTER_ACTIONS.postSchedule, result);
    if (typeof result.duplicate !== 'boolean') {
      return invalidScheduleResponseOutcome(
        'AUTOPOSTER_INVALID_SCHEDULE_RESPONSE',
        'AutoPoster returned a schedule response without a valid duplicate flag.'
      );
    }

    const post = result.post as AutoPosterScheduleSuccess['post'] | undefined;
    const postId = typeof post?.id === 'string' ? post.id : '';
    if (!post || !postId || postId !== postId.trim()) {
      return invalidScheduleResponseOutcome(
        'AUTOPOSTER_INVALID_SCHEDULE_RESPONSE',
        'AutoPoster returned a schedule response without an exact canonical post.id.'
      );
    }
    if (post.approved !== false) {
      return invalidScheduleResponseOutcome(
        'AUTOPOSTER_UNSAFE_SCHEDULE_RESPONSE',
        'AutoPoster did not confirm that the scheduled queue draft is unapproved.'
      );
    }
    const postAccountId = typeof post.accountId === 'string' ? post.accountId : '';
    const expectedProvider = provider || 'tiktok';
    const postProvider = typeof post.provider === 'string'
      ? post.provider
      : provider
        ? ''
        : 'tiktok';
    const postStatus = typeof post.status === 'string' ? post.status : '';
    const postScheduledAt = typeof post.scheduledAt === 'string' ? post.scheduledAt : '';
    if (
      postAccountId !== accountId ||
      postProvider !== expectedProvider ||
      postStatus !== 'scheduled' ||
      !postScheduledAt ||
      postScheduledAt !== scheduledAtIso
    ) {
      return invalidScheduleResponseOutcome(
        'AUTOPOSTER_UNSAFE_SCHEDULE_RESPONSE',
        'AutoPoster did not confirm the requested provider, account, and scheduled draft state.'
      );
    }

    return {
      ok: true,
      ...(result.duplicate ? { status: 'duplicate' as const } : {}),
      output: {
        duplicate: result.duplicate,
        post: {
          id: postId,
          accountId: postAccountId,
          provider: postProvider,
          status: postStatus,
          scheduledAt: postScheduledAt,
          approved: post.approved,
        },
        publishing: 'blocked_until_human_approval',
      },
      warnings: result.duplicate
        ? ['Idempotency key already had a queue item; the existing item was returned and no new item was created.']
        : [],
      evidence: [
        {
          type: 'note',
          label: result.duplicate ? 'autoposter-schedule-duplicate' : 'autoposter-schedule-created',
          detail: result.duplicate
            ? `Existing queue item ${postId} returned for the supplied idempotency key; no duplicate was created.`
            : `Queue item ${postId} created for account ${postAccountId}, scheduled for ${postScheduledAt}; publishing remains blocked until human approval in AutoPoster.`,
        },
      ],
    };
  }

  return {
    id: AUTOPOSTER_MISSION_ADAPTER_ID,
    product: 'auto_poster',
    version: '1.0.0',
    actions: ACTION_SPECS,
    async execute(request, spec) {
      switch (spec.action) {
        case AUTOPOSTER_ACTIONS.queueList:
          return executeQueueList(request);
        case AUTOPOSTER_ACTIONS.postGetStatus:
          return executePostGetStatus(request);
        case AUTOPOSTER_ACTIONS.mediaValidate:
          return executeMediaValidate(request);
        case AUTOPOSTER_ACTIONS.postSchedule:
          return executePostSchedule(request);
        default:
          return {
            ok: false,
            status: 'denied',
            errors: [
              {
                code: 'UNSUPPORTED_ACTION',
                message: `Adapter ${AUTOPOSTER_MISSION_ADAPTER_ID} cannot execute "${spec.action}".`,
              },
            ],
          };
      }
    },
  };
}
