/**
 * CHANTER Agent Runtime — generic product adapter contract.
 *
 * Every product-specific adapter in this package (SafeCommit today; Loop
 * Governor / Operator / AutoPoster / MCP Server / Memory Vault as they land)
 * should conform to `RuntimeProductAdapter<TInput>`: a small, product-owned
 * mapping from that product's own stable contract shape into a real
 * RuntimeTask plus its JSON-safe evidence bundle. This file defines that
 * shared shape; it does not itself know about any specific product.
 */
import type { RuntimeProduct, RuntimeTask } from '../types.js';
import { createEvidenceBundle, type RuntimeEvidenceBundle } from '../evidence.js';

/** Wraps a product-specific input payload with the lightweight metadata common to every adapter call. */
export interface RuntimeAdapterInputEnvelope<TInput> {
  /** The product-specific payload being mapped into the runtime (e.g. SafeCommit's AdvisoryContract). */
  input: TInput;
  /** Optional caller-supplied correlation id (e.g. request id, CI run id) for tracing across systems. */
  correlationId?: string;
  /** Optional ISO-8601 timestamp of when this input was produced/received upstream. */
  receivedAt?: string;
}

/** The paired output of running a product adapter: the mapped task and its exported evidence bundle. */
export interface RuntimeAdapterResult {
  task: RuntimeTask;
  evidenceBundle: RuntimeEvidenceBundle;
}

/**
 * The contract every product adapter must implement. `mapToRuntimeTask` and
 * `buildEvidenceBundle` are kept as separate methods (rather than one method
 * returning both) so a caller that only needs one doesn't pay for the other
 * — e.g. a caller that only wants the bundle can call `buildEvidenceBundle`
 * directly without holding onto the intermediate task.
 *
 * Note that calling both methods independently for the same input is *not*
 * guaranteed to describe the same task instance (each mapping generates its
 * own task id/timestamps unless the adapter's input carries an explicit,
 * stable id). Use `runProductAdapter` when you need a task and its bundle
 * to definitely describe one another.
 */
export interface RuntimeProductAdapter<TInput> {
  /** Stable identifier for this adapter, e.g. 'safecommit-advisory-adapter'. */
  id: string;
  /** CHANTER product this adapter maps tasks for. */
  product: RuntimeProduct;
  /** Adapter contract version — bump when the shape of TInput or its mapping changes. */
  version: string;
  /** Maps a product-specific input into a real RuntimeTask, driven through the runtime's lifecycle functions. */
  mapToRuntimeTask(input: TInput): RuntimeTask;
  /** Maps a product-specific input directly into its JSON-safe evidence bundle. */
  buildEvidenceBundle(input: TInput): RuntimeEvidenceBundle;
}

/**
 * Runs a product adapter against an input envelope, returning a task and an
 * evidence bundle that are guaranteed to describe the *same* mapped task:
 * it maps once via `mapToRuntimeTask`, then derives the bundle from that
 * exact task via the shared `createEvidenceBundle`, rather than calling
 * `adapter.buildEvidenceBundle` (which would map a second, independent task).
 */
export function runProductAdapter<TInput>(
  adapter: RuntimeProductAdapter<TInput>,
  envelope: RuntimeAdapterInputEnvelope<TInput>
): RuntimeAdapterResult {
  const task = adapter.mapToRuntimeTask(envelope.input);
  return { task, evidenceBundle: createEvidenceBundle(task) };
}
