import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  piModelConfigV4Schema,
  piNativeInferenceUrl,
} from "@okouai/api-contracts/contracts/pi-native";
import fixtures from "../../api-contracts/src/contracts/__tests__/fixtures/pi-native.json";

import {
  createPiApiFirstTurnOwnership,
  runPiApiFirstTurn,
  PiApiModelRequestError,
} from "./api";
import { materializePiAgentModelConfig } from "./credential";
import type { PiAgentModelConfig } from "./types";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const resourceSnapshot = {
  schemaVersion: 1 as const,
  agentsFiles: [],
  skills: [],
};

function model(codex = false): PiAgentModelConfig {
  const common = {
    transport: "sse" as const,
    model: "gpt-5.6-terra",
    thinkingLevel: "low" as const,
    baseUrl: "https://usage-provider.example/v1",
    apiKey: "usage-test-key",
  };
  return codex
    ? {
        ...common,
        provider: "openai-codex",
        dialect: "openai-codex-responses",
        accountId: "usage-test-account",
      }
    : { ...common, provider: "openai", dialect: "openai-responses" };
}

function run(modelConfig = model(), signal?: AbortSignal) {
  return runPiApiFirstTurn(
    {
      cwd: "/home/user/workspace",
      agentDir: "/home/user/workspace/pi-usage-test",
      sessionId: randomUUID(),
      prompt: "Answer briefly",
      appendSystemPrompt: null,
      model: modelConfig,
      resourceSnapshot,
      ownership: createPiApiFirstTurnOwnership(),
    },
    signal,
  );
}

