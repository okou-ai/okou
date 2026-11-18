import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import {
  fauxAssistantMessage,
  fauxToolCall,
  normalizeContext,
  type Message,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { PiImageHistory } from "./image-history";
import { inspectPiSessionJsonl } from "./api";
import { piAgentStreamForConfig } from "./model";
import { resolvePiAgentModel } from "./model-catalog";
import { MemoryPiSession } from "./session-memory";

const MIB = 1024 * 1024;
const SESSION_ID = "00000000-0000-4000-8000-000000000915";
const server = setupServer();
beforeAll(() => {
  return server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  return server.resetHandlers();
});
afterAll(() => {
  return server.close();
});

function history(count = 7): Message[] {
  const messages: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Compare the screenshots with this upload" },
        { type: "image", data: "B".repeat(MIB), mimeType: "image/png" },
      ],
      timestamp: 1,
    },
  ];
  for (let index = 0; index < count; index += 1) {
    messages.push(
      fauxAssistantMessage(
        fauxToolCall(
          "read",
          { path: `screenshot-${index}.png` },
          {
            id: `image-${index}`,
          },
        ),
        { stopReason: "toolUse", timestamp: index * 2 + 2 },
      ),
      {
        role: "toolResult",
        toolCallId: `image-${index}`,
        toolName: "read",
        content: [
          { type: "text", text: `screenshot-${index}.png` },
          { type: "image", data: "A".repeat(4 * MIB), mimeType: "image/png" },
        ],
        details: { source: index },
        isError: false,
        timestamp: index * 2 + 3,
      },
    );
  }
  messages.push(fauxAssistantMessage("Screenshots reviewed"));
  return messages;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

async function nativeFile(count = 7) {
  const directory = await mkdtemp(join(tmpdir(), "pi-image-history-"));
  onTestFinished(() => {
    return rm(directory, { recursive: true, force: true });
  });
  const memory = MemoryPiSession.create({ cwd: directory, id: SESSION_ID });
  for (const message of history(count)) memory.appendMessage(message);
  const sessionFile = join(directory, "session.jsonl");
  await writeFile(sessionFile, memory.toJsonl());
  return { directory, sessionFile };
}

function imageCount(
  messages: Readonly<
    ReturnType<SessionManager["buildSessionContext"]>["messages"]
  >,
): number {
  return messages.reduce((count, message) => {
    if (!("content" in message) || typeof message.content === "string") {
      return count;
    }
    return (
      count +
      message.content.filter((block) => {
        return block.type === "image";
      }).length
    );
  }, 0);
}

