# CHANTER Agent Runtime — Contract

> Status: real, tested foundation. Not yet wired into any product's live control flow.

## 1. Purpose

One shared execution contract for CHANTER's control products — Loop Governor, SafeCommit,
Operator, MCP Server, AutoPoster, Clean Engine:

```
Goal -> Plan -> Task -> Approval Gate -> Execution State -> Evidence
     -> Validation -> Review -> Result -> Next Recommendation
```

Every product task becomes a `RuntimeTask`. Every mutation is a pure function
(`RuntimeTask -> RuntimeTask`), fully audited in `task.logs`, and exportable as a
compact JSON-safe `RuntimeEvidenceBundle`.

## 2. Relationship to prior art in this repo

Two earlier, smaller attempts at this same idea already exist and were reviewed while
building this package:

- `apps/_scratch_safecommit_agentRuntime` — a 6-state (`PLAN/EXECUTE/VALIDATE/EVIDENCE/
  HUMAN_REVIEW/COMPLETE`) contract + mock adapter. Explicitly marked "contract/mock only."
- `apps/CHANTER Operator/apps/backend/src/agentRuntime` — the same 6-state contract,
  further developed with a policy model and three "contract-only" adapters
  (`loopGovernorAdapter.ts`, `safeCommitAdapter.ts`, `autoPosterAdapter.ts`). Not imported
  by any route/API in Operator's backend today — it is dormant, test-only code.

This package is a deliberate evolution, not a rename: it adds risk levels, execution
policies, guarded-policy approval gates, `blocked`/`cancelled` recovery states, and a
richer evidence bundle. See **Files changed / Risks** in the delivery report for the
consolidation recommendation (Operator's `safeCommitAdapter.ts` models SafeCommit states
that don't match SafeCommit's real implementation — a concrete argument for converging
on one contract).

## 3. Lifecycle

```
draft --attachPlan--> planned
planned --requireApproval--> approval_required   (only if approvalRequired)
planned --startExecution--> executing            (only if !approvalRequired)
approval_required --approveTask--> approved
approved --startExecution--> executing
executing --startValidation--> validating
validating --completeTask--> completed   (requires a prior passing validationResult)
validating --failTask--> failed
<any non-terminal> --blockTask--> blocked
<any non-terminal> --cancelTask--> cancelled
blocked --attachPlan--> planned                  (recovery)
completed / failed / cancelled are terminal — create a new task instead
```

`getAllowedNextStatuses(task)` is the single source of truth; `assertTransitionAllowed`
throws a `RuntimeTransitionError` (with `from`/`to`/`allowed` fields) for anything else.

`passValidation`/`failValidation` attach a `RuntimeValidationResult` without changing
status. `completeTask`/`failTask` perform the terminal transition and require a
validation result to already be present (passing, for `completeTask`).

`attachRecommendation` is deliberately allowed on terminal tasks: "Next Recommendation"
is the pipeline's last stage, coming *after* Result.

## 4. Risk model

`RuntimeRiskLevel` = `low | medium | high | critical`.

## 5. Approval model

`RuntimeExecutionPolicy` = `local_only | advisory_only | requires_approval |
requires_safecommit_review | publish_guarded | deploy_guarded | commit_guarded`.

`requiresApprovalBeforeExecution({ riskLevel, executionPolicy })` is `true` when:
- `riskLevel` is `high` or `critical`, **or**
- `executionPolicy` is anything other than `local_only` / `advisory_only` ("guarded").

This drives `task.approvalRequired`, which the transition table enforces automatically —
there is no separate approval check to forget to call.

`requireApproval` emits `SAFECOMMIT_REVIEW_REQUIRED` instead of the generic
`APPROVAL_REQUIRED` when `executionPolicy === 'requires_safecommit_review'`.
`attachEvidence({ ..., guard: 'safecommit_review' | 'publish' | 'deploy' | 'commit' })`
emits the matching `*_GUARD_ATTACHED` event instead of the generic `EVIDENCE_ATTACHED`.

## 6. Evidence bundle

`createEvidenceBundle(task)` produces a `RuntimeEvidenceBundle`: task id, product,
objective, risk level, policy, status, plan summary, evidence, validation commands +
result, final result, a slimmed event-log summary, next recommendation, and timestamps.
It is asserted JSON-safe (round-tripped through `JSON.stringify`/`parse`) before being
returned — see `assertJsonSafe`. Optional fields serialize as `null`, never `undefined`,
so a consumer doesn't need to distinguish "key missing" from "key present but undefined."

`summarizeTaskForReview(task)` produces a human-readable text block + structured fields,
for CLI/terminal consumption (SafeCommit's `commitReadinessSummary` was the model for this).

## 7. Adapters

`src/adapters/safeCommitAdapter.ts` maps a SafeCommit `AdvisoryContract` (the stable
v1 schema SafeCommit already writes to `ADVISORY_CONTRACT.json`) into a real
`RuntimeTask`, by driving it through the actual lifecycle functions rather than
hand-assembling a bundle shape. Notably: a `RED` verdict (`riskLevel: HIGH`) forces the
approval gate, so the resulting task honestly stops at `approval_required` — it does not
fabricate an approval SafeCommit itself never granted. See the adapter's module doc
comment for the full reasoning and the "no cross-repo import" rationale.
