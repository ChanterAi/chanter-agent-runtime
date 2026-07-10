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

// ---------------------------------------------------------------------------
// Operations port contract
// ---------------------------------------------------------------------------

/** Stable downstream error taxonomy every port implementation must map into. */
export type AutoPosterPortErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'unavailable'
  | 'internal';

export interface AutoPosterPortFailure {
  ok: false;
  code: AutoPosterPortErrorCode;
  message: string;
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

export interface AutoPosterPostStatusView extends AutoPosterQueueItemView {
  approvedAt: string | null;
  approvedBy: string;
  postedAt: string | null;
  publishId: string;
  claimAttempts: number;
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
    status: string;
    scheduledAt: string | null;
    approved: boolean;
  };
}

export interface AutoPosterQueueListParams {
  userId: string;
  accountId?: string;
  limit: number;
}

export interface AutoPosterPostStatusParams {
  userId: string;
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
  accountId: string;
  mediaUrl: string;
  caption: string;
  hashtags: string;
  scheduledAt: string;
  idempotencyKey: string;
  requestedBy: string;
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
    errors: [{ code: `AUTOPOSTER_${failure.code.toUpperCase()}`, message: failure.message }],
    evidence: [
      {
        type: 'note',
        label: `autoposter-${failure.code}`,
        detail: `${action} failed downstream: ${failure.message}`,
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

    const result = await port.getPostStatus({
      userId: request.tenant.userId,
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
    const errors: RuntimeMissionError[] = [];
    const accountId = asTrimmedString(request.input.accountId) || request.tenant.accountId?.trim() || '';
    const mediaUrl = asTrimmedString(request.input.mediaUrl);
    const scheduledAtRaw = asTrimmedString(request.input.scheduledAt);
    const caption = asTrimmedString(request.input.caption);
    const hashtags = asTrimmedString(request.input.hashtags);

    if (!accountId) errors.push({ code: 'MISSING_ACCOUNT_ID', message: 'accountId is required for scheduling.' });
    if (!mediaUrl) errors.push({ code: 'MISSING_MEDIA_URL', message: 'mediaUrl is required for scheduling.' });
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
      accountId,
      mediaUrl,
      caption,
      hashtags,
      scheduledAt: scheduledAtIso,
      // executeMission guarantees this is present for requiresIdempotencyKey actions.
      idempotencyKey: request.idempotencyKey!.trim(),
      requestedBy: request.actor.id,
    });
    if (!result.ok) return portFailureOutcome(AUTOPOSTER_ACTIONS.postSchedule, result);

    return {
      ok: true,
      ...(result.duplicate ? { status: 'duplicate' as const } : {}),
      output: {
        duplicate: result.duplicate,
        post: {
          id: result.post.id,
          accountId: result.post.accountId,
          status: result.post.status,
          scheduledAt: result.post.scheduledAt,
          approved: result.post.approved,
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
            ? `Existing queue item ${result.post.id} returned for the supplied idempotency key; no duplicate was created.`
            : `Queue item ${result.post.id} created for account ${result.post.accountId}, scheduled for ${result.post.scheduledAt}; publishing remains blocked until human approval in AutoPoster.`,
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
