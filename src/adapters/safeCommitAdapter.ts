/**
 * CHANTER Agent Runtime — SafeCommit adapter.
 *
 * Maps a SafeCommit P1.1 AdvisoryContract (the stable, downstream-facing
 * summary SafeCommit already writes to ADVISORY_CONTRACT.json) into a real
 * RuntimeTask, by driving it through the actual runtime lifecycle functions
 * rather than hand-assembling an evidence bundle shape. This is a read-only,
 * pure transformation: no SafeCommit code is imported, no git/network/file
 * I/O happens here, and SafeCommit's own source is never modified.
 *
 * `SafeCommitAdvisoryContractInput` is a deliberate structural mirror of
 * `AdvisoryContract` in apps/SafeCommit/src/advisoryContract.ts (verified
 * field-for-field against that file). It is duplicated rather than imported
 * so this package never takes a cross-repo dependency on SafeCommit's
 * package (SafeCommit ships its own independent package.json/node_modules),
 * matching the existing contract-only adapter convention already used
 * elsewhere in this repo (see apps/CHANTER Operator's agentRuntime/adapters).
 *
 * SAFETY: SafeCommit's contract guarantees isCommitGate=false and
 * commitApproval='NOT_GRANTED' — this adapter asserts that invariant and
 * refuses to map an input that violates it. This adapter never grants
 * commit approval either; it only ever records evidence and, when risk
 * is high, an unresolved approval_required gate.
 */
import type { RuntimeRecommendationAction, RuntimeRiskLevel, RuntimeTask } from '../types.js';
import {
  attachEvidence,
  attachPlan,
  attachRecommendation,
  completeTask,
  createTask,
  failTask,
  passValidation,
  requireApproval,
  startExecution,
  startValidation,
  failValidation,
} from '../tasks.js';
import { createEvidenceBundle, type RuntimeEvidenceBundle } from '../evidence.js';
import type { RuntimeProductAdapter } from './runtimeAdapter.js';

/** SafeCommit's P1.0 advisory verdict — human-readable, no false trust. */
export type SafeCommitVerdict = 'GREEN' | 'YELLOW' | 'RED';

/** SafeCommit's own coarse risk bucket, distinct from RuntimeRiskLevel. */
export type SafeCommitContractRiskLevel = 'NONE' | 'LOW' | 'MODERATE' | 'HIGH';

/**
 * Structural mirror of SafeCommit's `AdvisoryContract`
 * (apps/SafeCommit/src/advisoryContract.ts). Field names and types are
 * copied verbatim; see the module doc comment for why this isn't imported.
 */
export interface SafeCommitAdvisoryContractInput {
  schema: 'safecommit-advisory/v1';
  mode: 'ADVISORY_ONLY';
  isCommitGate: false;
  repoPath: string;
  timestamp: string;
  branch: string;
  headCommit: string;
  verdict: SafeCommitVerdict;
  verdictReason: string;
  riskLevel: SafeCommitContractRiskLevel;
  changedFileCount: number;
  trackedModifiedCount: number;
  stagedCount: number;
  untrackedCount: number;
  diffCheckPassed: boolean;
  validationConfigured: boolean;
  validationPassed: boolean;
  validationSummary: Array<{ command: string; status: string }>;
  severeRiskCount: number;
  moderateRiskCount: number;
  blockedPathCount: number;
  blockerCount: number;
  warningCount: number;
  commitApproval: 'NOT_GRANTED';
  commitRecommendation: 'REVIEW_RECOMMENDED';
  recommendedNextAction: string;
  topBlockers: string[];
  topWarnings: string[];
}

export interface SafeCommitAdapterOptions {
  /** Override the generated task id (default: derived from branch + headCommit). */
  taskId?: string;
}

