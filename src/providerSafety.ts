export const PROVIDER_DIAGNOSTIC_REDACTED_CODE = 'PROVIDER_DIAGNOSTIC_REDACTED';
export const PROVIDER_DIAGNOSTIC_REDACTED_MESSAGE =
  'Provider diagnostic material was withheld by the Runtime safety boundary.';

const forbiddenKey = /^(?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|credential(?:s|envelope)?|session(?:url|uri|locator|locatorenvelope)|upload[_-]?(?:url|uri|locator)|raw(?:body|response|payload))$/i;
const forbiddenText = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /https?:\/\/[^\s"'<>]*(?:upload[_-]?id|upload-session|resumable|session(?:url|uri|locator))[^\s"'<>]*/i,
  /\b(?:upload[_-]?id|session(?:url|uri|locator)|resumable[_-]?(?:url|uri|locator))\s*[:=]\s*[^\s,"'}]+/i,
  /\b(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|credential)\b\s*[:=]\s*["']?[^\s,"'}]+/i,
];

function variants(value: string): string[] {
  const result = new Set([value]);
  let current = value;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const decoded = decodeURIComponent(current.replace(/\+/g, '%20'));
      if (decoded === current) break;
      result.add(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return [...result];
}

export function containsForbiddenProviderMaterial(
  value: unknown,
  protectedValues: readonly string[] = [],
  seen = new Set<object>(),
): boolean {
  if (typeof value === 'string') {
    return variants(value).some((candidate) =>
      forbiddenText.some((pattern) => pattern.test(candidate))
      || protectedValues.some((secret) => secret.length >= 8 && candidate.includes(secret))
    );
  }
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsForbiddenProviderMaterial(entry, protectedValues, seen));
  }
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    forbiddenKey.test(key) || containsForbiddenProviderMaterial(entry, protectedValues, seen)
  );
}

export function safeProviderFailureMessage(value: unknown, protectedValues: readonly string[] = []): string {
  const text = typeof value === 'string' ? value.slice(0, 500) : '';
  return containsForbiddenProviderMaterial(text, protectedValues)
    ? PROVIDER_DIAGNOSTIC_REDACTED_MESSAGE
    : text;
}
