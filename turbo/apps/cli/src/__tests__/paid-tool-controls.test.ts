import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DISABLED_PAID_TOOLS_ENV_VAR } from "@okouai/api-contracts/contracts/paid-tools";
import { Command } from "commander";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../mocks/server";
import { buildHelpText, registerRequestedCommand } from "../okou";

const managedFamilies = [
  {
    tool: "web-search",
    path: ["web", "search"],
    example: "okou data web search",
  },
  {
    tool: "people-search",
    path: ["people", "search"],
    example: "okou data people search",
  },
  { tool: "scrape", path: ["web", "scrape"], example: "okou data web scrape" },
  { tool: "finance", path: ["finance"], example: "okou data finance" },
  { tool: "maps", path: ["maps"], example: "okou data maps" },
  { tool: "seo", path: ["seo"], example: "okou data seo" },
  { tool: "social", path: ["social"], example: "okou data social" },
  { tool: "data-search", path: ["company"], example: "okou data capabilities" },
] as const;

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
          { status: 500 },
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
    const program = new Command("okou").addHelpText("after", () => {
      return buildHelpText();
    });
    await registerRequestedCommand(program, argv);
    // Each parse models a fresh process even when command modules are cached.
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

  it.each([false, true])(
    "only deletes disabled image guidance from the original sprite packet (disabled: %s)",
    async (disabled) => {
      vi.stubEnv(
        DISABLED_PAID_TOOLS_ENV_VAR,
        disabled ? '["image-generation"]' : "[]",
      );
      await run(["generate", "sprite", "--prompt", "A fox"]);
      // Golden output from the PR base 152d5a8; includes instruction ordering.
      const baseline = await readFile(
        new URL(
          "../commands/generate/__tests__/fixtures/sprite-enabled.txt",
          import.meta.url,
        ),
        "utf8",
      );
      const filtered = baseline
        .replace("generate each raw sheet with built-in image generation, ", "")
        .replace(
          "Every raw sprite image must come from built-in image generation. ",
          "",
        )
        .replace(
          "Generate each raw sheet with built-in image generation as described under Image Generation. ",
          "",
        )
        .replace(
          /^- Generate every raw sheet via built-in image generation.*\n/m,
          "",
        )
        .replace(
          /^- Pick a sheet-friendly square or grid-aligned size.*\n/m,
          "",
        );
      expect(output).toBe(disabled ? filtered : baseline);
      expect(requests).toEqual([]);
    },
  );

  it.each([
    [["generate"], "generate-help.txt"],
    [["generate", "sprite"], "sprite-help.txt"],
    [["data", "web", "search"], "web-search-help.txt"],
  ] as const)(
    "preserves pre-filtering help for %s with all tools enabled",
    async (args, fixture) => {
      await expect(run([...args, "--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      expect(output).toBe(
        await readFile(
          new URL(
            `../commands/generate/__tests__/fixtures/${fixture}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(requests).toEqual([]);
    },
  );

  it.each(managedFamilies)(
    "removes disabled $tool from help, actions and suggestions",
    async ({ tool, path, example }) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, JSON.stringify([tool]));
      await expect(run(["--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      expect(output).not.toContain(example);
      expect(output).not.toContain("disabled");
      output = "";
      const parent = path.slice(0, -1);
      const leaf = path[path.length - 1];
      if (!leaf) throw new Error("Expected a managed command");
      await expect(run(["data", ...path, "example"])).rejects.toMatchObject({
        code: "commander.unknownCommand",
      });
      expect(errors).toContain(`unknown command '${leaf}'`);
      expect(output).toBe("");
      errors = "";
      await expect(
        run(["data", ...parent, "help", leaf]),
      ).rejects.toMatchObject({
        code: "commander.help",
      });
      const listsDisabledCommand = output.split("\n").some((line) => {
        const entry = line.trimStart();
        return (
          entry !== line &&
          (entry.trimEnd() === leaf ||
            entry.startsWith(`${leaf} `) ||
            entry.startsWith(`${leaf}(`))
        );
      });
      expect(listsDisabledCommand).toBe(false);
      expect(output).not.toContain(example);
      if (tool === "web-search")
        expect(output).not.toContain("Search and extract");
      if (tool === "scrape")
        expect(output).not.toContain("extract public web sources");
      output = "";
      await expect(
        run(["data", ...parent, leaf.slice(0, -1)]),
      ).rejects.toMatchObject({
        code: "commander.unknownCommand",
      });
      expect(errors).not.toContain(`'${leaf}'`);
      expect(requests).toEqual([]);
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it.each(["capabilities", "status", "downloads", "download", "resume"])(
    "removes disabled social %s including free helpers and recovery",
    async (operation) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["social"]');
      await expect(run(["data", "social", operation])).rejects.toMatchObject({
        code: "commander.unknownCommand",
      });
      expect(requests).toEqual([]);
    },
  );

  it("keeps research search and independent tools while omitting Data Search adapters", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["data-search"]');
    await expect(run(["data", "--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    expect(output).toContain("weather");
    expect(output).toContain("commerce");
    expect(output).toContain("okou data web search");
    expect(output).not.toContain("capabilities");
    expect(output).not.toContain("jobs");
    expect(output).not.toContain("enrich business profiles");
    output = "";
    await expect(
      run(["data", "people", "search", "--help"]),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    expect(output).toContain("Research query");
    expect(output).not.toContain("prospect");
    expect(output).not.toContain("--max-credits");
    await expect(
      run(["data", "people", "search", "--backend", "prospect", "--dry-run"]),
    ).rejects.toMatchObject({ code: "commander.unknownOption" });
    await expect(
      run([
        "data",
        "finance",
        "company-profile",
        "--ticker",
        "AAPL",
        "--exchange",
        "NASDAQ",
        "--dry-run",
      ]),
    ).rejects.toMatchObject({ code: "commander.unknownCommand" });
    expect(requests).toEqual([]);
  });

  it.each(["discover", "capabilities"])(
    "filters disabled families from data %s without hiding independent enrichment",
    async (operation) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["finance","people-search"]');
      const capabilities = [
        "finance.company-profile",
        "people.search",
        "people.enrich",
        "company.search",
      ].map((id) => {
        return {
          id,
          description: id,
          inputSchema: {},
          limits: { default: 1, max: 10 },
          status: "available",
        };
      });
      server.use(
        http.get("http://localhost:3000/api/data/capabilities", () => {
          return HttpResponse.json({ capabilities });
        }),
      );
      await run(["data", operation, "--json"]);
      expect(JSON.parse(output)).toEqual({
        capabilities: capabilities.slice(2),
      });
      output = "";
      await expect(run(["data", "people", "--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      expect(output).toContain("enrich");
      expect(output).toContain("enrich business profiles");
      expect(output).not.toContain("Research professionals");
      expect(output).not.toContain("okou data people search");
      expect(requests).toEqual([]);
    },
  );

  it("exposes only connector image options and preserves other generation commands", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["image-generation"]');
    for (const args of [
      ["--help"],
      ["generate", "--help"],
      ["help", "generate"],
      ["generate", "image", "--help"],
      ["generate", "sprite", "--help"],
    ]) {
      output = "";
      await expect(run(args)).rejects.toMatchObject({
        code: args[0] === "help" ? "commander.help" : "commander.helpDisplayed",
      });
      expect(output).not.toContain("--raw-prompt");
      expect(output).not.toContain("--compiled-prompt");
      expect(output).not.toContain("--provider built-in");
      expect(output).not.toContain("image-batch");
      expect(output).not.toContain("disabled");
      expect(output).not.toContain("built-in image generation");
      expect(output).not.toContain("okou generate image --style");
    }
    output = "";
    await run(["generate", "sprite", "--prompt", "A fox"]);
    expect(output).toContain("## Core Invariants");
    expect(output).not.toContain("--provider built-in");
    expect(output).not.toContain("Settings › Built-in tools");
    for (const args of [
      ["presentation", "--prompt", "A roadmap"],
      [
        "presentation",
        "--template",
        "html-ppt-playful-launch",
        "--prompt",
        "A roadmap",
      ],
      ["website", "--prompt", "A product site"],
    ]) {
      output = "";
      await run(["generate", ...args]);
      expect(output).not.toContain("Image workflow:");
      expect(output).not.toContain("okou generate image-batch");
      expect(output).not.toContain("--provider built-in");
    }
    expect(requests).toEqual([]);
  });

  it.each([
    "website",
    "report",
    "poster",
    "docs-design",
    "dashboard-design",
    "mobile-app-design",
  ])("filters managed image batch notes from the %s packet", async (type) => {
    const args = ["generate", type, "--prompt", "Use the supplied assets"];
    await run(args);
    const enabled = output;
    expect(enabled).toContain(
      "- Image batch results may be relative asset paths",
    );
    const filtered = enabled
      .split("\n")
      .filter((line) => {
        return (
          !line.startsWith("- Image batch results") &&
          !line.startsWith("- Image workflow:")
        );
      })
      .join("\n");

    output = "";
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["image-generation"]');
    await run(args);

    expect(output).toBe(filtered);
    expect(output).toContain("okou web download-file --help");
    expect(output).toContain("## Publish");
    expect(requests).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    ["image", "--raw-prompt", "A fox"],
    ["image", "--compiled-prompt", "A fox"],
    [
      "image",
      "--style",
      "image-style:ink-storefront",
      "--prompt",
      "A fox",
      "--compile",
    ],
    ["image-batch", "start", "images.tsv", "state"],
    ["image-batch", "__run", "images.tsv", "state"],
    ["image-batch", "wait", "state"],
  ])("cannot parse managed image invocation %s", async (...args) => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["image-generation"]');
    await expect(run(["generate", ...args])).rejects.toMatchObject({
      code:
        args[0] === "image"
          ? "commander.unknownOption"
          : "commander.unknownCommand",
    });
    expect(requests).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not recommend disabled extraction from enabled web-search help", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["scrape"]');
    await expect(
      run(["data", "web", "search", "--help"]),
    ).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    expect(output).toContain("okou data web search");
    expect(output).not.toContain("okou data web scrape");
    expect(requests).toEqual([]);
  });

  it.each(['["image-generation"]', "not-json"])(
    "keeps image result queries and downloads without offering generation recovery under policy %s",
    async (policy) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, policy);
      const generationId = "00000000-0000-4000-8000-000000000001";
      await expect(run(["generate", "get", "--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      expect(output).toContain("--out <path>");
      expect(output).not.toContain("--refresh");
      output = "";
      await expect(
        run(["generate", "get", generationId, "--refresh"]),
      ).rejects.toMatchObject({ code: "commander.unknownOption" });
      expect(requests).toEqual([]);
      let completed = false;
      let reads = 0;
      let downloads = 0;
      server.use(
        http.get(
          `http://localhost:3000/api/built-in-generations/${generationId}`,
          () => {
            reads += 1;
            return HttpResponse.json({
              generationId,
              type: "image",
              status: completed ? "completed" : "queued",
              ...(completed
                ? {
                    result: {
                      id: "existing-image",
                      url: "https://example.com/image.png",
                    },
                  }
                : {}),
            });
          },
        ),
        http.get("http://localhost:3000/api/web/file-url", ({ request }) => {
          expect(new URL(request.url).searchParams.get("file_id")).toBe(
            "existing-image",
          );
          return HttpResponse.json({
            url: "https://example.com/image.png",
            downloadUrl: "https://example.com/image.png",
            expiresAt: "2026-10-23T15:00:00.000Z",
            publicUrl: null,
          });
        }),
        http.get("https://example.com/image.png", ({ request }) => {
          downloads += 1;
          expect(request.headers.get("authorization")).toBeNull();
          return new HttpResponse("existing image");
        }),
      );
      await run(["generate", "get", generationId]);
      expect(output).toContain("Status: queued");
      expect(output).toContain(
        `Query again: okou generate get ${generationId}`,
      );
      expect(output).not.toContain("--refresh");
      completed = true;
      output = "";
      const out = join(directory, "existing-image.png");
      await run(["generate", "get", generationId, "--out", out, "--json"]);
      expect(await readFile(out, "utf8")).toBe("existing image");
      expect(output).toContain('"status":"completed"');
      expect(reads).toBe(2);
      expect(downloads).toBe(1);
      expect(requests).toEqual([]);
    },
  );

  it.each([
    undefined,
    "",
    "   ",
    "[]",
    '["future-tool"]',
    '["finance"]',
    '["data-search"]',
  ])("permits an enabled operation under policy %s", async (policy) => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, policy);
    let paidRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/web-search", () => {
        paidRequests += 1;
        return HttpResponse.json({
          query: "example",
          limit: 5,
          provider: "perplexity",
          billingCategory: "request",
          billingQuantity: 1,
          creditsCharged: 5,
          results: [],
        });
      }),
    );
    await run(["data", "web", "search", "example", "--json"]);
    expect(paidRequests).toBe(1);
    expect(output).toContain('"results":[]');
    expect(errors).toBe("");
  });

  it.each(["not-json", "null", "{}", '"web-search"', '["web-search", 1]'])(
    "omits managed capabilities with malformed policy %s",
    async (policy) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, policy);
      await expect(run(["--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      for (const { example } of managedFamilies)
        expect(output).not.toContain(example);
      expect(output).not.toContain("--raw-prompt");
      expect(output).toContain("okou generate website");
      output = "";
      await expect(
        run(["data", "web", "search", "example"]),
      ).rejects.toMatchObject({
        code: "commander.unknownCommand",
      });
      await expect(
        run(["generate", "image", "--raw-prompt", "A fox"]),
      ).rejects.toMatchObject({ code: "commander.unknownOption" });
      expect(requests).toEqual([]);
    },
  );
});
