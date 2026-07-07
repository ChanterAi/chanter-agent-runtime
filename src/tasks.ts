/**
 * CHANTER Agent Runtime — task lifecycle functions.
 *
 * Every function here is pure: it takes a RuntimeTask and returns a new
 * RuntimeTask, never mutating its input. This keeps the runtime safe to use
 * from synchronous call sites, tests, and future dashboard/event-sourcing
 * consumers that want to diff or replay task history.
 */
import type {
  JsonValue,
  RuntimeEvidence,
  RuntimeEvidenceType,
  RuntimeEventType,
  RuntimeExecutionPolicy,
  RuntimePlan,
  RuntimeProduct,
  RuntimeRecommendation,
  RuntimeRecommendationAction,
  RuntimeResult,
  RuntimeRiskLevel,
  RuntimeStatus,
  RuntimeTask,
  RuntimeValidationCheck,
  RuntimeValidationResult,
} from './types.js';
import { assertTransitionAllowed, isTerminalStatus, requiresApprovalBeforeExecution } from './transitions.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Monotonic ISO-8601 clock. Two calls in the same millisecond (common in
 * synchronous test code) would otherwise produce identical timestamps and
 * make `updatedAt` look unchanged after a real mutation.
 */
let lastTimestampMs = 0;
function nowIso(): string {
  let ms = Date.now();
  if (ms <= lastTimestampMs) {
    ms = lastTimestampMs + 1;
  }
  lastTimestampMs = ms;
  return new Date(ms).toISOString();
}

