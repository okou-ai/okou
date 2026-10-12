import { PI_MEMORY_STAGE1_RESPONSE_SCHEMA } from "./stage1-provider";
import { redactPiMemoryStage1Secrets } from "./stage1-secrets";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { createServer, type ServerResponse } from "node:http";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  PI_MEMORY_CITATION_OPEN,
  PI_MEMORY_CITATION_CLOSE,
} from "@okouai/api-contracts/contracts/pi-memory-citations";

import {
  projectPiMemoryStage1Evidence as projectEvidence,
  runPiMemoryStage1Extraction,
} from "./stage1-memory";
import { MemoryPiSession } from "./session-memory";
import {
  PI_MEMORY_STAGE1_SYSTEM_PROMPT,
  PI_MEMORY_STAGE1_UPSTREAM_INPUT_TEMPLATE,
} from "./stage1-prompts";

function projectPiMemoryStage1Evidence(
  args: Parameters<typeof projectEvidence>[0],
): string {
  return JSON.stringify(projectEvidence(args));
}

const SESSION_ID = "00000000-0000-4000-8000-000000000123";

function entry(id: string, parentId: string | null, message: unknown): unknown {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-02T00:00:00.000Z",
    message,
  };
}

function branchedJsonl(): string {
  const completedCall = fauxToolCall(
    "read",
    { z: "last", a: "first" },
    { id: "call-completed" },
  );
  const orphanCall = fauxToolCall(
    "bash",
    { command: "ignored" },
    { id: "call-orphan" },
  );
  const memoryCall = fauxToolCall(
    "memories.search",
    { query: "recursive" },
    { id: "call-memory" },
  );
  const assistant = fauxAssistantMessage(
    [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "I inspected the file." },
      completedCall,
      orphanCall,
      memoryCall,
    ],
    { stopReason: "toolUse", timestamp: 4 },
  );
  const rows = [
    {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: SESSION_ID,
      timestamp: "2026-09-02T00:00:00.000Z",
      cwd: "/secret/workspace",
    },
    entry("root", null, {
      role: "user",
      content: "root request",
      timestamp: 1,
    }),
    entry("discarded-user", "root", {
      role: "user",
      content: "discarded branch",
      timestamp: 2,
    }),
    entry(
      "discarded-assistant",
      "discarded-user",
      fauxAssistantMessage("discarded answer", { timestamp: 3 }),
    ),
    entry("active-user", "root", {
      role: "user",
      content: "active request",
      timestamp: 3,
    }),
    entry("assistant-tools", "active-user", assistant),
    entry("tool-completed", "assistant-tools", {
      role: "toolResult",
      toolCallId: "call-completed",
      toolName: "read",
      content: [{ type: "text", text: "useful contents" }],
      isError: false,
      timestamp: 5,
    }),
    entry("tool-memory", "tool-completed", {
      role: "toolResult",
      toolCallId: "call-memory",
      toolName: "memories.search",
      content: [{ type: "text", text: "recalled memory" }],
      isError: false,
      timestamp: 6,
    }),
    entry(
      "final",
      "tool-memory",
      fauxAssistantMessage("finished", { stopReason: "stop", timestamp: 7 }),
    ),
  ];
  return `${rows
    .map((row) => {
      return JSON.stringify(row);
    })
    .join("\n")}\n`;
}

function responsesTextSse(response: ServerResponse, text: string): void {
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp_stage1",
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
        id: "msg_stage1",
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
        id: "msg_stage1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_stage1",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_stage1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          input_tokens_details: { cached_tokens: 2 },
          total_tokens: 18,
        },
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

