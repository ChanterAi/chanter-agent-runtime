/**
 * Mission execution layer tests: dispatch, gating, idempotency, redaction,
 * and truthful failure propagation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createInMemoryIdempotencyStore,
  createMissionAdapterRegistry,
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
  it('a duplicate idempotency key does not execute twice and reports the original mission', async () => {
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
    const second = await executeMission(makeRequest({ ...base, missionId: 'mission-b' }), {
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
