/**
 * CHANTER Agent Runtime — transition rules and approval-gate logic.
 *
 * This module is the single source of truth for which RuntimeStatus a task
 * may move to next. Every mutating function in tasks.ts routes status changes
 * through `assertTransitionAllowed`, so the rules here are enforced globally.
 */
import type { RuntimeExecutionPolicy, RuntimeRiskLevel, RuntimeStatus, RuntimeTask } from './types.js';

/** Execution policies that force an approval gate regardless of risk level. */
const GUARDED_POLICIES: ReadonlySet<RuntimeExecutionPolicy> = new Set([
  'requires_approval',
  'requires_safecommit_review',
  'publish_guarded',
  'deploy_guarded',
  'commit_guarded',
]);

const HIGH_RISK_LEVELS: ReadonlySet<RuntimeRiskLevel> = new Set(['high', 'critical']);

const TERMINAL_STATUSES: ReadonlySet<RuntimeStatus> = new Set(['completed', 'failed', 'cancelled']);

/**
 * True if a task of this risk level / execution policy must be approved
 * before it is allowed to enter `executing`.
 */
export function requiresApprovalBeforeExecution(
  input: Pick<RuntimeTask, 'riskLevel' | 'executionPolicy'>
): boolean {
  if (HIGH_RISK_LEVELS.has(input.riskLevel)) return true;
  return GUARDED_POLICIES.has(input.executionPolicy);
}

/** Terminal statuses never accept further transitions; a new task must be created instead. */
export function isTerminalStatus(status: RuntimeStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Full transition table. `planned` is the only status whose outgoing edges
 * depend on task state (approvalRequired) rather than being fixed by status alone.
 */
export function getAllowedNextStatuses(task: RuntimeTask): RuntimeStatus[] {
  switch (task.status) {
    case 'draft':
      return ['planned', 'blocked', 'cancelled'];
    case 'planned':
      return task.approvalRequired
        ? ['approval_required', 'blocked', 'cancelled']
        : ['executing', 'blocked', 'cancelled'];
    case 'approval_required':
      return ['approved', 'blocked', 'cancelled'];
    case 'approved':
      return ['executing', 'blocked', 'cancelled'];
    case 'executing':
      return ['validating', 'blocked', 'cancelled'];
    case 'validating':
      return ['completed', 'failed', 'blocked', 'cancelled'];
    case 'blocked':
      return ['planned', 'cancelled'];
    case 'completed':
    case 'failed':
    case 'cancelled':
      return [];
  }
}

/** Thrown by assertTransitionAllowed. Carries structured context for programmatic handling. */
export class RuntimeTransitionError extends Error {
  readonly taskId: string;
  readonly from: RuntimeStatus;
  readonly to: RuntimeStatus;
  readonly allowed: RuntimeStatus[];

  constructor(task: RuntimeTask, to: RuntimeStatus, allowed: RuntimeStatus[]) {
    super(
      `Invalid transition for task ${task.id} (${task.product}): "${task.status}" -> "${to}" is not allowed.` +
        (allowed.length > 0
          ? ` Allowed next status(es): ${allowed.join(', ')}.`
          : ` "${task.status}" is a terminal status; create a new task instead.`) +
        explainReason(task, to)
    );
    this.name = 'RuntimeTransitionError';
    this.taskId = task.id;
    this.from = task.status;
    this.to = to;
    this.allowed = allowed;
  }
}

/** Best-effort human-readable hint appended to transition errors for the common approval-gate cases. */
function explainReason(task: RuntimeTask, to: RuntimeStatus): string {
  if (to === 'executing' && task.status === 'planned' && task.approvalRequired) {
    return ' Reason: this task requires approval (riskLevel=' + task.riskLevel + ', executionPolicy=' +
      task.executionPolicy + ') — call requireApproval then approveTask before startExecution.';
  }
  if (to === 'executing' && task.status === 'approval_required') {
    return ' Reason: this task is awaiting approval; call approveTask first.';
  }
  if (to === 'approval_required' && task.status === 'planned' && !task.approvalRequired) {
    return ' Reason: this task does not require approval; call startExecution directly.';
  }
  if (isTerminalStatus(task.status)) {
    return ` Reason: "${task.status}" is terminal and cannot mutate further.`;
  }
  return '';
}

/** Throws RuntimeTransitionError if `to` is not a valid next status for `task`. */
export function assertTransitionAllowed(task: RuntimeTask, to: RuntimeStatus): void {
  const allowed = getAllowedNextStatuses(task);
  if (!allowed.includes(to)) {
    throw new RuntimeTransitionError(task, to, allowed);
  }
}
