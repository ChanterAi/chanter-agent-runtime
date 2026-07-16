/**
 * CHANTER Agent Runtime — Loop Governor mission process port.
 *
 * The only transport a mission may use to reach Loop Governor. It runs the
 * fixed local module `python -m governor.mission_intake` under the Master
 * Plan §3 port rules:
 *
 *   fixed executable (absolute path, validated at construction)
 *   fixed module (constant argument array, never caller-influenced)
 *   JSON on stdin — no shell, no interpolation, no argument smuggling
 *   fixed working directory (the Loop Governor repository root)
 *   bounded environment (small allowlist + explicit data-dir isolation)
 *   timeout with process kill
 *   stdout/stderr size limits
 *   JSON-only response, strictly validated and identity-echo checked
 *
 * Downstream semantics (idempotent create, read-only lookup, typed
 * conflicts) are owned by Loop Governor's `governor/mission_intake.py`;
 * this port only transports and truthfully classifies outcomes.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';

// ---------------------------------------------------------------------------
// Port contract
// ---------------------------------------------------------------------------

export interface LoopGovernorManualLoopTaskInput {
  appName: string;
  taskType: string;
  goal: string;
  scope?: string;
  promptMode?: string;
  allowedFiles?: string[];
  forbiddenActions?: string[];
  validationCommands?: string[];
  maxContext?: string;
}

export interface LoopGovernorManualLoopCreateParams {
  missionId: string;
  payloadHash: string;
  task: LoopGovernorManualLoopTaskInput;
}

export interface LoopGovernorManualLoopLookupParams {
  missionId: string;
  payloadHash: string;
}

export interface LoopGovernorManualLoopCreateSuccess {
  ok: true;
  /** False when the durable downstream binding already existed (replay/recovery). */
  created: boolean;
  taskId: string;
  loopId: string;
  realAgentExecution: false;
}

export type LoopGovernorManualLoopLookupOutcome =
  | 'unique'
  | 'not_found'
  | 'incomplete'
  | 'payload_mismatch';

export interface LoopGovernorManualLoopBinding {
  taskId: string;
  loopId: string;
  boundAt: string;
}

export interface LoopGovernorManualLoopLookupSuccess {
  ok: true;
  outcome: LoopGovernorManualLoopLookupOutcome;
  binding: LoopGovernorManualLoopBinding | null;
}

export type LoopGovernorPortErrorCode =
  | 'unavailable'
  | 'timeout'
  | 'validation_failed'
  | 'conflict'
  | 'invalid_response'
  | 'internal';

export interface LoopGovernorPortFailure {
  ok: false;
  code: LoopGovernorPortErrorCode;
  message: string;
  /** Stable downstream mission-intake code, when one was returned. */
  downstreamCode?: string;
}

export interface LoopGovernorMissionPort {
  createManualLoop(
    params: LoopGovernorManualLoopCreateParams,
  ): Promise<LoopGovernorManualLoopCreateSuccess | LoopGovernorPortFailure>;
  lookupManualLoop(
    params: LoopGovernorManualLoopLookupParams,
  ): Promise<LoopGovernorManualLoopLookupSuccess | LoopGovernorPortFailure>;
}

// ---------------------------------------------------------------------------
// Process port implementation
// ---------------------------------------------------------------------------

/** Constant module invocation — never derived from any caller input. */
export const LOOP_GOVERNOR_MISSION_INTAKE_ARGS = Object.freeze([
  '-m',
  'governor.mission_intake',
] as const);

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
const STDERR_CAPTURE_LIMIT = 2_048;
const MESSAGE_DETAIL_LIMIT = 512;

/** Only these parent environment variables may reach the child process. */
const ENVIRONMENT_ALLOWLIST = Object.freeze([
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
] as const);

const VALIDATION_DOWNSTREAM_CODES = new Set([
  'MISSION_INTAKE_VALIDATION_FAILED',
  'MISSION_INTAKE_UNSUPPORTED_FIELD',
  'MISSION_INTAKE_INVALID_JSON',
  'MISSION_INTAKE_REQUEST_TOO_LARGE',
]);

const LOOKUP_OUTCOMES: ReadonlySet<string> = new Set([
  'unique',
  'not_found',
  'incomplete',
  'payload_mismatch',
]);

export type LoopGovernorSpawnImplementation = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    shell: false;
    windowsHide: true;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
) => ChildProcess;

export interface LoopGovernorProcessPortOptions {
  /** Absolute path to the Python executable. Relative paths are rejected. */
  pythonExecutable: string;
  /** Absolute path to the Loop Governor repository root (the fixed cwd). */
  governorRoot: string;
  /** Optional isolated LOOP_GOVERNOR_DATA_DIR passed to the child. */
  dataDir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Test seam only; production wiring always uses node:child_process.spawn. */
  spawnImplementation?: LoopGovernorSpawnImplementation;
}

