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
  AutoPosterMediaValidationParams,
  AutoPosterMediaValidationSuccess,
  AutoPosterOperationsPort,
  AutoPosterPortErrorCode,
  AutoPosterPortFailure,
  AutoPosterPostStatusParams,
  AutoPosterPostStatusSuccess,
  AutoPosterQueueListParams,
  AutoPosterQueueListSuccess,
  AutoPosterScheduleParams,
  AutoPosterScheduleSuccess,
} from './autoPosterMissionAdapter.js';

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

function failure(code: AutoPosterPortErrorCode, message: string): AutoPosterPortFailure {
  return { ok: false, code, message };
}

function statusToErrorCode(status: number): AutoPosterPortErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 409 || status === 422) return 'validation_failed';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  return 'internal';
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
    body?: Record<string, unknown>
  ): Promise<TSuccess | AutoPosterPortFailure> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          [RUNTIME_CONTROL_TOKEN_HEADER]: serviceToken,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
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

    const record = payload as Record<string, unknown>;
    if (!response.ok || record?.ok !== true) {
      const reason =
        typeof record?.reason === 'string'
          ? record.reason
          : typeof record?.message === 'string'
            ? record.message
            : `HTTP ${response.status}`;
      const code =
        typeof record?.code === 'string' && isPortErrorCode(record.code)
          ? record.code
          : statusToErrorCode(response.status);
      return failure(code, `AutoPoster refused ${method} ${path}: ${reason}`);
    }
    return record as unknown as TSuccess;
  }

  return {
    listQueue(params: AutoPosterQueueListParams) {
      const query = new URLSearchParams();
      if (params.accountId) query.set('accountId', params.accountId);
      query.set('limit', String(params.limit));
      return call<AutoPosterQueueListSuccess>('GET', `/api/runtime/queue?${query.toString()}`);
    },
    getPostStatus(params: AutoPosterPostStatusParams) {
      const query = new URLSearchParams();
      if (params.accountId) query.set('accountId', params.accountId);
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
        ...(params.provider ? { provider: params.provider } : {}),
        mediaUrl: params.mediaUrl,
        caption: params.caption,
        hashtags: params.hashtags,
        ...(params.title ? { title: params.title } : {}),
        ...(params.description ? { description: params.description } : {}),
        scheduledAt: params.scheduledAt,
        idempotencyKey: params.idempotencyKey,
        requestedBy: params.requestedBy,
      });
    },
  };
}

function isPortErrorCode(value: string): value is AutoPosterPortErrorCode {
  return ['unauthorized', 'forbidden', 'not_found', 'validation_failed', 'unavailable', 'internal'].includes(value);
}