/** NONE/LOW -> low, MODERATE -> medium, HIGH -> high. SafeCommit has no `critical` bucket today. */
export function mapSafeCommitRiskLevel(level: SafeCommitContractRiskLevel): RuntimeRiskLevel {
  switch (level) {
    case 'NONE':
    case 'LOW':
      return 'low';
    case 'MODERATE':
      return 'medium';
    case 'HIGH':
      return 'high';
  }
}

/**
 * Maps a SafeCommit AdvisoryContract into a real RuntimeTask by driving it
 * through the actual lifecycle functions (not a hand-built object literal).
 *
 * GREEN/YELLOW (no forced approval): runs all the way to `completed`, since
 * SafeCommit already finished producing a usable, human-actionable review.
 *
 * RED (riskLevel HIGH forces the approval gate): deliberately stops at
 * `approval_required`. This is not a bug — it is the approval gate working
 * as designed. SafeCommit itself never auto-decides on severe risk, so this
 * adapter does not fabricate an approval on its behalf; the evidence is
 * still fully attached, but the task honestly reports that a human gate is
 * unresolved rather than claiming a synthetic completion.
 */
export function mapAdvisoryContractToRuntimeTask(
  input: SafeCommitAdvisoryContractInput,
  options: SafeCommitAdapterOptions = {}
): RuntimeTask {
  if (input.isCommitGate !== false || input.commitApproval !== 'NOT_GRANTED') {
    throw new Error(
      'mapAdvisoryContractToRuntimeTask: refusing to map an AdvisoryContract that does not uphold ' +
        'SafeCommit\'s own advisory-only guarantee (isCommitGate=false, commitApproval=NOT_GRANTED).'
    );
  }

  const riskLevel = mapSafeCommitRiskLevel(input.riskLevel);
  const validationCommands = input.validationSummary.map((v) => v.command);

  let task = createTask({
    id: options.taskId,
    product: 'safecommit',
    objective: `Advisory review of ${input.branch}@${input.headCommit} (${input.changedFileCount} file(s) changed)`,
    riskLevel,
    executionPolicy: 'advisory_only',
    validationCommands,
    inputs: {
      repoPath: input.repoPath,
      branch: input.branch,
      headCommit: input.headCommit,
      schema: input.schema,
    },
  });

  task = attachPlan(task, {
    summary: 'Run SafeCommit P1.1 advisory review (git checks, risk scan, optional validation commands).',
    steps: [
      { description: 'Inspect working-tree changes and diff whitespace' },
      { description: 'Scan changed paths and diff content for risk patterns' },
      { description: 'Run configured validation commands, if any' },
      { description: 'Produce advisory verdict and recommendation for human review' },
    ],
  });

  task = attachEvidence(task, {
    type: 'artifact',
    label: 'safecommit-advisory-contract',
    detail: input.verdictReason,
    source: input.schema,
    guard: 'safecommit_review',
  });

  if (input.severeRiskCount > 0 || input.moderateRiskCount > 0) {
    task = attachEvidence(task, {
      type: 'note',
      label: `risk-assessment-${input.riskLevel.toLowerCase()}`,
      detail: `${input.severeRiskCount} severe, ${input.moderateRiskCount} moderate risk finding(s).`,
    });
  }
  if (input.blockedPathCount > 0) {
    task = attachEvidence(task, {
      type: 'note',
      label: 'blocked-paths',
      detail: `${input.blockedPathCount} blocked path(s) detected.`,
    });
  }
  if (input.topBlockers.length > 0 || input.topWarnings.length > 0) {
    task = attachEvidence(task, {
      type: 'note',
      label: 'blockers-and-warnings',
      detail: [...input.topBlockers.map((b) => `BLOCKER: ${b}`), ...input.topWarnings.map((w) => `WARNING: ${w}`)].join(
        '; '
      ) || 'none',
    });
  }

  let recommendationAction: RuntimeRecommendationAction;

  if (!task.approvalRequired) {
    // GREEN or YELLOW: riskLevel is low/medium, so no approval gate is forced.
    task = startExecution(task);
    task = startValidation(task);

    const checks = [
      { command: 'safecommit-advisory-verdict', passed: input.verdict !== 'RED', message: input.verdictReason },
      ...input.validationSummary.map((v) => ({ command: v.command, passed: v.status === 'PASS' })),
    ];

    task = input.verdict === 'RED' ? failValidation(task, { checks }) : passValidation(task, { checks });
    task =
      input.verdict === 'RED'
        ? failTask(task, { summary: input.recommendedNextAction, output: { verdict: input.verdict } })
        : completeTask(task, { summary: input.recommendedNextAction, output: { verdict: input.verdict } });

    recommendationAction = input.verdict === 'GREEN' ? 'proceed' : 'escalate';
  } else {
    // RED / HIGH risk: honestly stop at approval_required rather than
    // synthesizing an approval SafeCommit itself never granted.
    task = requireApproval(
      task,
      `SafeCommit flagged ${input.severeRiskCount} severe risk finding(s); human approval is required before proceeding.`
    );
    recommendationAction = 'request_changes';
  }

  task = attachRecommendation(task, {
    action: recommendationAction,
    reason: input.recommendedNextAction,
    confidence: input.verdict === 'YELLOW' ? 'medium' : 'high',
  });

  return task;
}

