import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createTask,
  attachPlan,
  requireApproval,
  approveTask,
  startExecution,
  attachEvidence,
  RuntimeTransitionError,
} from '../src/index.js';

describe('approval gate: high/critical risk', () => {
  it('high risk task cannot execute straight after planning', () => {
    let task = createTask({ product: 'auto_poster', objective: 'Post to socials', riskLevel: 'high' });
    task = attachPlan(task, { summary: 'plan' });
    assert.strictEqual(task.approvalRequired, true);
    assert.throws(() => startExecution(task), RuntimeTransitionError);
  });

  it('critical risk task follows the full gate: planned -> approval_required -> approved -> executing', () => {
    let task = createTask({ product: 'auto_poster', objective: 'Post to socials', riskLevel: 'critical' });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    assert.strictEqual(task.status, 'approval_required');

    assert.throws(() => startExecution(task), RuntimeTransitionError, 'cannot execute before approveTask');

    task = approveTask(task, 'founder@chanter.dev', 'looks safe');
    assert.strictEqual(task.status, 'approved');

    task = startExecution(task);
    assert.strictEqual(task.status, 'executing');
  });

  it('medium risk does not require approval by itself', () => {
    const task = createTask({ product: 'clean_engine', objective: 'x', riskLevel: 'medium' });
    assert.strictEqual(task.approvalRequired, false);
  });
});

describe('approval gate: guarded execution policies', () => {
  const guardedPolicies = [
    'requires_approval',
    'requires_safecommit_review',
    'publish_guarded',
    'deploy_guarded',
    'commit_guarded',
  ] as const;

  for (const executionPolicy of guardedPolicies) {
    it(`${executionPolicy} forces the approval gate even at low risk`, () => {
      let task = createTask({ product: 'operator', objective: 'x', riskLevel: 'low', executionPolicy });
      task = attachPlan(task, { summary: 'plan' });
      assert.strictEqual(task.approvalRequired, true);
      assert.throws(() => startExecution(task), RuntimeTransitionError);

      task = requireApproval(task);
      task = approveTask(task);
      task = startExecution(task);
      assert.strictEqual(task.status, 'executing');
    });
  }

  it('requires_safecommit_review emits SAFECOMMIT_REVIEW_REQUIRED instead of generic APPROVAL_REQUIRED', () => {
    let task = createTask({
      product: 'safecommit',
      objective: 'x',
      executionPolicy: 'requires_safecommit_review',
    });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    assert.strictEqual(task.logs.at(-1)?.type, 'SAFECOMMIT_REVIEW_REQUIRED');
    assert.ok(!task.logs.some((e) => e.type === 'APPROVAL_REQUIRED'));
  });

  it('other guarded policies emit the generic APPROVAL_REQUIRED event', () => {
    let task = createTask({ product: 'operator', objective: 'x', executionPolicy: 'deploy_guarded' });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    assert.strictEqual(task.logs.at(-1)?.type, 'APPROVAL_REQUIRED');
  });

  it('attachEvidence tagged with a guard emits the matching *_GUARD_ATTACHED event', () => {
    let task = createTask({ product: 'auto_poster', objective: 'x', executionPolicy: 'publish_guarded' });
    task = attachPlan(task, { summary: 'plan' });
    task = requireApproval(task);
    task = approveTask(task);
    task = startExecution(task);
    task = attachEvidence(task, {
      type: 'note',
      label: 'publish-clearance',
      detail: 'content policy check passed',
      guard: 'publish',
    });
    assert.strictEqual(task.logs.at(-1)?.type, 'PUBLISH_GUARD_ATTACHED');
  });

  it('commit_guarded evidence emits COMMIT_GUARD_ATTACHED and deploy_guarded emits DEPLOY_GUARD_ATTACHED', () => {
    let commitTask = createTask({ product: 'safecommit', objective: 'x', executionPolicy: 'commit_guarded' });
    commitTask = attachEvidence(attachPlan(commitTask, { summary: 'p' }), {
      type: 'artifact',
      label: 'commit-guard',
      detail: 'ok',
      guard: 'commit',
    });
    assert.strictEqual(commitTask.logs.at(-1)?.type, 'COMMIT_GUARD_ATTACHED');

    let deployTask = createTask({ product: 'operator', objective: 'x', executionPolicy: 'deploy_guarded' });
    deployTask = attachEvidence(attachPlan(deployTask, { summary: 'p' }), {
      type: 'artifact',
      label: 'deploy-guard',
      detail: 'ok',
      guard: 'deploy',
    });
    assert.strictEqual(deployTask.logs.at(-1)?.type, 'DEPLOY_GUARD_ATTACHED');
  });

  it('safecommit_review guard tag on evidence emits SAFECOMMIT_REVIEW_ATTACHED', () => {
    let task = createTask({ product: 'safecommit', objective: 'x', executionPolicy: 'requires_safecommit_review' });
    task = attachEvidence(attachPlan(task, { summary: 'p' }), {
      type: 'artifact',
      label: 'safecommit-advisory-contract',
      detail: 'GREEN',
      guard: 'safecommit_review',
    });
    assert.strictEqual(task.logs.at(-1)?.type, 'SAFECOMMIT_REVIEW_ATTACHED');
  });
});

describe('approval gate: local/advisory policies stay ungated at low risk', () => {
  it('local_only and advisory_only do not require approval at low/medium risk', () => {
    const local = createTask({ product: 'clean_engine', objective: 'x', executionPolicy: 'local_only' });
    const advisory = createTask({
      product: 'safecommit',
      objective: 'x',
      executionPolicy: 'advisory_only',
      riskLevel: 'medium',
    });
    assert.strictEqual(local.approvalRequired, false);
    assert.strictEqual(advisory.approvalRequired, false);
  });

  it('but high risk still forces approval even on local_only', () => {
    const task = createTask({
      product: 'clean_engine',
      objective: 'x',
      executionPolicy: 'local_only',
      riskLevel: 'high',
    });
    assert.strictEqual(task.approvalRequired, true);
  });
});
