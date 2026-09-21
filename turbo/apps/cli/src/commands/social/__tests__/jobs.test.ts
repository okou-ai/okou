import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SocialDataJobResponse } from "@okouai/api-contracts/contracts/social-data";
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
import { socialCommand } from "../index";

const jobId = "e36218c1-94a9-4728-9a4d-d41c4c73a720";
const requestId = "d835e249-b217-4c41-9c41-48da45d592b0";
const api = "http://localhost:3000/api/social/data";

function job(
  overrides: Partial<SocialDataJobResponse> = {},
): SocialDataJobResponse {
  return {
    jobId,
    requestId,
    platform: "facebook",
    operation: "comments",
    status: "completed",
    data: { items: [{ id: "comment-1", text: "Useful feedback", likes: 4 }] },
    billing: {
      state: "settled",
      creditsCharged: 7,
      reservedCredits: 0,
      maxCredits: 9,
    },
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:01.000Z",
    ...overrides,
  };
}

function resetOptions(command: Command): void {
  for (const option of command.options) {
    command.setOptionValue(option.attributeName(), option.defaultValue);
  }
  for (const child of command.commands) resetOptions(child);
}

describe("saved Social data jobs", () => {
  const originalExitCode = process.exitCode;
  let directory: string;
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
    return true;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });

  beforeEach(async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    resetOptions(socialCommand);
    directory = await mkdtemp(join(tmpdir(), "okou-social-jobs-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
    output.mockClear();
    errors.mockClear();
    stderr.mockClear();
    exit.mockClear();
  });

  afterAll(() => {
    output.mockRestore();
    errors.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
  });

  function stdout(): string {
    return output.mock.calls.flat().join("\n");
  }

  it("quotes Facebook posts through the free API without invoking a legacy intent", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(`${api}/quote`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          platform: "facebook",
          operation: "posts",
          estimatedCredits: 7,
          maxCredits: 9,
          quantity: 20,
          unit: "result",
        });
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "posts",
      "https://www.facebook.com/example",
      "--limit",
      "20",
      "--dry-run",
      "--max-credits",
      "8",
      "--json",
    ]);
    expect(requests).toEqual([
      {
        operation: "posts",
        platform: "facebook",
        url: "https://www.facebook.com/example",
        limit: 20,
      },
    ]);
    expect(JSON.parse(stdout())).toMatchObject({
      kind: "quote",
      maxCredits: 9,
      quantity: 20,
      budget: { maxCredits: 8, fits: false },
    });
  });

  it("routes a Xiaohongshu note URL to a saved job", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(`${api}/quote`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          platform: "xiaohongshu",
          operation: "comments",
          estimatedCredits: 19,
          maxCredits: 19,
          quantity: 1,
          unit: "request",
        });
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://www.xiaohongshu.com/explore/6a402c900000000006021700",
      "--limit",
      "20",
      "--dry-run",
      "--json",
    ]);
    expect(requests).toEqual([
      {
        operation: "comments",
        platform: "xiaohongshu",
        url: "https://www.xiaohongshu.com/explore/6a402c900000000006021700",
        limit: 20,
      },
    ]);
    expect(JSON.parse(stdout())).toMatchObject({
      kind: "quote",
      quantity: 1,
    });
  });

  it("routes an xhslink share link to a saved job without rewriting it", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(`${api}/quote`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          platform: "xiaohongshu",
          operation: "posts",
          estimatedCredits: 19,
          maxCredits: 19,
          quantity: 1,
          unit: "request",
        });
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "posts",
      "https://xhslink.com/m/3ZSCJZAMz0a",
      "--dry-run",
      "--json",
    ]);
    expect(requests).toEqual([
      {
        operation: "posts",
        platform: "xiaohongshu",
        url: "https://xhslink.com/m/3ZSCJZAMz0a",
        limit: 10,
      },
    ]);
  });

  it("searches Xiaohongshu by name only through saved jobs", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(`${api}/quote`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          platform: "xiaohongshu",
          operation: "search",
          estimatedCredits: 19,
          maxCredits: 19,
          quantity: 1,
          unit: "request",
        });
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "search",
      "\u5496\u5561\u5e97\u63a2\u5e97",
      "--platform",
      "xiaohongshu",
      "--dry-run",
      "--json",
    ]);
    expect(requests).toEqual([
      {
        operation: "search",
        platform: "xiaohongshu",
        query: "\u5496\u5561\u5e97\u63a2\u5e97",
        limit: 10,
      },
    ]);
  });

  it("rejects a Xiaohongshu search that does not ask for a saved job", async () => {
    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "search",
        "\u5496\u5561\u5e97\u63a2\u5e97",
        "--platform",
        "xiaohongshu",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(`${stdout()}${errors.mock.calls.flat().join("\n")}`).toContain(
      "saved data job",
    );
  });

  it("submits an async job with the caller's idempotency key and hard credit cap", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(`${api}/jobs`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json(job({ status: "pending", data: null }), {
          status: 202,
        });
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://www.facebook.com/example/posts/123",
      "--limit",
      "100",
      "--max-credits",
      "12",
      "--request-id",
      requestId,
      "--async",
      "--json",
    ]);
    expect(requests).toEqual([
      {
        operation: "comments",
        platform: "facebook",
        url: "https://www.facebook.com/example/posts/123",
        limit: 100,
        maxCredits: 12,
        requestId,
      },
    ]);
    expect(JSON.parse(stdout())).toMatchObject({
      jobId,
      status: "pending",
      recoveryCommand: `okou social jobs get ${jobId} --wait --json`,
    });
  });

  it("exports completed job rows through the existing CSV serializer", async () => {
    server.use(
      http.post(`${api}/jobs`, () => {
        return HttpResponse.json(job(), { status: 202 });
      }),
    );
    const destination = join(directory, "comments.csv");
    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://www.facebook.com/example/posts/123",
      "--max-credits",
      "12",
      "--format",
      "csv",
      "--select",
      "text,likes",
      "--output",
      destination,
      "--json",
    ]);
    expect(await readFile(destination, "utf8")).toBe(
      '"text","likes"\r\n"Useful feedback",4\r\n',
    );
    expect(JSON.parse(stdout())).toMatchObject({
      kind: "export",
      jobId,
      status: "completed",
      billing: { creditsCharged: 7 },
      export: { path: destination, format: "csv" },
    });
    expect(stdout()).not.toContain("Useful feedback");
  });

  it("exports normalized timestamped transcripts without another collection", async () => {
    server.use(
      http.post(`${api}/jobs`, () => {
        return HttpResponse.json(
          job({
            platform: "youtube",
            operation: "transcript",
            data: {
              transcript: "Hello",
              language: "en",
              segments: [{ text: "Hello", start: 0, duration: 1 }],
            },
          }),
          { status: 202 },
        );
      }),
    );
    const destination = join(directory, "captions.vtt");
    await socialCommand.parseAsync([
      "node",
      "okou",
      "transcript",
      "https://youtu.be/abcdefghijk",
      "--max-credits",
      "12",
      "--format",
      "vtt",
      "--output",
      destination,
      "--json",
    ]);
    expect(await readFile(destination, "utf8")).toContain(
      "00:00:00.000 --> 00:00:01.000\nHello",
    );
    expect(JSON.parse(stdout())).toMatchObject({
      kind: "export",
      jobId,
      export: { language: "en" },
    });
  });

  it.each(["running", "completed"] as const)(
    "waits for a %s job's settlement only by reading the saved job",
    async (status) => {
      const methods: string[] = [];
      server.use(
        http.get(`${api}/jobs/${jobId}`, ({ request }) => {
          methods.push(request.method);
          return HttpResponse.json(
            methods.length === 1
              ? job({
                  status,
                  billing: {
                    state: "pending",
                    creditsCharged: 0,
                    reservedCredits: 9,
                    maxCredits: 9,
                  },
                })
              : job(),
          );
        }),
      );
      await socialCommand.parseAsync([
        "node",
        "okou",
        "jobs",
        "get",
        jobId,
        "--wait",
        "--json",
      ]);
      expect(JSON.parse(stdout())).toMatchObject({
        jobId,
        status: "completed",
        billing: { state: "settled", creditsCharged: 7 },
        data: { items: [{ text: "Useful feedback" }] },
      });
      expect(methods).toEqual(["GET", "GET"]);
    },
  );

  it("returns an unknown job for recovery without repeated polling", async () => {
    server.use(
      http.get(`${api}/jobs/${jobId}`, () => {
        return HttpResponse.json(
          job({
            status: "unknown",
            data: null,
            billing: {
              state: "pending",
              creditsCharged: 0,
              reservedCredits: 9,
              maxCredits: 9,
            },
          }),
        );
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "jobs",
      "get",
      jobId,
      "--wait",
      "--json",
    ]);
    expect(JSON.parse(stdout())).toMatchObject({
      jobId,
      status: "unknown",
      billing: { state: "pending" },
    });
    expect(process.exitCode).toBe(1);
  });

  it("lists a bounded page of saved jobs and forwards its opaque cursor", async () => {
    const queries: string[] = [];
    server.use(
      http.get(`${api}/jobs`, ({ request }) => {
        queries.push(new URL(request.url).search);
        return HttpResponse.json({ jobs: [job()], nextCursor: null });
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "jobs",
      "list",
      "--limit",
      "5",
      "--cursor",
      jobId,
      "--json",
    ]);
    expect(queries).toEqual([`?limit=5&cursor=${jobId}`]);
    expect(JSON.parse(stdout())).toMatchObject({
      jobs: [{ jobId }],
      nextCursor: null,
    });
  });

  it("cancels only the specified saved job", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${api}/jobs/${jobId}/cancel`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(job({ status: "cancelled" }));
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "jobs",
      "cancel",
      jobId,
      "--json",
    ]);
    expect(bodies).toEqual([{}]);
    expect(JSON.parse(stdout())).toMatchObject({ jobId, status: "cancelled" });
  });

  it.each([
    ["--async", "--stream"],
    ["--async", "--checkpoint", "progress.json"],
    ["--async", "--output", "comments.json"],
    ["--dry-run", "--select", "text"],
    ["--dry-run", "--async"],
    ["--dry-run", "--limit", "1001"],
    ["--max-credits", "0"],
  ])(
    "rejects unsupported job controls before any paid request: %j",
    async (...flags) => {
      const requests: string[] = [];
      server.use(
        http.all(`${api}/*`, ({ request }) => {
          requests.push(request.url);
          return HttpResponse.json({});
        }),
      );
      await expect(
        socialCommand.parseAsync([
          "node",
          "okou",
          "comments",
          "https://www.facebook.com/example/posts/123",
          ...flags,
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(requests).toEqual([]);
    },
  );

  it("retains the submission key when a network response is lost", async () => {
    server.use(
      http.post(`${api}/jobs`, () => {
        return HttpResponse.error();
      }),
    );
    await expect(
      socialCommand.parseAsync([
        "node",
        "okou",
        "comments",
        "https://www.facebook.com/example/posts/123",
        "--request-id",
        requestId,
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      `--request-id ${requestId}`,
    );
    expect(errors.mock.calls.flat().join("\n")).toContain(
      '"recovery":{"requestId":',
    );
  });

  it("prints only the documented job and result fields", async () => {
    server.use(
      http.get(`${api}/jobs/${jobId}`, () => {
        return HttpResponse.json({
          ...job(),
          sourceJobId: "private-task-id",
          toolEndpoint: "/internal-tool",
          billing: { ...job().billing, sourceCost: 123 },
          data: { items: [{ text: "Public text", accessToken: "not-public" }] },
        });
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "jobs",
      "get",
      jobId,
      "--json",
    ]);
    expect(JSON.parse(stdout())).toMatchObject({
      data: { items: [{ text: "Public text" }] },
    });
    expect(stdout()).not.toMatch(
      /sourceJobId|toolEndpoint|sourceCost|accessToken|not-public/u,
    );
  });

  it("retains job recovery guidance when waiting is interrupted", async () => {
    server.use(
      http.post(`${api}/jobs`, () => {
        return HttpResponse.json(job({ status: "running", data: null }), {
          status: 202,
        });
      }),
      http.get(`${api}/jobs/${jobId}`, () => {
        process.emit("SIGINT");
        return HttpResponse.json(job({ status: "running", data: null }));
      }),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://www.facebook.com/example/posts/123",
      "--max-credits",
      "12",
      "--json",
    ]);
    expect(process.exitCode).toBe(130);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      `okou social jobs get ${jobId} --wait --json`,
    );
    expect(stdout()).toBe("");
  });

  it("keeps the existing request protocol when no job controls are supplied", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(
        "http://localhost:3000/api/social/request",
        async ({ request }) => {
          requests.push(await request.json());
          return HttpResponse.json({
            tool: "facebook_comments",
            billingCategory: "request",
            billingQuantity: 1,
            creditsCharged: 3,
            collection: { state: "complete", itemsReturned: 1 },
            result: {
              comments: [{ id: "legacy-comment", text: "Existing result" }],
              hasMore: false,
            },
          });
        },
      ),
    );
    await socialCommand.parseAsync([
      "node",
      "okou",
      "comments",
      "https://www.facebook.com/example/posts/123",
      "--json",
    ]);
    expect(requests).toMatchObject([{ tool: "facebook_comments" }]);
    expect(JSON.parse(stdout())).toMatchObject({
      status: "complete",
      data: { items: [{ text: "Existing result" }] },
    });
  });
});
