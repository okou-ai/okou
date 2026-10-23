import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DISABLED_PAID_TOOLS_ENV_VAR } from "@okouai/api-contracts/contracts/paid-tools";
import type { SocialKitDownloadResponse } from "@okouai/api-contracts/contracts/social";
import { Command } from "commander";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../mocks/server";
import { registerRequestedCommand } from "../okou";

const webSearchResponse = {
  query: "example",
  limit: 5,
  provider: "perplexity",
  billingCategory: "request",
  billingQuantity: 1,
  creditsCharged: 5,
  results: [],
};

const completedDownload = {
  downloadId: "6bdc3449-41ef-4624-a525-45bce09c67f0",
  status: "completed",
  platform: "youtube",
  requested: { quality: "720p", format: "mp4" },
  delivered: { quality: null, format: null },
  maxDuration: 600,
  billingCategory: "request",
  provider: {
    durationSeconds: 61,
    fileSizeMB: 2,
    creditsCost: 2,
    quality: "720p",
    format: "mp4",
  },
  billing: { quantity: 2, creditsCharged: 6 },
  download: {
    url: "https://media.example/video.mp4?signature=temporary-access",
    expiresAt: "2026-08-27T01:00:00.000Z",
  },
  error: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  completedAt: "2026-08-27T00:01:00.000Z",
} satisfies SocialKitDownloadResponse;

