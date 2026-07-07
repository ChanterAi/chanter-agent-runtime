import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createTask,
  attachPlan,
  startExecution,
  attachEvidence,
  startValidation,
  passValidation,
  completeTask,
  blockTask,
  cancelTask,
} from '../src/index.js';

describe('createTask', () => {
  it('creates a task in draft status with sensible defaults', () => {
    const task = createTask({ product: 'safecommit', objective: 'Review a diff' });
    assert.strictEqual(task.status, 'draft');
    assert.strictEqual(task.product, 'safecommit');
    assert.strictEqual(task.objective, 'Review a diff');
    assert.strictEqual(task.riskLevel, 'low');
    assert.strictEqual(task.executionPolicy, 'local_only');
    assert.strictEqual(task.approvalRequired, false);
    assert.deepStrictEqual(task.evidence, []);
    assert.deepStrictEqual(task.validationCommands, []);
    assert.strictEqual(task.plan, undefined);
    assert.strictEqual(task.result, undefined);
    assert.ok(task.id.length > 0);
    assert.ok(task.createdAt);
    assert.strictEqual(task.createdAt, task.updatedAt);
  });

  it('generates unique ids across multiple calls', () => {
    const a = createTask({ product: 'safecommit', objective: 'a' });
    const b = createTask({ product: 'safecommit', objective: 'b' });
    assert.notStrictEqual(a.id, b.id);
  });

  it('respects explicit riskLevel and executionPolicy and derives approvalRequired', () => {
    const task = createTask({
      product: 'auto_poster',
      objective: 'Publish a post',
      riskLevel: 'medium',
      executionPolicy: 'publish_guarded',
    });
    assert.strictEqual(task.riskLevel, 'medium');
    assert.strictEqual(task.executionPolicy, 'publish_guarded');
    assert.strictEqual(task.approvalRequired, true);
  });

  it('records a TASK_CREATED event as the first log entry', () => {
    const task = createTask({ product: 'safecommit', objective: 'Review a diff' });
    assert.strictEqual(task.logs.length, 1);
    assert.strictEqual(task.logs[0].type, 'TASK_CREATED');
    assert.strictEqual(task.logs[0].taskId, task.id);
  });
});

describe('lifecycle happy path (low risk, local_only, no approval needed)', () => {
  it('runs draft -> planned -> executing -> validating -> completed', () => {
    let task = createTask({ product: 'clean_engine', objective: 'Sanitize output', riskLevel: 'low' });
    assert.strictEqual(task.status, 'draft');

    task = attachPlan(task, { summary: 'Scan and redact', steps: [{ description: 'scan' }, { description: 'redact' }] });
    assert.strictEqual(task.status, 'planned');
    assert.ok(task.plan);
    assert.strictEqual(task.plan?.steps.length, 2);

    task = startExecution(task);
    assert.strictEqual(task.status, 'executing');

    task = attachEvidence(task, { type: 'log', label: 'scan-log', detail: 'no secrets found' });
    assert.strictEqual(task.evidence.length, 1);

    task = startValidation(task);
    assert.strictEqual(task.status, 'validating');

    task = passValidation(task, { checks: [{ command: 'npm test', passed: true }] });
    assert.strictEqual(task.validationResult?.passed, true);
    assert.strictEqual(task.status, 'validating', 'passValidation should not itself change status');

    task = completeTask(task, { summary: 'Output sanitized successfully' });
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.result?.success, true);
    assert.strictEqual(task.result?.summary, 'Output sanitized successfully');
  });

  it('low-risk local task can execute without ever entering approval_required', () => {
    let task = createTask({ product: 'clean_engine', objective: 'x', riskLevel: 'low', executionPolicy: 'local_only' });
    task = attachPlan(task, { summary: 'plan' });
    assert.strictEqual(task.approvalRequired, false);
    task = startExecution(task);
    assert.strictEqual(task.status, 'executing');
    assert.ok(!task.logs.some((e) => e.type === 'APPROVAL_REQUIRED'));
  });
});

