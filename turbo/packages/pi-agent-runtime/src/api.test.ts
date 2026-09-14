import { zstdDecompressSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";

import { piModelConfigSchema } from "@okouai/api-contracts/contracts/runners";
import {
  PI_MEMORY_CITATION_OPEN,
  PI_MEMORY_CITATION_CLOSE,
} from "@okouai/api-contracts/contracts/pi-memory-citations";
import { materializePiAgentModelConfig } from "./credential";
import {
  fauxAssistantMessage,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  AgentSession,
  CURRENT_SESSION_VERSION,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  createPiApiFirstTurnOwnership,
  createPiSessionJsonl,
  inspectPiSessionJsonl,
  projectPiSessionJsonlForExport,
  PiApiFirstTurnCompactionRequiredError,
  runPiApiFirstTurn,
  preparePiApiTurn,
  executePreparedPiApiTurn,
  UnsupportedPiSessionVersionError,
} from "./api";
import { projectPiApiAssistantMessage } from "./api-turn";
import { resolvePiAgentModel } from "./model";
import { MemoryPiSession } from "./session-memory";
import type { PiApiAssistantMessage, PiApiFirstTurnArgs } from "./api-types";

function promiseWithResolvers<T>() {
  return (
    Promise as PromiseConstructor & {
      withResolvers<TValue>(): {
        readonly promise: Promise<TValue>;
        readonly resolve: (value: TValue) => void;
      };
    }
  ).withResolvers<T>();
}

const publicEventFixture = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/pi-public-events.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly cases: readonly {
    readonly name: string;
    readonly guestMessage: AssistantMessage;
    readonly apiAssistant: PiApiAssistantMessage;
  }[];
};

describe("Pi API input normalization fixtures", () => {
  it.each(publicEventFixture.cases)(
    "normalizes $name before API event projection",
    (example) => {
      expect(projectPiApiAssistantMessage(example.guestMessage)).toEqual(
        example.apiAssistant,
      );
    },
  );
});

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const SESSION_TIMESTAMP = "2026-08-31T12:34:56.000Z";

