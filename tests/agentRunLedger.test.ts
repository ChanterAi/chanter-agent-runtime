import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENT_RUN_LEDGER_PAYLOAD_HASH_DOMAIN,
  AGENT_RUN_LEDGER_SCHEMA_VERSION,
  AGENT_RUN_LEDGER_SCOPE_HASH_DOMAIN,
  AgentRunLedgerReplayMismatchError,
  AgentRunLedgerTransitionError,
  AgentRunLedgerValidationError,
  assertAgentRunLedgerExactReplay,
  assertAgentRunLedgerTransition,
  canonicalizeAgentRunLedgerJson,
  createAgentRunLedgerEntry,
  createAgentRunLedgerPayloadHash,
  createAgentRunLedgerScopeHash,
  deriveAgentRunLedgerOutcome,
  normalizeAgentRunLedgerEntry,
  validateAgentRunLedgerEntry,
  verifyAgentRunLedgerHashes,
  type AgentRunLedgerEntry,
  type AgentRunLedgerEntryDraft,
  type AgentRunLedgerValidationIssueCode,
} from '../src/index.js';

const T0 = '2026-07-14T10:00:00.000Z';

function makeDraft(overrides: Partial<AgentRunLedgerEntryDraft> = {}): AgentRunLedgerEntryDraft {
  return {
    schema_version: '1.0',
    run_id: 'Run-Exact A',
    event_id: 'Run-Exact A:event:1',
    sequence: 1,
    product_id: 'loop_governor',
    workflow_id: 'controlled_local_loop',
    agent_id: 'governor-agent',
    attempt_id: 'Run-Exact A:attempt:1',
    parent_run_id: null,
    trace_id: 'Trace-CaseSensitive',
    status: 'created',
    outcome: 'pending',
    started_at: T0,
    completed_at: null,
    provider: 'not_applicable',
    model: 'not_applicable',
    input_summary: 'Controlled local ledger demonstration.',
    actions_taken: [{
      action_id: 'lifecycle',
      action_type: 'loop.lifecycle',
      summary: 'Created the controlled run.',
      outcome: 'pending',
    }],
    tools_used: [],
    latency_ms: null,
    cost_estimate: { kind: 'not_applicable', amount_micros: null, currency: null },
    approval_status: 'not_required',
    approval_actor: null,
    approval_timestamp: null,
    risk_level: 'low',
    production_impact: false,
    validation_result: 'not_run',
    validation_summary: null,
    failure_reason: null,
    failure_code: null,
    evidence_refs: [],
    evidence_count: 0,
    evidence_integrity_status: 'not_present',
    created_at: T0,
    updated_at: T0,
    source_subsystem: 'chanter-loop.governor',
    ...overrides,
  };
}

function makeCompletedDraft(overrides: Partial<AgentRunLedgerEntryDraft> = {}): AgentRunLedgerEntryDraft {
  return makeDraft({
    event_id: 'Run-Exact A:event:6',
    sequence: 6,
    status: 'completed',
    outcome: 'success',
    completed_at: '2026-07-14T10:00:05.000Z',
    latency_ms: 5_000,
    actions_taken: [{
      action_id: 'lifecycle',
      action_type: 'loop.lifecycle',
      summary: 'Completed the controlled run.',
      outcome: 'succeeded',
    }],
    validation_result: 'passed',
    validation_summary: 'All controlled checks passed.',
    evidence_refs: [{
      evidence_id: 'evidence-local-1',
      kind: 'artifact',
      uri: 'evidence/Run-Exact-A/result.json',
      sha256: 'a'.repeat(64),
      captured_at: '2026-07-14T10:00:04.000Z',
    }],
    evidence_count: 1,
    evidence_integrity_status: 'verified',
    updated_at: '2026-07-14T10:00:05.000Z',
    ...overrides,
  });
}

function makeFailedDraft(overrides: Partial<AgentRunLedgerEntryDraft> = {}): AgentRunLedgerEntryDraft {
  return makeDraft({
    event_id: 'Run-Exact A:event:4',
    sequence: 4,
    status: 'failed',
    outcome: 'failure',
    completed_at: '2026-07-14T10:00:03.000Z',
    latency_ms: 3_000,
    actions_taken: [{
      action_id: 'controlled-step',
      action_type: 'loop.local_check',
      summary: 'The controlled step failed.',
      outcome: 'failed',
    }],
    validation_result: 'failed',
    validation_summary: 'The deterministic check failed.',
    failure_reason: 'The local fixture returned a typed failure.',
    failure_code: 'CONTROLLED_CHECK_FAILED',
    updated_at: '2026-07-14T10:00:03.000Z',
    ...overrides,
  });
}

