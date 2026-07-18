import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TEMPORAL_AUTHORITY_FIXTURES_V1,
  TEMPORAL_AUTHORITY_FIXTURES_V1_SERIALIZATION,
  TEMPORAL_AUTHORITY_LIMITS,
  TEMPORAL_AUTHORITY_SCHEMA_VERSION,
  TEMPORAL_POLICY_HASH_DOMAIN,
  FakeTemporalClock,
  SystemTemporalClock,
  TemporalAuthorityValidationError,
  canonicalizeTemporalAuthorityJson,
  createRuntimeMissionPayloadHash,
  createTemporalPolicyBindingHash,
  evaluateTemporalEligibilityV1,
  isCanonicalTemporalInstant,
  validateCanonicalTemporalInstant,
  validateDurableTemporalStateV1,
  validateTemporalAuthorizationV1,
  validateTemporalMissionPolicyV1,
  type DurableTemporalStateV1,
  type RuntimeMissionRequest,
  type TemporalAuthorizationV1,
  type TemporalClaimEvaluationInputV1,
  type TemporalMissionPolicyV1,
  type TemporalReasonCodeV1,
} from '../src/index.js';

const MISSION_PAYLOAD_HASH = TEMPORAL_AUTHORITY_FIXTURES_V1.missionPayloadHash;
const T0 = '2026-07-18T10:00:00.000Z';

function policy(overrides: Partial<TemporalMissionPolicyV1> = {}): TemporalMissionPolicyV1 {
  return {
    schemaVersion: TEMPORAL_AUTHORITY_SCHEMA_VERSION,
    submittedAt: T0,
    maxAttempts: 3,
    ...overrides,
  };
}

function state(overrides: Partial<DurableTemporalStateV1> = {}): DurableTemporalStateV1 {
  return {
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    terminalAt: null,
    terminalReason: null,
    ...overrides,
  };
}

function authorization(
  approvedPolicy: TemporalMissionPolicyV1,
  overrides: Partial<TemporalAuthorizationV1> = {},
): TemporalAuthorizationV1 {
  return {
    authorizationId: 'authorization-001',
    authorizationVersion: 1,
    approvedAt: '2026-07-18T10:01:00.000Z',
    approvalExpiresAt: '2026-07-18T10:45:00.000Z',
    approvedPolicyHash: createTemporalPolicyBindingHash(MISSION_PAYLOAD_HASH, approvedPolicy),
    ...overrides,
  };
}

function claimInput(
  overrides: Partial<TemporalClaimEvaluationInputV1> = {},
): TemporalClaimEvaluationInputV1 {
  return {
    operation: 'claim',
    policy: policy(),
    authorizationRequired: false,
    state: state(),
    stateRevision: 'revision-001',
    evaluatedAt: T0,
    ...overrides,
  };
}

