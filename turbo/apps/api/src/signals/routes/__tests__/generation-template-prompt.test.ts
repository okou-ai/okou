import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
} from "@okouai/core";
import {
  findImageStyle,
  findWebsiteTemplatePackage,
} from "@okouai/core/resource-registry";
import { formatUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import {
  buildGenerationTemplatePrompt,
  buildGenerationTemplatesPrompt,
} from "../../../lib/generation-template-prompt";

const USER_TEMPLATE_ROW_ID = "8f5c9a1e-6f7d-4a2b-9c3e-0d1a2b3c4d5e";

// The presentation assertions below quote one runbook by name, so they pin the
// item by slug: the picker order is a product decision that moves on its own.
function presentationTemplateBySlug(slug: string) {
  const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
    return candidate.slug === slug;
  });
  if (!item) {
    throw new Error(`Expected a registered presentation template: ${slug}`);
  }
  return item;
}

describe("buildGenerationTemplatePrompt", () => {
  it("builds one shared context for multiple ordered templates", () => {
    const illustration = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const workflow = WORKFLOW_TEMPLATE_ITEMS[0]!;

    const result = buildGenerationTemplatesPrompt([
      {
        type: "illustration",
        selection: {
          illustrationStyleId: illustration.illustrationStyleId,
        },
      },
      {
        type: "workflow",
        selection: { workflowTemplateId: workflow.id },
      },
    ]);

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt.match(/^# Inline Templates$/gm)).toHaveLength(1);
    expect(result.prompt).not.toContain("# Artifact Template Context");
    expect(result.prompt).not.toContain("# Workflow Template Context");
    expect(result.prompt).toContain("## Template #1 (illustration)");
    expect(result.prompt).toContain("## Template #2 (workflow)");
    expect(result.prompt).toContain(
      "Match each numbered template marker in the current user message with the same numbered section below.",
    );
    expect(result.prompt).toContain(
      "Apply each template only to the request around its marker.",
    );
    expect(result.prompt).toContain(
      "A template is context, not a request by itself.",
    );
    expect(result.prompt).toContain(illustration.illustrationStyleId);
    expect(result.prompt).toContain(workflow.id);
  });

  it("returns invalid for a presentation selection without a runbook package", () => {
    // Presentations are runbook-only. Retired demo-catalog selections no longer
    // resolve to generation prompts.
    const result = buildGenerationTemplatePrompt({
      type: "presentation",
      selection: {
        templateId: "template:html-ppt-missing",
        previewUrl: "https://example.com/retired.html",
      },
    });

    expect(result.status).toBe("invalid");
  });

  it("builds direct-HTML presentation guidance with the Okou image batch command", () => {
    const item = presentationTemplateBySlug("playful-launch-presentation");

    const result = buildGenerationTemplatePrompt({
      type: "presentation",
      selection: {
        templateId: item.templateId,
        colorSystemId: item.colorSystemId,
      },
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("# Artifact Template Context");
    expect(result.prompt).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    expect(result.prompt).toContain(
      "okou resource pull template:html-ppt-playful-launch-runbook --dir ./generated/resources",
    );
    expect(result.prompt).toContain(
      "./generated/resources/playful-launch/SKILL.md",
    );
    expect(result.prompt).toContain("Color system token: carnival");
    expect(result.prompt).toContain(
      "follow its template, authoring, and verification instructions",
    );
    expect(result.prompt).toContain(
      "Keep all slides and visible content in index.html; render the first slide without JavaScript",
    );
    expect(result.prompt).toContain(
      "okou host <output-dir> --site <slug> --artifact-kind presentation-html",
    );
    const imageWorkflowLines = result.prompt.split("\n").filter((line) => {
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

  it("points a private template at its mounted package and forbids an intermediate representation", () => {
    const result = buildGenerationTemplatePrompt(
      {
        type: "presentation",
        selection: {
          templateId: formatUserPresentationTemplateId(USER_TEMPLATE_ROW_ID),
        },
      },
      {
        mountedUserPresentationTemplateIds: [USER_TEMPLATE_ROW_ID],
      },
    );

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("# Artifact Template Context");
    const packageDir = `./generated/presentation-template/${USER_TEMPLATE_ROW_ID}`;
    expect(result.prompt).toContain(`mounted at ${packageDir}.`);
    expect(result.prompt).toContain(
      `Read ${packageDir}/SKILL.md fully and follow only the files and assets it names`,
    );
    expect(result.prompt).toContain(
      "Author the finished deck directly as semantic HTML, CSS, and SVG",
    );
    expect(result.prompt).toContain(
      "okou generate image-batch start <manifest.tsv> <state-dir>",
    );
    expect(result.prompt).toContain(
      "okou generate image-batch wait <state-dir>",
    );
    // The package is a visual language, not a renderer: an agent that reaches
    // for slide JSON produces something the guidance cannot inform.
    expect(result.prompt).toContain("Do not produce slide JSON");
    expect(result.prompt).toContain("tokens.json");
    expect(result.prompt).toContain(
      "okou host <output-dir> --site <slug> --artifact-kind presentation-html",
    );
    // A private package has no registry resource to pull.
    expect(result.prompt).not.toContain("okou resource pull");
    expect(result.prompt).not.toContain("AGENT_RUNBOOK.md");
    expect(result.prompt).not.toContain("design-system.md");
    expect(result.prompt).not.toContain("color-systems/");
    expect(result.prompt).not.toContain("data-color-system");
    // The raw row id may name the mount, but no storage key may leak.
    expect(result.prompt).not.toContain("presentation-template@");
  });

  it("emits no guidance for a private template the run does not mount", () => {
    const result = buildGenerationTemplatePrompt(
      {
        type: "presentation",
        selection: {
          templateId: formatUserPresentationTemplateId(USER_TEMPLATE_ROW_ID),
        },
      },
      // A prompt steered into an already-running run cannot add a volume to
      // it, so naming the package would send the agent to a path that is not
      // there.
      {
        mountedUserPresentationTemplateIds: [],
      },
    );

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") {
      return;
    }
    expect(result.message).toBe("Presentation template not found");
  });

  it("emits guidance only for the mounted one when several are selected", () => {
    const mounted = USER_TEMPLATE_ROW_ID;
    const unmounted = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

    const result = buildGenerationTemplatesPrompt(
      [
        {
          type: "presentation",
          selection: { templateId: formatUserPresentationTemplateId(mounted) },
        },
        {
          type: "presentation",
          selection: {
            templateId: formatUserPresentationTemplateId(unmounted),
          },
        },
      ],
      {
        mountedUserPresentationTemplateIds: [mounted],
      },
    );

    // One unmountable selection invalidates the whole message rather than
    // silently dropping a template the user attached on purpose.
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") {
      return;
    }
    expect(result.message).toBe("Presentation template not found");
  });

  it("rejects a private template id that is not a row id", () => {
    const result = buildGenerationTemplatePrompt(
      {
        type: "presentation",
        selection: { templateId: "user-template:not-a-uuid" },
      },
      {
        mountedUserPresentationTemplateIds: [],
      },
    );

    // Distinct from an unknown built-in: the caller named the private
    // namespace, so it is not silently retried as a registry slug.
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") {
      return;
    }
    expect(result.message).toBe("Malformed presentation template");
  });

  it("falls back to the default color token when none is selected", () => {
    const item = presentationTemplateBySlug("playful-launch-presentation");

    const result = buildGenerationTemplatePrompt({
      type: "presentation",
      selection: {
        templateId: item.templateId,
      },
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("Color system token: carnival");
  });

  it("builds illustration template guidance", () => {
    const item = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const imageStyle = findImageStyle(item.illustrationStyleId)!;

    const result = buildGenerationTemplatePrompt({
      type: "illustration",
      selection: {
        illustrationStyleId: item.illustrationStyleId,
      },
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("# Artifact Template Context");
    expect(result.prompt).toContain(item.illustrationStyleId);
    expect(result.prompt).toContain(
      `- Style description: ${imageStyle.description}`,
    );
    expect(result.prompt).toContain(
      `okou generate image --provider built-in --style ${item.illustrationStyleId} --prompt "<user request>" --compile --style-source r2`,
    );
    expect(result.prompt).toContain(
      `Style source: private R2 registry resource ${imageStyle.id}`,
    );
    expect(result.prompt).toContain("Follow the returned packet completely");
    expect(result.prompt).toContain(
      "If the R2 source is unavailable, stop without generating; do not fall back to GitHub.",
    );
    expect(result.prompt).toContain("--compiled-prompt");
    expect(result.prompt).toContain("resolved compatible CLI options");
    expect(result.prompt).toContain("required reference image URLs");
  });

  it("builds video template preset guidance", () => {
    const item = VIDEO_TEMPLATE_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "video",
      selection: {
        stylePresetId: item.id,
      },
    });

    expect(result).toStrictEqual({
      status: "resolved",
      prompt: expect.stringContaining("# Artifact Template Context"),
    });
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain(`Template: ${item.title} (${item.id})`);
    expect(result.prompt).toContain(
      `Template source: vm0-ai/vm0-skills@main:${item.sourcePath}`,
    );
    expect(result.prompt).not.toContain("nexu-io/open-design");
    expect(result.prompt).toContain(
      `okou generate video --provider built-in --template ${item.id}`,
    );
    expect(result.prompt).toContain(
      "Run once to fetch the locked video authoring packet",
    );
    expect(result.prompt).toContain(
      "read its SKILL.md before final generation",
    );
    expect(result.prompt).toContain("without `--template`");
  });

  it("reads avatar options from the flat fields older bundles wrote", () => {
    const flat = buildGenerationTemplatePrompt({
      type: "video",
      selection: {
        stylePresetId: "avatar-template:42",
        voiceId: "voice-legacy",
        aspectRatio: "landscape",
      },
    });
    const nested = buildGenerationTemplatePrompt({
      type: "video",
      selection: {
        stylePresetId: "avatar-template:42",
        avatarOptions: { voiceId: "voice-legacy", aspectRatio: "landscape" },
      },
    });

    expect(flat.status).toBe("resolved");
    expect(nested).toStrictEqual(flat);
    if (flat.status !== "resolved") {
      return;
    }
    expect(flat.prompt).toContain("Public JoggAI voice ID: voice-legacy");
    expect(flat.prompt).toContain("Aspect ratio: landscape");
  });

  it("prefers nested avatar options over the flat fallback", () => {
    const result = buildGenerationTemplatePrompt({
      type: "video",
      selection: {
        stylePresetId: "avatar-template:42",
        avatarOptions: { voiceId: "voice-nested" },
        voiceId: "voice-flat",
      },
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("Public JoggAI voice ID: voice-nested");
    expect(result.prompt).not.toContain("voice-flat");
  });

  it("builds workflow template guidance", () => {
    const item = WORKFLOW_TEMPLATE_ITEMS[0]!;

    const result = buildGenerationTemplatePrompt({
      type: "workflow",
      selection: {
        workflowTemplateId: item.id,
      },
    });

    expect(result).toStrictEqual({
      status: "resolved",
      prompt: item.promptGuidance,
    });
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain("# Workflow Template Context");
    expect(result.prompt).toContain(`Auto-inbox label (${item.id})`);
    expect(result.prompt).toContain("Use the workflow-setup skill");
    expect(result.prompt).toContain("Gmail label-applied automation");
    expect(result.prompt).not.toContain("# Artifact Template Context");
  });

  it("builds website template package guidance", () => {
    const item = WEBSITE_TEMPLATE_ITEMS[0]!;
    const resourceId = item.resourceId;
    const latestPackage = findWebsiteTemplatePackage(resourceId);
    if (!latestPackage) {
      throw new Error("Expected current Website template package");
    }

    const result = buildGenerationTemplatePrompt({
      type: "website",
      selection: {
        websiteTemplateId: item.id,
      },
    });

    expect(result).toStrictEqual({
      status: "resolved",
      prompt: expect.stringContaining("# Artifact Template Context"),
    });
    if (result.status !== "resolved") {
      return;
    }
    expect(result.prompt).toContain(`Template: ${item.title} (${item.id})`);
    expect(result.prompt).toContain(`Template package id: ${resourceId}`);
    expect(result.prompt).toContain(`Package resource: ${resourceId}`);
    expect(result.prompt).toContain(
      `Template archive SHA-256: ${latestPackage.source.archive.sha256}`,
    );
    expect(result.prompt).toContain(
      `okou resource pull ${resourceId} --dir ./generated/resources`,
    );
    expect(result.prompt).toContain(
      `Read ./generated/resources/${item.sourcePath}/SKILL.md before authoring`,
    );
    expect(result.prompt).toContain(
      "Assemble the page once with `node tools/compose.mjs <section-ids...>`",
    );
    const imageWorkflowLines = result.prompt.split("\n").filter((line) => {
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
    expect(result.prompt).toContain("until it prints QA_READY");
    expect(result.prompt).toContain("okou host ./publish --site <slug>");
    expect(result.prompt).toContain("checks/verify-published.sh <url>");
    expect(result.prompt).not.toContain("render.mjs");
    expect(result.prompt).not.toContain("tools/generate-images.mjs");
    expect(result.prompt).toContain("built-in R2-backed package");
    expect(result.prompt).not.toContain("okou generate website --template");
  });

  it("selects every current website template package", () => {
    for (const item of WEBSITE_TEMPLATE_ITEMS) {
      const resourceId = item.resourceId;
      const result = buildGenerationTemplatePrompt({
        type: "website",
        selection: {
          websiteTemplateId: item.id,
        },
      });

      expect(result).toStrictEqual({
        status: "resolved",
        prompt: expect.stringContaining(
          `okou resource pull ${resourceId} --dir ./generated/resources`,
        ),
      });
      if (result.status !== "resolved") {
        continue;
      }
      expect(result.prompt).toContain(`Template package id: ${resourceId}`);
      expect(result.prompt).toContain(`Package resource: ${resourceId}`);
      expect(result.prompt).toContain(
        `Read ./generated/resources/${item.sourcePath}/SKILL.md before authoring`,
      );
      expect(result.prompt).toContain(
        "okou generate image-batch start <manifest.tsv> <state-dir>",
      );
      expect(result.prompt).not.toContain("tools/generate-images.mjs");
    }
  });

  it("rejects unknown workflow templates", () => {
    const result = buildGenerationTemplatePrompt({
      type: "workflow",
      selection: {
        workflowTemplateId: "workflow-template:missing",
      },
    });

    expect(result).toStrictEqual({
      status: "invalid",
      message: "Unknown workflow template",
    });
  });

  it("rejects unknown website templates", () => {
    const result = buildGenerationTemplatePrompt({
      type: "website",
      selection: {
        websiteTemplateId: "website-template:missing",
      },
    });

    expect(result).toStrictEqual({
      status: "invalid",
      message: "Unknown website template",
    });
  });
});
