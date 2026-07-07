import { describe, it } from 'node:test';
import assert from 'node:assert';
import { runProductAdapter } from '../../src/adapters/runtimeAdapter.js';
import type { RuntimeProductAdapter } from '../../src/adapters/runtimeAdapter.js';
import {
  createTask,
  attachPlan,
  startExecution,
  startValidation,
  passValidation,
  completeTask,
  createEvidenceBundle,
  assertJsonSafe,
} from '../../src/index.js';
import type { RuntimeTask } from '../../src/index.js';

interface MockInput {
  objective: string;
}

function mapMockInput(input: MockInput): RuntimeTask {
  let task = createTask({ product: 'clean_engine', objective: input.objective, riskLevel: 'low' });
  task = attachPlan(task, { summary: 'mock plan' });
  task = startExecution(task);
  task = startValidation(task);
  task = passValidation(task, { checks: [{ command: 'mock-check', passed: true }] });
  task = completeTask(task, { summary: 'mock done' });
  return task;
}

const mockAdapter: RuntimeProductAdapter<MockInput> = {
  id: 'mock-adapter',
  product: 'clean_engine',
  version: '0.0.1',
  mapToRuntimeTask: mapMockInput,
  buildEvidenceBundle: (input) => createEvidenceBundle(mapMockInput(input)),
};

describe('RuntimeProductAdapter contract', () => {
  it('exposes id/product/version and the two mapping methods', () => {
    assert.strictEqual(mockAdapter.id, 'mock-adapter');
    assert.strictEqual(mockAdapter.product, 'clean_engine');
    assert.strictEqual(mockAdapter.version, '0.0.1');
    assert.strictEqual(typeof mockAdapter.mapToRuntimeTask, 'function');
    assert.strictEqual(typeof mockAdapter.buildEvidenceBundle, 'function');
  });

  it('mapToRuntimeTask produces a real, completed RuntimeTask', () => {
    const task = mockAdapter.mapToRuntimeTask({ objective: 'sanitize output' });
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.objective, 'sanitize output');
  });

  it('buildEvidenceBundle produces a JSON-safe bundle matching the mapped task', () => {
    const bundle = mockAdapter.buildEvidenceBundle({ objective: 'sanitize output' });
    assert.strictEqual(bundle.status, 'completed');
    assert.strictEqual(bundle.objective, 'sanitize output');
    assert.doesNotThrow(() => assertJsonSafe(bundle));
  });
});

describe('runProductAdapter', () => {
  it('runs an adapter against an input envelope and returns both task and bundle', () => {
    const result = runProductAdapter(mockAdapter, { input: { objective: 'run once' } });
    assert.strictEqual(result.task.objective, 'run once');
    assert.strictEqual(result.evidenceBundle.objective, 'run once');
    assert.strictEqual(result.task.id, result.evidenceBundle.taskId);
  });

  it('accepts optional correlationId/receivedAt envelope metadata without altering the mapping', () => {
    const result = runProductAdapter(mockAdapter, {
      input: { objective: 'traced run' },
      correlationId: 'req-123',
      receivedAt: '2026-07-01T00:00:00.000Z',
    });
    assert.strictEqual(result.task.objective, 'traced run');
    assert.strictEqual(result.task.status, 'completed');
  });
});
