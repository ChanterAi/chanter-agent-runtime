/**
 * CHANTER Agent Runtime — versioned mission ingress envelope.
 *
 * One versioned, runtime-validated contract that any CHANTER OS ingress
 * (Operator, MCP, Mission Compiler, Loop Governor, human) can submit.
 * Converts to the existing RuntimeMissionRequest so every existing control
 * (policy, approval, idempotency, redaction, evidence) applies unchanged.
 *
 * Design rules:
 *  - no duplicated execution semantics — the envelope is ingress-only;
 *  - deterministic canonical serialization for stable payload hashing;
 *  - opaque workspace/account identifiers preserved byte-for-byte;
 *  - no secret-bearing fields.
 */
import { createHash } from "node:crypto";
import type { JsonValue, RuntimeProduct } from "./types.js";
import type {
  RuntimeMissionActor,
  RuntimeMissionApproval,
  RuntimeMissionRequest,
  RuntimeMissionTenant,
} from "./missions.js";

// ---------------------------------------------------------------------------
// Envelope contract
// ---------------------------------------------------------------------------

export const MISSION_ENVELOPE_SCHEMA_VERSION = "chanter.mission.v1" as const;

export type MissionEnvelopeSourceSystem =
  | "operator"
  | "mcp"
  | "mission_compiler"
  | "loop_governor"
  | "human";

export interface ChanterMissionEnvelopeSource {
  system: MissionEnvelopeSourceSystem;
  requestedBy: string;
}

export interface ChanterMissionEnvelopeTarget {
  product: RuntimeProduct;
  action: string;
}

export interface ChanterMissionEnvelopeV1 {
  schemaVersion: typeof MISSION_ENVELOPE_SCHEMA_VERSION;
  missionId: string;
  traceId: string;
  idempotencyKey?: string;
  source: ChanterMissionEnvelopeSource;
  objective: string;
  target: ChanterMissionEnvelopeTarget;
  tenant: RuntimeMissionTenant;
  input: Record<string, JsonValue>;
  constraints: string[];
  acceptanceCriteria: string[];
  approval?: RuntimeMissionApproval;
  requestedAt: string;
  metadata?: Record<string, JsonValue>;
}

export interface MissionEnvelopeValidationError {
  code: string;
  message: string;
}

const VALID_SOURCE_SYSTEMS: readonly string[] = [
  "operator",
  "mcp",
  "mission_compiler",
  "loop_governor",
  "human",
];

const VALID_PRODUCTS: readonly string[] = [
  "loop_governor",
  "safecommit",
  "operator",
  "mcp_server",
  "auto_poster",
  "clean_engine",
];

// ---------------------------------------------------------------------------
// Runtime validator
// ---------------------------------------------------------------------------

