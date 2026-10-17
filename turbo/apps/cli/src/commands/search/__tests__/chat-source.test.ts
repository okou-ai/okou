/**
 * Tests for `okou search --source chat`.
 *
 * Entry point: searchCommand.parseAsync()
 * Mock (external): Web API via MSW
 * Real (internal): flag parsing, time parsing, renderers, error mapping
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { searchCommand } from "../index";

function makeMessage(params: {
  content: string;
  role?: "user" | "assistant";
  createdAt?: string;
  seqId?: number;
}) {
  return {
    chatThreadId: "thread-1",
    role: params.role ?? "user",
    content: params.content,
    createdAt: params.createdAt ?? "2024-01-15T10:30:00Z",
    seqId: params.seqId ?? 1,
    runId: null,
  };
}

describe("okou search --source chat", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    // Clear any prior spy call history before each test so assertions only
    // see calls made by the current case.
    vi.clearAllMocks();
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    // Commander retains collector state across parseAsync calls on the
    // same command instance. Reset before each case.
    searchCommand.setOptionValue("source", []);
  });

  afterEach(() => {
    // Restore stubbed env vars so state never bleeds across test files.
    vi.unstubAllEnvs();
  });

  it("rejects whitespace-only queries", async () => {
    await expect(
      searchCommand.parseAsync(["node", "cli", "   ", "--source", "chat"]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("Query cannot be empty");
  });

  it("renders the matched message grouped by thread", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/chat/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({
          results: [
            {
              chatThreadId: "thread-abc",
              agentName: "my-agent",
              matchedMessage: makeMessage({
                content: "OOM killed the build",
              }),
            },
          ],
        });
      }),
    );

    await searchCommand.parseAsync(["node", "cli", "OOM", "--source", "chat"]);

    const logs = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("thread-abc");
    expect(logs).toContain("my-agent");
    expect(logs).toContain("OOM killed the build");
    expect(capturedUrl?.searchParams.has("limit")).toBeFalsy();
  });

  it("tolerates invalid chat message timestamps", async () => {
    server.use(
      http.get("http://localhost:3000/api/chat/search", () => {
        return HttpResponse.json({
          results: [
            {
              chatThreadId: "thread-abc",
              agentName: "my-agent",
              matchedMessage: makeMessage({
                content: "OOM killed the build",
                createdAt: "not-a-timestamp",
              }),
            },
          ],
        });
      }),
    );

    await searchCommand.parseAsync(["node", "cli", "OOM", "--source", "chat"]);

    const logs = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("invalid-date");
    expect(logs).toContain("OOM killed the build");
  });

  it("handles no matches", async () => {
    server.use(
      http.get("http://localhost:3000/api/chat/search", () => {
        return HttpResponse.json({ results: [] });
      }),
    );

    await searchCommand.parseAsync([
      "node",
      "cli",
      "nothing",
      "--source",
      "chat",
    ]);

    const logs = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("No matches found");
    expect(logs).toContain("--since 30d");
  });

  it("passes epoch --since to API instead of the default search window", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get("http://localhost:3000/api/chat/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [] });
      }),
    );

    await searchCommand.parseAsync([
      "node",
      "cli",
      "error",
      "--source",
      "chat",
      "--since",
      "1970-01-01T00:00:00Z",
    ]);

    expect(capturedUrl?.searchParams.get("since")).toBe("0");
  });

  it("passes --agent as agentId filter to API", async () => {
    let capturedUrl: URL | undefined;
    const agentId = "550e8400-e29b-41d4-a716-446655440001";
    server.use(
      http.get("http://localhost:3000/api/chat/search", ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ results: [] });
      }),
    );

    await searchCommand.parseAsync([
      "node",
      "cli",
      "hello",
      "--source",
      "chat",
      "--agent",
      agentId,
    ]);

    expect(capturedUrl?.searchParams.get("agentId")).toBe(agentId);
  });

  it("rejects non-UUID --agent values", async () => {
    await expect(
      searchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "chat",
        "--agent",
        "agent-123",
      ]),
    ).rejects.toThrow("process.exit called");

    let errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("Invalid agent ID");

    mockConsoleError.mockClear();
    searchCommand.setOptionValue("source", []);

    await expect(
      searchCommand.parseAsync([
        "node",
        "cli",
        "hello",
        "--source",
        "chat",
        "--agent",
        "",
      ]),
    ).rejects.toThrow("process.exit called");

    errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("Invalid agent ID");
  });

  it("surfaces API authentication errors", async () => {
    server.use(
      http.get("http://localhost:3000/api/chat/search", () => {
        return HttpResponse.json(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    await expect(
      searchCommand.parseAsync(["node", "cli", "error", "--source", "chat"]),
    ).rejects.toThrow();

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("Authentication failed");
  });
});
