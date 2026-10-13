// OpenTelemetry for the voice agent: one span per browser session, one per
// spoken turn, one per tool call. The tool-call span's context is injected
// into the A2A request (traceparent), so the kagent controller and the agent
// pod continue the same trace: voice question -> delegation -> LLM and tool
// spans of the kagent agent, in one trace id across the three backends.
//
// Export: OTLP/gRPC to OTEL_EXPORTER_OTLP_ENDPOINT (default the bridge
// collector of releases/mlflow-otel-collector.yaml, port-forwarded to 4317).
// Manual spans only: the http auto-instrumentation needs an ESM loader hook
// that `node server.ts` does not have, and the fetch calls we care about are
// the two in kagent.ts.
import { context, propagation, trace, diag, DiagConsoleLogger, DiagLogLevel, SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

// Export failures are silent by default; a dead port-forward on 4317 looked
// like "no spans" until this was on.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME ?? "voice-agent", "service.version": "0.2.0" }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4317" }))],
});
provider.register({ propagator: new W3CTraceContextPropagator() });
export const tracer = trace.getTracer("voice-agent");

export function startSpan(name: string, attrs: Record<string, string | number> = {}, parent?: Span, kind = SpanKind.INTERNAL): Span {
  const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
  return tracer.startSpan(name, { kind, attributes: attrs }, ctx);
}
export function headersFor(span: Span): Record<string, string> {
  const h: Record<string, string> = {};
  propagation.inject(trace.setSpan(context.active(), span), h);
  return h;
}
export function endOk(span: Span, attrs: Record<string, string | number> = {}) { span.setAttributes(attrs); span.setStatus({ code: SpanStatusCode.OK }); span.end(); }
export function endErr(span: Span, e: unknown) { span.recordException(e as Error); span.setStatus({ code: SpanStatusCode.ERROR, message: String((e as Error)?.message ?? e) }); span.end(); }
export const shutdownTracing = () => provider.shutdown();
export { SpanKind };
