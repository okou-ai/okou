import {
  fauxAssistantMessage,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import {
  PI_MEMORY_CITATION_OPEN,
  PI_MEMORY_CITATION_CLOSE,
} from "@okouai/api-contracts/contracts/pi-memory-citations";
import { describe, expect, it } from "vitest";
import {
  createPiSessionJsonl,
  inspectPiSessionJsonl,
  projectPiSessionJsonlForExport,
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
      isSettledCheckpoint: false,
    });
    expect(JSON.parse(jsonl.split("\n")[0] ?? "{}")).toMatchObject({
      id: SESSION_ID,
      timestamp: SESSION_TIMESTAMP,
    });
  });

  it("hides citation envelopes in exports while preserving canonical JSONL", () => {
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

  it("preserves split delimiter examples through immutable session export", () => {
    const literal = `explain \`${PI_MEMORY_CITATION_OPEN}\` suffix`;
    const hidden = `${PI_MEMORY_CITATION_OPEN}<citation_entries>private.md:1-1|note=[private note]</citation_entries>${PI_MEMORY_CITATION_CLOSE}`;
    const expected = `explain \`&lt;${PI_MEMORY_CITATION_OPEN.slice(1, -1)}&gt;\` suffix`;
    const native = fauxAssistantMessage([
      { type: "text", text: literal.slice(0, 14) },
      { type: "text", text: literal.slice(14) + hidden },
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
