import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { http, HttpResponse } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { server } from "../../../mocks/server";
import { peopleSearchCommand } from "../../people-search";
import { registerDataSearchCommands } from "../query";

const origin = "http://localhost:3000";
const jobId = "1c71bda8-a995-4a03-8099-a7af141c943d";
const requestId = "93768b3c-4d64-4e1b-b9b0-ce60ce620ea6";
const completed = {
  jobId,
  requestId,
  capability: "company.search",
  status: "completed",
  data: {
    items: [
      {
        name: "=Example",
        domain: "example.com",
        source: { url: "https://example.com/about" },
      },
    ],
  },
  billing: {
    state: "settled",
    creditsCharged: 20,
    reservedCredits: 0,
    maxCredits: 30,
  },
  createdAt: "2026-10-22T00:00:00Z",
  updatedAt: "2026-10-22T00:00:01Z",
};

function command(): Command {
  const data = new Command("data");
  data.addCommand(new Command("people").addCommand(peopleSearchCommand));
  data.addCommand(new Command("web"));
  registerDataSearchCommands(data);
  return data;
}

function parse(args: string[]): Promise<Command> {
  return command().parseAsync(["node", "okou", ...args]);
}

describe("Data Search business commands", () => {
  const directories: string[] = [];
  let log: MockInstance<typeof console.log>;
  let error: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", origin);
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    process.exitCode = undefined;
    for (const option of peopleSearchCommand.options) {
      peopleSearchCommand.setOptionValue(
        option.attributeName(),
        option.defaultValue,
      );
    }
  });

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => {
        return rm(directory, { recursive: true, force: true });
      }),
    );
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function output(): string {
    return log.mock.calls.flat().join("\n");
  }

  it("quotes structured company filters for free without creating a job", async () => {
    let body: unknown;
    let creates = 0;
    server.use(
      http.post(`${origin}/api/data/quote`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          capability: "company.search",
          estimatedCredits: 20,
          maxCredits: 30,
          quantity: 1,
          unit: "request",
        });
      }),
      http.post(`${origin}/api/data/jobs`, () => {
        creates += 1;
        return HttpResponse.json(completed, { status: 202 });
      }),
    );
    await parse([
      "company",
      "search",
      "--domains",
      "EXAMPLE.COM",
      "--sizes",
      "1-10,11-50",
      "--limit",
      "5",
      "--dry-run",
      "--json",
    ]);
    expect(body).toEqual({
      capability: "company.search",
      input: { domains: ["example.com"], sizes: ["1,10", "11,50"] },
      limit: 5,
    });
    expect(JSON.parse(output())).toMatchObject({
      estimatedCredits: 20,
      maxCredits: 30,
    });
    expect(creates).toBe(0);
  });

  it("quotes one company inspection by domain", async () => {
    let body: unknown;
    server.use(
      http.post(`${origin}/api/data/quote`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          capability: "company.inspect",
          estimatedCredits: 33,
          maxCredits: 33,
          quantity: 1,
          unit: "request",
        });
      }),
    );
    await parse([
      "company",
      "inspect",
      "--domain",
      "example.com",
      "--dry-run",
      "--json",
    ]);
    expect(body).toEqual({
      capability: "company.inspect",
      input: { domain: "example.com" },
      limit: 1,
    });
    expect(JSON.parse(output())).toMatchObject({ estimatedCredits: 33 });
  });

  it("defaults enrichment to one profile and sends an explicit idempotency key and budget", async () => {
    let body: unknown;
    server.use(
      http.post(`${origin}/api/data/jobs`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { ...completed, capability: "people.enrich" },
          { status: 202 },
        );
      }),
    );
    await parse([
      "people",
      "enrich",
      "--name",
      "Jordan Lee",
      "--domain",
      "example.com",
      "--max-credits",
      "30",
      "--request-id",
      requestId,
      "--json",
    ]);
    expect(body).toEqual({
      capability: "people.enrich",
      input: { name: "Jordan Lee", domain: "example.com", fields: ["profile"] },
      limit: 1,
      maxCredits: 30,
      requestId,
    });
    expect(JSON.parse(output())).toMatchObject({
      jobId,
      billing: { creditsCharged: 20 },
    });
  });

  it("requires explicit work-email selection and sends only named employer matching inputs", async () => {
    let body: unknown;
    server.use(
      http.post(`${origin}/api/data/quote`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          capability: "people.enrich",
          estimatedCredits: 20,
          maxCredits: 30,
          quantity: 1,
          unit: "request",
        });
      }),
    );
    await parse([
      "people",
      "enrich",
      "--first-name",
      "Jordan",
      "--last-name",
      "Lee",
      "--domain",
      "example.com",
      "--fields",
      "work-email",
      "--dry-run",
      "--json",
    ]);
    expect(body).toEqual({
      capability: "people.enrich",
      input: {
        firstName: "Jordan",
        lastName: "Lee",
        domain: "example.com",
        fields: ["work-email"],
      },
      limit: 1,
    });
  });

  it("routes the prospect backend through the people.search business capability", async () => {
    let body: unknown;
    server.use(
      http.post(`${origin}/api/data/jobs`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { ...completed, capability: "people.search" },
          { status: 202 },
        );
      }),
    );
    await parse([
      "people",
      "search",
      "marketing leaders",
      "--backend",
      "prospect",
      "--limit",
      "100",
      "--titles",
      "VP Marketing,CMO",
      "--company-domains",
      "example.com",
      "--max-credits",
      "30",
      "--request-id",
      requestId,
      "--json",
    ]);
    expect(body).toMatchObject({
      capability: "people.search",
      limit: 100,
      input: {
        query: "marketing leaders",
        titles: ["VP Marketing", "CMO"],
        companyDomains: ["example.com"],
      },
      maxCredits: 30,
      requestId,
    });
  });

  it("quotes structured prospects without requiring a free-text query", async () => {
    let body: unknown;
    server.use(
      http.post(`${origin}/api/data/quote`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          capability: "people.search",
          estimatedCredits: 0,
          maxCredits: 0,
          quantity: 1,
          unit: "request",
        });
      }),
    );
    await parse([
      "people",
      "search",
      "--backend",
      "prospect",
      "--titles",
      "Head of Marketing",
      "--dry-run",
      "--json",
    ]);
    expect(body).toEqual({
      capability: "people.search",
      input: { titles: ["Head of Marketing"] },
      limit: 5,
    });
    expect(JSON.parse(output())).toMatchObject({ estimatedCredits: 0 });
  });

  it("returns async jobs immediately and prints recovery guidance", async () => {
    let creates = 0;
    let reads = 0;
    server.use(
      http.post(`${origin}/api/data/jobs`, () => {
        creates += 1;
        return HttpResponse.json(
          {
            ...completed,
            status: "running",
            data: null,
            billing: { ...completed.billing, state: "pending" },
          },
          { status: 202 },
        );
      }),
      http.get(`${origin}/api/data/jobs/${jobId}`, () => {
        reads += 1;
        return HttpResponse.json(completed);
      }),
    );
    await parse([
      "company",
      "search",
      "--name",
      "Example",
      "--max-credits",
      "30",
      "--async",
      "--json",
    ]);
    expect(JSON.parse(output())).toMatchObject({
      status: "running",
      recovery: `okou data jobs get ${jobId} --wait --json`,
    });
    expect({ creates, reads }).toEqual({ creates: 1, reads: 0 });
  });

  it("waits by reading the created job without another paid submission", async () => {
    let creates = 0;
    let reads = 0;
    server.use(
      http.post(`${origin}/api/data/jobs`, () => {
        creates += 1;
        return HttpResponse.json(
          { ...completed, status: "running", data: null },
          { status: 202 },
        );
      }),
      http.get(`${origin}/api/data/jobs/${jobId}`, () => {
        reads += 1;
        return HttpResponse.json(completed);
      }),
    );
    await parse([
      "company",
      "search",
      "--name",
      "Example",
      "--max-credits",
      "30",
      "--json",
    ]);
    expect(JSON.parse(output())).toMatchObject({
      status: "completed",
      data: completed.data,
    });
    expect({ creates, reads }).toEqual({ creates: 1, reads: 1 });
  });

  it("honors a zero-second bound and leaves a recoverable saved job", async () => {
    let reads = 0;
    server.use(
      http.post(`${origin}/api/data/jobs`, () => {
        return HttpResponse.json(
          { ...completed, status: "pending", data: null },
          { status: 202 },
        );
      }),
      http.get(`${origin}/api/data/jobs/${jobId}`, () => {
        reads += 1;
        return HttpResponse.json(completed);
      }),
    );
    await parse([
      "company",
      "search",
      "--name",
      "Example",
      "--max-credits",
      "30",
      "--wait-seconds",
      "0",
      "--json",
    ]);
    expect(JSON.parse(output())).toMatchObject({ status: "pending", jobId });
    expect(reads).toBe(0);
  });

  it("preserves submission recovery on an ambiguous transport failure without retrying", async () => {
    let creates = 0;
    server.use(
      http.post(`${origin}/api/data/jobs`, () => {
        creates += 1;
        return HttpResponse.error();
      }),
    );
    await expect(
      parse([
        "company",
        "search",
        "--name",
        "Example",
        "--max-credits",
        "30",
        "--request-id",
        requestId,
      ]),
    ).rejects.toThrow("exit");
    expect(error.mock.calls.flat().join("\n")).toContain(
      `--request-id ${requestId}`,
    );
    expect(creates).toBe(1);
  });

  it("exports saved results to safe CSV with provenance and a billing receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "okou-data-export-"));
    directories.push(directory);
    const destination = join(directory, "companies.csv");
    server.use(
      http.get(`${origin}/api/data/jobs/${jobId}`, () => {
        return HttpResponse.json(completed);
      }),
    );
    await parse([
      "jobs",
      "get",
      jobId,
      "--format",
      "csv",
      "--select",
      "name,domain,source.url",
      "--output",
      destination,
      "--json",
    ]);
    expect(await readFile(destination, "utf8")).toContain(
      '"\'=Example","example.com","https://example.com/about"',
    );
    expect(JSON.parse(output())).toMatchObject({
      kind: "export",
      jobId,
      billing: { creditsCharged: 20 },
      export: { path: destination, format: "csv" },
    });
  });

  it("lists saved jobs with cursor/status filters and exposes the next cursor", async () => {
    let query: string | undefined;
    server.use(
      http.get(`${origin}/api/data/jobs`, ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ jobs: [completed], nextCursor: jobId });
      }),
    );
    await parse([
      "jobs",
      "list",
      "--status",
      "completed",
      "--limit",
      "5",
      "--cursor",
      requestId,
      "--json",
    ]);
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      limit: "5",
      status: "completed",
      cursor: requestId,
    });
    expect(JSON.parse(output())).toMatchObject({
      jobs: [{ jobId }],
      nextCursor: jobId,
    });
  });

  it.each([
    {
      args: [
        "traffic",
        "overview",
        "example.com",
        "--month",
        "2025-09",
        "--country",
        "US",
        "--device",
        "desktop",
        "--metrics",
        "visits,bounce_rate",
      ],
      capability: "traffic.overview",
      input: {
        domain: "example.com",
        month: "2025-09",
        country: "us",
        device: "desktop",
        metrics: ["visits", "bounce_rate"],
      },
      limit: 1,
    },
    {
      args: [
        "ads",
        "search",
        "productivity software",
        "--active",
        "--recency-days",
        "30",
      ],
      capability: "ads.search",
      input: { query: "productivity software", active: true, recencyDays: 30 },
      limit: 10,
    },
    {
      args: [
        "trends",
        "related",
        "AI assistant",
        "--geo",
        "US",
        "--time",
        "today 3-m",
        "--property",
        "web",
      ],
      capability: "trends.related",
      input: {
        keyword: "AI assistant",
        geo: "US",
        time: "today 3-m",
        property: "web",
      },
      limit: 10,
    },
    {
      args: ["creators", "search", "--bio", "business productivity"],
      capability: "creators.search",
      input: { bio: "business productivity" },
      limit: 10,
    },
    {
      args: [
        "web",
        "history",
        "https://example.com/",
        "--date",
        "20250101",
        "--limit",
        "20",
      ],
      capability: "web.history",
      input: { url: "https://example.com/", date: "20250101" },
      limit: 20,
    },
    {
      args: [
        "affiliate",
        "search",
        "example.com",
        "--country",
        "us",
        "--category",
        "software",
      ],
      capability: "affiliate.search",
      input: { query: "example.com", country: "US", category: "software" },
      limit: 10,
    },
    {
      args: [
        "apps",
        "profile",
        "com.example.app",
        "--country",
        "us",
        "--language",
        "en_US",
      ],
      capability: "apps.profile",
      input: { package: "com.example.app", country: "US", language: "en_US" },
      limit: 1,
    },
    {
      args: [
        "podcasts",
        "search",
        "Business stories",
        "--language",
        "en",
        "--topic",
        "business",
      ],
      capability: "podcasts.search",
      input: { query: "Business stories", language: "en", topic: "business" },
      limit: 10,
    },
    {
      args: [
        "finance",
        "company-profile",
        "--ticker",
        "MSFT",
        "--exchange",
        "NASDAQ",
      ],
      capability: "finance.company-profile",
      input: { ticker: "MSFT", exchange: "NASDAQ" },
      limit: 1,
    },
  ])(
    "quotes verified $capability using typed business fields",
    async ({ args, capability, input, limit }) => {
      let body: unknown;
      server.use(
        http.post(`${origin}/api/data/quote`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({
            capability,
            estimatedCredits: 5,
            maxCredits: 5,
            quantity: 1,
            unit: "request",
          });
        }),
      );
      await parse([...args, "--dry-run", "--json"]);
      expect(body).toEqual({ capability, input, limit });
      expect(JSON.parse(output())).toMatchObject({
        capability,
        estimatedCredits: 5,
      });
    },
  );

  it("discovers exact business capability schemas", async () => {
    server.use(
      http.get(`${origin}/api/data/capabilities`, () => {
        return HttpResponse.json({
          capabilities: [
            {
              id: "company.search",
              description: "Find companies",
              inputSchema: { type: "object" },
              limits: { default: 10, max: 100 },
              status: "available",
            },
          ],
        });
      }),
    );
    await parse(["discover", "company", "--json"]);
    expect(JSON.parse(output())).toMatchObject({
      capabilities: [{ id: "company.search", inputSchema: { type: "object" } }],
    });
  });
});
