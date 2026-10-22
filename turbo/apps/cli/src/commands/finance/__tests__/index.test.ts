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
import { financeCommand } from "../index";

function financeResponse(operation: string, result: unknown) {
  return {
    operation,
    provider: "monid/yahoo-finance",
    billingCategory: "provider_cost_usd_micros",
    billingQuantity: 50_000,
    creditsCharged: 63,
    result,
  };
}

describe("okou finance command", () => {
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
    for (const command of financeCommand.commands) {
      command.setOptionValue("json", undefined);
      if (command.name() === "chart") {
        command.setOptionValue("range", "1y");
        command.setOptionValue("interval", "1d");
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

  it.each([
    {
      operation: "search",
      argument: "Tencent",
      request: { query: "Tencent" },
      result: {
        quotes: [
          {
            symbol: "0700.HK",
            shortname: "TENCENT",
            exchange: "HKG",
            quoteType: "EQUITY",
          },
        ],
      },
    },
    {
      operation: "profile",
      argument: "AAPL",
      request: { symbol: "AAPL" },
      result: {
        assetProfile: {
          sector: "Technology",
          industry: "Consumer Electronics",
          website: "https://www.apple.com",
        },
        financialData: { financialCurrency: "USD", currentPrice: 230.5 },
      },
    },
    {
      operation: "quote",
      argument: "0700.HK",
      request: { symbol: "0700.HK" },
      result: {
        quotes: [
          {
            symbol: "0700.HK",
            currency: "HKD",
            regularMarketPrice: 425.6,
            regularMarketVolume: 18342000,
            marketState: "CLOSED",
          },
        ],
      },
    },
  ])("posts $operation requests and prints JSON", async (example) => {
    let requestBody: unknown;
    const response = financeResponse(example.operation, example.result);
    server.use(
      http.post(
        `http://localhost:3000/api/finance/${example.operation}`,
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(response);
        },
      ),
    );

    await financeCommand.parseAsync([
      "node",
      "cli",
      example.operation,
      example.argument,
      "--json",
    ]);

    expect(requestBody).toStrictEqual(example.request);
    expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(response));
  });

  it("posts chart range and interval and renders raw provider data", async () => {
    let requestBody: unknown;
    const result = {
      symbol: "AAPL",
      range: "5y",
      interval: "1wk",
      prices: [
        {
          timestamp: 1725235200,
          open: 228.55,
          high: 229,
          low: 217.48,
          close: 220.82,
          volume: 204951200,
        },
      ],
    };
    server.use(
      http.post(
        "http://localhost:3000/api/finance/chart",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(financeResponse("chart", result));
        },
      ),
    );

    await financeCommand.parseAsync([
      "node",
      "cli",
      "chart",
      "AAPL",
      "--range",
      "5y",
      "--interval",
      "1wk",
    ]);

    expect(requestBody).toStrictEqual({
      symbol: "AAPL",
      range: "5y",
      interval: "1wk",
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Finance chart completed");
    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify(result, null, 2),
    );
    expect(output).toContain("Provider: monid/yahoo-finance");
    expect(output).toContain("Credits charged: 63");
  });

  it("documents Monid provider costs and configured credit pricing in help", () => {
    let help = "";
    const writeOut = financeCommand.configureOutput().writeOut;
    financeCommand.configureOutput({
      writeOut: (text: string) => {
        help += text;
      },
    });
    try {
      financeCommand.outputHelp();
    } finally {
      financeCommand.configureOutput({ writeOut });
    }

    expect(help).toContain("$0.05/call provider base cost");
    expect(help).toContain("credits are charged under configured pricing");
    expect(help).toContain(
      "native Monid output (provider: monid/yahoo-finance)",
    );
    expect(help).toContain("okou finance chart AAPL --range 1y --interval 1d");
  });

  it("rejects invalid chart intervals before calling the API", async () => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/finance/chart", () => {
        apiRequests += 1;
        return HttpResponse.json(financeResponse("chart", {}));
      }),
    );

    await expect(
      financeCommand.parseAsync([
        "node",
        "cli",
        "chart",
        "AAPL",
        "--interval",
        "4h",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = [
      ...mockConsoleError.mock.calls.flat(),
      ...mockStderrWrite.mock.calls.flat(),
    ]
      .map(String)
      .join("\n");
    expect(errors).toContain("interval must be one of");
    expect(apiRequests).toBe(0);
  });
});
