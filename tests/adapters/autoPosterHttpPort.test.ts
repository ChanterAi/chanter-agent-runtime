/**
 * AutoPoster HTTP port tests: typed/bounded behavior with an injected fetch —
 * status mapping, timeout -> unavailable, token header handling, and the
 * guarantee that the service token never leaks into returned data.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAutoPosterHttpPort,
  RUNTIME_CONTROL_TOKEN_HEADER,
} from '../../src/adapters/autoPosterHttpPort.js';

const TOKEN = 'runtime-test-token-abc123';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeFetch(
  responder: (call: RecordedCall) => { status: number; json?: unknown; nonJson?: boolean } | 'hang'
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const plan = responder(call);
    if (plan === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    return {
      ok: plan.status >= 200 && plan.status < 300,
      status: plan.status,
      json: async () => {
        if (plan.nonJson) throw new Error('Unexpected token < in JSON');
        return plan.json;
      },
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makePort(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createAutoPosterHttpPort({
    baseUrl: 'http://localhost:3010/',
    serviceToken: TOKEN,
    fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

describe('createAutoPosterHttpPort — wiring', () => {
  it('fails closed at construction when baseUrl or token is missing', () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200, json: { ok: true } }));
    assert.throws(() => createAutoPosterHttpPort({ baseUrl: '', serviceToken: TOKEN, fetchImpl }));
    assert.throws(() => createAutoPosterHttpPort({ baseUrl: 'http://localhost:3010', serviceToken: '', fetchImpl }));
  });

  it('sends the service token header, JSON accept, and bounded query parameters', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      json: { ok: true, items: [], count: 0, scope: { accountId: 'all' } },
    }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 25 });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://localhost:3010/api/runtime/queue?limit=25');
    assert.equal(calls[0]!.headers[RUNTIME_CONTROL_TOKEN_HEADER], TOKEN);
    assert.equal(calls[0]!.method, 'GET');
  });
});

describe('createAutoPosterHttpPort — status mapping', () => {
  const cases: Array<[number, string]> = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [400, 'validation_failed'],
    [422, 'validation_failed'],
    [503, 'unavailable'],
    [500, 'internal'],
  ];
  for (const [status, code] of cases) {
    it(`maps HTTP ${status} to '${code}'`, async () => {
      const { fetchImpl } = makeFetch(() => ({ status, json: { ok: false, reason: 'refused' } }));
      const port = makePort(fetchImpl);
      const result = await port.getPostStatus({ userId: 'owner', postId: 'post-1' });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, code);
    });
  }

  it('prefers an explicit downstream error code over the HTTP status mapping', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 404,
      json: { ok: false, code: 'forbidden', reason: 'not yours' },
    }));
    const port = makePort(fetchImpl);
    const result = await port.getPostStatus({ userId: 'owner', postId: 'post-1' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'forbidden');
  });

  it('an HTTP 200 body without ok:true is refused, not trusted', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200, json: { unexpected: 'shape' } }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 5 });
    assert.equal(result.ok, false);
  });

  it('a non-JSON response maps to a structured failure', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 200, nonJson: true }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 5 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'internal');
  });
});

describe('createAutoPosterHttpPort — reachability and boundedness', () => {
  it('a connection failure maps to unavailable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 5 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unavailable');
  });

  it('a hung request times out and maps to unavailable (no retry)', async () => {
    const { fetchImpl, calls } = makeFetch(() => 'hang');
    const port = makePort(fetchImpl, 50);
    const result = await port.schedulePost({
      userId: 'owner',
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/a.mp4',
      caption: '',
      hashtags: '',
      scheduledAt: '2099-07-11T09:00:00.000Z',
      idempotencyKey: 'idem-1',
      requestedBy: 'mcp-client',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'unavailable');
      assert.match(result.message, /timed out/);
    }
    assert.equal(calls.length, 1, 'exactly one attempt — retries could duplicate scheduling');
  });

  it('failure messages never contain the service token', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 500, json: { ok: false, reason: 'boom' } }));
    const port = makePort(fetchImpl);
    const result = await port.listQueue({ userId: 'owner', limit: 5 });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  it('schedule sends the full typed body and never the tenant userId (server derives it from the token)', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 201,
      json: {
        ok: true,
        duplicate: false,
        post: { id: 'post-9', accountId: 'account-a', status: 'scheduled', scheduledAt: '2099-07-11T09:00:00.000Z', approved: false },
      },
    }));
    const port = makePort(fetchImpl);
    const result = await port.schedulePost({
      userId: 'owner',
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/a.mp4',
      caption: 'Launch',
      hashtags: '#go',
      scheduledAt: '2099-07-11T09:00:00.000Z',
      idempotencyKey: 'idem-9',
      requestedBy: 'mcp-client',
    });
    assert.equal(result.ok, true);
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    assert.equal(body.accountId, 'account-a');
    assert.equal(body.idempotencyKey, 'idem-9');
    assert.equal(body.userId, undefined, 'tenant identity must be derived server-side from the token');
  });
});
