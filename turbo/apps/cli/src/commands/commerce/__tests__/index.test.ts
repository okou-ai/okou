import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AmazonMarketplace,
  CommerceJob,
  CommerceResponse,
} from "@okouai/api-contracts/contracts/commerce";
import type { Command } from "commander";
import { HttpResponse } from "msw";
import { dataRouterTool } from "../../../mocks/data-router";
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
import { commerceCommand } from "../index";

const api = "http://localhost:3000/api/commerce";
const product = { asin: "B0D1XD1ZV3", title: "Standing desk", price: 149.99 };

const jobId = "06a77350-1ee0-44db-9305-07d366bab7dc";

function response(
  operation: "inspect" | "search",
  marketplace: AmazonMarketplace = "amazon.com",
): CommerceResponse {
  return {
    operation,
    marketplace,
    provider: "dataforseo",
    billingCategory: "provider_cost_usd_micros",
    billingQuantity: 10000,
    providerCostUsd: 0.01,
    creditsCharged: 12,
    result: {
      items: [product],
      source: { status_code: 20000, cost: 0.01, tasks: [] },
    },
  };
}

function job(
  status: CommerceJob["status"],
  operation: CommerceJob["operation"] = "search",
  marketplace: AmazonMarketplace = "amazon.com",
): CommerceJob {
  return {
    id: jobId,
    status,
    operation,
    provider: "dataforseo",
    marketplace,
    result: status === "completed" ? response(operation, marketplace) : null,
    error:
      status === "failed"
        ? { code: "COMMERCE_PROVIDER_ERROR", message: "Provider task failed" }
        : null,
  };
}

function resetOptions(command: Command): void {
  for (const option of command.options) {
    command.setOptionValue(option.attributeName(), option.defaultValue);
  }
  for (const child of command.commands) resetOptions(child);
}

