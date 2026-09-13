import type { PiApiFirstTurnResult } from "@okouai/pi-agent-runtime/api";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
} from "@langfuse/tracing";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import {
  normalizePiLangfuseTraceId,
  PI_LANGFUSE_API_OBSERVATION_NAMES,
  startPiLangfuseOwnershipTransfer,
  tracePiApiFirstTurn,
} from "./pi-langfuse-tracing";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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
  readonly exporter: InMemorySpanExporter;
  readonly provider: BasicTracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
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
  return { exporter, provider };
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

  it("creates API, generation, and real ownership-transfer observations", async () => {
    const { exporter, provider } = installMemoryExporter();
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
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => {
      return span.name === "API First Turn";
    });
    const generation = spans.find((span) => {
      return span.name === "API LLM Call";
    });
    const ownership = spans.find((span) => {
      return span.name === "Ownership Transfer";
    });
    expect(root).toBeDefined();
    expect(generation).toBeDefined();
    expect(ownership).toBeDefined();
    if (!root || !generation || !ownership) {
      throw new Error("Expected a complete API-first transfer trace");
    }

    const traceId = normalizePiLangfuseTraceId(RUN_ID);
    expect(root.spanContext().traceId).toBe(traceId);
    expect(generation.spanContext().traceId).toBe(traceId);
    expect(ownership.spanContext().traceId).toBe(traceId);
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
    expect(generation.attributes).not.toHaveProperty(
      "langfuse.observation.input",
    );
    expect(generation.attributes).not.toHaveProperty(
      "langfuse.observation.output",
    );
  });

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
