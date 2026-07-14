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
  AutoPosterPostStatusParams,
  AutoPosterPostStatusSuccess,
  AutoPosterQueueListParams,
  AutoPosterQueueListSuccess,
  AutoPosterScheduleParams,
  AutoPosterScheduleReconciliationParams,
  AutoPosterScheduleReconciliationSuccess,
  AutoPosterScheduleSuccess,
} from './autoPosterMissionAdapter.js';
import { redactText } from '../redaction.js';

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
      return failure(code, redactText(`AutoPoster refused ${method} ${path}: ${reason}`).slice(0, 500), details);
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
    getPostStatus(params: AutoPosterPostStatusParams) {
      const query = new URLSearchParams();
      if (params.accountId) query.set('accountId', params.accountId);
      if (params.workspaceId) query.set('workspaceId', params.workspaceId);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return call<AutoPosterPostStatusSuccess>(
        'GET',
        `/api/runtime/posts/${encodeURIComponent(params.postId)}/status${suffix}`
      );
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
