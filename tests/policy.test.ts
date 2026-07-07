import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createTask,
  attachPlan,
  requireApproval,
  approveTask,
  startExecution,
  blockTask,
  startValidation,
  passValidation,
  completeTask,
} from '../src/index.js';
import { evaluateRuntimeActionPolicy } from '../src/policy.js';
import type { RuntimeActionType } from '../src/policy.js';

const ALL_ACTION_TYPES: RuntimeActionType[] = [
  'read',
  'write',
  'shell',
  'network',
  'commit',
  'deploy',
  'publish',
  'delete',
];

function baseRequest(actionType: RuntimeActionType, overrides: Partial<Parameters<typeof evaluateRuntimeActionPolicy>[1]> = {}) {
  return { actionType, target: 'irrelevant-target', reason: 'test', ...overrides };
}

describe('evaluateRuntimeActionPolicy: read', () => {
  it('is allowed at every non-terminal status', () => {
    const draft = createTask({ product: 'operator', objective: 'x' });
    assert.strictEqual(evaluateRuntimeActionPolicy(draft, baseRequest('read')).allowed, true);

    const blocked = blockTask(draft, 'stuck');
    const blockedDecision = evaluateRuntimeActionPolicy(blocked, baseRequest('read'));
    assert.strictEqual(blockedDecision.allowed, true);
    assert.strictEqual(blockedDecision.blocked, false);

    const highRisk = attachPlan(
      createTask({ product: 'operator', objective: 'x', riskLevel: 'critical' }),
      { summary: 'plan' }
    );
    const gated = requireApproval(highRisk);
    assert.strictEqual(evaluateRuntimeActionPolicy(gated, baseRequest('read')).allowed, true);
  });

  it('is blocked once the task is terminal', () => {
    let task = createTask({ product: 'operator', objective: 'x' });
    task = attachPlan(task, { summary: 'plan' });
    task = startExecution(task);
    task = startValidation(task);
    task = passValidation(task, { checks: [{ command: 'test', passed: true }] });
    task = completeTask(task, { summary: 'done' });

    const decision = evaluateRuntimeActionPolicy(task, baseRequest('read'));
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.blocked, true);
    assert.strictEqual(decision.approvalRequired, false);
  });
});

describe('evaluateRuntimeActionPolicy: write/shell/network status gate', () => {
  const mutatingTypes: RuntimeActionType[] = ['write', 'shell', 'network'];

  it('is not yet allowed on a draft task (no plan attached)', () => {
    const task = createTask({ product: 'operator', objective: 'x' });
    for (const actionType of mutatingTypes) {
      const decision = evaluateRuntimeActionPolicy(task, baseRequest(actionType));
      assert.strictEqual(decision.allowed, false, actionType);
      assert.strictEqual(decision.blocked, false, actionType);
      assert.strictEqual(decision.approvalRequired, false, actionType);
    }
  });

  it('is blocked while the task itself is blocked', () => {
    let task = createTask({ product: 'operator', objective: 'x' });
    task = attachPlan(task, { summary: 'plan' });
    task = blockTask(task, 'external dependency down');
    for (const actionType of mutatingTypes) {
      const decision = evaluateRuntimeActionPolicy(task, baseRequest(actionType));
      assert.strictEqual(decision.blocked, true, actionType);
      assert.strictEqual(decision.allowed, false, actionType);
    }
  });

  it('requires approval when planned and approvalRequired is true (high risk)', () => {
    let task = createTask({ product: 'operator', objective: 'x', riskLevel: 'high' });
    task = attachPlan(task, { summary: 'plan' });
    assert.strictEqual(task.approvalRequired, true);
    for (const actionType of mutatingTypes) {
      const decision = evaluateRuntimeActionPolicy(task, baseRequest(actionType));
      assert.strictEqual(decision.approvalRequired, true, actionType);
      assert.strictEqual(decision.allowed, false, actionType);
      assert.strictEqual(decision.blocked, false, actionType);
    }
  });

  it('is allowed once planned with no approval required (low risk, local_only)', () => {
    let task = createTask({ product: 'operator', objective: 'x', riskLevel: 'low' });
    task = attachPlan(task, { summary: 'plan' });
    assert.strictEqual(task.approvalRequired, false);
    for (const actionType of mutatingTypes) {
      const decision = evaluateRuntimeActionPolicy(task, baseRequest(actionType));
      assert.strictEqual(decision.allowed, true, actionType);
    }
  });

  it('still reports approvalRequired while sitting in approval_required', () => {
    let task = createTask({ product: 'operator', objective: 'x', riskLevel: 'high' });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    for (const actionType of mutatingTypes) {
      const decision = evaluateRuntimeActionPolicy(task, baseRequest(actionType));
      assert.strictEqual(decision.approvalRequired, true, actionType);
      assert.strictEqual(decision.allowed, false, actionType);
    }
  });

  it('is allowed once approved and executing', () => {
    let task = createTask({ product: 'operator', objective: 'x', riskLevel: 'high' });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    task = approveTask(task, 'reviewer');
    task = startExecution(task);
    for (const actionType of mutatingTypes) {
      const decision = evaluateRuntimeActionPolicy(task, baseRequest(actionType));
      assert.strictEqual(decision.allowed, true, actionType);
      assert.strictEqual(decision.approvalRequired, false, actionType);
    }
  });
});

