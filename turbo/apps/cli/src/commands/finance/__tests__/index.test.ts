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
import { financeCommand } from "../index";

function financeResponse(operation: string, result: unknown) {
  return {
    operation,
    provider: "apidojo",
    billingCategory: "request",
    billingQuantity: 1,
    creditsCharged: 1,
    result,
  };
}

describe("okou data finance command", () => {
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
      result: { quotes: [{ symbol: "0700.HK" }] },
    },
    {
      operation: "profile",
      argument: "AAPL",
      request: { symbol: "AAPL" },
      result: { assetProfile: { industry: "Consumer Electronics" } },
    },
    {
      operation: "quote",
      argument: "0700.HK",
      request: { symbol: "0700.HK" },
      result: { quoteResponse: { result: [{ symbol: "0700.HK" }] } },
    },
  ])("posts $operation requests and prints JSON", async (example) => {
    let requestBody: unknown;
    const response = financeResponse(example.operation, example.result);
    server.use(
      dataRouterTool(`finance_${example.operation}`, ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json(response);
      }),
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
      chart: { result: [{ meta: { symbol: "AAPL" }, timestamp: [1, 2] }] },
    };
    server.use(
      dataRouterTool("finance_chart", ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json(financeResponse("chart", result));
      }),
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
    expect(output).toContain('"symbol": "AAPL"');
    expect(output).toContain("Provider: apidojo");
    expect(output).toContain("Credits charged: 1");
  });

  it("rejects invalid chart intervals before calling the API", async () => {
    let apiRequests = 0;
    server.use(
      dataRouterTool("finance_chart", () => {
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