function rehash(entry: AgentRunLedgerEntry): AgentRunLedgerEntry {
  const next = structuredClone(entry);
  next.scope_hash = createAgentRunLedgerScopeHash(next);
  next.payload_hash = createAgentRunLedgerPayloadHash(next);
  return next;
}

function expectValidationIssue(
  operation: () => unknown,
  code: AgentRunLedgerValidationIssueCode
): AgentRunLedgerValidationError {
  let captured: AgentRunLedgerValidationError | null = null;
  assert.throws(operation, (error: unknown) => {
    if (!(error instanceof AgentRunLedgerValidationError)) return false;
    captured = error;
    return error.issues.some((issue) => issue.code === code);
  });
  assert.ok(captured);
  return captured;
}

describe('AgentRunLedgerEntry v1 contract and canonical hashing', () => {
  it('creates the complete snake_case wire shape with explicit nulls and verified hashes', () => {
    const entry = createAgentRunLedgerEntry(makeDraft());

    assert.equal(entry.schema_version, AGENT_RUN_LEDGER_SCHEMA_VERSION);
    assert.equal(entry.parent_run_id, null);
    assert.equal(entry.completed_at, null);
    assert.equal(entry.latency_ms, null);
    assert.equal(entry.cost_estimate.amount_micros, null);
    assert.equal(entry.approval_actor, null);
    assert.equal(entry.validation_summary, null);
    assert.equal(entry.failure_reason, null);
    assert.deepEqual(verifyAgentRunLedgerHashes(entry), {
      valid: true,
      scope_hash_matches: true,
      payload_hash_matches: true,
      expected_scope_hash: entry.scope_hash,
      expected_payload_hash: entry.payload_hash,
    });
    assert.strictEqual(validateAgentRunLedgerEntry(entry), entry);
    assert.ok(!JSON.stringify(entry).includes('undefined'));
  });

  it('uses the documented compact recursive key-sort canonical JSON and exact hash domains', () => {
    assert.equal(AGENT_RUN_LEDGER_SCOPE_HASH_DOMAIN, 'agent-run-ledger-scope-v1');
    assert.equal(AGENT_RUN_LEDGER_PAYLOAD_HASH_DOMAIN, 'agent-run-ledger-payload-v1');
    assert.equal(
      canonicalizeAgentRunLedgerJson({ z: 1, a: { z: 2, a: ['x', { b: true, a: null }] } }),
      '{"a":{"a":["x",{"a":null,"b":true}],"z":2},"z":1}'
    );

    const first = createAgentRunLedgerEntry(makeDraft());
    const reordered = createAgentRunLedgerEntry({
      ...makeDraft(),
      actions_taken: [{ outcome: 'pending', summary: 'Created the controlled run.', action_type: 'loop.lifecycle', action_id: 'lifecycle' }],
    });
    assert.equal(first.scope_hash, reordered.scope_hash);
    assert.equal(first.payload_hash, reordered.payload_hash);
    assert.equal(first.scope_hash, '76c919d9170d9191df378a51bfcff9c5eab3fc90c81353e4df3c46565c4cb981');
    assert.equal(first.payload_hash, '7740d3c65e5cc2228f451b07f9d6fc5c9c70fdf79ba7b89cf4b3446433262d4b');
  });

  it('preserves opaque identifier bytes and changes integrity hashes for case or whitespace mutations', () => {
    const baseline = createAgentRunLedgerEntry(makeDraft());
    const leadingSpace = createAgentRunLedgerEntry(makeDraft({ run_id: ' Run-Exact A' }));
    const changedCase = createAgentRunLedgerEntry(makeDraft({ run_id: 'run-exact A' }));

    assert.equal(leadingSpace.run_id, ' Run-Exact A');
    assert.notEqual(leadingSpace.scope_hash, baseline.scope_hash);
    assert.notEqual(changedCase.scope_hash, baseline.scope_hash);
  });

  it('rejects unknown schema versions, missing required provider/model, and unknown fields', () => {
    const entry = createAgentRunLedgerEntry(makeDraft());
    expectValidationIssue(
      () => validateAgentRunLedgerEntry({ ...entry, schema_version: '2.0' }),
      'UNSUPPORTED_SCHEMA_VERSION'
    );

    const missingProvider = { ...entry } as Record<string, unknown>;
    delete missingProvider.provider;
    expectValidationIssue(() => validateAgentRunLedgerEntry(missingProvider), 'MISSING_FIELD');
    expectValidationIssue(() => validateAgentRunLedgerEntry({ ...entry, extra: true }), 'UNKNOWN_FIELD');
  });

  it('accepts only explicit provider/model values and explicit, non-fabricated cost shapes', () => {
    assert.doesNotThrow(() => createAgentRunLedgerEntry(makeDraft({ provider: 'unknown', model: 'unknown' })));
    assert.doesNotThrow(() => createAgentRunLedgerEntry(makeDraft({
      provider: 'local',
      model: 'deterministic-fixture-v1',
      cost_estimate: { kind: 'known', amount_micros: 125, currency: 'USD' },
    })));
    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeDraft({
        cost_estimate: { kind: 'known', amount_micros: 1.5, currency: 'USD' },
      })),
      'INVALID_INTEGER'
    );
    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeDraft({
        cost_estimate: { kind: 'unknown', amount_micros: 0, currency: null },
      })),
      'COST_SHAPE_MISMATCH'
    );
  });
});

