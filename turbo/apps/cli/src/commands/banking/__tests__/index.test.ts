import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { bankingCommand } from "../index";
const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const THREAD_ID = "550e8400-e29b-41d4-a716-446655440001";

describe("okou banking command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_APP_URL", "https://app.example.test");
    vi.stubEnv("OKOU_AGENT_ID", AGENT_ID);
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("posts transaction requests with the default limit and prints JSON", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/banking/transactions",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "transactions",
            provider: "finicity",
            accountId: "acct-1",
            transactions: [
              {
                id: "txn-1",
                accountId: "acct-1",
                amount: -12.34,
                description: "Coffee",
              },
            ],
          });
        },
      ),
    );

    await bankingCommand.parseAsync([
      "node",
      "cli",
      "transactions",
      "--account-id",
      "acct-1",
      "--from",
      "2026-01-01",
      "--to",
      "2026-01-31",
      "--json",
    ]);

    expect(requestBody).toEqual({
      accountId: "acct-1",
      from: "2026-01-01",
      to: "2026-01-31",
      limit: 100,
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        operation: "transactions",
        provider: "finicity",
        accountId: "acct-1",
        transactions: [
          {
            id: "txn-1",
            accountId: "acct-1",
            amount: -12.34,
            description: "Coffee",
          },
        ],
      }),
    );
  });

  it("renders provider and account data in human output", async () => {
    server.use(
      http.post("http://localhost:3000/api/banking/accounts", () => {
        return HttpResponse.json({
          operation: "accounts",
          provider: "finicity",
          accounts: [
            {
              id: "acct-1",
              name: "Everyday Checking",
              institutionName: "Example Bank",
              type: "checking",
              last4: "6789",
            },
          ],
        });
      }),
    );

    await bankingCommand.parseAsync(["node", "cli", "accounts"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Banking accounts loaded");
    expect(output).toContain("Provider: finicity");
    expect(output).toContain("Everyday Checking");
    expect(output).toContain("Example Bank");
  });

  it("shows auth guidance when no token is available", async () => {
    vi.stubEnv("OKOU_TOKEN", undefined);

    await expect(
      bankingCommand.parseAsync(["node", "cli", "accounts"]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("Not authenticated");
    expect(errors).toContain("Set OKOU_TOKEN to a valid run token");
  });

  it("prints a current-chat banking access card URL", async () => {
    await bankingCommand.parseAsync([
      "node",
      "cli",
      "access-request",
      "--reason",
      "Review recent expenses",
      "--callback-prompt",
      "Continue the expense review",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    const urlText = mockConsoleLog.mock.calls
      .flat()
      .map(String)
      .find((value) => {
        return value.startsWith("https://app.example.test/agents/");
      });
    if (!urlText) {
      throw new Error("Expected a banking access URL");
    }
    const url = new URL(urlText);
    expect(url.pathname).toBe(`/agents/${AGENT_ID}/banking`);
    expect(Array.from(url.searchParams.entries())).toStrictEqual([
      ["reason", "Review recent expenses"],
      ["callbackPrompt", "Continue the expense review"],
      ["threadId", THREAD_ID],
    ]);
    expect(output).toContain("end the current turn");
    expect(output).toContain("exact callback URL above verbatim");
    expect(output).toContain("omitting any query parameters");
  });
});
