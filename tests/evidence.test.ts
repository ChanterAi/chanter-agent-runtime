import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createTask,
  attachPlan,
  startExecution,
  attachEvidence,
  startValidation,
  passValidation,
  failValidation,
  completeTask,
  failTask,
  attachRecommendation,
  createEvidenceBundle,
  summarizeTaskForReview,
  assertJsonSafe,
} from '../src/index.js';

function runToValidating() {
  let task = createTask({ product: 'safecommit', objective: 'Review PR #42', riskLevel: 'medium' });
  task = attachPlan(task, { summary: 'Run checks and scan risk' });
  task = startExecution(task);
  task = attachEvidence(task, { type: 'command_output', label: 'npm test output', detail: 'All green' });
  task = startValidation(task);
  return task;
}

describe('evidence attachment', () => {
  it('appends evidence with a generated id and timestamp', () => {
    let task = createTask({ product: 'safecommit', objective: 'x' });
    task = attachEvidence(task, { type: 'file', label: 'diff.patch', detail: '12 lines changed' });
    assert.strictEqual(task.evidence.length, 1);
    assert.ok(task.evidence[0].id);
    assert.ok(task.evidence[0].createdAt);
    assert.strictEqual(task.evidence[0].label, 'diff.patch');
  });

  it('accumulates multiple evidence items in order', () => {
    let task = createTask({ product: 'safecommit', objective: 'x' });
    task = attachEvidence(task, { type: 'note', label: 'first', detail: 'a' });
    task = attachEvidence(task, { type: 'note', label: 'second', detail: 'b' });
    assert.deepStrictEqual(
      task.evidence.map((e) => e.label),
      ['first', 'second']
    );
  });

  it('rejects attaching evidence to a terminal task', () => {
    let task = runToValidating();
    task = passValidation(task, { checks: [{ command: 'npm test', passed: true }] });
    task = completeTask(task, { summary: 'done' });
    assert.throws(() => attachEvidence(task, { type: 'note', label: 'late', detail: 'x' }), /terminal/);
  });
});

describe('validation pass/fail', () => {
  it('passValidation attaches a passing result without changing status', () => {
    let task = runToValidating();
    task = passValidation(task, {
      checks: [
        { command: 'npm run typecheck', passed: true },
        { command: 'npm test', passed: true },
      ],
    });
    assert.strictEqual(task.status, 'validating');
    assert.strictEqual(task.validationResult?.passed, true);
    assert.strictEqual(task.validationResult?.checks.length, 2);
  });

  it('failValidation attaches a failing result without changing status', () => {
    let task = runToValidating();
    task = failValidation(task, {
      checks: [
        { command: 'npm run typecheck', passed: true },
        { command: 'npm test', passed: false, message: '3 tests failed' },
      ],
    });
    assert.strictEqual(task.status, 'validating');
    assert.strictEqual(task.validationResult?.passed, false);
  });

  it('passValidation throws if any check actually failed', () => {
    const task = runToValidating();
    assert.throws(
      () => passValidation(task, { checks: [{ command: 'npm test', passed: false }] }),
      /use failValidation instead/
    );
  });

  it('failValidation throws if all checks actually passed', () => {
    const task = runToValidating();
    assert.throws(
      () => failValidation(task, { checks: [{ command: 'npm test', passed: true }] }),
      /use passValidation instead/
    );
  });

  it('completeTask requires a prior passing validationResult', () => {
    const task = runToValidating();
    assert.throws(() => completeTask(task, { summary: 'done' }), /validation has not passed/);
  });

  it('failTask moves validating -> failed and attaches a failing result', () => {
    let task = runToValidating();
    task = failValidation(task, { checks: [{ command: 'npm test', passed: false }] });
    task = failTask(task, { summary: 'Tests failed in CI' });
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.result?.success, false);
    assert.strictEqual(task.result?.summary, 'Tests failed in CI');
  });

  it('completeTask moves validating -> completed and attaches a passing result', () => {
    let task = runToValidating();
    task = passValidation(task, { checks: [{ command: 'npm test', passed: true }] });
    task = completeTask(task, { summary: 'Shipped', output: { filesChanged: 3 } });
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.result?.success, true);
    assert.deepStrictEqual(task.result?.output, { filesChanged: 3 });
  });
});

