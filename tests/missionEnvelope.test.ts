// Tests: Phase 2A — Mission ingress envelope contract.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_ENVELOPE_SCHEMA_VERSION,
  validateMissionEnvelope,
  canonicalEnvelopeJson,
  createEnvelopePayloadHash,
  envelopeToRuntimeMissionRequest,
  type ChanterMissionEnvelopeV1,
} from "../src/missionEnvelope.js";

function validEnvelope(overrides: Partial<ChanterMissionEnvelopeV1> = {}): ChanterMissionEnvelopeV1 {
  return {
    schemaVersion: MISSION_ENVELOPE_SCHEMA_VERSION,
    missionId: "mission-001",
    traceId: "trace-001",
    source: { system: "mcp", requestedBy: "mcp-client" },
    objective: "Schedule one AutoPoster draft.",
    target: { product: "auto_poster", action: "autoposter.post.schedule" },
    tenant: { userId: "owner", workspaceId: "ws-a", accountId: "acc-a" },
    input: { provider: "tiktok", mediaUrl: "https://cdn.example.com/v.mp4" },
    constraints: ["Do not publish."],
    acceptanceCriteria: ["Exactly one queue draft created."],
    requestedAt: "2026-07-15T10:00:00Z",
    ...overrides,
  };
}

describe("Phase 2A — Mission envelope validation", () => {
  it("accepts a valid envelope", () => {
    const result = validateMissionEnvelope(validEnvelope());
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.missionId, "mission-001");
  });

  it("rejects unsupported schema version", () => {
    const result = validateMissionEnvelope(validEnvelope({ schemaVersion: "chanter.mission.v0" as never }));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "UNSUPPORTED_SCHEMA_VERSION"));
  });

  it("rejects missing missionId", () => {
    const result = validateMissionEnvelope(validEnvelope({ missionId: "" }));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "MISSING_MISSION_ID"));
  });

  it("rejects missing traceId", () => {
    const result = validateMissionEnvelope(validEnvelope({ traceId: "  " }));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "MISSING_TRACE_ID"));
  });

  it("rejects invalid source system", () => {
    const result = validateMissionEnvelope(
      validEnvelope({ source: { system: "external_agent" as never, requestedBy: "x" } }),
    );
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "INVALID_SOURCE_SYSTEM"));
  });

  it("rejects missing source.requestedBy", () => {
    const result = validateMissionEnvelope(
      validEnvelope({ source: { system: "operator", requestedBy: "" } }),
    );
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "MISSING_SOURCE_REQUESTED_BY"));
  });

  it("rejects invalid target product", () => {
    const result = validateMissionEnvelope(
      validEnvelope({ target: { product: "twitter" as never, action: "x" } }),
    );
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "INVALID_TARGET_PRODUCT"));
  });

  it("rejects missing target action", () => {
    const result = validateMissionEnvelope(
      validEnvelope({ target: { product: "auto_poster", action: "" } }),
    );
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "MISSING_TARGET_ACTION"));
  });

  it("rejects missing tenant.userId", () => {
    const result = validateMissionEnvelope(validEnvelope({ tenant: { userId: "", workspaceId: "ws" } }));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "MISSING_TENANT_USER_ID"));
  });

  it("preserves opaque workspace/account identifiers byte-for-byte", () => {
    const wsId = "  weird-but-exact  ";
    const accId = "UC-CaseSensitive";
    const envelope = validEnvelope({ tenant: { userId: "owner", workspaceId: wsId, accountId: accId } });
    const result = validateMissionEnvelope(envelope);
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.value.tenant.workspaceId === wsId);
    assert.ok(result.ok && result.value.tenant.accountId === accId);
  });

  it("rejects non-object input", () => {
    const result = validateMissionEnvelope(validEnvelope({ input: "not-object" as unknown as Record<string, never> }));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "INVALID_INPUT"));
  });

  it("rejects non-array constraints", () => {
    const result = validateMissionEnvelope(validEnvelope({ constraints: "no-push" as unknown as string[] }));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "INVALID_CONSTRAINTS"));
  });

  it("rejects invalid approval", () => {
    const result = validateMissionEnvelope(
      validEnvelope({ approval: { approved: "yes" as unknown as boolean } }),
    );
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "INVALID_APPROVAL_APPROVED"));
  });

  it("rejects invalid requestedAt", () => {
    const result = validateMissionEnvelope(validEnvelope({ requestedAt: "not-a-date" }));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.code === "INVALID_REQUESTED_AT"));
  });
});

