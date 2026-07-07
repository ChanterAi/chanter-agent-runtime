import { describe, it } from 'node:test';
import assert from 'node:assert';
import { selectProviderRoute } from '../src/providerRouting.js';
import type { RuntimeProviderRoute } from '../src/providerRouting.js';
import { assertJsonSafe } from '../src/index.js';

function route(overrides: Partial<RuntimeProviderRoute> = {}): RuntimeProviderRoute {
  return {
    provider: 'anthropic',
    toolId: 'claude-sonnet-5',
    product: 'operator',
    capability: 'chat',
    enabled: true,
    ...overrides,
  };
}

describe('selectProviderRoute: happy path', () => {
  it('picks the first enabled candidate matching product/capability', () => {
    const candidates: RuntimeProviderRoute[] = [
      route({ provider: 'openai', toolId: 'gpt-x', enabled: false }),
      route({ provider: 'anthropic', toolId: 'claude-sonnet-5', enabled: true }),
      route({ provider: 'local', toolId: 'local-model', enabled: true }),
    ];
    const decision = selectProviderRoute({ product: 'operator', capability: 'chat', reason: 'route a chat turn' }, candidates);
    assert.strictEqual(decision.blocked, false);
    assert.strictEqual(decision.provider, 'anthropic');
    assert.strictEqual(decision.toolId, 'claude-sonnet-5');
    assert.match(decision.reason, /anthropic/);
  });

  it('skips candidates for a different product or capability', () => {
    const candidates: RuntimeProviderRoute[] = [
      route({ provider: 'wrong-product', product: 'safecommit' }),
      route({ provider: 'wrong-capability', capability: 'summarize' }),
      route({ provider: 'correct-match' }),
    ];
    const decision = selectProviderRoute({ product: 'operator', capability: 'chat', reason: 'x' }, candidates);
    assert.strictEqual(decision.provider, 'correct-match');
  });

  it('includes the remaining eligible candidates as fallbackCandidates, excluding the selected one', () => {
    const first = route({ provider: 'anthropic', toolId: 'claude-sonnet-5' });
    const second = route({ provider: 'openai', toolId: 'gpt-x' });
    const decision = selectProviderRoute({ product: 'operator', capability: 'chat', reason: 'x' }, [first, second]);
    assert.strictEqual(decision.fallbackCandidates.length, 1);
    assert.strictEqual(decision.fallbackCandidates[0].provider, 'openai');
  });
});

describe('selectProviderRoute: blocked decisions', () => {
  it('is blocked when no candidate matches the product', () => {
    const candidates: RuntimeProviderRoute[] = [route({ product: 'safecommit' })];
    const decision = selectProviderRoute({ product: 'operator', capability: 'chat', reason: 'x' }, candidates);
    assert.strictEqual(decision.blocked, true);
    assert.strictEqual(decision.provider, null);
    assert.strictEqual(decision.toolId, null);
    assert.deepStrictEqual(decision.fallbackCandidates, []);
  });

  it('is blocked when no candidate matches the capability', () => {
    const candidates: RuntimeProviderRoute[] = [route({ capability: 'summarize' })];
    const decision = selectProviderRoute({ product: 'operator', capability: 'chat', reason: 'x' }, candidates);
    assert.strictEqual(decision.blocked, true);
  });

  it('is blocked when every matching candidate is disabled, and lists them as fallbackCandidates', () => {
    const candidates: RuntimeProviderRoute[] = [
      route({ provider: 'anthropic', enabled: false }),
      route({ provider: 'openai', enabled: false }),
    ];
    const decision = selectProviderRoute({ product: 'operator', capability: 'chat', reason: 'x' }, candidates);
    assert.strictEqual(decision.blocked, true);
    assert.strictEqual(decision.provider, null);
    assert.strictEqual(decision.fallbackCandidates.length, 2);
  });

  it('is blocked on an empty candidate list', () => {
    const decision = selectProviderRoute({ product: 'operator', capability: 'chat', reason: 'x' }, []);
    assert.strictEqual(decision.blocked, true);
    assert.deepStrictEqual(decision.fallbackCandidates, []);
  });
});

describe('selectProviderRoute: JSON-safety', () => {
  it('produces a JSON-safe decision on both success and blocked paths', () => {
    const success = selectProviderRoute({ product: 'operator', capability: 'chat', reason: 'x' }, [route()]);
    assert.doesNotThrow(() => assertJsonSafe(success, 'success decision'));

    const blocked = selectProviderRoute({ product: 'operator', capability: 'chat', reason: 'x' }, []);
    assert.doesNotThrow(() => assertJsonSafe(blocked, 'blocked decision'));
  });
});
