import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  PI_MEMORY_CITATION_OPEN,
  PI_MEMORY_CITATION_CLOSE,
} from "@okouai/api-contracts/contracts/pi-memory-citations";

import { PI_MEMORY_STAGE1_MODEL } from "./memory-background-config";
import {
  PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
  projectPiMemoryStage1History,
  redactPiMemoryStage1Secrets,
  runPiMemoryStage1Extraction,
  truncatePiMemoryStage1History,
} from "./stage1-memory";
import {
  PI_MEMORY_STAGE1_SYSTEM_PROMPT,
  PI_MEMORY_STAGE1_UPSTREAM_INPUT_TEMPLATE,
} from "./stage1-prompts";

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
    const first = projectPiMemoryStage1History({
      jsonl: branchedJsonl(),
      expectedSessionId: SESSION_ID,
    });
    const second = projectPiMemoryStage1History({
      jsonl: branchedJsonl(),
      expectedSessionId: SESSION_ID,
    });

    expect(second).toBe(first);
    expect(first).toContain('"content":"root request"');
    expect(first).toContain('"content":"active request"');
    expect(first).toContain(
      '"tool":{"name":"read","arguments":{"a":"first","z":"last"}}',
    );
    expect(first).toContain('"content":"useful contents"');
    expect(first).toContain('"content":"finished"');
    expect(first).not.toContain("discarded");
    expect(first).not.toContain("private reasoning");
    expect(first).not.toContain("call-");
    expect(first).not.toContain("ignored");
    expect(first).not.toContain("memories.search");
    expect(first).not.toContain("recalled memory");
    expect(first).not.toContain("/secret/workspace");
  });

  it("removes hidden citations from the active assistant branch", () => {
    const hidden =
      "<oai-mem-citation><citation_entries>memory.md:1-1|note=[private]</citation_entries></oai-mem-citation>";
    const jsonl = branchedJsonl().replace("finished", `visible${hidden}`);
    const projected = projectPiMemoryStage1History({
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
    const projected = projectPiMemoryStage1History({
      jsonl: branchedJsonl().replace("finished", text),
      expectedSessionId: SESSION_ID,
    });
    expect(projected).toContain("&lt;oai-mem-citation&gt;");
    expect(projected).toContain("complete suffix");
    expect(projected).not.toContain("private.md");
    expect(projected).not.toContain("private note");
    expect(projected).not.toContain("private reasoning");
  });

  it("redacts adversarial secret forms and truncates both ends deterministically", () => {
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

    const source = `${"head ".repeat(100)}MIDDLE${" tail".repeat(100)}`;
    const first = truncatePiMemoryStage1History({
      projectedHistory: source,
      contextWindow: 40,
      fallbackTokenLimit: 150_000,
      maxBytes: 8 * 1024 * 1024,
    });
    expect(
      truncatePiMemoryStage1History({
        projectedHistory: source,
        contextWindow: 40,
        fallbackTokenLimit: 150_000,
        maxBytes: 8 * 1024 * 1024,
      }),
    ).toStrictEqual(first);
    expect(first.tokenCount).toBeLessThanOrEqual(28);
    expect(first.content).toContain("head");
    expect(first.content).toContain("tail");
    expect(first.content).toContain("[... truncated ...]");
    expect(first.content).not.toContain("MIDDLE");
  });

  it("sends one fixed luna low-reasoning strict-schema request without tools", async () => {
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        requests.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
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
        model: {
          provider: "openai",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-key",
          model: PI_MEMORY_STAGE1_MODEL,
          dialect: "openai-responses",
          transport: "sse",
        },
        projectedHistory: '{"role":"user","content":"work"}',
        requestId: "00000000-0000-4000-8000-000000000999",
      });

      expect(result).toMatchObject({
        responseId: "resp_stage1",
        usage: { input: 9, output: 7, cacheRead: 2 },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: "gpt-5.6-luna",
        reasoning: { effort: "low" },
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
    } finally {
      server.close();
    }
  });
});