function expectIssue(
  action: () => unknown,
  code: TemporalAuthorityValidationError['issues'][number]['code'],
  field?: string,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof TemporalAuthorityValidationError);
    assert.ok(error.issues.some((issue) => issue.code === code && (field === undefined || issue.field === field)));
    return true;
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('TemporalMissionPolicyV1 strict contract', () => {
  it('accepts a valid minimal policy', () => {
    const value = policy({ maxAttempts: 1 });
    const validated = validateTemporalMissionPolicyV1(value);
    assert.deepEqual(validated, value);
    assert.notStrictEqual(validated, value);
    assert.equal(Object.isFrozen(validated), true);
  });

  it('accepts a valid full policy using safe positive integer conventions', () => {
    const value = policy({
      notBefore: '2026-07-18T10:05:00.000Z',
      deadlineAt: '2026-07-18T11:00:00.000Z',
      executionTimeoutMs: 30_000,
      maxAttempts: Number.MAX_SAFE_INTEGER,
      leaseDurationMs: 60_000,
    });
    assert.deepEqual(validateTemporalMissionPolicyV1(value), value);
  });

  it('accepts only canonical UTC instants with milliseconds', () => {
    assert.equal(isCanonicalTemporalInstant('2026-02-28T23:59:59.999Z'), true);
    assert.equal(validateCanonicalTemporalInstant('2026-02-28T23:59:59.999Z'), '2026-02-28T23:59:59.999Z');

    const invalid = [
      '2026-07-18T10:00:00',
      '2026-07-18T12:00:00.000+02:00',
      '2026-07-18T10:00:00Z',
      '2026-07-18t10:00:00.000z',
      '2026-02-30T10:00:00.000Z',
      'not-an-instant',
    ];
    for (const instant of invalid) {
      assert.equal(isCanonicalTemporalInstant(instant), false, instant);
      expectIssue(() => validateCanonicalTemporalInstant(instant), 'INVALID_TIMESTAMP');
    }
  });

  it('rejects timezone-less, offset, missing-millisecond, and invalid-calendar policy values', () => {
    for (const submittedAt of [
      '2026-07-18T10:00:00',
      '2026-07-18T12:00:00.000+02:00',
      '2026-07-18T10:00:00Z',
      '2026-02-30T10:00:00.000Z',
    ]) {
      expectIssue(
        () => validateTemporalMissionPolicyV1({ ...policy(), submittedAt }),
        'INVALID_TIMESTAMP',
        'submittedAt',
      );
    }
  });

  it('rejects unsupported versions, missing required fields, and unknown fields', () => {
    expectIssue(
      () => validateTemporalMissionPolicyV1({ ...policy(), schemaVersion: 'chanter.temporal.v0' }),
      'UNSUPPORTED_SCHEMA_VERSION',
    );
    const missingSubmittedAt = { ...policy() } as Record<string, unknown>;
    delete missingSubmittedAt.submittedAt;
    expectIssue(() => validateTemporalMissionPolicyV1(missingSubmittedAt), 'MISSING_FIELD', '$.submittedAt');
    expectIssue(
      () => validateTemporalMissionPolicyV1({ ...policy(), retryWindowMs: 60_000 }),
      'UNKNOWN_FIELD',
      '$.retryWindowMs',
    );
  });

  it('rejects inherited, accessor, and non-enumerable policy fields before hashing or evaluation', () => {
    const inheritedPolicy = Object.assign(
      Object.create({ deadlineAt: '2026-07-18T10:30:00.000Z' }) as Record<string, unknown>,
      policy(),
    );
    expectIssue(() => validateTemporalMissionPolicyV1(inheritedPolicy), 'INVALID_TYPE', '$');

    const hiddenCeiling = { ...policy() } as Record<string, unknown>;
    Object.defineProperty(hiddenCeiling, 'maxAttempts', { value: 1, enumerable: false });
    expectIssue(() => validateTemporalMissionPolicyV1(hiddenCeiling), 'INVALID_TYPE', '$');
    expectIssue(
      () => createTemporalPolicyBindingHash(MISSION_PAYLOAD_HASH, hiddenCeiling as unknown as TemporalMissionPolicyV1),
      'INVALID_TYPE',
      '$',
    );

    const accessorPolicy = { ...policy() } as Record<string, unknown>;
    Object.defineProperty(accessorPolicy, 'maxAttempts', { get: () => 1, enumerable: true });
    expectIssue(() => validateTemporalMissionPolicyV1(accessorPolicy), 'INVALID_TYPE', '$');
  });

  it('snapshots proxy descriptor values so getters cannot split the hash from evaluation', () => {
    let descriptorMaxAttempts = 1;
    const target = policy({ maxAttempts: 1 });
    const adversarialPolicy = new Proxy(target, {
      get(object, property, receiver) {
        if (property === 'maxAttempts') return 99;
        return Reflect.get(object, property, receiver);
      },
      getOwnPropertyDescriptor(object, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
        if (property === 'maxAttempts' && descriptor !== undefined) {
          return { ...descriptor, value: descriptorMaxAttempts };
        }
        return descriptor;
      },
    });

    const firstSnapshot = validateTemporalMissionPolicyV1(adversarialPolicy);
    assert.equal(firstSnapshot.maxAttempts, 1);
    const firstHash = createTemporalPolicyBindingHash(MISSION_PAYLOAD_HASH, adversarialPolicy);
    descriptorMaxAttempts = 2;
    const result = evaluateTemporalEligibilityV1(claimInput({
      policy: adversarialPolicy,
      authorizationRequired: true,
      missionPayloadHash: MISSION_PAYLOAD_HASH,
      authorization: authorization(firstSnapshot, { approvedPolicyHash: firstHash }),
      evaluatedAt: '2026-07-18T10:02:00.000Z',
    }));
    assert.equal(result.reason, 'approval_required');
    assert.equal(result.maxAttempts, 2);
  });

  it('enforces not-before and deadline ordering at equality and before', () => {
    expectIssue(
      () => validateTemporalMissionPolicyV1(policy({ notBefore: '2026-07-18T09:59:59.999Z' })),
      'INVALID_ORDER',
      'notBefore',
    );
    for (const deadlineAt of [T0, '2026-07-18T09:59:59.999Z']) {
      expectIssue(
        () => validateTemporalMissionPolicyV1(policy({ deadlineAt })),
        'INVALID_ORDER',
        'deadlineAt',
      );
    }
    expectIssue(
      () => validateTemporalMissionPolicyV1(policy({
        notBefore: '2026-07-18T10:05:00.000Z',
        deadlineAt: '2026-07-18T10:05:00.000Z',
      })),
      'INVALID_ORDER',
      'deadlineAt',
    );
  });

  it('rejects zero, negative, non-integer, non-finite, and unsafe numeric values', () => {
    for (const maxAttempts of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expectIssue(() => validateTemporalMissionPolicyV1({ ...policy(), maxAttempts }), 'INVALID_INTEGER', 'maxAttempts');
    }
    for (const executionTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      expectIssue(
        () => validateTemporalMissionPolicyV1({ ...policy(), executionTimeoutMs }),
        'INVALID_INTEGER',
        'executionTimeoutMs',
      );
    }
    for (const leaseDurationMs of [0, -1, 1.5, Number.NEGATIVE_INFINITY]) {
      expectIssue(
        () => validateTemporalMissionPolicyV1({ ...policy(), leaseDurationMs }),
        'INVALID_INTEGER',
        'leaseDurationMs',
      );
    }
  });
});

