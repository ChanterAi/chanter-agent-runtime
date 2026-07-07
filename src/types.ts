/**
 * CHANTER Agent Runtime — core typed models.
 *
 * Shared execution contract for Loop Governor, SafeCommit, Operator, MCP Server,
 * AutoPoster, and Clean Engine:
 *
 *   Goal -> Plan -> Task -> Approval Gate -> Execution State -> Evidence
 *        -> Validation -> Review -> Result -> Next Recommendation
 */

/** JSON-safe value. Every field that must survive serialization to disk/wire is built from this. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** CHANTER product that can own a runtime task. */
export type RuntimeProduct =
  | 'loop_governor'
  | 'safecommit'
  | 'operator'
  | 'mcp_server'
  | 'auto_poster'
  | 'clean_engine';

/** Ordered task lifecycle status. See transitions.ts for the allowed edges. */
export type RuntimeStatus =
  | 'draft'
  | 'planned'
  | 'approval_required'
  | 'approved'
  | 'executing'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

/** Risk classification driving approval-gate behavior. */
export type RuntimeRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Execution policy attached to a task. Guarded policies (everything except
 * local_only/advisory_only) force an approval gate regardless of risk level.
 */
export type RuntimeExecutionPolicy =
  | 'local_only'
  | 'advisory_only'
  | 'requires_approval'
  | 'requires_safecommit_review'
  | 'publish_guarded'
  | 'deploy_guarded'
  | 'commit_guarded';

/** Single step inside a RuntimePlan. */
export interface RuntimePlanStep {
  id: string;
  description: string;
  done: boolean;
}

/** Attached plan describing how a task intends to reach its objective. */
export interface RuntimePlan {
  summary: string;
  steps: RuntimePlanStep[];
  createdAt: string;
}

/** Discriminant for how a piece of evidence should be interpreted. */
export type RuntimeEvidenceType = 'file' | 'log' | 'artifact' | 'command_output' | 'url' | 'note';

/** One inspectable artifact produced while working a task. */
export interface RuntimeEvidence {
  id: string;
  type: RuntimeEvidenceType;
  label: string;
  detail: string;
  source?: string;
  createdAt: string;
}

/** Result of a single validation command/check. */
export interface RuntimeValidationCheck {
  command: string;
  passed: boolean;
  message?: string;
}

/** Aggregate validation outcome attached while a task is `validating`. */
export interface RuntimeValidationResult {
  passed: boolean;
  checks: RuntimeValidationCheck[];
  summary: string;
  validatedAt: string;
}

/** Final, terminal outcome of a task (set by completeTask/failTask/cancelTask). */
export interface RuntimeResult {
  success: boolean;
  summary: string;
  output?: JsonValue;
  completedAt: string;
}

/** Suggested next action, attachable at any point — including after a terminal outcome. */
export type RuntimeRecommendationAction =
  | 'proceed'
  | 'retry'
  | 'escalate'
  | 'request_changes'
  | 'block'
  | 'stop';

export interface RuntimeRecommendation {
  action: RuntimeRecommendationAction;
  reason: string;
  confidence?: 'low' | 'medium' | 'high';
  createdAt: string;
}

/** Every event type the runtime can append to a task's audit log. */
export type RuntimeEventType =
  | 'TASK_CREATED'
  | 'PLAN_ATTACHED'
  | 'APPROVAL_REQUIRED'
  | 'TASK_APPROVED'
  | 'EXECUTION_STARTED'
  | 'EVIDENCE_ATTACHED'
  | 'VALIDATION_STARTED'
  | 'VALIDATION_PASSED'
  | 'VALIDATION_FAILED'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'TASK_BLOCKED'
  | 'TASK_CANCELLED'
  | 'RECOMMENDATION_ATTACHED'
  | 'SAFECOMMIT_REVIEW_REQUIRED'
  | 'SAFECOMMIT_REVIEW_ATTACHED'
  | 'PUBLISH_GUARD_ATTACHED'
  | 'DEPLOY_GUARD_ATTACHED'
  | 'COMMIT_GUARD_ATTACHED';

/** One immutable audit-log entry. */
export interface RuntimeEvent {
  type: RuntimeEventType;
  taskId: string;
  timestamp: string;
  message: string;
  data?: JsonValue;
}

/** The core unit of work: one task moving through the shared execution contract. */
export interface RuntimeTask {
  id: string;
  product: RuntimeProduct;
  objective: string;
  status: RuntimeStatus;
  riskLevel: RuntimeRiskLevel;
  executionPolicy: RuntimeExecutionPolicy;
  /** Derived from riskLevel + executionPolicy at creation time; see requiresApprovalBeforeExecution. */
  approvalRequired: boolean;
  inputs: Record<string, JsonValue>;
  plan?: RuntimePlan;
  evidence: RuntimeEvidence[];
  validationCommands: string[];
  validationResult?: RuntimeValidationResult;
  result?: RuntimeResult;
  nextRecommendation?: RuntimeRecommendation;
  logs: RuntimeEvent[];
  createdAt: string;
  updatedAt: string;
}
