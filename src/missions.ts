/**
 * CHANTER Agent Runtime — mission execution layer (P1B).
 *
 * A mission is one externally requested product action (e.g. MCP asking
 * AutoPoster to schedule a post) driven through the existing task lifecycle:
 * the mission envelope carries identity/tenant/approval/idempotency context,
 * and `executeMission` maps it onto a real RuntimeTask so every existing
 * control — transition table, approval gate, action policy, redaction,
 * evidence bundle — applies unchanged.
 *
 * This module owns orchestration only. Product behavior lives in a
 * RuntimeMissionAdapter (see adapters/), and the adapter in turn delegates
 * to the product's own services; no business logic is duplicated here.
 *
 * Truthfulness guarantees:
 *  - the adapter is never invoked when validation, approval, or policy fails;
 *  - a downstream failure is never reported as success;
 *  - every result status is explicit (`succeeded`/`failed`/`denied`/
 *    `validation_failed`/`approval_required`/`duplicate`/`unavailable`);
 *  - all outputs, errors, and evidence pass through the runtime's redaction
 *    choke points before leaving this module.
 */
import type { JsonValue, RuntimeProduct, RuntimeRiskLevel, RuntimeExecutionPolicy } from './types.js';
import {
  approveTask,
  attachEvidence,
  attachPlan,
  completeTask,
  createTask,
  failTask,
  failValidation,
  passValidation,
  requireApproval,
  startExecution,
  startValidation,
  type RuntimeEvidenceInput,
} from './tasks.js';
import { evaluateRuntimeActionPolicy, type RuntimeActionDecision, type RuntimeActionType } from './policy.js';
import { createEvidenceBundle, type RuntimeEvidenceBundle } from './evidence.js';
import { redactJsonValue, redactText } from './redaction.js';

// ---------------------------------------------------------------------------
// Mission request contract
// ---------------------------------------------------------------------------

/** Who is asking for this mission. */
export interface RuntimeMissionActor {
  /** Stable identifier for the requester, e.g. 'mcp-client', 'founder'. */
  id: string;
  kind?: 'human' | 'agent' | 'service';
}

/** Tenant/account scope the mission executes under. */
export interface RuntimeMissionTenant {
  /** Owning user/tenant identifier. Downstream products re-verify this server-side. */
  userId: string;
  /** Optional workspace scope. Downstream products re-verify membership server-side. */
  workspaceId?: string;
  /** Optional product account/channel scope (e.g. a TikTok channel id). */
  accountId?: string;
}

/** Approval context supplied by the caller. The runtime decides whether it is sufficient. */
export interface RuntimeMissionApproval {
  approved: boolean;
  approvedBy?: string;
  note?: string;
}

/** One externally requested product action. */
export interface RuntimeMissionRequest {
  /** Caller-supplied unique id for this mission. */
  missionId: string;
  /** Correlation id preserved through the full call chain. Defaults to missionId. */
  traceId?: string;
  product: RuntimeProduct;
  /** Canonical action id, e.g. 'autoposter.post.schedule'. */
  action: string;
  actor: RuntimeMissionActor;
  tenant: RuntimeMissionTenant;
  /** Action-specific payload. Validated by the adapter before any execution. */
  input: Record<string, JsonValue>;
  /** Optional free-form policy reason recorded with the policy decision. */
  policyContext?: { reason?: string };
  approval?: RuntimeMissionApproval;
  /** Required for write actions (spec.requiresIdempotencyKey). */
  idempotencyKey?: string;
  metadata?: Record<string, JsonValue>;
  /** ISO-8601 timestamp of when the caller issued the request. */
  requestedAt?: string;
}

// ---------------------------------------------------------------------------
// Mission result contract
// ---------------------------------------------------------------------------

/** Explicit, truthful mission outcome statuses. */
export type RuntimeMissionStatus =
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'validation_failed'
  | 'approval_required'
  | 'duplicate'
  | 'unavailable';

