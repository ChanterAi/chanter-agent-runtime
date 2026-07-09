# chanter-agent-runtime

Shared, typed task-lifecycle runtime for CHANTER's control products (Loop Governor,
SafeCommit, Operator, MCP Server, AutoPoster, Clean Engine).

```
Goal -> Plan -> Task -> Approval Gate -> Execution State -> Evidence
     -> Validation -> Review -> Result -> Next Recommendation
```

See [docs/RUNTIME_CONTRACT.md](docs/RUNTIME_CONTRACT.md) for the full contract
(lifecycle, risk model, approval model, evidence bundle, adapters).

## Usage

```ts
import { createTask, attachPlan, startExecution, createEvidenceBundle } from 'chanter-agent-runtime';

let task = createTask({ product: 'clean_engine', objective: 'Sanitize export' });
task = attachPlan(task, { summary: 'Scan and redact' });
task = startExecution(task);
// ...attachEvidence / startValidation / passValidation|failValidation / completeTask|failTask
const bundle = createEvidenceBundle(task);
```

## Scripts

```bash
npm install
npm run typecheck
npm run build
npm test
```

## Status

Real, tested foundation (132 tests passing, verified 2026-07-09). Consumed by
chanter-Operator's backend: `apps/backend/package.json` declares a `file:` dependency and
Operator's runtime bridge imports this package's contract, policy, redaction, and
provider-routing modules (see [docs/RUNTIME_CONTRACT.md](docs/RUNTIME_CONTRACT.md)).
Not yet driving any live external control flow.
One adapter exists today: `src/adapters/safeCommitAdapter.ts` (SafeCommit
`AdvisoryContract` -> `RuntimeTask`).
