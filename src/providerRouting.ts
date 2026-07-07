/**
 * CHANTER Agent Runtime — provider routing foundation.
 *
 * Deliberately dumb: this module never calls a model, a tool, or the
 * network. It only decides *which* configured candidate a caller should use
 * for a given product/capability pair, from a plain in-memory candidate
 * list the caller supplies. Wiring an actual provider call is entirely the
 * caller's responsibility — this is routing selection, not invocation.
 */
import type { RuntimeProduct } from './types.js';

/** One configured route a product could use to satisfy a capability. */
export interface RuntimeProviderRoute {
  /** Provider name, e.g. 'anthropic', 'openai', 'local'. */
  provider: string;
  /** Tool or model identifier at that provider, e.g. 'claude-sonnet-5', 'safecommit-cli'. */
  toolId: string;
  /** CHANTER product this candidate serves. */
  product: RuntimeProduct;
  /** Free-form capability tag, e.g. 'chat', 'commit-review', 'summarize'. */
  capability: string;
  /** Whether this candidate is currently allowed to be selected. */
  enabled: boolean;
}

/** A request to resolve a provider route for a product/capability pair. */
export interface RuntimeProviderRouteRequest {
  product: RuntimeProduct;
  capability: string;
  reason: string;
}

/**
 * The routing outcome. `provider`/`toolId` are `null` when `blocked` is
 * true — there is nothing to route to. `fallbackCandidates` always lists
 * the other candidates that matched product/capability but weren't
 * selected (enabled-but-lower-priority when a selection succeeded, or
 * disabled-only when the decision is blocked), so a caller can retry
 * against the next one without re-deriving the candidate list.
 */
export interface RuntimeProviderRouteDecision {
  blocked: boolean;
  provider: string | null;
  toolId: string | null;
  reason: string;
  fallbackCandidates: RuntimeProviderRoute[];
}

/**
 * Picks the first enabled candidate matching `request.product` and
 * `request.capability`, in the order `candidates` was given (callers
 * encode priority via array order). Returns a blocked decision — never
 * throws — when nothing matches.
 */
export function selectProviderRoute(
  request: RuntimeProviderRouteRequest,
  candidates: RuntimeProviderRoute[]
): RuntimeProviderRouteDecision {
  const eligible = candidates.filter(
    (candidate) => candidate.product === request.product && candidate.capability === request.capability
  );
  const selected = eligible.find((candidate) => candidate.enabled);

  if (!selected) {
    return {
      blocked: true,
      provider: null,
      toolId: null,
      reason: `No enabled provider route found for product="${request.product}" capability="${request.capability}".`,
      fallbackCandidates: eligible.filter((candidate) => !candidate.enabled),
    };
  }

  return {
    blocked: false,
    provider: selected.provider,
    toolId: selected.toolId,
    reason: `Selected provider="${selected.provider}" toolId="${selected.toolId}" for product="${request.product}" capability="${request.capability}".`,
    fallbackCandidates: eligible.filter((candidate) => candidate !== selected),
  };
}
