import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { generateCommand } from "../index";
import { reportCommand } from "../artifacts";
import { selectResourceCandidates } from "@okouai/core/resource-registry";

describe("okou generate source-backed artifact commands", () => {
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
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  it.each([
    {
      command: "report",
      prompt: "Q2 generation usage report",
    },
    {
      command: "docs-design",
      prompt: "Docs for adding built-in artifact targets",
    },
    {
      command: "poster",
      prompt: "A poster for source-backed generation",
    },
    {
      command: "dashboard-design",
      prompt: "A dashboard for generation run health",
    },
    {
      command: "mobile-app-design",
      prompt: "A mobile app design for reviewing generated artifacts",
    },
  ])(
    "prints a source selection packet for $command",
    async ({ command, prompt }) => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        command,
        "--prompt",
        prompt,
        "--site-slug",
        `${command}-demo`,
        "--title",
        `${command} demo`,
      ]);

      const stdout = output();
      expect(stdout).toContain(`# Okou generate ${command}`);
      expect(stdout).toContain("generation source-selection packet");
      expect(stdout).not.toContain("federated");
      expect(stdout).toContain(prompt);
      expect(stdout).toContain(
        `https://static.okou.io/html-resources/9e005c4ace807d67338dfa701877df10175a4d2a1c677dea1414aba76867493d/${command}.json`,
      );
      expect(stdout).not.toContain("/website.json");
      expect(stdout).not.toContain("Sources:");
      expect(stdout).toContain('"templates": "string[]"');
      expect(stdout).toContain(
        "Resolve and download only resources selected from the index.",
      );
      expect(stdout).not.toContain("source.pull");
      expect(stdout).not.toContain("built-in R2 template packages");
      expect(stdout).toContain(`Artifact kind: ${command}`);
      expect(stdout).toContain("## Artifact Output Model");
      expect(stdout).toContain(
        `Primary artifact: \`${command}\` at \`./generated/mockups/${command}-demo/index.html\`.`,
      );
      expect(stdout).toContain(
        `Write the artifact under \`./generated/mockups/${command}-demo/\`.`,
      );
      expect(stdout).toContain(
        `okou host ./generated/mockups/${command}-demo --site ${command}-demo\n`,
      );
      expect(stdout).toContain(
        "The hosted URL is the preview and user-accessible view for this static HTML artifact.",
      );
      expect(stdout).toContain(
        "Check that shapes, charts, images, or decorative graphics do not cover readable text",
      );
    },
  );

  it.each([
    "report",
    "docs-design",
    "poster",
    "dashboard-design",
    "mobile-app-design",
  ])(
    "preserves org visibility in %s delivery instructions",
    async (command) => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        command,
        "--prompt",
        "An internal planning artifact",
        "--site-slug",
        "team-plan",
        "--visibility",
        "org",
      ]);

      expect(output()).toContain(
        "okou host ./generated/mockups/team-plan --site team-plan --visibility org\n",
      );
      expect(output()).toContain(
        "okou web upload-file -f <file> --visibility org",
      );
    },
  );

  it("exposes the shared HTML artifact flags in report help", () => {
    let helpOutput = "";
    reportCommand.configureOutput({
      writeOut: (str: string) => {
        helpOutput += str;
      },
    });

    reportCommand.outputHelp();

    expect(helpOutput).toContain("--prompt <text>");
    expect(helpOutput).toContain("--site-slug <slug>");
    expect(helpOutput).toContain("--title <text>");
    expect(helpOutput).toContain("--design-system <id>");
    expect(helpOutput).toContain("--template <id>");
    expect(helpOutput).toContain("--visibility <visibility>");
  });

  it("returns every registered skill when no target is requested", () => {
    const selection = selectResourceCandidates();

    expect(selection.candidates.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "skill:theme-factory",
          description: expect.stringContaining(
            "Apply professional font and color themes",
          ),
          source: expect.objectContaining({
            path: "skills/theme-factory/SKILL.md",
          }),
        }),
      ]),
    );
  });

  it("filters skill candidates by target when requested", () => {
    const websiteSkillIds = selectResourceCandidates(
      "website",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });
    const reportSkillIds = selectResourceCandidates(
      "report",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });
    const posterSkillIds = selectResourceCandidates(
      "poster",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });
    const presentationSkillIds = selectResourceCandidates(
      "presentation",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });
    const imageSkillIds = selectResourceCandidates(
      "image",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });
    const videoSkillIds = selectResourceCandidates(
      "video",
    ).candidates.skills.map((skill) => {
      return skill.id;
    });

    expect(websiteSkillIds).toHaveLength(23);
    expect(reportSkillIds).toHaveLength(23);
    expect(posterSkillIds).toHaveLength(28);
    expect(presentationSkillIds).toHaveLength(6);
    expect(imageSkillIds).toHaveLength(5);
    expect(videoSkillIds).toHaveLength(18);

    expect(websiteSkillIds).toContain("skill:article-magazine");
    expect(reportSkillIds).toContain("skill:article-magazine");
    expect(reportSkillIds).not.toContain("skill:design-brief");
    expect(reportSkillIds).not.toContain("skill:algorithmic-art");
    expect(reportSkillIds).not.toContain("skill:slides");
    expect(reportSkillIds).not.toContain("skill:video-hyperframes");
    expect(reportSkillIds).not.toContain("skill:8-bit-orbit-video-template");

    expect(posterSkillIds).toContain("skill:article-magazine");
    expect(posterSkillIds).toContain("skill:algorithmic-art");
    expect(presentationSkillIds).toContain("skill:slides");
    expect(presentationSkillIds).not.toContain(
      "skill:presentation-reverse-template",
    );
    expect(imageSkillIds).toContain("skill:algorithmic-art");
    expect(videoSkillIds).toContain("skill:video-hyperframes");
    expect(videoSkillIds).toContain("skill:8-bit-orbit-video-template");
  });

  it("returns every registered template and design system", () => {
    const selection = selectResourceCandidates();

    expect(selection.candidates.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "template:finance-report",
          description: expect.stringContaining("financial report"),
        }),
      ]),
    );
    expect(selection.candidates.designSystems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "design-system:shopify",
          description: expect.stringContaining("E-commerce platform"),
        }),
      ]),
    );
  });

  it("filters template candidates by target when requested", () => {
    const websiteSelection = selectResourceCandidates("website");
    const presentationSelection = selectResourceCandidates("presentation");

    expect(websiteSelection.candidates.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "template:warm-cards",
          source: expect.objectContaining({
            path: "warm-cards",
            archive: expect.objectContaining({ type: "tar.gz" }),
          }),
        }),
      ]),
    );
    expect(websiteSelection.candidates.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "template:saas-landing" }),
        expect.objectContaining({ id: "template:web-prototype" }),
      ]),
    );
    expect(websiteSelection.candidates.templates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "template:html-ppt-pitch-deck" }),
      ]),
    );
    expect(presentationSelection.candidates.templates).toHaveLength(0);
  });

  it("annotates every template entry with at least one target", () => {
    const selection = selectResourceCandidates();
    for (const template of selection.candidates.templates) {
      expect(
        template.targets,
        `${template.id} is missing the targets field`,
      ).toBeDefined();
      expect(
        template.targets?.length,
        `${template.id} has an empty targets array`,
      ).toBeGreaterThan(0);
    }
  });

  it("annotates every skill entry with targets", () => {
    const selection = selectResourceCandidates();
    for (const skill of selection.candidates.skills) {
      expect(
        skill.targets,
        `${skill.id} is missing the targets field`,
      ).toBeDefined();
    }
  });

  it("accepts --design-system and --template on report", async () => {
    await generateCommand.parseAsync([
      "node",
      "cli",
      "report",
      "--prompt",
      "Q2 finance report",
      "--site-slug",
      "q2-finance-demo",
      "--design-system",
      "apple",
      "--template",
      "finance-report",
    ]);

    const stdout = output();
    expect(stdout).toContain(
      "Selected design system: design-system:apple (Apple)",
    );
    expect(stdout).toContain(
      "Selected template: template:finance-report (Finance Report)",
    );
  });

  it("rejects an unknown template id on dashboard-design", async () => {
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "dashboard-design",
        "--prompt",
        "a dashboard",
        "--template",
        "not-a-real-template",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown template for dashboard-design");
  });

  it("rejects a template that does not target the requested kind", async () => {
    // finance-report only targets report and should fail for dashboard-design
    await expect(async () => {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "dashboard-design",
        "--prompt",
        "a dashboard",
        "--template",
        "finance-report",
      ]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("Unknown template for dashboard-design");
  });
});
