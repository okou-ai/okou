import type { PiApiFirstTurnResult } from "@okouai/pi-agent-runtime/api";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
} from "@langfuse/tracing";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { PI_LANGFUSE_MAX_CAPTURED_CHARS } from "./pi-langfuse-debug";
import {
  normalizePiLangfuseTraceId,
  piLangfuseIdGenerator,
  PI_LANGFUSE_API_OBSERVATION_NAMES,
  recordPiLangfuseRunEndToEnd,
  startPiLangfuseOwnershipTransfer,
  tracePiApiFirstTurn,
} from "./pi-langfuse-tracing";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function epochMillis(time: readonly [number, number]): number {
  return time[0] * 1000 + time[1] / 1_000_000;
}

function turnResult(handoffRequired: boolean): PiApiFirstTurnResult {
  return {
    assistantMessage: {
      content: handoffRequired
        ? [
            {
              type: "toolCall",
              id: "tool-1",
              name: "read",
              arguments: { path: "README.md" },
            },
          ]
        : [{ type: "text", text: "done" }],
      model: "model-1",
      responseId: "response-1",
      stopReason: handoffRequired ? "toolUse" : "stop",
      timestamp: 1,
      usage: {
        input: 5,
        output: 3,
        cacheRead: 2,
        cacheWrite: 1,
      },
    },
    handoffRequired,
    observedServiceTier: undefined,
    sessionJsonl: "{}\n",
  };
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

type FinishedSpan = ReturnType<
  InMemorySpanExporter["getFinishedSpans"]
>[number];

function requireFinishedSpan(
  exporter: InMemorySpanExporter,
  name: string,
): FinishedSpan {
  const span = exporter.getFinishedSpans().find((candidate) => {
    return candidate.name === name;
  });
  expect(span).toBeDefined();
  if (!span) {
    throw new Error(`Expected ${name} span`);
  }
  return span;
}

function expectOfficialPluginParityPayload(
  generation: FinishedSpan,
  axiomGeneration: FinishedSpan,
): void {
  expect(
    JSON.parse(
      String(
        generation.attributes[LangfuseOtelSpanAttributes.OBSERVATION_INPUT],
      ),
    ),
  ).toStrictEqual({ role: "user", content: "inspect the repository" });
  expect(
    JSON.parse(
      String(
        generation.attributes[LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT],
      ),
    ),
  ).toStrictEqual({
    role: "assistant",
    tool_calls: [{ id: "tool-1", name: "read" }],
  });
  for (const attribute of [
    LangfuseOtelSpanAttributes.OBSERVATION_INPUT,
    LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT,
  ]) {
    expect(axiomGeneration.attributes[attribute]).toBe(
      generation.attributes[attribute],
    );
  }
  for (const exportedGeneration of [generation, axiomGeneration]) {
    expect(exportedGeneration.attributes).toMatchObject({
      "vm0.pi.instrumentation_source": "vm0-api-custom",
      "langfuse.observation.metadata.instrumentation_source": "vm0-api-custom",
      "langfuse.observation.metadata.content_capture": "official-plugin-parity",
    });
  }
}

describe("Pi API-first Langfuse tracing", () => {
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

describe("Pi API-first Langfuse tracing", () => {
  it("creates API, generation, and real ownership-transfer observations", async () => {
    const { axiomExporter, exporter, provider } = installMemoryExporter();
    const result = await tracePiApiFirstTurn({
      enabled: true,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      userId: "user-1",
      prompt: "inspect the repository",
      model: "model-1",
      provider: "provider-1",
      execute() {
        return Promise.resolve(turnResult(true));
      },
    });
    await provider.forceFlush();
    expect(
      exporter.getFinishedSpans().find((span) => {
        return span.name === "Ownership Transfer";
      }),
    ).toBeUndefined();

    const transfer = startPiLangfuseOwnershipTransfer(result.traceContext);
    expect(transfer).toBeDefined();
    if (!transfer) {
      throw new Error("Expected a transfer observation");
    }
    transfer.end();
    result.traceContext?.end();
    const terminalCommittedAt = Date.parse("2026-09-14T03:39:10.832Z");
    recordPiLangfuseRunEndToEnd({
      enabled: true,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      userId: "user-1",
      apiStartedAt: terminalCommittedAt - 2000,
      terminalCommittedAt,
      terminalStatus: "completed",
    });
    await provider.forceFlush();

    const root = requireFinishedSpan(exporter, "API First Turn");
    const generation = requireFinishedSpan(exporter, "API LLM Call");
    const ownership = requireFinishedSpan(exporter, "Ownership Transfer");
    const runEndToEnd = requireFinishedSpan(exporter, "Run End-to-End");

    const traceId = normalizePiLangfuseTraceId(RUN_ID);
    expect(root.spanContext().traceId).toBe(traceId);
    expect(generation.spanContext().traceId).toBe(traceId);
    expect(ownership.spanContext().traceId).toBe(traceId);
    expect(runEndToEnd.spanContext().traceId).toBe(traceId);
    expect(runEndToEnd.parentSpanContext).toBeUndefined();
    expect(root.parentSpanContext?.spanId).toBe(
      runEndToEnd.spanContext().spanId,
    );
    expect(root.attributes[LangfuseOtelSpanAttributes.IS_APP_ROOT]).toBe(true);
    expect(generation.attributes[LangfuseOtelSpanAttributes.IS_APP_ROOT]).toBe(
      undefined,
    );
    expect(ownership.attributes[LangfuseOtelSpanAttributes.IS_APP_ROOT]).toBe(
      undefined,
    );
    expect(generation.parentSpanContext?.spanId).toBe(
      root.spanContext().spanId,
    );
    expect(ownership.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(transfer.parent).toStrictEqual({
      traceId,
      spanId: ownership.spanContext().spanId,
      traceFlags: 1,
      sessionId: SESSION_ID,
    });
    expect(generation.attributes).toMatchObject({
      "vm0.pi.run_id": RUN_ID,
      "vm0.pi.phase": "api-first-generation",
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "provider-1",
      "gen_ai.request.model": "model-1",
    });
    expectOfficialPluginParityPayload(
      generation,
      requireFinishedSpan(axiomExporter, "API LLM Call"),
    );
  });
});

describe("Pi API-first Langfuse payloads", () => {
  it("redacts and bounds shared API generation payloads", async () => {
    const { axiomExporter, exporter, provider } = installMemoryExporter();
    const inputSecret = "pk-lf-user-input-secret";
    const outputSecret = "sk-lf-model-output-secret";
    const longInput = `${inputSecret}:${"i".repeat(
      PI_LANGFUSE_MAX_CAPTURED_CHARS * 2,
    )}`;
    const longOutput = `${outputSecret}:${"o".repeat(
      PI_LANGFUSE_MAX_CAPTURED_CHARS * 2,
    )}`;
    const expected = turnResult(false);
    const result = await tracePiApiFirstTurn({
      enabled: true,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      userId: "user-1",
      prompt: longInput,
      model: "model-1",
      provider: "provider-1",
      execute() {
        return Promise.resolve({
          ...expected,
          assistantMessage: {
            ...expected.assistantMessage,
            content: [{ type: "text", text: longOutput }],
          },
        });
      },
    });
    result.traceContext?.end();
    await provider.forceFlush();

    for (const exported of [exporter, axiomExporter]) {
      const generation = exported.getFinishedSpans().find((span) => {
        return span.name === "API LLM Call";
      });
      const input = JSON.parse(
        String(
          generation?.attributes[LangfuseOtelSpanAttributes.OBSERVATION_INPUT],
        ),
      ) as { content: string };
      const output = JSON.parse(
        String(
          generation?.attributes[LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT],
        ),
      ) as { content: string };
      expect(input.content).toHaveLength(PI_LANGFUSE_MAX_CAPTURED_CHARS);
      expect(output.content).toHaveLength(PI_LANGFUSE_MAX_CAPTURED_CHARS);
      expect(input.content).toContain("[redacted-langfuse-secret]");
      expect(output.content).toContain("[redacted-langfuse-secret]");
      expect(input.content).not.toContain(inputSecret);
      expect(output.content).not.toContain(outputSecret);
    }
  });
});

describe("Pi API-first Langfuse transfer", () => {
  it("can transfer a settled API result when active input moves ownership", async () => {
    const { exporter, provider } = installMemoryExporter();
    const result = await tracePiApiFirstTurn({
      enabled: true,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      userId: "user-1",
      prompt: "complete before active input",
      model: "model-1",
      provider: "provider-1",
      execute() {
        return Promise.resolve(turnResult(false));
      },
    });

    const transfer = startPiLangfuseOwnershipTransfer(result.traceContext);
    expect(transfer).toBeDefined();
    transfer?.end();
    result.traceContext?.end();
    await provider.forceFlush();

    expect(
      exporter.getFinishedSpans().find((span) => {
        return span.name === "Ownership Transfer";
      })?.parentSpanContext?.spanId,
    ).toBe(result.traceContext?.rootSpanContext.spanId);
  });
});

describe("Pi API-first Langfuse failure isolation", () => {
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

  it("does not create observations when the run gate is off", async () => {
    const { exporter, provider } = installMemoryExporter();
    const expected = turnResult(false);
    const result = await tracePiApiFirstTurn({
      enabled: false,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      userId: "user-1",
      prompt: "no trace",
      model: "model-1",
      provider: "provider-1",
      execute() {
        return Promise.resolve(expected);
      },
    });
    await provider.forceFlush();

    expect(result).toStrictEqual({ result: expected });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("preserves provider exceptions while closing debug observations", async () => {
    const { exporter, provider } = installMemoryExporter();
    const failure = new TypeError("provider failed");

    await expect(
      tracePiApiFirstTurn({
        enabled: true,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        userId: "user-1",
        prompt: "fail",
        model: "model-1",
        provider: "provider-1",
        execute() {
          return Promise.reject(failure);
        },
      }),
    ).rejects.toBe(failure);
    await provider.forceFlush();

    expect(
      exporter
        .getFinishedSpans()
        .map((span) => {
          return span.name;
        })
        .sort(),
    ).toStrictEqual(["API First Turn", "API LLM Call"]);
  });
});
