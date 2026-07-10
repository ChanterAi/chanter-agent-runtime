# AutoPoster Operational Control Loop — P1B

> Status: implemented and test-proven 2026-07-10. This document describes exactly what
> the code does; it makes no claims beyond what the referenced tests verify.

## 1. Architecture flow

```
MCP tool (chanter-mcp-server, 4 chanter.autoposter_* tools)
  -> executeAutoPosterMission (mcp: src/runtime/autoposterGateway.ts)
  -> executeMission (this package: src/missions.ts)
       envelope validation -> idempotency replay check -> RuntimeTask creation
       -> approval gate -> action policy gate -> adapter dispatch
       -> validation -> truthful result + redacted evidence bundle
  -> AutoPoster mission adapter (src/adapters/autoPosterMissionAdapter.ts)
  -> AutoPoster operations port (src/adapters/autoPosterHttpPort.ts — typed,
       bounded HTTP client; injectable fake in tests)
  -> AutoPoster control routes (chanter-auto-poster: src/runtimeControlRoutes.js,
       token-guarded /api/runtime/*)
  -> existing AutoPoster services (storage.js queue chokepoint, mediaPolicy.js)
```

Layer responsibilities are fixed:

- **MCP** is a thin control interface: schema validation, mission construction, truthful
  status mapping. It holds no queue/media/ownership/scheduling logic and cannot reach
  AutoPoster except through this runtime (`tests/p4-autoposter-runtime.test.ts` includes a
  source-scan proving the tool handlers import only the gateway and never call fetch).
- **Agent Runtime** owns orchestration: policy, approval, idempotency, redaction, evidence.
- **AutoPoster** stays the business authority: ownership, tenant scoping, the video-only
  media policy, queue creation, and the human approval gate all execute inside AutoPoster.

## 2. Canonical action names

| Action | Kind | Risk / policy | Idempotency key |
| --- | --- | --- | --- |
| `autoposter.queue.list` | read | low / `local_only` | not required |
| `autoposter.post.get_status` | read | low / `local_only` | not required |
| `autoposter.media.validate` | read | low / `local_only` | not required |
| `autoposter.post.schedule` | write | high / `requires_approval` | **required** |

## 3. Request / result contract

`RuntimeMissionRequest` (src/missions.ts): `missionId`, `traceId` (defaults to
`missionId`; preserved through the full chain), `product`, `action`, `actor {id, kind}`,
`tenant {userId, accountId?}`, `input`, `policyContext?`, `approval {approved,
approvedBy, note}?`, `idempotencyKey?`, `metadata?`, `requestedAt?`.

`RuntimeMissionResult`: `missionId`, `traceId`, `product`, `action`, `status`, `output`,
`evidence` (a `RuntimeEvidenceBundle`), `warnings`, `errors [{code, message}]`,
`policyDecision`, `approvalDecision {required, approved, approvedBy}`, `idempotency
{key, outcome, originalMissionId?}`, `startedAt`, `completedAt`, `durationMs`.

Statuses are explicit and truthful: `succeeded`, `failed`, `denied`,
`validation_failed`, `approval_required`, `duplicate`, `unavailable`. A downstream
failure is never reported as success; an unreachable AutoPoster is `unavailable`, never
an empty success. `media.validate` succeeds as a *validation run* — an invalid input is
`status: succeeded` with `output.valid: false` plus a rejection code.

## 4. Security boundaries

- AutoPoster's `/api/runtime/*` routes require the `RUNTIME_CONTROL_TOKEN` service token
  (constant-time compare over SHA-256 digests). No token configured -> every request is
  refused with 503 (fail closed). Admin session cookies are never accepted there.
- Tenant identity is derived server-side from the token (AutoPoster's
  `config.defaultUserId`); a caller-supplied userId is ignored. Account scope is
  verified against `storage.getTikTokAccount` ownership.
- Redaction is applied at the runtime's existing choke points (task inputs, events,
  evidence exports) plus mission outputs/warnings/errors in `executeMission`. The
  service token is sent only in the `x-chanter-runtime-token` header and never logged
  or echoed.
- The HTTP port makes exactly one attempt per call with an AbortController timeout
  (default 10s) and no retries — a retry could double-create a queue item.
- MCP responses carry the mission result verbatim; `isError` is set for every status
  except `succeeded` and `duplicate`.