describe("Pi image history at provider and native-session boundaries", () => {
  it.each([
    {
      provider: "openrouter",
      baseUrl: "https://image-history.test/v1",
      model: "openai/gpt-6-luna",
      dialect: "openai-completions",
      transport: "sse",
    },
    {
      provider: "openrouter",
      baseUrl: "https://image-history.test/v1",
      model: "openai/gpt-6-luna",
      dialect: "openai-responses",
      transport: "sse",
    },
    {
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-6-luna",
      accountId: "synthetic-account",
      dialect: "openai-codex-responses",
      transport: "sse",
    },
  ] as const)(
    "bounds serialized $dialect images and keeps retirements on the next request",
    async (route) => {
      const config = { ...route, apiKey: "synthetic-key" };
      const model = resolvePiAgentModel(config);
      if (!model) throw new Error("Expected a resolved image-history model");
      const requests: unknown[] = [];
      server.use(
        http.post("*", async ({ request }) => {
          const bytes = Buffer.from(await request.arrayBuffer());
          requests.push(
            JSON.parse(
              (request.headers.get("content-encoding") === "zstd"
                ? zstdDecompressSync(bytes)
                : bytes
              ).toString("utf8"),
            ) as unknown,
          );
          return HttpResponse.json(
            { error: { message: "Synthetic request capture" } },
            { status: 400 },
          );
        }),
      );
      const stream = piAgentStreamForConfig(config);
      for (const count of [7, 8]) {
        const context = normalizeContext({ messages: history(count) });
        const result = await stream(model, context, {
          apiKey: config.apiKey,
          maxRetries: 0,
        }).result();
        expect(result.stopReason).toBe("error");
        // Projections must leave the original transcript available to callers.
        expect(imageCount(context.messages)).toBe(count + 1);
      }
      expect(requests).toHaveLength(2);
      for (const [index, request] of requests.entries()) {
        const values = strings(request);
        const images = values.filter((value) => {
          return value.startsWith("data:image/png;base64,");
        });
        expect(
          images.map((value) => {
            return value.length - 22;
          }),
        ).toEqual([
          MIB,
          ...Array.from({ length: index + 3 }, () => {
            return 4 * MIB;
          }),
        ]);
        const text = values
          .filter((value) => {
            return value.length < 1000;
          })
          .join("\n");
        expect(text).toContain("Tool image omitted");
        for (let image = 0; image < index + 7; image += 1) {
          expect(text).toContain(`screenshot-${image}.png`);
        }
      }
    },
  );

  it("retains earlier request omissions below budget after compaction and reopen", async () => {
    const { sessionFile } = await nativeFile();
    const manager = SessionManager.open(sessionFile);
    const first = manager.getEntries().find((entry) => {
      return (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === "image-3"
      );
    });
    if (
      !first ||
      first.type !== "message" ||
      first.message.role !== "toolResult"
    )
      throw new Error("Missing tool result");
    manager.appendContextEdit(first.id, {
      content: [
        { type: "text", text: "previous edit" },
        ...first.message.content,
      ],
    });
    const otherBranch = manager.getLeafId();
    const policy = new PiImageHistory();
    policy.boundContext(normalizeContext({ messages: history() }));
    const firstKept = manager.getEntries().find((entry) => {
      return (
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.content.some((block) => {
          return block.type === "toolCall" && block.id === "image-3";
        })
      );
    });
    if (!firstKept) throw new Error("Missing kept tool call");
    manager.appendCompaction("checkpoint", firstKept.id, 100);
    const before = await readFile(sessionFile, "utf8");
    policy.retain(manager);
    const retainedLeaf = manager.getLeafId();
    expect((await readFile(sessionFile, "utf8")).startsWith(before)).toBe(true);

    const reopened = SessionManager.open(sessionFile);
    const messages = reopened.buildSessionContext().messages;
    expect(imageCount(messages)).toBe(3);
    expect(
      messages.find((message) => {
        return message.role === "toolResult";
      }),
    ).toMatchObject({
      toolCallId: "image-3",
      toolName: "read",
      details: { source: 3 },
      isError: false,
      content: [
        { type: "text", text: "previous edit" },
        { type: "text", text: "screenshot-3.png" },
        { type: "text", text: expect.stringContaining("Tool image omitted") },
      ],
    });
    const entries = reopened.getEntries().length;
    new PiImageHistory().retain(reopened);
    expect(reopened.getEntries()).toHaveLength(entries);
    if (!otherBranch || !retainedLeaf) throw new Error("Missing branch leaf");
    reopened.branch(otherBranch);
    expect(imageCount(reopened.buildSessionContext().messages)).toBe(8);
    reopened.branch(retainedLeaf);
    expect(imageCount(reopened.buildSessionContext().messages)).toBe(3);
  });

  it("keeps native edits scoped to ancestors of the active branch", async () => {
    const { sessionFile } = await nativeFile(0);
    const manager = SessionManager.open(sessionFile);
    const split = manager.getLeafId();
    if (!split) throw new Error("Missing branch point");
    const other = manager.appendMessage({
      role: "user",
      content: "other branch",
      timestamp: 2,
    });
    const otherLeaf = manager.appendContextEdit(other, {
      content: "edited other branch",
    });
    manager.branch(split);
    const active = manager.appendMessage({
      role: "user",
      content: "active branch",
      timestamp: 3,
    });
    manager.appendContextEdit(active, { content: "edited active branch" });
    expect(() => {
      return manager.appendContextEdit(other, { content: "wrong branch" });
    }).toThrow("not on the active branch");
    const reopened = SessionManager.open(sessionFile);
    expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "user",
      content: "edited active branch",
    });
    reopened.branch(otherLeaf);
    expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "user",
      content: "edited other branch",
    });
  });

  it("persists tool-image omissions before the official RPC host exits on stdin EOF", async () => {
    const { directory, sessionFile } = await nativeFile();
    const fixture = fileURLToPath(
      new URL("./test/fixtures/pending-tool-rpc.ts", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fixture,
        directory,
        "image-history",
      ],
      {
        cwd: directory,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 20_000,
        killSignal: "SIGKILL",
      },
    );
    const exit = once(child, "exit");
    onTestFinished(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stdin.write(
      `${JSON.stringify({ type: "get_state", id: "ready" })}\n`,
    );
    for await (const line of lines) {
      const event = JSON.parse(line) as { type: string; id?: string };
      if (event.type === "response" && event.id === "ready") {
        child.stdin.end();
        break;
      }
    }
    const [code, signal] = await exit;
    expect({ code, signal, stderr }).toMatchObject({ code: 0, signal: null });
    expect(
      imageCount(
        SessionManager.open(sessionFile).buildSessionContext().messages,
      ),
    ).toBe(4);
    expect(
      inspectPiSessionJsonl(await readFile(sessionFile, "utf8")),
    ).toMatchObject({
      sessionId: SESSION_ID,
      hasPendingToolCalls: false,
      isSettledHistory: true,
    });
  });
});