describe('recommendation attachment', () => {
  it('attaches a recommendation to a non-terminal task', () => {
    let task = createTask({ product: 'safecommit', objective: 'x' });
    task = attachRecommendation(task, { action: 'proceed', reason: 'Low risk, no blockers.' });
    assert.strictEqual(task.nextRecommendation?.action, 'proceed');
    assert.strictEqual(task.logs.at(-1)?.type, 'RECOMMENDATION_ATTACHED');
  });

  it('can attach a recommendation after the task is already terminal (Result -> Next Recommendation)', () => {
    let task = runToValidating();
    task = passValidation(task, { checks: [{ command: 'npm test', passed: true }] });
    task = completeTask(task, { summary: 'done' });
    assert.strictEqual(task.status, 'completed');

    task = attachRecommendation(task, {
      action: 'proceed',
      reason: 'Proceed to the next guarded task (deploy_guarded).',
      confidence: 'high',
    });
    assert.strictEqual(task.status, 'completed', 'attaching a recommendation must not change status');
    assert.strictEqual(task.nextRecommendation?.action, 'proceed');
  });
});

describe('createEvidenceBundle', () => {
  it('produces a JSON-safe bundle with the required fields', () => {
    let task = runToValidating();
    task = passValidation(task, { checks: [{ command: 'npm test', passed: true }] });
    task = completeTask(task, { summary: 'done' });
    task = attachRecommendation(task, { action: 'proceed', reason: 'ship it' });

    const bundle = createEvidenceBundle(task);
    assert.strictEqual(bundle.taskId, task.id);
    assert.strictEqual(bundle.product, task.product);
    assert.strictEqual(bundle.objective, task.objective);
    assert.strictEqual(bundle.riskLevel, task.riskLevel);
    assert.strictEqual(bundle.executionPolicy, task.executionPolicy);
    assert.strictEqual(bundle.status, 'completed');
    assert.strictEqual(bundle.planSummary, task.plan?.summary);
    assert.ok(Array.isArray(bundle.evidence));
    assert.ok(Array.isArray(bundle.validationCommands));
    assert.strictEqual(bundle.validationResult?.passed, true);
    assert.strictEqual(bundle.result?.success, true);
    assert.ok(Array.isArray(bundle.eventLogSummary));
    assert.ok(bundle.eventLogSummary.length > 0);
    assert.strictEqual(bundle.nextRecommendation?.action, 'proceed');
    assert.ok(bundle.createdAt);
    assert.ok(bundle.updatedAt);
    assert.ok(bundle.generatedAt);

    assert.doesNotThrow(() => assertJsonSafe(bundle, 'bundle'));
  });

  it('uses null (not undefined) for absent optional fields, staying JSON-safe', () => {
    const task = createTask({ product: 'safecommit', objective: 'x' });
    const bundle = createEvidenceBundle(task);
    assert.strictEqual(bundle.planSummary, null);
    assert.strictEqual(bundle.validationResult, null);
    assert.strictEqual(bundle.result, null);
    assert.strictEqual(bundle.nextRecommendation, null);
    const json = JSON.stringify(bundle);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.planSummary, null);
  });

  it('event log summary omits internal taskId/data noise, keeping only type/timestamp/message', () => {
    const task = createTask({ product: 'safecommit', objective: 'x' });
    const bundle = createEvidenceBundle(task);
    const keys = Object.keys(bundle.eventLogSummary[0]).sort();
    assert.deepStrictEqual(keys, ['message', 'timestamp', 'type']);
  });
});

describe('summarizeTaskForReview', () => {
  it('produces a text block and structured fields', () => {
    let task = runToValidating();
    task = passValidation(task, { checks: [{ command: 'npm test', passed: true }] });
    task = completeTask(task, { summary: 'done' });

    const review = summarizeTaskForReview(task);
    assert.match(review.text, /Task .* — safecommit/);
    assert.strictEqual(review.fields.status, 'completed');
    assert.strictEqual(review.fields.validationPassed, true);
    assert.strictEqual(review.fields.evidenceCount, task.evidence.length);
  });

  it('reports validationPassed as null when validation has not run', () => {
    const task = createTask({ product: 'safecommit', objective: 'x' });
    const review = summarizeTaskForReview(task);
    assert.strictEqual(review.fields.validationPassed, null);
  });
});
