/**
 * CHANTER Agent Runtime — Loop Governor mission adapter.
 *
 * Registers exactly one controlled write action:
 *
 *   loop_governor.manual_loop.create   write / medium / requires_approval
 *                                      idempotency required / production_impact: false
 *
 * The action creates one manual (human-relayed) Loop Governor task + relay
 * loop through the injected LoopGovernorMissionPort. Real coding-agent
 * execution stays frozen: the downstream module never launches an agent, and
 * this adapter verifies the `realAgentExecution: false` attestation on every
 * successful result.
 *
 * Downstream idempotency: the port binds (missionId, payloadHash) durably in
 * Loop Governor before the task exists, so re-execution after any crash
 * boundary returns the same task/loop identifiers with `created: false` —
 * reported truthfully here as a `duplicate`, never as a fresh success.
 */
import type {
  RuntimeMissionActionSpec,
  RuntimeMissionAdapter,
  RuntimeMissionAdapterOutcome,
  RuntimeMissionError,
  RuntimeMissionRequest,
} from '../missions.js';
import { createRuntimeMissionPayloadHash } from '../missions.js';
import type {
  LoopGovernorManualLoopTaskInput,
  LoopGovernorMissionPort,
  LoopGovernorPortFailure,
} from './loopGovernorProcessPort.js';

export const LOOP_GOVERNOR_ACTIONS = Object.freeze({
  manualLoopCreate: 'loop_governor.manual_loop.create',
} as const);

export const LOOP_GOVERNOR_DOWNSTREAM_OPERATION_TYPE =
  'loop_governor.task.create_manual_loop' as const;

const TASK_TYPES: ReadonlySet<string> = new Set([
  'build',
  'fix',
  'test',
  'review',
  'document',
  'deploy_check',
]);
const PROMPT_MODES: ReadonlySet<string> = new Set(['concise', 'full']);

const MAX_APP_NAME_LENGTH = 120;
const MAX_GOAL_LENGTH = 2_000;
const MAX_SCOPE_LENGTH = 2_000;
const MAX_CONTEXT_LENGTH = 2_000;
const MAX_LIST_ITEMS = 64;
const MAX_LIST_ITEM_LENGTH = 512;

const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set([
  'appName',
  'taskType',
  'goal',
  'scope',
  'promptMode',
  'allowedFiles',
  'forbiddenActions',
  'validationCommands',
  'maxContext',
]);

interface ValidatedManualLoopInput {
  errors: RuntimeMissionError[];
  task: LoopGovernorManualLoopTaskInput | null;
}

function pushError(errors: RuntimeMissionError[], code: string, message: string): void {
  errors.push({ code, message });
}

