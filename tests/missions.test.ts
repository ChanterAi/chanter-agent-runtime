/**
 * Mission execution layer tests: dispatch, gating, idempotency, redaction,
 * and truthful failure propagation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInMemoryIdempotencyStore,
  createMissionAdapterRegistry,
  createRuntimeMissionPayloadHash,
  executeMission,
  type RuntimeMissionAdapter,
  type RuntimeMissionRequest,
} from '../src/missions.js';

function makeAdapter(overrides: Partial<RuntimeMissionAdapter> = {}): {
  adapter: RuntimeMissionAdapter;
  calls: RuntimeMissionRequest[];
} {
  const calls: RuntimeMissionRequest[] = [];
  const adapter: RuntimeMissionAdapter = {
    id: 'test-adapter',
    product: 'auto_poster',
    version: '0.0.1',
    actions: [
      {
        action: 'test.read',
        description: 'read something',
        policyActionType: 'read',
        riskLevel: 'low',
        executionPolicy: 'local_only',
        requiresIdempotencyKey: false,
      },
      {
        action: 'test.write',
        description: 'write something',
        policyActionType: 'write',
        riskLevel: 'high',
        executionPolicy: 'requires_approval',
        requiresIdempotencyKey: true,
      },
    ],
    async execute(request) {
      calls.push(request);
      return { ok: true, output: { echoed: request.action } };
    },
    ...overrides,
  };
  return { adapter, calls };
}

function makeRequest(overrides: Partial<RuntimeMissionRequest> = {}): RuntimeMissionRequest {
  return {
    missionId: 'mission-1',
    product: 'auto_poster',
    action: 'test.read',
    actor: { id: 'tester', kind: 'human' },
    tenant: { userId: 'owner' },
    input: {},
    ...overrides,
  };
}

describe('runtime mission payload hash', () => {
  it('is stable across object key order and excludes process-local request metadata', () => {
    const first = makeRequest({
      missionId: 'mission-a',
      traceId: 'trace-a',
      tenant: { userId: 'owner', workspaceId: 'workspace-a', accountId: 'Case-A' },
      input: { caption: 'hello', nested: { beta: 2, alpha: 1 } },
      requestedAt: '2026-07-14T00:00:00.000Z',
    });
    const second = makeRequest({
      missionId: 'mission-b',
      traceId: 'trace-b',
      tenant: { userId: 'owner', workspaceId: 'workspace-a', accountId: 'Case-A' },
      input: { nested: { alpha: 1, beta: 2 }, caption: 'hello' },
      requestedAt: '2026-07-15T00:00:00.000Z',
    });
    assert.equal(createRuntimeMissionPayloadHash(first), createRuntimeMissionPayloadHash(second));
  });

  it('changes for every exact action, workspace, account case/whitespace, provider, or payload mutation', () => {
    const base = makeRequest({
      action: 'autoposter.post.schedule',
      tenant: { userId: 'owner', workspaceId: 'workspace-a', accountId: 'Case-A' },
      input: { provider: 'tiktok', accountId: 'Case-A', caption: 'hello' },
    });
    const baseline = createRuntimeMissionPayloadHash(base);
    const mutations: RuntimeMissionRequest[] = [
      { ...base, action: 'autoposter.queue.list' },
      { ...base, tenant: { ...base.tenant, workspaceId: 'workspace-b' } },
      { ...base, tenant: { ...base.tenant, accountId: 'case-a' } },
      { ...base, tenant: { ...base.tenant, accountId: ' Case-A' } },
      { ...base, input: { ...base.input, provider: 'youtube' } },
      { ...base, input: { ...base.input, caption: 'changed' } },
    ];
    for (const mutation of mutations) {
      assert.notEqual(createRuntimeMissionPayloadHash(mutation), baseline);
    }
  });
});

describe('executeMission — dispatch and routing', () => {
  it('dispatches a supported action to the adapter and succeeds', async () => {
    const { adapter, calls } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(makeRequest(), { registry });

    assert.equal(result.status, 'succeeded');
    assert.equal(calls.length, 1);
    assert.deepEqual(result.output, { echoed: 'test.read' });
    assert.ok(result.evidence);
    assert.equal(result.evidence!.status, 'completed');
    assert.ok(result.durationMs >= 0);
  });

  it('rejects an unsupported action without invoking the adapter', async () => {
    const { adapter, calls } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(makeRequest({ action: 'test.unknown' }), { registry });

    assert.equal(result.status, 'denied');
    assert.equal(result.errors[0]!.code, 'UNSUPPORTED_ACTION');
    assert.equal(calls.length, 0);
  });

  it('rejects an unknown product without invoking anything', async () => {
    const { adapter } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(makeRequest({ product: 'clean_engine' }), { registry });

    assert.equal(result.status, 'denied');
    assert.equal(result.errors[0]!.code, 'UNKNOWN_PRODUCT');
  });

  it('fails envelope validation closed (missing actor/tenant)', async () => {
    const { adapter, calls } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(
      makeRequest({ actor: { id: '' }, tenant: { userId: ' ' } }),
      { registry }
    );

    assert.equal(result.status, 'validation_failed');
    const codes = result.errors.map((error) => error.code);
    assert.ok(codes.includes('MISSING_ACTOR'));
    assert.ok(codes.includes('MISSING_TENANT'));
    assert.equal(calls.length, 0);
  });

  it('preserves missionId and traceId through the result', async () => {
    const { adapter } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(
      makeRequest({ missionId: 'mission-42', traceId: 'trace-abc' }),
      { registry }
    );

    assert.equal(result.missionId, 'mission-42');
    assert.equal(result.traceId, 'trace-abc');
    // The trace id also survives into the task inputs recorded in evidence.
    assert.equal(result.evidence!.taskId.length > 0, true);
  });

  it('defaults traceId to missionId when omitted', async () => {
    const { adapter } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(makeRequest({ missionId: 'mission-7' }), { registry });
    assert.equal(result.traceId, 'mission-7');
  });

  it('refuses duplicate adapters for one product at registry construction', () => {
    const { adapter } = makeAdapter();
    const { adapter: second } = makeAdapter();
    assert.throws(() => createMissionAdapterRegistry([adapter, second]), /Duplicate mission adapter/);
  });
});

describe('executeMission — approval gate', () => {
  it('blocks a write action without approval and never reaches the adapter', async () => {
    const { adapter, calls } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(
      makeRequest({ action: 'test.write', idempotencyKey: 'key-1' }),
      { registry }
    );

    assert.equal(result.status, 'approval_required');
    assert.equal(result.approvalDecision.required, true);
    assert.equal(result.approvalDecision.approved, false);
    assert.equal(calls.length, 0);
    // Evidence shows the honest approval_required task state.
    assert.equal(result.evidence!.status, 'approval_required');
  });

  it('approved=true without approvedBy still refuses to execute', async () => {
    const { adapter, calls } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(
      makeRequest({ action: 'test.write', idempotencyKey: 'key-2', approval: { approved: true } }),
      { registry }
    );

    assert.equal(result.status, 'approval_required');
    assert.equal(calls.length, 0);
  });

  it('an approved write reaches the adapter and records the approver', async () => {
    const { adapter, calls } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(
      makeRequest({
        action: 'test.write',
        idempotencyKey: 'key-3',
        approval: { approved: true, approvedBy: 'founder' },
      }),
      { registry }
    );

    assert.equal(result.status, 'succeeded');
    assert.equal(calls.length, 1);
    assert.equal(result.approvalDecision.required, true);
    assert.equal(result.approvalDecision.approvedBy, 'founder');
  });

  it('a write action without an idempotency key fails closed before approval', async () => {
    const { adapter, calls } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(
      makeRequest({ action: 'test.write', approval: { approved: true, approvedBy: 'founder' } }),
      { registry }
    );

    assert.equal(result.status, 'validation_failed');
    assert.equal(result.errors[0]!.code, 'MISSING_IDEMPOTENCY_KEY');
    assert.equal(calls.length, 0);
  });
});

describe('executeMission — idempotency', () => {
  it('an exact mission replay does not execute twice and reports the authoritative mission', async () => {
    const { adapter, calls } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const store = createInMemoryIdempotencyStore();
    const base = {
      action: 'test.write',
      idempotencyKey: 'same-key',
      approval: { approved: true, approvedBy: 'founder' },
    };

    const first = await executeMission(makeRequest({ ...base, missionId: 'mission-a' }), {
      registry,
      idempotencyStore: store,
    });
    const second = await executeMission(makeRequest({ ...base, missionId: 'mission-a' }), {
      registry,
      idempotencyStore: store,
    });

    assert.equal(first.status, 'succeeded');
    assert.equal(first.idempotency.outcome, 'first_execution');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.idempotency.outcome, 'duplicate');
    assert.equal(second.idempotency.originalMissionId, 'mission-a');
    assert.equal(calls.length, 1);
    // The duplicate returns the original output rather than fabricating a new one.
    assert.deepEqual(second.output, first.output);
  });

  it('isolates the same caller key across workspaces while replaying within the original workspace', async () => {
    const calls: RuntimeMissionRequest[] = [];
    const { adapter } = makeAdapter({
      async execute(request) {
        calls.push(request);
        return { ok: true, output: { workspaceId: request.tenant.workspaceId ?? null } };
      },
    });
    const registry = createMissionAdapterRegistry([adapter]);
    const store = createInMemoryIdempotencyStore();
    const write = {
      action: 'test.write',
      idempotencyKey: 'same-caller-key',
      approval: { approved: true, approvedBy: 'founder' },
    };

    const workspaceA = await executeMission(
      makeRequest({ ...write, missionId: 'mission-a', tenant: { userId: 'owner', workspaceId: 'workspace-a' } }),
      { registry, idempotencyStore: store }
    );
    const workspaceB = await executeMission(
      makeRequest({ ...write, missionId: 'mission-b', tenant: { userId: 'owner', workspaceId: 'workspace-b' } }),
      { registry, idempotencyStore: store }
    );
    const replayA = await executeMission(
      makeRequest({ ...write, missionId: 'mission-a', tenant: { userId: 'owner', workspaceId: 'workspace-a' } }),
      { registry, idempotencyStore: store }
    );

    assert.equal(workspaceA.status, 'succeeded');
    assert.equal(workspaceB.status, 'succeeded');
    assert.deepEqual(workspaceB.output, { workspaceId: 'workspace-b' });
    assert.equal(replayA.status, 'duplicate');
    assert.equal(replayA.idempotency.key, 'same-caller-key', 'public result retains the caller key');
    assert.equal(replayA.idempotency.originalMissionId, 'mission-a');
    assert.deepEqual(replayA.output, { workspaceId: 'workspace-a' });
    assert.equal(calls.length, 2, 'workspace B executes once; only the replay in workspace A is deduplicated');
  });

  it('isolates one caller key across actions and exact canonical account ids', async () => {
    const calls: RuntimeMissionRequest[] = [];
    const { adapter } = makeAdapter({
      async execute(request) {
        calls.push(request);
        return {
          ok: true,
          output: { action: request.action, accountId: request.tenant.accountId ?? null },
        };
      },
    });
    const registry = createMissionAdapterRegistry([adapter]);
    const store = createInMemoryIdempotencyStore();
    const tenantA = { userId: 'owner', workspaceId: 'workspace-a', accountId: 'CaseSensitive-A' };
    const tenantB = { ...tenantA, accountId: 'casesensitive-a' };

    const read = await executeMission(
      makeRequest({ missionId: 'mission-read', action: 'test.read', tenant: tenantA, idempotencyKey: 'shared-key' }),
      { registry, idempotencyStore: store }
    );
    const writeA = await executeMission(
      makeRequest({
        missionId: 'mission-write-a',
        action: 'test.write',
        tenant: tenantA,
        idempotencyKey: 'shared-key',
        approval: { approved: true, approvedBy: 'founder' },
      }),
      { registry, idempotencyStore: store }
    );
    const writeB = await executeMission(
      makeRequest({
        missionId: 'mission-write-b',
        action: 'test.write',
        tenant: tenantB,
        idempotencyKey: 'shared-key',
        approval: { approved: true, approvedBy: 'founder' },
      }),
      { registry, idempotencyStore: store }
    );
    const replayA = await executeMission(
      makeRequest({
        missionId: 'mission-write-a',
        action: 'test.write',
        tenant: tenantA,
        idempotencyKey: 'shared-key',
        approval: { approved: true, approvedBy: 'founder' },
      }),
      { registry, idempotencyStore: store }
    );

    assert.equal(read.status, 'succeeded');
    assert.equal(writeA.status, 'succeeded');
    assert.equal(writeB.status, 'succeeded');
    assert.deepEqual(writeB.output, { action: 'test.write', accountId: 'casesensitive-a' });
    assert.equal(replayA.status, 'duplicate');
    assert.equal(replayA.idempotency.originalMissionId, 'mission-write-a');
    assert.equal(calls.length, 3);
  });

  it('an approval-refused mission does not consume its idempotency key', async () => {
    const { adapter, calls } = makeAdapter();
    const registry = createMissionAdapterRegistry([adapter]);
    const store = createInMemoryIdempotencyStore();

    const refused = await executeMission(
      makeRequest({ missionId: 'mission-a', action: 'test.write', idempotencyKey: 'retry-key' }),
      { registry, idempotencyStore: store }
    );
    const retried = await executeMission(
      makeRequest({
        missionId: 'mission-b',
        action: 'test.write',
        idempotencyKey: 'retry-key',
        approval: { approved: true, approvedBy: 'founder' },
      }),
      { registry, idempotencyStore: store }
    );

    assert.equal(refused.status, 'approval_required');
    assert.equal(retried.status, 'succeeded');
    assert.equal(calls.length, 1);
  });

  it('a denied execution does not consume its idempotency key', async () => {
    let attempts = 0;
    const { adapter } = makeAdapter({
      async execute() {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false,
            status: 'denied',
            errors: [{ code: 'AUTOPOSTER_FORBIDDEN', message: 'Quota denied.' }],
          };
        }
        return { ok: true, output: { accepted: true } };
      },
    });
    const registry = createMissionAdapterRegistry([adapter]);
    const store = createInMemoryIdempotencyStore();
    const request = {
      action: 'test.write',
      idempotencyKey: 'denial-retry-key',
      approval: { approved: true, approvedBy: 'founder' },
    };

    const denied = await executeMission(makeRequest({ ...request, missionId: 'mission-denied' }), {
      registry,
      idempotencyStore: store,
    });
    const retried = await executeMission(makeRequest({ ...request, missionId: 'mission-retried' }), {
      registry,
      idempotencyStore: store,
    });

    assert.equal(denied.status, 'denied');
    assert.equal(retried.status, 'succeeded');
    assert.equal(retried.idempotency.outcome, 'first_execution');
    assert.equal(attempts, 2);
  });

  it('coalesces concurrent same-scope execution and invokes the adapter once', async () => {
    let attempts = 0;
    const { adapter } = makeAdapter({
      async execute() {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, output: { accepted: true } };
      },
    });
    const registry = createMissionAdapterRegistry([adapter]);
    const store = createInMemoryIdempotencyStore();
    const base = {
      action: 'test.write',
      tenant: { userId: 'owner', workspaceId: 'workspace-a', accountId: 'Account-A' },
      idempotencyKey: 'concurrent-key',
      approval: { approved: true, approvedBy: 'founder' },
    };

    const [first, replay] = await Promise.all([
      executeMission(makeRequest({ ...base, missionId: 'mission-concurrent-a' }), { registry, idempotencyStore: store }),
      executeMission(makeRequest({ ...base, missionId: 'mission-concurrent-a' }), { registry, idempotencyStore: store }),
    ]);

    assert.equal(first.status, 'succeeded');
    assert.equal(first.idempotency.outcome, 'first_execution');
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.idempotency.outcome, 'duplicate');
    assert.equal(replay.idempotency.originalMissionId, 'mission-concurrent-a');
    assert.equal(attempts, 1);
  });

  it('shares a concurrent typed failure without automatically retrying it', async () => {
    let attempts = 0;
    const { adapter } = makeAdapter({
      async execute() {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ok: false,
          status: 'denied',
          errors: [{ code: 'AUTOPOSTER_ACCOUNT_DISCONNECTED', message: 'Reconnect the selected account.' }],
        };
      },
    });
    const registry = createMissionAdapterRegistry([adapter]);
    const store = createInMemoryIdempotencyStore();
    const base = {
      action: 'test.write',
      tenant: { userId: 'owner', workspaceId: 'workspace-a', accountId: 'Account-A' },
      idempotencyKey: 'concurrent-denial-key',
      approval: { approved: true, approvedBy: 'founder' },
    };

    const [first, replay] = await Promise.all([
      executeMission(makeRequest({ ...base, missionId: 'mission-denial-a' }), { registry, idempotencyStore: store }),
      executeMission(makeRequest({ ...base, missionId: 'mission-denial-a' }), { registry, idempotencyStore: store }),
    ]);
    assert.equal(first.status, 'denied');
    assert.equal(replay.status, 'denied');
    assert.equal(replay.errors[0]!.code, 'AUTOPOSTER_ACCOUNT_DISCONNECTED');
    assert.equal(replay.idempotency.outcome, 'duplicate');
    assert.equal(attempts, 1, 'the concurrent request shares the refusal instead of retrying');

    const manualRetry = await executeMission(makeRequest({ ...base, missionId: 'mission-denial-a' }), {
      registry,
      idempotencyStore: store,
    });
    assert.equal(manualRetry.status, 'denied');
    assert.equal(manualRetry.idempotency.outcome, 'first_execution');
    assert.equal(attempts, 2, 'a later explicit retry remains possible because failures are not cached');
  });

  it('rejects every independent replay-binding mutation without prior output or evidence', async () => {
    const baseline = makeRequest({
      missionId: 'mission-exact-binding',
      action: 'test.write',
      tenant: {
        userId: 'owner',
        workspaceId: 'workspace-a',
        accountId: 'CaseSensitive-Account',
      },
      input: {
        provider: 'tiktok',
        caption: 'baseline',
        scheduledAt: '2026-07-20T12:00:00.000Z',
      },
      idempotencyKey: 'Raw-Key-A',
      approval: { approved: true, approvedBy: 'founder' },
    });
    const mutations: Array<{
      label: string;
      request: RuntimeMissionRequest;
      code: string;
    }> = [
      { label: 'action', request: { ...baseline, action: 'test.read' }, code: 'RUNTIME_REPLAY_SCOPE_MISMATCH' },
      { label: 'workspace', request: { ...baseline, tenant: { ...baseline.tenant, workspaceId: 'workspace-b' } }, code: 'RUNTIME_REPLAY_SCOPE_MISMATCH' },
      { label: 'provider', request: { ...baseline, input: { ...baseline.input, provider: 'youtube' } }, code: 'RUNTIME_REPLAY_SCOPE_MISMATCH' },
      { label: 'account-value', request: { ...baseline, tenant: { ...baseline.tenant, accountId: 'Other-Account' } }, code: 'RUNTIME_REPLAY_SCOPE_MISMATCH' },
      { label: 'account-case', request: { ...baseline, tenant: { ...baseline.tenant, accountId: 'casesensitive-account' } }, code: 'RUNTIME_REPLAY_SCOPE_MISMATCH' },
      { label: 'account-whitespace', request: { ...baseline, tenant: { ...baseline.tenant, accountId: ' CaseSensitive-Account' } }, code: 'RUNTIME_REPLAY_SCOPE_MISMATCH' },
      { label: 'payload', request: { ...baseline, input: { ...baseline.input, caption: 'changed' } }, code: 'RUNTIME_PAYLOAD_MISMATCH' },
      { label: 'idempotency-key', request: { ...baseline, idempotencyKey: 'Raw-Key-B' }, code: 'RUNTIME_IDEMPOTENCY_MISMATCH' },
      { label: 'schedule', request: { ...baseline, input: { ...baseline.input, scheduledAt: '2026-07-20T12:00:00Z' } }, code: 'RUNTIME_PAYLOAD_MISMATCH' },
    ];

    for (const mutation of mutations) {
      const { adapter, calls } = makeAdapter();
      const registry = createMissionAdapterRegistry([adapter]);
      const store = createInMemoryIdempotencyStore();
      const first = await executeMission(baseline, { registry, idempotencyStore: store });
      const rejected = await executeMission(mutation.request, { registry, idempotencyStore: store });
      assert.equal(first.status, 'succeeded', mutation.label);
      assert.equal(rejected.status, 'validation_failed', mutation.label);
      assert.equal(rejected.errors[0]?.code, mutation.code, mutation.label);
      assert.equal(rejected.output, null, mutation.label);
      assert.equal(rejected.evidence, null, mutation.label);
      assert.equal(rejected.idempotency.outcome, 'mismatch', mutation.label);
      assert.equal(calls.length, 1, `${mutation.label}: mutation must create no downstream job`);
    }
  });

  it('places Runtime failure hooks on opposite sides of exact result persistence', async () => {
    let attempts = 0;
    const { adapter } = makeAdapter({
      async execute() {
        attempts += 1;
        return {
          ok: true,
          output: { post: { id: 'queue-exact-1' } },
        };
      },
    });
    const registry = createMissionAdapterRegistry([adapter]);
    const request = makeRequest({
      missionId: 'mission-runtime-boundaries',
      action: 'test.write',
      idempotencyKey: 'boundary-key',
      approval: { approved: true, approvedBy: 'founder' },
    });

    const beforeStore = createInMemoryIdempotencyStore();
    await assert.rejects(
      executeMission(request, {
        registry,
        idempotencyStore: beforeStore,
        failureInjector(boundary) {
          if (boundary === 'after_runtime_receives_queue_id_before_result_persistence') {
            throw new Error('injected-before-runtime-result-persistence');
          }
        },
      }),
      /injected-before-runtime-result-persistence/
    );
    assert.equal(beforeStore.getByMissionId(request.missionId), undefined);

    const afterStore = createInMemoryIdempotencyStore();
    await assert.rejects(
      executeMission(request, {
        registry,
        idempotencyStore: afterStore,
        failureInjector(boundary) {
          if (boundary === 'after_runtime_result_persistence') {
            throw new Error('injected-after-runtime-result-persistence');
          }
        },
      }),
      /injected-after-runtime-result-persistence/
    );
    assert.ok(afterStore.getByMissionId(request.missionId));
    const replay = await executeMission(request, { registry, idempotencyStore: afterStore });
    assert.equal(replay.status, 'duplicate');
    assert.equal(attempts, 2, 'the persisted result suppresses a third adapter execution');
  });
});

describe('executeMission — truthful failure propagation', () => {
  it('a downstream failure stays a failed result with the adapter errors', async () => {
    const { adapter } = makeAdapter({
      async execute() {
        return {
          ok: false,
          status: 'failed',
          errors: [{ code: 'DOWNSTREAM_FAILURE', message: 'AutoPoster storage write failed.' }],
        };
      },
    });
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(makeRequest(), { registry });

    assert.equal(result.status, 'failed');
    assert.equal(result.errors[0]!.code, 'DOWNSTREAM_FAILURE');
    assert.equal(result.evidence!.status, 'failed');
    assert.equal(result.evidence!.result!.success, false);
  });

  it('an adapter that reports unavailable maps to an unavailable result', async () => {
    const { adapter } = makeAdapter({
      async execute() {
        return {
          ok: false,
          status: 'unavailable',
          errors: [{ code: 'AUTOPOSTER_UNAVAILABLE', message: 'AutoPoster is unreachable.' }],
        };
      },
    });
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(makeRequest(), { registry });
    assert.equal(result.status, 'unavailable');
  });

  it('an adapter exception becomes a failed result, never success', async () => {
    const { adapter } = makeAdapter({
      async execute() {
        throw new Error('unexpected explosion');
      },
    });
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(makeRequest(), { registry });

    assert.equal(result.status, 'failed');
    assert.equal(result.errors[0]!.code, 'ADAPTER_EXCEPTION');
    assert.match(result.errors[0]!.message, /unexpected explosion/);
  });
});

describe('executeMission — redaction', () => {
  it('secrets in inputs, outputs, warnings, and errors are redacted in the result and evidence', async () => {
    const { adapter } = makeAdapter({
      async execute() {
        return {
          ok: false,
          status: 'failed',
          output: {
            apiKey: 'sk-verysecretkey12345678',
            note: 'TOKEN=abc123DEF456ghi789JKL012mno345PQR',
            caption: 'hello world',
          },
          warnings: ['Bearer sk-anothersecretvalue1234567890 leaked upstream'],
          errors: [{ code: 'LEAKY', message: 'PASSWORD=hunter2secret failed' }],
        };
      },
    });
    const registry = createMissionAdapterRegistry([adapter]);
    const result = await executeMission(
      makeRequest({ input: { accessToken: 'sk-inputsecret1234567890', caption: 'hello world' } }),
      { registry }
    );

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('sk-verysecretkey12345678'), 'output secret must be redacted');
    assert.ok(!serialized.includes('sk-anothersecretvalue1234567890'), 'warning secret must be redacted');
    assert.ok(!serialized.includes('hunter2secret'), 'error secret must be redacted');
    assert.ok(!serialized.includes('sk-inputsecret1234567890'), 'input secret must be redacted');
    assert.ok(serialized.includes('hello world'), 'ordinary content must survive');
  });
});
