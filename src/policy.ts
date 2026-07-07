/**
 * CHANTER Agent Runtime — action policy evaluator.
 *
 * A separate, additive gate from the task lifecycle in transitions.ts: where
 * `assertTransitionAllowed` governs which RuntimeStatus a task may move to,
 * `evaluateRuntimeActionPolicy` governs whether a concrete side-effecting
 * action (read a file, run a shell command, hit the network, commit, deploy,
 * publish, delete) may be performed *right now*, given the task's current
 * status, risk level, and execution policy.
 *
 * This module never performs an action and never mutates a task — it only
 * returns a decision. Enforcement is the caller's responsibility.
 */
import type { RuntimeExecutionPolicy, RuntimeTask } from './types.js';
import { isTerminalStatus } from './transitions.js';

/** The kind of side-effecting action a caller is asking permission to perform. */
export type RuntimeActionType = 'read' | 'write' | 'shell' | 'network' | 'commit' | 'deploy' | 'publish' | 'delete';

/** A request to perform one action against a target, in the context of a RuntimeTask. */
export interface RuntimeActionRequest {
  actionType: RuntimeActionType;
  target: string;
  reason: string;
  /** When true, the caller only wants a decision preview — see the dryRun rule below. */
  dryRun?: boolean;
}

/**
 * The evaluator's answer. `allowed`/`approvalRequired`/`blocked` are
 * deliberately independent booleans (not one enum) so a caller can render
 * "waiting on a human" differently from "will never be allowed on this task."
 * `requiredPolicy` is set when the action can only ever proceed if the task
 * had been created with a specific `RuntimeExecutionPolicy`.
 */
export interface RuntimeActionDecision {
  allowed: boolean;
  approvalRequired: boolean;
  blocked: boolean;
  reasons: string[];
  requiredPolicy?: RuntimeExecutionPolicy;
}

function terminalDecision(task: RuntimeTask, actionType: RuntimeActionType): RuntimeActionDecision {
  return {
    allowed: false,
    approvalRequired: false,
    blocked: true,
    reasons: [
      `Task ${task.id} is terminal (status="${task.status}"); '${actionType}' cannot be performed — create a new task instead.`,
    ],
  };
}

/**
 * Shared status gate for actions that need the task to have actually cleared
 * its approval gate (write/shell/network, and — once policy-eligible —
 * commit/deploy/publish). Deliberately reuses `task.approvalRequired` /
 * `task.status` rather than re-deriving a risk check: those fields already
 * encode "high/critical risk requires approval" via transitions.ts, and the
 * transition table itself refuses to let a task reach `executing` while an
 * unresolved approval gate exists.
 */
function statusGateDecision(task: RuntimeTask, actionType: RuntimeActionType): RuntimeActionDecision {
  switch (task.status) {
    case 'blocked':
      return {
        allowed: false,
        approvalRequired: false,
        blocked: true,
        reasons: [`Task ${task.id} is blocked; '${actionType}' cannot proceed until the task is replanned.`],
      };
    case 'draft':
      return {
        allowed: false,
        approvalRequired: false,
        blocked: false,
        reasons: [`Task ${task.id} has no plan attached yet; attach a plan before '${actionType}' can proceed.`],
      };
    case 'approval_required':
      return {
        allowed: false,
        approvalRequired: true,
        blocked: false,
        reasons: [`Task ${task.id} is awaiting human approval before '${actionType}' can proceed.`],
      };
    case 'planned':
      if (task.approvalRequired) {
        return {
          allowed: false,
          approvalRequired: true,
          blocked: false,
          reasons: [
            `Task ${task.id} requires approval (riskLevel=${task.riskLevel}, executionPolicy=${task.executionPolicy}) before '${actionType}' can proceed.`,
          ],
        };
      }
      return {
        allowed: true,
        approvalRequired: false,
        blocked: false,
        reasons: [`Task ${task.id} does not require approval; '${actionType}' may proceed.`],
      };
    case 'approved':
    case 'executing':
    case 'validating':
      return {
        allowed: true,
        approvalRequired: false,
        blocked: false,
        reasons: [`Task ${task.id} has cleared its approval gate (status="${task.status}"); '${actionType}' may proceed.`],
      };
    /* istanbul ignore next -- completed/failed/cancelled are intercepted by the terminal check before this runs. */
    default:
      return terminalDecision(task, actionType);
  }
}