/** One structured, redacted error. `code` is stable; `message` is human-readable. */
export interface RuntimeMissionError {
  code: string;
  message: string;
}

export interface RuntimeMissionApprovalDecision {
  required: boolean;
  approved: boolean;
  approvedBy: string | null;
}

export type RuntimeMissionIdempotencyOutcome = 'not_applicable' | 'first_execution' | 'duplicate';

export interface RuntimeMissionIdempotencyResult {
  key: string | null;
  outcome: RuntimeMissionIdempotencyOutcome;
  /** Set when outcome is 'duplicate': the mission that originally executed this key. */
  originalMissionId?: string;
}

export interface RuntimeMissionResult {
  missionId: string;
  traceId: string;
  product: RuntimeProduct;
  action: string;
  status: RuntimeMissionStatus;
  output: JsonValue | null;
  evidence: RuntimeEvidenceBundle | null;
  warnings: string[];
  errors: RuntimeMissionError[];
  policyDecision: RuntimeActionDecision | null;
  approvalDecision: RuntimeMissionApprovalDecision;
  idempotency: RuntimeMissionIdempotencyResult;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Mission adapter contract
// ---------------------------------------------------------------------------

/** Declares one action an adapter supports and how the runtime must gate it. */
export interface RuntimeMissionActionSpec {
  action: string;
  description: string;
  /** Maps to the action policy evaluator ('read' or 'write' today). */
  policyActionType: Extract<RuntimeActionType, 'read' | 'write'>;
  riskLevel: RuntimeRiskLevel;
  executionPolicy: RuntimeExecutionPolicy;
  /** True when a missing idempotency key must fail the mission closed. */
  requiresIdempotencyKey: boolean;
  /**
   * Optional product-owned validation for every identity field that affects
   * replay scope. It runs before stored or in-flight results can be reused, so
   * a malformed request cannot bypass adapter validation through a cache hit.
   */
  validateIdempotencyScope?: (request: RuntimeMissionRequest) => RuntimeMissionError[];
  /**
   * Optional product-owned canonical scope that participates in Runtime
   * idempotency. This prevents one logical provider/resource scope from
   * replaying another while keeping product normalization out of the core.
   */
  resolveIdempotencyScope?: (request: RuntimeMissionRequest) => string | null;
}

/**
 * What an adapter reports back after actually attempting the operation.
 * `ok: false` must carry a truthful `status` refinement and structured errors.
 */
export interface RuntimeMissionAdapterOutcome {
  ok: boolean;
  /** Refines the mission status for failures. Ignored when ok=true unless 'duplicate'. */
  status?: 'succeeded' | 'failed' | 'denied' | 'validation_failed' | 'unavailable' | 'duplicate';
  output?: JsonValue;
  warnings?: string[];
  errors?: RuntimeMissionError[];
  evidence?: RuntimeEvidenceInput[];
}

/** A product adapter that can execute mission actions (distinct from the mapping-only RuntimeProductAdapter). */
export interface RuntimeMissionAdapter {
  /** Stable identifier, e.g. 'autoposter-mission-adapter'. */
  id: string;
  product: RuntimeProduct;
  version: string;
  actions: RuntimeMissionActionSpec[];
  execute(request: RuntimeMissionRequest, spec: RuntimeMissionActionSpec): Promise<RuntimeMissionAdapterOutcome>;
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

/** Immutable lookup from product to its registered mission adapter. */
export interface RuntimeMissionAdapterRegistry {
  getAdapter(product: RuntimeProduct): RuntimeMissionAdapter | undefined;
  listAdapters(): RuntimeMissionAdapter[];
}

/** Builds a registry. Registering two adapters for one product is a wiring bug and throws. */
export function createMissionAdapterRegistry(adapters: RuntimeMissionAdapter[]): RuntimeMissionAdapterRegistry {
  const byProduct = new Map<RuntimeProduct, RuntimeMissionAdapter>();
  for (const adapter of adapters) {
    if (byProduct.has(adapter.product)) {
      throw new Error(`Duplicate mission adapter for product "${adapter.product}".`);
    }
    byProduct.set(adapter.product, adapter);
  }
  return {
    getAdapter: (product) => byProduct.get(product),
    listAdapters: () => [...byProduct.values()],
  };
}

// ---------------------------------------------------------------------------
// Idempotency store
// ---------------------------------------------------------------------------

/**
 * Records the result of every mission that actually reached an adapter. The
 * runtime supplies an opaque key scoped to product + action + tenant user +
 * workspace + exact account + product-owned canonical scope + caller
 * idempotency key, preventing one action or tenant/account/provider scope
 * from replaying another scope's result. Missions that never executed
 * (validation/approval/policy refusals) do not consume their key, so a
 * corrected retry with the same caller key still works.
 */
export interface RuntimeMissionIdempotencyStore {
  get(key: string): RuntimeMissionResult | undefined;
  set(key: string, result: RuntimeMissionResult): void;
}

function scopedIdempotencyStoreKey(
  request: RuntimeMissionRequest,
  spec: RuntimeMissionActionSpec,
  callerKey: string
): string {
  return JSON.stringify([
    'runtime-mission-idempotency-v4',
    request.product,
    request.action,
    request.tenant.userId.trim(),
    // A supplied workspace is part of the exact replay identity. Product
    // validation rejects non-canonical values before this key is consulted.
    request.tenant.workspaceId ?? null,
    // Account ids are opaque and case-sensitive. Upstream canonical
    // selection supplies tenant.accountId; preserve it byte-for-byte.
    request.tenant.accountId ?? null,
    spec.resolveIdempotencyScope?.(request) ?? null,
    callerKey,
  ]);
}

/**
 * Per-store in-flight executions close the async get-then-set window without
 * changing the public store interface. Only missions that clear validation,
 * approval, and policy gates are registered here.
 */
const inFlightByStore = new WeakMap<
  RuntimeMissionIdempotencyStore,
  Map<string, Promise<RuntimeMissionResult>>
>();

function inFlightExecutions(
  store: RuntimeMissionIdempotencyStore
): Map<string, Promise<RuntimeMissionResult>> {
  const existing = inFlightByStore.get(store);
  if (existing) return existing;
  const created = new Map<string, Promise<RuntimeMissionResult>>();
  inFlightByStore.set(store, created);
  return created;
}

/** Simple per-process Map-backed store. Durable stores can implement the same interface. */
export function createInMemoryIdempotencyStore(): RuntimeMissionIdempotencyStore {
  const results = new Map<string, RuntimeMissionResult>();
  return {
    get: (key) => results.get(key),
    set: (key, result) => {
      results.set(key, result);
    },
  };
}

// ---------------------------------------------------------------------------
// executeMission
// ---------------------------------------------------------------------------

export interface ExecuteMissionOptions {
  registry: RuntimeMissionAdapterRegistry;
  idempotencyStore?: RuntimeMissionIdempotencyStore;
}

interface ResultDraft {
  status: RuntimeMissionStatus;
  output?: JsonValue | null;
  evidence?: RuntimeEvidenceBundle | null;
  warnings?: string[];
  errors?: RuntimeMissionError[];
  policyDecision?: RuntimeActionDecision | null;
  approvalDecision?: RuntimeMissionApprovalDecision;
  idempotency?: RuntimeMissionIdempotencyResult;
}

function redactErrors(errors: RuntimeMissionError[] | undefined): RuntimeMissionError[] {
  return (errors ?? []).map((error) => ({ code: error.code, message: redactText(error.message) }));
}

function validateRequestShape(request: RuntimeMissionRequest): RuntimeMissionError[] {
  const errors: RuntimeMissionError[] = [];
  if (!request.missionId || !request.missionId.trim()) {
    errors.push({ code: 'MISSING_MISSION_ID', message: 'missionId is required.' });
  }
  if (!request.action || !request.action.trim()) {
    errors.push({ code: 'MISSING_ACTION', message: 'action is required.' });
  }
  if (!request.actor || !request.actor.id || !request.actor.id.trim()) {
    errors.push({ code: 'MISSING_ACTOR', message: 'actor.id is required.' });
  }
  if (!request.tenant || !request.tenant.userId || !request.tenant.userId.trim()) {
    errors.push({ code: 'MISSING_TENANT', message: 'tenant.userId is required.' });
  }
  if (request.input === null || typeof request.input !== 'object' || Array.isArray(request.input)) {
    errors.push({ code: 'INVALID_INPUT', message: 'input must be an object payload.' });
  }
  if (request.requestedAt !== undefined && Number.isNaN(Date.parse(request.requestedAt))) {
    errors.push({ code: 'INVALID_REQUESTED_AT', message: 'requestedAt must be a valid ISO-8601 timestamp.' });
  }
  return errors;
}

/**
 * Executes one mission through the full runtime control chain:
 *
 *   validate envelope -> resolve adapter/action -> idempotency replay check
 *   -> RuntimeTask creation (redacted inputs) -> approval gate -> action
 *   policy gate -> adapter execution -> validation -> truthful result
 *   + redacted evidence bundle.
 *
 * Never throws for mission-level failures — every refusal and downstream
 * failure is returned as a structured, truthful RuntimeMissionResult.
 */
export async function executeMission(
  request: RuntimeMissionRequest,
  options: ExecuteMissionOptions
): Promise<RuntimeMissionResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const traceId = request.traceId && request.traceId.trim() ? request.traceId : request.missionId;

