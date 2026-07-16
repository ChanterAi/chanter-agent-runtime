/**
 * Loop Governor process port tests against REAL child processes: fixed
 * module invocation, JSON stdin/stdout exchange, bounded environment,
 * timeout kill, output caps, identity-echo validation, and typed
 * downstream error mapping. A scripted fixture module stands in for
 * governor/mission_intake.py so every transport edge is deterministic;
 * the real module's semantics are covered by Loop Governor's own suite
 * and the Phase 2C cross-repository integration test.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  LOOP_GOVERNOR_MISSION_INTAKE_ARGS,
  createLoopGovernorProcessPort,
} from '../../src/adapters/loopGovernorProcessPort.js';

function resolvePythonExecutable(): string {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const probe = spawnSync(command, ['python'], { encoding: 'utf-8' });
  const candidate = probe.stdout?.split(/\r?\n/).find((line) => line.trim());
  if (probe.status !== 0 || !candidate || !isAbsolute(candidate.trim())) {
    throw new Error('An absolute python executable path is required for process-port tests.');
  }
  return candidate.trim();
}

const FIXTURE_MODULE = String.raw`
import json
import os
import sys
import time

raw = sys.stdin.buffer.read()
request = json.loads(raw.decode("utf-8"))
mission_id = request.get("mission_id", "")
payload_hash = request.get("payload_hash", "")
mode = request.get("mode", "")

if "timeout" in mission_id:
    time.sleep(30)
    sys.exit(0)
if "garbage" in mission_id:
    sys.stdout.write("this is not json")
    sys.exit(0)
if "hugeout" in mission_id:
    sys.stdout.write("x" * 50000)
    sys.exit(0)
if "crashexit" in mission_id:
    sys.stderr.write("fixture crashed hard")
    sys.exit(3)
if "typederr-conflict" in mission_id:
    sys.stdout.write(json.dumps({"ok": False, "code": "MISSION_INTAKE_PAYLOAD_CONFLICT", "message": "bound to a different payload"}))
    sys.exit(1)
if "typederr-validation" in mission_id:
    sys.stdout.write(json.dumps({"ok": False, "code": "MISSION_INTAKE_UNSUPPORTED_FIELD", "message": "unsupported field"}))
    sys.exit(1)

if mode == "lookup":
    if "lookup-unique" in mission_id:
        body = {"ok": True, "mode": "lookup", "mission_id": mission_id, "payload_hash": payload_hash,
                "outcome": "unique", "binding": {"task_id": "task-known", "loop_id": "loop-known", "bound_at": "2026-07-16T00:00:00+00:00"}}
    elif "lookup-badbinding" in mission_id:
        body = {"ok": True, "mode": "lookup", "mission_id": mission_id, "payload_hash": payload_hash,
                "outcome": "not_found", "binding": {"task_id": "task-x", "loop_id": "loop-x"}}
    else:
        body = {"ok": True, "mode": "lookup", "mission_id": mission_id, "payload_hash": payload_hash,
                "outcome": "not_found", "binding": None}
    sys.stdout.write(json.dumps(body))
    sys.exit(0)

echo_mission = "different-mission" if "wrongecho" in mission_id else mission_id
task_id = "task-" + ("leak" if os.environ.get("CHANTER_SECRET_PROBE") else "clean")
loop_id = "loop-" + ("data" if os.environ.get("LOOP_GOVERNOR_DATA_DIR") else "nodata")
body = {
    "ok": True,
    "mode": "create",
    "mission_id": echo_mission,
    "payload_hash": payload_hash,
    "created": True,
    "task_id": task_id,
    "loop_id": loop_id,
    "real_agent_execution": "unfrozen" in mission_id,
}
sys.stdout.write(json.dumps(body))
sys.exit(0)
`;

const VALID_HASH = 'a'.repeat(64);

function taskInput() {
  return {
    appName: 'chanter-operator',
    taskType: 'review',
    goal: 'Exercise the process port transport.',
  };
}

describe('loop governor process port (real child processes)', () => {
  let pythonExecutable = '';
  let fixtureRoot = '';
  let dataDir = '';

  before(() => {
    pythonExecutable = resolvePythonExecutable();
    fixtureRoot = mkdtempSync(join(tmpdir(), 'phase2c-port-fixture-'));
    dataDir = mkdtempSync(join(tmpdir(), 'phase2c-port-data-'));
    mkdirSync(join(fixtureRoot, 'governor'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'governor', '__init__.py'), '', 'utf-8');
    writeFileSync(join(fixtureRoot, 'governor', 'mission_intake.py'), FIXTURE_MODULE, 'utf-8');
    process.env.CHANTER_SECRET_PROBE = 'must-never-reach-the-child';
  });

  after(() => {
    delete process.env.CHANTER_SECRET_PROBE;
  });

  function makePort(overrides: { timeoutMs?: number; maxOutputBytes?: number; dataDir?: string } = {}) {
    return createLoopGovernorProcessPort({
      pythonExecutable,
      governorRoot: fixtureRoot,
      dataDir: overrides.dataDir ?? dataDir,
      timeoutMs: overrides.timeoutMs ?? 20_000,
      ...(overrides.maxOutputBytes ? { maxOutputBytes: overrides.maxOutputBytes } : {}),
    });
  }

  it('freezes the module argument array', () => {
    assert.deepEqual([...LOOP_GOVERNOR_MISSION_INTAKE_ARGS], ['-m', 'governor.mission_intake']);
    assert.equal(Object.isFrozen(LOOP_GOVERNOR_MISSION_INTAKE_ARGS), true);
  });

  it('rejects relative executable and root paths at construction', () => {
    assert.throws(
      () => createLoopGovernorProcessPort({ pythonExecutable: 'python', governorRoot: fixtureRoot }),
      TypeError,
    );
    assert.throws(
      () => createLoopGovernorProcessPort({ pythonExecutable, governorRoot: 'governor' }),
      TypeError,
    );
  });

  it('exchanges one JSON request/response, applies the bounded environment, and passes the data dir', async () => {
    const port = makePort();
    const result = await port.createManualLoop({
      missionId: 'phase2c-port-create',
      payloadHash: VALID_HASH,
      task: taskInput(),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.created, true);
      assert.equal(result.taskId, 'task-clean', 'non-allowlisted parent env must never reach the child');
      assert.equal(result.loopId, 'loop-data', 'LOOP_GOVERNOR_DATA_DIR must reach the child');
      assert.equal(result.realAgentExecution, false);
    }
  });

  it('kills the child on timeout and reports a typed timeout', async () => {
    const port = makePort({ timeoutMs: 1_500 });
    const started = Date.now();
    const result = await port.createManualLoop({
      missionId: 'phase2c-port-timeout',
      payloadHash: VALID_HASH,
      task: taskInput(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'timeout');
    assert.equal(Date.now() - started < 10_000, true, 'the child must be killed, not awaited');
  });

  it('rejects non-JSON stdout as invalid_response', async () => {
    const result = await makePort().createManualLoop({
      missionId: 'phase2c-port-garbage',
      payloadHash: VALID_HASH,
      task: taskInput(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid_response');
  });

  it('caps oversized stdout as invalid_response', async () => {
    const result = await makePort({ maxOutputBytes: 4_096 }).createManualLoop({
      missionId: 'phase2c-port-hugeout',
      payloadHash: VALID_HASH,
      task: taskInput(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid_response');
  });

  it('classifies an untyped nonzero exit as unavailable', async () => {
    const result = await makePort().createManualLoop({
      missionId: 'phase2c-port-crashexit',
      payloadHash: VALID_HASH,
      task: taskInput(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unavailable');
  });

  it('classifies a missing executable as unavailable', async () => {
    const port = createLoopGovernorProcessPort({
      pythonExecutable: join(fixtureRoot, 'no-such-python.exe'),
      governorRoot: fixtureRoot,
      timeoutMs: 5_000,
    });
    const result = await port.createManualLoop({
      missionId: 'phase2c-port-missing-exe',
      payloadHash: VALID_HASH,
      task: taskInput(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unavailable');
  });

  it('rejects a mismatched mission identity echo', async () => {
    const result = await makePort().createManualLoop({
      missionId: 'phase2c-port-wrongecho',
      payloadHash: VALID_HASH,
      task: taskInput(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid_response');
  });

  it('rejects a create result that does not attest the real-agent freeze', async () => {
    const result = await makePort().createManualLoop({
      missionId: 'phase2c-port-unfrozen',
      payloadHash: VALID_HASH,
      task: taskInput(),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid_response');
  });

  it('maps typed downstream conflicts and validation refusals', async () => {
    const conflict = await makePort().createManualLoop({
      missionId: 'phase2c-port-typederr-conflict',
      payloadHash: VALID_HASH,
      task: taskInput(),
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.code, 'conflict');
      assert.equal(conflict.downstreamCode, 'MISSION_INTAKE_PAYLOAD_CONFLICT');
    }
    const validation = await makePort().createManualLoop({
      missionId: 'phase2c-port-typederr-validation',
      payloadHash: VALID_HASH,
      task: taskInput(),
    });
    assert.equal(validation.ok, false);
    if (!validation.ok) assert.equal(validation.code, 'validation_failed');
  });

  it('validates lookup outcomes and bindings strictly', async () => {
    const port = makePort();
    const unique = await port.lookupManualLoop({
      missionId: 'phase2c-port-lookup-unique',
      payloadHash: VALID_HASH,
    });
    assert.equal(unique.ok, true);
    if (unique.ok) {
      assert.equal(unique.outcome, 'unique');
      assert.equal(unique.binding?.taskId, 'task-known');
      assert.equal(unique.binding?.loopId, 'loop-known');
    }
    const notFound = await port.lookupManualLoop({
      missionId: 'phase2c-port-lookup-notfound',
      payloadHash: VALID_HASH,
    });
    assert.equal(notFound.ok, true);
    if (notFound.ok) {
      assert.equal(notFound.outcome, 'not_found');
      assert.equal(notFound.binding, null);
    }
    const badBinding = await port.lookupManualLoop({
      missionId: 'phase2c-port-lookup-badbinding',
      payloadHash: VALID_HASH,
    });
    assert.equal(badBinding.ok, false);
    if (!badBinding.ok) assert.equal(badBinding.code, 'invalid_response');
  });
});