describe('TemporalAuthorizationV1 binding contract', () => {
  it('accepts a bounded identity, positive version, ordered instants, and lowercase SHA-256', () => {
    const approvedPolicy = policy();
    const value = authorization(approvedPolicy);
    const validated = validateTemporalAuthorizationV1(value);
    assert.deepEqual(validated, value);
    assert.notStrictEqual(validated, value);
    assert.equal(Object.isFrozen(validated), true);
  });

  it('rejects blank, oversized, control-bearing, and secret-like authorization identities', () => {
    for (const authorizationId of [
      '',
      '   ',
      'line\nbreak',
      'x'.repeat(TEMPORAL_AUTHORITY_LIMITS.opaqueIdentifier + 1),
      'Bearer credential-material',
    ]) {
      expectIssue(() => validateTemporalAuthorizationV1({ ...authorization(policy()), authorizationId }),
        authorizationId.length > TEMPORAL_AUTHORITY_LIMITS.opaqueIdentifier
          ? 'FIELD_TOO_LARGE'
          : authorizationId.startsWith('Bearer')
            ? 'SECRET_IN_IDENTIFIER'
            : 'INVALID_IDENTIFIER');
    }
  });

  it('rejects non-positive or non-integer versions and invalid hashes', () => {
    for (const authorizationVersion of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expectIssue(
        () => validateTemporalAuthorizationV1({ ...authorization(policy()), authorizationVersion }),
        'INVALID_INTEGER',
        'authorizationVersion',
      );
    }
    for (const approvedPolicyHash of ['a'.repeat(63), 'A'.repeat(64), 'not-a-hash']) {
      expectIssue(
        () => validateTemporalAuthorizationV1({ ...authorization(policy()), approvedPolicyHash }),
        'INVALID_HASH',
        'approvedPolicyHash',
      );
    }
  });

  it('requires approval expiry to be strictly later than approval', () => {
    for (const approvalExpiresAt of ['2026-07-18T10:01:00.000Z', '2026-07-18T10:00:59.999Z']) {
      expectIssue(
        () => validateTemporalAuthorizationV1({ ...authorization(policy()), approvalExpiresAt }),
        'INVALID_ORDER',
        'approvalExpiresAt',
      );
    }
  });

  it('rejects noncanonical approval instants and unknown fields', () => {
    expectIssue(
      () => validateTemporalAuthorizationV1({ ...authorization(policy()), approvedAt: '2026-07-18T10:01:00Z' }),
      'INVALID_TIMESTAMP',
      'approvedAt',
    );
    expectIssue(
      () => validateTemporalAuthorizationV1({ ...authorization(policy()), renewedBy: 'operator' }),
      'UNKNOWN_FIELD',
      '$.renewedBy',
    );
  });

  it('uses the existing lowercase SHA-256 format with an isolated domain and unchanged mission identity input', () => {
    const approvedPolicy = policy({ maxAttempts: 2 });
    const first = createTemporalPolicyBindingHash(MISSION_PAYLOAD_HASH, approvedPolicy);
    const reordered = createTemporalPolicyBindingHash(MISSION_PAYLOAD_HASH, {
      maxAttempts: 2,
      submittedAt: T0,
      schemaVersion: TEMPORAL_AUTHORITY_SCHEMA_VERSION,
    });
    assert.equal(TEMPORAL_POLICY_HASH_DOMAIN, 'chanter-temporal-policy-binding-v1');
    assert.equal(first, reordered);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(first, createTemporalPolicyBindingHash('0'.repeat(64), approvedPolicy));
    assert.notEqual(first, createTemporalPolicyBindingHash(MISSION_PAYLOAD_HASH, policy({ maxAttempts: 3 })));
    expectIssue(() => createTemporalPolicyBindingHash('A'.repeat(64), approvedPolicy), 'INVALID_HASH');
  });
});

