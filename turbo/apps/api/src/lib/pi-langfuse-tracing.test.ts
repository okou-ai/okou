import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import {
  normalizePiLangfuseTraceId,
  piLangfuseIdGenerator,
  PI_LANGFUSE_API_OBSERVATION_NAMES,
  recordPiLangfuseRunEndToEnd,
} from "./pi-langfuse-tracing";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function epochMillis(time: readonly [number, number]): number {
  return time[0] * 1000 + time[1] / 1_000_000;
}

function installMemoryExporter(): {
  readonly axiomExporter: InMemorySpanExporter;
  readonly exporter: InMemorySpanExporter;
  readonly provider: BasicTracerProvider;
} {
  const axiomExporter = new InMemorySpanExporter();
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    idGenerator: piLangfuseIdGenerator,
    spanProcessors: [
      new SimpleSpanProcessor(axiomExporter),
      new LangfuseSpanProcessor({
        exporter,
        publicKey: "pk-lf-test",
        secretKey: "sk-lf-test",
        mediaUploadEnabled: false,
        shouldExportSpan: ({ otelSpan }) => {
          return (
            otelSpan.instrumentationScope.name === "langfuse-sdk" &&
            PI_LANGFUSE_API_OBSERVATION_NAMES.includes(otelSpan.name)
          );
        },
      }),
    ],
  });
  setLangfuseTracerProvider(provider);
  return { axiomExporter, exporter, provider };
}

describe("Pi Langfuse trace IDs", () => {
  it("normalizes the run UUID into one W3C trace ID", () => {
    expect(normalizePiLangfuseTraceId(RUN_ID)).toBe(
      "11111111222243338444555555555555",
    );
    expect(normalizePiLangfuseTraceId("not-a-run-id")).toBeUndefined();
    expect(
      normalizePiLangfuseTraceId("00000000-0000-0000-0000-000000000000"),
    ).toBeUndefined();
  });
});

describe("Pi run E2E Langfuse tracing", () => {
  it("records one run E2E span through the terminal commit timestamp", async () => {
    const { exporter, provider } = installMemoryExporter();
    const apiStartedAt = Date.parse("2026-09-13T23:57:22.208Z");
    const terminalCommittedAt = Date.parse("2026-09-13T23:57:31.186Z");

    recordPiLangfuseRunEndToEnd({
      enabled: true,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      userId: "user-1",
      apiStartedAt,
      terminalCommittedAt,
      terminalStatus: "completed",
    });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [e2e] = spans;
    expect(e2e?.name).toBe("Run End-to-End");
    expect(e2e?.spanContext().traceId).toBe(normalizePiLangfuseTraceId(RUN_ID));
    expect(e2e?.parentSpanContext).toBeUndefined();
    expect(epochMillis(e2e?.startTime ?? [0, 0])).toBe(apiStartedAt);
    expect(epochMillis(e2e?.endTime ?? [0, 0])).toBe(terminalCommittedAt);
    expect(e2e?.attributes).toMatchObject({
      "vm0.pi.run_id": RUN_ID,
      "vm0.pi.phase": "run-end-to-end",
      "vm0.pi.e2e.duration_ms": 8978,
      "vm0.pi.terminal_committed_at": "2026-09-13T23:57:31.186Z",
      "langfuse.observation.metadata.api_started_at":
        "2026-09-13T23:57:22.208Z",
      "langfuse.observation.metadata.terminal_committed_at":
        "2026-09-13T23:57:31.186Z",
      "langfuse.observation.metadata.duration_ms": "8978",
      "langfuse.observation.metadata.terminal_status": "completed",
    });
    expect(e2e?.attributes).not.toHaveProperty("langfuse.observation.input");
    expect(e2e?.attributes).not.toHaveProperty("langfuse.observation.output");
  });
});

describe("Pi run E2E Langfuse gating", () => {
  it("does not create an E2E span without the run gate or API start", async () => {
    const { exporter, provider } = installMemoryExporter();
    const terminalCommittedAt = Date.parse("2026-09-13T23:57:31.186Z");

    recordPiLangfuseRunEndToEnd({
      enabled: false,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      userId: "user-1",
      apiStartedAt: terminalCommittedAt - 1000,
      terminalCommittedAt,
      terminalStatus: "completed",
    });
    recordPiLangfuseRunEndToEnd({
      enabled: true,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      userId: "user-1",
      apiStartedAt: undefined,
      terminalCommittedAt,
      terminalStatus: "completed",
    });
    await provider.forceFlush();

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
