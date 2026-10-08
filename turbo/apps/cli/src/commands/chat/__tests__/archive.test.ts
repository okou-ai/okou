/**
 * Tests for okou chat archive / unarchive commands
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend archive routes via MSW
 * - Real (internal): CLI argument parsing, API client, env handling
 */

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { chatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000002";
const BASE_URL = "http://localhost:3000/api/chat-threads";

describe("okou chat archive / unarchive commands", () => {
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

  it("archives the current chat thread", async () => {
    let requests = 0;
    server.use(
      http.post(`${BASE_URL}/${THREAD_ID}/archive`, ({ request }) => {
        requests += 1;
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await chatCommand.parseAsync(["node", "cli", "archive"]);

    expect(requests).toBe(1);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Chat thread archived");
    expect(output).toContain(`Thread: ${THREAD_ID}`);
  });

  it("unarchives another thread and prints JSON", async () => {
    let requests = 0;
    server.use(
      http.post(`${BASE_URL}/${OTHER_THREAD_ID}/unarchive`, () => {
        requests += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await chatCommand.parseAsync([
      "node",
      "cli",
      "unarchive",
      "--thread-id",
      OTHER_THREAD_ID,
      "--json",
    ]);

    expect(requests).toBe(1);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      { threadId: OTHER_THREAD_ID, archived: false },
    );
  });

  it("reports a missing thread", async () => {
    server.use(
      http.post(`${BASE_URL}/${THREAD_ID}/archive`, () => {
        return HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Chat thread not found" } },
          { status: 404 },
        );
      }),
    );

    await expect(
      chatCommand.parseAsync(["node", "cli", "archive"]),
    ).rejects.toThrow("process.exit called");
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Chat thread not found",
    );
  });

  it("rejects an invalid thread id before calling the API", async () => {
    await expect(
      chatCommand.parseAsync([
        "node",
        "cli",
        "archive",
        "--thread-id",
        "not-a-uuid",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      'Invalid thread ID "not-a-uuid"',
    );
  });
});