describe("Pi memory Stage 1 runtime", () => {
  it("pins the attributed Apache-2.0 Codex templates by exact hash", () => {
    expect(
      createHash("sha256").update(PI_MEMORY_STAGE1_SYSTEM_PROMPT).digest("hex"),
    ).toBe("cf795e8a2f5f52d333af2613bf1ff79178112f5fd2161cc181a8ddf52e59da33");
    expect(
      createHash("sha256")
        .update(PI_MEMORY_STAGE1_UPSTREAM_INPUT_TEMPLATE)
        .digest("hex"),
    ).toBe("2e54c74909238022305c269c862910bb29509fda8b58ce671ef011f8d6453047");
  });

  it("projects only the settled official active branch and completed tools", () => {
    const first = projectPiMemoryStage1Evidence({
      jsonl: branchedJsonl(),
      expectedSessionId: SESSION_ID,
    });
    const second = projectPiMemoryStage1Evidence({
      jsonl: branchedJsonl(),
      expectedSessionId: SESSION_ID,
    });

    expect(second).toBe(first);
    expect(first).toContain('"content":"root request"');
    expect(first).toContain('"content":"active request"');
    expect(first).toContain("Tool: read");
    expect(first).toContain('a\\\":\\\"first');
    expect(first).toContain("useful contents");
    expect(first).toContain('"content":"finished"');
    expect(first).not.toContain("discarded");
    expect(first).not.toContain("private reasoning");
    expect(first).not.toContain("call-");
    expect(first).not.toContain("ignored");
    expect(first).not.toContain("memories.search");
    expect(first).not.toContain("recalled memory");
    expect(first).not.toContain("/secret/workspace");
  });

  it("retains completed evidence without promoting a failed assistant leaf", () => {
    const session = MemoryPiSession.fromJsonl(branchedJsonl());
    session.appendMessage(
      fauxAssistantMessage(
        [
          { type: "thinking", thinking: "failed private reasoning" },
          { type: "text", text: "failed partial answer" },
        ],
        { stopReason: "error" },
      ),
    );

    const projected = projectPiMemoryStage1Evidence({
      jsonl: session.toJsonl(),
      expectedSessionId: SESSION_ID,
    });

    expect(projected).toContain('"content":"root request"');
    expect(projected).toContain("Tool: read");
    expect(projected).toContain("useful contents");
    expect(projected).toContain('"content":"finished"');
    expect(projected).not.toContain("failed private reasoning");
    expect(projected).not.toContain("failed partial answer");
  });

  it("removes hidden citations from the active assistant branch", () => {
    const hidden =
      "<oai-mem-citation><citation_entries>memory.md:1-1|note=[private]</citation_entries></oai-mem-citation>";
    const jsonl = branchedJsonl().replace("finished", `visible${hidden}`);
    const projected = projectPiMemoryStage1Evidence({
      jsonl,
      expectedSessionId: SESSION_ID,
    });
    expect(projected).toContain('"content":"visible"');
    expect(projected).not.toContain("oai-mem-citation");
    expect(projected).not.toContain("memory.md");
  });

  it("retains delimiter examples and the following answer in Stage 1 without private provenance", () => {
    const hidden = `${PI_MEMORY_CITATION_OPEN}<citation_entries>private.md:1-1|note=[private note]</citation_entries>${PI_MEMORY_CITATION_CLOSE}`;
    const text = `explain \`${PI_MEMORY_CITATION_OPEN}\` complete suffix${hidden}`;
    const projected = projectPiMemoryStage1Evidence({
      jsonl: branchedJsonl().replace("finished", text),
      expectedSessionId: SESSION_ID,
    });
    expect(projected).toContain("&lt;oai-mem-citation&gt;");
    expect(projected).toContain("complete suffix");
    expect(projected).not.toContain("private.md");
    expect(projected).not.toContain("private note");
    expect(projected).not.toContain("private reasoning");
  });

  it("redacts adversarial and incomplete secret forms", () => {
    const slackToken = [
      "x",
      "o",
      "x",
      "b",
      "-",
      "123456789012",
      "-",
      "abcdefghijklmnop",
    ].join("");
    const awsAccessKeyId = ["A", "K", "I", "A", "ABCDEFGHIJKLMNOP"].join("");
    const secrets = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      "github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz012345",
      slackToken,
      awsAccessKeyId,
      "eyJabcdefghijk.eyJmnopqrstuv.abcdefghijklm",
      "json-super-secret",
      "basic-credential",
      "session-cookie-value",
      "url-password",
      "private-key-material",
    ] as const;
    const input = [
      "```env",
      `OPENAI_API_KEY=${secrets[0]}`,
      `TOKEN=${secrets[6]}`,
      "```",
      `{"client_secret":"${secrets[6]}"}`,
      `Authorization: Bearer ${secrets[1]}`,
      `Authorization: Basic ${secrets[7]}`,
      `Cookie: session=${secrets[8]}`,
      `https://user:${secrets[9]}@example.com/path`,
      secrets[2],
      secrets[3],
      secrets[4],
      secrets[5],
      "-----BEGIN PRIVATE KEY-----",
      secrets[10],
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactPiMemoryStage1Secrets(input);
    expect(redactPiMemoryStage1Secrets(input)).toBe(redacted);
    expect(redacted).toContain("https://[REDACTED_SECRET]@example.com/path");
    for (const secret of secrets) {
      expect(redacted).not.toContain(secret);
    }
    expect(
      redactPiMemoryStage1Secrets(
        "before\n-----BEGIN RSA PRIVATE KEY-----\nunclosed-secret",
      ),
    ).toBe("before\n[REDACTED_SECRET]");
  });

  it.each(["builtin", "codex"] as const)(
    "sends one $0 strict-schema request without tools",
    async (route) => {
      const requests: unknown[] = [];
      const server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const bytes = Buffer.concat(chunks);
          requests.push(
            JSON.parse(
              (request.headers["content-encoding"] === "zstd"
                ? zstdDecompressSync(bytes)
                : bytes
              ).toString("utf8"),
            ) as unknown,
          );
          responsesTextSse(
            response,
            JSON.stringify({
              raw_memory: "memory",
              rollout_summary: "summary",
              rollout_slug: "slug",
            }),
          );
        })().catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : new Error("test"));
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
        throw new Error("Stage 1 test server has no TCP address");
      }
      try {
        const result = await runPiMemoryStage1Extraction({
          model:
            route === "builtin"
              ? {
                  provider: "openrouter",
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  apiKey: "test-key",
                  model: "openai/gpt-6-luna",
                  dialect: "openai-responses",
                  transport: "sse",
                }
              : {
                  provider: "openai-codex",
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  apiKey: "test-key",
                  model: "gpt-6-luna",
                  accountId: "test-codex-account",
                  dialect: "openai-codex-responses",
                  transport: "sse",
                },
          evidence: [{ kind: "human", content: "work" }],
          requestId: "00000000-0000-4000-8000-000000000999",
        });

        expect(result).toMatchObject({
          responseId: "resp_stage1",
          usage: { input: 9, output: 7, cacheRead: 2 },
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          model: route === "builtin" ? "openai/gpt-6-luna" : "gpt-6-luna",
          text: {
            format: {
              type: "json_schema",
              name: "pi_memory_stage1",
              strict: true,
              schema: PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
            },
          },
        });
        expect(requests[0]).not.toHaveProperty("tools");
        expect(requests[0]).toMatchObject({ reasoning: { effort: "low" } });
      } finally {
        server.close();
      }
    },
  );

  it.each(["openai/gpt-6-luna", "@preset/memory"])(
    "extracts Stage 1 through OpenRouter Chat Completions with %s",
    async (modelId) => {
      const requests: unknown[] = [];
      const sessions: unknown[] = [];
      const server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const bytes = Buffer.concat(chunks);
          sessions.push(request.headers["x-session-id"]);
          requests.push(
            JSON.parse(
              (request.headers["content-encoding"] === "zstd"
                ? zstdDecompressSync(bytes)
                : bytes
              ).toString("utf8"),
            ) as unknown,
          );
          const text = JSON.stringify({
            raw_memory: "memory",
            rollout_summary: "summary",
            rollout_slug: "slug",
          });
          const chunk = (body: unknown) => {
            return `data: ${JSON.stringify(body)}\n\n`;
          };
          const base = {
            id: "chatcmpl_stage1",
            object: "chat.completion.chunk",
            model: "openai/gpt-6-luna",
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            chunk({
              ...base,
              choices: [
                { index: 0, delta: { content: text }, finish_reason: null },
              ],
            }) +
              chunk({
                ...base,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: 11,
                  completion_tokens: 7,
                  prompt_tokens_details: { cached_tokens: 2 },
                },
              }) +
              "data: [DONE]\n\n",
          );
        })().catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : new Error("test"));
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
        throw new Error("Stage 1 test server has no TCP address");
      }
      try {
        const result = await runPiMemoryStage1Extraction({
          model: {
            provider: "openrouter",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "test-key",
            model: modelId,
            dialect: "openai-completions",
            transport: "sse",
            sessionAffinityKey: "MEMORY-user-1-org-1",
          },
          evidence: [{ kind: "human", content: "work" }],
          requestId: "00000000-0000-4000-8000-000000000999",
        });

        expect(result).toMatchObject({
          responseText: expect.stringContaining("raw_memory"),
          usage: { input: 9, output: 7, cacheRead: 2 },
        });
        expect(requests).toHaveLength(1);
        expect(sessions).toStrictEqual(["MEMORY-user-1-org-1"]);
        if (modelId === "@preset/memory") {
          expect(Object.keys(requests[0] as object).sort()).toStrictEqual([
            "messages",
            "model",
            "stream",
            "stream_options",
          ]);
          expect(requests[0]).toMatchObject({
            model: modelId,
            messages: [
              {
                role: "system",
                content: [
                  expect.objectContaining({
                    cache_control: { type: "ephemeral" },
                  }),
                ],
              },
              {
                role: "user",
                content: [
                  expect.objectContaining({
                    text: expect.stringContaining("work"),
                    cache_control: { type: "ephemeral" },
                  }),
                ],
              },
            ],
          });
          return;
        }
        expect(requests[0]).toMatchObject({
          model: modelId,
          max_tokens: 32_768,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "pi_memory_stage1",
              strict: true,
              schema: PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
            },
          },
          messages: [
            { role: "developer" },
            {
              role: "user",
              content: [
                expect.objectContaining({
                  type: "text",
                  text: expect.stringContaining("work"),
                }),
              ],
            },
          ],
        });
        expect(requests[0]).not.toHaveProperty("tools");
        expect(requests[0]).toMatchObject({ reasoning: { effort: "low" } });
        expect(requests[0]).not.toHaveProperty("input");
      } finally {
        server.close();
      }
    },
  );
});
