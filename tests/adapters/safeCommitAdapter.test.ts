import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  mapAdvisoryContractToRuntimeTask,
  buildSafeCommitEvidenceBundle,
  mapSafeCommitRiskLevel,
  SAMPLE_ADVISORY_CONTRACT,
} from '../../src/adapters/safeCommitAdapter.js';
import type { SafeCommitAdvisoryContractInput } from '../../src/adapters/safeCommitAdapter.js';
import { assertJsonSafe, approveTask, startExecution, startValidation, failValidation, failTask } from '../../src/index.js';

function contract(overrides: Partial<SafeCommitAdvisoryContractInput> = {}): SafeCommitAdvisoryContractInput {
  return { ...SAMPLE_ADVISORY_CONTRACT, ...overrides };
}

describe('mapSafeCommitRiskLevel', () => {
  it('maps SafeCommit risk buckets to RuntimeRiskLevel', () => {
    assert.strictEqual(mapSafeCommitRiskLevel('NONE'), 'low');
    assert.strictEqual(mapSafeCommitRiskLevel('LOW'), 'low');
    assert.strictEqual(mapSafeCommitRiskLevel('MODERATE'), 'medium');
    assert.strictEqual(mapSafeCommitRiskLevel('HIGH'), 'high');
  });
});

describe('mapAdvisoryContractToRuntimeTask: GREEN', () => {
  it('runs the task all the way to completed with a positive result', () => {
    const task = mapAdvisoryContractToRuntimeTask(contract());
    assert.strictEqual(task.product, 'safecommit');
    assert.strictEqual(task.executionPolicy, 'advisory_only');
    assert.strictEqual(task.riskLevel, 'low');
    assert.strictEqual(task.approvalRequired, false);
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.result?.success, true);
    assert.strictEqual(task.nextRecommendation?.action, 'proceed');
  });

  it('tags the advisory contract evidence with the safecommit_review guard event', () => {
    const task = mapAdvisoryContractToRuntimeTask(contract());
    assert.ok(task.logs.some((e) => e.type === 'SAFECOMMIT_REVIEW_ATTACHED'));
    assert.ok(task.evidence.some((e) => e.label === 'safecommit-advisory-contract'));
  });

  it('produces a JSON-safe evidence bundle', () => {
    const bundle = buildSafeCommitEvidenceBundle(contract());
    assert.strictEqual(bundle.status, 'completed');
    assert.doesNotThrow(() => assertJsonSafe(bundle));
  });
});

describe('mapAdvisoryContractToRuntimeTask: YELLOW', () => {
  it('completes with an escalate recommendation at medium risk', () => {
    const task = mapAdvisoryContractToRuntimeTask(
      contract({
        verdict: 'YELLOW',
        riskLevel: 'MODERATE',
        verdictReason: 'Moderate risk pattern detected in one file.',
        moderateRiskCount: 1,
      })
    );
    assert.strictEqual(task.riskLevel, 'medium');
    assert.strictEqual(task.approvalRequired, false);
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.result?.success, true);
    assert.strictEqual(task.nextRecommendation?.action, 'escalate');
    assert.strictEqual(task.nextRecommendation?.confidence, 'medium');
    assert.ok(task.evidence.some((e) => e.label.startsWith('risk-assessment-')));
  });
});

describe('mapAdvisoryContractToRuntimeTask: RED', () => {
  const redContract = contract({
    verdict: 'RED',
    riskLevel: 'HIGH',
    verdictReason: 'Severe risk: potential secret committed.',
    severeRiskCount: 1,
    validationPassed: false,
  });

  it('forces the approval gate instead of auto-completing', () => {
    const task = mapAdvisoryContractToRuntimeTask(redContract);
    assert.strictEqual(task.riskLevel, 'high');
    assert.strictEqual(task.approvalRequired, true);
    assert.strictEqual(task.status, 'approval_required', 'severe risk must not auto-complete');
    assert.strictEqual(task.result, undefined, 'no result should be fabricated while gated');
  });

  it('still attaches full evidence even though the gate is unresolved', () => {
    const task = mapAdvisoryContractToRuntimeTask(redContract);
    assert.ok(task.evidence.some((e) => e.label === 'safecommit-advisory-contract'));
    assert.ok(task.evidence.some((e) => e.label.startsWith('risk-assessment-')));
  });

  it('attaches a request_changes recommendation', () => {
    const task = mapAdvisoryContractToRuntimeTask(redContract);
    assert.strictEqual(task.nextRecommendation?.action, 'request_changes');
  });

  it('the resulting bundle is still JSON-safe even while gated', () => {
    const bundle = buildSafeCommitEvidenceBundle(redContract);
    assert.strictEqual(bundle.status, 'approval_required');
    assert.strictEqual(bundle.result, null);
    assert.doesNotThrow(() => assertJsonSafe(bundle));
  });

  it('can be resumed and driven to failed once a human explicitly approves inspecting it further', () => {
    // Demonstrates that the gate is real, not a dead end: the caller can
    // continue the exact same task through the ordinary runtime functions.
    let task = mapAdvisoryContractToRuntimeTask(redContract);
    task = approveTask(task, 'security-team');
    task = startExecution(task);
    task = startValidation(task);
    task = failValidation(task, { checks: [{ command: 'safecommit-advisory-verdict', passed: false }] });
    task = failTask(task, { summary: 'Confirmed unsafe; do not commit.' });
    assert.strictEqual(task.status, 'failed');
  });
});

describe('mapAdvisoryContractToRuntimeTask: safety invariant', () => {
  it('refuses to map a contract that claims to be a commit gate', () => {
    assert.throws(
      () => mapAdvisoryContractToRuntimeTask(contract({ isCommitGate: false as unknown as false, commitApproval: 'GRANTED' as unknown as 'NOT_GRANTED' })),
      /advisory-only guarantee/
    );
  });
});

describe('mapAdvisoryContractToRuntimeTask: no validation configured', () => {
  it('still completes using the synthetic advisory-verdict check', () => {
    const task = mapAdvisoryContractToRuntimeTask(
      contract({ validationConfigured: false, validationSummary: [], validationPassed: true })
    );
    assert.strictEqual(task.status, 'completed');
    assert.strictEqual(task.validationResult?.checks.length, 1);
    assert.strictEqual(task.validationResult?.checks[0].command, 'safecommit-advisory-verdict');
  });
});
