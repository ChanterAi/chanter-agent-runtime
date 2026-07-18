/**
 * AutoPoster mission adapter tests: action declarations, input validation,
 * port mapping, truthful downstream failure propagation, and the
 * schedule-only (never publish) guarantee.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTOPOSTER_ACTIONS,
  createAutoPosterMissionAdapter,
  normalizeScheduledAt,
  type AutoPosterOperationsPort,
  type AutoPosterPortFailure,
} from '../../src/adapters/autoPosterMissionAdapter.js';
import {
  createInMemoryIdempotencyStore,
  createMissionAdapterRegistry,
  executeMission,
  type RuntimeMissionRequest,
} from '../../src/missions.js';

interface PortCallLog {
  listQueue: unknown[];
  getPostStatus: unknown[];
  validateMedia: unknown[];
  schedulePost: unknown[];
}

function makeFakePort(overrides: Partial<AutoPosterOperationsPort> = {}): {
  port: AutoPosterOperationsPort;
  calls: PortCallLog;
} {
  const calls: PortCallLog = { listQueue: [], getPostStatus: [], validateMedia: [], schedulePost: [] };
  const port: AutoPosterOperationsPort = {
    async listQueue(params) {
      calls.listQueue.push(params);
      return {
        ok: true,
        items: [
          {
            id: 'post-1',
            accountId: 'account-a',
            username: 'creator_a',
            status: 'scheduled',
            scheduledAt: '2026-07-11T09:00:00.000Z',
            approved: false,
            mediaType: 'video',
            captionSummary: 'First drop',
            createdAt: '2026-07-10T08:00:00.000Z',
            updatedAt: '2026-07-10T08:00:00.000Z',
          },
        ],
        count: 1,
        scope: { accountId: params.accountId ?? 'all' },
      };
    },
    async getPostStatus(params) {
      calls.getPostStatus.push(params);
      return {
        ok: true,
        post: {
          id: params.postId,
          provider: 'tiktok',
          connectedAccountId: 'tiktok:account-a',
          accountId: 'account-a',
          username: 'creator_a',
          workspaceId: params.workspaceId ?? '',
          status: 'scheduled',
          scheduledAt: '2026-07-11T09:00:00.000Z',
          approved: false,
          approvalState: 'unapproved',
          approvedAt: null,
          approvedBy: '',
          mediaType: 'video',
          captionSummary: 'First drop',
          createdAt: '2026-07-10T08:00:00.000Z',
          updatedAt: '2026-07-10T08:00:00.000Z',
          postedAt: null,
          publishId: '',
          providerStatus: '',
          providerVerification: null,
          lockedAt: null,
          claimAttempts: 0,
          publishAttemptBudget: 5,
          attemptBudgetExhausted: false,
          runtimeMissionId: '',
          runtimeIdempotencyKey: '',
          runtimeAction: '',
          runtimePayloadHash: '',
          lastResult: null,
          history: [],
          lastErrorMessage: '',
        },
      };
    },
    async validateMedia(params) {
      calls.validateMedia.push(params);
      return {
        ok: true,
        valid: true,
        classification: 'video',
        policy: { videoOnly: true, allowedExtensions: ['.mp4', '.mov', '.webm'] },
      };
    },
    async schedulePost(params) {
      calls.schedulePost.push(params);
      return {
        ok: true,
        duplicate: false,
        post: {
          id: 'post-new',
          accountId: params.accountId,
          provider: params.provider ?? 'tiktok',
          status: 'scheduled',
          scheduledAt: params.scheduledAt,
          approved: false,
        },
      };
    },
    ...overrides,
  };
  return { port, calls };
}

function futureIso(minutesAhead = 60): string {
  return new Date(Date.now() + minutesAhead * 60_000).toISOString();
}

function makeRequest(overrides: Partial<RuntimeMissionRequest> = {}): RuntimeMissionRequest {
  return {
    missionId: 'mission-ap-1',
    product: 'auto_poster',
    action: AUTOPOSTER_ACTIONS.queueList,
    actor: { id: 'mcp-client', kind: 'agent' },
    tenant: { userId: 'owner' },
    input: {},
    ...overrides,
  };
}

async function run(portOverrides: Partial<AutoPosterOperationsPort>, requestOverrides: Partial<RuntimeMissionRequest>) {
  const { port, calls } = makeFakePort(portOverrides);
  const adapter = createAutoPosterMissionAdapter(port);
  const registry = createMissionAdapterRegistry([adapter]);
  const result = await executeMission(makeRequest(requestOverrides), {
    registry,
    idempotencyStore: createInMemoryIdempotencyStore(),
  });
  return { result, calls };
}

describe('autoposter.queue.list', () => {
  it('succeeds with an authorized account scope and bounded limit', async () => {
    const { result, calls } = await run({}, { input: { accountId: 'account-a', limit: 10 } });
    assert.equal(result.status, 'succeeded');
    assert.equal(calls.listQueue.length, 1);
    assert.deepEqual(calls.listQueue[0], { userId: 'owner', accountId: 'account-a', limit: 10 });
    const output = result.output as { count: number; empty: boolean; scope: { accountId: string } };
    assert.equal(output.count, 1);
    assert.equal(output.empty, false);
    assert.equal(output.scope.accountId, 'account-a');
  });

  it('passes the optional tenant workspace scope to the port', async () => {
    const { result, calls } = await run(
      {},
      {
        tenant: { userId: 'owner', workspaceId: 'workspace-a' },
        input: { accountId: 'account-a', limit: 10 },
      }
    );
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(calls.listQueue[0], {
      userId: 'owner',
      workspaceId: 'workspace-a',
      accountId: 'account-a',
      limit: 10,
    });
  });

  it('returns a truthful empty result distinct from failure', async () => {
    const { result } = await run(
      {
        async listQueue(params) {
          return { ok: true, items: [], count: 0, scope: { accountId: params.accountId ?? 'all' } };
        },
      },
      { input: {} }
    );
    assert.equal(result.status, 'succeeded');
    const output = result.output as { count: number; empty: boolean };
    assert.equal(output.count, 0);
    assert.equal(output.empty, true);
  });

  it('downstream failure is a failed result, never an empty success', async () => {
    const { result } = await run(
      {
        async listQueue() {
          return { ok: false, code: 'internal', message: 'Firestore read failed.' } as AutoPosterPortFailure;
        },
      },
      { input: {} }
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.errors[0]!.code, 'AUTOPOSTER_INTERNAL');
    assert.equal(result.output, null);
  });

  it('an unreachable AutoPoster maps to unavailable', async () => {
    const { result } = await run(
      {
        async listQueue() {
          return { ok: false, code: 'unavailable', message: 'AutoPoster is unreachable.' } as AutoPosterPortFailure;
        },
      },
      { input: {} }
    );
    assert.equal(result.status, 'unavailable');
  });

  it('rejects a non-integer limit', async () => {
    const { result, calls } = await run({}, { input: { limit: 2.5 } });
    assert.equal(result.status, 'validation_failed');
    assert.equal(calls.listQueue.length, 0);
  });
});

describe('autoposter.post.get_status', () => {
  it('requires postId', async () => {
    const { result, calls } = await run({}, { action: AUTOPOSTER_ACTIONS.postGetStatus, input: {} });
    assert.equal(result.status, 'validation_failed');
    assert.equal(result.errors[0]!.code, 'MISSING_POST_ID');
    assert.equal(calls.getPostStatus.length, 0);
  });

  it('missing post surfaces the structured not_found error', async () => {
    const { result } = await run(
      {
        async getPostStatus() {
          return { ok: false, code: 'not_found', message: 'Post not found.' } as AutoPosterPortFailure;
        },
      },
      { action: AUTOPOSTER_ACTIONS.postGetStatus, input: { postId: 'nope' } }
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.errors[0]!.code, 'AUTOPOSTER_NOT_FOUND');
  });

  it('ownership scope is preserved into the port call', async () => {
    const { result, calls } = await run(
      {},
      {
        action: AUTOPOSTER_ACTIONS.postGetStatus,
        tenant: { userId: 'owner', accountId: 'account-a' },
        input: { postId: 'post-1' },
      }
    );
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(calls.getPostStatus[0], { userId: 'owner', postId: 'post-1', accountId: 'account-a' });
  });

  it('passes workspace and account scopes together', async () => {
    const { result, calls } = await run(
      {},
      {
        action: AUTOPOSTER_ACTIONS.postGetStatus,
        tenant: { userId: 'owner', workspaceId: 'workspace-a', accountId: 'account-a' },
        input: { postId: 'post-1' },
      }
    );
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(calls.getPostStatus[0], {
      userId: 'owner',
      workspaceId: 'workspace-a',
      postId: 'post-1',
      accountId: 'account-a',
    });
  });
});

describe('autoposter.media.validate', () => {
  it('accepts a supported video result from the real policy', async () => {
    const { result } = await run({}, { action: AUTOPOSTER_ACTIONS.mediaValidate, input: { mediaUrl: 'https://cdn.example.com/a.mp4' } });
    assert.equal(result.status, 'succeeded');
    const output = result.output as { valid: boolean; classification: string };
    assert.equal(output.valid, true);
    assert.equal(output.classification, 'video');
  });

  it('propagates a rejection (invalid media) as a succeeded validation with valid=false', async () => {
    const { result } = await run(
      {
        async validateMedia() {
          return {
            ok: true,
            valid: false,
            classification: 'rejected',
            rejectionCode: 'image_mime',
            reason: 'TikTok posting is video-only.',
            policy: { videoOnly: true, allowedExtensions: ['.mp4', '.mov', '.webm'] },
          };
        },
      },
      { action: AUTOPOSTER_ACTIONS.mediaValidate, input: { fileName: 'photo.jpg', mimeType: 'image/jpeg' } }
    );
    assert.equal(result.status, 'succeeded');
    const output = result.output as { valid: boolean; rejectionCode: string };
    assert.equal(output.valid, false);
    assert.equal(output.rejectionCode, 'image_mime');
  });

  it('fails closed when no media input is supplied', async () => {
    const { result, calls } = await run({}, { action: AUTOPOSTER_ACTIONS.mediaValidate, input: {} });
    assert.equal(result.status, 'validation_failed');
    assert.equal(calls.validateMedia.length, 0);
  });
});

describe('autoposter.post.schedule', () => {
  const approvedSchedule = (input: Record<string, unknown>, extra: Partial<RuntimeMissionRequest> = {}) => {
    const inputAccountId = typeof input.accountId === 'string' ? input.accountId : undefined;
    return ({
      action: AUTOPOSTER_ACTIONS.postSchedule,
      idempotencyKey: 'idem-1',
      approval: { approved: true, approvedBy: 'founder' },
      tenant: { userId: 'owner', ...(inputAccountId !== undefined ? { accountId: inputAccountId } : {}) },
      input: input as RuntimeMissionRequest['input'],
      ...extra,
    }) satisfies Partial<RuntimeMissionRequest>;
  };

  it('valid approved scheduling calls the port exactly once with normalized UTC time', async () => {
    const scheduledAt = futureIso();
    const { result, calls } = await run(
      {},
      approvedSchedule(
        { accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt, caption: 'Launch' },
        { traceId: ' trace-ap-1 ' }
      )
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(calls.schedulePost.length, 1);
    const params = calls.schedulePost[0] as {
      scheduledAt: string;
      traceId: string;
      idempotencyKey: string;
      requestedBy: string;
    };
    assert.equal(params.scheduledAt, new Date(scheduledAt).toISOString());
    assert.equal(params.traceId, 'trace-ap-1');
    assert.equal(params.idempotencyKey, 'idem-1');
    assert.equal(params.requestedBy, 'mcp-client');
    const output = result.output as { post: { id: string }; publishing: string; duplicate: boolean };
    assert.equal(output.post.id, 'post-new');
    assert.equal(output.duplicate, false);
    assert.equal(output.publishing, 'blocked_until_human_approval');
  });

  it('a YouTube mission passes provider, title, and description through to the port', async () => {
    const scheduledAt = futureIso();
    const { result, calls } = await run(
      {},
      approvedSchedule({
        provider: 'youtube',
        accountId: 'UC-chanter',
        mediaUrl: 'https://cdn.example.com/a.mp4',
        scheduledAt,
        title: 'Private launch teaser',
        description: 'Supervised test upload',
      })
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(calls.schedulePost.length, 1);
    const params = calls.schedulePost[0] as { provider?: string; title?: string; description?: string };
    assert.equal(params.provider, 'youtube');
    assert.equal(params.title, 'Private launch teaser');
    assert.equal(params.description, 'Supervised test upload');
  });

  it('a YouTube mission without a title fails before the port is called', async () => {
    const { result, calls } = await run(
      {},
      approvedSchedule({
        provider: 'youtube',
        accountId: 'UC-chanter',
        mediaUrl: 'https://cdn.example.com/a.mp4',
        scheduledAt: futureIso(),
      })
    );
    assert.equal(result.status, 'validation_failed');
    assert.equal(result.errors[0]!.code, 'MISSING_YOUTUBE_TITLE');
    assert.equal(calls.schedulePost.length, 0);
  });

  it('a TikTok mission (no provider) sends no provider or YouTube fields downstream', async () => {
    const { result, calls } = await run(
      {},
      approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() })
    );
    assert.equal(result.status, 'succeeded');
    const params = calls.schedulePost[0] as Record<string, unknown>;
    assert.equal('provider' in params, false);
    assert.equal('title' in params, false);
    assert.equal('description' in params, false);
    assert.equal('workspaceId' in params, false, 'legacy missions remain workspace-optional');
    assert.equal(params.traceId, 'mission-ap-1', 'traceId defaults to missionId when omitted');
  });

  it('uses only the tenant workspace and ignores caller-supplied plan/workspace claims', async () => {
    const { result, calls } = await run(
      {},
      approvedSchedule(
        {
          accountId: 'account-a',
          mediaUrl: 'https://cdn.example.com/a.mp4',
          scheduledAt: futureIso(),
          workspaceId: 'untrusted-input-workspace',
          planId: 'studio',
          remaining: 999999,
        },
        { tenant: { userId: 'owner', workspaceId: 'workspace-a', accountId: 'account-a' } }
      )
    );
    assert.equal(result.status, 'succeeded');
    const params = calls.schedulePost[0] as Record<string, unknown>;
    assert.equal(params.workspaceId, 'workspace-a');
    assert.equal('planId' in params, false);
    assert.equal('remaining' in params, false);
  });

  it('rejects an input account that differs byte-for-byte from the canonical tenant account', async () => {
    const { result, calls } = await run(
      {},
      approvedSchedule(
        {
          accountId: 'casesensitive-openid',
          mediaUrl: 'https://cdn.example.com/a.mp4',
          scheduledAt: futureIso(),
        },
        { tenant: { userId: 'owner', workspaceId: 'workspace-a', accountId: 'CaseSensitive-OpenId' } }
      )
    );
    assert.equal(result.status, 'validation_failed');
    assert.equal(result.errors[0]!.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal(calls.schedulePost.length, 0);
  });

  it('rejects a missing tenant account before the operations port is called', async () => {
    const { result, calls } = await run(
      {},
      approvedSchedule(
        { accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() },
        { tenant: { userId: 'owner', workspaceId: 'workspace-a' } }
      )
    );
    assert.equal(result.status, 'validation_failed');
    assert.equal(result.errors[0]!.code, 'MISSING_ACCOUNT_ID');
    assert.equal(calls.schedulePost.length, 0);
  });

  it('rejects a missing input account before the operations port is called', async () => {
    const { result, calls } = await run(
      {},
      approvedSchedule(
        { mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() },
        { tenant: { userId: 'owner', workspaceId: 'workspace-a', accountId: 'account-a' } }
      )
    );
    assert.equal(result.status, 'validation_failed');
    assert.equal(result.errors[0]!.code, 'MISSING_ACCOUNT_ID');
    assert.equal(calls.schedulePost.length, 0);
  });

  it('isolates one caller key and raw account id across canonical provider scopes', async () => {
    const { port, calls } = makeFakePort();
    const registry = createMissionAdapterRegistry([createAutoPosterMissionAdapter(port)]);
    const idempotencyStore = createInMemoryIdempotencyStore();
    const scheduledAt = futureIso();

    const tiktok = await executeMission(
      makeRequest(
        approvedSchedule(
          { accountId: 'shared-channel-id', mediaUrl: 'https://cdn.example.com/tiktok.mp4', scheduledAt },
          { missionId: 'mission-tiktok' }
        )
      ),
      { registry, idempotencyStore }
    );
    const youtube = await executeMission(
      makeRequest(
        approvedSchedule(
          {
            provider: 'youtube',
            accountId: 'shared-channel-id',
            mediaUrl: 'https://cdn.example.com/youtube.mp4',
            scheduledAt,
            title: 'Provider-scoped launch',
          },
          { missionId: 'mission-youtube' }
        )
      ),
      { registry, idempotencyStore }
    );
    const exactTiktokReplay = await executeMission(
      makeRequest(
        approvedSchedule(
          {
            accountId: 'shared-channel-id',
            mediaUrl: 'https://cdn.example.com/tiktok.mp4',
            scheduledAt,
          },
          { missionId: 'mission-tiktok' }
        )
      ),
      { registry, idempotencyStore }
    );

    assert.equal(tiktok.status, 'succeeded');
    assert.equal(youtube.status, 'succeeded');
    assert.equal(exactTiktokReplay.status, 'duplicate');
    assert.equal(tiktok.idempotency.outcome, 'first_execution');
    assert.equal(youtube.idempotency.outcome, 'first_execution');
    assert.equal(exactTiktokReplay.idempotency.originalMissionId, 'mission-tiktok');
    assert.equal((tiktok.output as { post: { provider: string } }).post.provider, 'tiktok');
    assert.equal((youtube.output as { post: { provider: string } }).post.provider, 'youtube');
    assert.equal(calls.schedulePost.length, 2);
    assert.equal('provider' in (calls.schedulePost[0] as Record<string, unknown>), false);
    assert.equal((calls.schedulePost[1] as { provider: string }).provider, 'youtube');
  });

  it('validates the exact replay scope before reusing a canonical schedule result', async () => {
    const { port, calls } = makeFakePort();
    const registry = createMissionAdapterRegistry([createAutoPosterMissionAdapter(port)]);
    const idempotencyStore = createInMemoryIdempotencyStore();
    const scheduledAt = futureIso();
    const accountId = 'CaseSensitive-OpenId';
    const baseInput = {
      provider: 'tiktok',
      accountId,
      mediaUrl: 'https://cdn.example.com/canonical.mp4',
      scheduledAt,
    };
    const baseTenant = { userId: 'owner', workspaceId: 'workspace-a', accountId };
    const execute = (missionId: string, input: Record<string, unknown>, tenant = baseTenant) => executeMission(
      makeRequest(approvedSchedule(input, {
        missionId,
        idempotencyKey: 'exact-replay-scope',
        tenant,
      })),
      { registry, idempotencyStore }
    );

    const first = await execute('mission-canonical', baseInput);
    const exactReplay = await execute('mission-canonical', baseInput);

    assert.equal(first.status, 'succeeded');
    assert.equal(exactReplay.status, 'duplicate');
    assert.equal(exactReplay.idempotency.originalMissionId, 'mission-canonical');
    assert.equal((exactReplay.output as { post: { id: string } }).post.id, 'post-new');
    assert.equal(calls.schedulePost.length, 1);

    const malformedCases: Array<{
      label: string;
      input: Record<string, unknown>;
      tenant?: typeof baseTenant;
      expectedCode: string;
    }> = [
      {
        label: 'account-case',
        input: { ...baseInput, accountId: 'casesensitive-openid' },
        expectedCode: 'ACCOUNT_SCOPE_MISMATCH',
      },
      {
        label: 'account-leading-whitespace',
        input: { ...baseInput, accountId: ` ${accountId}` },
        expectedCode: 'ACCOUNT_SCOPE_MISMATCH',
      },
      {
        label: 'account-trailing-whitespace',
        input: { ...baseInput, accountId: `${accountId} ` },
        expectedCode: 'ACCOUNT_SCOPE_MISMATCH',
      },
      {
        label: 'account-value',
        input: { ...baseInput, accountId: 'Different-OpenId' },
        expectedCode: 'ACCOUNT_SCOPE_MISMATCH',
      },
      {
        label: 'workspace-whitespace',
        input: baseInput,
        tenant: { ...baseTenant, workspaceId: ' workspace-a ' },
        expectedCode: 'WORKSPACE_SCOPE_MISMATCH',
      },
      {
        label: 'provider-case',
        input: { ...baseInput, provider: 'TikTok' },
        expectedCode: 'PROVIDER_SCOPE_MISMATCH',
      },
      {
        label: 'provider-whitespace',
        input: { ...baseInput, provider: ' tiktok ' },
        expectedCode: 'PROVIDER_SCOPE_MISMATCH',
      },
    ];

    for (const malformed of malformedCases) {
      const result = await execute(
        `mission-malformed-${malformed.label}`,
        malformed.input,
        malformed.tenant ?? baseTenant
      );
      assert.equal(result.status, 'validation_failed', malformed.label);
      assert.equal(result.errors[0]!.code, malformed.expectedCode, malformed.label);
      assert.equal(result.output, null, malformed.label);
      assert.equal(result.evidence, null, malformed.label);
    }
    assert.equal(calls.schedulePost.length, 1, 'malformed replays never reach AutoPoster or reuse cached evidence');
  });

  it('missing approval never reaches the port', async () => {
    const { result, calls } = await run(
      {},
      {
        action: AUTOPOSTER_ACTIONS.postSchedule,
        idempotencyKey: 'idem-2',
        tenant: { userId: 'owner', accountId: 'account-a' },
        input: { accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() },
      }
    );
    assert.equal(result.status, 'approval_required');
    assert.equal(calls.schedulePost.length, 0);
  });

  it('a duplicate reported downstream maps to a duplicate result without a second item', async () => {
    const { result } = await run(
      {
        async schedulePost(params) {
          return {
            ok: true,
            duplicate: true,
            post: { id: 'post-existing', accountId: params.accountId, status: 'scheduled', scheduledAt: params.scheduledAt, approved: false },
          };
        },
      },
      approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() })
    );
    assert.equal(result.status, 'duplicate');
    assert.equal(result.idempotency.outcome, 'duplicate');
    const output = result.output as { duplicate: boolean; post: { id: string } };
    assert.equal(output.duplicate, true);
    assert.equal(output.post.id, 'post-existing');
  });

  it('an invalid timestamp fails clearly before the port is called', async () => {
    const { result, calls } = await run(
      {},
      approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: 'tomorrow at nine' })
    );
    assert.equal(result.status, 'validation_failed');
    assert.equal(result.errors[0]!.code, 'INVALID_SCHEDULED_AT');
    assert.equal(calls.schedulePost.length, 0);
  });

  it('a timestamp without an explicit timezone fails (deterministic normalization)', async () => {
    const { result } = await run(
      {},
      approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: '2026-07-11T09:00:00' })
    );
    assert.equal(result.status, 'validation_failed');
    assert.equal(result.errors[0]!.code, 'INVALID_SCHEDULED_AT');
  });

  it('a past timestamp fails clearly', async () => {
    const { result, calls } = await run(
      {},
      approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: '2020-01-01T00:00:00Z' })
    );
    assert.equal(result.status, 'validation_failed');
    assert.equal(result.errors[0]!.code, 'PAST_SCHEDULED_AT');
    assert.equal(calls.schedulePost.length, 0);
  });

  it('an unauthorized account scope from downstream maps to denied', async () => {
    const { result } = await run(
      {
        async schedulePost() {
          return { ok: false, code: 'forbidden', message: 'Account is not owned by this tenant.' } as AutoPosterPortFailure;
        },
      },
      approvedSchedule({ accountId: 'account-x', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() })
    );
    assert.equal(result.status, 'denied');
    assert.equal(result.errors[0]!.code, 'AUTOPOSTER_FORBIDDEN');
  });

  it('maps allowlisted downstream account reason codes onto exact Runtime errors', async () => {
    const cases = [
      ['unknown_account_id', 'AUTOPOSTER_UNKNOWN_ACCOUNT_ID'],
      ['account_id_case_mismatch', 'AUTOPOSTER_ACCOUNT_ID_CASE_MISMATCH'],
      ['account_id_non_canonical', 'AUTOPOSTER_ACCOUNT_ID_NON_CANONICAL'],
      ['account_workspace_mismatch', 'AUTOPOSTER_ACCOUNT_WORKSPACE_MISMATCH'],
      ['provider_account_mismatch', 'AUTOPOSTER_PROVIDER_ACCOUNT_MISMATCH'],
      ['account_disconnected', 'AUTOPOSTER_ACCOUNT_DISCONNECTED'],
      ['account_not_publishing_ready', 'AUTOPOSTER_ACCOUNT_NOT_PUBLISHING_READY'],
    ] as const;

    for (const [reasonCode, expectedCode] of cases) {
      const { result } = await run(
        {
          async schedulePost() {
            return {
              ok: false,
              code: 'validation_failed',
              reasonCode,
              message: `AutoPoster refused the account: ${reasonCode}.`,
              details: { reasonCode, accountId: 'CaseSensitive-OpenId' },
            } as AutoPosterPortFailure;
          },
        },
        approvedSchedule({
          accountId: 'CaseSensitive-OpenId',
          mediaUrl: 'https://cdn.example.com/a.mp4',
          scheduledAt: futureIso(),
        })
      );
      assert.equal(result.status, 'validation_failed');
      assert.equal(result.errors[0]!.code, expectedCode);
      assert.equal((result.output as { reasonCode: string }).reasonCode, reasonCode);
    }
  });

  it('preserves allowlisted server-side commercial denial facts in mission output', async () => {
    const details = {
      reasonCode: 'runtime_scheduling_not_allowed',
      current: 0,
      limit: 0,
      remaining: 0,
      planId: 'starter',
      workspaceId: 'workspace-a',
    };
    const { result } = await run(
      {
        async schedulePost() {
          return {
            ok: false,
            code: 'forbidden',
            message: 'Runtime scheduling is not included in this plan.',
            details,
          } as AutoPosterPortFailure;
        },
      },
      approvedSchedule(
        { accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() },
        { tenant: { userId: 'owner', workspaceId: 'workspace-a', accountId: 'account-a' } }
      )
    );
    assert.equal(result.status, 'denied');
    assert.deepEqual(result.output, details);
    assert.equal(result.errors[0]!.code, 'AUTOPOSTER_FORBIDDEN');
  });

  it('downstream scheduling failure stays failed with no success language', async () => {
    const { result } = await run(
      {
        async schedulePost() {
          return { ok: false, code: 'internal', message: 'Queue write failed.' } as AutoPosterPortFailure;
        },
      },
      approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() })
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.evidence!.result!.success, false);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('"status":"succeeded"'));
  });

  it('preserves an exact opaque downstream queue id in output and evidence', async () => {
    const opaquePostId = 'Queue-ID:CaseSensitive/01~opaque';
    const { result } = await run(
      {
        async schedulePost(params) {
          return {
            ok: true,
            duplicate: false,
            post: {
              id: opaquePostId,
              accountId: params.accountId,
              provider: params.provider ?? 'tiktok',
              status: 'scheduled',
              scheduledAt: params.scheduledAt,
              approved: false,
            },
          };
        },
      },
      approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() })
    );

    assert.equal(result.status, 'succeeded');
    assert.equal((result.output as { post: { id: string } }).post.id, opaquePostId);
    assert.equal(JSON.stringify(result.evidence).includes(opaquePostId), true);
  });

  it('rejects whitespace-altered or non-string downstream queue ids without transformed evidence', async () => {
    for (const malformedId of [' post-opaque', 'post-opaque ', '\tpost-opaque', 42]) {
      const { result } = await run(
        {
          async schedulePost(params) {
            return {
              ok: true,
              duplicate: false,
              post: {
                id: malformedId,
                accountId: params.accountId,
                provider: params.provider ?? 'tiktok',
                status: 'scheduled',
                scheduledAt: params.scheduledAt,
                approved: false,
              },
            } as unknown as Awaited<ReturnType<AutoPosterOperationsPort['schedulePost']>>;
          },
        },
        approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() })
      );

      assert.equal(result.status, 'failed');
      assert.equal(result.errors[0]!.code, 'AUTOPOSTER_INVALID_SCHEDULE_RESPONSE');
      assert.equal(result.output, null);
      assert.equal(result.evidence!.result!.success, false);
      assert.equal(result.evidence!.evidence.some((item) => item.label.includes('schedule-created')), false);
    }
  });

  it('rejects schedule responses that do not prove an identifiable, unapproved queue draft', async () => {
    for (const duplicate of [undefined, 'false']) {
      const invalidDuplicate = await run(
        {
          async schedulePost(params) {
            return {
              ok: true,
              duplicate,
              post: {
                id: 'post-invalid-duplicate',
                accountId: params.accountId,
                status: 'scheduled',
                scheduledAt: params.scheduledAt,
                approved: false,
              },
            } as unknown as Awaited<ReturnType<AutoPosterOperationsPort['schedulePost']>>;
          },
        },
        approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() })
      );
      assert.equal(invalidDuplicate.result.status, 'failed');
      assert.equal(invalidDuplicate.result.errors[0]!.code, 'AUTOPOSTER_INVALID_SCHEDULE_RESPONSE');
      assert.equal(invalidDuplicate.result.evidence!.result!.success, false);
    }

    const unsafeApproval = await run(
      {
        async schedulePost(params) {
          return {
            ok: true,
            duplicate: false,
            post: {
              id: 'post-unsafe',
              accountId: params.accountId,
              status: 'scheduled',
              scheduledAt: params.scheduledAt,
              approved: true,
            },
          };
        },
      },
      approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() })
    );
    assert.equal(unsafeApproval.result.status, 'failed');
    assert.equal(unsafeApproval.result.errors[0]!.code, 'AUTOPOSTER_UNSAFE_SCHEDULE_RESPONSE');
    assert.equal(unsafeApproval.result.evidence!.result!.success, false);

    const missingPostId = await run(
      {
        async schedulePost(params) {
          return {
            ok: true,
            duplicate: false,
            post: {
              id: ' ',
              accountId: params.accountId,
              status: 'scheduled',
              scheduledAt: params.scheduledAt,
              approved: false,
            },
          };
        },
      },
      approvedSchedule({ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso() })
    );
    assert.equal(missingPostId.result.status, 'failed');
    assert.equal(missingPostId.result.errors[0]!.code, 'AUTOPOSTER_INVALID_SCHEDULE_RESPONSE');
    assert.equal(missingPostId.result.evidence!.result!.success, false);

    for (const postOverride of [
      { accountId: 'account-b' },
      { status: 'published' },
      { scheduledAt: futureIso(180) },
    ]) {
      const mismatchedDraft = await run(
        {
          async schedulePost(params) {
            return {
              ok: true,
              duplicate: false,
              post: {
                id: 'post-mismatched',
                accountId: params.accountId,
                status: 'scheduled',
                scheduledAt: params.scheduledAt,
                approved: false,
                ...postOverride,
              },
            };
          },
        },
        approvedSchedule({
          accountId: 'account-a',
          mediaUrl: 'https://cdn.example.com/a.mp4',
          scheduledAt: futureIso(),
        })
      );
      assert.equal(mismatchedDraft.result.status, 'failed');
      assert.equal(mismatchedDraft.result.errors[0]!.code, 'AUTOPOSTER_UNSAFE_SCHEDULE_RESPONSE');
      assert.equal(mismatchedDraft.result.evidence!.result!.success, false);
    }

    const mismatchedProvider = await run(
      {
        async schedulePost(params) {
          return {
            ok: true,
            duplicate: false,
            post: {
              id: 'post-wrong-provider',
              accountId: params.accountId,
              provider: 'tiktok',
              status: 'scheduled',
              scheduledAt: params.scheduledAt,
              approved: false,
            },
          };
        },
      },
      approvedSchedule({
        accountId: 'account-a',
        provider: 'youtube',
        title: 'Launch',
        mediaUrl: 'https://cdn.example.com/a.mp4',
        scheduledAt: futureIso(),
      })
    );
    assert.equal(mismatchedProvider.result.status, 'failed');
    assert.equal(mismatchedProvider.result.errors[0]!.code, 'AUTOPOSTER_UNSAFE_SCHEDULE_RESPONSE');
    assert.equal(mismatchedProvider.result.evidence!.result!.success, false);
  });

  it('the adapter exposes no publish action and its specs never use publish policy types', () => {
    const adapter = createAutoPosterMissionAdapter(makeFakePort().port);
    for (const spec of adapter.actions) {
      assert.ok(!spec.action.includes('publish'), `${spec.action} must not be a publish action`);
      assert.notEqual(spec.policyActionType as string, 'publish');
      assert.notEqual(spec.executionPolicy, 'publish_guarded');
    }
    assert.deepEqual(
      adapter.actions.map((spec) => spec.action).sort(),
      [
        'autoposter.media.validate',
        'autoposter.post.get_status',
        'autoposter.post.schedule',
        'autoposter.queue.list',
      ]
    );
  });
});

describe('normalizeScheduledAt', () => {
  it('normalizes offset timestamps to UTC deterministically', () => {
    const result = normalizeScheduledAt('2099-07-11T12:00:00+03:00');
    assert.ok('iso' in result);
    assert.equal(result.iso, '2099-07-11T09:00:00.000Z');
  });

  it('rejects zone-less, malformed, and past values', () => {
    for (const value of ['2099-07-11T12:00:00', 'not-a-date', '2020-01-01T00:00:00Z']) {
      const result = normalizeScheduledAt(value);
      assert.ok('error' in result, `${value} must be rejected`);
    }
  });
});
