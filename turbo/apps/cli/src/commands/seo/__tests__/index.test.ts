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
import { seoCommand } from "../index";

function dataForSeoResponse(operation: string, result: unknown) {
  return {
    operation,
    provider: "dataforseo",
    billingCategory: "provider_cost_usd_micros",
    billingQuantity: 24_000,
    providerCostUsd: 0.024,
    creditsCharged: 30,
    result,
  };
}

describe("okou seo command", () => {
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
    for (const command of seoCommand.commands) {
      command.setOptionValue("json", undefined);
      if (command.name() === "serp") {
        command.setOptionValue("engine", "google");
        command.setOptionValue("location", "United States");
        command.setOptionValue("language", "en");
        command.setOptionValue("device", "desktop");
        command.setOptionValue("limit", 10);
      } else if (command.name() === "backlinks-summary") {
        command.setOptionValue("excludeSubdomains", undefined);
      } else {
        command.setOptionValue("location", "United States");
        command.setOptionValue("language", "en");
        command.setOptionValue("limit", 100);
      }
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

  it("posts DataForSEO SERP options and prints the JSON response", async () => {
    let requestBody: unknown;
    const response = dataForSeoResponse("serp", {
      tasks: [{ result: [{ title: "Coffee" }] }],
    });
    server.use(
      http.post("http://localhost:3000/api/seo/serp", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json(response);
      }),
    );

    await seoCommand.parseAsync([
      "node",
      "cli",
      "serp",
      "coffee shops",
      "--engine",
      "google_maps",
      "--location",
      "Austin, Texas, United States",
      "--language",
      "en",
      "--device",
      "mobile",
      "--limit",
      "20",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      query: "coffee shops",
      provider: "dataforseo",
      engine: "google_maps",
      location: "Austin, Texas, United States",
      languageCode: "en",
      device: "mobile",
      limit: 20,
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(response));
  });

  it.each(["human", "json"] as const)(
    "reports partial SERP results in %s output without failing",
    async (format) => {
      const result = {
        status_code: 20_000,
        status_message: "Ok.",
        cost: 0.002,
        tasks_count: 1,
        tasks_error: 0,
        tasks: [
          {
            status_code: 40_106,
            status_message: "Task completed with partial results.",
            cost: 0.002,
            result: [{ items: [{ title: "Technical SEO guide" }] }],
          },
        ],
      };
      const response = {
        ...dataForSeoResponse("serp", result),
        billingQuantity: 2000,
        providerCostUsd: 0.002,
        creditsCharged: 3,
        partialResults: true,
      };
      server.use(
        http.post("http://localhost:3000/api/seo/serp", () => {
          return HttpResponse.json(response);
        }),
      );

      await seoCommand.parseAsync([
        "node",
        "okou",
        "serp",
        "technical seo",
        ...(format === "json" ? ["--json"] : []),
      ]);

      if (format === "json") {
        expect(mockConsoleLog.mock.calls).toStrictEqual([
          [JSON.stringify(response)],
        ]);
      } else {
        const output = mockConsoleLog.mock.calls.flat().join("\n");
        expect(output).toContain("completed with partial results");
        expect(output).toContain("some requested pages could not be retrieved");
        expect(output).toContain("Technical SEO guide");
        expect(output).toContain("Provider cost: $0.002000");
        expect(output).toContain("Credits charged: 3");
        expect(output).not.toContain("✓ SEO serp completed");
      }
      expect(mockConsoleError).not.toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();
    },
  );

  it("keeps provider failures unsuccessful instead of reporting partial success", async () => {
    server.use(
      http.post("http://localhost:3000/api/seo/serp", () => {
        return HttpResponse.json(
          {
            error: {
              code: "DATAFORSEO_UPSTREAM_ERROR",
              message: "DataForSEO upstream request failed",
            },
          },
          { status: 502 },
        );
      }),
    );

    await expect(
      seoCommand.parseAsync(["node", "okou", "serp", "technical seo"]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "DataForSEO upstream request failed",
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("posts DataForSEO keyword defaults and renders billing metadata", async () => {
    let requestBody: unknown;
    const response = dataForSeoResponse("keyword-ideas", {
      tasks: [{ result: [{ keyword: "seo audit" }] }],
    });
    server.use(
      http.post(
        "http://localhost:3000/api/seo/keyword-ideas",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(response);
        },
      ),
    );

    await seoCommand.parseAsync([
      "node",
      "cli",
      "keyword-ideas",
      "technical seo",
    ]);

    expect(requestBody).toStrictEqual({
      keyword: "technical seo",
      location: "United States",
      languageCode: "en",
      limit: 100,
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("SEO keyword-ideas completed");
    expect(output).toContain("Provider: dataforseo");
    expect(output).toContain("Provider cost: $0.024000");
    expect(output).toContain("Credits charged: 30");
    expect(output).not.toContain("partial results");
  });

  it("posts supported DataForSEO search engines", async () => {
    let requestBody: unknown;
    server.use(
      http.post("http://localhost:3000/api/seo/serp", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json(dataForSeoResponse("serp", {}));
      }),
    );

    await seoCommand.parseAsync([
      "node",
      "cli",
      "serp",
      "technical seo",
      "--engine",
      "bing",
      "--device",
      "mobile",
      "--limit",
      "20",
    ]);

    expect(requestBody).toStrictEqual({
      query: "technical seo",
      provider: "dataforseo",
      engine: "bing",
      location: "United States",
      languageCode: "en",
      device: "mobile",
      limit: 20,
    });
  });

  it("rejects mobile DataForSEO Google News before calling the API", async () => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/seo/serp", () => {
        apiRequests += 1;
        return HttpResponse.json(dataForSeoResponse("serp", {}));
      }),
    );

    await expect(
      seoCommand.parseAsync([
        "node",
        "cli",
        "serp",
        "ai news",
        "--engine",
        "google_news",
        "--device",
        "mobile",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = [
      ...mockConsoleError.mock.calls.flat(),
      ...mockStderrWrite.mock.calls.flat(),
    ]
      .map(String)
      .join("\n");
    expect(errors).toContain(
      "DataForSEO Google News supports only the desktop device",
    );
    expect(apiRequests).toBe(0);
  });

  it("explains DataForSEO engine compatibility in serp help", () => {
    const command = seoCommand.commands.find((candidate) => {
      return candidate.name() === "serp";
    });
    if (!command) {
      throw new Error("Okou SEO serp command is missing");
    }
    let help = "";
    command.configureOutput({
      writeOut: (value) => {
        help += value;
      },
    });

    command.outputHelp();

    expect(help).toContain("Provider:");
    expect(help).toContain("DataForSEO is the only managed SEO provider");
    expect(help).toContain("provider-reported cost +25%");
    expect(help).toContain("google_news  desktop only");
    expect(help).toContain("google_maps returns at most 20 results on mobile");
  });

  it.each(["keyword-ideas", "ranked-keywords"])(
    "explains supported locations in %s help",
    (operation) => {
      const command = seoCommand.commands.find((candidate) => {
        return candidate.name() === operation;
      });
      if (!command) {
        throw new Error(`Okou SEO ${operation} command is missing`);
      }
      let help = "";
      command.configureOutput({
        writeOut: (value) => {
          help += value;
        },
      });

      command.outputHelp();

      expect(help).toContain("country or region");
      expect(help).toContain("US/USA");
      expect(help).toContain("GB/UK");
      expect(help).toContain("City and state locations are not supported");
      expect(help).toContain(
        "https://docs.dataforseo.com/v3/dataforseo_labs_locations_and_languages/",
      );
    },
  );

  it("shows the API location guidance and exits unsuccessfully", async () => {
    const message =
      'Use a supported country or region, such as "United States" or "US". City and state locations are not supported.';
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/seo/keyword-ideas", () => {
        apiRequests += 1;
        return HttpResponse.json(
          { error: { code: "DATAFORSEO_INVALID_REQUEST", message } },
          { status: 400 },
        );
      }),
    );

    await expect(
      seoCommand.parseAsync([
        "node",
        "okou",
        "keyword-ideas",
        "technical seo",
        "--location",
        "Austin, Texas, United States",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(message);
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(apiRequests).toBe(1);
  });
});
