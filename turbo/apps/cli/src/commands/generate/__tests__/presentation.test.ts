/**
 * Tests for okou generate presentation command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): none for the source-selection path
 * - Real (internal): prompt parsing and authoring packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { generateCommand } from "../index";
import { presentationCommand } from "../presentation";

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

  it("should print direct authoring instructions for presentation", async () => {
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
    expect(stdout).toContain("direct HTML presentation authoring packet");
    expect(stdout).not.toContain("generation source-selection packet");
    expect(stdout).not.toContain("## Stage 1: Resource Selection");
    expect(stdout).not.toContain("## Candidate Registry Slice");
    expect(stdout).toContain("API migration plan");
    expect(stdout).not.toContain("skill:article-magazine");
    expect(stdout).not.toContain("design-system:");
    expect(stdout).not.toContain("Selected design system");
    expect(stdout).toContain("Selected template: agent decides");
    expect(stdout).not.toContain("template:html-ppt-graphify-dark-graph");
    expect(stdout).not.toContain("template:saas-landing");
    expect(stdout).not.toContain("## Output Contract");
    expect(stdout).not.toContain("```bash");
    expect(stdout).not.toContain("okou host ./generated/mockups");
    expect(stdout).toContain("Slide count: 10");
    expect(stdout).toContain("Use a fixed 1920x1080 slide canvas");
    expect(stdout).toContain(
      "Keep all slides and visible content in index.html; render the first slide without JavaScript",
    );
    expect(stdout).toContain(
      "okou generate image-batch start <manifest.tsv> <state-dir>",
    );
    expect(stdout).toContain("okou generate image-batch wait <state-dir>");
    expect(stdout).toContain("Produce exactly the requested slide count");
    expect(stdout).toContain("make an internal slide plan");
    expect(stdout).toContain(
      "Adapt the selected template to the requested slide count",
    );
    expect(stdout).toContain(
      "Use selected template references only for structure, layout devices, spacing, and visual language",
    );
    expect(stdout).toContain(
      "Derive every presentation image/media choice from the user's requested topic",
    );
    expect(stdout).toContain("Vary slide forms across the deck");
    expect(stdout).toContain(
      "Check that shapes, charts, images, or decorative graphics do not cover readable text",
    );
    expect(stdout).toContain(
      "Host the finished deck: okou host <output-dir> --site <slug> --artifact-kind presentation-html\n",
    );
    expect(stdout).toContain(
      "With privateArtifacts enabled, new artifacts default to only-me.",
    );
  });

  it.each([
    { label: "direct authoring", templateArgs: [] },
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
      return line.includes("okou host ");
    });
    expect(hostInstructions).toEqual([
      "- Host the finished deck: okou host <output-dir> --site team-plan --artifact-kind presentation-html --visibility org",
    ]);
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

  it("should list presentation templates but not design systems in help", () => {
    let helpOutput = "";
    presentationCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    presentationCommand.outputHelp();

    expect(helpOutput).not.toContain("Design Systems:");
    expect(helpOutput).not.toContain("design-system:apple");
    expect(helpOutput).toContain("Templates (presentation):");
    expect(helpOutput).toContain("template:html-ppt-playful-launch");
    expect(helpOutput).not.toContain("Templates (presentation registry):");
    expect(helpOutput).not.toContain("(no presentation templates registered)");
    expect(helpOutput).not.toContain("template:html-ppt-pitch-deck");
    expect(helpOutput).not.toContain("template:saas-landing");
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
      "Host the finished deck: okou host <output-dir> --site <slug> --artifact-kind presentation-html\n",
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
      expect(stderr).not.toContain("Available design systems");
    } finally {
      mockConsoleError.mockRestore();
    }
  });

  it.each(["--design-system", "--runbook"])(
    "should reject removed presentation selector flag %s",
    async (flag) => {
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
            "investor pitch",
            flag,
            "html-ppt-playful-launch",
          ]);
        }).rejects.toThrow("process.exit called");

        const stderr = mockStderrWrite.mock.calls
          .map(([chunk]) => {
            return String(chunk);
          })
          .join("");
        expect(stderr).toContain(`unknown option '${flag}'`);
      } finally {
        mockStderrWrite.mockRestore();
      }
    },
  );
});