function responsesTextSse(
  response: ServerResponse,
  text: string,
  options?: {
    readonly fragmentTerminal?: boolean;
    readonly serviceTier?: string | null;
  },
): void {
  const responseId = "resp_terra_api_first";
  const messageId = "msg_terra_api_first";
  const events = [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: messageId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        ...(options && "serviceTier" in options
          ? { service_tier: options.serviceTier }
          : {}),
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  const body = events
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
  if (!options?.fragmentTerminal) {
    response.end(body);
    return;
  }
  const splitAt = body.lastIndexOf("service_tier") + 5;
  response.write(body.slice(0, splitAt));
  setImmediate(() => {
    response.end(body.slice(splitAt));
  });
}

function responsesToolSse(
  response: ServerResponse,
  args: {
    readonly callId: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  },
): void {
  const responseId = "resp_pi_memory_tool";
  const itemId = "fc_pi_memory_tool";
  const functionArguments = JSON.stringify(args.arguments);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: args.callId,
    name: args.name,
    arguments: functionArguments,
    status: "completed",
  };
  const events = [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: itemId,
      delta: functionArguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: itemId,
      arguments: functionArguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events
      .map((event) => {
        return `data: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
  );
}

describe("Pi API facade", () => {
  it.each(["execute", "discard", "cancel", "late-initialization"] as const)(
    "owns a prepared session through %s without speculative provider transport",
    async (outcome) => {
      let providerRequests = 0;
      const server = createServer((_request, response) => {
        providerRequests++;
        responsesTextSse(response, "prepared answer");
      });
      await new Promise<void>((resolve) => {
        return server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected test transport");
      const disposed = vi.spyOn(AgentSession.prototype, "dispose");
      const controller = new AbortController();
      const args = {
        cwd: "/home/user/workspace",
        agentDir: "/home/user/.pi/agent",
        sessionId: SESSION_ID,
        prompt: "use exactly the captured input",
        appendSystemPrompt: "Captured final instruction",
        model: {
          provider: "openai",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-key",
          model: "gpt-5.6-terra",
          dialect: "openai-responses",
          transport: "sse",
          thinkingLevel: "low",
        },
        resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
        onPreparationTiming(observation: { readonly phase: string }) {
          // The official initializer is already running and does not stop at
          // this abort. Preparation must dispose its eventual session.
          if (
            outcome === "late-initialization" &&
            observation.phase === "model_runtime"
          ) {
            controller.abort(new Error("abandoned initializer"));
          }
        },
      } as const;
      try {
        if (outcome === "late-initialization") {
          await expect(
            preparePiApiTurn(args, controller.signal),
          ).rejects.toThrow("abandoned initializer");
        } else {
          const prepared = await preparePiApiTurn(args, controller.signal);
          expect(providerRequests).toBe(0);
          const ownership = createPiApiFirstTurnOwnership();
          if (outcome === "discard") {
            prepared.dispose();
            prepared.dispose();
          } else if (outcome === "cancel") {
            controller.abort(new Error("cancel before transport"));
            await expect(
              executePreparedPiApiTurn(
                prepared,
                { ownership },
                controller.signal,
              ),
            ).rejects.toThrow("cancel before transport");
          } else {
            const gate = promiseWithResolvers<void>();
            const entered = promiseWithResolvers<void>();
            const execution = executePreparedPiApiTurn(
              prepared,
              {
                ownership,
                async providerRequestBoundary(mark) {
                  entered.resolve();
                  await gate.promise;
                  mark();
                },
              },
              controller.signal,
            );
            await entered.promise;
            expect(providerRequests).toBe(0);
            expect(ownership.stage).toBe("pre-provider");
            gate.resolve();
            const result = await execution;
            expect(result.assistantMessage.content).toEqual([
              { type: "text", text: "prepared answer" },
            ]);
          }
          await expect(
            executePreparedPiApiTurn(prepared, { ownership }),
          ).rejects.toThrow("already been consumed or disposed");
          prepared.dispose();
        }
        expect(providerRequests).toBe(outcome === "execute" ? 1 : 0);
        expect(disposed).toHaveBeenCalledTimes(1);
      } finally {
        disposed.mockRestore();
        controller.abort();
        await new Promise<void>((resolve, reject) => {
          return server.close((error) => {
            return error ? reject(error) : resolve();
          });
        });
      }
    },
  );

  it("sends stable memory schemas and hands a call off without API execution", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        requestBodies.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >,
        );
        responsesToolSse(response, {
          callId: "memory-call-1",
          name: "add_ad_hoc_note",
          arguments: {
            filename: "2026-09-05T16-05-00-api-handoff.md",
            note: "API-first must hand this write to the sandbox.",
          },
        });
      })().catch((error: unknown) => {
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Memory tool test server has no TCP address");
    }

    try {
      const result = await runPiApiFirstTurn({
        cwd: "/home/user/workspace",
        agentDir: "/home/user/.pi/agent",
        sessionId: SESSION_ID,
        prompt: "remember this through the sandbox",
        appendSystemPrompt: null,
        model: {
          provider: "openai",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-key",
          model: "gpt-5.6-terra",
          dialect: "openai-responses",
          transport: "sse",
          thinkingLevel: "low",
        },
        resourceSnapshot: {
          schemaVersion: 2,
          agentsFiles: [],
          skills: [],
          memoryRecall: {
            status: "no-content",
            memoryStorageId: "memory-storage-a",
            storageVersionId: "memory-version-a",
          },
        },
        ownership: createPiApiFirstTurnOwnership(),
      });

      const requestTools = requestBodies[0]?.tools;
      expect(Array.isArray(requestTools)).toBe(true);
      expect(
        (requestTools as Array<{ name?: string }>)
          .map((tool) => {
            return tool.name;
          })
          .filter((name) => {
            return name?.startsWith("memories_") || name === "add_ad_hoc_note";
          }),
      ).toStrictEqual([
        "memories_list",
        "memories_search",
        "memories_read",
        "add_ad_hoc_note",
      ]);
      expect(
        (
          requestTools as Array<{
            name?: string;
            parameters?: unknown;
          }>
        ).find((tool) => {
          return tool.name === "add_ad_hoc_note";
        }),
      ).toMatchObject({
        parameters: {
          additionalProperties: false,
          properties: {
            filename: {
              maxLength: 128,
              minLength: 24,
              pattern:
                "^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-[a-z0-9][a-z0-9-]{0,79}\\.md$",
              type: "string",
            },
            note: { maxLength: 65_536, minLength: 1, type: "string" },
          },
          required: ["filename", "note"],
          type: "object",
        },
      });
      expect(result.handoffRequired).toBe(true);
      expect(result.assistantMessage.content).toStrictEqual([
        {
          type: "toolCall",
          id: "memory-call-1|fc_pi_memory_tool",
          name: "add_ad_hoc_note",
          arguments: {
            filename: "2026-09-05T16-05-00-api-handoff.md",
            note: "API-first must hand this write to the sandbox.",
          },
        },
      ]);
      expect(inspectPiSessionJsonl(result.sessionJsonl)).toMatchObject({
        hasPendingToolCalls: true,
        isSettledCheckpoint: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("keeps provider request ownership monotonic", () => {
    const ownership = createPiApiFirstTurnOwnership();

    expect(ownership.stage).toBe("pre-provider");
    ownership.markProviderRequestMayHaveStarted();
    expect(ownership.stage).toBe("provider-may-have-started");
    ownership.markProviderRequestMayHaveStarted();
    expect(ownership.stage).toBe("provider-may-have-started");
  });

  it("creates one canonical empty native Pi history", () => {
    const jsonl = createPiSessionJsonl({
      cwd: "/home/user/workspace",
      sessionId: SESSION_ID,
      timestamp: SESSION_TIMESTAMP,
    });

    expect(inspectPiSessionJsonl(jsonl)).toStrictEqual({
      sessionId: SESSION_ID,
      messageCount: 0,
      hasPendingToolCalls: false,
      isSettledCheckpoint: false,
    });
    expect(JSON.parse(jsonl.split("\n")[0] ?? "{}")).toMatchObject({
      id: SESSION_ID,
      timestamp: SESSION_TIMESTAMP,
    });
  });

  it.each(["public", "native"] as const)(
    "applies %s Terra API-first request policy",
    async (route) => {
      const providerRequests: Array<{
        readonly url: string | undefined;
        readonly body: unknown;
        readonly accountId: string | string[] | undefined;
        readonly authorization: string | undefined;
      }> = [];
      const server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          providerRequests.push({
            url: request.url,
            accountId: request.headers["chatgpt-account-id"],
            authorization: request.headers.authorization,
            body: JSON.parse(
              (request.headers["content-encoding"] === "zstd"
                ? zstdDecompressSync(Buffer.concat(chunks))
                : Buffer.concat(chunks)
              ).toString("utf8"),
            ) as unknown,
          });
          responsesTextSse(response, "Terra API-first answer");
        })().catch((error: unknown) => {
          response.destroy(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Terra API-first test server has no TCP address");
      }

      try {
        let sessionJsonl: string | undefined;
        const runTurn = async (
          serviceTier: "priority" | "fast" | undefined,
          api:
            | "openai-completions"
            | "openai-codex-responses"
            | "openai-responses"
            | undefined,
          thinkingLevel: "low" | "high" = "low",
        ) => {
          const result = await runPiApiFirstTurn({
            cwd: "/home/user/workspace",
            agentDir: "/home/user/.pi/agent",
            sessionId: SESSION_ID,
            sessionJsonl,
            prompt: "answer through Terra",
            appendSystemPrompt: null,
            model:
              route === "native"
                ? await materializePiAgentModelConfig({
                    config: piModelConfigSchema.parse({
                      schemaVersion: serviceTier === undefined ? 2 : 3,
                      dialect: "openai-codex-responses",
                      transport: "sse",
                      provider: "openai-codex",
                      baseUrl: `http://127.0.0.1:${address.port}/v1`,
                      model: "gpt-5.6-terra",
                      thinkingLevel,
                      ...(serviceTier === undefined ? {} : { serviceTier }),
                      credentialBindings: [
                        {
                          kind: "access-token",
                          environment: "CHATGPT_ACCESS_TOKEN",
                          secretName: "CHATGPT_ACCESS_TOKEN",
                        },
                        {
                          kind: "account-id",
                          environment: "CHATGPT_ACCOUNT_ID",
                          secretName: "CHATGPT_ACCOUNT_ID",
                        },
                      ],
                    }),
                    target: "direct",
                    resolveCredential(binding) {
                      return binding.kind === "account-id"
                        ? "exact-account-id"
                        : "opaque-access-token";
                    },
                  })
                : await materializePiAgentModelConfig({
                    config: piModelConfigSchema.parse({
                      provider: "openai",
                      baseUrl: `http://127.0.0.1:${address.port}/v1`,
                      model: "gpt-5.6-terra",
                      ...(api === undefined ? {} : { api }),
                      apiKeyEnv: "OPENAI_API_KEY",
                      credentialSecretName: "OPENAI_API_KEY",
                      thinkingLevel,
                      ...(serviceTier ? { serviceTier } : {}),
                    }),
                    target: "direct",
                    resolveCredential: () => {
                      return "test-key";
                    },
                  }),
            resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
            ownership: createPiApiFirstTurnOwnership(),
          });
          sessionJsonl = result.sessionJsonl;
          return result;
        };
        const standardResult = await runTurn(undefined, "openai-completions");
        const priorityResult = await runTurn(
          route === "native" ? "fast" : "priority",
          "openai-codex-responses",
          "high",
        );
        const standardReturnResult = await runTurn(undefined, undefined);
        const publicResult = await runTurn(undefined, "openai-responses");

        expect(providerRequests).toHaveLength(4);
        if (route === "native") {
          expect(
            providerRequests.map((request) => {
              return request.accountId;
            }),
          ).toEqual([
            "exact-account-id",
            "exact-account-id",
            "exact-account-id",
            "exact-account-id",
          ]);
          for (const request of providerRequests) {
            expect(request.authorization).toBe("Bearer opaque-access-token");
            expect(request.body).toMatchObject({ store: false, stream: true });
            expect(request.body).not.toHaveProperty("previous_response_id");
          }
        }
        expect(providerRequests[0]).toMatchObject({
          url: route === "native" ? "/v1/codex/responses" : "/v1/responses",
          body: {
            model: "gpt-5.6-terra",
            reasoning: { effort: "low" },
          },
        });
        expect(providerRequests[0]?.body).not.toHaveProperty("service_tier");
        expect(providerRequests[1]).toMatchObject({
          url: route === "native" ? "/v1/codex/responses" : "/v1/responses",
          body: {
            model: "gpt-5.6-terra",
            reasoning: { effort: "high" },
            service_tier: "priority",
          },
        });
        expect(providerRequests[2]?.body).not.toHaveProperty("service_tier");
        expect(providerRequests[3]?.body).not.toHaveProperty("service_tier");
        expect(publicResult.assistantMessage.content).toStrictEqual([
          { type: "text", text: "Terra API-first answer" },
        ]);
        expect(
          inspectPiSessionJsonl(standardReturnResult.sessionJsonl),
        ).toMatchObject({
          sessionId: SESSION_ID,
          messageCount: 6,
        });
        expect(standardResult.assistantMessage.content).toStrictEqual([
          { type: "text", text: "Terra API-first answer" },
        ]);
        expect(priorityResult.assistantMessage.content).toStrictEqual([
          { type: "text", text: "Terra API-first answer" },
        ]);
        expect(standardResult.observedServiceTier).toBeUndefined();
        expect(priorityResult.observedServiceTier).toBeUndefined();
        expect(standardReturnResult.sessionJsonl).not.toMatch(
          /serviceTier|service_tier|exact-account-id|opaque-access-token|test-key/,
        );
        expect(
          MemoryPiSession.fromJsonl(
            priorityResult.sessionJsonl,
          ).buildSessionContext().thinkingLevel,
        ).toBe("high");
        expect(providerRequests[2]?.body).toMatchObject({
          reasoning: { effort: "low" },
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    },
  );

  it.each(["absent", "throwing"] as const)(
    "preserves DeepSeek transport and pre-provider cancellation with a %s preparation observer",
    async (observer) => {
      const providerRequests: Array<{
        readonly url: string | undefined;
        readonly body: Record<string, unknown>;
        readonly userAgent: string | undefined;
      }> = [];
      const server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          providerRequests.push({
            url: request.url,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >,
            userAgent: request.headers["user-agent"],
          });
          responsesTextSse(response, "DeepSeek API-first answer");
        })().catch((error: unknown) => {
          response.destroy(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("DeepSeek API-first test server has no TCP address");
      }

      try {
        const args: PiApiFirstTurnArgs = {
          cwd: "/home/user/workspace",
          agentDir: "/home/user/.pi/agent",
          sessionId: SESSION_ID,
          prompt: "answer through direct DeepSeek",
          appendSystemPrompt: null,
          model: {
            provider: "deepseek",
            baseUrl: `http://127.0.0.1:${address.port}`,
            apiKey: "test-key",
            model: "deepseek-v4-flash",
            dialect: "openai-responses",
            transport: "sse",
          },
          resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
          ownership: createPiApiFirstTurnOwnership(),
          onPreparationTiming:
            observer === "throwing"
              ? () => {
                  throw new Error("telemetry unavailable");
                }
              : undefined,
        };
        const result = await runPiApiFirstTurn(args);

        expect(providerRequests).toHaveLength(1);
        expect(providerRequests[0]).toMatchObject({
          url: "/responses",
          userAgent: "okou-pi-agent/1.0",
          body: {
            model: "deepseek-v4-flash",
            stream: true,
            store: false,
          },
        });
        expect(providerRequests[0]?.body).not.toHaveProperty("service_tier");
        expect(providerRequests[0]?.body).not.toHaveProperty("temperature");
        expect(providerRequests[0]?.body).not.toHaveProperty("top_p");
        expect(result.assistantMessage.content).toStrictEqual([
          { type: "text", text: "DeepSeek API-first answer" },
        ]);
        const cancellation = new AbortController();
        const reason = new DOMException("request cancelled", "AbortError");
        await expect(
          runPiApiFirstTurn(
            {
              ...args,
              ownership: createPiApiFirstTurnOwnership(),
              providerRequestBoundary: async () => {
                cancellation.abort(reason);
                cancellation.signal.throwIfAborted();
              },
            },
            cancellation.signal,
          ),
        ).rejects.toBe(reason);
        expect(providerRequests).toHaveLength(1);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    },
  );

  it("captures fragmented terminal OpenRouter tiers without persisting them", async () => {
    const observedTiers = [
      "priority",
      "fast",
      "default",
      "flex",
      null,
      undefined,
      "future-tier",
    ] as const;
    const requestBodies: unknown[] = [];
    let responseIndex = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        requestBodies.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        );
        const serviceTier = observedTiers[responseIndex];
        responseIndex += 1;
        responsesTextSse(response, "OpenRouter answer", {
          fragmentTerminal: true,
          ...(serviceTier === undefined ? {} : { serviceTier }),
        });
      })().catch((error: unknown) => {
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("OpenRouter tier test server has no TCP address");
    }

    try {
      const results = [];
      for (const _serviceTier of observedTiers) {
        results.push(
          await runPiApiFirstTurn({
            cwd: "/home/user/workspace",
            agentDir: "/home/user/.pi/agent",
            sessionId: SESSION_ID,
            prompt: "observe the terminal tier",
            appendSystemPrompt: null,
            model: {
              provider: "openrouter",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "test-key",
              model: "openai/gpt-5.6-terra",
              dialect: "openai-responses",
              transport: "sse",
              thinkingLevel: "low",
              serviceTier: "priority",
            },
            resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
            ownership: createPiApiFirstTurnOwnership(),
          }),
        );
      }

      expect(requestBodies).toHaveLength(observedTiers.length);
      for (const body of requestBodies) {
        expect(body).toMatchObject({
          model: "openai/gpt-5.6-terra",
          service_tier: "priority",
          store: false,
        });
      }
      expect(
        results.map((result) => {
          return result.observedServiceTier;
        }),
      ).toStrictEqual(observedTiers);
      for (const result of results) {
        expect(result.sessionJsonl).not.toContain("serviceTier");
        expect(result.sessionJsonl).not.toContain("service_tier");
        expect(result.sessionJsonl).not.toContain("observedServiceTier");
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("resumes pre-migration OpenRouter Chat JSONL through full-context Responses", async () => {
    const providerRequests: Array<{
      readonly url: string | undefined;
      readonly body: unknown;
    }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        providerRequests.push({
          url: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
        responsesTextSse(response, "post-migration answer", {
          serviceTier: "default",
        });
      })().catch((error: unknown) => {
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("OpenRouter migration test server has no TCP address");
    }
    const legacy = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    legacy.appendMessage({
      role: "user",
      content: "legacy user context",
      timestamp: 1,
    });
    legacy.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "legacy reasoning context" },
        { type: "text", text: "legacy answer context" },
        {
          type: "toolCall",
          id: "legacy_tool_call",
          name: "read",
          arguments: { path: "/home/user/workspace/AGENTS.md" },
        },
      ],
      api: "openai-completions",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      usage: {
        input: 4,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 7,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: 2,
    });
    legacy.appendMessage({
      role: "toolResult",
      toolCallId: "legacy_tool_call",
      toolName: "read",
      content: [{ type: "text", text: "legacy tool output" }],
      isError: false,
      timestamp: 3,
    });
    legacy.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "legacy tool conclusion" }],
      api: "openai-completions",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      usage: {
        input: 2,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 4,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 4,
    });

    try {
      const result = await runPiApiFirstTurn({
        cwd: "/home/user/workspace",
        agentDir: "/home/user/.pi/agent",
        sessionId: SESSION_ID,
        sessionJsonl: legacy.toJsonl(),
        prompt: "post-migration prompt",
        appendSystemPrompt: null,
        model: {
          provider: "openrouter",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-key",
          model: "openai/gpt-5.6-terra",
          dialect: "openai-responses",
          transport: "sse",
          thinkingLevel: "low",
        },
        resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
        ownership: createPiApiFirstTurnOwnership(),
      });

      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]?.url).toBe("/v1/responses");
      expect(providerRequests[0]?.body).toMatchObject({ store: false });
      expect(providerRequests[0]?.body).not.toHaveProperty(
        "previous_response_id",
      );
      const requestJson = JSON.stringify(providerRequests[0]?.body);
      for (const marker of [
        "legacy user context",
        "legacy reasoning context",
        "legacy answer context",
        "legacy tool output",
        "legacy tool conclusion",
        "post-migration prompt",
      ]) {
        expect(requestJson.split(marker)).toHaveLength(2);
      }
      expect(result.observedServiceTier).toBe("default");
      expect(result.assistantMessage.content).toStrictEqual([
        { type: "text", text: "post-migration answer" },
      ]);
      expect(inspectPiSessionJsonl(result.sessionJsonl)).toMatchObject({
        messageCount: 6,
        hasPendingToolCalls: false,
        isSettledCheckpoint: true,
      });
      for (const marker of [
        "legacy reasoning context",
        "legacy tool output",
        "post-migration prompt",
        "post-migration answer",
      ]) {
        expect(result.sessionJsonl.split(marker)).toHaveLength(2);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("runs threshold-safe H0 once and blocks above-threshold H0 before transport", async () => {
    let providerRequests = 0;
    const server = createServer((_request, response) => {
      providerRequests += 1;
      responsesTextSse(response, "threshold-safe answer");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Terra threshold test server has no TCP address");
    }
    const resolvedModel = resolvePiAgentModel({
      provider: "openai",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key",
      model: "gpt-5.6-terra",
      dialect: "openai-responses",
      transport: "sse",
    });
    if (!resolvedModel) {
      throw new Error("Expected pinned Pi to catalog Terra");
    }
    const threshold = resolvedModel.contextWindow - 16_384;
    const sessionJsonl = (totalTokens: number): string => {
      const session = MemoryPiSession.create({
        cwd: "/home/user/workspace",
        id: SESSION_ID,
      });
      session.appendMessage({
        role: "user",
        content: "prior prompt",
        timestamp: 1,
      });
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "prior answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-terra",
        usage: {
          input: totalTokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      return session.toJsonl();
    };
    const model = {
      provider: "openai" as const,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key",
      model: "gpt-5.6-terra",
      dialect: "openai-responses" as const,
      transport: "sse" as const,
      thinkingLevel: "low" as const,
    };

    try {
      const safeOwnership = createPiApiFirstTurnOwnership();
      const safe = await runPiApiFirstTurn({
        cwd: "/home/user/workspace",
        agentDir: "/home/user/.pi/agent",
        sessionId: SESSION_ID,
        sessionJsonl: sessionJsonl(threshold),
        prompt: "safe threshold prompt",
        appendSystemPrompt: null,
        model,
        resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
        ownership: safeOwnership,
      });
      expect(providerRequests).toBe(1);
      expect(safeOwnership.stage).toBe("provider-may-have-started");
      expect(safe.sessionJsonl).toContain("safe threshold prompt");

      const blockedOwnership = createPiApiFirstTurnOwnership();
      await expect(
        runPiApiFirstTurn({
          cwd: "/home/user/workspace",
          agentDir: "/home/user/.pi/agent",
          sessionId: SESSION_ID,
          sessionJsonl: sessionJsonl(threshold + 1),
          prompt: "must remain sandbox-owned",
          appendSystemPrompt: null,
          model,
          resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
          ownership: blockedOwnership,
          onPreparationTiming() {
            throw new Error("telemetry unavailable");
          },
        }),
      ).rejects.toThrow(PiApiFirstTurnCompactionRequiredError);
      expect(providerRequests).toBe(1);
      expect(blockedOwnership.stage).toBe("pre-provider");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("projects only API-consumed assistant fields", () => {
    const nativeMessage: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "before tools" },
        { type: "thinking", thinking: "private reasoning" },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "/workspace/AGENTS.md" },
        },
      ],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      responseId: "response-1",
      errorMessage: "native-only diagnostic",
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        reasoning: 5,
        totalTokens: 18,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.03,
          cacheWrite: 0.02,
          total: 0.35,
        },
      },
      stopReason: "toolUse",
      timestamp: 123,
    };

    expect(projectPiApiAssistantMessage(nativeMessage)).toStrictEqual({
      content: [
        { type: "text", text: "before tools" },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "/workspace/AGENTS.md" },
        },
      ],
      model: "deepseek-v4-flash",
      responseId: "response-1",
      stopReason: "toolUse",
      timestamp: 123,
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
      },
    });
  });

  it("hides citation envelopes while preserving structured provenance and canonical JSONL", () => {
    const hidden =
      "<oai-mem-citation><citation_entries>memory.md:2-3|note=[used]</citation_entries><rollout_ids>019c6e27-e55b-73d1-87d8-4e01f1f75043</rollout_ids></oai-mem-citation>";
    const nativeMessage: AssistantMessage = {
      ...fauxAssistantMessage(
        [
          { type: "text", text: `before${hidden.slice(0, 10)}` },
          { type: "text", text: `${hidden.slice(10)}after` },
        ],
        { timestamp: 123 },
      ),
      errorMessage: `provider failed${hidden}`,
    };
    const nativeBefore = JSON.stringify(nativeMessage);
    const projected = projectPiApiAssistantMessage(nativeMessage);
    expect(projected.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ]);
    expect(projected.memoryCitation).toEqual({
      entries: [{ path: "memory.md", lineStart: 2, lineEnd: 3, note: "used" }],
      rolloutIds: ["019c6e27-e55b-73d1-87d8-4e01f1f75043"],
    });
    expect(JSON.stringify(nativeMessage)).toBe(nativeBefore);

    const session = MemoryPiSession.create({
      cwd: "/workspace",
      id: SESSION_ID,
    });
    session.appendMessage(nativeMessage);
    const canonical = session.toJsonl();
    expect(canonical).toContain(hidden.slice(0, 10));
    expect(canonical).toContain(hidden.slice(10));
    const exported = projectPiSessionJsonlForExport(canonical);
    expect(exported).not.toContain("<oai-mem-citation>");
    expect(exported).toContain('"errorMessage":"provider failed"');
    expect(session.toJsonl()).toBe(canonical);
  });

  it("preserves split delimiter examples through API-first and immutable session export", () => {
    const literal = `explain \`${PI_MEMORY_CITATION_OPEN}\` suffix`;
    const hidden = `${PI_MEMORY_CITATION_OPEN}<citation_entries>private.md:1-1|note=[private note]</citation_entries>${PI_MEMORY_CITATION_CLOSE}`;
    const expected = `explain \`&lt;${PI_MEMORY_CITATION_OPEN.slice(1, -1)}&gt;\` suffix`;
    const native = fauxAssistantMessage([
      { type: "text", text: literal.slice(0, 14) },
      { type: "text", text: literal.slice(14) + hidden },
    ]);
    const projected = projectPiApiAssistantMessage(native);
    expect(
      projected.content
        .filter((block) => {
          return block.type === "text";
        })
        .map((block) => {
          return block.text;
        })
        .join(""),
    ).toBe(expected);
    expect(projected.memoryCitation?.entries).toEqual([
      { path: "private.md", lineStart: 1, lineEnd: 1, note: "private note" },
    ]);
    const session = MemoryPiSession.create({
      cwd: "/workspace",
      id: SESSION_ID,
    });
    session.appendMessage(native);
    const canonical = session.toJsonl();
    const exported = projectPiSessionJsonlForExport(canonical);
    const exportedText = MemoryPiSession.fromJsonl(exported)
      .buildSessionContext()
      .messages.flatMap((message) => {
        return message.role === "assistant"
          ? message.content
              .filter((block) => {
                return block.type === "text";
              })
              .map((block) => {
                return block.text;
              })
          : [];
      })
      .join("");
    expect(exportedText).toBe(expected);
    expect(exported).not.toContain("private.md");
    expect(exported).not.toContain("private note");
    expect(projectPiSessionJsonlForExport(exported)).toBe(exported);
    expect(session.toJsonl()).toBe(canonical);
  });

  it("projects only a content-free usage-limit classification", () => {
    const nativeMessage: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-terra",
      errorMessage:
        "You've hit your usage limit; private upstream response omitted",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "error",
      timestamp: 456,
    };

    expect(projectPiApiAssistantMessage(nativeMessage)).toMatchObject({
      stopReason: "error",
      failureReason: "usage_limit",
    });
    expect(projectPiApiAssistantMessage(nativeMessage)).not.toHaveProperty(
      "errorMessage",
    );
    expect(
      projectPiApiAssistantMessage({
        ...nativeMessage,
        api: "openai-responses",
        provider: "deepseek",
      }),
    ).not.toHaveProperty("failureReason");
  });

  it("projects native session state into a narrow inspection result", () => {
    const session = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "complete" }],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 1,
    });

    expect(inspectPiSessionJsonl(session.toJsonl())).toStrictEqual({
      sessionId: SESSION_ID,
      messageCount: 1,
      hasPendingToolCalls: false,
      isSettledCheckpoint: true,
    });
  });

  it("preserves the clean entrypoint's unsupported-version error identity", () => {
    const jsonl = `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION + 1,
      id: SESSION_ID,
      timestamp: new Date(0).toISOString(),
      cwd: "/home/user/workspace",
    })}\n`;

    expect(() => {
      inspectPiSessionJsonl(jsonl);
    }).toThrow(UnsupportedPiSessionVersionError);
  });
});
