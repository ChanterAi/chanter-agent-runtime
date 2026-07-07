import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createTask,
  attachPlan,
  requireApproval,
  startExecution,
  startValidation,
  passValidation,
  completeTask,
  getAllowedNextStatuses,
  assertTransitionAllowed,
  isTerminalStatus,
  requiresApprovalBeforeExecution,
  RuntimeTransitionError,
} from '../src/index.js';
import type { RuntimeStatus } from '../src/index.js';

describe('isTerminalStatus', () => {
  it('classifies completed, failed, cancelled as terminal', () => {
    assert.strictEqual(isTerminalStatus('completed'), true);
    assert.strictEqual(isTerminalStatus('failed'), true);
    assert.strictEqual(isTerminalStatus('cancelled'), true);
  });

  it('classifies every other status as non-terminal', () => {
    const nonTerminal: RuntimeStatus[] = [
      'draft',
      'planned',
      'approval_required',
      'approved',
      'executing',
      'validating',
      'blocked',
    ];
    for (const status of nonTerminal) {
      assert.strictEqual(isTerminalStatus(status), false, `${status} should be non-terminal`);
    }
  });
});

describe('requiresApprovalBeforeExecution', () => {
  it('is false for low/medium risk on unguarded policies', () => {
    assert.strictEqual(requiresApprovalBeforeExecution({ riskLevel: 'low', executionPolicy: 'local_only' }), false);
    assert.strictEqual(
      requiresApprovalBeforeExecution({ riskLevel: 'medium', executionPolicy: 'advisory_only' }),
      false
    );
  });

  it('is true for high or critical risk regardless of policy', () => {
    assert.strictEqual(requiresApprovalBeforeExecution({ riskLevel: 'high', executionPolicy: 'local_only' }), true);
    assert.strictEqual(
      requiresApprovalBeforeExecution({ riskLevel: 'critical', executionPolicy: 'advisory_only' }),
      true
    );
  });

  it('is true for every guarded policy regardless of risk level', () => {
    const guarded = [
      'requires_approval',
      'requires_safecommit_review',
      'publish_guarded',
      'deploy_guarded',
      'commit_guarded',
    ] as const;
    for (const executionPolicy of guarded) {
      assert.strictEqual(
        requiresApprovalBeforeExecution({ riskLevel: 'low', executionPolicy }),
        true,
        `${executionPolicy} should require approval even at low risk`
      );
    }
  });
});

describe('getAllowedNextStatuses', () => {
  it('draft allows planned, blocked, cancelled only', () => {
    const task = createTask({ product: 'safecommit', objective: 'x' });
    assert.deepStrictEqual(getAllowedNextStatuses(task).sort(), ['blocked', 'cancelled', 'planned'].sort());
  });

  it('planned allows executing (not approval_required) when approval is not required', () => {
    const task = attachPlan(createTask({ product: 'safecommit', objective: 'x', riskLevel: 'low' }), {
      summary: 'plan',
    });
    assert.deepStrictEqual(getAllowedNextStatuses(task).sort(), ['blocked', 'cancelled', 'executing'].sort());
  });

  it('planned allows approval_required (not executing) when approval is required', () => {
    const task = attachPlan(createTask({ product: 'safecommit', objective: 'x', riskLevel: 'high' }), {
      summary: 'plan',
    });
    assert.deepStrictEqual(
      getAllowedNextStatuses(task).sort(),
      ['approval_required', 'blocked', 'cancelled'].sort()
    );
  });

  it('terminal statuses allow nothing', () => {
    const task = createTask({ product: 'safecommit', objective: 'x' });
    for (const status of ['completed', 'failed', 'cancelled'] as RuntimeStatus[]) {
      assert.deepStrictEqual(getAllowedNextStatuses({ ...task, status }), []);
    }
  });
});

describe('assertTransitionAllowed / invalid transitions', () => {
  it('rejects skipping straight from draft to executing', () => {
    const task = createTask({ product: 'safecommit', objective: 'x' });
    assert.throws(() => assertTransitionAllowed(task, 'executing'), RuntimeTransitionError);
  });

  it('rejects draft to completed', () => {
    const task = createTask({ product: 'safecommit', objective: 'x' });
    assert.throws(() => assertTransitionAllowed(task, 'completed'), RuntimeTransitionError);
  });

  it('rejects backward transitions (validating -> executing)', () => {
    let task = createTask({ product: 'safecommit', objective: 'x' });
    task = attachPlan(task, { summary: 'plan' });
    task = startExecution(task);
    task = startValidation(task);
    assert.throws(() => assertTransitionAllowed(task, 'executing'), RuntimeTransitionError);
  });

  it('rejects approval_required -> executing directly (must approve first)', () => {
    let task = createTask({ product: 'safecommit', objective: 'x', riskLevel: 'high' });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    assert.throws(() => startExecution(task), RuntimeTransitionError);
  });

  it('throws RuntimeTransitionError with structured from/to/allowed fields', () => {
    const task = createTask({ product: 'safecommit', objective: 'x' });
    try {
      assertTransitionAllowed(task, 'completed');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof RuntimeTransitionError);
      assert.strictEqual(err.from, 'draft');
      assert.strictEqual(err.to, 'completed');
      assert.deepStrictEqual(err.allowed.sort(), ['blocked', 'cancelled', 'planned'].sort());
    }
  });

  it('terminal states cannot mutate into execution', () => {
    let task = createTask({ product: 'safecommit', objective: 'x' });
    task = attachPlan(task, { summary: 'plan' });
    task = startExecution(task);
    task = startValidation(task);
    task = passValidation(task, { checks: [{ command: 'test', passed: true }] });
    task = completeTask(task, { summary: 'done' });
    assert.strictEqual(task.status, 'completed');

    assert.throws(() => startExecution(task), RuntimeTransitionError);
    assert.throws(() => assertTransitionAllowed(task, 'executing'), RuntimeTransitionError);
  });
});
