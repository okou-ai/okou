import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  CURRENT_SESSION_VERSION,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryPiSession } from "./session-memory";
import { UnsupportedPiSessionVersionError } from "./errors";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("MemoryPiSession", () => {
  it("uses Pi migrations and compacted-context projection", async () => {
    const legacyJsonl = [
      {
        type: "session",
        id: SESSION_ID,
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: "/home/user/workspace",
      },
      {
        type: "message",
        timestamp: "2025-01-01T00:00:01.000Z",
        message: { role: "user", content: "legacy message", timestamp: 1 },
      },
    ]
      .map((entry) => {
        return JSON.stringify(entry);
      })
      .join("\n");
    const migrated = MemoryPiSession.fromJsonl(legacyJsonl);
    expect(migrated.getHeader().version).toBe(CURRENT_SESSION_VERSION);

    const directory = await temporaryDirectory();
    const nativeSession = SessionManager.create(
      "/home/user/workspace",
      directory,
      {
        id: SESSION_ID,
      },
    );
    nativeSession.appendMessage({
      role: "user",
      content: "summarized turn",
      timestamp: 1,
    });
    const firstKeptEntryId = nativeSession.appendMessage({
      role: "user",
      content: "kept turn",
      timestamp: 2,
    });
    nativeSession.appendCompaction(
      "Pi generated summary",
      firstKeptEntryId,
      42,
    );
    nativeSession.appendMessage(
      fauxAssistantMessage("after compaction", { timestamp: 3 }),
    );
    const sessionFile = nativeSession.getSessionFile();
    if (!sessionFile) {
      throw new Error("Expected Pi to create a native session file");
    }
    const memory = MemoryPiSession.fromJsonl(
      await readFile(sessionFile, "utf8"),
    );
    const nativeContext = nativeSession.buildSessionContext();
    expect(memory.buildSessionContext()).toStrictEqual(
      JSON.parse(JSON.stringify(nativeContext)) as unknown,
    );
    expect(
      JSON.parse(
        JSON.stringify(convertToLlm(memory.buildSessionContext().messages)),
      ),
    ).toStrictEqual(
      JSON.parse(
        JSON.stringify(convertToLlm(nativeContext.messages)),
      ) as unknown,
    );
  });

  it("rejects a future Pi session version without invoking the model", () => {
    const futureJsonl = `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION + 1,
      id: SESSION_ID,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/home/user/workspace",
    })}\n`;

    expect(() => {
      return MemoryPiSession.fromJsonl(futureJsonl);
    }).toThrow(UnsupportedPiSessionVersionError);
  });

  it("rejects a malformed line after a valid native session header", () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });

    expect(() => {
      return MemoryPiSession.fromJsonl(`${memory.toJsonl()}{malformed\n`);
    }).toThrow(SyntaxError);
  });

  it("distinguishes a pending tool call from a settled native checkpoint", () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    memory.appendMessage({ role: "user", content: "read it", timestamp: 1 });
    const pending = fauxAssistantMessage(
      fauxToolCall("read", { path: "/home/user/workspace/README.md" }),
      { stopReason: "toolUse", timestamp: 2 },
    );
    memory.appendMessage(pending);

    expect(memory.hasPendingToolCalls()).toBe(true);
    expect(memory.isSettledCheckpoint()).toBe(false);
    const call = pending.content.find((content) => {
      return content.type === "toolCall";
    });
    if (!call || call.type !== "toolCall") {
      throw new Error("Expected a pending tool call");
    }
    memory.appendMessage({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 3,
    });

    expect(memory.hasPendingToolCalls()).toBe(false);
    expect(memory.isSettledCheckpoint()).toBe(false);
    memory.appendMessage(
      fauxAssistantMessage("done", { stopReason: "stop", timestamp: 4 }),
    );
    expect(memory.isSettledCheckpoint()).toBe(true);
  });
});