## 5. Approval behavior

`autoposter.post.schedule` is created as a high-risk `requires_approval` task, so the
existing transition table forces the approval gate. The mission's approval context must
carry `approved: true` **and** a non-empty `approvedBy`; anything less returns
`approval_required` with the task honestly stopped at that state, and the adapter is
never invoked. Approval here releases *runtime execution only* — the created queue item
itself is still an **unapproved AutoPoster draft**, and AutoPoster's own human approval
gate (`storage.approvePost`; `scheduler.claimPost` refuses unapproved jobs) remains the
only path to publishing.

## 6. Idempotency behavior

Two layers, both test-proven:

1. **Runtime** (`createInMemoryIdempotencyStore`, per MCP server process): a key that
   already reached the adapter returns the stored result as `status: duplicate` with
   `idempotency.outcome: duplicate` and the original missionId. Missions refused before
   execution (validation/approval/policy) do not consume their key, so a corrected
   retry works.
2. **AutoPoster** (durable, in the queue itself): each runtime-scheduled post stores
   `runtimeIdempotencyKey`; the schedule route returns the existing item
   (`duplicate: true`) instead of creating a second one. This holds even across MCP
   server restarts.

## 7. Supported and intentionally unsupported

Supported: the four actions above, through the full MCP -> runtime -> AutoPoster chain.

Intentionally unsupported: direct TikTok publishing (no publish action exists; adapter
specs never use `publish` policy types or `publish_guarded`), post deletion, approval
of AutoPoster drafts, queue reordering, caption/content generation, Instagram actions,
and any runtime-triggered cron/tick processing. Mission-level dry-run is not offered:
the existing `evaluateRuntimeActionPolicy` dryRun decision-preview remains available,
and no fake execution-preview layer was invented on top of it.

## 8. Local test / invocation examples

Run the proofs:

```bash
# runtime: mission executor + adapter + HTTP port (187 tests)
cd apps/chanter-agent-runtime && npm run build && npm test
# AutoPoster: control routes (152 tests)
cd apps/chanter-auto-poster && npm test
# MCP: tools + end-to-end success/failure contract (178 tests)
cd apps/chanter-mcp-server && npm test
```

MCP wiring (environment of chanter-mcp-server):

```
AUTOPOSTER_BASE_URL=http://localhost:3010
AUTOPOSTER_RUNTIME_TOKEN=<value of AutoPoster's RUNTIME_CONTROL_TOKEN>
```

Example MCP call (tool `chanter.autoposter_schedule_post`):

```json
{
  "accountId": "account-a",
  "mediaUrl": "https://cdn.example.com/launch.mp4",
  "scheduledAtUtc": "2026-07-12T09:00:00Z",
  "idempotencyKey": "launch-2026-07-12-account-a",
  "caption": "Launch teaser",
  "approvedBy": "founder",
  "requestedBy": "claude"
}
```

Successful result: `status: succeeded`, `output.post.id` (the queue item),
`output.post.approved: false`, `output.publishing: "blocked_until_human_approval"`,
plus the policy decision, approval decision, idempotency outcome, and the redacted
evidence bundle with the full event log.

## 9. Known limitations

- The runtime idempotency store is in-memory per MCP process; durable idempotency is
  provided only by AutoPoster's `runtimeIdempotencyKey` lookup, which is a
  read-then-write (a concurrent same-key race could pass the read; the runtime layer
  narrows but does not eliminate this).
- Single-tenant: tenant identity is AutoPoster's `defaultUserId`; multi-user auth does
  not exist yet anywhere in AutoPoster.
- Live-chain verification (real MCP process against a real AutoPoster server) requires
  local credentials (Firebase, `RUNTIME_CONTROL_TOKEN`) and was not part of automated
  validation; the E2E contract tests fake only the HTTP port boundary.
- Scheduling failures after queue creation leave a truthfully-reported unscheduled
  draft (`createdPostId` in the error); cleanup is manual by design.

## 10. Next logical milestone

Runtime-controlled review actions: expose AutoPoster's existing human approval gate
(`approve` / `revoke approval`) through the same mission contract with an Operator-side
approval workflow, making the full "schedule -> human review -> release" loop drivable
from the control plane while publishing stays human-gated.