describe('DurableTemporalStateV1 structural validation', () => {
  it('accepts ready state and attemptCount equal to maxAttempts', () => {
    const approvedPolicy = policy({ maxAttempts: 3 });
    const ready = state();
    const exhausted = state({ attemptCount: 3 });
    assert.deepEqual(validateDurableTemporalStateV1(ready, approvedPolicy), ready);
    assert.deepEqual(validateDurableTemporalStateV1(exhausted, approvedPolicy), exhausted);
  });

  it('rejects attemptCount above maxAttempts and invalid counts', () => {
    expectIssue(
      () => validateDurableTemporalStateV1(state({ attemptCount: 4 }), policy({ maxAttempts: 3 })),
      'ATTEMPT_BUDGET_EXCEEDED',
      'attemptCount',
    );
    for (const attemptCount of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expectIssue(
        () => validateDurableTemporalStateV1({ ...state(), attemptCount }, policy()),
        'INVALID_INTEGER',
        'attemptCount',
      );
    }
  });

  it('requires an all-null or fully populated lease tuple and a started attempt', () => {
    const lease = {
      attemptCount: 1,
      leaseOwner: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: '2026-07-18T10:10:00.000Z',
    };
    assert.doesNotThrow(() => validateDurableTemporalStateV1(state(lease), policy()));
    expectIssue(
      () => validateDurableTemporalStateV1(state({ ...lease, leaseToken: null }), policy()),
      'LEASE_TUPLE_MISMATCH',
    );
    expectIssue(
      () => validateDurableTemporalStateV1(state({ ...lease, attemptCount: 0 }), policy()),
      'LEASE_TUPLE_MISMATCH',
      'attemptCount',
    );
  });

  it('requires coherent terminal fields and the closed terminal outcome vocabulary', () => {
    expectIssue(
      () => validateDurableTemporalStateV1(state({ terminalAt: '2026-07-18T10:10:00.000Z' }), policy()),
      'TERMINAL_TUPLE_MISMATCH',
    );
    expectIssue(
      () => validateDurableTemporalStateV1({ ...state(), terminalReason: 'deadline_exceeded' }, policy()),
      'TERMINAL_TUPLE_MISMATCH',
    );
    expectIssue(
      () => validateDurableTemporalStateV1({
        ...state(),
        terminalAt: '2026-07-18T10:10:00.000Z',
        terminalReason: 'blocked',
      }, policy()),
      'INVALID_TERMINAL_REASON',
    );
    assert.doesNotThrow(() => validateDurableTemporalStateV1(state({
      attemptCount: 3,
      terminalAt: '2026-07-18T10:10:00.000Z',
      terminalReason: 'attempt_budget_exhausted',
    }), policy({ maxAttempts: 3 })));
    assert.doesNotThrow(() => validateDurableTemporalStateV1(state({
      terminalAt: '2026-07-18T10:10:00.000Z',
      terminalReason: 'deadline_exceeded',
    }), policy()));
  });

  it('strictly validates state timestamps and rejects unknown fields', () => {
    expectIssue(
      () => validateDurableTemporalStateV1({ ...state(), nextAttemptAt: '2026-07-18T10:05:00Z' }, policy()),
      'INVALID_TIMESTAMP',
      'nextAttemptAt',
    );
    expectIssue(
      () => validateDurableTemporalStateV1({ ...state(), decrementableRetries: 2 }, policy()),
      'UNKNOWN_FIELD',
      '$.decrementableRetries',
    );
  });
});

