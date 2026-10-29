/**
 * Tests for okou generate presentation command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Real (internal): prompt parsing and authoring packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { listPresentationRunbookPackages } from "@okouai/core/resource-registry";
import { createGenerateCommand } from "../index";
import { presentationCommand } from "../presentation";

const generateCommand = createGenerateCommand();

describe("okou generate presentation command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("guides source-aware template selection before authoring", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "presentation",
      "--prompt",
      "API migration plan",
      "--slides",
      "10",
      "--title",
      "API Migration Plan",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Okou generate presentation");
    expect(stdout).toContain(
      "Select a built-in presentation template from the catalog below",
    );
    expect(stdout).toContain("API migration plan");
    expect(stdout).toContain("Slide count: 10");
    expect(stdout).toContain(
      "Before choosing a template, planning slides, or launching workers, read the user's request and supplied source text and inspect important charts and images",
    );
    expect(stdout).toContain(
      "Distinguish content sources from visual references and explicitly required templates",
    );
    expect(stdout).toContain(
      "based only on tone, audience fit, and visual preferences",
    );
    expect(stdout).toContain(
      "The scenarios in each description are examples, not subject restrictions",
    );
    expect(stdout).toContain(
      "When visual preferences are unspecified, choose a broadly suitable, understated style consistent with the audience and context",
    );
    expect(stdout).toContain(
      "Keep the choice internal: do not announce the selected template or ask the user to choose or confirm one",
    );
    expect(stdout).toContain(
      "Keep all slides and visible content in index.html; render the first slide without JavaScript",
    );
    expect(stdout).toContain(
      "okou generate image-batch start <manifest.tsv> <state-dir>",
    );
    expect(stdout).toContain("okou generate image-batch wait <state-dir>");
    expect(stdout).toContain(
      "Pull only the selected package once: `okou resource pull <Package from the catalog> --dir ./generated/resources`",
    );
    expect(stdout).toContain(
      "Read SKILL.md in the source directory printed by the pull command fully",
    );
    expect(stdout).toContain(
      "Follow that package's authoring, worker startup, layout and verification workflow",
    );
    expect(stdout).toContain(
      "Preserve the requested slide count and substantive content",
    );
    expect(stdout).toContain(
      "For HTML delivery, host the finished deck: okou host <output-dir> --site <slug> --title 'API Migration Plan' --artifact-kind presentation-html --preview ./generated/previews/cover.png --json\n",
    );
    expect(stdout).toContain(
      "Uploaded and generated files default to only-me. New hosted sites default to only-me. Redeployments keep the site's visibility unless --visibility is supplied.",
    );
  });

  it("provides every built-in candidate with its style and pullable package", async () => {
    await createGenerateCommand().parseAsync([
      "node",
      "cli",
      "presentation",
      "--prompt",
      "Explain the attached research to a general business audience",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const candidates = [
      ...stdout.matchAll(/^### .+ \((template:[^)]+)\)$/gm),
    ].map((match) => {
      return match[1];
    });
    const templates = listPresentationRunbookPackages();
    expect(candidates).toEqual(
      templates.map((template) => {
        return template.templateId;
      }),
    );
    for (const template of templates) {
      expect(stdout).toContain(template.description);
      expect(stdout).toContain(
        `Package: ${template.resourceId}; default color system: ${template.defaultColorSystem}`,
      );
    }
    expect(stdout).toContain("Calm, scholarly and cultivated");
    expect(stdout).toContain("Exuberant, irreverent and loud");
    expect(stdout).toContain("Rational, composed and businesslike");
  });

  it.each([
    { label: "automatic selection", templateArgs: [] },
    {
      label: "template authoring",
      templateArgs: ["--template", "html-ppt-playful-launch"],
    },
  ])("preserves org visibility for $label", async ({ templateArgs }) => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "presentation",
      "--prompt",
      "A team planning deck",
      "--site-slug",
      "team-plan",
      "--visibility",
      "org",
      ...templateArgs,
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const hostInstructions = stdout.split("\n").filter((line) => {
      return line.startsWith("- For HTML delivery, host the finished deck:");
    });
    expect(hostInstructions).toEqual([
      '- For HTML delivery, host the finished deck: okou host <output-dir> --site team-plan --title "<presentation title>" --artifact-kind presentation-html --visibility org --preview ./generated/previews/cover.png --json',
    ]);
    expect(stdout).toContain(
      "choose HTML or PPTX from the user's request, remembered preferences, and intended use",
    );
    expect(stdout).toContain("Explicit requests take priority");
    expect(stdout).toContain(
      "Deliver one format unless the user requests multiple formats",
    );
    expect(stdout).toContain(
      "For PPTX, follow the platform's conversion instructions. For HTML, follow the preview and hosting steps below",
    );
    expect(stdout).toContain("okou web upload-file -f <file> --visibility org");
    expect(stdout).toContain(
      "Keep supporting generated media at its default visibility",
    );
    const imageWorkflow = stdout.split("\n").find((line) => {
      return line.startsWith("- Image workflow:");
    });
    expect(imageWorkflow).toContain("okou generate image-batch start");
    expect(imageWorkflow).not.toContain("--visibility org");
  });

  it("should reject slide counts outside the supported range", async () => {
    const mockStderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => {
        return true;
      }) as never);

    try {
      await expect(async () => {
        await generateCommand.parseAsync([
          "node",
          "cli",
          "presentation",
          "--prompt",
          "launch plan",
          "--slides",
          "3",
        ]);
      }).rejects.toThrow("process.exit called");

      const stderr = mockStderrWrite.mock.calls
        .map(([chunk]) => {
          return String(chunk);
        })
        .join("");
      expect(stderr).toContain("slides must be between 4 and 20");
    } finally {
      mockStderrWrite.mockRestore();
    }
  });

  it("should expose only base artifact flags plus slides in help", () => {
    let helpOutput = "";
    presentationCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    presentationCommand.outputHelp();

    expect(helpOutput).toContain("--prompt <text>");
    expect(helpOutput).toContain("--site-slug <slug>");
    expect(helpOutput).toContain("--title <text>");

    expect(helpOutput).toContain("--template <id>");
    expect(helpOutput).toContain("--slides <count>");
    expect(helpOutput).toContain("--visibility <visibility>");
  });

  it("should list presentation templates in help", () => {
    let helpOutput = "";
    presentationCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    presentationCommand.outputHelp();

    expect(helpOutput).toContain("Templates (presentation):");
    expect(helpOutput).toContain("template:html-ppt-playful-launch");
    expect(helpOutput).not.toContain("(no presentation templates registered)");
  });

  it("resolves --template to direct-HTML instructions", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "presentation",
      "--prompt",
      "create a 15-slide launch deck",
      "--template",
      "html-ppt-playful-launch",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Presentation Generation (template)");
    expect(stdout).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    expect(stdout).toContain(
      "okou resource pull template:html-ppt-playful-launch-runbook --dir ./generated/resources",
    );
    expect(stdout).toContain("./generated/resources/playful-launch/SKILL.md");
    expect(stdout).toContain("Color system token: carnival");
    expect(stdout).toContain(
      "follow its template, authoring, and verification instructions",
    );
    expect(stdout).toContain(
      "Keep all slides and visible content in index.html; render the first slide without JavaScript",
    );
    expect(stdout).toContain("User request: create a 15-slide launch deck");
    expect(stdout).toContain(
      'For HTML delivery, host the finished deck: okou host <output-dir> --site <slug> --title "<presentation title>" --artifact-kind presentation-html --preview ./generated/previews/cover.png --json\n',
    );
    const imageWorkflowLines = stdout.split("\n").filter((line) => {
      return line.startsWith("- Image workflow:");
    });
    expect(imageWorkflowLines).toHaveLength(1);
    const imageWorkflow = imageWorkflowLines[0] ?? "";
    expect(imageWorkflow).toContain("with no manifest skip this workflow");
    expect(imageWorkflow).toContain(
      "let the command own generation settings/concurrency/retry",
    );
    expect(
      imageWorkflow.indexOf("okou generate image-batch start <manifest.tsv>"),
    ).toBeLessThan(imageWorkflow.indexOf("author the deck while it runs"));
    expect(imageWorkflow.indexOf("author the deck while it runs")).toBeLessThan(
      imageWorkflow.indexOf("okou generate image-batch wait <state-dir>"),
    );
    expect(
      imageWorkflow.indexOf("okou generate image-batch wait <state-dir>"),
    ).toBeLessThan(imageWorkflow.indexOf("<state-dir>/results.tsv"));
  });

  it("rejects an unknown presentation template id with available templates", async () => {
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      await expect(async () => {
        await generateCommand.parseAsync([
          "node",
          "cli",
          "presentation",
          "--prompt",
          "launch plan",
          "--template",
          "not-a-real-template",
        ]);
      }).rejects.toThrow("process.exit called");

      const stderr = mockConsoleError.mock.calls.flat().join("\n");
      expect(stderr).toContain(
        "Unknown template for presentation: not-a-real-template",
      );
      expect(stderr).toContain("Available templates for presentation:");
      expect(stderr).toContain("template:html-ppt-playful-launch");
      expect(stderr).toContain(
        'okou generate presentation --template template:html-ppt-playful-launch --prompt "..."',
      );
    } finally {
      mockConsoleError.mockRestore();
    }
  });
});
