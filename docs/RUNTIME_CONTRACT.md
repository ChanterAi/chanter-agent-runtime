# CHANTER Agent Runtime — Contract

> Status: real, tested runtime. Consumed by chanter-Operator's backend since 2026-07-07:
> `apps/backend/package.json` declares a `file:` dependency on this package, and Operator's
> runtime bridge (`apps/backend/src/agentRuntime/runtimeBridge/`) imports its contract,
> policy, redaction, and provider-routing modules. Since P1B (2026-07-10) the runtime also
> drives one live product control flow — the AutoPoster operational control loop
> (`src/missions.ts` + `src/adapters/autoPosterMissionAdapter.ts`), consumed by
> chanter-mcp-server. See docs/AUTOPOSTER_CONTROL_LOOP.md.

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
  *(Update 2026-07-09: Operator has since added `src/agentRuntime/runtimeBridge/`, which
  imports THIS package directly — see the Status line above. The older internal copy
  described here remains prior art.)*

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

As of the P1 hardening pass, `src/adapters/safeCommitAdapter.ts` also exports
`safeCommitAdapter`, a `RuntimeProductAdapter<SafeCommitAdvisoryContractInput>` object
wrapping the same free functions — see **§10 Adapter contract** below.

## 8. Redaction guarantees

`src/redaction.ts` provides `redactText`, `redactJsonValue`, and `redactRecord`. They are
best-effort pattern redaction, not a cryptographic guarantee: a defensive net against
secrets accidentally flowing into task data, not a substitute for keeping real secrets
out of it in the first place.

Patterns covered:
- `KEY=value` / `KEY: value` style assignments where the identifier contains
  `API_KEY`/`ACCESS_KEY`/`SECRET_KEY`/`PRIVATE_KEY`/`PASSWORD`/`SECRET`/`TOKEN`/`CREDENTIAL(S)`,
  case-insensitively and with or without underscores (`OPENAI_API_KEY=`, `apiKey:`,
  `DB_PASSWORD=`, …) — only the value is redacted.
- `Bearer <token>` HTTP authorization headers.
- OpenAI/Anthropic-style `sk-...` secret keys.
- GitHub `ghp_...` and `github_pat_...` tokens.
- PEM-style private key blocks (`-----BEGIN ... PRIVATE KEY----- … -----END ... PRIVATE KEY-----`).
- A fallback net for long (32+ char), contiguous, mixed-case-plus-digit tokens (typical of
  base64/JWT secrets) that don't match any named pattern above. Plain lowercase/digit-only
  identifiers (git hashes, generated task ids) are deliberately left alone.
- JSON object keys that look like credential fields
  (`password`/`secret`/`token`/`*_key`/`credential`) are collapsed to `"[REDACTED]"`
  wholesale, regardless of the value's shape — except `null`, which stays `null`.

Redaction is applied in two layers:
1. **At the write boundary**, inside `tasks.ts`, at the single points where each field is
   constructed: `createTask` (`task.inputs`), the shared `pushEvent` helper (every
   `RuntimeEvent.message`/`.data`, across all event types), `buildEvidence`
   (`RuntimeEvidence.detail`/`.source`), `buildValidationResult`
   (`RuntimeValidationCheck.message`), `buildResult` (`RuntimeResult.output`), and
   `buildRecommendation` (`RuntimeRecommendation.reason`).
2. **At the export boundary**, defensively, inside `evidence.ts`: `createEvidenceBundle`
   and `summarizeTaskForReview` re-redact the same fields before returning, so the
   exported shape is safe even if a `RuntimeTask` was hand-assembled rather than driven
   through the lifecycle functions.

Redaction never introduces `undefined`: every function stays within `JsonValue`, and
`redactRecord`/`redactJsonValue` round-trip cleanly through `JSON.stringify`/`parse`.

## 9. Action policy evaluator

`src/policy.ts` exports `evaluateRuntimeActionPolicy(task, request)`, a second,
additive gate alongside the status transition table: where `assertTransitionAllowed`
governs which `RuntimeStatus` a task may move to, this evaluator governs whether a
concrete side-effecting action may be performed *right now*. It never mutates a task
and never performs the action — it only returns a `RuntimeActionDecision`.