interface GuardRequirement {
  policies: readonly RuntimeExecutionPolicy[];
  requiredPolicy: RuntimeExecutionPolicy;
}

const GUARD_REQUIREMENTS: Record<'commit' | 'deploy' | 'publish', GuardRequirement> = {
  commit: { policies: ['commit_guarded', 'requires_safecommit_review'], requiredPolicy: 'commit_guarded' },
  deploy: { policies: ['deploy_guarded'], requiredPolicy: 'deploy_guarded' },
  publish: { policies: ['publish_guarded'], requiredPolicy: 'publish_guarded' },
};

/** commit/deploy/publish first require the task to carry the matching guarded execution policy, then fall back to the ordinary status gate. */
function guardedActionDecision(task: RuntimeTask, actionType: 'commit' | 'deploy' | 'publish'): RuntimeActionDecision {
  const requirement = GUARD_REQUIREMENTS[actionType];
  if (!requirement.policies.includes(task.executionPolicy)) {
    return {
      allowed: false,
      approvalRequired: false,
      blocked: true,
      reasons: [
        `'${actionType}' requires executionPolicy ${requirement.policies.join(' or ')}; task ${task.id} has "${task.executionPolicy}".`,
      ],
      requiredPolicy: requirement.requiredPolicy,
    };
  }
  return statusGateDecision(task, actionType);
}

/**
 * `delete` has no implemented execution path yet. It is blocked by default;
 * a `dryRun` request reports that honestly (not allowed, not blocked outright)
 * instead of pretending a preview exists.
 */
function deleteActionDecision(task: RuntimeTask, request: RuntimeActionRequest): RuntimeActionDecision {
  if (request.dryRun) {
    return {
      allowed: false,
      approvalRequired: false,
      blocked: false,
      reasons: [
        `'delete' has no dry-run preview implemented yet for task ${task.id}; explicit delete support must be added before this action type can be enabled.`,
      ],
    };
  }
  return {
    allowed: false,
    approvalRequired: false,
    blocked: true,
    reasons: [`'delete' actions are blocked by default; the runtime does not yet support performing deletes.`],
  };
}

/**
 * Evaluates whether `request` may be performed against `task` right now.
 * Pure and side-effect free: it never mutates `task` and never performs the
 * requested action, only decides whether it may be performed.
 */
export function evaluateRuntimeActionPolicy(task: RuntimeTask, request: RuntimeActionRequest): RuntimeActionDecision {
  let decision: RuntimeActionDecision;

  if (isTerminalStatus(task.status)) {
    decision = terminalDecision(task, request.actionType);
  } else {
    switch (request.actionType) {
      case 'read':
        decision = {
          allowed: true,
          approvalRequired: false,
          blocked: false,
          reasons: [`'read' is allowed for task ${task.id} (status="${task.status}").`],
        };
        break;
      case 'write':
      case 'shell':
      case 'network':
        decision = statusGateDecision(task, request.actionType);
        break;
      case 'commit':
      case 'deploy':
      case 'publish':
        decision = guardedActionDecision(task, request.actionType);
        break;
      case 'delete':
        decision = deleteActionDecision(task, request);
        break;
    }
  }

  // dryRun is a decision preview: it must never report an action as actually allowed to run.
  if (request.dryRun && decision.allowed) {
    decision = {
      ...decision,
      allowed: false,
      reasons: [...decision.reasons, 'dryRun=true: decision preview only, no action was performed.'],
    };
  }

  return decision;
}
