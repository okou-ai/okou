import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { dataRouterTool } from "../../../mocks/data-router";
import { createDataCommand } from "../index";

const jobId = "d5c8a112-2312-43f7-8e1b-64ee290d919a";
const changedResult = {
  provider: "future-provider",
  result: { values: [null, false, { newField: "kept" }] },
  creditsCharged: { newFormat: 7 },
  extension: [1, 2],
};
function program(): Command {
  const root = new Command("okou").addCommand(createDataCommand());
  function reset(command: Command): void {
    for (const option of command.options)
      command.setOptionValue(option.attributeName(), option.defaultValue);
    command.commands.forEach(reset);
  }
  reset(root);
  return root;
}
const cases: {
  command: string[];
  tool: string;
  input: Record<string, unknown>;
}[] = [
  {
    command: ["web", "search", "coffee"],
    tool: "web_search",
    input: { query: "coffee", limit: 5 },
  },
  {
    command: ["web", "scrape", "https://example.com"],
    tool: "web_scrape",
    input: { url: "https://example.com", format: "markdown", mode: "standard" },
  },
  {
    command: ["people", "search", "founders"],
    tool: "people_search",
    input: { query: "founders" },
  },
  {
    command: ["maps", "search", "coffee in Paris"],
    tool: "maps_search",
    input: { query: "coffee in Paris" },
  },
  ...["search", "profile", "quote", "chart"].map((operation) => {
    return {
      command: ["finance", operation, "AAPL"],
      tool: `finance_${operation}`,
      input: operation === "search" ? { query: "AAPL" } : { symbol: "AAPL" },
    };
  }),
  ...[
    ["current"],
    ["forecast", "hourly"],
    ["forecast", "daily"],
    ["history", "hourly"],
    ["air-quality", "current"],
  ].map((path) => {
    return {
      command: ["weather", ...path, "--lat", "1", "--lng", "2"],
      tool: `weather_${path.join("_").replaceAll("-", "_")}`,
      input: { lat: 1, lng: 2 },
    };
  }),
  {
    command: ["seo", "serp", "coffee"],
    tool: "seo_serp",
    input: { query: "coffee" },
  },
  {
    command: ["seo", "keyword-ideas", "coffee"],
    tool: "seo_keyword_ideas",
    input: { keyword: "coffee" },
  },
  {
    command: ["seo", "ranked-keywords", "example.com"],
    tool: "seo_ranked_keywords",
    input: { target: "example.com" },
  },
  {
    command: ["seo", "backlinks-summary", "example.com"],
    tool: "seo_backlinks_summary",
    input: { target: "example.com" },
  },
  {
    command: ["social", "inspect", "https://www.instagram.com/p/example/"],
    tool: "instagram_stats",
    input: { url: "https://www.instagram.com/p/example/" },
  },
  {
    command: ["social", "posts", "https://www.instagram.com/example/"],
    tool: "instagram_channel_posts",
    input: { limit: 10 },
  },
  {
    command: ["social", "search", "coffee", "--platform", "tiktok"],
    tool: "tiktok_search",
    input: { query: "coffee" },
  },
  {
    command: ["social", "comments", "https://www.instagram.com/p/example/"],
    tool: "instagram_comments",
    input: { limit: 10 },
  },
  ...["transcript", "summarize"].map((operation) => {
    return {
      command: ["social", operation, "https://youtu.be/dQw4w9WgXcQ"],
      tool: `youtube_${operation}`,
      input: {},
    };
  }),
  { command: ["social", "status"], tool: "social_status", input: {} },
  {
    command: ["social", "downloads"],
    tool: "social_download_list",
    input: { limit: 20, requestIds: [] },
  },
  {
    command: [
      "social",
      "download",
      "https://youtu.be/dQw4w9WgXcQ",
      "--max-duration",
      "600",
    ],
    tool: "social_download_create",
    input: { platform: "youtube", maxDuration: 600 },
  },
  {
    command: ["social", "download", "--resume", jobId],
    tool: "social_download_get",
    input: { downloadId: jobId },
  },
  {
    command: ["social", "jobs", "get", jobId],
    tool: "social_data_get",
    input: { jobId },
  },
  {
    command: ["social", "jobs", "cancel", jobId],
    tool: "social_data_cancel",
    input: { jobId },
  },
  {
    command: ["social", "jobs", "list"],
    tool: "social_data_list",
    input: { limit: 20, requestIds: [] },
  },
  {
    command: ["commerce", "search", "desk", "--platform", "amazon"],
    tool: "commerce_search",
    input: { query: "desk" },
  },
  {
    command: ["commerce", "inspect", "B0D1XD1ZV3", "--platform", "amazon"],
    tool: "commerce_inspect",
    input: { target: "B0D1XD1ZV3" },
  },
  {
    command: ["commerce", "job", jobId],
    tool: "commerce_get",
    input: { id: jobId },
  },
  { command: ["capabilities"], tool: "data_capabilities", input: {} },
  { command: ["jobs", "get", jobId], tool: "data_get", input: { jobId } },
  { command: ["jobs", "cancel", jobId], tool: "data_cancel", input: { jobId } },
  {
    command: ["jobs", "list"],
    tool: "data_list",
    input: { limit: 20, requestIds: [] },
  },
];