let idCounter = 0;
function generateId(prefix: string): string {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${idCounter}-${random}`;
}

function cloneTask(task: RuntimeTask): RuntimeTask {
  return structuredClone(task);
}

function assertNotTerminal(task: RuntimeTask, action: string): void {
  if (isTerminalStatus(task.status)) {
    throw new Error(`Cannot ${action}: task ${task.id} is already terminal (status="${task.status}").`);
  }
}

function assertInStatus(task: RuntimeTask, expected: RuntimeStatus, action: string): void {
  if (task.status !== expected) {
    throw new Error(
      `Cannot ${action}: task ${task.id} is in status "${task.status}", expected "${expected}".`
    );
  }
}

/** Appends an event and bumps updatedAt on an already-cloned task. Mutates in place, returns it. */
function pushEvent(task: RuntimeTask, type: RuntimeEventType, message: string, data?: JsonValue): RuntimeTask {
  const timestamp = nowIso();
  const event = data === undefined
    ? { type, taskId: task.id, timestamp, message }
    : { type, taskId: task.id, timestamp, message, data };
  task.logs.push(event);
  task.updatedAt = timestamp;
  return task;
}

/** Clone + apply a field mutation + append event, without changing status. */
function mutateTask(
  task: RuntimeTask,
  eventType: RuntimeEventType,
  message: string,
  mutate: (draft: RuntimeTask) => void,
  data?: JsonValue
): RuntimeTask {
  const next = cloneTask(task);
  mutate(next);
  return pushEvent(next, eventType, message, data);
}

/** Clone + assert transition + apply field mutation + change status + append event. */
function transitionTo(
  task: RuntimeTask,
  to: RuntimeStatus,
  eventType: RuntimeEventType,
  message: string,
  mutate?: (draft: RuntimeTask) => void,
  data?: JsonValue
): RuntimeTask {
  assertTransitionAllowed(task, to);
  const next = cloneTask(task);
  mutate?.(next);
  next.status = to;
  return pushEvent(next, eventType, message, data);
}

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  id?: string;
  product: RuntimeProduct;
  objective: string;
  riskLevel?: RuntimeRiskLevel;
  executionPolicy?: RuntimeExecutionPolicy;
  inputs?: Record<string, JsonValue>;
  validationCommands?: string[];
}

/** Creates a new task in `draft` status. */
export function createTask(input: CreateTaskInput): RuntimeTask {
  const timestamp = nowIso();
  const riskLevel = input.riskLevel ?? 'low';
  const executionPolicy = input.executionPolicy ?? 'local_only';
  const approvalRequired = requiresApprovalBeforeExecution({ riskLevel, executionPolicy });

  const task: RuntimeTask = {
    id: input.id ?? generateId(input.product),
    product: input.product,
    objective: input.objective,
    status: 'draft',
    riskLevel,
    executionPolicy,
    approvalRequired,
    inputs: input.inputs ?? {},
    evidence: [],
    validationCommands: input.validationCommands ?? [],
    logs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  // Reuse `timestamp` (rather than calling pushEvent, which stamps a fresh nowIso())
  // so createdAt, updatedAt, and the TASK_CREATED event timestamp all agree exactly.
  task.logs.push({
    type: 'TASK_CREATED',
    taskId: task.id,
    timestamp,
    message: `Task created for ${input.product}: ${input.objective}`,
    data: { riskLevel, executionPolicy, approvalRequired },
  });
  return task;
}

// ---------------------------------------------------------------------------
// attachPlan  (draft -> planned, or blocked -> planned for recovery)
// ---------------------------------------------------------------------------

export interface RuntimePlanStepInput {
  id?: string;
  description: string;
}

export interface RuntimePlanInput {
  summary: string;
  steps?: RuntimePlanStepInput[];
}

function buildPlan(input: RuntimePlanInput): RuntimePlan {
  return {
    summary: input.summary,
    steps: (input.steps ?? []).map((step, index) => ({
      id: step.id ?? `step-${index + 1}`,
      description: step.description,
      done: false,
    })),
    createdAt: nowIso(),
  };
}

/** Attaches a plan and moves the task to `planned`. Valid from `draft` (initial) or `blocked` (recovery). */
export function attachPlan(task: RuntimeTask, planInput: RuntimePlanInput): RuntimeTask {
  const plan = buildPlan(planInput);
  return transitionTo(
    task,
    'planned',
    'PLAN_ATTACHED',
    `Plan attached: ${plan.summary}`,
    (draft) => {
      draft.plan = plan;
    },
    { stepCount: plan.steps.length }
  );
}

// ---------------------------------------------------------------------------
// Approval gate: planned -> approval_required -> approved -> executing
// ---------------------------------------------------------------------------

/**
 * Flags the task as awaiting human approval. Only valid when task.approvalRequired is true.
 * Tasks on the `requires_safecommit_review` policy emit SAFECOMMIT_REVIEW_REQUIRED instead of
 * the generic APPROVAL_REQUIRED, so downstream consumers can route the gate to SafeCommit specifically.
 */
export function requireApproval(task: RuntimeTask, reason?: string): RuntimeTask {
  const eventType: RuntimeEventType =
    task.executionPolicy === 'requires_safecommit_review' ? 'SAFECOMMIT_REVIEW_REQUIRED' : 'APPROVAL_REQUIRED';
  return transitionTo(
    task,
    'approval_required',
    eventType,
    reason ??
      `Task ${task.id} requires approval before execution (riskLevel=${task.riskLevel}, executionPolicy=${task.executionPolicy}).`
  );
}

/** Records human approval and moves the task to `approved`. */
export function approveTask(task: RuntimeTask, approver?: string, note?: string): RuntimeTask {
  const message = approver
    ? `Approved by ${approver}${note ? `: ${note}` : ''}`
    : note ?? `Task ${task.id} approved.`;
  return transitionTo(task, 'approved', 'TASK_APPROVED', message, undefined, approver ? { approver } : undefined);
}

/**
 * Starts execution. Valid from `approved`, or from `planned` when the task
 * does not require approval — the approval gate is enforced entirely by the
 * transition table (see transitions.ts), not by a separate check here.
 */
export function startExecution(task: RuntimeTask): RuntimeTask {
  return transitionTo(task, 'executing', 'EXECUTION_STARTED', `Execution started for task ${task.id}.`);
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Tags evidence as satisfying a specific guard, so attachEvidence emits the matching *_GUARD_ATTACHED event. */
export type RuntimeGuardTag = 'safecommit_review' | 'publish' | 'deploy' | 'commit';

const GUARD_EVENT_TYPE: Record<RuntimeGuardTag, RuntimeEventType> = {
  safecommit_review: 'SAFECOMMIT_REVIEW_ATTACHED',
  publish: 'PUBLISH_GUARD_ATTACHED',
  deploy: 'DEPLOY_GUARD_ATTACHED',
  commit: 'COMMIT_GUARD_ATTACHED',
};

export interface RuntimeEvidenceInput {
  id?: string;
  type: RuntimeEvidenceType;
  label: string;
  detail: string;
  source?: string;
  /** When set, this evidence represents a specific guard/review being satisfied. */
  guard?: RuntimeGuardTag;
}

function buildEvidence(input: RuntimeEvidenceInput): RuntimeEvidence {
  return {
    id: input.id ?? generateId('evidence'),
    type: input.type,
    label: input.label,
    detail: input.detail,
    // Omit (rather than set-to-undefined) so the object round-trips through
    // JSON without a key-count mismatch — see assertJsonSafe.
    ...(input.source !== undefined ? { source: input.source } : {}),
    createdAt: nowIso(),
  };
}

/** Attaches one evidence item. Allowed any time before a task reaches a terminal status. */
export function attachEvidence(task: RuntimeTask, evidenceInput: RuntimeEvidenceInput): RuntimeTask {
  assertNotTerminal(task, 'attach evidence');
  const evidence = buildEvidence(evidenceInput);
  const eventType = evidenceInput.guard ? GUARD_EVENT_TYPE[evidenceInput.guard] : 'EVIDENCE_ATTACHED';
  return mutateTask(
    task,
    eventType,
    `Evidence attached: ${evidence.label}`,
    (draft) => {
      draft.evidence.push(evidence);
    },
    { evidenceId: evidence.id, type: evidence.type }
  );
}

// ---------------------------------------------------------------------------
// Validation: executing -> validating -> completed | failed
// ---------------------------------------------------------------------------

export interface RuntimeValidationInput {
  checks: RuntimeValidationCheck[];
  summary?: string;
}

function buildValidationResult(input: RuntimeValidationInput): RuntimeValidationResult {
  // Rebuild explicitly (rather than `{ ...check }`) so an explicit `message: undefined`
  // from a caller can't sneak an undefined-valued key past assertJsonSafe's round-trip check.
  const checks = input.checks.map((check) => ({
    command: check.command,
    passed: check.passed,
    ...(check.message !== undefined ? { message: check.message } : {}),
  }));
  const passed = checks.length > 0 && checks.every((check) => check.passed);
  const failedCount = checks.filter((check) => !check.passed).length;
  const summary =
    input.summary ??
    (passed
      ? `All ${checks.length} validation check(s) passed.`
      : `${failedCount} of ${checks.length} validation check(s) failed.`);
  return { passed, checks, summary, validatedAt: nowIso() };
}

/** Moves the task into `validating`. */
export function startValidation(task: RuntimeTask): RuntimeTask {
  return transitionTo(task, 'validating', 'VALIDATION_STARTED', `Validation started for task ${task.id}.`);
}

/** Attaches a passing validation result. Does not change status; call completeTask next. */
export function passValidation(task: RuntimeTask, input: RuntimeValidationInput): RuntimeTask {
  assertInStatus(task, 'validating', 'record a passing validation result');
  const result = buildValidationResult(input);
  if (!result.passed) {
    throw new Error(
      `passValidation called on task ${task.id} but ${result.checks.filter((c) => !c.passed).length} check(s) failed; use failValidation instead.`
    );
  }
  return mutateTask(task, 'VALIDATION_PASSED', result.summary, (draft) => {
    draft.validationResult = result;
  });
}

/** Attaches a failing validation result. Does not change status; call failTask next. */
export function failValidation(task: RuntimeTask, input: RuntimeValidationInput): RuntimeTask {
  assertInStatus(task, 'validating', 'record a failing validation result');
  const result = buildValidationResult(input);
  if (result.passed) {
    throw new Error(`failValidation called on task ${task.id} but all checks passed; use passValidation instead.`);
  }
  return mutateTask(task, 'VALIDATION_FAILED', result.summary, (draft) => {
    draft.validationResult = result;
  });
}

// ---------------------------------------------------------------------------
// Terminal transitions
// ---------------------------------------------------------------------------

export interface RuntimeResultInput {
  summary: string;
  output?: JsonValue;
}

function buildResult(input: RuntimeResultInput, success: boolean): RuntimeResult {
  return {
    success,
    summary: input.summary,
    ...(input.output !== undefined ? { output: input.output } : {}),
    completedAt: nowIso(),
  };
}

/** Completes the task. Requires a passing validationResult already attached via passValidation. */
export function completeTask(task: RuntimeTask, input: RuntimeResultInput): RuntimeTask {
  assertInStatus(task, 'validating', 'complete the task');
  if (!task.validationResult || !task.validationResult.passed) {
    throw new Error(`Cannot complete task ${task.id}: validation has not passed.`);
  }
  const result = buildResult(input, true);
  return transitionTo(task, 'completed', 'TASK_COMPLETED', result.summary, (draft) => {
    draft.result = result;
  });
}

/** Fails the task from `validating`. */
export function failTask(task: RuntimeTask, input: RuntimeResultInput): RuntimeTask {
  assertInStatus(task, 'validating', 'fail the task');
  const result = buildResult(input, false);
  return transitionTo(task, 'failed', 'TASK_FAILED', result.summary, (draft) => {
    draft.result = result;
  });
}

/** Blocks the task from any non-terminal status. Recoverable via attachPlan (blocked -> planned). */
export function blockTask(task: RuntimeTask, reason: string): RuntimeTask {
  return transitionTo(task, 'blocked', 'TASK_BLOCKED', reason);
}

/** Cancels the task from any non-terminal status. Terminal; a new task must be created to retry. */
export function cancelTask(task: RuntimeTask, reason: string): RuntimeTask {
  const result = buildResult({ summary: `Cancelled: ${reason}` }, false);
  return transitionTo(task, 'cancelled', 'TASK_CANCELLED', reason, (draft) => {
    draft.result = result;
  });
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

export interface RuntimeRecommendationInput {
  action: RuntimeRecommendationAction;
  reason: string;
  confidence?: 'low' | 'medium' | 'high';
}

function buildRecommendation(input: RuntimeRecommendationInput): RuntimeRecommendation {
  return {
    action: input.action,
    reason: input.reason,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    createdAt: nowIso(),
  };
}

/**
 * Attaches the runtime's suggested next action. Deliberately allowed on
 * terminal tasks too: "Next Recommendation" is the final stage of the
 * pipeline (...Result -> Next Recommendation), so it must be attachable
 * after completeTask/failTask/cancelTask have already set the result.
 */
export function attachRecommendation(task: RuntimeTask, input: RuntimeRecommendationInput): RuntimeTask {
  const recommendation = buildRecommendation(input);
  return mutateTask(
    task,
    'RECOMMENDATION_ATTACHED',
    `Recommendation: ${recommendation.action} — ${recommendation.reason}`,
    (draft) => {
      draft.nextRecommendation = recommendation;
    }
  );
}