describe("managed Commerce commands", () => {
  const originalExitCode = process.exitCode;
  const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  let directory: string;

  beforeEach(async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    resetOptions(commerceCommand);
    process.exitCode = undefined;
    directory = await mkdtemp(join(tmpdir(), "okou-commerce-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    process.exitCode = originalExitCode;
    stdout.mockClear();
    stderr.mockClear();
  });

  afterAll(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  function output(): unknown {
    return JSON.parse(stdout.mock.calls.flat().join("\n"));
  }

  it("discovers the implemented Amazon operations and real cost model offline", async () => {
    vi.stubEnv("OKOU_TOKEN", "");
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "capabilities",
      "amazon",
      "--json",
    ]);
    expect(output()).toMatchObject({
      capabilities: [
        {
          platform: "amazon",
          operations: ["inspect", "search"],
          search: { maxResults: 48, maxPages: 1 },
          jobs: {
            providerPriority: 2,
            get: "okou data commerce job <id> [--wait] --json",
          },
          billing: { mode: "asynchronous" },
          export: { formats: ["json", "csv"] },
        },
      ],
    });
  });

  it("searches one explicitly selected marketplace and preserves billing and source metadata", async () => {
    let body: unknown;
    server.use(
      dataRouterTool(
        "commerce_search",
        `${api}/search`,
        async ({ request }) => {
          body = await request.json();
          // Supported rollback APIs still choose synchronous execution by default.
          if (
            typeof body !== "object" ||
            body === null ||
            !("async" in body) ||
            body.async !== true
          ) {
            return HttpResponse.json(response("search", "amazon.co.uk"));
          }
          return HttpResponse.json(job("running", "search", "amazon.co.uk"), {
            status: 202,
          });
        },
      ),
      dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
        return HttpResponse.json(job("completed", "search", "amazon.co.uk"));
      }),
    );
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "search",
      "standing desk",
      "--platform",
      "amazon",
      "--marketplace",
      "amazon.co.uk",
      "--limit",
      "20",
      "--json",
    ]);
    expect(body).toEqual({
      query: "standing desk",
      marketplace: "amazon.co.uk",
      limit: 20,
      async: true,
      requestId: expect.any(String),
    });
    expect(output()).toMatchObject({
      kind: "result",
      operation: "search",
      marketplace: "amazon.co.uk",
      creditsCharged: 12,
      data: { items: [product], source: { status_code: 20000 } },
    });
  });

  it.each(["B0D1XD1ZV3", "https://www.amazon.de/dp/B0D1XD1ZV3"])(
    "inspects %s without overriding the target marketplace",
    async (target) => {
      let body: unknown;
      server.use(
        dataRouterTool(
          "commerce_inspect",
          `${api}/inspect`,
          async ({ request }) => {
            body = await request.json();
            if (
              typeof body !== "object" ||
              body === null ||
              !("async" in body) ||
              body.async !== true
            ) {
              return HttpResponse.json(response("inspect"));
            }
            return HttpResponse.json(
              job(
                "running",
                "inspect",
                target.startsWith("https:") ? "amazon.de" : "amazon.com",
              ),
              { status: 202 },
            );
          },
        ),
        dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
          return HttpResponse.json(
            job(
              "completed",
              "inspect",
              target.startsWith("https:") ? "amazon.de" : "amazon.com",
            ),
          );
        }),
      );
      await commerceCommand.parseAsync([
        "node",
        "okou",
        "inspect",
        target,
        "--platform",
        "amazon",
        "--json",
      ]);
      expect(body).toEqual({
        target,
        async: true,
        requestId: expect.any(String),
      });
      expect(output()).toMatchObject({
        kind: "result",
        operation: "inspect",
        data: { items: [product] },
      });
    },
  );

  it("writes selected product rows to a local CSV and leaves billing in the stdout receipt", async () => {
    server.use(
      dataRouterTool("commerce_search", `${api}/search`, () => {
        return HttpResponse.json(job("running"), { status: 202 });
      }),
      dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
        return HttpResponse.json(job("completed"));
      }),
    );
    const destination = join(directory, "products.csv");
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "search",
      "standing desk",
      "--platform",
      "amazon",
      "--select",
      "title,price",
      "--format",
      "csv",
      "--output",
      destination,
      "--json",
    ]);
    expect(await readFile(destination, "utf8")).toBe(
      '"title","price"\r\n"Standing desk",149.99\r\n',
    );
    expect(output()).toMatchObject({
      kind: "export",
      creditsCharged: 12,
      export: {
        path: destination,
        format: "csv",
        fields: ["title", "price"],
        visibility: "local",
      },
    });
  });

  it("saves a full inspect JSON envelope with source and billing intact", async () => {
    server.use(
      dataRouterTool("commerce_inspect", `${api}/inspect`, () => {
        return HttpResponse.json(job("running", "inspect"), { status: 202 });
      }),
      dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
        return HttpResponse.json(job("completed", "inspect"));
      }),
    );
    const destination = join(directory, "product.json");
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "inspect",
      "B0D1XD1ZV3",
      "--platform",
      "amazon",
      "--output",
      destination,
      "--json",
    ]);
    expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({
      kind: "result",
      creditsCharged: 12,
      data: { items: [product], source: { cost: 0.01 } },
    });
    expect(output()).toMatchObject({
      kind: "export",
      export: { path: destination, format: "json" },
    });
  });

  it.each(["search", "inspect"] as const)(
    "waits for an asynchronous %s and preserves the existing final result envelope",
    async (operation) => {
      server.use(
        dataRouterTool(`commerce_${operation}`, `${api}/${operation}`, () => {
          return HttpResponse.json(job("pending", operation), { status: 202 });
        }),
        dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
          return HttpResponse.json(job("completed", operation));
        }),
      );
      await commerceCommand.parseAsync([
        "node",
        "okou",
        operation,
        operation === "search" ? "standing desk" : "B0D1XD1ZV3",
        "--platform",
        "amazon",
        "--json",
      ]);
      expect(output()).toMatchObject({
        kind: "result",
        operation,
        creditsCharged: 12,
        data: { items: [product], source: { status_code: 20000 } },
      });
    },
  );

  it("returns an async job receipt with its recovery command", async () => {
    server.use(
      dataRouterTool("commerce_search", `${api}/search`, () => {
        return HttpResponse.json(job("pending"), { status: 202 });
      }),
    );
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "search",
      "standing desk",
      "--platform",
      "amazon",
      "--async",
      "--json",
    ]);
    expect(output()).toMatchObject({
      id: jobId,
      status: "pending",
      result: null,
      recoveryCommand: `okou data commerce job ${jobId} --wait --json`,
    });
  });

  it("reads a saved job without starting a new paid operation", async () => {
    server.use(
      dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
        return HttpResponse.json(job("completed"));
      }),
    );
    await commerceCommand.parseAsync(["node", "okou", "job", jobId, "--json"]);
    expect(output()).toMatchObject({
      id: jobId,
      status: "completed",
      result: { creditsCharged: 12 },
    });
  });

  it("keeps polling running checkpoints until a saved job settles", async () => {
    let reads = 0;
    server.use(
      dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
        reads += 1;
        return HttpResponse.json(job(reads < 3 ? "running" : "completed"));
      }),
    );
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "job",
      jobId,
      "--wait",
      "--json",
    ]);
    expect(output()).toMatchObject({
      id: jobId,
      status: "completed",
      result: { result: { items: [product] } },
    });
  });

  it("exports the settled asynchronous result using the existing CSV contract", async () => {
    server.use(
      dataRouterTool("commerce_search", `${api}/search`, () => {
        return HttpResponse.json(job("running"), { status: 202 });
      }),
      dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
        return HttpResponse.json(job("completed"));
      }),
    );
    const destination = join(directory, "async-products.csv");
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "search",
      "standing desk",
      "--platform",
      "amazon",
      "--select",
      "title,price",
      "--format",
      "csv",
      "--output",
      destination,
      "--json",
    ]);
    expect(await readFile(destination, "utf8")).toBe(
      '"title","price"\r\n"Standing desk",149.99\r\n',
    );
    expect(output()).toMatchObject({
      kind: "export",
      creditsCharged: 12,
      export: { path: destination, format: "csv" },
    });
  });

  it("rejects async export options before a paid submission", async () => {
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "search",
      "standing desk",
      "--platform",
      "amazon",
      "--async",
      "--output",
      join(directory, "receipt.csv"),
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr.mock.calls.flat().join("\n"))).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("--async does not support") },
    });
  });

  it("recovers an uncertain transport submission by its generated request UUID", async () => {
    let requestId = "";
    let submissions = 0;
    server.use(
      dataRouterTool(
        "commerce_inspect",
        `${api}/inspect`,
        async ({ request }) => {
          submissions += 1;
          const body: unknown = await request.json();
          if (
            typeof body === "object" &&
            body !== null &&
            "requestId" in body &&
            typeof body.requestId === "string"
          ) {
            requestId = body.requestId;
          }
          return HttpResponse.error();
        },
      ),
    );
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "inspect",
      "B0D1XD1ZV3",
      "--platform",
      "amazon",
      "--json",
    ]);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(submissions).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr.mock.calls.flat().join("\n"))).toMatchObject({
      error: {
        code: "COMMERCE_SUBMISSION_UNCERTAIN",
        message: expect.stringContaining(
          `okou data commerce job ${requestId} --wait --json`,
        ),
      },
    });
  });

  it("reports an uncertain provider submission as failed with read-only recovery guidance", async () => {
    server.use(
      dataRouterTool("commerce_search", `${api}/search`, () => {
        return HttpResponse.json(
          {
            ...job("failed"),
            error: {
              code: "COMMERCE_SUBMISSION_UNCERTAIN",
              message:
                "Provider submission outcome is unknown; no automatic resubmission",
            },
          },
          { status: 202 },
        );
      }),
    );
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "search",
      "standing desk",
      "--platform",
      "amazon",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr.mock.calls.flat().join("\n"))).toMatchObject({
      error: {
        code: "COMMERCE_SUBMISSION_UNCERTAIN",
        retryable: false,
        message: expect.stringContaining(
          `Read it with: okou data commerce job ${jobId}`,
        ),
      },
    });
  });

  it("prints a failed saved job and exits unsuccessfully when waiting", async () => {
    server.use(
      dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
        return HttpResponse.json(job("failed"));
      }),
    );
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "job",
      jobId,
      "--wait",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    expect(output()).toMatchObject({
      id: jobId,
      status: "failed",
      error: { code: "COMMERCE_PROVIDER_ERROR" },
    });
  });

  it("retains the job ID when a status read fails", async () => {
    server.use(
      dataRouterTool("commerce_search", `${api}/search`, () => {
        return HttpResponse.json(job("pending"), { status: 202 });
      }),
      dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: "Temporarily unavailable",
            },
          },
          { status: 503 },
        );
      }),
    );
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "search",
      "standing desk",
      "--platform",
      "amazon",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr.mock.calls.flat().join("\n"))).toMatchObject({
      error: {
        code: "COMMERCE_JOB_READ_FAILED",
        message: expect.stringContaining(
          `okou data commerce job ${jobId} --wait --json`,
        ),
      },
    });
  });

  it("interrupts local waiting while preserving read-only recovery guidance", async () => {
    server.use(
      dataRouterTool("commerce_search", `${api}/search`, () => {
        return HttpResponse.json(job("pending"), { status: 202 });
      }),
      dataRouterTool("commerce_get", `${api}/jobs/${jobId}`, () => {
        process.emit("SIGINT");
        return HttpResponse.json(job("running"));
      }),
    );
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "search",
      "standing desk",
      "--platform",
      "amazon",
      "--json",
    ]);
    expect(process.exitCode).toBe(130);
    expect(JSON.parse(stderr.mock.calls.flat().join("\n"))).toMatchObject({
      status: "interrupted",
      jobId,
      recoveryCommand: `okou data commerce job ${jobId} --wait --json`,
    });
  });

  it("surfaces a managed billing rejection without retrying or claiming results", async () => {
    server.use(
      dataRouterTool("commerce_search", `${api}/search`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "INSUFFICIENT_CREDITS",
              message: "Insufficient credits for Commerce",
            },
          },
          { status: 402 },
        );
      }),
    );
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "search",
      "standing desk",
      "--platform",
      "amazon",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr.mock.calls.flat().join("\n"))).toMatchObject({
      status: "error",
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits for Commerce",
        retryable: false,
      },
    });
  });

  it("rejects conflicting URL marketplace selection before a billed request", async () => {
    await commerceCommand.parseAsync([
      "node",
      "okou",
      "inspect",
      "https://www.amazon.de/dp/B0D1XD1ZV3",
      "--platform",
      "amazon",
      "--marketplace",
      "amazon.com",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr.mock.calls.flat().join("\n"))).toMatchObject({
      status: "error",
      error: { message: "Marketplace must match the Amazon product URL" },
    });
  });
});
