import chalk from "chalk";
import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { server } from "../../../mocks/server";
import { webSearchCommand } from "../index";

const responseBody = {
  query: "latest AI regulation",
  limit: 5,
  provider: "perplexity",
  billingCategory: "request",
  billingQuantity: 1,
  creditsCharged: 5,
  results: [
    {
      rank: 1,
      title: "AI regulation update",
      url: "https://example.com/update",
      snippet: "A relevant public-web excerpt.",
      publishedDate: "2026-07-14",
      lastUpdatedDate: "2026-07-14",
    },
  ],
} as const;

describe("okou web-search command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockStderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => {
      return true;
    }) as never);
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    webSearchCommand.setOptionValue("limit", 5);
    webSearchCommand.setOptionValue("recency", undefined);
    webSearchCommand.setOptionValue("domain", []);
    webSearchCommand.setOptionValue("json", undefined);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockStderrWrite.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    mockStderrWrite.mockRestore();
    mockExit.mockRestore();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  function errorOutput(): string {
    return [
      ...mockConsoleError.mock.calls.flat(),
      ...mockStderrWrite.mock.calls.flat(),
    ]
      .map(String)
      .join("\n");
  }

  it("prints search results and pending billing when the charge is unknown", async () => {
    server.use(
      http.post("http://localhost:3000/api/web-search", () => {
        return HttpResponse.json({ ...responseBody, creditsCharged: null });
      }),
    );
    await webSearchCommand.parseAsync(["node", "cli", "latest AI regulation"]);
    expect(output()).toContain("AI regulation update");
    expect(output()).toContain("Credits charged: pending");
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("posts default requests and prints JSON", async () => {
    let requestBody: unknown;
    server.use(
      http.post("http://localhost:3000/api/web-search", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json(responseBody);
      }),
    );

    await webSearchCommand.parseAsync([
      "node",
      "cli",
      "latest AI regulation",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      query: "latest AI regulation",
      limit: 5,
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(responseBody));
  });

  it("translates filters and renders ranked results", async () => {
    let requestBody: unknown;
    server.use(
      http.post("http://localhost:3000/api/web-search", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          ...responseBody,
          limit: 3,
          recency: "week",
          domains: ["example.com", "docs.example.com"],
        });
      }),
    );

    await webSearchCommand.parseAsync([
      "node",
      "cli",
      "latest AI regulation",
      "--limit",
      "3",
      "--recency",
      "week",
      "--domain",
      "EXAMPLE.com",
      "--domain",
      "docs.example.com",
    ]);

    expect(requestBody).toStrictEqual({
      query: "latest AI regulation",
      limit: 3,
      recency: "week",
      domains: ["example.com", "docs.example.com"],
    });
    expect(output()).toContain("Web search completed");
    expect(output()).toContain("Provider: perplexity");
    expect(output()).toContain("Credits charged: 5");
    expect(output()).toContain("1. AI regulation update");
    expect(output()).toContain("https://example.com/update");
    expect(output()).toContain("A relevant public-web excerpt.");
    expect(output()).toContain("Published: 2026-07-14");
    expect(output()).toContain("Updated: 2026-07-14");
  });

  it("guides users when no results are returned", async () => {
    server.use(
      http.post("http://localhost:3000/api/web-search", () => {
        return HttpResponse.json({ ...responseBody, results: [] });
      }),
    );

    await webSearchCommand.parseAsync(["node", "cli", "very narrow query"]);

    expect(output()).toContain("No web results found");
    expect(output()).toContain("broader query");
  });

  it.each([
    ["invalid limit", ["query", "--limit", "11"], "limit must be"],
    [
      "invalid recency",
      ["query", "--recency", "forever"],
      "recency must be one of",
    ],
    [
      "invalid domain",
      ["query", "--domain", "https://example.com"],
      "Domain must be",
    ],
    ["empty query", ["   "], "Too small"],
  ])("rejects %s before calling the API", async (_name, args, message) => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/web-search", () => {
        apiRequests += 1;
        return HttpResponse.json(responseBody);
      }),
    );

    await expect(
      webSearchCommand.parseAsync(["node", "cli", ...args]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(message);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(apiRequests).toBe(0);
  });

  it("prints API error messages", async () => {
    server.use(
      http.post("http://localhost:3000/api/web-search", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Perplexity web search request failed",
              code: "PERPLEXITY_ERROR",
            },
          },
          { status: 502 },
        );
      }),
    );

    await expect(
      webSearchCommand.parseAsync(["node", "cli", "latest news"]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(
      "502: Perplexity web search request failed",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