describe('event log ordering', () => {
  it('appends events in the exact order operations were performed', () => {
    let task = createTask({ product: 'safecommit', objective: 'x' });
    task = attachPlan(task, { summary: 'plan' });
    task = startExecution(task);
    task = attachEvidence(task, { type: 'note', label: 'n', detail: 'd' });
    task = startValidation(task);
    task = passValidation(task, { checks: [{ command: 'c', passed: true }] });
    task = completeTask(task, { summary: 'done' });

    assert.deepStrictEqual(
      task.logs.map((e) => e.type),
      [
        'TASK_CREATED',
        'PLAN_ATTACHED',
        'EXECUTION_STARTED',
        'EVIDENCE_ATTACHED',
        'VALIDATION_STARTED',
        'VALIDATION_PASSED',
        'TASK_COMPLETED',
      ]
    );
  });

  it('timestamps are non-decreasing across the log', () => {
    let task = createTask({ product: 'safecommit', objective: 'x' });
    task = attachPlan(task, { summary: 'plan' });
    task = startExecution(task);

    const timestamps = task.logs.map((e) => Date.parse(e.timestamp));
    for (let i = 1; i < timestamps.length; i++) {
      assert.ok(timestamps[i] >= timestamps[i - 1], 'timestamps must be non-decreasing');
    }
  });
});

describe('updatedAt', () => {
  it('changes after every mutation, even ones fired back-to-back synchronously', () => {
    let task = createTask({ product: 'safecommit', objective: 'x' });
    const seen = new Set([task.updatedAt]);

    task = attachPlan(task, { summary: 'plan' });
    assert.ok(!seen.has(task.updatedAt));
    seen.add(task.updatedAt);

    task = startExecution(task);
    assert.ok(!seen.has(task.updatedAt));
    seen.add(task.updatedAt);

    task = attachEvidence(task, { type: 'note', label: 'n', detail: 'd' });
    assert.ok(!seen.has(task.updatedAt));
    seen.add(task.updatedAt);

    assert.strictEqual(seen.size, 4);
  });

  it('does not change createdAt', () => {
    let task = createTask({ product: 'safecommit', objective: 'x' });
    const createdAt = task.createdAt;
    task = attachPlan(task, { summary: 'plan' });
    task = startExecution(task);
    assert.strictEqual(task.createdAt, createdAt);
  });
});

describe('blocked task recovery', () => {
  it('any non-terminal status can be blocked, and blocked recovers via attachPlan -> planned', () => {
    let task = createTask({ product: 'loop_governor', objective: 'x' });
    task = attachPlan(task, { summary: 'first plan' });
    task = blockTask(task, 'External dependency unavailable');
    assert.strictEqual(task.status, 'blocked');
    assert.strictEqual(task.logs.at(-1)?.type, 'TASK_BLOCKED');

    task = attachPlan(task, { summary: 'revised plan after unblocking' });
    assert.strictEqual(task.status, 'planned');
    assert.strictEqual(task.plan?.summary, 'revised plan after unblocking');
  });

  it('blocked task can still be cancelled', () => {
    let task = createTask({ product: 'loop_governor', objective: 'x' });
    task = blockTask(task, 'stuck');
    task = cancelTask(task, 'giving up');
    assert.strictEqual(task.status, 'cancelled');
  });
});

describe('cancellation', () => {
  it('cancels a task from executing and attaches a failing result', () => {
    let task = createTask({ product: 'safecommit', objective: 'x' });
    task = attachPlan(task, { summary: 'plan' });
    task = startExecution(task);
    task = cancelTask(task, 'user requested stop');
    assert.strictEqual(task.status, 'cancelled');
    assert.strictEqual(task.result?.success, false);
    assert.match(task.result?.summary ?? '', /user requested stop/);
  });
});