function boundedText(
  errors: RuntimeMissionError[],
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
  required: boolean,
): string {
  const value = input[field];
  if (value === undefined || value === null) {
    if (required) pushError(errors, 'LOOP_GOVERNOR_INPUT_INVALID', `input.${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') {
    pushError(errors, 'LOOP_GOVERNOR_INPUT_INVALID', `input.${field} must be a string.`);
    return '';
  }
  const normalized = value.trim();
  if (required && !normalized) {
    pushError(errors, 'LOOP_GOVERNOR_INPUT_INVALID', `input.${field} is required.`);
    return '';
  }
  if (normalized.length > maxLength) {
    pushError(
      errors,
      'LOOP_GOVERNOR_INPUT_INVALID',
      `input.${field} must be at most ${maxLength} characters.`,
    );
    return '';
  }
  return normalized;
}

function boundedStringList(
  errors: RuntimeMissionError[],
  input: Record<string, unknown>,
  field: string,
): string[] {
  const value = input[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    pushError(
      errors,
      'LOOP_GOVERNOR_INPUT_INVALID',
      `input.${field} must be a list of at most ${MAX_LIST_ITEMS} strings.`,
    );
    return [];
  }
  const items: string[] = [];
  for (const item of value) {
    if (
      typeof item !== 'string'
      || !item.trim()
      || item.length > MAX_LIST_ITEM_LENGTH
    ) {
      pushError(
        errors,
        'LOOP_GOVERNOR_INPUT_INVALID',
        `Every input.${field} item must be a nonblank string of at most ${MAX_LIST_ITEM_LENGTH} characters.`,
      );
      return [];
    }
    items.push(item.trim());
  }
  return items;
}

export function validateManualLoopInput(request: RuntimeMissionRequest): ValidatedManualLoopInput {
  const errors: RuntimeMissionError[] = [];
  const input = request.input;

  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      pushError(
        errors,
        'LOOP_GOVERNOR_INPUT_UNSUPPORTED_FIELD',
        `input.${key} is not a registered manual-loop field.`,
      );
    }
  }

  const appName = boundedText(errors, input, 'appName', MAX_APP_NAME_LENGTH, true);
  const goal = boundedText(errors, input, 'goal', MAX_GOAL_LENGTH, true);
  const scope = boundedText(errors, input, 'scope', MAX_SCOPE_LENGTH, false);
  const maxContext = boundedText(errors, input, 'maxContext', MAX_CONTEXT_LENGTH, false);

  const taskType = input.taskType;
  if (typeof taskType !== 'string' || !TASK_TYPES.has(taskType)) {
    pushError(
      errors,
      'LOOP_GOVERNOR_INPUT_INVALID',
      `input.taskType must be one of: ${[...TASK_TYPES].join(', ')}.`,
    );
  }
  const promptMode = input.promptMode ?? 'concise';
  if (typeof promptMode !== 'string' || !PROMPT_MODES.has(promptMode)) {
    pushError(
      errors,
      'LOOP_GOVERNOR_INPUT_INVALID',
      `input.promptMode must be one of: ${[...PROMPT_MODES].join(', ')}.`,
    );
  }

  const allowedFiles = boundedStringList(errors, input, 'allowedFiles');
  const forbiddenActions = boundedStringList(errors, input, 'forbiddenActions');
  const validationCommands = boundedStringList(errors, input, 'validationCommands');

  if (errors.length > 0) return { errors, task: null };
  return {
    errors,
    task: {
      appName,
      taskType: taskType as string,
      goal,
      ...(scope ? { scope } : {}),
      promptMode: promptMode as string,
      ...(allowedFiles.length > 0 ? { allowedFiles } : {}),
      ...(forbiddenActions.length > 0 ? { forbiddenActions } : {}),
      ...(validationCommands.length > 0 ? { validationCommands } : {}),
      ...(maxContext ? { maxContext } : {}),
    },
  };
}

function failureOutcome(failure: LoopGovernorPortFailure): RuntimeMissionAdapterOutcome {
  const status = failure.code === 'validation_failed'
    ? 'validation_failed' as const
    : failure.code === 'unavailable' || failure.code === 'timeout'
      ? 'unavailable' as const
      : 'failed' as const;
  return {
    ok: false,
    status,
    errors: [{
      code: failure.code === 'conflict'
        ? 'LOOP_GOVERNOR_PAYLOAD_CONFLICT'
        : failure.code === 'timeout'
          ? 'LOOP_GOVERNOR_TIMEOUT'
          : failure.code === 'unavailable'
            ? 'LOOP_GOVERNOR_UNAVAILABLE'
            : failure.code === 'validation_failed'
              ? 'LOOP_GOVERNOR_VALIDATION_FAILED'
              : failure.code === 'invalid_response'
                ? 'LOOP_GOVERNOR_INVALID_RESPONSE'
                : 'LOOP_GOVERNOR_INTAKE_FAILED',
      message: failure.message,
    }],
  };
}

export function createLoopGovernorMissionAdapter(
  port: LoopGovernorMissionPort,
): RuntimeMissionAdapter {
  const manualLoopCreateSpec: RuntimeMissionActionSpec = {
    action: LOOP_GOVERNOR_ACTIONS.manualLoopCreate,
    description:
      'Create one manual (human-relayed, agent-frozen) Loop Governor task and relay loop, idempotently bound to the mission identity.',
    policyActionType: 'write',
    riskLevel: 'medium',
    executionPolicy: 'requires_approval',
    requiresIdempotencyKey: true,
    downstreamOperationType: LOOP_GOVERNOR_DOWNSTREAM_OPERATION_TYPE,
    validateIdempotencyScope: (request) => validateManualLoopInput(request).errors,
  };

  return {
    id: 'loop-governor-mission-adapter',
    product: 'loop_governor',
    version: '1.0.0',
    actions: [manualLoopCreateSpec],
    async execute(request, spec): Promise<RuntimeMissionAdapterOutcome> {
      if (spec.action !== LOOP_GOVERNOR_ACTIONS.manualLoopCreate) {
        return {
          ok: false,
          status: 'denied',
          errors: [{
            code: 'LOOP_GOVERNOR_UNSUPPORTED_ACTION',
            message: `Action "${spec.action}" is not implemented by the Loop Governor mission adapter.`,
          }],
        };
      }
      const validated = validateManualLoopInput(request);
      if (!validated.task) {
        return { ok: false, status: 'validation_failed', errors: validated.errors };
      }

      const payloadHash = createRuntimeMissionPayloadHash(request);
      const result = await port.createManualLoop({
        missionId: request.missionId,
        payloadHash,
        task: validated.task,
      });
      if (!result.ok) return failureOutcome(result);

      return {
        ok: true,
        status: result.created ? 'succeeded' : 'duplicate',
        output: {
          loop: {
            loopId: result.loopId,
            taskId: result.taskId,
            created: result.created,
          },
          governor: 'manual_relay',
          realAgentExecution: false,
          payloadHash,
        },
        evidence: [{
          type: 'artifact',
          label: 'loop-governor-manual-loop',
          detail: `Manual relay loop ${result.loopId} bound to task ${result.taskId} (created=${result.created}); real-agent execution remains frozen.`,
          source: 'loop-governor-mission-intake',
        }],
      };
    },
  };
}
