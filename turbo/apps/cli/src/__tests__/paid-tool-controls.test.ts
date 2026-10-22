import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DISABLED_PAID_TOOLS_ENV_VAR } from "@okouai/api-contracts/contracts/paid-tools";
import { Command } from "commander";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../mocks/server";
import { buildHelpText, registerRequestedCommand } from "../okou";

const managedFamilies = [
  "web-search",
  "people-search",
  "scrape",
  "finance",
  "maps",
  "seo",
  "social",
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

  it.each(managedFamilies)(
    "removes disabled %s from help, actions and suggestions",
    async (tool) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, JSON.stringify([tool]));
      await expect(run(["--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      expect(output).not.toContain(tool);
      expect(output).not.toContain("disabled");
      output = "";

      for (const args of [
        [tool, "example"],
        ["help", tool],
      ]) {
        await expect(run(args)).rejects.toMatchObject({
          code: "commander.unknownCommand",
        });
        expect(errors).toContain(`unknown command '${tool}'`);
        expect(output).toBe("");
        errors = "";
      }
      // Commander treats an unknown command followed by --help as root help.
      await expect(run([tool, "--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      expect(output).not.toContain(tool);
      output = "";
      await expect(run([tool.slice(0, -1)])).rejects.toMatchObject({
        code: "commander.unknownCommand",
      });
      expect(errors).not.toContain(tool);
      expect(requests).toEqual([]);
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it.each(["capabilities", "status", "downloads", "download", "resume"])(
    "removes disabled social %s including free helpers and recovery",
    async (operation) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["social"]');
      await expect(run(["social", operation])).rejects.toMatchObject({
        code: "commander.unknownCommand",
      });
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
    }
    expect(output).toContain("--provider <name>");
    output = "";
    await run(["generate", "sprite", "--prompt", "A fox"]);
    expect(output).toContain("## Core Invariants");
    expect(output).toContain("--provider <connector>");
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
      expect(output).toContain("Image workflow:");
      expect(output).not.toContain("okou generate image-batch");
      expect(output).not.toContain("--provider built-in");
    }
    expect(requests).toEqual([]);
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
    await expect(run(["web-search", "--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });
    expect(output).toContain("okou web-search");
    expect(output).not.toContain("okou scrape");
    expect(requests).toEqual([]);
  });

  it("retrieves an existing image job while managed generation is absent", async () => {
    vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, '["image-generation"]');
    const generationId = "00000000-0000-4000-8000-000000000001";
    let reads = 0;
    server.use(
      http.get(
        `http://localhost:3000/api/built-in-generations/${generationId}`,
        () => {
          reads += 1;
          return HttpResponse.json({
            generationId,
            type: "image",
            status: "completed",
            result: {
              id: "existing-image",
              url: "https://example.com/image.png",
            },
          });
        },
      ),
    );
    await run(["generate", "get", generationId, "--json"]);
    expect(reads).toBe(1);
    expect(output).toContain('"status":"completed"');
    expect(requests).toEqual([]);
  });

  it.each([undefined, "", "   ", "[]", '["future-tool"]', '["finance"]'])(
    "permits an enabled operation under policy %s",
    async (policy) => {
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
    },
  );

  it.each(["not-json", "null", "{}", '"web-search"', '["web-search", 1]'])(
    "omits managed capabilities with malformed policy %s",
    async (policy) => {
      vi.stubEnv(DISABLED_PAID_TOOLS_ENV_VAR, policy);
      await expect(run(["--help"])).rejects.toMatchObject({
        code: "commander.helpDisplayed",
      });
      for (const tool of managedFamilies) expect(output).not.toContain(tool);
      expect(output).not.toContain("--raw-prompt");
      expect(output).toContain("okou generate website");
      output = "";
      await expect(run(["web-search", "example"])).rejects.toMatchObject({
        code: "commander.unknownCommand",
      });
      await expect(
        run(["generate", "image", "--raw-prompt", "A fox"]),
      ).rejects.toMatchObject({ code: "commander.unknownOption" });
      expect(requests).toEqual([]);
    },
  );
});
