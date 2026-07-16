/**
 * Loop Governor mission adapter tests: Master Plan §3 action properties,
 * closed-world input validation, truthful outcome mapping (created vs
 * duplicate, conflict, unavailable), payload-hash binding, and the full
 * executeMission chain (approval gate + idempotency key requirement).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOOP_GOVERNOR_ACTIONS,
  LOOP_GOVERNOR_DOWNSTREAM_OPERATION_TYPE,
  createLoopGovernorMissionAdapter,
} from '../../src/adapters/loopGovernorMissionAdapter.js';
import type {
  LoopGovernorManualLoopCreateParams,
  LoopGovernorMissionPort,
  LoopGovernorPortFailure,
} from '../../src/adapters/loopGovernorProcessPort.js';
import {
  createInMemoryIdempotencyStore,
  createMissionAdapterRegistry,
  createRuntimeMissionPayloadHash,
  executeMission,
  type RuntimeMissionRequest,
} from '../../src/missions.js';

function makePort(overrides: Partial<LoopGovernorMissionPort> = {}): {
  port: LoopGovernorMissionPort;
  createCalls: LoopGovernorManualLoopCreateParams[];
} {
  const createCalls: LoopGovernorManualLoopCreateParams[] = [];
  const port: LoopGovernorMissionPort = {
    async createManualLoop(params) {
      createCalls.push(params);
      return {
        ok: true,
        created: true,
        taskId: 'task-abc12345',
        loopId: 'loop-def67890',
        realAgentExecution: false,
      };
    },
    async lookupManualLoop() {
      return { ok: true, outcome: 'not_found', binding: null };
    },
    ...overrides,
  };
  return { port, createCalls };
}

function makeRequest(overrides: Partial<RuntimeMissionRequest> = {}): RuntimeMissionRequest {
  return {
    missionId: 'phase2c-mission-0001',
    traceId: 'phase2c-trace-0001',
    product: 'loop_governor',
    action: LOOP_GOVERNOR_ACTIONS.manualLoopCreate,
    actor: { id: 'chanter-operator', kind: 'service' },
    tenant: { userId: 'operator-tenant' },
    input: {
      appName: 'chanter-operator',
      taskType: 'review',
      goal: 'Review one Phase 2C adapter test artifact.',
      scope: 'adapter tests only',
    },
    approval: { approved: true, approvedBy: 'founder' },
    idempotencyKey: 'phase2c-key-0001',
    ...overrides,
  };
}

describe('loop governor mission adapter — action registration', () => {
  it('registers exactly the manual-loop action with the Master Plan properties', () => {
    const { port } = makePort();
    const adapter = createLoopGovernorMissionAdapter(port);
    assert.equal(adapter.product, 'loop_governor');
    assert.equal(adapter.actions.length, 1);
    const spec = adapter.actions[0]!;
    assert.equal(spec.action, 'loop_governor.manual_loop.create');
    assert.equal(spec.policyActionType, 'write');
    assert.equal(spec.riskLevel, 'medium');
    assert.equal(spec.executionPolicy, 'requires_approval');
    assert.equal(spec.requiresIdempotencyKey, true);
    assert.equal(spec.downstreamOperationType, LOOP_GOVERNOR_DOWNSTREAM_OPERATION_TYPE);
  });
});

describe('loop governor mission adapter — executeMission chain', () => {
  it('requires approval before the port is ever reached', async () => {
    const { port, createCalls } = makePort();
    const registry = createMissionAdapterRegistry([createLoopGovernorMissionAdapter(port)]);
    const result = await executeMission(
      makeRequest({ approval: undefined }),
      { registry, idempotencyStore: createInMemoryIdempotencyStore() },
    );
    assert.equal(result.status, 'approval_required');
    assert.equal(createCalls.length, 0);
  });

  it('requires an idempotency key before the port is ever reached', async () => {
    const { port, createCalls } = makePort();
    const registry = createMissionAdapterRegistry([createLoopGovernorMissionAdapter(port)]);
    const result = await executeMission(
      makeRequest({ idempotencyKey: undefined }),
      { registry, idempotencyStore: createInMemoryIdempotencyStore() },
    );
    assert.equal(result.status, 'validation_failed');
    assert.equal(result.errors[0]?.code, 'MISSING_IDEMPOTENCY_KEY');
    assert.equal(createCalls.length, 0);
  });

  it('executes an approved mission and binds the exact payload hash', async () => {
    const { port, createCalls } = makePort();
    const registry = createMissionAdapterRegistry([createLoopGovernorMissionAdapter(port)]);
    const request = makeRequest();
    const result = await executeMission(request, {
      registry,
      idempotencyStore: createInMemoryIdempotencyStore(),
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0]!.missionId, request.missionId);
    assert.equal(createCalls[0]!.payloadHash, createRuntimeMissionPayloadHash(request));
    assert.equal(createCalls[0]!.task.appName, 'chanter-operator');
    const output = result.output as Record<string, unknown>;
    const loop = output.loop as Record<string, unknown>;
    assert.equal(loop.loopId, 'loop-def67890');
    assert.equal(loop.taskId, 'task-abc12345');
    assert.equal(loop.created, true);
    assert.equal(output.realAgentExecution, false);
    assert.equal(result.evidence?.evidence.some(
      (item) => item.label === 'loop-governor-manual-loop',
    ), true);
  });

  it('reports an already-bound downstream loop as duplicate, never fresh success', async () => {
    const { port } = makePort({
      async createManualLoop() {
        return {
          ok: true,
          created: false,
          taskId: 'task-abc12345',
          loopId: 'loop-def67890',
          realAgentExecution: false,
        };
      },
    });
    const registry = createMissionAdapterRegistry([createLoopGovernorMissionAdapter(port)]);
    const result = await executeMission(makeRequest(), {
      registry,
      idempotencyStore: createInMemoryIdempotencyStore(),
    });
    assert.equal(result.status, 'duplicate');
    const output = result.output as Record<string, unknown>;
    assert.equal((output.loop as Record<string, unknown>).created, false);
  });
});

describe('loop governor mission adapter — closed-world input validation', () => {
  const cases: Array<{ name: string; input: Record<string, unknown>; code: string }> = [
    {
      name: 'unregistered input field',
      input: {
        appName: 'chanter-operator',
        taskType: 'review',
        goal: 'g',
        shellCommand: 'echo pwned',
      },
      code: 'LOOP_GOVERNOR_INPUT_UNSUPPORTED_FIELD',
    },
    {
      name: 'unknown task type',
      input: { appName: 'chanter-operator', taskType: 'exfiltrate', goal: 'g' },
      code: 'LOOP_GOVERNOR_INPUT_INVALID',
    },
    {
      name: 'missing goal',
      input: { appName: 'chanter-operator', taskType: 'review' },
      code: 'LOOP_GOVERNOR_INPUT_INVALID',
    },
    {
      name: 'non-string list items',
      input: {
        appName: 'chanter-operator',
        taskType: 'review',
        goal: 'g',
        allowedFiles: [42],
      },
      code: 'LOOP_GOVERNOR_INPUT_INVALID',
    },
    {
      name: 'invalid prompt mode',
      input: {
        appName: 'chanter-operator',
        taskType: 'review',
        goal: 'g',
        promptMode: 'verbose',
      },
      code: 'LOOP_GOVERNOR_INPUT_INVALID',
    },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name} before the port is reached`, async () => {
      const { port, createCalls } = makePort();
      const registry = createMissionAdapterRegistry([createLoopGovernorMissionAdapter(port)]);
      const result = await executeMission(
        makeRequest({ input: testCase.input as RuntimeMissionRequest['input'] }),
        { registry, idempotencyStore: createInMemoryIdempotencyStore() },
      );
      assert.equal(result.status, 'validation_failed');
      assert.equal(result.errors.some((error) => error.code === testCase.code), true);
      assert.equal(createCalls.length, 0);
    });
  }
});

describe('loop governor mission adapter — truthful failure mapping', () => {
  const failures: Array<{
    failure: LoopGovernorPortFailure;
    status: string;
    code: string;
  }> = [
    {
      failure: { ok: false, code: 'conflict', message: 'payload conflict' },
      status: 'failed',
      code: 'LOOP_GOVERNOR_PAYLOAD_CONFLICT',
    },
    {
      failure: { ok: false, code: 'timeout', message: 'timed out' },
      status: 'unavailable',
      code: 'LOOP_GOVERNOR_TIMEOUT',
    },
    {
      failure: { ok: false, code: 'unavailable', message: 'python missing' },
      status: 'unavailable',
      code: 'LOOP_GOVERNOR_UNAVAILABLE',
    },
    {
      failure: { ok: false, code: 'validation_failed', message: 'bad task' },
      status: 'validation_failed',
      code: 'LOOP_GOVERNOR_VALIDATION_FAILED',
    },
    {
      failure: { ok: false, code: 'invalid_response', message: 'garbage' },
      status: 'failed',
      code: 'LOOP_GOVERNOR_INVALID_RESPONSE',
    },
    {
      failure: { ok: false, code: 'internal', message: 'relay failed' },
      status: 'failed',
      code: 'LOOP_GOVERNOR_INTAKE_FAILED',
    },
  ];

  for (const { failure, status, code } of failures) {
    it(`maps port ${failure.code} to mission ${status} / ${code}`, async () => {
      const { port } = makePort({
        async createManualLoop() {
          return failure;
        },
      });
      const registry = createMissionAdapterRegistry([createLoopGovernorMissionAdapter(port)]);
      const result = await executeMission(makeRequest(), {
        registry,
        idempotencyStore: createInMemoryIdempotencyStore(),
      });
      assert.equal(result.status, status);
      assert.equal(result.errors[0]?.code, code);
    });
  }
});