describe('evaluateRuntimeActionPolicy: commit', () => {
  it('is blocked with requiredPolicy when the task lacks a commit-eligible policy', () => {
    let task = createTask({ product: 'safecommit', objective: 'x', executionPolicy: 'local_only' });
    task = attachPlan(task, { summary: 'plan' });
    const decision = evaluateRuntimeActionPolicy(task, baseRequest('commit'));
    assert.strictEqual(decision.blocked, true);
    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(decision.requiredPolicy, 'commit_guarded');
  });

  it('is allowed once commit_guarded and past the approval gate', () => {
    let task = createTask({ product: 'safecommit', objective: 'x', executionPolicy: 'commit_guarded' });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    task = approveTask(task);
    task = startExecution(task);
    const decision = evaluateRuntimeActionPolicy(task, baseRequest('commit'));
    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.requiredPolicy, undefined);
  });

  it('accepts requires_safecommit_review as an alternative commit-eligible policy', () => {
    let task = createTask({
      product: 'safecommit',
      objective: 'x',
      executionPolicy: 'requires_safecommit_review',
    });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    task = approveTask(task);
    task = startExecution(task);
    assert.strictEqual(evaluateRuntimeActionPolicy(task, baseRequest('commit')).allowed, true);
  });
});

describe('evaluateRuntimeActionPolicy: deploy', () => {
  it('is blocked with requiredPolicy=deploy_guarded on a mismatched policy', () => {
    const task = createTask({ product: 'operator', objective: 'x', executionPolicy: 'publish_guarded' });
    const decision = evaluateRuntimeActionPolicy(task, baseRequest('deploy'));
    assert.strictEqual(decision.blocked, true);
    assert.strictEqual(decision.requiredPolicy, 'deploy_guarded');
  });

  it('is allowed once deploy_guarded and approved', () => {
    let task = createTask({ product: 'operator', objective: 'x', executionPolicy: 'deploy_guarded' });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    task = approveTask(task);
    task = startExecution(task);
    assert.strictEqual(evaluateRuntimeActionPolicy(task, baseRequest('deploy')).allowed, true);
  });
});

describe('evaluateRuntimeActionPolicy: publish', () => {
  it('is blocked with requiredPolicy=publish_guarded on a mismatched policy', () => {
    const task = createTask({ product: 'auto_poster', objective: 'x', executionPolicy: 'local_only' });
    const decision = evaluateRuntimeActionPolicy(task, baseRequest('publish'));
    assert.strictEqual(decision.blocked, true);
    assert.strictEqual(decision.requiredPolicy, 'publish_guarded');
  });

  it('is allowed once publish_guarded and approved', () => {
    let task = createTask({ product: 'auto_poster', objective: 'x', executionPolicy: 'publish_guarded' });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    task = approveTask(task);
    task = startExecution(task);
    assert.strictEqual(evaluateRuntimeActionPolicy(task, baseRequest('publish')).allowed, true);
  });
});

describe('evaluateRuntimeActionPolicy: delete', () => {
  it('is blocked by default', () => {
    const task = createTask({ product: 'clean_engine', objective: 'x' });
    const decision = evaluateRuntimeActionPolicy(task, baseRequest('delete'));
    assert.strictEqual(decision.blocked, true);
    assert.strictEqual(decision.allowed, false);
  });

  it('is not blocked (but still not allowed) when dryRun=true', () => {
    const task = createTask({ product: 'clean_engine', objective: 'x' });
    const decision = evaluateRuntimeActionPolicy(task, baseRequest('delete', { dryRun: true }));
    assert.strictEqual(decision.blocked, false);
    assert.strictEqual(decision.allowed, false);
    assert.ok(decision.reasons.some((r) => /not yet implemented|explicit/.test(r)));
  });
});

describe('evaluateRuntimeActionPolicy: terminal task blocking', () => {
  it('blocks every action type once a task is completed', () => {
    let task = createTask({ product: 'operator', objective: 'x' });
    task = attachPlan(task, { summary: 'plan' });
    task = startExecution(task);
    task = startValidation(task);
    task = passValidation(task, { checks: [{ command: 'test', passed: true }] });
    task = completeTask(task, { summary: 'done' });

    for (const actionType of ALL_ACTION_TYPES) {
      const decision = evaluateRuntimeActionPolicy(task, baseRequest(actionType));
      assert.strictEqual(decision.blocked, true, actionType);
      assert.strictEqual(decision.allowed, false, actionType);
      assert.strictEqual(decision.approvalRequired, false, actionType);
    }
  });
});

describe('evaluateRuntimeActionPolicy: dryRun behavior', () => {
  it('never reports allowed=true for a dryRun request, even when the underlying action would be allowed', () => {
    let task = createTask({ product: 'operator', objective: 'x', riskLevel: 'low' });
    task = attachPlan(task, { summary: 'plan' });
    task = startExecution(task);

    const live = evaluateRuntimeActionPolicy(task, baseRequest('write'));
    assert.strictEqual(live.allowed, true);

    const dryRun = evaluateRuntimeActionPolicy(task, baseRequest('write', { dryRun: true }));
    assert.strictEqual(dryRun.allowed, false);
    assert.strictEqual(dryRun.blocked, false);
    assert.strictEqual(dryRun.approvalRequired, false);
    assert.ok(dryRun.reasons.some((r) => r.includes('dryRun=true')));
  });

  it('does not add a redundant dryRun note when the action was already disallowed', () => {
    const task = createTask({ product: 'operator', objective: 'x' });
    const live = evaluateRuntimeActionPolicy(task, baseRequest('write'));
    const dryRun = evaluateRuntimeActionPolicy(task, baseRequest('write', { dryRun: true }));
    assert.strictEqual(live.allowed, false);
    assert.strictEqual(dryRun.allowed, false);
    assert.deepStrictEqual(dryRun.reasons, live.reasons);
  });
});