describe('Pure temporal claim evaluation', () => {
  it('returns an explicit eligible result without acquiring a lease or incrementing attempts', () => {
    const input = claimInput({ stateRevision: 7 });
    assert.deepEqual(evaluateTemporalEligibilityV1(input), {
      operation: 'claim',
      evaluatedAt: T0,
      stateRevision: 7,
      authorizationId: null,
      authorizationVersion: null,
      attemptCount: 0,
      maxAttempts: 3,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      eligible: true,
      reason: null,
    });
  });

  it('fails closed with approval_required for missing approval or a mismatched binding', () => {
    const approvedPolicy = policy();
    const missing = evaluateTemporalEligibilityV1(claimInput({
      policy: approvedPolicy,
      authorizationRequired: true,
      missionPayloadHash: MISSION_PAYLOAD_HASH,
    }));
    assert.equal(missing.eligible, false);
    assert.equal(missing.reason, 'approval_required');

    const mismatched = evaluateTemporalEligibilityV1(claimInput({
      policy: approvedPolicy,
      authorizationRequired: true,
      missionPayloadHash: MISSION_PAYLOAD_HASH,
      authorization: authorization(approvedPolicy, { approvedPolicyHash: '0'.repeat(64) }),
      evaluatedAt: '2026-07-18T10:02:00.000Z',
    }));
    assert.equal(mismatched.reason, 'approval_required');
    assert.equal(mismatched.authorizationId, 'authorization-001');
    assert.equal(mismatched.authorizationVersion, 1);
  });

  it('treats approval expiry as an exact now >= boundary', () => {
    const approvedPolicy = policy();
    const approved = authorization(approvedPolicy);
    const base = {
      policy: approvedPolicy,
      authorizationRequired: true,
      authorization: approved,
      missionPayloadHash: MISSION_PAYLOAD_HASH,
    };
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      ...base,
      evaluatedAt: '2026-07-18T10:44:59.999Z',
    })).eligible, true);
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      ...base,
      evaluatedAt: '2026-07-18T10:45:00.000Z',
    })).reason, 'approval_expired');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      ...base,
      evaluatedAt: '2026-07-18T10:45:00.001Z',
    })).reason, 'approval_expired');
  });

  it('treats deadline as an exact now >= boundary', () => {
    const deadlinePolicy = policy({ deadlineAt: '2026-07-18T10:10:00.000Z' });
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: deadlinePolicy,
      evaluatedAt: '2026-07-18T10:09:59.999Z',
    })).eligible, true);
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: deadlinePolicy,
      evaluatedAt: '2026-07-18T10:10:00.000Z',
    })).reason, 'deadline_exceeded');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: deadlinePolicy,
      evaluatedAt: '2026-07-18T10:10:00.001Z',
    })).reason, 'deadline_exceeded');
  });

  it('handles one millisecond before, at, and after policy not-before', () => {
    const delayedPolicy = policy({ notBefore: '2026-07-18T10:05:00.000Z' });
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: delayedPolicy,
      evaluatedAt: '2026-07-18T10:04:59.999Z',
    })).reason, 'not_before_pending');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: delayedPolicy,
      evaluatedAt: '2026-07-18T10:05:00.000Z',
    })).eligible, true);
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: delayedPolicy,
      evaluatedAt: '2026-07-18T10:05:00.001Z',
    })).eligible, true);
  });

  it('maps durable nextAttemptAt to the same canonical not-yet-claimable reason', () => {
    const delayedState = state({ nextAttemptAt: '2026-07-18T10:05:00.000Z' });
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      state: delayedState,
      evaluatedAt: '2026-07-18T10:04:59.999Z',
    })).reason, 'not_before_pending');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      state: delayedState,
      evaluatedAt: '2026-07-18T10:05:00.000Z',
    })).eligible, true);
  });

  it('returns attempt_budget_exhausted when attemptCount equals maxAttempts', () => {
    const exhaustedPolicy = policy({ maxAttempts: 2 });
    const result = evaluateTemporalEligibilityV1(claimInput({
      policy: exhaustedPolicy,
      state: state({ attemptCount: 2 }),
    }));
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'attempt_budget_exhausted');
    assert.equal(result.attemptCount, 2);
    assert.equal(result.maxAttempts, 2);
  });

  it('blocks a live foreign lease and allows a new claim at exact lease expiry', () => {
    const leased = state({
      attemptCount: 1,
      leaseOwner: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: '2026-07-18T10:10:00.000Z',
    });
    const live = evaluateTemporalEligibilityV1(claimInput({ state: leased, evaluatedAt: '2026-07-18T10:09:59.999Z' }));
    assert.equal(live.reason, 'lease_live');
    assert.equal(live.leaseOwner, 'worker-a');
    assert.equal(live.leaseToken, 'lease-a');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      state: leased,
      evaluatedAt: '2026-07-18T10:10:00.000Z',
    })).eligible, true);
  });

  it('returns terminal success and failure independently of other simultaneous gates', () => {
    const terminalPolicy = policy({ deadlineAt: '2026-07-18T10:05:00.000Z', maxAttempts: 1 });
    for (const terminalReason of ['terminal_success', 'terminal_failure'] as const) {
      const result = evaluateTemporalEligibilityV1(claimInput({
        policy: terminalPolicy,
        authorizationRequired: true,
        missionPayloadHash: MISSION_PAYLOAD_HASH,
        state: state({
          attemptCount: 1,
          leaseOwner: 'worker-a',
          leaseToken: 'lease-a',
          leaseExpiresAt: '2026-07-18T11:00:00.000Z',
          terminalAt: '2026-07-18T10:04:00.000Z',
          terminalReason,
        }),
        evaluatedAt: '2026-07-18T10:10:00.000Z',
      }));
      assert.equal(result.reason, terminalReason);
    }
  });

  it('locks deterministic precedence for simultaneous claim failures', () => {
    const gatedPolicy = policy({
      notBefore: '2026-07-18T10:20:00.000Z',
      deadlineAt: '2026-07-18T10:30:00.000Z',
      maxAttempts: 1,
    });
    const liveLease = state({
      attemptCount: 1,
      nextAttemptAt: '2026-07-18T10:25:00.000Z',
      leaseOwner: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: '2026-07-18T11:00:00.000Z',
    });

    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: gatedPolicy,
      authorizationRequired: true,
      missionPayloadHash: MISSION_PAYLOAD_HASH,
      state: liveLease,
      evaluatedAt: '2026-07-18T10:30:00.000Z',
    })).reason, 'deadline_exceeded');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: gatedPolicy,
      authorizationRequired: true,
      missionPayloadHash: MISSION_PAYLOAD_HASH,
      state: liveLease,
      evaluatedAt: '2026-07-18T10:10:00.000Z',
    })).reason, 'approval_required');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: gatedPolicy,
      authorizationRequired: true,
      missionPayloadHash: MISSION_PAYLOAD_HASH,
      authorization: authorization(gatedPolicy, { approvalExpiresAt: '2026-07-18T10:05:00.000Z' }),
      state: liveLease,
      evaluatedAt: '2026-07-18T10:10:00.000Z',
    })).reason, 'approval_expired');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: gatedPolicy,
      authorizationRequired: false,
      state: liveLease,
      evaluatedAt: '2026-07-18T10:10:00.000Z',
    })).reason, 'attempt_budget_exhausted');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: { ...gatedPolicy, maxAttempts: 2 },
      authorizationRequired: false,
      state: liveLease,
      evaluatedAt: '2026-07-18T10:10:00.000Z',
    })).reason, 'not_before_pending');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: policy({ maxAttempts: 2 }),
      authorizationRequired: false,
      state: liveLease,
      evaluatedAt: '2026-07-18T10:20:00.000Z',
    })).reason, 'not_before_pending');
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: policy({ maxAttempts: 2 }),
      authorizationRequired: false,
      state: { ...liveLease, nextAttemptAt: null },
      evaluatedAt: '2026-07-18T10:20:00.000Z',
    })).reason, 'lease_live');
  });

  it('does not mutate any caller-owned policy, authorization, state, or context', () => {
    const approvedPolicy = policy({ maxAttempts: 2 });
    const input = deepFreeze(claimInput({
      policy: approvedPolicy,
      authorizationRequired: true,
      authorization: authorization(approvedPolicy),
      missionPayloadHash: MISSION_PAYLOAD_HASH,
      state: state(),
      evaluatedAt: '2026-07-18T10:02:00.000Z',
    }));
    const before = structuredClone(input);
    assert.equal(evaluateTemporalEligibilityV1(input).eligible, true);
    assert.deepEqual(input, before);
  });

  it('fails closed on invalid operation and state-revision context', () => {
    expectIssue(
      () => evaluateTemporalEligibilityV1({
        ...claimInput(),
        operation: 'retry',
      } as unknown as TemporalClaimEvaluationInputV1),
      'INVALID_TYPE',
      'operation',
    );
    expectIssue(
      () => evaluateTemporalEligibilityV1({
        ...claimInput(),
        stateRevision: -1,
      }),
      'INVALID_INTEGER',
      'stateRevision',
    );
  });
});

