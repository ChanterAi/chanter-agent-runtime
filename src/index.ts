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

// ── Redaction ──
export { redactText, redactJsonValue, redactRecord } from './redaction.js';

// ── Action policy evaluator ──
export type { RuntimeActionType, RuntimeActionRequest, RuntimeActionDecision } from './policy.js';
export { evaluateRuntimeActionPolicy } from './policy.js';

// ── Provider routing foundation ──
export type {
  RuntimeProviderRoute,
  RuntimeProviderRouteRequest,
  RuntimeProviderRouteDecision,
} from './providerRouting.js';
export { selectProviderRoute } from './providerRouting.js';

// ── Canonical Agent Run Ledger contract ──
export type {
  AgentRunLedgerStatus,
  AgentRunLedgerOutcome,
  AgentRunLedgerApprovalStatus,
  AgentRunLedgerValidationOutcome,
  AgentRunLedgerEvidenceIntegrityStatus,
  AgentRunLedgerActionOutcome,
  AgentRunLedgerEvidenceKind,
  AgentRunLedgerCostEstimate,
  AgentRunLedgerAction,
  AgentRunLedgerTool,
  AgentRunLedgerEvidenceRef,
  AgentRunLedgerEntry,
  AgentRunLedgerEntryDraft,
  AgentRunLedgerValidationIssueCode,
  AgentRunLedgerValidationIssue,
  AgentRunLedgerTransitionErrorCode,
  AgentRunLedgerReplayMismatchCode,
  AgentRunLedgerHashVerification,
} from './agentRunLedger.js';
export {
  AGENT_RUN_LEDGER_SCHEMA_VERSION,
  AGENT_RUN_LEDGER_SCOPE_HASH_DOMAIN,
  AGENT_RUN_LEDGER_PAYLOAD_HASH_DOMAIN,
  AGENT_RUN_LEDGER_LIMITS,
  AgentRunLedgerValidationError,
  AgentRunLedgerTransitionError,
  AgentRunLedgerReplayMismatchError,
  canonicalizeAgentRunLedgerJson,
  redactAgentRunLedgerFreeText,
  createAgentRunLedgerScopeHash,
  createAgentRunLedgerPayloadHash,
  deriveAgentRunLedgerOutcome,
  normalizeAgentRunLedgerEntry,
  createAgentRunLedgerEntry,
  validateAgentRunLedgerEntry,
  verifyAgentRunLedgerHashes,
  assertAgentRunLedgerTransition,
  assertAgentRunLedgerExactReplay,
} from './agentRunLedger.js';

// ── Generic adapter contract ──
export type {
  RuntimeAdapterInputEnvelope,
  RuntimeAdapterResult,
  RuntimeProductAdapter,
} from './adapters/runtimeAdapter.js';
export { runProductAdapter } from './adapters/runtimeAdapter.js';

// ── Mission execution layer (P1B) ──
export type {
  RuntimeMissionActor,
  RuntimeMissionTenant,
  RuntimeMissionApproval,
  RuntimeMissionRequest,
  RuntimeMissionStatus,
  RuntimeMissionError,
  RuntimeMissionApprovalDecision,
  RuntimeMissionIdempotencyOutcome,
  RuntimeMissionIdempotencyResult,
  RuntimeMissionResult,
  RuntimeMissionActionSpec,
  RuntimeMissionAdapterOutcome,
  RuntimeMissionAdapter,
  RuntimeMissionAdapterRegistry,
  RuntimeMissionReplayBinding,
  RuntimeMissionIdempotencyRecord,
  RuntimeMissionIdempotencyStore,
  ExecuteMissionOptions,
} from './missions.js';
export {
  createRuntimeMissionPayloadHash,
  createMissionAdapterRegistry,
  createInMemoryIdempotencyStore,
  executeMission,
} from './missions.js';

// ── AutoPoster mission adapter + operations port ──
export type {
  AutoPosterPortErrorCode,
  AutoPosterConnectedAccountReasonCode,
  AutoPosterCommercialDenialDetails,
  AutoPosterPortFailure,
  AutoPosterConnectedAccountView,
  AutoPosterConnectedAccountListParams,
  AutoPosterConnectedAccountListSuccess,
  AutoPosterConnectedAccountValidationParams,
  AutoPosterConnectedAccountValidationSuccess,
  AutoPosterQueueItemView,
  AutoPosterQueueListSuccess,
  AutoPosterQueueStatus,
  AutoPosterPostStatusLastResultView,
  AutoPosterPostStatusHistoryEntryView,
  AutoPosterPostStatusView,
  AutoPosterPostStatusSuccess,
  AutoPosterMediaValidationSuccess,
  AutoPosterScheduleSuccess,
  AutoPosterScheduleReconciliationOutcome,
  AutoPosterScheduleReconciliationSuccess,
  AutoPosterQueueListParams,
  AutoPosterPostStatusParams,
  AutoPosterMediaValidationParams,
  AutoPosterScheduleParams,
  AutoPosterScheduleReconciliationParams,
  AutoPosterOperationsPort,
} from './adapters/autoPosterMissionAdapter.js';
export {
  AUTOPOSTER_ACTIONS,
  AUTOPOSTER_MISSION_ADAPTER_ID,
  createAutoPosterMissionAdapter,
  normalizeScheduledAt,
} from './adapters/autoPosterMissionAdapter.js';
export type { AutoPosterHttpPortOptions } from './adapters/autoPosterHttpPort.js';
export { createAutoPosterHttpPort, RUNTIME_CONTROL_TOKEN_HEADER } from './adapters/autoPosterHttpPort.js';

// ── Loop Governor mission adapter + process port (Phase 2C) ──
export type {
  LoopGovernorManualLoopTaskInput,
  LoopGovernorManualLoopCreateParams,
  LoopGovernorManualLoopLookupParams,
  LoopGovernorManualLoopCreateSuccess,
  LoopGovernorManualLoopLookupOutcome,
  LoopGovernorManualLoopBinding,
  LoopGovernorManualLoopLookupSuccess,
  LoopGovernorPortErrorCode,
  LoopGovernorPortFailure,
  LoopGovernorMissionPort,
  LoopGovernorSpawnImplementation,
  LoopGovernorProcessPortOptions,
} from './adapters/loopGovernorProcessPort.js';
export {
  LOOP_GOVERNOR_MISSION_INTAKE_ARGS,
  createLoopGovernorProcessPort,
} from './adapters/loopGovernorProcessPort.js';
export {
  LOOP_GOVERNOR_ACTIONS,
  LOOP_GOVERNOR_DOWNSTREAM_OPERATION_TYPE,
  createLoopGovernorMissionAdapter,
  validateManualLoopInput,
} from './adapters/loopGovernorMissionAdapter.js';

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
  safeCommitAdapter,
  SAMPLE_ADVISORY_CONTRACT,
} from './adapters/safeCommitAdapter.js';

// ── Mission ingress envelope (Phase 2A) ──
export type {
  MissionEnvelopeSourceSystem,
  ChanterMissionEnvelopeSource,
  ChanterMissionEnvelopeTarget,
  ChanterMissionEnvelopeV1,
  MissionEnvelopeValidationError,
} from './missionEnvelope.js';
export {
  MISSION_ENVELOPE_SCHEMA_VERSION,
  validateMissionEnvelope,
  canonicalEnvelopeJson,
  createEnvelopePayloadHash,
  envelopeToRuntimeMissionRequest,
} from './missionEnvelope.js';