describe('AgentRunLedgerEntry bounds and secret hygiene', () => {
  it('redacts free-text tokens, all authorization schemes, cookies, and signed credential URLs before hashing', () => {
    const rawValues = [
      'Basic dXNlcjpwYXNzd29yZA==',
      'session=raw-cookie-value',
      'refresh=raw-set-cookie-value',
      'raw-signature-value',
      'sk-secretvalue1234567890',
      'raw-json-auth-value',
      'raw-api-header-value',
      'db-user:db-password',
    ];
    const entry = createAgentRunLedgerEntry(makeDraft({
      input_summary: [
        `Authorization: ${rawValues[0]}`,
        `Cookie: ${rawValues[1]}`,
        `Set-Cookie: ${rawValues[2]}`,
        `https://provider.example/resource?X-Amz-Signature=${rawValues[3]}`,
        `TOKEN=${rawValues[4]}`,
        `{"Authorization":"Basic ${rawValues[5]}"}`,
        `X-API-Key: ${rawValues[6]}`,
        `postgres://${rawValues[7]}@database.internal/app`,
      ].join('\n'),
      actions_taken: [{
        action_id: 'local-action',
        action_type: 'loop.local',
        summary: 'Authorization: Digest raw-digest-value',
        outcome: 'pending',
      }],
    }));
    const serialized = JSON.stringify(entry);

    for (const raw of rawValues) assert.ok(!serialized.includes(raw));
    assert.ok(!serialized.includes('raw-digest-value'));
    assert.match(entry.input_summary, /\[REDACTED/);
    assert.equal(verifyAgentRunLedgerHashes(entry).valid, true);
  });

  it('reports typed redaction requirements for pre-hashed unsafe free text', () => {
    const unsafe = createAgentRunLedgerEntry(makeDraft());
    unsafe.input_summary = 'Authorization: Basic raw-basic-value';
    const prehashedUnsafe = rehash(unsafe);
    expectValidationIssue(
      () => validateAgentRunLedgerEntry(prehashedUnsafe),
      'FREE_TEXT_REQUIRES_REDACTION'
    );

    const normalized = normalizeAgentRunLedgerEntry(prehashedUnsafe);
    assert.ok(!normalized.input_summary.includes('raw-basic-value'));
    assert.equal(normalized.payload_hash, prehashedUnsafe.payload_hash, 'normalization never silently blesses a supplied hash');
  });

  it('rejects secrets in opaque identities and signed evidence references instead of rewriting them', () => {
    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeDraft({ event_id: 'Bearer rawBearerCredential123' })),
      'SECRET_IN_OPAQUE_FIELD'
    );

    const completed = makeCompletedDraft({
      evidence_refs: [{
        evidence_id: 'unsafe-reference',
        kind: 'url',
        uri: 'https://provider.example/evidence.json?access_token=raw-short-token',
        sha256: 'b'.repeat(64),
        captured_at: '2026-07-14T10:00:04.000Z',
      }],
    });
    expectValidationIssue(() => createAgentRunLedgerEntry(completed), 'SIGNED_CREDENTIAL_URL');
  });

  it('rejects oversized text and arrays', () => {
    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeDraft({ input_summary: 'x'.repeat(4_097) })),
      'FIELD_TOO_LARGE'
    );
    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeDraft({
        actions_taken: Array.from({ length: 65 }, (_, index) => ({
          action_id: `action-${index}`,
          action_type: 'loop.local',
          summary: 'bounded action',
          outcome: 'pending' as const,
        })),
      })),
      'ARRAY_TOO_LARGE'
    );
  });
});

