/**
 * CHANTER Agent Runtime — secret redaction.
 *
 * Applied at the runtime's write boundaries (task creation/mutation in
 * tasks.ts) and again, defensively, at its export boundaries
 * (createEvidenceBundle/summarizeTaskForReview in evidence.ts) so secrets
 * accidentally passed into the runtime — API keys, bearer tokens, private
 * keys, password/secret/token fields — never survive into logs, dashboards,
 * or SafeCommit/MCP-facing exports.
 *
 * Pattern-matching redaction is inherently best-effort, not a cryptographic
 * guarantee: it cannot catch every possible secret shape. It is a defensive
 * net, not a substitute for callers keeping real secrets out of task data.
 */
import type { JsonValue } from './types.js';

const REDACTED = '[REDACTED]';
const REDACTED_PRIVATE_KEY = '[REDACTED_PRIVATE_KEY]';

/** PEM-style private key blocks, e.g. `-----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----`. */
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/**
 * `SOME_API_KEY=value`, `apiKey: "value"`, `DB_PASSWORD=value`, etc.
 * Matches an identifier built from an optional `_`-joined prefix, a
 * sensitive core word (case-insensitive, `_` optional inside it — so it
 * matches both `API_KEY` and `apiKey`), and an optional `_`-joined suffix,
 * followed by `:`/`=` and a value. Only the value is replaced.
 */
const KEY_VALUE_PATTERN =
  /\b((?:[A-Za-z0-9]+_)*(?:API_?KEY|ACCESS_?KEY|SECRET_?KEY|PRIVATE_?KEY|PASSWORD|SECRET|TOKEN|CREDENTIALS?)(?:_[A-Za-z0-9]+)*)(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/gi;

/** `Bearer <token>` HTTP authorization headers. */
const BEARER_TOKEN_PATTERN = /\bbearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/** OpenAI/Anthropic-style secret keys: `sk-...`, `sk-ant-...`, `sk-proj-...`. */
const OPENAI_STYLE_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g;

/** GitHub personal access tokens: classic `ghp_...` and fine-grained `github_pat_...`. */
const GITHUB_TOKEN_PATTERN = /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/** Fallback net: long contiguous tokens with mixed case + digits (typical of base64/JWT secrets). */
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;

function looksLikeGenericSecret(candidate: string): boolean {
  return /[0-9]/.test(candidate) && /[a-z]/.test(candidate) && /[A-Z]/.test(candidate);
}

/** JSON object keys treated as sensitive regardless of their value's shape. */
const SENSITIVE_KEY_PATTERN = /(password|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i;

/** Redacts known secret patterns out of free-form text. Safe to call on any string, including non-sensitive text. */
export function redactText(input: string): string {
  let out = input.replace(PRIVATE_KEY_BLOCK_PATTERN, REDACTED_PRIVATE_KEY);
  out = out.replace(KEY_VALUE_PATTERN, (_match, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  out = out.replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`);
  out = out.replace(OPENAI_STYLE_KEY_PATTERN, REDACTED);
  out = out.replace(GITHUB_TOKEN_PATTERN, REDACTED);
  out = out.replace(LONG_TOKEN_PATTERN, (match) => (looksLikeGenericSecret(match) ? REDACTED : match));
  return out;
}

/** A JSON object value under a sensitive key collapses entirely to `[REDACTED]` (nulls stay null: nothing to hide). */
function redactSensitiveField(value: JsonValue): JsonValue {
  return value === null ? null : REDACTED;
}

/**
 * Recursively redacts a JSON-safe value: strings are pattern-scanned via
 * `redactText`, arrays are mapped element-wise, and object values whose key
 * looks like a credential field (password/secret/token/*_key/credential)
 * are collapsed to `[REDACTED]` outright, regardless of their shape.
 */
export function redactJsonValue(input: JsonValue): JsonValue {
  if (typeof input === 'string') {
    return redactText(input);
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactJsonValue(item));
  }
  if (input !== null && typeof input === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? redactSensitiveField(value) : redactJsonValue(value);
    }
    return out;
  }
  return input;
}

/** Same recursive redaction as `redactJsonValue`, typed for a top-level record (the common task.inputs shape). */
export function redactRecord(input: Record<string, JsonValue>): Record<string, JsonValue> {
  return redactJsonValue(input) as Record<string, JsonValue>;
}