`RuntimeActionType` = `read | write | shell | network | commit | deploy | publish | delete`.

Rules:
- **Terminal tasks** cannot perform any action, `read` included — `blocked: true`.
- **`read`** is allowed at every non-terminal status, regardless of risk or policy.
- **`write` / `shell` / `network`** share a status gate: blocked while the task itself is
  `blocked`; not yet allowed in `draft` (no plan attached); `approvalRequired: true` while
  `approval_required` or while `planned` with an unresolved approval gate; allowed once
  `planned` (no gate needed), `approved`, `executing`, or `validating`. This reuses
  `task.approvalRequired`/`task.status` rather than re-deriving a risk check, since
  high/critical risk is already baked into `approvalRequired` by transitions.ts.
- **`commit`** requires `executionPolicy` of `commit_guarded` or `requires_safecommit_review`;
  otherwise `blocked: true` with `requiredPolicy: 'commit_guarded'`. Once policy-eligible,
  the same status gate as write/shell/network applies.
- **`deploy`** requires `executionPolicy: 'deploy_guarded'`; otherwise blocked with
  `requiredPolicy: 'deploy_guarded'`.
- **`publish`** requires `executionPolicy: 'publish_guarded'`; otherwise blocked with
  `requiredPolicy: 'publish_guarded'`.
- **`delete`** is blocked by default (`blocked: true`) — the runtime has no delete
  implementation yet. A `dryRun: true` request reports that honestly instead of
  pretending a preview exists: `blocked: false`, `allowed: false`, with a reason
  explaining explicit delete support must be added first.
- **`dryRun: true`** on any action type forces `allowed: false` in the returned decision
  (a dry run must never report as having actually been allowed to run), while still
  reporting what `blocked`/`approvalRequired` would be for a real request.

## 10. Provider routing foundation

`src/providerRouting.ts` exports `selectProviderRoute(request, candidates)`. It makes
**no model calls and no network calls** — it is pure candidate selection over a plain
in-memory list the caller supplies (`RuntimeProviderRoute[]`), each entry carrying
`provider`, `toolId`, `product`, `capability`, and `enabled`.

Given a `RuntimeProviderRouteRequest` (`product`, `capability`, `reason`), it:
- picks the **first enabled candidate** matching `product`+`capability`, in the order
  `candidates` was given (callers encode priority via array order);
- returns a `RuntimeProviderRouteDecision` with `provider`, `toolId`, a human-readable
  `reason`, and `fallbackCandidates` — the other matching candidates not selected;
- returns `blocked: true` with `provider`/`toolId: null` when nothing matches (wrong
  product, wrong capability, or every matching candidate disabled), never throws;
- stays fully JSON-safe.

Wiring an actual provider/model call remains entirely the caller's responsibility.

## 11. Generic adapter contract

`src/adapters/runtimeAdapter.ts` defines the shape every product-specific adapter in
this package should conform to, independent of any one product:

- `RuntimeAdapterInputEnvelope<TInput>` — wraps a product-specific input payload with
  optional `correlationId`/`receivedAt` metadata.
- `RuntimeAdapterResult` — `{ task: RuntimeTask; evidenceBundle: RuntimeEvidenceBundle }`.
- `RuntimeProductAdapter<TInput>` — `{ id, product, version, mapToRuntimeTask(input),
  buildEvidenceBundle(input) }`.
- `runProductAdapter(adapter, envelope)` — runs `mapToRuntimeTask` once, then derives the
  bundle from that exact task via `createEvidenceBundle`, so the returned task and bundle
  are guaranteed to describe one another. (Calling `adapter.mapToRuntimeTask` and
  `adapter.buildEvidenceBundle` independently for the same input is *not* guaranteed to
  produce matching ids, since each mapping generates its own task unless the input
  carries an explicit, stable id — use `runProductAdapter` when that guarantee matters.)

`safeCommitAdapter` (see §7) is the reference implementation of this contract.

## 12. Integration rules for CHANTER products

