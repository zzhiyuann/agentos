/**
 * OpenTelemetry SDK bootstrap for AgentOS (RYA-1092).
 *
 * Emits OTLP HTTP/protobuf traces following the OpenTelemetry GenAI semantic
 * conventions (currently `Development` stability). Idempotent — safe to import
 * from any entrypoint.
 *
 * Span model:
 *   Root:   invoke_agent {role}  (CLIENT)   — spawn.ts on attempt start
 *   Child:  execute_tool memory.{op}        — memory-store.ts wrappers
 *   Child:  execute_tool handoff.write      — handoff-enrich.ts wrapper
 *   Child:  attempt.completed                — monitor.ts when attempt resolves
 *
 * Honors:
 *   - OTEL_SDK_DISABLED=true              → fully disabled (no-op tracer)
 *   - OTEL_EXPORTER_OTLP_ENDPOINT unset   → no-op (returns the global Noop tracer)
 *   - OTEL_SEMCONV_STABILITY_OPT_IN       → opt into the current GenAI attribute names
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

import {
  trace,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | null = null;
let started = false;

/** True when the exporter has been started and spans will be emitted. */
export function isTelemetryEnabled(): boolean {
  return started;
}

/**
 * Start the OTel SDK. Idempotent. Returns immediately when telemetry is
 * disabled via env (no endpoint, or OTEL_SDK_DISABLED=true) so AgentOS still
 * runs unmodified in CI / fresh dev installs.
 */
export function startTelemetry(): void {
  if (started) return;
  if (process.env.OTEL_SDK_DISABLED === 'true') return;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'agentos',
      [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION ?? '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter(),
  });
  sdk.start();
  started = true;
}

/** Flush and shut down the exporter. Call from graceful-shutdown handlers. */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    console.debug(`[telemetry] shutdown failed: ${(err as Error).message}`);
  }
  sdk = null;
  started = false;
}

/** Return a Tracer (real when started, NoopTracer otherwise — calls remain safe). */
export function tracer(): Tracer {
  return trace.getTracer('agentos', process.env.OTEL_SERVICE_VERSION ?? '0.1.0');
}

/**
 * Serialize the active trace context into a W3C `traceparent` string for
 * cross-process propagation. Returns undefined when no active span exists.
 */
export function getTraceparentHeader(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

/**
 * Run a synchronous or async function inside an execute_tool INTERNAL span
 * with GenAI semconv attributes. Records exceptions and sets ERROR status on
 * throw. The span is always ended.
 */
export async function withToolSpan<T>(
  toolName: string,
  toolType: 'datastore' | 'function' | 'extension',
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const span = tracer().startSpan(`execute_tool ${toolName}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.type': toolType,
      ...attrs,
    },
  });
  try {
    return await fn();
  } catch (err) {
    span.recordException(err as Error);
    span.setAttribute('error.type', (err as Error).name || 'Error');
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Emit an `attempt.completed` child span anchored to a previously-saved root
 * span context (see saveAttemptTraceContext in db.ts). This is the
 * cross-process "close the root span" pattern from the design spec §5.5:
 * monitor and spawn may run in different processes, so we cannot re-hydrate
 * the original Span object — we attach a completion event under the same
 * trace_id instead, and let the backend correlate.
 */
export function emitAttemptCompleted(
  stored: SerializedSpanContext,
  outcome: 'completed' | 'failed' | 'killed' | 'blocked' | 'idle',
  attrs: Record<string, string | number | boolean> = {},
): void {
  const spanContext: SpanContext = {
    traceId: stored.traceId,
    spanId: stored.spanId,
    traceFlags: (stored.traceFlags ?? 1) as 1 | 0,
    isRemote: true,
  };
  const ctx = trace.setSpanContext(context.active(), spanContext);
  const span = tracer().startSpan(
    `attempt.completed`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        'aos.attempt.outcome': outcome,
        ...attrs,
      },
    },
    ctx,
  );
  if (outcome === 'failed' || outcome === 'killed') {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

export interface SerializedSpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

export { trace, context, SpanKind, SpanStatusCode };
export type { Span, Tracer, SpanContext };
