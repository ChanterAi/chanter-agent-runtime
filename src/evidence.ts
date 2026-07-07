/**
 * CHANTER Agent Runtime — evidence bundle + review summary.
 *
 * These are the two "export" shapes the runtime produces for outside
 * consumption: a compact JSON-safe bundle (SafeCommit/MCP/Operator/dashboard)
 * and a human-readable review summary (CLI/terminal output).
 */
import type {
  RuntimeEvent,
  RuntimeEventType,
  RuntimeEvidence,
  RuntimeExecutionPolicy,
  RuntimeProduct,
  RuntimeRecommendation,
  RuntimeResult,
  RuntimeRiskLevel,
  RuntimeStatus,
  RuntimeTask,
  RuntimeValidationResult,
} from './types.js';

/** Slimmed event entry — drops taskId (redundant with the bundle's own taskId) and any extra data payload. */
export interface RuntimeEventSummary {
  type: RuntimeEventType;
  timestamp: string;
  message: string;
}

/**
 * Compact, JSON-safe snapshot of a task suitable for SafeCommit, MCP,
 * Operator, and future dashboard consumption. Never contains functions,
 * undefined, or circular references — see assertJsonSafe.
 */
export interface RuntimeEvidenceBundle {
  taskId: string;
  product: RuntimeProduct;
  objective: string;
  riskLevel: RuntimeRiskLevel;
  executionPolicy: RuntimeExecutionPolicy;
  status: RuntimeStatus;
  approvalRequired: boolean;
  planSummary: string | null;
  evidence: RuntimeEvidence[];
  validationCommands: string[];
  validationResult: RuntimeValidationResult | null;
  result: RuntimeResult | null;
  eventLogSummary: RuntimeEventSummary[];
  nextRecommendation: RuntimeRecommendation | null;
  createdAt: string;
  updatedAt: string;
  generatedAt: string;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => bKeys.includes(key) && deepEqual(aObj[key], bObj[key]));
}

/** Throws if `value` is not fully JSON-serializable without data loss. */
export function assertJsonSafe(value: unknown, label = 'value'): void {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new Error(`${label} is not JSON-serializable: ${(err as Error).message}`);
  }
  if (json === undefined) {
    throw new Error(`${label} is not JSON-serializable: JSON.stringify returned undefined.`);
  }
  const roundTripped: unknown = JSON.parse(json);
  if (!deepEqual(value, roundTripped)) {
    throw new Error(`${label} is not JSON-safe: round-trip produced different data.`);
  }
}

function summarizeEvent(event: RuntimeEvent): RuntimeEventSummary {
  return { type: event.type, timestamp: event.timestamp, message: event.message };
}

/** Builds the compact, JSON-safe evidence bundle described in the runtime contract. */
export function createEvidenceBundle(task: RuntimeTask): RuntimeEvidenceBundle {
  const bundle: RuntimeEvidenceBundle = {
    taskId: task.id,
    product: task.product,
    objective: task.objective,
    riskLevel: task.riskLevel,
    executionPolicy: task.executionPolicy,
    status: task.status,
    approvalRequired: task.approvalRequired,
    planSummary: task.plan?.summary ?? null,
    evidence: task.evidence.map((item) => ({ ...item })),
    validationCommands: [...task.validationCommands],
    validationResult: task.validationResult ? { ...task.validationResult } : null,
    result: task.result ? { ...task.result } : null,
    eventLogSummary: task.logs.map(summarizeEvent),
    nextRecommendation: task.nextRecommendation ? { ...task.nextRecommendation } : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    generatedAt: new Date().toISOString(),
  };
  assertJsonSafe(bundle, `evidence bundle for task ${task.id}`);
  return bundle;
}

/** Key facts extracted for a human/CLI review pass. */
export interface RuntimeReviewSummaryFields {
  taskId: string;
  product: RuntimeProduct;
  objective: string;
  status: RuntimeStatus;
  riskLevel: RuntimeRiskLevel;
  executionPolicy: RuntimeExecutionPolicy;
  approvalRequired: boolean;
  validationPassed: boolean | null;
  evidenceCount: number;
  recommendation: string | null;
}

export interface RuntimeReviewSummary {
  /** Pre-formatted, copy-paste-ready text block. */
  text: string;
  fields: RuntimeReviewSummaryFields;
}

/** Builds a human-readable review summary (text + structured fields) for a task. */
export function summarizeTaskForReview(task: RuntimeTask): RuntimeReviewSummary {
  const fields: RuntimeReviewSummaryFields = {
    taskId: task.id,
    product: task.product,
    objective: task.objective,
    status: task.status,
    riskLevel: task.riskLevel,
    executionPolicy: task.executionPolicy,
    approvalRequired: task.approvalRequired,
    validationPassed: task.validationResult?.passed ?? null,
    evidenceCount: task.evidence.length,
    recommendation: task.nextRecommendation?.action ?? null,
  };

  const lines: string[] = [];
  lines.push(`Task ${fields.taskId} — ${fields.product}`);
  lines.push(`Objective: ${fields.objective}`);
  lines.push(`Status: ${fields.status} | Risk: ${fields.riskLevel} | Policy: ${fields.executionPolicy}`);
  lines.push(`Approval required: ${fields.approvalRequired ? 'YES' : 'no'}`);
  lines.push(
    `Validation: ${fields.validationPassed === null ? 'not run' : fields.validationPassed ? 'PASSED' : 'FAILED'}`
  );
  lines.push(`Evidence items: ${fields.evidenceCount}`);
  if (task.result) {
    lines.push(`Result: ${task.result.success ? 'SUCCESS' : 'FAILURE'} — ${task.result.summary}`);
  }
  if (task.nextRecommendation) {
    lines.push(`Recommendation: ${task.nextRecommendation.action} — ${task.nextRecommendation.reason}`);
  }

  return { text: lines.join('\n'), fields };
}
