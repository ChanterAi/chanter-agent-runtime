/**
 * AutoPoster HTTP port tests: typed/bounded behavior with an injected fetch —
 * status mapping, timeout -> unavailable, token header handling, and the
 * guarantee that the service token never leaks into returned data.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAutoPosterHttpPort,
  RUNTIME_CONTROL_TOKEN_HEADER,
} from '../../src/adapters/autoPosterHttpPort.js';
import type { AutoPosterPostStatusParams } from '../../src/adapters/autoPosterMissionAdapter.js';

const TOKEN = 'opaquecredentialvalue';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeFetch(
  responder: (call: RecordedCall) => { status: number; json?: unknown; nonJson?: boolean } | 'hang'
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const plan = responder(call);
    if (plan === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    return {
      ok: plan.status >= 200 && plan.status < 300,
      status: plan.status,
      json: async () => {
        if (plan.nonJson) throw new Error('Unexpected token < in JSON');
        return plan.json;
      },
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makePort(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createAutoPosterHttpPort({
    baseUrl: 'http://localhost:3010/',
    serviceToken: TOKEN,
    fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

describe('createAutoPosterHttpPort — wiring', () => {
  it('fails closed at construction when baseUrl or token is missing', () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200, json: { ok: true } }));
    assert.throws(() => createAutoPosterHttpPort({ baseUrl: '', serviceToken: TOKEN, fetchImpl }));
    assert.throws(() => createAutoPosterHttpPort({ baseUrl: 'http://localhost:3010', serviceToken: '', fetchImpl }));
  });

  it('sends the service token header, JSON accept, and bounded query parameters', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { ok: true, items: [], count: 0, scope: { accountId: 'all' } },
    }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 25 });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://localhost:3010/api/runtime/queue?limit=25');
    assert.equal(calls[0]!.headers[RUNTIME_CONTROL_TOKEN_HEADER], TOKEN);
    assert.equal(calls[0]!.method, 'GET');
  });

  it('adds optional workspace scope to list and status query parameters', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 200, json: { ok: true } }));
    const port = makePort(fetchImpl);

    await port.listQueue({ userId: 'owner', workspaceId: 'workspace-a', accountId: 'account-a', limit: 25 });
    await port.getPostStatus({
      userId: 'owner',
      workspaceId: 'workspace-a',
      accountId: 'account-a',
      postId: 'post-1',
    });

    assert.equal(
      calls[0]!.url,
      'http://localhost:3010/api/runtime/queue?accountId=account-a&workspaceId=workspace-a&limit=25'
    );
    assert.equal(
      calls[1]!.url,
      'http://localhost:3010/api/runtime/posts/post-1/status?accountId=account-a&workspaceId=workspace-a'
    );
  });
});

describe('createAutoPosterHttpPort - durable schedule reconciliation', () => {
  const params = {
    userId: 'owner',
    workspaceId: 'workspace-a',
    accountId: 'Case-A',
    provider: 'tiktok' as const,
    scheduledAt: '2030-07-15T15:50:00.000Z',
    idempotencyKey: 'idem-a',
    missionId: 'mission-a',
    action: 'autoposter.post.schedule' as const,
    missionPayloadHash: 'a'.repeat(64),
    traceId: 'trace-a',
  };

  it('preserves exact scope and accepts one authoritative reusable result', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: {
        ok: true,
        outcome: 'unique',
        count: 1,
        unique: true,
        safeToReuse: true,
        approvalState: 'required',
        publishingState: 'blocked_until_human_approval',
        evidenceStatus: 'authoritative',
        post: {
          id: 'Queue-Exact/01',
          accountId: 'Case-A',
          provider: 'tiktok',
          status: 'scheduled',
          scheduledAt: params.scheduledAt,
          approved: false,
        },
      },
    }));
    const result = await makePort(fetchImpl).reconcileSchedule!(params);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.outcome, 'unique');
    assert.equal(calls[0]!.url, 'http://localhost:3010/api/runtime/schedule/reconcile');
    assert.equal(calls[0]!.headers['x-correlation-id'], 'trace-a');
    assert.deepEqual(JSON.parse(calls[0]!.body!), {
      workspaceId: 'workspace-a',
      accountId: 'Case-A',
      provider: 'tiktok',
      scheduledAt: params.scheduledAt,
      idempotencyKey: 'idem-a',
      missionId: 'mission-a',
      action: 'autoposter.post.schedule',
      missionPayloadHash: 'a'.repeat(64),
    });
  });

  it('accepts explicit not-found, mismatch, and conflict truth without exposing unsafe evidence', async () => {
    const payloads = [
      {
        ok: true, outcome: 'not_found', count: 0, unique: true, safeToReuse: false,
        approvalState: 'not_started', publishingState: 'not_started', evidenceStatus: 'not_found',
      },
      {
        ok: true, outcome: 'conflict', count: 2, unique: false, safeToReuse: false,
        approvalState: 'unknown', publishingState: 'unknown', evidenceStatus: 'conflict',
        conflictingPostIds: ['conflict-A', 'conflict-B'],
      },
      ...(['scope_mismatch', 'idempotency_mismatch', 'payload_mismatch'] as const).map((outcome) => ({
        ok: true,
        outcome,
        count: 1,
        unique: true,
        safeToReuse: false,
        approvalState: 'unknown',
        publishingState: 'not_started',
        evidenceStatus: outcome,
      })),
    ];
    for (const payload of payloads) {
      const { fetchImpl } = makeFetch(() => ({ status: 200, json: payload }));
      const result = await makePort(fetchImpl).reconcileSchedule!(params);
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.outcome, payload.outcome);
    }
  });

  it('rejects contradictory, mismatched, or unsafe success evidence', async () => {
    const invalidPayloads = [
      {
        ok: true, outcome: 'not_found', count: 1, unique: true, safeToReuse: false,
        approvalState: 'not_started', publishingState: 'not_started', evidenceStatus: 'not_found',
      },
      {
        ok: true, outcome: 'conflict', count: 2, unique: false, safeToReuse: false,
        approvalState: 'unknown', publishingState: 'unknown', evidenceStatus: 'conflict',
        conflictingPostIds: ['only-one'],
      },
      {
        ok: true, outcome: 'unique', count: 1, unique: true, safeToReuse: true,
        approvalState: 'required', publishingState: 'blocked_until_human_approval', evidenceStatus: 'authoritative',
        post: { id: 'queue-a', accountId: 'case-a', provider: 'tiktok', status: 'scheduled', scheduledAt: params.scheduledAt, approved: false },
      },
    ];
    for (const payload of invalidPayloads) {
      const { fetchImpl } = makeFetch(() => ({ status: 200, json: payload }));
      const result = await makePort(fetchImpl).reconcileSchedule!(params);
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.code, 'internal');
    }
  });
});

describe('createAutoPosterHttpPort — safe connected-account preflight', () => {
  const canonicalAccount = {
    provider: 'tiktok',
    providerDisplayName: 'TikTok',
    accountId: 'CaseSensitive-OpenId',
    connectedAccountId: 'tiktok:CaseSensitive-OpenId',
    username: 'creator',
    displayName: 'CHANTER Creator',
    connectionStatus: 'connected',
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: '2026-07-14T07:00:00+03:00',
  };

  it('lists and validates exact canonical ids through the new bounded paths', async () => {
    const { fetchImpl, calls } = makeFetch((call) => call.method === 'GET'
      ? {
          status: 200,
          json: {
            ok: true,
            workspaceId: 'workspace-a',
            count: 1,
            accounts: [{
              ...canonicalAccount,
              username: 'TOKEN=abc123DEF456ghi789JKL012mno345PQR',
              ownerUserId: 'must-not-cross',
              accessToken: 'provider-secret-must-not-cross',
              authorization: { scopes: ['video.publish'] },
              providerPayload: { raw: true },
            }],
          },
        }
      : {
          status: 200,
          json: { ok: true, workspaceId: 'workspace-a', account: canonicalAccount },
        });
    const port = makePort(fetchImpl);

    const listed = await port.listConnectedAccounts!({
      userId: 'owner',
      workspaceId: 'workspace-a',
      provider: 'tiktok',
    });
    const validated = await port.validateConnectedAccount!({
      userId: 'owner',
      workspaceId: 'workspace-a',
      provider: 'tiktok',
      accountId: 'CaseSensitive-OpenId',
    });

    assert.equal(calls[0]!.url, 'http://localhost:3010/api/runtime/connected-accounts?workspaceId=workspace-a&provider=tiktok');
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[1]!.url, 'http://localhost:3010/api/runtime/connected-accounts/validate');
    assert.equal(calls[1]!.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1]!.body!), {
      workspaceId: 'workspace-a',
      provider: 'tiktok',
      accountId: 'CaseSensitive-OpenId',
    });

    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.equal(listed.workspaceId, 'workspace-a');
      assert.equal(listed.count, 1);
      assert.equal(listed.accounts[0]!.accountId, 'CaseSensitive-OpenId');
      assert.equal(listed.accounts[0]!.connectedAccountId, 'tiktok:CaseSensitive-OpenId');
      assert.equal(listed.accounts[0]!.username, 'TOKEN=[REDACTED]');
      assert.equal(listed.accounts[0]!.lastVerifiedAt, '2026-07-14T04:00:00.000Z');
      const serialized = JSON.stringify(listed);
      for (const canary of ['must-not-cross', 'provider-secret-must-not-cross', 'video.publish', 'providerPayload']) {
        assert.equal(serialized.includes(canary), false, `${canary} must not cross the account-view allowlist`);
      }
    }
    assert.equal(validated.ok, true);
    if (validated.ok) {
      assert.equal(validated.workspaceId, 'workspace-a');
      assert.equal(validated.account.accountId, 'CaseSensitive-OpenId');
    }
  });

  it('fails closed on malformed or non-exact connected-account success payloads', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 200,
      json: {
        ok: true,
        workspaceId: 'workspace-a',
        account: { ...canonicalAccount, accountId: 'casesensitive-openid' },
      },
    }));
    const port = makePort(fetchImpl);
    const result = await port.validateConnectedAccount!({
      userId: 'owner',
      workspaceId: 'workspace-a',
      provider: 'tiktok',
      accountId: 'CaseSensitive-OpenId',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'internal');
  });

  it('fails closed when success payloads do not prove exact workspace ownership and publishing readiness', async () => {
    const payloads = [
      {
        ok: true,
        workspaceId: 'workspace-other',
        account: canonicalAccount,
      },
      {
        ok: true,
        workspaceId: 'workspace-a',
        account: {
          ...canonicalAccount,
          publishingReady: false,
          readinessBlockers: ['provider_not_active'],
        },
      },
      {
        ok: true,
        workspaceId: 'workspace-a',
        account: {
          ...canonicalAccount,
          connectionStatus: 'reauthorization_required',
          publishingReady: false,
          readinessBlockers: ['reauthorization_required'],
        },
      },
    ];

    for (const json of payloads) {
      const { fetchImpl } = makeFetch(() => ({ status: 200, json }));
      const port = makePort(fetchImpl);
      const result = await port.validateConnectedAccount!({
        userId: 'owner',
        workspaceId: 'workspace-a',
        provider: 'tiktok',
        accountId: 'CaseSensitive-OpenId',
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'internal');
    }

    const { fetchImpl } = makeFetch(() => ({
      status: 200,
      json: { ok: true, workspaceId: 'workspace-other', count: 1, accounts: [canonicalAccount] },
    }));
    const listResult = await makePort(fetchImpl).listConnectedAccounts!({
      userId: 'owner',
      workspaceId: 'workspace-a',
    });
    assert.equal(listResult.ok, false);
    if (!listResult.ok) assert.equal(listResult.code, 'internal');
  });

  it('preserves allowlisted account-domain reason codes and drops arbitrary error payloads', async () => {
    const reasonCodes = [
      'unknown_account_id',
      'account_id_case_mismatch',
      'account_id_non_canonical',
      'account_workspace_mismatch',
      'provider_account_mismatch',
      'account_disconnected',
      'account_not_publishing_ready',
    ];
    for (const reasonCode of reasonCodes) {
      const { fetchImpl } = makeFetch(() => ({
        status: reasonCode === 'unknown_account_id' ? 404 : 409,
        json: {
          ok: false,
          code: reasonCode,
          reason: `TOKEN=abc123DEF456ghi789JKL012mno345PQR Refused: ${reasonCode}`,
          accountId: 'CaseSensitive-OpenId',
          provider: 'tiktok',
          blockers: ['account_disconnected'],
          rawProviderPayload: { accessToken: 'must-not-cross' },
        },
      }));
      const port = makePort(fetchImpl);
      const result = await port.validateConnectedAccount!({
        userId: 'owner',
        workspaceId: 'workspace-a',
        provider: 'tiktok',
        accountId: 'CaseSensitive-OpenId',
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reasonCode, reasonCode);
        assert.equal(result.details?.reasonCode, reasonCode);
        assert.equal(result.details?.accountId, 'CaseSensitive-OpenId');
        assert.equal(result.message.includes('abc123DEF456ghi789JKL012mno345PQR'), false);
        assert.equal(result.message.includes('TOKEN=[REDACTED]'), true);
        assert.equal(JSON.stringify(result).includes('must-not-cross'), false);
      }
    }
  });
});

describe('createAutoPosterHttpPort — status mapping', () => {
  const cases: Array<[number, string]> = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [400, 'validation_failed'],
    [409, 'validation_failed'],
    [422, 'validation_failed'],
    [503, 'unavailable'],
    [500, 'internal'],
  ];
  for (const [status, code] of cases) {
    it(`maps HTTP ${status} to '${code}'`, async () => {
      const { fetchImpl } = makeFetch(() => ({ status, json: { ok: false, reason: 'refused' } }));
      const port = makePort(fetchImpl);
      const result = await port.getPostStatus({ userId: 'owner', postId: 'post-1' });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, code);
    });
  }

  it('prefers an explicit downstream error code over the HTTP status mapping', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 404,
      json: { ok: false, code: 'forbidden', reason: 'not yours' },
    }));
    const port = makePort(fetchImpl);
    const result = await port.getPostStatus({ userId: 'owner', postId: 'post-1' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'forbidden');
  });

  it('allowlists structured commercial denial facts and drops arbitrary response fields', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 409,
      json: {
        ok: false,
        code: 'monthly_post_limit_reached',
        reason: 'Monthly scheduling limit reached.',
        reasonCode: 'monthly_post_limit_reached',
        current: 10,
        limit: 10,
        remaining: 0,
        planId: 'starter',
        workspaceId: 'workspace-a',
        evaluationTimestamp: '2026-07-12T09:30:00+02:00',
        planOverrides: { scheduledPostsPerCycle: 999999 },
        customerId: 'must-not-cross-runtime-boundary',
      },
    }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', workspaceId: 'workspace-a', limit: 5 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'forbidden');
      assert.deepEqual(result.details, {
        reasonCode: 'monthly_post_limit_reached',
        current: 10,
        limit: 10,
        remaining: 0,
        planId: 'starter',
        workspaceId: 'workspace-a',
        evaluationTimestamp: '2026-07-12T07:30:00.000Z',
      });
      assert.equal('planOverrides' in (result.details as Record<string, unknown>), false);
      assert.equal('customerId' in (result.details as Record<string, unknown>), false);
    }
  });

  it('maps an explicit unknown-workspace refusal to denied transport truth without changing ordinary 404s', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 404,
      json: {
        ok: false,
        code: 'workspace_not_found',
        reason: 'Workspace not found for this authenticated owner.',
      },
    }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', workspaceId: 'workspace-unknown', limit: 5 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'forbidden');
      assert.deepEqual(result.details, { reasonCode: 'workspace_not_found' });
    }
  });

  it('an HTTP 200 body without ok:true is refused, not trusted', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200, json: { unexpected: 'shape' } }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 5 });
    assert.equal(result.ok, false);
  });

  it('a malformed JSON value preserves the HTTP-derived failure classification', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 503, json: null }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 5 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unavailable');
  });

  it('a non-JSON response maps to a structured failure', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200, nonJson: true }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 5 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'internal');
  });
});

describe('createAutoPosterHttpPort — reachability and boundedness', () => {
  it('a connection failure maps to unavailable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 5 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unavailable');
  });

  it('a hung request times out and maps to unavailable (no retry)', async () => {
    const { fetchImpl, calls } = makeFetch(() => 'hang');
    const port = makePort(fetchImpl, 50);
    const result = await port.schedulePost({
      userId: 'owner',
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/a.mp4',
      caption: '',
      hashtags: '',
      scheduledAt: '2099-07-11T09:00:00.000Z',
      idempotencyKey: 'idem-1',
      requestedBy: 'mcp-client',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'unavailable');
      assert.match(result.message, /timed out/);
    }
    assert.equal(calls.length, 1, 'exactly one attempt — retries could duplicate scheduling');
  });

  it('rejects a downstream failure that echoes the exact service token', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 500,
      json: { ok: false, reason: `downstream echoed ${TOKEN}` },
    }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 5 });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  it('rejects a purported success that echoes the exact service token', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 201,
      json: {
        ok: true,
        duplicate: false,
        post: {
          id: TOKEN,
          accountId: 'account-a',
          status: 'scheduled',
          scheduledAt: '2099-07-11T09:00:00.000Z',
          approved: false,
        },
      },
    }));
    const port = makePort(fetchImpl);
    const result = await port.schedulePost({
      userId: 'owner',
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/a.mp4',
      caption: '',
      hashtags: '',
      scheduledAt: '2099-07-11T09:00:00.000Z',
      idempotencyKey: 'idem-token-echo',
      requestedBy: 'mcp-client',
    });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  it('schedule sends the full typed body and never the tenant userId (server derives it from the token)', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 201,
      json: {
        ok: true,
        duplicate: false,
        post: { id: 'post-9', accountId: 'account-a', status: 'scheduled', scheduledAt: '2099-07-11T09:00:00.000Z', approved: false },
      },
    }));
    const port = makePort(fetchImpl);
    const result = await port.schedulePost({
      userId: 'owner',
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/a.mp4',
      caption: 'Launch',
      hashtags: '#go',
      scheduledAt: '2099-07-11T09:00:00.000Z',
      traceId: ' trace-99 ',
      idempotencyKey: 'idem-9',
      requestedBy: 'mcp-client',
    });
    assert.equal(result.ok, true);
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    assert.equal(body.accountId, 'account-a');
    assert.equal(body.idempotencyKey, 'idem-9');
    assert.equal(calls[0]!.headers['x-correlation-id'], 'trace-99');
    assert.equal(body.traceId, undefined, 'trace identity belongs in the correlation header, not the request body');
    assert.equal(body.userId, undefined, 'tenant identity must be derived server-side from the token');
    assert.equal('provider' in body, false, 'a TikTok schedule carries no provider field (backward compatibility)');
    assert.equal('title' in body, false);
  });

  it('sends the optional workspace in the schedule body without plan claims', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 201,
      json: {
        ok: true,
        duplicate: false,
        post: { id: 'post-9', accountId: 'account-a', status: 'scheduled', scheduledAt: null, approved: false },
      },
    }));
    const port = makePort(fetchImpl);
    await port.schedulePost({
      userId: 'owner',
      workspaceId: 'workspace-a',
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/a.mp4',
      caption: '',
      hashtags: '',
      scheduledAt: '2099-07-11T09:00:00.000Z',
      traceId: '   ',
      idempotencyKey: 'idem-workspace',
      requestedBy: 'mcp-client',
    });

    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    assert.equal(body.workspaceId, 'workspace-a');
    assert.equal('planId' in body, false);
    assert.equal('entitlements' in body, false);
    assert.equal(calls[0]!.headers['x-correlation-id'], undefined, 'blank traceId must not emit a header');
  });

  it('a YouTube schedule carries provider, title, and description in the body', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 201,
      json: {
        ok: true,
        duplicate: false,
        post: { id: 'post-10', accountId: 'UC-chanter', status: 'scheduled', scheduledAt: '2099-07-11T09:00:00.000Z', approved: false },
      },
    }));
    const port = makePort(fetchImpl);
    const result = await port.schedulePost({
      userId: 'owner',
      accountId: 'UC-chanter',
      provider: 'youtube',
      mediaUrl: 'https://cdn.example.com/a.mp4',
      caption: '',
      hashtags: '',
      title: 'Private launch teaser',
      description: 'Supervised test upload',
      scheduledAt: '2099-07-11T09:00:00.000Z',
      idempotencyKey: 'idem-10',
      requestedBy: 'mcp-client',
    });
    assert.equal(result.ok, true);
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    assert.equal(body.provider, 'youtube');
    assert.equal(body.title, 'Private launch teaser');
    assert.equal(body.description, 'Supervised test upload');
  });
});

// ---------------------------------------------------------------------------
// Phase 2E-B strict post-status contract
// ---------------------------------------------------------------------------

function makeStatusPost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'post-1',
    provider: 'tiktok',
    connectedAccountId: 'tiktok:account-a',
    accountId: 'account-a',
    username: 'creator_a',
    workspaceId: 'workspace-a',
    status: 'scheduled',
    scheduledAt: '2026-07-11T09:00:00.000Z',
    approved: false,
    approvalState: 'unapproved',
    approvedAt: null,
    approvedBy: '',
    mediaType: 'video',
    captionSummary: 'First drop',
    createdAt: '2026-07-10T08:00:00.000Z',
    updatedAt: '2026-07-10T08:05:00.000Z',
    postedAt: null,
    publishId: '',
    providerStatus: '',
    providerVerification: null,
    lockedAt: null,
    claimAttempts: 0,
    publishAttemptBudget: 5,
    attemptBudgetExhausted: false,
    runtimeMissionId: 'graph:g-1:node:n-1',
    runtimeIdempotencyKey: 'graph:g-1:node:n-1',
    runtimeAction: 'autoposter.post.schedule',
    runtimePayloadHash: 'a'.repeat(64),
    lastResult: null,
    history: [],
    lastErrorMessage: '',
    ...overrides,
  };
}

const APPROVED_FIELDS = {
  approved: true,
  approvalState: 'approved',
  approvedAt: '2026-07-10T10:00:00.000Z',
  approvedBy: 'founder@chanter',
};

function statusPortFor(post: unknown) {
  const { fetchImpl, calls } = makeFetch(() => ({ status: 200, json: { ok: true, post } }));
  return { port: makePort(fetchImpl), calls };
}

const STATUS_VIEW_KEYS = [
  'accountId', 'approvalState', 'approved', 'approvedAt', 'approvedBy', 'attemptBudgetExhausted',
  'captionSummary', 'claimAttempts', 'connectedAccountId', 'createdAt',
  'history', 'id', 'lastErrorMessage', 'lastResult', 'lockedAt', 'mediaType',
  'postedAt', 'provider', 'providerStatus', 'providerVerification', 'publishAttemptBudget', 'publishId', 'runtimeAction',
  'runtimeIdempotencyKey', 'runtimeMissionId', 'runtimePayloadHash',
  'scheduledAt', 'status', 'updatedAt', 'username', 'workspaceId',
];

describe('createAutoPosterHttpPort — strict post status parsing (Phase 2E-B)', () => {
  it('parses every supported lifecycle state through the closed-world projection', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['scheduled unapproved draft', {}],
      ['pending unapproved', { status: 'pending', scheduledAt: null }],
      ['legacy ready', { status: 'ready', ...APPROVED_FIELDS }],
      ['approved for publishing', APPROVED_FIELDS],
      ['processing', {
        ...APPROVED_FIELDS,
        status: 'processing',
        lockedAt: '2026-07-11T09:00:05.000Z',
        claimAttempts: 1,
      }],
      ['retry scheduled', {
        ...APPROVED_FIELDS,
        claimAttempts: 2,
        lastResult: { code: 'PROVIDER_5XX', message: 'HTTP 502 from provider.', willRetry: true },
        history: [{ at: '2026-07-11T09:01:00.000Z', event: 'retry_scheduled', detail: 'Retrying in 5 minutes.' }],
      }],
      ['youtube uploaded private', {
        ...APPROVED_FIELDS,
        provider: 'youtube',
        connectedAccountId: 'youtube:account-a',
        status: 'posted',
        postedAt: '2026-07-11T09:02:00.000Z',
        publishId: 'yt-video-123',
        providerStatus: 'uploaded_private',
        providerVerification: {
          provider: 'youtube',
          externalVideoId: 'yt-video-123',
          channelId: 'account-a',
          channelTitle: 'CHANTER',
          channelHandle: '@chantercy',
          title: 'CHANTER OS Real Provider Proof',
          privacyStatus: 'private',
          uploadStatus: 'uploaded',
          processingStatus: 'processing',
          verifiedAt: '2026-07-11T09:02:00.000Z',
          uploadMethod: 'resumable',
        },
        lastResult: { completedAt: '2026-07-11T09:02:00.000Z' },
      }],
      ['tiktok provider accepted unverified', {
        ...APPROVED_FIELDS,
        status: 'posted',
        postedAt: '2026-07-11T09:03:00.000Z',
        publishId: 'tt-publish-9',
        lastResult: { mode: 'api', completedAt: '2026-07-11T09:03:00.000Z' },
      }],
      ['manually reconciled', {
        ...APPROVED_FIELDS,
        status: 'posted',
        postedAt: '2026-07-11T09:04:00.000Z',
        lastResult: { mode: 'manual', message: 'Marked posted manually', completedAt: '2026-07-11T09:04:00.000Z' },
        history: [{ at: '2026-07-11T09:04:00.000Z', event: 'marked_posted', detail: 'Human assertion.' }],
      }],
      ['failed', {
        ...APPROVED_FIELDS,
        status: 'failed',
        claimAttempts: 3,
        lastResult: {
          code: 'PROVIDER_AUTH',
          message: 'Reauthorize the account.',
          providerMutationStarted: false,
          failureBoundary: 'before_provider_upload_session',
        },
        lastErrorMessage: 'Reauthorize the account.',
      }],
      ['outcome unknown', {
        ...APPROVED_FIELDS,
        status: 'outcome_unknown',
        providerStatus: 'provider_reconciliation_required',
        lastResult: { code: 'PROVIDER_RECONCILIATION_REQUIRED', outcomeUnknown: true },
      }],
    ];
    for (const [label, overrides] of cases) {
      const post = makeStatusPost(overrides);
      const { port } = statusPortFor(post);
      const result = await port.getPostStatus({
        userId: 'owner',
        workspaceId: 'workspace-a',
        accountId: 'account-a',
        postId: 'post-1',
      });
      assert.equal(result.ok, true, `${label}: ${JSON.stringify(!result.ok ? result.message : '')}`);
      if (result.ok) {
        assert.deepEqual(Object.keys(result.post).sort(), STATUS_VIEW_KEYS, label);
        assert.equal(result.post.id, 'post-1', label);
        assert.equal(result.post.status, post.status, label);
        assert.equal(result.post.approved, post.approved, label);
        assert.equal(result.post.updatedAt, '2026-07-10T08:05:00.000Z', label);
      }
    }
  });

  it('rejects provider verification that is not bound to the exact private YouTube artifact', async () => {
    const base = {
      ...APPROVED_FIELDS,
      provider: 'youtube',
      connectedAccountId: 'youtube:account-a',
      status: 'posted',
      postedAt: '2026-07-11T09:02:00.000Z',
      publishId: 'yt-video-123',
      providerStatus: 'uploaded_private',
      providerVerification: {
        provider: 'youtube',
        externalVideoId: 'different-video',
        channelId: 'account-a',
        channelTitle: 'CHANTER',
        channelHandle: '@chantercy',
        title: 'CHANTER OS Real Provider Proof',
        privacyStatus: 'private',
        uploadStatus: 'uploaded',
        processingStatus: 'succeeded',
        verifiedAt: '2026-07-11T09:02:00.000Z',
        uploadMethod: 'resumable',
      },
    };
    const { port } = statusPortFor(makeStatusPost(base));
    const result = await port.getPostStatus({ userId: 'owner', accountId: 'account-a', postId: 'post-1' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /provider verification/i);
  });

  it('drops safe extra response fields (providerMetadata) without failing the parse', async () => {
    const { port } = statusPortFor(makeStatusPost({
      providerMetadata: { youtube: { title: 'Launch', description: '', privacyStatus: 'private', notifySubscribers: false } },
    }));
    const result = await port.getPostStatus({ userId: 'owner', postId: 'post-1' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal('providerMetadata' in result.post, false, 'unlisted fields never pass through');
    }
  });

  it('rejects identity substitution with a typed identity mismatch', async () => {
    const cases: Array<[string, Record<string, unknown>, AutoPosterPostStatusParams]> = [
      ['different post id', {}, { userId: 'owner', postId: 'post-2' }],
      ['account substitution', { accountId: 'account-b', connectedAccountId: 'tiktok:account-b' },
        { userId: 'owner', postId: 'post-1', accountId: 'account-a' }],
      ['workspace substitution', { workspaceId: 'workspace-b' },
        { userId: 'owner', postId: 'post-1', workspaceId: 'workspace-a' }],
      ['legacy empty workspace under a workspace-scoped read', { workspaceId: '' },
        { userId: 'owner', postId: 'post-1', workspaceId: 'workspace-a' }],
    ];
    for (const [label, overrides, params] of cases) {
      const { port } = statusPortFor(makeStatusPost(overrides));
      const result = await port.getPostStatus(params);
      assert.equal(result.ok, false, label);
      if (!result.ok) {
        assert.equal(result.code, 'invalid_response', label);
        assert.equal(result.reasonCode, 'status_identity_mismatch', label);
      }
    }
  });

  it('fails closed on contract violations instead of normalizing them', async () => {
    const legacyMinimalView = {
      id: 'post-1',
      accountId: 'account-a',
      username: 'creator_a',
      status: 'scheduled',
      scheduledAt: '2026-07-11T09:00:00.000Z',
      approved: false,
      mediaType: 'video',
      captionSummary: 'First drop',
      createdAt: '2026-07-10T08:00:00.000Z',
      updatedAt: '2026-07-10T08:05:00.000Z',
      approvedAt: null,
      approvedBy: '',
      postedAt: null,
      publishId: '',
      claimAttempts: 0,
      lastErrorMessage: '',
    };
    const cases: Array<[string, unknown]> = [
      ['missing post object', undefined],
      ['array post', []],
      ['legacy minimal pre-2E-B view', legacyMinimalView],
      ['unknown queue status', makeStatusPost({ status: 'publishing' })],
      ['unsupported provider', makeStatusPost({ provider: 'instagram', connectedAccountId: 'instagram:account-a' })],
      ['non-canonical connected account', makeStatusPost({ connectedAccountId: 'tiktok:other' })],
      ['approval flag contradiction', makeStatusPost({ approved: true })],
      ['approved without timestamp', makeStatusPost({ approved: true, approvalState: 'approved', approvedAt: null })],
      ['processing without approval', makeStatusPost({ status: 'processing', lockedAt: '2026-07-11T09:00:05.000Z' })],
      ['missing source revision', makeStatusPost({ updatedAt: null })],
      ['malformed source revision', makeStatusPost({ updatedAt: 'not-a-date' })],
      ['malformed posted timestamp', makeStatusPost({ postedAt: 'garbage' })],
      ['negative claim attempts', makeStatusPost({ claimAttempts: -1 })],
      ['fractional claim attempts', makeStatusPost({ claimAttempts: 1.5 })],
      ['string claim attempts', makeStatusPost({ claimAttempts: '3' })],
      ['missing publish attempt budget', makeStatusPost({ publishAttemptBudget: undefined })],
      ['attempt budget contradiction', makeStatusPost({ claimAttempts: 5, attemptBudgetExhausted: false })],
      ['non-array history', makeStatusPost({ history: 'log' })],
      ['oversized history', makeStatusPost({
        history: Array.from({ length: 21 }, (_, index) => ({ at: null, event: `event_${index}`, detail: '' })),
      })],
      ['history entry with unknown field', makeStatusPost({
        history: [{ at: null, event: 'x', detail: '', raw: { body: 'payload' } }],
      })],
      ['history entry without event', makeStatusPost({ history: [{ at: null, detail: 'orphan' }] })],
      ['lastResult with raw response', makeStatusPost({
        lastResult: { code: 'OK', response: { publish_id: 'p' } },
      })],
      ['lastResult with unexpected attempts', makeStatusPost({ lastResult: { attempts: 2 } })],
      ['malformed runtime payload hash', makeStatusPost({ runtimePayloadHash: 'Z'.repeat(64) })],
    ];
    for (const [label, post] of cases) {
      const { port, calls } = statusPortFor(post);
      const result = await port.getPostStatus({ userId: 'owner', postId: 'post-1' });
      assert.equal(result.ok, false, label);
      if (!result.ok) {
        assert.equal(result.code, 'invalid_response', label);
        assert.equal(result.reasonCode, 'status_contract_violation', label);
      }
      assert.equal(calls.length, 1, `${label}: a rejected response is never retried`);
    }
  });

  it('rejects secret-like and unsafe fields anywhere in the response post', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['top-level lock ownership', { lockedBy: 'worker-1' }],
      ['top-level media url', { mediaUrl: 'https://cdn.example.com/a.mp4' }],
      ['top-level caption body', { caption: 'full caption' }],
      ['secret-shaped key', { accessToken: 'value' }],
      ['nested secret-shaped key', { debug: { refresh_token: 'value' } }],
    ];
    for (const [label, overrides] of cases) {
      const { port } = statusPortFor(makeStatusPost(overrides));
      const result = await port.getPostStatus({ userId: 'owner', postId: 'post-1' });
      assert.equal(result.ok, false, label);
      if (!result.ok) {
        assert.equal(result.code, 'invalid_response', label);
        assert.equal(result.message.includes('value'), false, `${label}: unsafe values never echo`);
      }
    }
  });

  it('redacts token-shaped content in human-readable evidence fields', async () => {
    const { port } = statusPortFor(makeStatusPost({
      status: 'failed',
      ...APPROVED_FIELDS,
      lastResult: { code: 'PROVIDER_AUTH', message: 'Bearer abc.def-ghi caused the refusal' },
      lastErrorMessage: 'Bearer abc.def-ghi caused the refusal',
      history: [{ at: null, event: 'failed', detail: 'API_KEY=super-secret-value refused' }],
    }));
    const result = await port.getPostStatus({ userId: 'owner', postId: 'post-1' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.post.lastResult?.message?.includes('abc.def-ghi'), false);
      assert.equal(result.post.lastErrorMessage.includes('abc.def-ghi'), false);
      assert.equal(result.post.history[0]!.detail.includes('super-secret-value'), false);
    }
  });

  it('a response echoing the service token stays an internal credential failure', async () => {
    const { port } = statusPortFor(makeStatusPost({ publishId: TOKEN }));
    const result = await port.getPostStatus({ userId: 'owner', postId: 'post-1' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'internal');
  });
});
