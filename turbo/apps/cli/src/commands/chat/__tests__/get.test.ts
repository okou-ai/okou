/**
 * Tests for okou chat get command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend metadata route via MSW
 * - Real (internal): CLI argument parsing, API client, env handling
 */

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { chatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000002";
const GET_URL = `http://localhost:3000/api/chat-threads/${THREAD_ID}/metadata`;
const OTHER_GET_URL = `http://localhost:3000/api/chat-threads/${OTHER_THREAD_ID}/metadata`;

describe("okou chat get command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("loads the current chat thread and prints a human-readable summary", async () => {
    server.use(
      http.get(GET_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "Launch plan",
          selectedModel: "claude-sonnet-5",
          modelSettings: { "claude-sonnet-5": { effort: "extra" } },
        });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "get"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat thread loaded");
    expect(output).toContain(`Thread: ${THREAD_ID}`);
    expect(output).toContain(`Agent:  ${AGENT_ID}`);
    expect(output).toContain("Title:  Launch plan");
    expect(output).toContain("Model:  claude-sonnet-5 · effort extra");
  });

  it("shows the default effective effort without a saved override", async () => {
    server.use(
      http.get(GET_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "Launch plan",
          selectedModel: "gpt-6-sol",
          modelSettings: {},
        });
      }),
    );
    await chatCommand.parseAsync(["node", "cli", "get"]);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Model:  gpt-6-sol · effort max",
    );
  });

  it("prints JSON output when --json is passed", async () => {
    server.use(
      http.get(GET_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "Launch plan",
          selectedModel: "claude-sonnet-5",
        });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "get", "--json"]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        id: THREAD_ID,
        agentId: AGENT_ID,
        title: "Launch plan",
        selectedModel: "claude-sonnet-5",
      },
    );
  });

  it("prints an untitled placeholder for null titles", async () => {
    server.use(
      http.get(GET_URL, () => {
        return HttpResponse.json({
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: null,
          selectedModel: null,
        });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "get"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Title:  (untitled)");
    expect(output).toContain("Model:  (default)");
    expect(output).not.toContain("effort");
  });

  it("loads another chat thread passed with --thread-id", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", undefined);
    server.use(
      http.get(OTHER_GET_URL, () => {
        return HttpResponse.json({
          id: OTHER_THREAD_ID,
          agentId: AGENT_ID,
          title: "Delegation source",
          selectedModel: "claude-sonnet-5",
        });
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "get",
      "--thread-id",
      OTHER_THREAD_ID,
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(`Thread: ${OTHER_THREAD_ID}`);
    expect(output).toContain("Title:  Delegation source");
  });

  it("requires a thread ID from the flag or the current web chat", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", undefined);

    await expect(async () => {
      await chatCommand.parseAsync(["node", "cli", "get"]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("OKOU_CHAT_THREAD_ID is not set");
    expect(stderr).toContain("Pass --thread-id <thread-id>");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