  const approvalDecisionDefault: RuntimeMissionApprovalDecision = {
    required: false,
    approved: Boolean(request.approval?.approved),
    approvedBy: request.approval?.approvedBy?.trim() || null,
  };

  const finish = (draft: ResultDraft): RuntimeMissionResult => {
    const completedAt = new Date().toISOString();
    return {
      missionId: request.missionId,
      traceId,
      product: request.product,
      action: request.action,
      status: draft.status,
      output: draft.output === undefined ? null : redactJsonValue(draft.output as JsonValue),
      evidence: draft.evidence ?? null,
      warnings: (draft.warnings ?? []).map(redactText),
      errors: redactErrors(draft.errors),
      policyDecision: draft.policyDecision ?? null,
      approvalDecision: draft.approvalDecision ?? approvalDecisionDefault,
      idempotency: draft.idempotency ?? {
        key: request.idempotencyKey?.trim() || null,
        outcome: 'not_applicable',
      },
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.now() - startedMs),
    };
  };

  // 1. Envelope validation — fail closed before touching anything else.
  const shapeErrors = validateRequestShape(request);
  if (shapeErrors.length > 0) {
    return finish({ status: 'validation_failed', errors: shapeErrors });
  }

  // 2. Adapter + action resolution — unknown products/actions fail clearly.
  const adapter = options.registry.getAdapter(request.product);
  if (!adapter) {
    return finish({
      status: 'denied',
      errors: [
        {
          code: 'UNKNOWN_PRODUCT',
          message: `No mission adapter is registered for product "${request.product}".`,
        },
      ],
    });
  }
  const spec = adapter.actions.find((candidate) => candidate.action === request.action);
  if (!spec) {
    return finish({
      status: 'denied',
      errors: [
        {
          code: 'UNSUPPORTED_ACTION',
          message: `Action "${request.action}" is not supported by adapter "${adapter.id}". Supported: ${adapter.actions
            .map((candidate) => candidate.action)
            .join(', ')}.`,
        },
      ],
    });
  }

