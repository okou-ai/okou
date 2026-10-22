import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { http, HttpResponse } from "msw";
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

function response(operation: "inspect" | "search", marketplace = "amazon.com") {
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
          billing: { mode: "synchronous" },
          export: { formats: ["json", "csv"] },
        },
      ],
    });
  });

  it("searches one explicitly selected marketplace and preserves billing and source metadata", async () => {
    let body: unknown;
    server.use(
      http.post(`${api}/search`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(response("search", "amazon.co.uk"));
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
        http.post(`${api}/inspect`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json(
            response(
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
      expect(body).toEqual({ target });
      expect(output()).toMatchObject({
        kind: "result",
        operation: "inspect",
        data: { items: [product] },
      });
    },
  );

  it("writes selected product rows to a local CSV and leaves billing in the stdout receipt", async () => {
    server.use(
      http.post(`${api}/search`, () => {
        return HttpResponse.json(response("search"));
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
      http.post(`${api}/inspect`, () => {
        return HttpResponse.json(response("inspect"));
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

  it("surfaces a managed billing rejection without retrying or claiming results", async () => {
    server.use(
      http.post(`${api}/search`, () => {
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