describe('Pure completion fencing evaluation', () => {
  const leasedState = state({
    attemptCount: 2,
    leaseOwner: 'worker-a',
    leaseToken: 'lease-a',
    leaseExpiresAt: '2026-07-18T12:00:00.000Z',
  });

  it('allows the exact same owner, token, and attempt context', () => {
    const expiredPolicy = policy({ deadlineAt: '2026-07-18T11:00:00.000Z' });
    const result = evaluateTemporalEligibilityV1({
      operation: 'completion',
      policy: expiredPolicy,
      authorizationRequired: true,
      authorization: authorization(expiredPolicy, { approvalExpiresAt: '2026-07-18T10:45:00.000Z' }),
      missionPayloadHash: MISSION_PAYLOAD_HASH,
      state: leasedState,
      stateRevision: 'revision-lease-002',
      evaluatedAt: '2026-07-18T11:30:00.000Z',
      completion: { leaseOwner: 'worker-a', leaseToken: 'lease-a', attemptNumber: 2 },
    });
    assert.equal(result.eligible, true);
    assert.equal(result.reason, null);
    assert.equal(result.operation, 'completion');
    assert.equal(result.stateRevision, 'revision-lease-002');
  });

  it('returns lease_lost for stale owner, token, attempt, missing lease, or exact lease expiry', () => {
    const cases = [
      { completion: { leaseOwner: 'worker-b', leaseToken: 'lease-a', attemptNumber: 2 }, state: leasedState, at: '2026-07-18T11:00:00.000Z' },
      { completion: { leaseOwner: 'worker-a', leaseToken: 'lease-b', attemptNumber: 2 }, state: leasedState, at: '2026-07-18T11:00:00.000Z' },
      { completion: { leaseOwner: 'worker-a', leaseToken: 'lease-a', attemptNumber: 1 }, state: leasedState, at: '2026-07-18T11:00:00.000Z' },
      { completion: { leaseOwner: 'worker-a', leaseToken: 'lease-a', attemptNumber: 2 }, state: state({ attemptCount: 2 }), at: '2026-07-18T11:00:00.000Z' },
      { completion: { leaseOwner: 'worker-a', leaseToken: 'lease-a', attemptNumber: 2 }, state: leasedState, at: '2026-07-18T12:00:00.000Z' },
    ];
    for (const item of cases) {
      const result = evaluateTemporalEligibilityV1({
        operation: 'completion',
        policy: policy(),
        authorizationRequired: false,
        state: item.state,
        stateRevision: 2,
        evaluatedAt: item.at,
        completion: item.completion,
      });
      assert.equal(result.eligible, false);
      assert.equal(result.reason, 'lease_lost');
    }
  });

  it('returns terminal outcome before re-evaluating a stale completion token', () => {
    const result = evaluateTemporalEligibilityV1({
      operation: 'completion',
      policy: policy(),
      authorizationRequired: false,
      state: state({
        attemptCount: 2,
        terminalAt: '2026-07-18T10:30:00.000Z',
        terminalReason: 'terminal_success',
      }),
      stateRevision: 3,
      evaluatedAt: '2026-07-18T11:00:00.000Z',
      completion: { leaseOwner: 'stale-worker', leaseToken: 'stale-token', attemptNumber: 1 },
    });
    assert.equal(result.reason, 'terminal_success');
  });
});

