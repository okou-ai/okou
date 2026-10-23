import { Command } from "commander";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";

const origin = "http://localhost:3000";
const jobId = "1c71bda8-a995-4a03-8099-a7af141c943d";
const completed = {
  jobId,
  requestId: "93768b3c-4d64-4e1b-b9b0-ce60ce620ea6",
  capability: "people.search",
  status: "completed",
  data: { items: [] },
  billing: {
    state: "settled",
    creditsCharged: 10,
    reservedCredits: 0,
    maxCredits: 30,
  },
  createdAt: "2026-10-22T00:00:00Z",
  updatedAt: "2026-10-22T00:00:01Z",
};
const adapters = [
  {
    tool: "people-search",
    capability: "people.search",
    canonicalPath: ["people", "search"],
    aliasArgs: ["people-search", "marketing leaders", "--backend", "prospect"],
  },
  {
    tool: "finance",
    capability: "finance.company-profile",
    canonicalPath: ["finance", "company-profile"],
    aliasArgs: [
      "finance",
      "company-profile",
      "--ticker",
      "AAPL",
      "--exchange",
      "NASDAQ",
    ],
  },
] as const;

describe("legacy data aliases with fresh CLI command trees", () => {
  let output: string;
  let errors: string;
  let requests: string[];
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    // Command modules export singletons. A canonical-first parse leaves parent
    // links/hooks behind and can mask alias-first policy bugs. Reload all CLI
    // modules for each case, without mocking any production implementation.
    vi.resetModules();
    output = "";
    errors = "";
    requests = [];
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", origin);
    vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", undefined);
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
          { status: 500 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = originalExitCode;
  });

  async function run(args: string[]): Promise<void> {
    // Deliberate dynamic import: resetModules must create a fresh lazy registry
    // and canonical command tree before the first public alias invocation.
    const { registerRequestedCommand } = await import("../../../okou");
    const argv = ["node", "okou", ...args];
    const program = new Command("okou");
    await registerRequestedCommand(program, argv);
    function configure(command: Command): void {
      command.exitOverride().configureOutput({
        writeOut: (text) => {
          output += text;
        },
        writeErr: (text) => {
          errors += text;
        },
      });
      command.commands.forEach(configure);
    }
    configure(program);
    await program.parseAsync(argv);
  }

  describe.each(adapters)("$tool", (adapter) => {
    it.each(["advanced", "historical", "malformed"])(
      "blocks alias-first execution under %s policy before HTTP",
      async (policy) => {
        const disabled = policy === "historical" ? adapter.tool : "data-search";
        vi.stubEnv(
          "OKOU_DISABLED_PAID_TOOLS",
          policy === "malformed" ? "invalid" : JSON.stringify([disabled]),
        );

        await expect(
          run([...adapter.aliasArgs, "--max-credits", "30", "--json"]),
        ).rejects.toThrow("process.exit(1)");

        expect(errors).toContain(
          policy === "malformed"
            ? "Paid tool configuration is invalid"
            : `Paid tool "${disabled}" is disabled`,
        );
        expect(requests).toEqual([]);
      },
    );

    it.each(["disabled", "malformed"])(
      "allows an alias-first free quote under %s policy",
      async (policy) => {
        vi.stubEnv(
          "OKOU_DISABLED_PAID_TOOLS",
          policy === "malformed"
            ? "invalid"
            : JSON.stringify([adapter.tool, "data-search"]),
        );
        let body: unknown;
        server.use(
          http.post(`${origin}/api/data/quote`, async ({ request }) => {
            body = await request.json();
            return HttpResponse.json({
              capability: adapter.capability,
              estimatedCredits: 10,
              maxCredits: 30,
              quantity: 1,
              unit: "request",
            });
          }),
        );

        await run([...adapter.aliasArgs, "--dry-run", "--json"]);

        expect(body).toMatchObject({ capability: adapter.capability });
        expect(JSON.parse(output)).toMatchObject({
          capability: adapter.capability,
          estimatedCredits: 10,
        });
        expect(errors).toBe("");
        expect(requests).toEqual([]);
      },
    );

    it("executes when enabled and preserves canonical help after forwarding", async () => {
      const creates: unknown[] = [];
      server.use(
        http.post(`${origin}/api/data/jobs`, async ({ request }) => {
          creates.push(await request.json());
          return HttpResponse.json(
            { ...completed, capability: adapter.capability },
            { status: 202 },
          );
        }),
      );

      await run([...adapter.aliasArgs, "--max-credits", "30", "--json"]);

      expect(creates).toEqual([
        expect.objectContaining({
          capability: adapter.capability,
          maxCredits: 30,
        }),
      ]);
      expect(JSON.parse(output)).toMatchObject({
        jobId,
        capability: adapter.capability,
      });
      output = "";
      await expect(
        run(["data", ...adapter.canonicalPath, "--help"]),
      ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
      expect(output).toContain(
        `Usage: okou data ${adapter.canonicalPath.join(" ")}`,
      );
      expect(errors).toBe("");
      expect(requests).toEqual([]);
    });
  });

  it.each(['["data-search", "people-search", "finance"]', "invalid"])(
    "keeps discovery and saved job recovery free after alias-first use under %s",
    async (policy) => {
      vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", policy);
      const operations: string[] = [];
      server.use(
        http.post(`${origin}/api/data/quote`, () => {
          operations.push("quote");
          return HttpResponse.json({
            capability: "people.search",
            estimatedCredits: 10,
            maxCredits: 30,
            quantity: 1,
            unit: "request",
          });
        }),
        http.get(`${origin}/api/data/capabilities`, () => {
          operations.push("capabilities");
          return HttpResponse.json({ capabilities: [] });
        }),
        http.get(`${origin}/api/data/jobs`, () => {
          operations.push("list");
          return HttpResponse.json({ jobs: [completed], nextCursor: null });
        }),
        http.get(`${origin}/api/data/jobs/:jobId`, () => {
          operations.push("get");
          return HttpResponse.json(completed);
        }),
        http.post(`${origin}/api/data/jobs/:jobId/cancel`, () => {
          operations.push("cancel");
          return HttpResponse.json(completed);
        }),
      );

      await run([...adapters[0].aliasArgs, "--dry-run", "--json"]);
      await run(["data", "capabilities", "--json"]);
      await run(["data", "jobs", "list", "--json"]);
      await run(["data", "jobs", "get", jobId, "--json"]);
      await run(["data", "jobs", "cancel", jobId, "--json"]);

      expect(operations).toEqual([
        "quote",
        "capabilities",
        "list",
        "get",
        "cancel",
      ]);
      expect(output).toContain(jobId);
      expect(errors).toBe("");
      expect(requests).toEqual([]);
    },
  );
});