describe('AgentRunLedgerEntry governance and evidence invariants', () => {
  it('accepts completed only with passed validation and nonempty verified evidence', () => {
    const completed = createAgentRunLedgerEntry(makeCompletedDraft());
    assert.equal(completed.status, 'completed');
    assert.equal(completed.outcome, 'success');
    assert.equal(completed.evidence_count, 1);

    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeCompletedDraft({
        evidence_refs: [], evidence_count: 0, evidence_integrity_status: 'not_present',
      })),
      'COMPLETED_REQUIRES_EVIDENCE'
    );
    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeCompletedDraft({
        validation_result: 'failed', validation_summary: 'Validation failed.',
      })),
      'COMPLETED_REQUIRES_VALIDATION'
    );
  });

  it('requires complete approval metadata for production-impact execution and completion', () => {
    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeCompletedDraft({ production_impact: true })),
      'PRODUCTION_APPROVAL_REQUIRED'
    );

    const approved = createAgentRunLedgerEntry(makeCompletedDraft({
      production_impact: true,
      approval_status: 'approved',
      approval_actor: 'founder',
      approval_timestamp: '2026-07-14T10:00:01.000Z',
    }));
    assert.equal(approved.approval_actor, 'founder');

    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeDraft({
        status: 'running', approval_status: 'required', updated_at: '2026-07-14T10:00:01.000Z',
      })),
      'APPROVAL_METADATA_MISMATCH'
    );
    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeDraft({ approval_actor: 'unexpected-partial-metadata' })),
      'APPROVAL_METADATA_MISMATCH'
    );
  });

  it('keeps typed failed runs valid and visible without fabricating evidence', () => {
    const failed = createAgentRunLedgerEntry(makeFailedDraft());
    assert.equal(failed.status, 'failed');
    assert.equal(failed.outcome, 'failure');
    assert.equal(failed.failure_code, 'CONTROLLED_CHECK_FAILED');
    assert.equal(failed.evidence_count, 0);
    assert.equal(failed.evidence_integrity_status, 'not_present');
    assert.equal(verifyAgentRunLedgerHashes(failed).valid, true);
  });

  it('requires exact terminal timestamps, measured integer latency, and status-derived outcome', () => {
    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeCompletedDraft({ latency_ms: 4_999 })),
      'LATENCY_MISMATCH'
    );
    expectValidationIssue(
      () => createAgentRunLedgerEntry(makeCompletedDraft({ outcome: 'pending' })),
      'OUTCOME_STATUS_MISMATCH'
    );
    assert.equal(deriveAgentRunLedgerOutcome('blocked'), 'blocked');
    assert.equal(deriveAgentRunLedgerOutcome('reconciliation_required'), 'reconciliation_required');
  });
});