describe('Temporal clocks', () => {
  it('separates wall-clock rollback from increasing monotonic elapsed time', () => {
    const deadlinePolicy = policy({
      submittedAt: '2026-07-18T09:00:00.000Z',
      deadlineAt: '2026-07-18T10:00:00.000Z',
    });
    const clock = new FakeTemporalClock('2026-07-18T10:00:00.000Z', 1_000);
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: deadlinePolicy,
      evaluatedAt: clock.nowInstant().toISOString(),
    })).reason, 'deadline_exceeded');

    const persistedTerminalState = state({
      terminalAt: clock.nowInstant().toISOString(),
      terminalReason: 'deadline_exceeded',
    });
    clock.advanceWallTimeMs(-1);
    clock.advanceMonotonicMs(250);
    assert.equal(clock.nowInstant().toISOString(), '2026-07-18T09:59:59.999Z');
    assert.equal(clock.monotonicNowMs(), 1_250);
    assert.equal(evaluateTemporalEligibilityV1(claimInput({
      policy: deadlinePolicy,
      state: persistedTerminalState,
      evaluatedAt: clock.nowInstant().toISOString(),
    })).reason, 'terminal_failure');
  });

  it('supports a deterministic wall-clock forward jump without changing monotonic time', () => {
    const clock = new FakeTemporalClock(T0, 10);
    clock.advanceWallTimeMs(3_600_000);
    assert.equal(clock.nowInstant().toISOString(), '2026-07-18T11:00:00.000Z');
    assert.equal(clock.monotonicNowMs(), 10);
  });

  it('returns defensive Date copies and refuses monotonic rollback or invalid instants', () => {
    const clock = new FakeTemporalClock(T0, 10);
    const observed = clock.nowInstant();
    observed.setUTCFullYear(2030);
    assert.equal(clock.nowInstant().toISOString(), T0);
    assert.throws(() => clock.advanceMonotonicMs(-1), RangeError);
    assert.throws(() => clock.setWallInstant(new Date(Number.NaN)), RangeError);
  });

  it('provides a production wall and monotonic implementation without serializing either', () => {
    const clock = new SystemTemporalClock();
    assert.equal(Number.isNaN(clock.nowInstant().getTime()), false);
    assert.equal(Number.isFinite(clock.monotonicNowMs()), true);
    assert.equal(TEMPORAL_AUTHORITY_FIXTURES_V1_SERIALIZATION.includes('monotonic'), false);
  });
});