describe("Data Router JSON passthrough", () => {
  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", "[]");
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });
  it.each(cases)(
    "$tool preserves the full response through its command",
    async ({ command, tool, input }) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      let received: unknown;
      server.use(
        dataRouterTool(tool, ({ toolArguments }) => {
          received = toolArguments;
          return HttpResponse.json(changedResult);
        }),
      );
      await program().parseAsync([
        "node",
        "okou",
        "data",
        ...command,
        "--json",
      ]);
      expect(received).toMatchObject(input);
      expect(log.mock.calls).toEqual([[JSON.stringify(changedResult)]]);
    },
  );
  it.each([null, [1, { future: true }], "plain JSON string", 42, false])(
    "prints any JSON value: %j",
    async (body) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      server.use(
        dataRouterTool("web_search", () => {
          return HttpResponse.json(body);
        }),
      );
      await program().parseAsync([
        "node",
        "okou",
        "data",
        "call",
        "web_search",
        "--input",
        '{"query":"coffee"}',
      ]);
      expect(log.mock.calls).toEqual([[JSON.stringify(body, null, 2)]]);
    },
  );
  it("preserves Router error details and reports a failed command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = {
      reason: "new-error-envelope",
      detail: { retryAfter: 42 },
      messages: ["source unavailable"],
    };
    server.use(
      dataRouterTool("web_search", () => {
        return HttpResponse.json(error, { status: 503 });
      }),
    );
    await program().parseAsync([
      "node",
      "okou",
      "data",
      "web",
      "search",
      "coffee",
      "--json",
    ]);
    expect(log.mock.calls).toEqual([[JSON.stringify(error)]]);
    expect(process.exitCode).toBe(1);
  });
  it("returns a pending receipt without reading result fields", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const receipt = {
      id: jobId,
      status: "pending",
      result: { future: "shape" },
      extra: [1, 2],
    };
    server.use(
      dataRouterTool("commerce_search", () => {
        return HttpResponse.json(receipt, { status: 202 });
      }),
    );
    await program().parseAsync([
      "node",
      "okou",
      "data",
      "commerce",
      "search",
      "desk",
      "--platform",
      "amazon",
      "--json",
    ]);
    expect(log.mock.calls).toEqual([[JSON.stringify(receipt)]]);
  });
  const submissions = [
    {
      command: ["company", "search", "--name", "Example"],
      quote: "data_quote",
      create: "data_create",
      input: { capability: "company.search", input: { name: "Example" } },
    },
    {
      command: ["social", "search", "coffee", "--platform", "douyin"],
      quote: "social_data_quote",
      create: "social_data_create",
      input: { platform: "douyin", operation: "search", query: "coffee" },
    },
    {
      command: ["social", "jobs", "continue", jobId],
      quote: "social_data_quote_continuation",
      create: "social_data_continue",
      input: { jobId },
    },
  ];
  it.each(submissions)(
    "prints $quote unchanged in dry-run mode",
    async ({ command, quote }) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      server.use(
        dataRouterTool(quote, () => {
          return HttpResponse.json(changedResult);
        }),
      );
      await program().parseAsync([
        "node",
        "okou",
        "data",
        ...command,
        "--dry-run",
        "--json",
      ]);
      expect(log.mock.calls).toEqual([[JSON.stringify(changedResult)]]);
    },
  );
  it.each(submissions)(
    "checks the budget and returns the $create receipt",
    async ({ command, quote, create, input }) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const requests: { tool: string; input: Record<string, unknown> }[] = [];
      server.use(
        dataRouterTool(quote, ({ toolArguments }) => {
          requests.push({ tool: quote, input: toolArguments });
          return HttpResponse.json({
            maxCredits: 7,
            futurePricing: { unit: "new-unit" },
          });
        }),
        dataRouterTool(create, ({ toolArguments }) => {
          requests.push({ tool: create, input: toolArguments });
          return HttpResponse.json(changedResult, { status: 202 });
        }),
      );
      await program().parseAsync([
        "node",
        "okou",
        "data",
        ...command,
        "--max-credits",
        "10",
        "--request-id",
        jobId,
        "--json",
      ]);
      expect(requests).toEqual([
        { tool: quote, input: expect.any(Object) },
        {
          tool: create,
          input: expect.objectContaining({
            ...input,
            maxCredits: 10,
            requestId: jobId,
          }),
        },
      ]);
      expect(log.mock.calls).toEqual([[JSON.stringify(changedResult)]]);
    },
  );
  it("enforces an explicit spending limit before submitting a job", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const requests: string[] = [];
    server.use(
      dataRouterTool("data_quote", () => {
        requests.push("quote");
        return HttpResponse.json({ maxCredits: 11 });
      }),
      dataRouterTool("data_create", () => {
        requests.push("create");
        return HttpResponse.json(changedResult);
      }),
    );
    await expect(
      program().parseAsync([
        "node",
        "okou",
        "data",
        "company",
        "search",
        "--name",
        "Example",
        "--max-credits",
        "10",
      ]),
    ).rejects.toThrow("exit");
    expect(requests).toEqual(["quote"]);
    expect(error.mock.calls.flat().join(" ")).toContain(
      "Quoted cost 11 credits exceeds --max-credits 10",
    );
  });

  it("reports an uncertain submission after a connection failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const submissions: unknown[] = [];
    server.use(
      dataRouterTool("commerce_search", ({ toolArguments }) => {
        submissions.push(toolArguments);
        return HttpResponse.error();
      }),
    );
    await expect(
      program().parseAsync([
        "node",
        "okou",
        "data",
        "commerce",
        "search",
        "desk",
        "--platform",
        "amazon",
      ]),
    ).rejects.toThrow("exit");
    expect(submissions).toHaveLength(1);
    expect(error.mock.calls.flat().join(" ")).toContain(
      "Do not resubmit automatically",
    );
  });
});