  // 3. Idempotency key requirement — fail closed when a write demands one.
  const idempotencyKey = request.idempotencyKey?.trim() || null;
  if (spec.requiresIdempotencyKey && !idempotencyKey) {
    return finish({
      status: 'validation_failed',
      errors: [
        {
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: `Action "${spec.action}" requires an idempotencyKey.`,
        },
      ],
    });
  }

  // 4. Idempotency replay — a key that already executed returns the stored
  //    result as an explicit duplicate instead of executing twice.
  // Product-owned replay scope must be valid before either the durable cache
  // or the in-flight coalescing map is consulted. In particular, a malformed
  // account/provider/workspace request must never inherit a prior success.
  const idempotencyScopeErrors = spec.validateIdempotencyScope?.(request) ?? [];
  if (idempotencyScopeErrors.length > 0) {
    return finish({ status: 'validation_failed', errors: idempotencyScopeErrors });
  }

  const store = options.idempotencyStore;
  const storeKey = idempotencyKey ? scopedIdempotencyStoreKey(request, spec, idempotencyKey) : null;
  const replayExisting = (
    existing: RuntimeMissionResult,
    source: 'stored' | 'concurrent'
  ): RuntimeMissionResult => {
    const accepted = existing.status === 'succeeded' || existing.status === 'duplicate';
    const replayMessage = source === 'concurrent'
      ? `Idempotency key is already executing in mission ${existing.missionId}; this request shared its result and performed no second execution.`
      : `Idempotency key was already executed by mission ${existing.missionId} (status: ${existing.status}); no second execution was performed.`;
    return finish({
      // A coalesced failure remains a failure. It is never converted into a
      // non-error duplicate, and no automatic retry is attempted.
      status: accepted ? 'duplicate' : existing.status,
      output: existing.output,
      evidence: existing.evidence,
      warnings: [...existing.warnings, replayMessage],
      errors: existing.errors,
      policyDecision: existing.policyDecision,
      approvalDecision: existing.approvalDecision,
      idempotency: { key: idempotencyKey, outcome: 'duplicate', originalMissionId: existing.missionId },
    });
  };
  if (storeKey && store) {
    const existing = store.get(storeKey);
    if (existing) {
      return replayExisting(existing, 'stored');
    }
    const inFlight = inFlightExecutions(store).get(storeKey);
    if (inFlight) {
      const existingInFlightResult = await inFlight;
      return replayExisting(existingInFlightResult, 'concurrent');
    }
  }