describe('Temporal reason vocabulary and deterministic fixtures', () => {
  it('locks the closed Phase 1 reason-code vocabulary', () => {
    const reasons: Record<TemporalReasonCodeV1, true> = {
      not_before_pending: true,
      approval_required: true,
      approval_expired: true,
      deadline_exceeded: true,
      attempt_budget_exhausted: true,
      lease_live: true,
      lease_lost: true,
      execution_timeout_before_mutation: true,
      provider_outcome_unknown: true,
      terminal_success: true,
      terminal_failure: true,
    };
    assert.deepEqual(Object.keys(reasons), [
      'not_before_pending',
      'approval_required',
      'approval_expired',
      'deadline_exceeded',
      'attempt_budget_exhausted',
      'lease_live',
      'lease_lost',
      'execution_timeout_before_mutation',
      'provider_outcome_unknown',
      'terminal_success',
      'terminal_failure',
    ]);
  });

  it('exports immutable valid and invalid fixtures that exercise the strict validators', () => {
    const fixtures = TEMPORAL_AUTHORITY_FIXTURES_V1;
    assert.equal(Object.isFrozen(fixtures), true);
    assert.equal(Object.isFrozen(fixtures.valid.fullPolicy), true);
    validateTemporalMissionPolicyV1(fixtures.valid.minimalPolicy);
    validateTemporalMissionPolicyV1(fixtures.valid.fullPolicy);
    validateTemporalAuthorizationV1(fixtures.valid.authorization);
    validateDurableTemporalStateV1(fixtures.valid.readyState, fixtures.valid.fullPolicy);
    validateDurableTemporalStateV1(fixtures.valid.leasedState, fixtures.valid.fullPolicy);
    validateDurableTemporalStateV1(fixtures.valid.terminalSuccessState, fixtures.valid.fullPolicy);
    validateDurableTemporalStateV1(fixtures.valid.terminalFailureState, fixtures.valid.fullPolicy);
    validateDurableTemporalStateV1(fixtures.valid.terminalDeadlineState, fixtures.valid.fullPolicy);
    expectIssue(() => validateTemporalMissionPolicyV1(fixtures.invalid.nonCanonicalPolicy), 'INVALID_TIMESTAMP');
    expectIssue(() => validateTemporalMissionPolicyV1(fixtures.invalid.unknownFieldPolicy), 'UNKNOWN_FIELD');
    expectIssue(
      () => validateDurableTemporalStateV1(fixtures.invalid.partialLeaseState, fixtures.valid.fullPolicy),
      'LEASE_TUPLE_MISMATCH',
    );
    expectIssue(
      () => validateDurableTemporalStateV1(fixtures.invalid.attemptOverBudgetState, fixtures.valid.minimalPolicy),
      'ATTEMPT_BUDGET_EXCEEDED',
    );
  });

  it('serializes fixtures to byte-stable canonical JSON', () => {
    const serialized = canonicalizeTemporalAuthorityJson(TEMPORAL_AUTHORITY_FIXTURES_V1 as unknown as JsonValue);
    assert.equal(serialized, TEMPORAL_AUTHORITY_FIXTURES_V1_SERIALIZATION);
    assert.equal(Buffer.byteLength(serialized, 'utf8'), 2_264);
    assert.equal(
      createHash('sha256').update(serialized, 'utf8').digest('hex'),
      '381c62512ea178964a86bb0e775d6be3cfae6cef321436cc57fc31818bd60983',
    );
  });
});

describe('Existing Runtime contract compatibility', () => {
  it('does not alter existing mission payload identity or treat requestedAt as identity', () => {
    const request: RuntimeMissionRequest = {
      missionId: 'mission-temporal-compatibility',
      traceId: 'trace-temporal-compatibility',
      product: 'auto_poster',
      action: 'autoposter.post.schedule',
      actor: { id: 'operator', kind: 'service' },
      tenant: { userId: 'user-a', workspaceId: 'workspace-a', accountId: 'account-a' },
      input: { title: 'Deterministic fixture' },
      requestedAt: '2026-07-18T09:00:00.000Z',
    };
    const original = structuredClone(request);
    const before = createRuntimeMissionPayloadHash(request);
    const afterRequestedAtChange = createRuntimeMissionPayloadHash({
      ...request,
      requestedAt: '2026-07-18T09:30:00.000Z',
    });
    createTemporalPolicyBindingHash(before, policy());
    assert.equal(before, afterRequestedAtChange);
    assert.deepEqual(request, original);
  });
});

// Imported after declarations to keep the public contract used throughout the test.
import type { JsonValue } from '../src/index.js';