interface ProcessOutcome {
  kind: 'exit' | 'timeout' | 'spawn_error' | 'stdout_overflow';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorMessage?: string;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function isExactNonblankString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function boundedEnvironment(dataDir: string | undefined): Record<string, string> {
  const environment: Record<string, string> = {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const key of ENVIRONMENT_ALLOWLIST) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  if (dataDir) environment.LOOP_GOVERNOR_DATA_DIR = dataDir;
  return environment;
}

function createRequestBody(params: LoopGovernorManualLoopCreateParams): string {
  const task = params.task;
  return JSON.stringify({
    mode: 'create',
    mission_id: params.missionId,
    payload_hash: params.payloadHash,
    task: {
      app_name: task.appName,
      task_type: task.taskType,
      goal: task.goal,
      ...(task.scope ? { scope: task.scope } : {}),
      ...(task.promptMode ? { prompt_mode: task.promptMode } : {}),
      ...(task.allowedFiles && task.allowedFiles.length > 0
        ? { allowed_files: task.allowedFiles }
        : {}),
      ...(task.forbiddenActions && task.forbiddenActions.length > 0
        ? { forbidden_actions: task.forbiddenActions }
        : {}),
      ...(task.validationCommands && task.validationCommands.length > 0
        ? { validation_commands: task.validationCommands }
        : {}),
      ...(task.maxContext ? { max_context: task.maxContext } : {}),
    },
  });
}

function lookupRequestBody(params: LoopGovernorManualLoopLookupParams): string {
  return JSON.stringify({
    mode: 'lookup',
    mission_id: params.missionId,
    payload_hash: params.payloadHash,
  });
}

function mapDownstreamFailure(
  code: unknown,
  message: unknown,
): LoopGovernorPortFailure {
  const downstreamCode = typeof code === 'string' ? code : 'MISSION_INTAKE_INTERNAL';
  const detail = typeof message === 'string'
    ? truncate(message, MESSAGE_DETAIL_LIMIT)
    : 'Loop Governor mission intake reported a failure without a message.';
  if (downstreamCode === 'MISSION_INTAKE_PAYLOAD_CONFLICT') {
    return { ok: false, code: 'conflict', message: detail, downstreamCode };
  }
  if (VALIDATION_DOWNSTREAM_CODES.has(downstreamCode)) {
    return { ok: false, code: 'validation_failed', message: detail, downstreamCode };
  }
  return { ok: false, code: 'internal', message: detail, downstreamCode };
}

export function createLoopGovernorProcessPort(
  options: LoopGovernorProcessPortOptions,
): LoopGovernorMissionPort {
  const pythonExecutable = options.pythonExecutable;
  const governorRoot = options.governorRoot;
  if (!isExactNonblankString(pythonExecutable) || !isAbsolute(pythonExecutable)) {
    throw new TypeError('pythonExecutable must be an absolute path to a fixed executable.');
  }
  if (!isExactNonblankString(governorRoot) || !isAbsolute(governorRoot)) {
    throw new TypeError('governorRoot must be an absolute path to the Loop Governor repository.');
  }
  if (options.dataDir !== undefined && !isAbsolute(options.dataDir)) {
    throw new TypeError('dataDir must be an absolute path when provided.');
  }
  const timeoutMs = options.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : options.timeoutMs;
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < MIN_TIMEOUT_MS
    || timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`,
    );
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1_024) {
    throw new TypeError('maxOutputBytes must be an integer of at least 1024.');
  }
  const spawnImplementation = options.spawnImplementation
    ?? (nodeSpawn as unknown as LoopGovernorSpawnImplementation);

  function runIntake(requestBody: string): Promise<ProcessOutcome> {
    return new Promise((resolvePromise) => {
      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      let child: ChildProcess;
      try {
        child = spawnImplementation(
          pythonExecutable,
          [...LOOP_GOVERNOR_MISSION_INTAKE_ARGS],
          {
            cwd: governorRoot,
            env: boundedEnvironment(options.dataDir),
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
      } catch (error) {
        resolvePromise({
          kind: 'spawn_error',
          exitCode: null,
          stdout: '',
          stderr: '',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const settle = (outcome: ProcessOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(outcome);
      };

      const collectOutput = (): { stdout: string; stderr: string } => ({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: truncate(
          Buffer.concat(stderrChunks).toString('utf-8'),
          STDERR_CAPTURE_LIMIT,
        ),
      });

      const timer = setTimeout(() => {
        child.kill();
        settle({ kind: 'timeout', exitCode: null, ...collectOutput() });
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          child.kill();
          settle({ kind: 'stdout_overflow', exitCode: null, ...collectOutput() });
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= STDERR_CAPTURE_LIMIT * 4) stderrChunks.push(chunk);
      });
      child.on('error', (error) => {
        settle({
          kind: 'spawn_error',
          exitCode: null,
          ...collectOutput(),
          errorMessage: error.message,
        });
      });
      child.on('close', (exitCode) => {
        settle({ kind: 'exit', exitCode, ...collectOutput() });
      });

      child.stdin?.on('error', () => {
        // EPIPE from an early-exiting child: the close handler settles truthfully.
      });
      child.stdin?.end(requestBody, 'utf-8');
    });
  }

  function classifyTransportFailure(outcome: ProcessOutcome): LoopGovernorPortFailure {
    if (outcome.kind === 'timeout') {
      return {
        ok: false,
        code: 'timeout',
        message: `Loop Governor mission intake exceeded its ${timeoutMs}ms timeout and was terminated.`,
      };
    }
    if (outcome.kind === 'spawn_error') {
      return {
        ok: false,
        code: 'unavailable',
        message: `Loop Governor mission intake could not start: ${truncate(outcome.errorMessage ?? 'unknown spawn error', MESSAGE_DETAIL_LIMIT)}`,
      };
    }
    if (outcome.kind === 'stdout_overflow') {
      return {
        ok: false,
        code: 'invalid_response',
        message: `Loop Governor mission intake exceeded the ${maxOutputBytes}-byte response limit.`,
      };
    }
    return {
      ok: false,
      code: 'unavailable',
      message: `Loop Governor mission intake exited with code ${outcome.exitCode ?? 'null'} without a typed response.${outcome.stderr ? ` stderr: ${truncate(outcome.stderr, MESSAGE_DETAIL_LIMIT)}` : ''}`,
    };
  }

  type ExchangeResult =
    | { kind: 'failure'; failure: LoopGovernorPortFailure }
    | { kind: 'response'; response: Record<string, unknown> };

  const asFailure = (failure: LoopGovernorPortFailure): ExchangeResult => ({
    kind: 'failure',
    failure,
  });

  async function exchange(requestBody: string): Promise<ExchangeResult> {
    const outcome = await runIntake(requestBody);
    if (outcome.kind !== 'exit') return asFailure(classifyTransportFailure(outcome));

    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch {
      if (outcome.exitCode === 0) {
        return asFailure({
          ok: false,
          code: 'invalid_response',
          message: 'Loop Governor mission intake returned non-JSON output.',
        });
      }
      return asFailure(classifyTransportFailure(outcome));
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return asFailure({
        ok: false,
        code: 'invalid_response',
        message: 'Loop Governor mission intake returned a non-object response.',
      });
    }
    const response = parsed as Record<string, unknown>;
    if (response.ok === false) {
      return asFailure(mapDownstreamFailure(response.code, response.message));
    }
    if (response.ok !== true || outcome.exitCode !== 0) {
      return asFailure({
        ok: false,
        code: 'invalid_response',
        message: 'Loop Governor mission intake response has no truthful ok discriminant.',
      });
    }
    return { kind: 'response', response };
  }

  function identityEchoValid(
    response: Record<string, unknown>,
    missionId: string,
    payloadHash: string,
    mode: 'create' | 'lookup',
  ): boolean {
    return response.mode === mode
      && response.mission_id === missionId
      && response.payload_hash === payloadHash;
  }

  const invalidResponse = (detail: string): LoopGovernorPortFailure => ({
    ok: false,
    code: 'invalid_response',
    message: `Loop Governor mission intake returned an invalid response: ${detail}`,
  });

  return {
    async createManualLoop(params) {
      const result = await exchange(createRequestBody(params));
      if (result.kind === 'failure') return result.failure;
      const response = result.response;
      if (!identityEchoValid(response, params.missionId, params.payloadHash, 'create')) {
        return invalidResponse('the mission identity echo does not match the request.');
      }
      if (
        typeof response.created !== 'boolean'
        || !isExactNonblankString(response.task_id)
        || !isExactNonblankString(response.loop_id)
        || response.real_agent_execution !== false
      ) {
        return invalidResponse('the create result is missing exact task/loop identity or the real-agent freeze flag.');
      }
      return {
        ok: true,
        created: response.created,
        taskId: response.task_id,
        loopId: response.loop_id,
        realAgentExecution: false,
      };
    },

    async lookupManualLoop(params) {
      const result = await exchange(lookupRequestBody(params));
      if (result.kind === 'failure') return result.failure;
      const response = result.response;
      if (!identityEchoValid(response, params.missionId, params.payloadHash, 'lookup')) {
        return invalidResponse('the mission identity echo does not match the request.');
      }
      const outcome = response.outcome;
      if (typeof outcome !== 'string' || !LOOKUP_OUTCOMES.has(outcome)) {
        return invalidResponse('the lookup outcome is not a recognized value.');
      }
      if (outcome === 'unique') {
        const binding = response.binding;
        if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
          return invalidResponse('a unique lookup must carry its binding.');
        }
        const bindingRecord = binding as Record<string, unknown>;
        if (
          !isExactNonblankString(bindingRecord.task_id)
          || !isExactNonblankString(bindingRecord.loop_id)
        ) {
          return invalidResponse('the unique binding is missing exact task/loop identity.');
        }
        return {
          ok: true,
          outcome: 'unique',
          binding: {
            taskId: bindingRecord.task_id,
            loopId: bindingRecord.loop_id,
            boundAt: typeof bindingRecord.bound_at === 'string' ? bindingRecord.bound_at : '',
          },
        };
      }
      if (response.binding !== null && response.binding !== undefined) {
        return invalidResponse('a non-unique lookup must not carry a binding.');
      }
      return {
        ok: true,
        outcome: outcome as LoopGovernorManualLoopLookupOutcome,
        binding: null,
      };
    },
  };
}
