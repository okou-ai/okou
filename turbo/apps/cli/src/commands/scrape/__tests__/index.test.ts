import { dataRouterTool } from "../../../mocks/data-router";
import chalk from "chalk";
import { HttpResponse } from "msw";
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
import { scrapeCommand } from "../index";

describe("okou data web scrape command", () => {
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

  it("posts default markdown scrape requests and prints JSON", async () => {
    let requestBody: unknown;
    server.use(
      dataRouterTool("web_scrape", ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json({
          requestedUrl: "https://example.com",
          format: "markdown",
          mode: "standard",
          provider: "firecrawl",
          creditsCharged: 4,
          billingCategory: "standard.markdown",
          billingQuantity: 1,
          result: { markdown: "# Example" },
        });
      }),
    );

    await scrapeCommand.parseAsync([
      "node",
      "cli",
      "https://example.com",
      "--json",
    ]);

    expect(requestBody).toEqual({
      url: "https://example.com",
      format: "markdown",
      mode: "standard",
    });
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual({
      requestedUrl: "https://example.com",
      format: "markdown",
      mode: "standard",
      provider: "firecrawl",
      creditsCharged: 4,
      billingCategory: "standard.markdown",
      billingQuantity: 1,
      result: { markdown: "# Example" },
    });
  });

  it("posts enhanced link scrape requests and prints links", async () => {
    let requestBody: unknown;
    server.use(
      dataRouterTool("web_scrape", ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json({
          requestedUrl: "https://example.com",
          format: "links",
          mode: "enhanced",
          provider: "firecrawl",
          creditsCharged: 20,
          billingCategory: "enhanced.links",
          billingQuantity: 1,
          result: {
            links: ["https://example.com/a", "https://example.com/b"],
          },
        });
      }),
    );

    await scrapeCommand.parseAsync([
      "node",
      "cli",
      "https://example.com",
      "--format",
      "links",
      "--mode",
      "enhanced",
    ]);

    expect(requestBody).toEqual({
      url: "https://example.com",
      format: "links",
      mode: "enhanced",
    });
    expect(output()).toContain("Scrape completed");
    expect(output()).toContain("Provider: firecrawl");
    expect(output()).toContain("Billing category: enhanced.links");
    expect(output()).toContain("Credits charged: 20");
    expect(output()).toContain("https://example.com/a");
    expect(output()).toContain("https://example.com/b");
  });

  it("prints markdown in human-readable mode", async () => {
    server.use(
      dataRouterTool("web_scrape", () => {
        return HttpResponse.json({
          requestedUrl: "https://example.com",
          format: "markdown",
          mode: "standard",
          provider: "firecrawl",
          creditsCharged: 4,
          billingCategory: "standard.markdown",
          billingQuantity: 1,
          result: { markdown: "# Example\n\nContent" },
        });
      }),
    );

    await scrapeCommand.parseAsync(["node", "cli", "https://example.com"]);

    expect(output()).toContain("Scrape completed");
    expect(output()).toContain("Billing category: standard.markdown");
    expect(output()).toContain("Credits charged: 4");
    expect(output()).toContain("# Example\n\nContent");
  });

  it("prints API error messages", async () => {
    server.use(
      dataRouterTool("web_scrape", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Firecrawl rejected this scrape",
              code: "FIRECRAWL_ERROR",
            },
          },
          { status: 502 },
        );
      }),
    );

    await expect(async () => {
      await scrapeCommand.parseAsync(["node", "cli", "https://example.com"]);
    }).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain("502: Firecrawl rejected this scrape");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
