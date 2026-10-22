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
import { peopleSearchCommand } from "../index";

const responseBody = {
  query: "platform engineering leaders",
  limit: 5,
  provider: "perplexity",
  billingCategory: "request",
  billingQuantity: 1,
  creditsCharged: 20,
  profiles: [
    {
      name: "Jordan Lee",
      title: "VP of Platform",
      company: "Example",
      location: "San Francisco",
      summary: "Leads the public platform engineering organization.",
      sources: [
        {
          title: "Example leadership",
          url: "https://example.com/leadership",
        },
      ],
    },
  ],
} as const;

describe("okou data people search command", () => {
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
    for (const option of peopleSearchCommand.options) {
      peopleSearchCommand.setOptionValue(
        option.attributeName(),
        option.defaultValue,
      );
    }
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

  it("documents the default and maximum profile limits", () => {
    const help = peopleSearchCommand.helpInformation().replace(/\s+/gu, " ");

    expect(help).toContain(
      "Maximum profiles (research: 1-20; prospect: 1-100)",
    );
    expect(help).toContain("(default: 5)");
  });

  it("requires the prospect backend before accepting a free quote flag", async () => {
    await expect(
      peopleSearchCommand.parseAsync([
        "node",
        "cli",
        "marketing leaders",
        "--dry-run",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(errorOutput()).toContain("--dry-run requires --backend prospect");
  });

  it("posts default requests and prints JSON", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/people-search",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(responseBody);
        },
      ),
    );

    await peopleSearchCommand.parseAsync([
      "node",
      "cli",
      "platform engineering leaders",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      query: "platform engineering leaders",
      limit: 5,
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(responseBody));
  });

  it("renders normalized profiles, sources, and billing", async () => {
    server.use(
      http.post("http://localhost:3000/api/people-search", () => {
        return HttpResponse.json({ ...responseBody, limit: 3 });
      }),
    );

    await peopleSearchCommand.parseAsync([
      "node",
      "cli",
      "platform engineering leaders",
      "--limit",
      "3",
    ]);

    expect(output()).toContain("People search completed");
    expect(output()).toContain("Credits charged: 20");
    expect(output()).toContain("1. Jordan Lee");
    expect(output()).toContain("Title: VP of Platform");
    expect(output()).toContain("Company: Example");
    expect(output()).toContain("Location: San Francisco");
    expect(output()).toContain("1. Example leadership");
    expect(output()).toContain("https://example.com/leadership");
  });

  it("guides users when no profiles match", async () => {
    server.use(
      http.post("http://localhost:3000/api/people-search", () => {
        return HttpResponse.json({ ...responseBody, profiles: [] });
      }),
    );

    await peopleSearchCommand.parseAsync([
      "node",
      "cli",
      "very narrow professional query",
    ]);

    expect(output()).toContain("No matching professionals found");
    expect(output()).toContain("broader role, company, skill, or location");
  });

  it.each([
    ["invalid limit", ["query", "--limit", "101"], "limit must be"],
    ["empty query", ["   "], "Too small"],
  ])("rejects %s before calling the API", async (_name, args, message) => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/people-search", () => {
        apiRequests += 1;
        return HttpResponse.json(responseBody);
      }),
    );

    await expect(
      peopleSearchCommand.parseAsync(["node", "cli", ...args]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(message);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(apiRequests).toBe(0);
  });

  it("prints API error messages", async () => {
    server.use(
      http.post("http://localhost:3000/api/people-search", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Missing required capability: people-search:read",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(
      peopleSearchCommand.parseAsync(["node", "cli", "leaders"]),
    ).rejects.toThrow("process.exit called");

    expect(errorOutput()).toContain(
      "403: Missing required capability: people-search:read",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