function sse(events: readonly unknown[]): string {
  return events
    .map((event) => {
      const type =
        typeof event === "object" && event !== null && "type" in event
          ? event.type
          : undefined;
      return `event: ${String(type)}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
    })
    .join("");
}

function responseEvents(
  usage: unknown,
  terminal = "response.completed",
): unknown[] {
  const item = {
    type: "message",
    id: "msg_usage",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Answer", annotations: [] }],
  };
  return [
    {
      type: "response.created",
      response: { id: "resp_usage", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Answer",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: terminal,
      response: {
        id: "resp_usage",
        status: "completed",
        output: [item],
        usage,
      },
    },
  ];
}

function serveSse(body: string, fragment = false): void {
  server.use(
    http.post("https://usage-provider.example/*", () => {
      const bytes = new TextEncoder().encode(body);
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const end = fragment
            ? Math.min(offset + 7, bytes.length)
            : bytes.length;
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      });
      return new HttpResponse(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
}

const reportedUsage = {
  input_tokens: 50,
  input_tokens_details: { cached_tokens: 10, cache_write_tokens: 15 },
  output_tokens: 20,
  total_tokens: 70,
};
const reportedTokens = {
  input: 25,
  cacheRead: 10,
  cacheCreation: 15,
  output: 20,
};

describe("API provider usage evidence", () => {
  it.each([false, true])(
    "normalizes and replaces fragmented Responses usage (Codex %s)",
    async (codex) => {
      const terminal = codex ? "response.done" : "response.completed";
      const body = sse([
        {
          type: "response.in_progress",
          response: { id: "resp_usage", usage: reportedUsage },
        },
        ...responseEvents(reportedUsage, terminal),
        ...responseEvents(reportedUsage, terminal).slice(-1),
      ]);
      // The pinned Codex adapter consumes LF-delimited provider events.
      serveSse(codex ? body.replaceAll("\r\n", "\n") : body, true);
      const result = await run(model(codex));
      expect(result.assistantMessage).toMatchObject({ stopReason: "stop" });
      expect(result.usageObservation).toEqual({
        coverage: "complete",
        tokens: reportedTokens,
      });
      expect(result.assistantMessage.usage).toMatchObject({
        input: 25,
        cacheRead: 10,
        cacheWrite: 15,
        output: 20,
      });
      expect(result.assistantMessage.content).toEqual([
        { type: "text", text: "Answer" },
      ]);
      expect(result.sessionJsonl).not.toContain("usageObservation");
    },
  );

  it("distinguishes reported zero from absent usage across separate invocations", async () => {
    serveSse(sse(responseEvents({ input_tokens: 0, output_tokens: 0 })));
    const zero = await run();
    expect(zero.usageObservation).toEqual({
      coverage: "complete",
      tokens: { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    serveSse(sse(responseEvents(undefined)));
    const absent = await run();
    expect(absent.assistantMessage.usage.input).toBe(0);
    expect(absent.usageObservation).toEqual({
      coverage: "unavailable",
      tokens: {
        input: null,
        cacheRead: null,
        cacheCreation: null,
        output: null,
      },
    });
  });

  it.each([
    {
      name: "missing cache details",
      usage: { input_tokens: 50, output_tokens: 20 },
      tokens: { input: null, cacheRead: null, cacheCreation: null, output: 20 },
    },
    {
      name: "missing cache creation",
      usage: {
        input_tokens: 50,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens: 20,
      },
      tokens: { input: null, cacheRead: 10, cacheCreation: null, output: 20 },
    },
    {
      name: "overlapping cache partitions",
      usage: { ...reportedUsage, input_tokens: 5 },
      tokens: { input: null, cacheRead: null, cacheCreation: null, output: 20 },
    },
    {
      name: "invalid output",
      usage: { ...reportedUsage, output_tokens: -1 },
      tokens: { ...reportedTokens, output: null },
    },
    {
      name: "unsafe input",
      usage: { ...reportedUsage, input_tokens: Number.MAX_SAFE_INTEGER + 1 },
      tokens: { ...reportedTokens, input: null },
    },
    {
      name: "fractional cache",
      usage: {
        ...reportedUsage,
        input_tokens_details: { cached_tokens: 0.5, cache_write_tokens: 15 },
      },
      tokens: { ...reportedTokens, input: null, cacheRead: null },
    },
  ])("keeps $name explicitly partial", async ({ usage, tokens }) => {
    serveSse(sse(responseEvents(usage)));
    expect((await run()).usageObservation).toEqual({
      coverage: "partial",
      tokens,
    });
  });

  it("forwards an oversized event but reports lost coverage after valid later usage", async () => {
    const oversized = sse([
      { type: "response.unrecognized", padding: "x".repeat(270_000) },
    ]);
    serveSse(oversized + sse(responseEvents(reportedUsage)));
    const result = await run();
    expect(result.assistantMessage.stopReason).toBe("stop");
    expect(result.usageObservation).toEqual({
      coverage: "partial",
      tokens: reportedTokens,
    });
  });

  it("retains known usage when a provider fails after an intermediate observation", async () => {
    serveSse(
      sse([
        {
          type: "response.in_progress",
          response: { id: "resp_usage", usage: reportedUsage },
        },
        { type: "error", code: "server_error", message: "Provider stopped" },
      ]),
    );
    const result = await run();
    expect(result.assistantMessage.stopReason).toBe("error");
    expect(result.usageObservation).toEqual({
      coverage: "partial",
      tokens: reportedTokens,
    });
  });

  it("preserves evidence on a thrown request-boundary error", async () => {
    serveSse(
      sse([
        {
          type: "response.in_progress",
          response: { id: "resp_usage", usage: reportedUsage },
        },
        ...responseEvents(reportedUsage),
      ]),
    );
    const result = runPiApiFirstTurn({
      cwd: "/home/user/workspace",
      agentDir: "/home/user/workspace/pi-usage-test",
      sessionId: randomUUID(),
      prompt: "Answer briefly",
      appendSystemPrompt: null,
      model: model(),
      resourceSnapshot,
      ownership: createPiApiFirstTurnOwnership(),
      textStream: {
        eventIdPrefix: "usage",
        onDelta() {
          throw new Error("Consumer disconnected");
        },
      },
    });
    await expect(result).rejects.toMatchObject({
      name: PiApiModelRequestError.name,
      usageObservation: { coverage: "partial", tokens: reportedTokens },
    });
  });

  it("preserves known quantities when its caller aborts during streamed output", async () => {
    serveSse(
      sse([
        {
          type: "response.in_progress",
          response: { id: "resp_usage", usage: reportedUsage },
        },
        ...responseEvents(reportedUsage),
      ]),
    );
    const controller = new AbortController();
    try {
      const result = await runPiApiFirstTurn(
        {
          cwd: "/home/user/workspace",
          agentDir: "/home/user/workspace/pi-usage-test",
          sessionId: randomUUID(),
          prompt: "Answer briefly",
          appendSystemPrompt: null,
          model: model(),
          resourceSnapshot,
          ownership: createPiApiFirstTurnOwnership(),
          textStream: {
            eventIdPrefix: "usage",
            onDelta() {
              controller.abort();
            },
          },
        },
        controller.signal,
      );
      expect(["error", "aborted"]).toContain(
        result.assistantMessage.stopReason,
      );
      expect(result.usageObservation).toEqual({
        coverage: "partial",
        tokens: reportedTokens,
      });
    } finally {
      controller.abort();
    }
  });

  it("does not mix evidence from different provider response identities", async () => {
    serveSse(
      sse([
        {
          type: "response.in_progress",
          response: { id: "other", usage: reportedUsage },
        },
        ...responseEvents(reportedUsage),
      ]),
    );
    expect((await run()).usageObservation?.coverage).toBe("unavailable");
  });
});

function bedrockFrame(event: string, payload: unknown): Buffer {
  const headers = Buffer.concat(
    Object.entries({
      ":message-type": "event",
      ":event-type": event,
      ":content-type": "application/json",
    }).map(([name, value]) => {
      const size = Buffer.alloc(2);
      size.writeUInt16BE(Buffer.byteLength(value));
      return Buffer.concat([
        Buffer.from([name.length]),
        Buffer.from(name),
        Buffer.from([7]),
        size,
        Buffer.from(value),
      ]);
    }),
  );
  const body = Buffer.from(JSON.stringify(payload));
  const prefix = Buffer.alloc(12);
  prefix.writeUInt32BE(16 + headers.length + body.length);
  prefix.writeUInt32BE(headers.length, 4);
  prefix.writeUInt32BE(crc32(prefix.subarray(0, 8)), 8);
  const data = Buffer.concat([prefix, headers, body]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(data));
  return Buffer.concat([data, checksum]);
}

async function nativeModel(dialect: string) {
  const fixture = fixtures.find(({ config }) => {
    return config.dialect === dialect && config.billingOwner === "user";
  });
  if (!fixture) throw new Error("Missing native fixture");
  const config = piModelConfigV4Schema.parse(fixture.config);
  const materialized = await materializePiAgentModelConfig({
    config,
    target: "direct",
    resolveCredential() {
      return "test-native-key";
    },
  });
  return { config, materialized };
}

describe("native provider usage evidence", () => {
  it.each(["zero", "absent", "partial", "failed"])(
    "observes Messages BYOK %s",
    async (kind) => {
      const { config, materialized } = await nativeModel("anthropic-messages");
      const usage =
        kind === "absent"
          ? undefined
          : {
              input_tokens: kind === "zero" ? 0 : 11,
              cache_read_input_tokens: 0,
              ...(kind === "partial" ? {} : { cache_creation_input_tokens: 0 }),
              output_tokens: 0,
            };
      const events = [
        {
          type: "message_start",
          message: {
            id: "messages_usage",
            type: "message",
            role: "assistant",
            model: config.model,
            content: [],
            usage,
          },
        },
        ...(kind === "failed"
          ? [
              {
                type: "error",
                error: { type: "api_error", message: "Provider stopped" },
              },
            ]
          : [
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: kind === "absent" ? undefined : { output_tokens: 0 },
              },
              { type: "message_stop" },
            ]),
      ];
      server.use(
        http.post(piNativeInferenceUrl(config), () => {
          return new HttpResponse(sse(events), {
            headers: { "content-type": "text/event-stream" },
          });
        }),
      );
      const result = await run(materialized);
      expect(result.usageObservation).toEqual({
        coverage:
          kind === "absent"
            ? "unavailable"
            : kind === "zero"
              ? "complete"
              : "partial",
        tokens:
          kind === "absent"
            ? {
                input: null,
                output: null,
                cacheRead: null,
                cacheCreation: null,
              }
            : {
                input: kind === "zero" ? 0 : 11,
                output: 0,
                cacheRead: 0,
                cacheCreation: kind === "partial" ? null : 0,
              },
      });
    },
  );

  it.each(["zero", "absent", "partial", "bad-crc", "oversized"])(
    "observes fragmented Bedrock BYOK %s",
    async (kind) => {
      const { config, materialized } = await nativeModel(
        "bedrock-converse-stream",
      );
      const metadata = bedrockFrame("metadata", {
        usage: {
          inputTokens: kind === "zero" ? 0 : 11,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          ...(kind === "partial" ? {} : { cacheWriteInputTokens: 0 }),
          ...(kind === "oversized" ? { padding: "x".repeat(270_000) } : {}),
        },
      });
      if (kind === "bad-crc") {
        metadata[metadata.length - 1] =
          metadata.readUInt8(metadata.length - 1) ^ 255;
      }
      const frames = [
        bedrockFrame("messageStart", { role: "assistant" }),
        bedrockFrame("messageStop", { stopReason: "end_turn" }),
        ...(kind === "absent" ? [] : [metadata]),
      ];
      server.use(
        http.post(piNativeInferenceUrl(config), () => {
          const bytes = Buffer.concat(frames);
          let offset = 0;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset === bytes.length) {
                controller.close();
                return;
              }
              const end = Math.min(offset + 7, bytes.length);
              controller.enqueue(bytes.subarray(offset, end));
              offset = end;
            },
          });
          return new HttpResponse(stream, {
            headers: { "content-type": "application/vnd.amazon.eventstream" },
          });
        }),
      );
      const result = await run(materialized);
      expect(result.usageObservation).toEqual({
        coverage:
          kind === "zero"
            ? "complete"
            : kind === "partial"
              ? "partial"
              : "unavailable",
        tokens:
          kind === "zero" || kind === "partial"
            ? {
                input: kind === "zero" ? 0 : 11,
                output: 0,
                cacheRead: 0,
                cacheCreation: kind === "partial" ? null : 0,
              }
            : {
                input: null,
                output: null,
                cacheRead: null,
                cacheCreation: null,
              },
      });
    },
  );
});