export function validateMissionEnvelope(
  envelope: unknown,
): { ok: true; value: ChanterMissionEnvelopeV1 } | { ok: false; errors: MissionEnvelopeValidationError[] } {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return {
      ok: false,
      errors: [{ code: "INVALID_ENVELOPE", message: "Envelope must be a JSON object." }],
    };
  }

  const e = envelope as Record<string, unknown>;
  const errors: MissionEnvelopeValidationError[] = [];

  // schemaVersion
  if (e.schemaVersion !== MISSION_ENVELOPE_SCHEMA_VERSION) {
    errors.push({
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `schemaVersion must be "${MISSION_ENVELOPE_SCHEMA_VERSION}".`,
    });
  }

  // missionId
  if (typeof e.missionId !== "string" || !e.missionId.trim()) {
    errors.push({ code: "MISSING_MISSION_ID", message: "missionId is required and must be a nonblank string." });
  }

  // traceId
  if (typeof e.traceId !== "string" || !e.traceId.trim()) {
    errors.push({ code: "MISSING_TRACE_ID", message: "traceId is required and must be a nonblank string." });
  }

  // idempotencyKey (optional, must be nonblank when present)
  if (e.idempotencyKey !== undefined) {
    if (typeof e.idempotencyKey !== "string" || !e.idempotencyKey.trim()) {
      errors.push({ code: "INVALID_IDEMPOTENCY_KEY", message: "idempotencyKey must be a nonblank string when provided." });
    }
  }

  // source
  if (e.source === null || typeof e.source !== "object" || Array.isArray(e.source)) {
    errors.push({ code: "MISSING_SOURCE", message: "source is required and must be an object." });
  } else {
    const s = e.source as Record<string, unknown>;
    if (!VALID_SOURCE_SYSTEMS.includes(s.system as string)) {
      errors.push({
        code: "INVALID_SOURCE_SYSTEM",
        message: `source.system must be one of: ${VALID_SOURCE_SYSTEMS.join(", ")}.`,
      });
    }
    if (typeof s.requestedBy !== "string" || !s.requestedBy.trim()) {
      errors.push({ code: "MISSING_SOURCE_REQUESTED_BY", message: "source.requestedBy is required." });
    }
  }

  // objective
  if (typeof e.objective !== "string" || !e.objective.trim()) {
    errors.push({ code: "MISSING_OBJECTIVE", message: "objective is required." });
  }

  // target
  if (e.target === null || typeof e.target !== "object" || Array.isArray(e.target)) {
    errors.push({ code: "MISSING_TARGET", message: "target is required and must be an object." });
  } else {
    const t = e.target as Record<string, unknown>;
    if (!VALID_PRODUCTS.includes(t.product as string)) {
      errors.push({ code: "INVALID_TARGET_PRODUCT", message: "target.product is not a valid RuntimeProduct." });
    }
    if (typeof t.action !== "string" || !t.action.trim()) {
      errors.push({ code: "MISSING_TARGET_ACTION", message: "target.action is required." });
    }
  }

  // tenant — opaque workspace/account preserved byte-for-byte
  if (e.tenant === null || typeof e.tenant !== "object" || Array.isArray(e.tenant)) {
    errors.push({ code: "MISSING_TENANT", message: "tenant is required." });
  } else {
    const tn = e.tenant as Record<string, unknown>;
    if (typeof tn.userId !== "string" || !tn.userId.trim()) {
      errors.push({ code: "MISSING_TENANT_USER_ID", message: "tenant.userId is required." });
    }
    if (tn.workspaceId !== undefined && (typeof tn.workspaceId !== "string" || !tn.workspaceId)) {
      errors.push({ code: "INVALID_TENANT_WORKSPACE_ID", message: "tenant.workspaceId must be a string when provided." });
    }
    if (tn.accountId !== undefined && (typeof tn.accountId !== "string" || !tn.accountId)) {
      errors.push({ code: "INVALID_TENANT_ACCOUNT_ID", message: "tenant.accountId must be a string when provided." });
    }
  }

  // input
  if (e.input === null || typeof e.input !== "object" || Array.isArray(e.input)) {
    errors.push({ code: "INVALID_INPUT", message: "input must be an object payload." });
  }

  // constraints
  if (!Array.isArray(e.constraints) || !e.constraints.every((c) => typeof c === "string")) {
    errors.push({ code: "INVALID_CONSTRAINTS", message: "constraints must be an array of strings." });
  }

  // acceptanceCriteria
  if (!Array.isArray(e.acceptanceCriteria) || !e.acceptanceCriteria.every((c) => typeof c === "string")) {
    errors.push({ code: "INVALID_ACCEPTANCE_CRITERIA", message: "acceptanceCriteria must be an array of strings." });
  }

  // approval (optional)
  if (e.approval !== undefined) {
    if (e.approval === null || typeof e.approval !== "object" || Array.isArray(e.approval)) {
      errors.push({ code: "INVALID_APPROVAL", message: "approval must be an object when provided." });
    } else {
      const a = e.approval as Record<string, unknown>;
      if (typeof a.approved !== "boolean") {
        errors.push({ code: "INVALID_APPROVAL_APPROVED", message: "approval.approved must be a boolean." });
      }
    }
  }

  // requestedAt
  if (typeof e.requestedAt !== "string" || Number.isNaN(Date.parse(e.requestedAt))) {
    errors.push({ code: "INVALID_REQUESTED_AT", message: "requestedAt must be a valid ISO-8601 timestamp." });
  }

  // metadata (optional)
  if (e.metadata !== undefined && (e.metadata === null || typeof e.metadata !== "object" || Array.isArray(e.metadata))) {
    errors.push({ code: "INVALID_METADATA", message: "metadata must be an object when provided." });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: e as unknown as ChanterMissionEnvelopeV1 };
}

// ---------------------------------------------------------------------------
// Canonical JSON serialization (deterministic object-key ordering)
// ---------------------------------------------------------------------------

export function canonicalEnvelopeJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEnvelopeJson).join(",")}]`;
  const entries = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalEnvelopeJson(item)}`);
  return `{${entries.join(",")}}`;
}

// ---------------------------------------------------------------------------
// Stable payload hash — binds product/action/tenant/input
// ---------------------------------------------------------------------------

export function createEnvelopePayloadHash(envelope: ChanterMissionEnvelopeV1): string {
  const payload: JsonValue = {
    version: "chanter-mission-envelope-v1",
    schemaVersion: envelope.schemaVersion,
    target: { product: envelope.target.product, action: envelope.target.action },
    tenant: {
      userId: envelope.tenant.userId.trim(),
      workspaceId: envelope.tenant.workspaceId ?? null,
      accountId: envelope.tenant.accountId ?? null,
    },
    input: envelope.input,
  };
  return createHash("sha256").update(canonicalEnvelopeJson(payload)).digest("hex");
}

// ---------------------------------------------------------------------------
// Conversion to RuntimeMissionRequest
// ---------------------------------------------------------------------------

export function envelopeToRuntimeMissionRequest(envelope: ChanterMissionEnvelopeV1): RuntimeMissionRequest {
  const actor: RuntimeMissionActor = {
    id: envelope.source.requestedBy,
    kind: envelope.source.system === "human" ? "human" : "agent",
  };

  return {
    missionId: envelope.missionId,
    traceId: envelope.traceId,
    product: envelope.target.product,
    action: envelope.target.action,
    actor,
    tenant: envelope.tenant,
    input: envelope.input,
    requestedAt: envelope.requestedAt,
    ...(envelope.approval ? { approval: envelope.approval } : {}),
    ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
    metadata: {
      ...(envelope.metadata ?? {}),
      origin: envelope.source.system,
      objective: envelope.objective,
      ...(envelope.constraints.length > 0 ? { constraints: envelope.constraints as JsonValue[] } : {}),
      ...(envelope.acceptanceCriteria.length > 0 ? { acceptanceCriteria: envelope.acceptanceCriteria as JsonValue[] } : {}),
    },
  };
}
