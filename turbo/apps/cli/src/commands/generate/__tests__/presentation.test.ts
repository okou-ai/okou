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
import { createPresentationGenerateCommand } from "../../shared/presentation-generate";

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
    expect(stdout).toContain("Requested output format: html");
    expect(stdout).toContain(
      "The CLI output format is a package-selection parameter, not proof of an explicit user choice",
    );
    expect(stdout).toContain("Do not query or update saved preferences");
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
      "the current message's explicit format (including its selected template format) wins, then this input's frozen presentation default, then HTML",
    );
    expect(stdout).toContain(
      "An existing HTML deck requires an explicit conversion request; a default alone does not request its conversion",
    );
    expect(stdout).toContain(
      "Deliver one format unless the user requests multiple formats",
    );
    expect(stdout).toContain(
      "If the resolved new-presentation output is PPTX but the selected template is HTML-only, follow the platform's available conversion instructions",
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

  it.each([
    { label: "automatic selection", templateArgs: [] },
    {
      label: "selected template",
      templateArgs: ["--template", "html-ppt-schoolhouse"],
    },
  ])(
    "uses native PPTX packages and file delivery for $label",
    async ({ templateArgs }) => {
      await createPresentationGenerateCommand().parseAsync([
        "node",
        "okou",
        "--format",
        "pptx",
        "--prompt",
        "A school community planning deck",
        "--site-slug",
        "school-plan",
        "--visibility",
        "org",
        ...templateArgs,
      ]);

      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      expect(stdout).toContain("Requested output format: pptx");
      expect(stdout).toContain(
        "Author an editable native PPTX directly with the selected package",
      );
      expect(stdout).toContain("template:pptx-schoolhouse-runbook");
      expect(stdout).toContain("--dir ./generated/resources/pptx");
      expect(stdout).toContain("SKILL.md");
      expect(stdout).toContain("Deliver the final deck with org visibility");
      expect(stdout).toContain(
        "okou web upload-file -f <deck.pptx> --visibility org",
      );
      expect(stdout).not.toContain("index.html");
      expect(stdout).not.toContain("okou host");
      expect(stdout).not.toContain("conversion instructions");
      expect(stdout).not.toContain("convert to PPTX");

      if (templateArgs.length > 0) {
        expect(stdout).toContain(
          "okou resource pull template:pptx-schoolhouse-runbook --dir ./generated/resources/pptx",
        );
        expect(stdout).toContain(
          "./generated/resources/pptx/schoolhouse-native/SKILL.md",
        );
      } else {
        expect(stdout).toContain("template:pptx-bloom-runbook");
        const packages = [...stdout.matchAll(/^Package: ([^;]+);/gm)].map(
          (match) => {
            return match[1];
          },
        );
        expect(packages).toEqual(
          listPresentationRunbookPackages("pptx").map((template) => {
            return template.resourceId;
          }),
        );
      }
    },
  );

  it.each([
    {
      flag: "--slides",
      value: "3",
      message: "slides must be between 4 and 20",
    },
    {
      flag: "--format",
      value: "pdf",
      message: "Allowed choices are html, pptx",
    },
  ])(
    "rejects invalid $flag with supported choices",
    async ({ flag, value, message }) => {
      const mockStderrWrite = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((() => {
          return true;
        }) as never);

      try {
        await expect(async () => {
          await createPresentationGenerateCommand().parseAsync([
            "node",
            "okou",
            "--prompt",
            "launch plan",
            flag,
            value,
          ]);
        }).rejects.toThrow("process.exit called");

        const stderr = mockStderrWrite.mock.calls
          .map(([chunk]) => {
            return String(chunk);
          })
          .join("");
        expect(stderr).toContain(message);
      } finally {
        mockStderrWrite.mockRestore();
      }
    },
  );

  it.each([
    {
      format: "html",
      formatArgs: [],
      packageId: "template:html-ppt-playful-launch-runbook",
    },
    {
      format: "pptx",
      formatArgs: ["--format", "pptx"],
      packageId: "template:pptx-playful-launch-runbook",
    },
  ])(
    "shows format choices and the $format package catalog in help",
    async ({ format, formatArgs, packageId }) => {
      let helpOutput = "";
      const command = createPresentationGenerateCommand()
        .configureOutput({
          writeOut: (str: string) => {
            helpOutput += str;
          },
        })
        .exitOverride();

      await expect(
        command.parseAsync(["node", "okou", ...formatArgs, "--help"]),
      ).rejects.toMatchObject({
        code: "commander.helpDisplayed",
        exitCode: 0,
      });

      expect(helpOutput).toContain("--format <format>");
      expect(helpOutput).toContain('choices: "html", "pptx"');
      expect(helpOutput).toMatch(/default:\s+"html"/);
      expect(helpOutput).toContain("--template <id>");
      expect(helpOutput).toContain("--slides <count>");
      expect(helpOutput).toContain("--visibility <visibility>");
      expect(helpOutput).toContain(`Templates (presentation, ${format}):`);
      expect(helpOutput).toContain("template:html-ppt-playful-launch");
      expect(helpOutput).toContain(`Package: ${packageId}`);
      expect(helpOutput).toContain(
        'okou generate presentation --format pptx --prompt "A strategy deck for reducing support volume"',
      );
    },
  );

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
    expect(stdout).toContain("Requested output format: html");
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

  it.each([
    {
      format: "html",
      packageId: "template:html-ppt-playful-launch-runbook",
    },
    { format: "pptx", packageId: "template:pptx-playful-launch-runbook" },
  ])(
    "rejects an unknown template with the $format package catalog",
    async ({ format, packageId }) => {
      const mockConsoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        await expect(async () => {
          await createPresentationGenerateCommand().parseAsync([
            "node",
            "okou",
            "--format",
            format,
            "--prompt",
            "launch plan",
            "--template",
            "not-a-real-template",
          ]);
        }).rejects.toThrow("process.exit called");

        const stderr = mockConsoleError.mock.calls.flat().join("\n");
        expect(stderr).toContain(
          `Unknown template for ${format.toUpperCase()} presentation: not-a-real-template`,
        );
        expect(stderr).toContain(
          `Available templates for ${format.toUpperCase()} presentation:`,
        );
        expect(stderr).toContain(`Package: ${packageId}`);
        expect(stderr).toContain(
          `okou generate presentation --format ${format} --template template:html-ppt-playful-launch --prompt "..."`,
        );
      } finally {
        mockConsoleError.mockRestore();
      }
    },
  );
});
