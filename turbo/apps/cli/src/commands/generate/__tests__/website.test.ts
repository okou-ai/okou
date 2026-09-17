/**
 * Tests for okou generate website command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): none for the source-selection path
 * - Real (internal): prompt parsing and authoring packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { DEFAULT_IMAGE_MODEL_ENV } from "@okouai/core/image-model-catalog";
import { generateCommand } from "../index";
import { websiteCommand } from "../website";

function buildRunToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      userId: "user_test",
      runId: "run_test",
      orgId: "org_test",
      scope: "okou",
      capabilities: [],
      iat: 1,
      exp: 2,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

describe("okou generate website command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_TOKEN", undefined);
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("should print source selection instructions for website", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "observability launch site",
      "--title",
      "Clearpath",
      "--site-slug",
      "clearpath-demo",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Okou generate website");
    expect(stdout).toContain("generation source-selection packet");
    expect(stdout).not.toContain("federated");
    expect(stdout).toContain("## Stage 1: Resource Selection");
    expect(stdout).toContain(
      "https://static.okou.io/html-resources/website/v1/d7138a8fc889c7fda5e57e463d178c37e97a1bb4fd752f56a793dc2e53c1935a/website.json",
    );
    expect(stdout).not.toContain("Sources:");
    expect(stdout).toContain(
      "There is no fixed selection count for any resource type.",
    );
    expect(stdout).toContain(
      "For a selected entry without `source.archive`, resolve its `source.path` from the index's pinned `source.repo@source.ref`. Do not run `okou resource pull` for it.",
    );
    expect(stdout).toContain(
      "run its exact `source.pull.command`, then use `source.pull.resolvedPath`.",
    );
    expect(stdout).toContain(
      "The Website index includes Okou built-in R2 template packages as template entries with `source.archive`.",
    );
    expect(stdout).toContain(
      "Each built-in Website template entry includes the exact pull command and extracted package path in `source.pull`.",
    );
    expect(stdout).toContain("observability launch site");
    expect(stdout).toContain(
      "For landing, marketing, official brand or product, and launch pages, select an Okou built-in website template.",
    );
    expect(stdout).toContain(
      "For other HTML or website requests, select an Open Design template based on intent; when ambiguous, prefer Open Design.",
    );
    expect(stdout).toContain(
      "Built-in website candidates have `source.archive`; candidates without it are Open Design templates.",
    );
    expect(stdout).toContain(
      "Write the artifact under `./generated/mockups/clearpath-demo/`.",
    );
    expect(stdout).toContain(
      "okou host ./generated/mockups/clearpath-demo --site clearpath-demo --spa\n",
    );
    expect(stdout).toContain(
      "With privateArtifacts enabled, new artifacts default to only-me.",
    );
  });

  it("preserves public visibility for website delivery without sharing supporting images", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "A launch site",
      "--site-slug",
      "launch-site",
      "--visibility",
      "public",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "okou host ./generated/mockups/launch-site --site launch-site --spa --visibility public\n",
    );
    expect(stdout).toContain(
      "okou web upload-file -f <file> --visibility public",
    );
    expect(stdout).toContain("do not make supporting media public separately");
    const imageWorkflow = stdout.split("\n").find((line) => {
      return line.startsWith("- Image workflow:");
    });
    expect(imageWorkflow).toContain("okou generate image-batch start");
    expect(imageWorkflow).not.toContain("--visibility public");
  });

  it("uses the Okou static host for resource URLs", async () => {
    vi.stubEnv("OKOU_TOKEN", buildRunToken());

    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "brand-aware site",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("https://static.okou.io/html-resources/");
  });

  it("should emit the image batch workflow exactly once", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "observability launch site",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const imageWorkflowLines = stdout.split("\n").filter((line) => {
      return line.startsWith("- Image workflow: use supplied images first;");
    });
    expect(imageWorkflowLines).toHaveLength(1);
    const imageWorkflow = imageWorkflowLines[0] ?? "";
    expect(imageWorkflow).toContain(
      "one outside-site TSV row per selected real slot",
    );
    expect(imageWorkflow).toContain("asset-id<TAB>raw prompt<TAB>size");
    expect(imageWorkflow).toMatch(
      /npx --yes --package="\$\{CLI_PKG_URL\}" okou generate image-batch start <manifest\.tsv> <state-dir>/,
    );
    expect(imageWorkflow).toMatch(
      /npx --yes --package="\$\{CLI_PKG_URL\}" okou generate image-batch wait <state-dir>/,
    );
    expect(imageWorkflow).toContain("author the HTML while it runs");
    expect(imageWorkflow).toContain("<state-dir>/results.tsv");
    expect(imageWorkflow).toContain("data-generation-size");
    expect(imageWorkflow).toContain("with no manifest skip this workflow");
    expect(imageWorkflow).toContain("keep its state outside the site");
    expect(imageWorkflow).toContain(
      "let the command own generation settings/concurrency/retry",
    );
    expect(imageWorkflow).toContain("never call `okou generate image`");
    expect(imageWorkflow).toContain("or a template image wrapper directly");
    expect(imageWorkflow).not.toContain("a fourth is rejected");
  });

  it("should let the image batch own its settings with a default image model", async () => {
    vi.stubEnv(DEFAULT_IMAGE_MODEL_ENV, "qwen-image");

    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "observability launch site",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "let the command own generation settings/concurrency/retry",
    );
    expect(stdout).not.toContain("use `qwen-image` by default");
    expect(stdout).not.toContain("run default image model");
  });

  it("should use the generated base slug when no stable site slug is provided", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "observability launch site",
      "--title",
      "Clearpath",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "okou host ./generated/mockups/clearpath --site clearpath --spa",
    );
  });

  it("should accept a restored Open Design website template", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "A documentation page for a developer tool",
      "--template",
      "web-prototype",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "Selected template: template:web-prototype (Web Prototype)",
    );
    expect(stdout).toContain("Use the explicitly selected template.");
    expect(stdout).not.toContain(
      "For landing, marketing, official brand or product, and launch pages, select an Okou built-in website template.",
    );
    expect(stdout).not.toContain(
      "Selected template package: okou resource pull template:web-prototype",
    );
  });

  it("should accept the built-in R2 website template package", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "Kinetic onchain brand studio",
      "--template",
      "dot-matrix",
      "--design-system",
      "stripe",
      "--site-slug",
      "dot-matrix-demo",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "Selected template: template:dot-matrix (Dot Matrix)",
    );
    expect(stdout).toContain(
      "Selected design system: design-system:stripe (Stripe)",
    );
    expect(stdout).toContain(
      "Selected template package: okou resource pull template:dot-matrix --dir ./generated/resources",
    );
    expect(stdout).toContain(
      "Selected template archive SHA-256: 5d9f69b7f9625681b5b6183623cbece78c4f40dc6fe585ca799212d05e589623",
    );
  });

  it("should accept the built-in website picker id for --template", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "website",
      "--prompt",
      "High contrast launch page",
      "--template",
      "website-template:black-slabs",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(
      "Selected template: template:black-slabs (Black Slabs)",
    );
  });

  it("should reject a template that does not target website", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "website",
        "--prompt",
        "Pricing page for a SaaS",
        "--template",
        "html-ppt-pitch-deck",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown template for website");
  });

  it("should reject an unknown design system", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "website",
        "--prompt",
        "Pricing page for a SaaS",
        "--design-system",
        "definitely-not-a-design-system",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown design system");
  });

  it("should expose the shared HTML artifact flags in help", () => {
    let helpOutput = "";
    websiteCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    websiteCommand.outputHelp();

    expect(helpOutput).toContain("--prompt <text>");
    expect(helpOutput).toContain("--site-slug <slug>");
    expect(helpOutput).toContain("--title <text>");
    expect(helpOutput).toContain("--design-system <id>");
    expect(helpOutput).toContain("--template <id>");
    expect(helpOutput).toContain("--visibility <visibility>");
  });
});