describe("Phase 2A — Canonical JSON serialization", () => {
  it("produces deterministic key ordering regardless of insertion order", () => {
    const a: JsonValue = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b: JsonValue = { c: { y: 2, z: 1 }, a: 2, b: 1 };
    assert.equal(canonicalEnvelopeJson(a), canonicalEnvelopeJson(b));
  });

  it("produces sorted keys in output", () => {
    const result = canonicalEnvelopeJson({ b: 1, a: 2 });
    assert.equal(result, `{"a":2,"b":1}`);
  });
});

describe("Phase 2A — Envelope payload hash", () => {
  it("produces stable hash for identical envelope", () => {
    const e = validEnvelope();
    const h1 = createEnvelopePayloadHash(e);
    const h2 = createEnvelopePayloadHash(e);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  it("produces different hash when payload changes", () => {
    const e1 = validEnvelope();
    const e2 = validEnvelope({ input: { provider: "youtube", mediaUrl: "https://cdn.example.com/v.mp4" } });
    assert.notEqual(createEnvelopePayloadHash(e1), createEnvelopePayloadHash(e2));
  });

  it("produces different hash when tenant changes", () => {
    const e1 = validEnvelope();
    const e2 = validEnvelope({ tenant: { userId: "owner", workspaceId: "ws-b", accountId: "acc-a" } });
    assert.notEqual(createEnvelopePayloadHash(e1), createEnvelopePayloadHash(e2));
  });
});

describe("Phase 2A — Envelope to RuntimeMissionRequest conversion", () => {
  it("converts correctly preserving all fields", () => {
    const envelope = validEnvelope({
      idempotencyKey: "idem-1",
      approval: { approved: true, approvedBy: "founder" },
    });
    const request = envelopeToRuntimeMissionRequest(envelope);
    assert.equal(request.missionId, "mission-001");
    assert.equal(request.traceId, "trace-001");
    assert.equal(request.product, "auto_poster");
    assert.equal(request.action, "autoposter.post.schedule");
    assert.equal(request.actor.id, "mcp-client");
    assert.equal(request.actor.kind, "agent");
    assert.equal(request.tenant.userId, "owner");
    assert.equal(request.tenant.workspaceId, "ws-a");
    assert.equal(request.tenant.accountId, "acc-a");
    assert.equal(request.idempotencyKey, "idem-1");
    assert.equal(request.approval?.approved, true);
    assert.equal(request.approval?.approvedBy, "founder");
    assert.equal(request.requestedAt, "2026-07-15T10:00:00Z");
    assert.equal(request.metadata?.origin, "mcp");
    assert.equal(request.metadata?.objective, "Schedule one AutoPoster draft.");
  });

  it("converts human source to human actor kind", () => {
    const envelope = validEnvelope({ source: { system: "human", requestedBy: "founder" } });
    const request = envelopeToRuntimeMissionRequest(envelope);
    assert.equal(request.actor.kind, "human");
  });

  it("preserves constraints and acceptanceCriteria in metadata", () => {
    const envelope = validEnvelope({
      constraints: ["No deploy.", "No publish."],
      acceptanceCriteria: ["One draft only."],
    });
    const request = envelopeToRuntimeMissionRequest(envelope);
    assert.deepEqual(request.metadata?.constraints, ["No deploy.", "No publish."]);
    assert.deepEqual(request.metadata?.acceptanceCriteria, ["One draft only."]);
  });

  it("omits idempotencyKey when not provided", () => {
    const envelope = validEnvelope();
    const request = envelopeToRuntimeMissionRequest(envelope);
    assert.equal(request.idempotencyKey, undefined);
  });
});

// Import JsonValue type for the canonical JSON test
import type { JsonValue } from "../src/types.js";