describe('AgentRunLedgerEntry transitions and exact replay', () => {
  it('accepts one exact ordered controlled lifecycle', () => {
    const created = createAgentRunLedgerEntry(makeDraft());
    const approvalRequired = createAgentRunLedgerEntry(makeDraft({
      event_id: 'Run-Exact A:event:2', sequence: 2, status: 'approval_required',
      approval_status: 'required', updated_at: '2026-07-14T10:00:01.000Z',
    }));
    const approved = createAgentRunLedgerEntry(makeDraft({
      event_id: 'Run-Exact A:event:3', sequence: 3, status: 'approved',
      approval_status: 'approved', approval_actor: 'founder',
      approval_timestamp: '2026-07-14T10:00:01.000Z', updated_at: '2026-07-14T10:00:02.000Z',
    }));
    const running = createAgentRunLedgerEntry(makeDraft({
      event_id: 'Run-Exact A:event:4', sequence: 4, status: 'running',
      approval_status: 'approved', approval_actor: 'founder',
      approval_timestamp: '2026-07-14T10:00:01.000Z', updated_at: '2026-07-14T10:00:03.000Z',
    }));
    const validating = createAgentRunLedgerEntry(makeDraft({
      event_id: 'Run-Exact A:event:5', sequence: 5, status: 'validating',
      approval_status: 'approved', approval_actor: 'founder',
      approval_timestamp: '2026-07-14T10:00:01.000Z', updated_at: '2026-07-14T10:00:04.000Z',
    }));
    const completed = createAgentRunLedgerEntry(makeCompletedDraft({
      approval_status: 'approved', approval_actor: 'founder',
      approval_timestamp: '2026-07-14T10:00:01.000Z',
    }));

    const history = [created, approvalRequired, approved, running, validating, completed];
    assertAgentRunLedgerTransition(null, history[0]!);
    for (let index = 1; index < history.length; index += 1) {
      assertAgentRunLedgerTransition(history[index - 1]!, history[index]!);
    }
    assert.deepEqual(history.map((entry) => entry.sequence), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(history.map((entry) => entry.status), [
      'created', 'approval_required', 'approved', 'running', 'validating', 'completed',
    ]);
  });

  it('returns typed transition errors for skipped sequence, invalid edge, and terminal rewrite', () => {
    const created = createAgentRunLedgerEntry(makeDraft());
    const skipped = createAgentRunLedgerEntry(makeDraft({
      event_id: 'Run-Exact A:event:3', sequence: 3, status: 'running',
      updated_at: '2026-07-14T10:00:01.000Z',
    }));
    assert.throws(
      () => assertAgentRunLedgerTransition(created, skipped),
      (error: unknown) => error instanceof AgentRunLedgerTransitionError
        && error.code === 'AGENT_RUN_LEDGER_SEQUENCE_MISMATCH'
    );

    const invalid = createAgentRunLedgerEntry(makeDraft({
      event_id: 'Run-Exact A:event:2', sequence: 2, status: 'validating',
      updated_at: '2026-07-14T10:00:01.000Z',
    }));
    assert.throws(
      () => assertAgentRunLedgerTransition(created, invalid),
      (error: unknown) => error instanceof AgentRunLedgerTransitionError
        && error.code === 'AGENT_RUN_LEDGER_INVALID_TRANSITION'
    );

    const completed = createAgentRunLedgerEntry(makeCompletedDraft());
    const later = createAgentRunLedgerEntry(makeFailedDraft({
      event_id: 'Run-Exact A:event:7', sequence: 7,
      completed_at: '2026-07-14T10:00:06.000Z', latency_ms: 6_000,
      updated_at: '2026-07-14T10:00:06.000Z',
    }));
    assert.throws(
      () => assertAgentRunLedgerTransition(completed, later),
      (error: unknown) => error instanceof AgentRunLedgerTransitionError
        && error.code === 'AGENT_RUN_LEDGER_TERMINAL_REWRITE'
    );
  });

  it('accepts exact replay and types event, scope, and payload mismatches without prior-data payloads', () => {
    const existing = createAgentRunLedgerEntry(makeCompletedDraft());
    assert.doesNotThrow(() => assertAgentRunLedgerExactReplay(existing, structuredClone(existing)));

    const changedEvent = rehash({ ...structuredClone(existing), event_id: 'different-event' });
    const changedScope = rehash({ ...structuredClone(existing), provider: 'local' });
    const changedPayload = rehash({ ...structuredClone(existing), input_summary: 'Different safe summary.' });
    const cases: Array<[AgentRunLedgerEntry, string]> = [
      [changedEvent, 'AGENT_RUN_LEDGER_IDEMPOTENCY_MISMATCH'],
      [changedScope, 'AGENT_RUN_LEDGER_SCOPE_MISMATCH'],
      [changedPayload, 'AGENT_RUN_LEDGER_PAYLOAD_MISMATCH'],
    ];

    for (const [candidate, code] of cases) {
      assert.throws(() => assertAgentRunLedgerExactReplay(existing, candidate), (error: unknown) => {
        if (!(error instanceof AgentRunLedgerReplayMismatchError)) return false;
        assert.equal(error.code, code);
        assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
        assert.ok(!JSON.stringify(error).includes('evidence-local-1'));
        return true;
      });
    }
  });
});