describe("personal paid-tool controls through the CLI entry point", () => {
  let directory: string;
  let requests: string[];
  let output: string;
  let errors: string;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "okou-paid-tools-"));
    requests = [];
    output = "";
    errors = "";
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, undefined);
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      output += values.join(" ") + "\n";
    });
    vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      errors += values.join(" ") + "\n";
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    server.use(
      http.all("*", ({ request }) => {
        requests.push(`${request.method} ${request.url}`);
        return HttpResponse.json(
          { error: { message: "Unexpected request" } },
          {
            status: 500,
          },
        );
      }),
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = originalExitCode;
  });

  async function run(args: string[]): Promise<void> {
    const argv = ["node", "okou", ...args];
    const program = new Command("okou");
    await registerRequestedCommand(program, argv);

    // Loaded command instances are reused by the production lazy registry.
    // Reset parsed options so each invocation represents a fresh CLI process.
    function reset(command: Command): void {
      command.exitOverride().configureOutput({
        writeOut: (text) => {
          output += text;
        },
        writeErr: (text) => {
          errors += text;
        },
      });
      for (const option of command.options) {
        command.setOptionValue(option.attributeName(), option.defaultValue);
      }
      command.commands.forEach(reset);
    }
    reset(program);
    await program.parseAsync(argv);
  }

  it.each([
    { tool: "web-search", args: ["data", "web", "search", "example"] },
    { tool: "people-search", args: ["data", "people", "search", "example"] },
    { tool: "scrape", args: ["data", "web", "scrape", "https://example.com"] },
    { tool: "finance", args: ["data", "finance", "quote", "AAPL"] },
    {
      tool: "maps",
      args: ["data", "maps", "search", "coffee near Union Square"],
    },
    { tool: "seo", args: ["data", "seo", "serp", "example"] },
    {
      tool: "social",
      args: ["data", "social", "inspect", "https://x.com/example"],
    },
    {
      tool: "image-generation",
      args: [
        "generate",
        "image",
        "--raw-prompt",
        "A fox",
        "--visibility",
        "public",
      ],
    },
    {
      tool: "image-generation",
      args: ["generate", "image", "--compiled-prompt", "A fox"],
    },
  ])("rejects disabled $tool before any request", async ({ tool, args }) => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, JSON.stringify([tool]));

    await expect(run(args)).rejects.toThrow("process.exit(1)");

    expect(errors).toContain(`Paid tool "${tool}" is disabled`);
    expect(errors).toContain("Settings > Personal > Tools");
    expect(errors).toContain("http://localhost:3000/?settings=tools");
    expect(requests).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['["data-search", "people-search"]', "invalid"])(
    "permits free advanced discovery, quotes, saved reads and cancellation under %s",
    async (policy) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, policy);
      const jobId = "1c71bda8-a995-4a03-8099-a7af141c943d";
      const job = {
        jobId,
        requestId: "93768b3c-4d64-4e1b-b9b0-ce60ce620ea6",
        capability: "company.search",
        status: "completed",
        data: { items: [] },
        billing: {
          state: "settled",
          creditsCharged: 10,
          reservedCredits: 10,
          maxCredits: 20,
        },
        createdAt: "2026-10-22T00:00:00Z",
        updatedAt: "2026-10-22T00:00:01Z",
      };
      const operations: string[] = [];
      server.use(
        http.get("http://localhost:3000/api/data/capabilities", () => {
          operations.push("capabilities");
          return HttpResponse.json({ capabilities: [] });
        }),
        http.post(
          "http://localhost:3000/api/data/quote",
          async ({ request }) => {
            const body = (await request.json()) as { capability: string };
            operations.push(`quote:${body.capability}`);
            return HttpResponse.json({
              capability: body.capability,
              estimatedCredits: 10,
              maxCredits: 20,
              quantity: 1,
              unit: "request",
            });
          },
        ),
        http.get("http://localhost:3000/api/data/jobs", () => {
          operations.push("list");
          return HttpResponse.json({ jobs: [job], nextCursor: null });
        }),
        http.get("http://localhost:3000/api/data/jobs/:jobId", () => {
          operations.push("get");
          return HttpResponse.json(job);
        }),
        http.post("http://localhost:3000/api/data/jobs/:jobId/cancel", () => {
          operations.push("cancel");
          return HttpResponse.json(job);
        }),
      );
      await run(["data", "capabilities", "--json"]);
      await run([
        "data",
        "company",
        "search",
        "--domains",
        "example.com",
        "--dry-run",
        "--json",
      ]);
      await run([
        "data",
        "people",
        "search",
        "marketing leaders",
        "--backend",
        "prospect",
        "--dry-run",
        "--json",
      ]);
      await run(["data", "jobs", "list", "--json"]);
      await run(["data", "jobs", "get", jobId, "--json"]);
      await run(["data", "jobs", "cancel", jobId, "--json"]);
      expect(operations).toEqual([
        "capabilities",
        "quote:company.search",
        "quote:people.search",
        "list",
        "get",
        "cancel",
      ]);
      expect(errors).toBe("");
      expect(requests).toEqual([]);
    },
  );

  it.each(['["social"]', "invalid"])(
    "permits free social job quotes and saved-job recovery under %s",
    async (policy) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, policy);
      const jobId = "e36218c1-94a9-4728-9a4d-d41c4c73a720";
      const job = {
        jobId,
        requestId: "d835e249-b217-4c41-9c41-48da45d592b0",
        platform: "facebook",
        operation: "comments",
        status: "completed",
        data: { items: [] },
        billing: {
          state: "settled",
          creditsCharged: 7,
          reservedCredits: 0,
          maxCredits: 9,
        },
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:01.000Z",
      };
      server.use(
        http.post("http://localhost:3000/api/social/data/quote", () => {
          return HttpResponse.json({
            platform: "facebook",
            operation: "comments",
            estimatedCredits: 7,
            maxCredits: 9,
            quantity: 1,
            unit: "request",
          });
        }),
        http.get("http://localhost:3000/api/social/data/jobs", () => {
          return HttpResponse.json({ jobs: [job], nextCursor: null });
        }),
        http.get("http://localhost:3000/api/social/data/jobs/:jobId", () => {
          return HttpResponse.json(job);
        }),
        http.post(
          "http://localhost:3000/api/social/data/jobs/:jobId/cancel",
          () => {
            return HttpResponse.json(job);
          },
        ),
      );
      await run([
        "data",
        "social",
        "comments",
        "https://www.facebook.com/example/posts/123",
        "--dry-run",
        "--json",
      ]);
      expect(output).toContain('"kind":"quote"');
      await run(["data", "social", "jobs", "list", "--json"]);
      await run(["data", "social", "jobs", "get", jobId, "--json"]);
      await run(["data", "social", "jobs", "cancel", jobId, "--json"]);
      expect(output).toContain(jobId);
      expect(errors).toBe("");
      expect(requests).toEqual([]);
    },
  );

  it("keeps historical research independent from the advanced preference", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["data-search"]');
    server.use(
      http.post("http://localhost:3000/api/web-search", () => {
        return HttpResponse.json(webSearchResponse);
      }),
    );
    await run(["data", "web", "search", "example", "--json"]);
    expect(output).toContain('"results":[]');
    expect(errors).toBe("");
    expect(requests).toEqual([]);
  });

  it.each(["start", "__run"])(
    "rejects disabled image-batch %s without creating worker state or output",
    async (operation) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["image-generation"]');
      const manifest = join(directory, "images.tsv");
      const state = join(directory, "state");
      await writeFile(manifest, "hero\tA fox\n");
      if (operation === "__run") await mkdir(state);

      await expect(
        run(["generate", "image-batch", operation, manifest, state]),
      ).rejects.toThrow("process.exit(1)");

      expect(errors).toContain('Paid tool "image-generation" is disabled');
      expect(requests).toEqual([]);
      expect(output).toBe("");
      if (operation === "__run") {
        expect(await readdir(state)).toEqual([]);
      } else {
        expect(await readdir(directory)).toEqual(["images.tsv"]);
      }
    },
  );

  it.each([
    {
      tool: "image-generation",
      args: [
        "image",
        "--style",
        "image-style:ink-storefront",
        "--prompt",
        "A fox",
        "--compile",
      ],
      expected: "image prompt-compilation packet",
    },
  ])(
    "keeps free $tool authoring available under disabled or invalid policy",
    async ({ tool, args, expected }) => {
      for (const policy of [JSON.stringify([tool]), "invalid"]) {
        vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, policy);
        await run(["generate", ...args]);
        expect(output).toContain(expected);
        expect(errors).toBe("");
        expect(requests).toEqual([]);
      }
    },
  );

  it("keeps completed image-batch results readable when generation is disabled", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["image-generation"]');
    await writeFile(join(directory, "pid"), String(process.pid));
    await writeFile(join(directory, "done"), "0\n");
    await writeFile(
      join(directory, "results.tsv"),
      "hero\thttps://example.com/hero.png\n",
    );

    await run(["generate", "image-batch", "wait", directory]);

    expect(output).toContain("hero\thttps://example.com/hero.png");
    expect(errors).toBe("");
    expect(requests).toEqual([]);
  });

  it("rejects built-in media execution with malformed policy", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, "invalid");
    await expect(
      run(["generate", "image", "--raw-prompt", "A fox"]),
    ).rejects.toThrow("process.exit(1)");
    expect(errors).toContain("Paid tool configuration is invalid");
    expect(requests).toEqual([]);
  });

  it.each([{ args: ["generate", "image"], tool: "image-generation" }])(
    "annotates relevant media help for $tool",
    async ({ args, tool }) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["image-generation"]');
      await expect(run([...args, "--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      expect(output).toContain(`Disabled paid tools in this run: ${tool}.`);
      expect(output).toContain("Settings > Personal > Tools");
      expect(requests).toEqual([]);
    },
  );

  it.each([
    {
      api: "https://api.okou.ai",
      app: undefined,
      expected: "https://app.okou.ai/?settings=tools",
    },
    {
      api: "https://staging-api.vm6.ai",
      app: undefined,
      expected: "https://staging-app.omby.ai/?settings=tools",
    },
    {
      api: "https://pr-123-api.vm6.ai",
      app: undefined,
      expected: "https://pr-123-app.omby.ai/?settings=tools",
    },
    {
      api: "https://api.okou.ai",
      app: "https://preview.example.test/path",
      expected: "https://preview.example.test/?settings=tools",
    },
  ])(
    "uses the current platform recovery URL for $expected",
    async ({ api, app, expected }) => {
      vi.stubEnv("OKOU_API_BACKEND_URL", api);
      vi.stubEnv("OKOU_APP_URL", app);
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["web-search"]');
      await expect(run(["data", "web", "search", "example"])).rejects.toThrow(
        "process.exit(1)",
      );
      expect(errors).toContain(expected);
      expect(requests).toEqual([]);
    },
  );

  it.each([undefined, "", "   ", "[]", '["future-tool"]', '["finance"]'])(
    "permits an enabled operation under policy %s",
    async (policy) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, policy);
      let paidRequests = 0;
      server.use(
        http.post("http://localhost:3000/api/web-search", () => {
          paidRequests += 1;
          return HttpResponse.json(webSearchResponse);
        }),
      );
      await run(["data", "web", "search", "example", "--json"]);
      expect(paidRequests).toBe(1);
      expect(output).toContain('"results":[]');
      expect(errors).toBe("");
    },
  );

  it.each(["not-json", "null", "{}", '"web-search"', '["web-search", 1]'])(
    "rejects paid execution but permits free discovery for malformed policy %s",
    async (policy) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, policy);
      await expect(run(["data", "web", "search", "example"])).rejects.toThrow(
        "process.exit(1)",
      );
      expect(errors).toContain("Paid tool configuration is invalid");
      expect(errors).toContain(DISABLED_PAID_TOOLS_ENV_VAR);
      await run(["data", "social", "capabilities", "--json"]);
      expect(output).toContain('"capabilities"');
      expect(requests).toEqual([]);
    },
  );

  it("preserves help and annotates disabled commands at root and nested levels", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["maps", "future-tool"]');
    await expect(run(["--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    expect(output).toContain("Disabled paid tools in this run: maps.");
    expect(output).not.toContain("future-tool");
    output = "";
    await expect(
      run(["data", "maps", "search", "--help"]),
    ).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    expect(output).toContain("Disabled paid tools in this run: maps.");
    expect(requests).toEqual([]);
  });

  it("keeps help available with malformed policy", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, "invalid");
    await expect(
      run(["data", "web", "search", "--help"]),
    ).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    expect(output).toContain("paid-tool configuration is invalid");
    expect(requests).toEqual([]);
  });

  it("blocks a Maps search before issuing a request", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["maps"]');
    await expect(
      run(["data", "maps", "search", "coffee near Union Square"]),
    ).rejects.toThrow("process.exit(1)");
    expect(requests).toEqual([]);
  });

  it.each([
    "posts",
    "search",
    "comments",
    "resume",
    "transcript",
    "summarize",
    "download",
  ])(
    "blocks paid social %s including local collection effects",
    async (operation) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["social"]');
      const args =
        operation === "search"
          ? [
              "example",
              "--platform",
              "youtube",
              "--checkpoint",
              join(directory, "checkpoint.json"),
            ]
          : operation === "resume"
            ? [join(directory, "missing-checkpoint.json")]
            : operation === "download"
              ? ["https://youtu.be/example", "--max-duration", "600"]
              : ["https://youtu.be/example"];
      await expect(run(["data", "social", operation, ...args])).rejects.toThrow(
        "process.exit(1)",
      );
      expect(errors).toContain('Paid tool "social" is disabled');
      expect(requests).toEqual([]);
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it("keeps offline social capabilities available", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["social"]');
    await run(["data", "social", "capabilities", "--json"]);
    expect(output).toContain('"capabilities"');
    expect(requests).toEqual([]);
  });

  it("keeps social health and saved download listing available", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["social"]');
    const reads: string[] = [];
    server.use(
      http.get("http://localhost:3000/api/social/status", () => {
        reads.push("status");
        return HttpResponse.json({
          observedAt: "2026-09-14T09:00:00.000Z",
          staleAfterSeconds: 300,
          overall: {
            status: "healthy",
            updatedAt: "2026-09-14T09:00:00.000Z",
            reason: null,
          },
          operations: [],
        });
      }),
      http.get("http://localhost:3000/api/social/downloads", () => {
        reads.push("downloads");
        return HttpResponse.json({ downloads: [], nextCursor: null });
      }),
    );
    await run(["data", "social", "status", "--json"]);
    await run(["data", "social", "downloads", "--json"]);
    expect(reads).toEqual(["status", "downloads"]);
    expect(requests).toEqual([]);
  });

  it("allows recovery of an existing social download without permitting new downloads", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["social"]');
    let polls = 0;
    server.use(
      http.get("http://localhost:3000/api/social/downloads/:downloadId", () => {
        polls += 1;
        return HttpResponse.json(completedDownload);
      }),
    );
    await run([
      "data",
      "social",
      "download",
      "--resume",
      completedDownload.downloadId,
      "--json",
    ]);
    expect(polls).toBe(1);
    expect(output).toContain(completedDownload.download.url);
    await expect(
      run([
        "data",
        "social",
        "download",
        "https://youtu.be/example",
        "--max-duration",
        "600",
      ]),
    ).rejects.toThrow("process.exit(1)");
    expect(requests).toEqual([]);
  });
});
