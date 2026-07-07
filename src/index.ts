/**
 * CHANTER Agent Runtime — public entry point.
 *
 * Shared execution contract for Loop Governor, SafeCommit, Operator, MCP Server,
 * AutoPoster, and Clean Engine. See docs/RUNTIME_CONTRACT.md for the full contract.
 */

export type {
  JsonValue,
  RuntimeProduct,
  RuntimeStatus,
  RuntimeRiskLevel,
  RuntimeExecutionPolicy,
  RuntimePlanStep,
  RuntimePlan,
  RuntimeEvidenceType,
  RuntimeEvidence,
  RuntimeValidationCheck,
  RuntimeValidationResult,
  RuntimeResult,
  RuntimeRecommendationAction,
  RuntimeRecommendation,
  RuntimeEventType,
  RuntimeEvent,
  RuntimeTask,
} from './types.js';

export {
  requiresApprovalBeforeExecution,
  isTerminalStatus,
  getAllowedNextStatuses,
  assertTransitionAllowed,
  RuntimeTransitionError,
} from './transitions.js';

export type {
  CreateTaskInput,
  RuntimePlanStepInput,
  RuntimePlanInput,
  RuntimeEvidenceInput,
  RuntimeGuardTag,
  RuntimeValidationInput,
  RuntimeResultInput,
  RuntimeRecommendationInput,
} from './tasks.js';

export {
  createTask,
  attachPlan,
  requireApproval,
  approveTask,
  startExecution,
  attachEvidence,
  startValidation,
  passValidation,
  failValidation,
  completeTask,
  failTask,
  blockTask,
  cancelTask,
  attachRecommendation,
} from './tasks.js';

export type { RuntimeEvidenceBundle, RuntimeEventSummary, RuntimeReviewSummary, RuntimeReviewSummaryFields } from './evidence.js';
export { createEvidenceBundle, summarizeTaskForReview, assertJsonSafe } from './evidence.js';

// ── Product adapters ──
export type {
  SafeCommitVerdict,
  SafeCommitContractRiskLevel,
  SafeCommitAdvisoryContractInput,
  SafeCommitAdapterOptions,
} from './adapters/safeCommitAdapter.js';
export {
  mapSafeCommitRiskLevel,
  mapAdvisoryContractToRuntimeTask,
  buildSafeCommitEvidenceBundle,
  SAMPLE_ADVISORY_CONTRACT,
} from './adapters/safeCommitAdapter.js';
