import { describe, it } from 'node:test';
import assert from 'node:assert';
import { redactText, redactJsonValue, redactRecord } from '../src/redaction.js';
import type { JsonValue } from '../src/index.js';

describe('redactText: key=value style secrets', () => {
  it('redacts OPENAI_API_KEY assignments', () => {
    const out = redactText('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456');
    assert.strictEqual(out, 'OPENAI_API_KEY=[REDACTED]');
  });

  it('redacts ANTHROPIC_API_KEY assignments', () => {
    const out = redactText('config: ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    assert.strictEqual(out, 'config: ANTHROPIC_API_KEY=[REDACTED]');
  });

  it('redacts generic API_KEY style key-value text, quoted or camelCase', () => {
    assert.strictEqual(redactText('API_KEY: "abc123"'), 'API_KEY: [REDACTED]');
    assert.strictEqual(redactText('apiKey=abc123'), 'apiKey=[REDACTED]');
    assert.strictEqual(redactText('DB_PASSWORD=hunter2'), 'DB_PASSWORD=[REDACTED]');
  });

  it('leaves the surrounding text and separator style intact', () => {
    const out = redactText('Set OPENAI_API_KEY=sk-abc123 before running.');
    assert.strictEqual(out, 'Set OPENAI_API_KEY=[REDACTED] before running.');
  });
});

describe('redactText: bearer tokens', () => {
  it('redacts Authorization bearer tokens', () => {
    const out = redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcDEF123.signatureXYZ');
    assert.strictEqual(out, 'Authorization: Bearer [REDACTED]');
  });

  it('is case-insensitive on the "bearer" keyword', () => {
    const out = redactText('bearer abcDEF123456789xyzABC');
    assert.strictEqual(out, 'Bearer [REDACTED]');
  });
});

describe('redactText: provider-style secret keys', () => {
  it('redacts sk- prefixed keys standalone', () => {
    const out = redactText('here is the key: sk-abcdefghijklmnopqrstuvwxyz1234567890');
    assert.strictEqual(out, 'here is the key: [REDACTED]');
  });

  it('redacts GitHub ghp_ tokens', () => {
    const out = redactText('token ghp_1234567890abcdefghijKLMNOPQR used in CI');
    assert.strictEqual(out, 'token [REDACTED] used in CI');
  });

  it('redacts GitHub github_pat_ fine-grained tokens', () => {
    const out = redactText('github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz');
    assert.strictEqual(out, '[REDACTED]');
  });
});

describe('redactText: private key blocks', () => {
  it('redacts a full PEM private key block', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234567890abcdefgh',
      'moreBase64DataHere==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactText(`before\n${pem}\nafter`);
    assert.strictEqual(out, 'before\n[REDACTED_PRIVATE_KEY]\nafter');
  });
});

describe('redactText: long suspicious secrets', () => {
  it('redacts long mixed-case alphanumeric tokens with no known prefix', () => {
    const out = redactText('raw value: aB3dE7fG9hJ1kL5mN8pQ2rS6tU0vW4xY');
    assert.strictEqual(out, 'raw value: [REDACTED]');
  });

  it('does not redact long lowercase-only or all-digit identifiers (git hashes, ids)', () => {
    const out = redactText('commit abcdef0123456789abcdef0123456789abcdef01 looks fine');
    assert.strictEqual(out, 'commit abcdef0123456789abcdef0123456789abcdef01 looks fine');
  });
});

describe('redactText: normal text stays readable', () => {
  it('leaves ordinary prose untouched', () => {
    const text =
      'The build passed and no secrets were found. Please review the pull request before merging to main.';
    assert.strictEqual(redactText(text), text);
  });

  it('leaves short identifiers, file paths, and enum-like words untouched', () => {
    const text = 'Task safecommit-review objective at src/adapters/safeCommitAdapter.ts status=completed';
    assert.strictEqual(redactText(text), text);
  });
});

describe('redactJsonValue: nested JSON redaction', () => {
  it('redacts a sensitive field nested several levels deep', () => {
    const input: JsonValue = {
      level1: {
        level2: {
          level3: {
            apiKey: 'sk-abcdefghijklmnopqrstuvwxyz123456',
            note: 'safe to keep',
          },
        },
      },
    };
    const out = redactJsonValue(input) as Record<string, JsonValue>;
    const level3 = (((out.level1 as any).level2 as any).level3) as Record<string, JsonValue>;
    assert.strictEqual(level3.apiKey, '[REDACTED]');
    assert.strictEqual(level3.note, 'safe to keep');
  });

  it('redacts free-text secrets found inside non-sensitively-named nested fields', () => {
    const input: JsonValue = { config: { notes: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456' } };
    const out = redactJsonValue(input) as any;
    assert.strictEqual(out.config.notes, 'OPENAI_API_KEY=[REDACTED]');
  });
});

describe('redactJsonValue: arrays redact', () => {
  it('redacts secrets inside an array of strings', () => {
    const input: JsonValue = ['normal string', 'Bearer abcDEF123456789xyzABCqrstuvw'];
    const out = redactJsonValue(input) as JsonValue[];
    assert.strictEqual(out[0], 'normal string');
    assert.strictEqual(out[1], 'Bearer [REDACTED]');
  });

  it('redacts sensitive fields inside an array of objects', () => {
    const input: JsonValue = [
      { username: 'alice', password: 'hunter2' },
      { username: 'bob', password: 'correcthorsebatterystaple' },
    ];
    const out = redactJsonValue(input) as Record<string, JsonValue>[];
    assert.strictEqual(out[0].username, 'alice');
    assert.strictEqual(out[0].password, '[REDACTED]');
    assert.strictEqual(out[1].password, '[REDACTED]');
  });
});

describe('redactJsonValue: leaves normal data readable', () => {
  it('does not touch numbers, booleans, null, or non-sensitive strings', () => {
    const input: JsonValue = { count: 3, active: true, missing: null, label: 'diff.patch' };
    const out = redactJsonValue(input) as Record<string, JsonValue>;
    assert.deepStrictEqual(out, input);
  });

  it('keeps a null value null even under a sensitive key name', () => {
    const input: JsonValue = { token: null };
    const out = redactJsonValue(input) as Record<string, JsonValue>;
    assert.strictEqual(out.token, null);
  });
});

describe('redactRecord', () => {
  it('behaves like redactJsonValue for a top-level record', () => {
    const input: Record<string, JsonValue> = {
      branch: 'main',
      secretToken: 'ghp_1234567890abcdefghijKLMNOPQR',
    };
    const out = redactRecord(input);
    assert.strictEqual(out.branch, 'main');
    assert.strictEqual(out.secretToken, '[REDACTED]');
  });
});

describe('no undefined values are introduced', () => {
  it('round-trips cleanly through JSON.stringify/parse with no "undefined" leaking in', () => {
    const input: JsonValue = {
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz123456',
      nested: { password: 'x', list: ['Bearer abcDEF123456789xyzABCqrstuvw', 42, null, true] },
    };
    const out = redactJsonValue(input);
    const json = JSON.stringify(out);
    assert.ok(!json.includes('undefined'));
    const roundTripped = JSON.parse(json);
    assert.deepStrictEqual(roundTripped, out);
  });

  it('redactText never returns undefined for any string input, including empty string', () => {
    assert.strictEqual(typeof redactText(''), 'string');
    assert.strictEqual(redactText(''), '');
  });
});