  // 5. Real RuntimeTask — every existing lifecycle control now applies.
  let task = createTask({
    product: request.product,
    objective: `${spec.action} (mission ${request.missionId})`,
    riskLevel: spec.riskLevel,
    executionPolicy: spec.executionPolicy,
    inputs: {
      missionId: request.missionId,
      traceId,
      action: spec.action,
      actorId: request.actor.id,
      actorKind: request.actor.kind ?? 'agent',
      tenantUserId: request.tenant.userId,
      tenantWorkspaceId: request.tenant.workspaceId ?? null,
      tenantAccountId: request.tenant.accountId ?? null,
      input: request.input,
      metadata: request.metadata ?? {},
      requestedAt: request.requestedAt ?? startedAt,
    },
  });
  task = attachPlan(task, {
    summary: `Execute ${spec.action} through adapter ${adapter.id} v${adapter.version}.`,
    steps: [
      { description: 'Enforce approval and action policy gates' },
      { description: `Dispatch to ${adapter.id}` },
      { description: 'Validate the downstream outcome truthfully' },
    ],
  });

  // 6. Approval gate — reuses the transition table's enforcement.
  const approvalDecision: RuntimeMissionApprovalDecision = {
    required: task.approvalRequired,
    approved: approvalDecisionDefault.approved,
    approvedBy: approvalDecisionDefault.approvedBy,
  };
  if (task.approvalRequired) {
    task = requireApproval(task);
    if (request.approval?.approved === true && approvalDecision.approvedBy) {
      task = approveTask(task, approvalDecision.approvedBy, request.approval.note);
    } else {
      return finish({
        status: 'approval_required',
        evidence: createEvidenceBundle(task),
        errors: [
          {
            code: 'APPROVAL_REQUIRED',
            message: `Action "${spec.action}" requires explicit approval (approved=true with approvedBy) before it can execute.`,
          },
        ],
        approvalDecision,
      });
    }
  }