This package is a shared library, not a running service — nothing here is wired into any
product's live control flow yet. Each product integrates by depending on this package and
driving its own inputs through the contract:

- **SafeCommit**: use `safeCommitAdapter` (or the underlying
  `mapAdvisoryContractToRuntimeTask`/`buildSafeCommitEvidenceBundle` functions) to turn an
  `ADVISORY_CONTRACT.json` payload into a `RuntimeTask`. Never let this package's approval
  gate be treated as SafeCommit's own commit gate — SafeCommit's `commitApproval` stays
  `NOT_GRANTED` regardless of what this runtime reports.
- **Operator**: model each orchestrated step as a `RuntimeTask` with the execution policy
  matching its real-world guard (`deploy_guarded` for deploys, `commit_guarded` for
  commits, etc.) so `evaluateRuntimeActionPolicy` reflects the actual gate, not a default.
- **Loop Governor**: attach one `RuntimeTask` per governed iteration; use `blockTask`/
  `attachPlan` recovery for stalled loops rather than fabricating a synthetic completion.
- **AutoPoster**: any outbound post is a `publish` action — route it through
  `evaluateRuntimeActionPolicy` with `executionPolicy: 'publish_guarded'` and attach the
  `publish` guard tag on the clearance evidence before treating a post as approved.
- **MCP Server**: expose `createEvidenceBundle`/`summarizeTaskForReview` output to callers,
  never raw `RuntimeTask` internals — the bundle is the redacted, JSON-safe, stable export
  shape this contract guarantees.
- **Memory Vault**: treat anything persisted through this runtime as already
  redaction-passed at the write boundary (§8), but do not assume redaction is perfect —
  Memory Vault's own storage layer should not be the only place secrets are ever checked.

No product's adapter should import another product's source directly (see the
"no cross-repo import" rationale in `safeCommitAdapter.ts`); depend on this package's
public exports (`src/index.ts`) only.

## 13. Validation commands

From `apps/chanter-agent-runtime`:

```
npm run build       # tsc — compiles src/ and tests/ to dist/
npm run typecheck   # tsc --noEmit — type-checks without emitting
npm test            # recursively discovers and runs every compiled *.test.js file
```

`npm test` runs compiled output, so `npm run build` (or `npm run typecheck` for a
type-only pass) must be run first after any source change.

## 14. Agent Run Ledger v1 contract

`src/agentRunLedger.ts` is the canonical, additive `AgentRunLedgerEntry` wire contract.
It is intentionally separate from `RuntimeTask` and `RuntimeMission`: Loop Governor is
the first producer, while Operator owns durable persistence and read-only supervision.
The contract adds no AutoPoster action and does not change the existing mission replay
hash or recovery path.

The wire shape uses `schema_version: "1.0"`, snake_case fields, explicit nulls, a
one-based integer `sequence`, bounded structured actions/tools/evidence/cost, and its
own ledger status and outcome vocabularies. Provider and model are required inputs;
callers must provide an observed value or the explicit `unknown`/`not_applicable`
sentinel. Known cost uses integer micros plus a three-letter currency. No value is
defaulted or inferred. Timestamps use canonical UTC milliseconds
(`YYYY-MM-DDTHH:mm:ss.sssZ`); `completed_at` and `latency_ms` remain null until a
terminal state.

Hashing is cross-language deterministic:

1. canonical JSON recursively sorts object keys, preserves array order, and emits
   compact UTF-8 JSON; P0 numeric fields are integers;
2. `scope_hash` is SHA-256 over UTF-8 bytes of
   `agent-run-ledger-scope-v1\n` plus the canonical scope object;
3. `payload_hash` is SHA-256 over UTF-8 bytes of
   `agent-run-ledger-payload-v1\n` plus the canonical full entry without either hash.

The exact scope fields are `schema_version`, `run_id`, `product_id`, `workflow_id`,
`agent_id`, `attempt_id`, `parent_run_id`, `trace_id`, `provider`, `model`,
`production_impact`, and `source_subsystem`. Opaque identifiers and references are
never trimmed or lowercased. Free text is redacted before hashing; secret-bearing
opaque fields and signed credential URLs are rejected with typed validation errors.