/** Convenience: map + immediately produce the JSON-safe evidence bundle. */
export function buildSafeCommitEvidenceBundle(
  input: SafeCommitAdvisoryContractInput,
  options: SafeCommitAdapterOptions = {}
): RuntimeEvidenceBundle {
  return createEvidenceBundle(mapAdvisoryContractToRuntimeTask(input, options));
}

/**
 * SafeCommit's adapter, exposed as a `RuntimeProductAdapter` object so generic
 * runtime tooling (`runProductAdapter`, future adapter registries) can drive
 * it the same way as any other product's adapter. This is additive: the
 * free functions above (`mapAdvisoryContractToRuntimeTask`,
 * `buildSafeCommitEvidenceBundle`) remain the primary exports and are simply
 * reused as this object's methods.
 */
export const safeCommitAdapter: RuntimeProductAdapter<SafeCommitAdvisoryContractInput> = {
  id: 'safecommit-advisory-adapter',
  product: 'safecommit',
  version: '1.0.0',
  mapToRuntimeTask: (input) => mapAdvisoryContractToRuntimeTask(input),
  buildEvidenceBundle: (input) => buildSafeCommitEvidenceBundle(input),
};

/** Deterministic GREEN fixture, structurally identical to a real ADVISORY_CONTRACT.json. */
export const SAMPLE_ADVISORY_CONTRACT: SafeCommitAdvisoryContractInput = {
  schema: 'safecommit-advisory/v1',
  mode: 'ADVISORY_ONLY',
  isCommitGate: false,
  repoPath: '/repo/chanter-example',
  timestamp: '2026-07-05T10:30:00.000Z',
  branch: 'main',
  headCommit: 'abc12345',
  verdict: 'GREEN',
  verdictReason: 'All checks passed. No risky patterns detected.',
  riskLevel: 'LOW',
  changedFileCount: 2,
  trackedModifiedCount: 2,
  stagedCount: 0,
  untrackedCount: 0,
  diffCheckPassed: true,
  validationConfigured: true,
  validationPassed: true,
  validationSummary: [
    { command: 'npm test', status: 'PASS' },
    { command: 'npm run build', status: 'PASS' },
  ],
  severeRiskCount: 0,
  moderateRiskCount: 0,
  blockedPathCount: 0,
  blockerCount: 0,
  warningCount: 0,
  commitApproval: 'NOT_GRANTED',
  commitRecommendation: 'REVIEW_RECOMMENDED',
  recommendedNextAction: 'Advisory validation passed. Human diff review and explicit approval are still required.',
  topBlockers: [],
  topWarnings: [],
};
