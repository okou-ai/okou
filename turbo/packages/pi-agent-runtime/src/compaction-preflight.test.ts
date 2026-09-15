import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { CompactionSettings } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { assertPiApiFirstTurnCompactionSafe } from "./compaction-preflight";
import { PiApiFirstTurnCompactionRequiredError } from "./errors";
import { resolvePiAgentModel } from "./model";
import { MemoryPiSession } from "./session-memory";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const SETTINGS: Required<CompactionSettings> = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};
function terraModel() {
  const model = resolvePiAgentModel({
    provider: "openai",
    baseUrl: "https://api.openai.test/v1",
    apiKey: "test-key",
    model: "gpt-5.6-terra",
    dialect: "openai-responses",
    transport: "sse",
  });
  if (!model) {
    throw new Error("Expected pinned Pi to catalog Terra");
  }
  return model;
}
const MODEL = terraModel();

function usage(totalTokens: number): Usage {
  return {
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
  };
}

function assistant(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "prior answer" }],
    api: "openai-responses",
    provider: MODEL.provider,
    model: MODEL.id,
    usage: usage(8),
    stopReason: "stop",
    timestamp: 2,
    ...overrides,
  };
}

function settledSession(message: AssistantMessage): MemoryPiSession {
  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: SESSION_ID,
    timestamp: new Date(0).toISOString(),
  });
  session.appendMessage({
    role: "user",
    content: "prior prompt",
    timestamp: 1,
  });
  session.appendMessage(message);
  return session;
}

function assertSafe(session: MemoryPiSession): void {
  assertPiApiFirstTurnCompactionSafe({
    model: MODEL,
    session,
    settings: SETTINGS,
  });
}

function expectOfficialPreflight(session: MemoryPiSession): void {
  expect(() => {
    assertSafe(session);
  }).toThrow(PiApiFirstTurnCompactionRequiredError);
}

describe("Pi API-first compaction preflight", () => {
  it("proves only the public positive-usage threshold boundary", () => {
    const threshold = MODEL.contextWindow - SETTINGS.reserveTokens;

    expect(() => {
      assertSafe(settledSession(assistant({ usage: usage(threshold) })));
    }).not.toThrow();
    expectOfficialPreflight(
      settledSession(assistant({ usage: usage(threshold + 1) })),
    );
  });

  it("suppresses stale pre-compaction usage at the official boundary", () => {
    const session = settledSession(
      assistant({ usage: usage(MODEL.contextWindow), timestamp: 2 }),
    );
    const lines = session.toJsonl().trimEnd().split("\n");
    const userEntry = JSON.parse(lines.at(-2) ?? "{}") as { id?: string };
    const assistantEntry = JSON.parse(lines.at(-1) ?? "{}") as { id?: string };
    lines.push(
      JSON.stringify({
        type: "compaction",
        id: "compact1",
        parentId: assistantEntry.id,
        timestamp: new Date(3).toISOString(),
        summary: "official summary",
        firstKeptEntryId: userEntry.id,
        tokensBefore: MODEL.contextWindow,
        usage: usage(8),
      }),
    );
    const compacted = MemoryPiSession.fromJsonl(`${lines.join("\n")}\n`);

    expect(compacted.isSettledCheckpoint()).toBeTruthy();
    expect(() => {
      assertSafe(compacted);
    }).not.toThrow();
  });

  it.each([
    ["zero usage", assistant({ usage: usage(0) })],
    ["negative usage", assistant({ usage: usage(-1) })],
    ["error recovery", assistant({ stopReason: "error" })],
    ["aborted recovery", assistant({ stopReason: "aborted" })],
    ["length recovery", assistant({ stopReason: "length" })],
  ])("fails closed for %s", (_label, message) => {
    expectOfficialPreflight(settledSession(message));
  });

  it("fails closed for a non-settled checkpoint", () => {
    const session = settledSession(assistant());
    session.appendMessage({
      role: "user",
      content: "unsettled trailing input",
      timestamp: 3,
    });

    expectOfficialPreflight(session);
  });
});