  // 7. Action policy gate — denied actions never reach the adapter.
  const policyDecision = evaluateRuntimeActionPolicy(task, {
    actionType: spec.policyActionType,
    target: spec.action,
    reason: request.policyContext?.reason ?? `Mission ${request.missionId} requested by ${request.actor.id}.`,
  });
  if (!policyDecision.allowed) {
    return finish({
      status: policyDecision.approvalRequired ? 'approval_required' : 'denied',
      evidence: createEvidenceBundle(task),
      errors: [
        {
          code: policyDecision.approvalRequired ? 'APPROVAL_REQUIRED' : 'POLICY_DENIED',
          message: policyDecision.reasons.join(' '),
        },
      ],
      policyDecision,
      approvalDecision,
    });
  }

  // 8. Adapter execution — exceptions become truthful failures, never success.
  const executeAfterGates = async (): Promise<RuntimeMissionResult> => {
    task = startExecution(task);
    let outcome: RuntimeMissionAdapterOutcome;
    try {
      outcome = await adapter.execute(request, spec);
    } catch (error) {
      outcome = {
        ok: false,
        status: 'failed',
        errors: [
          {
            code: 'ADAPTER_EXCEPTION',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }

    for (const evidenceInput of outcome.evidence ?? []) {
      task = attachEvidence(task, evidenceInput);
    }

    // 9. Validation + terminal transition, driven by the adapter's truthful outcome.
    task = startValidation(task);
    // Redacted here because this text is embedded into the task result summary,
    // which the runtime treats as caller-supplied safe text (see evidence.ts).
    const checkMessage =
      outcome.errors && outcome.errors.length > 0
        ? redactText(outcome.errors.map((error) => `${error.code}: ${error.message}`).join('; '))
        : undefined;
    const checks = [
      {
        command: `adapter:${adapter.id}:${spec.action}`,
        passed: outcome.ok,
        ...(checkMessage !== undefined ? { message: checkMessage } : {}),
      },
    ];
    const summary = outcome.ok
      ? `${spec.action} completed via ${adapter.id}.`
      : `${spec.action} did not complete: ${checkMessage ?? 'downstream failure'}.`;
    if (outcome.ok) {
      task = passValidation(task, { checks });
      task = completeTask(task, { summary, ...(outcome.output !== undefined ? { output: outcome.output } : {}) });
    } else {
      task = failValidation(task, { checks });
      task = failTask(task, { summary, ...(outcome.output !== undefined ? { output: outcome.output } : {}) });
    }

    const status: RuntimeMissionStatus = outcome.ok
      ? outcome.status === 'duplicate'
        ? 'duplicate'
        : 'succeeded'
      : outcome.status && outcome.status !== 'succeeded'
        ? outcome.status
        : 'failed';

    const result = finish({
      status,
      output: outcome.output ?? null,
      evidence: createEvidenceBundle(task),
      warnings: outcome.warnings,
      errors: outcome.errors,
      policyDecision,
      approvalDecision,
      idempotency: idempotencyKey
        ? { key: idempotencyKey, outcome: status === 'duplicate' ? 'duplicate' : 'first_execution' }
        : { key: null, outcome: 'not_applicable' },
    });

    // 10. Only successful/duplicate downstream outcomes consume the Runtime
    // idempotency key. A refusal or unavailable dependency has no accepted side
    // effect to replay, and must remain retryable under corrected server truth.
    if (storeKey && store && outcome.ok) {
      store.set(storeKey, result);
    }
    return result;
  };

  if (storeKey && store) {
    const inFlight = inFlightExecutions(store);
    // Schedule execution in a microtask so the reservation is visible before
    // any adapter code can re-enter this runtime with the same scoped key.
    const execution = Promise.resolve().then(executeAfterGates);
    inFlight.set(storeKey, execution);
    try {
      return await execution;
    } finally {
      if (inFlight.get(storeKey) === execution) inFlight.delete(storeKey);
    }
  }
  return executeAfterGates();
}
