import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createPiSessionJsonl,
  inspectPiSessionJsonl,
  UnsupportedPiSessionVersionError,
} from "./api";
import { MemoryPiSession } from "./session-memory";
const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const SESSION_TIMESTAMP = "2026-08-31T12:34:56.000Z";

describe("Pi API facade", () => {
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
      pendingToolIds: [],
      isSettledHistory: false,
    });
    expect(JSON.parse(jsonl.split("\n")[0] ?? "{}")).toMatchObject({
      id: SESSION_ID,
      timestamp: SESSION_TIMESTAMP,
    });
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
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
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
      pendingToolIds: [],
      isSettledHistory: true,
    });
  });

  it.each(["empty", "partial"] as const)(
    "accepts %s error history without dropping completed work",
    (content) => {
      const session = MemoryPiSession.create({
        cwd: "/home/user/workspace",
        id: SESSION_ID,
      });
      session.appendMessage({ role: "user", content: "read it", timestamp: 1 });
      const call = fauxToolCall("read", { path: "README.md" });
      session.appendMessage(
        fauxAssistantMessage(call, { stopReason: "toolUse", timestamp: 2 }),
      );
      session.appendMessage({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "completed tool work" }],
        isError: false,
        timestamp: 3,
      });
      session.appendMessage(
        fauxAssistantMessage(
          content === "empty"
            ? []
            : [
                { type: "thinking", thinking: "partial reasoning" },
                { type: "text", text: "partial answer" },
              ],
          { stopReason: "error", timestamp: 4 },
        ),
      );
      const jsonl = session.toJsonl();

      expect(inspectPiSessionJsonl(jsonl)).toStrictEqual({
        sessionId: SESSION_ID,
        messageCount: 4,
        hasPendingToolCalls: false,
        pendingToolIds: [],
        isSettledHistory: true,
      });
      expect(MemoryPiSession.fromJsonl(jsonl).toJsonl()).toBe(jsonl);
      expect(session.toJsonl()).toBe(jsonl);
    },
  );

  it("keeps aborted and unresolved error history unsettled", () => {
    for (const message of [
      fauxAssistantMessage("cancelled", { stopReason: "aborted" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), {
        stopReason: "error",
      }),
    ]) {
      const session = MemoryPiSession.create({
        cwd: "/home/user/workspace",
        id: SESSION_ID,
      });
      session.appendMessage(message);
      expect(inspectPiSessionJsonl(session.toJsonl()).isSettledHistory).toBe(
        false,
      );
    }
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
