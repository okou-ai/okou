import {
  buildPresentationRunbookInstructionLines,
  findImageStyle,
  findPresentationRunbookPackage,
  findVideoTemplate,
  findWebsiteTemplatePackage,
  resolvePresentationRunbookColorToken,
  type PresentationRunbookPackage,
  type WebsiteTemplatePackage,
} from "@okouai/core/resource-registry";
import {
  findWebsiteTemplateItem,
  type WebsiteTemplateItem,
} from "@okouai/core/website-template-items";
import { findWorkflowTemplateItem } from "@okouai/core/workflow-template-items";
import {
  isUserPresentationTemplateId,
  parseUserPresentationTemplateId,
  userPresentationTemplateDirectory,
} from "@okouai/core/presentation-template-selection";
import {
  parseAvatarTemplateStylePresetId,
  readAvatarTemplateOptions,
  type AvatarTemplateOptions,
} from "@okouai/core/avatar-template";
import {
  PRESENTATION_IMAGE_BATCH_INSTRUCTION,
  PRESENTATION_STATIC_HTML_INSTRUCTION,
} from "@okouai/core/presentation-generation-instructions";
import { WEBSITE_IMAGE_BATCH_INSTRUCTION } from "@okouai/core/website-generation-instructions";
import type { IntroVideoOptions } from "@okouai/api-contracts/contracts/intro-video-options";
import {
  INTRO_VIDEO_TEMPLATE_ID,
  introVideoInstructionLines,
} from "@okouai/core/intro-video-template";
import {
  brandMotionInstructionLines,
  resolveBrandMotionTemplate,
} from "@okouai/core/brand-motion-template-items";

interface PresentationGenerationTemplateInput {
  readonly type: "presentation";
  readonly selection: {
    readonly templateId: string;
    readonly colorSystemId?: string;
    readonly previewUrl?: string;
  };
}

interface VideoGenerationTemplateInput {
  readonly type: "video";
  readonly selection: {
    readonly stylePresetId: string;
    readonly avatarOptions?: AvatarTemplateOptions;
    readonly explainerOptions?: IntroVideoOptions;
    /** @deprecated Read-only fallback; see readAvatarTemplateOptions. */
    readonly titleSnapshot?: string;
    /** @deprecated Read-only fallback; see readAvatarTemplateOptions. */
    readonly previewUrl?: string;
    /** @deprecated Read-only fallback; see readAvatarTemplateOptions. */
    readonly voiceId?: string;
    /** @deprecated Read-only fallback; see readAvatarTemplateOptions. */
    readonly aspectRatio?: "portrait" | "landscape" | "square";
  };
}

interface BrandMotionGenerationTemplateInput {
  readonly type: "brand-motion";
  readonly selection: {
    readonly templateId: string;
  };
}

interface IllustrationGenerationTemplateInput {
  readonly type: "illustration";
  readonly selection: {
    readonly illustrationStyleId: string;
  };
}

interface WorkflowGenerationTemplateInput {
  readonly type: "workflow";
  readonly selection: {
    readonly workflowTemplateId: string;
  };
}

interface WebsiteGenerationTemplateInput {
  readonly type: "website";
  readonly selection: {
    readonly websiteTemplateId: string;
  };
}

type GenerationTemplateInput =
  | PresentationGenerationTemplateInput
  | VideoGenerationTemplateInput
  | BrandMotionGenerationTemplateInput
  | IllustrationGenerationTemplateInput
  | WorkflowGenerationTemplateInput
  | WebsiteGenerationTemplateInput;

type GenerationTemplatePromptResult =
  | {
      readonly status: "resolved";
      readonly prompt: string;
    }
  | {
      readonly status: "invalid";
      readonly message: string;
    };

function generationTemplateTypeLabel(
  generationTemplate: GenerationTemplateInput,
): string {
  if (
    generationTemplate.type === "video" &&
    parseAvatarTemplateStylePresetId(
      generationTemplate.selection.stylePresetId,
    ) !== undefined
  ) {
    return "avatar";
  }
  return generationTemplate.type;
}

/**
 * What a caller must tell the prompt builder about the run it is building for.
 *
 * `mountedUserPresentationTemplateIds` is the set of private template row ids
 * whose packages that run will actually carry. Guidance for a private template
 * is emitted only for an id in this set, so a prompt can never name a package
 * the run does not mount. Callers that cannot mount anything — a prompt
 * steered into an already-running run, whose volumes were fixed at creation —
 * leave it empty and lose the guidance rather than point at nothing.
 */
interface GenerationTemplatePromptOptions {
  readonly introVideoEnabled?: boolean;
  readonly brandMotionEnabled?: boolean;
  readonly mountedUserPresentationTemplateIds?: readonly string[];
}

export function buildGenerationTemplatePrompt(
  generationTemplate: GenerationTemplateInput | null | undefined,
  options: GenerationTemplatePromptOptions = {},
): GenerationTemplatePromptResult {
  if (!generationTemplate) {
    return { status: "resolved", prompt: "" };
  }

  if (generationTemplate.type === "video") {
    return buildVideoGenerationTemplatePrompt(
      generationTemplate,
      options.introVideoEnabled === true,
    );
  }
  if (generationTemplate.type === "brand-motion") {
    return buildBrandMotionGenerationTemplatePrompt(
      generationTemplate,
      options.brandMotionEnabled === true,
    );
  }
  if (generationTemplate.type === "illustration") {
    return buildIllustrationGenerationTemplatePrompt(generationTemplate);
  }
  if (generationTemplate.type === "workflow") {
    return buildWorkflowGenerationTemplatePrompt(generationTemplate);
  }
  if (generationTemplate.type === "website") {
    return buildWebsiteGenerationTemplatePrompt(generationTemplate);
  }

  return buildPresentationGenerationTemplatePrompt(
    generationTemplate,
    options.mountedUserPresentationTemplateIds ?? [],
  );
}

function stripGenerationTemplateContext(prompt: string): string {
  const lines = prompt.split("\n");
  if (lines[0] === "# Workflow Template Context") {
    return lines.slice(lines[1] === "" ? 2 : 1).join("\n");
  }
  if (lines[0] !== "# Artifact Template Context") {
    return prompt;
  }
  const framingEnd = lines.findIndex((line, index) => {
    return index > 1 && line === "";
  });
  return lines.slice(framingEnd + 1).join("\n");
}

export function buildGenerationTemplatesPrompt(
  generationTemplates: readonly GenerationTemplateInput[],
  options: GenerationTemplatePromptOptions = {},
): GenerationTemplatePromptResult {
  if (generationTemplates.length === 0) {
    return { status: "resolved", prompt: "" };
  }
  const details: string[] = [];
  for (const [index, generationTemplate] of generationTemplates.entries()) {
    const built = buildGenerationTemplatePrompt(generationTemplate, options);
    if (built.status === "invalid") {
      return built;
    }
    details.push(
      [
        `## Template #${index + 1} (${generationTemplateTypeLabel(generationTemplate)})`,
        "",
        stripGenerationTemplateContext(built.prompt),
      ].join("\n"),
    );
  }
  return {
    status: "resolved",
    prompt: [
      "# Inline Templates",
      "",
      "Match each numbered template marker in the current user message with the same numbered section below.",
      "- Apply each template only to the request around its marker.",
      "- A template is context, not a request by itself.",
      "",
      details.join("\n\n"),
    ].join("\n"),
  };
}

function templateFraming(artifactNoun: string): readonly string[] {
  return [
    "# Artifact Template Context",
    "",
    `- The user deliberately selected this artifact template for this run — treat it as the default style whenever you produce ${artifactNoun} here.`,
    `- It does not force you to generate: the user's prompt decides the task, content, output format, and whether to produce an artifact at all. If a request isn't about producing ${artifactNoun}, just answer it normally.`,
    "- Other artifact templates, files, or attachments may also be present.",
    "",
  ];
}

function buildWorkflowGenerationTemplatePrompt(
  generationTemplate: WorkflowGenerationTemplateInput,
): GenerationTemplatePromptResult {
  const template = findWorkflowTemplateItem(
    generationTemplate.selection.workflowTemplateId,
  );
  if (!template) {
    return { status: "invalid", message: "Unknown workflow template" };
  }
  return { status: "resolved", prompt: template.promptGuidance };
}

function buildPresentationGenerationTemplatePrompt(
  generationTemplate: PresentationGenerationTemplateInput,
  mountedUserPresentationTemplateIds: readonly string[],
): GenerationTemplatePromptResult {
  const { templateId } = generationTemplate.selection;
  if (isUserPresentationTemplateId(templateId)) {
    const rowId = parseUserPresentationTemplateId(templateId);
    if (rowId === undefined) {
      return { status: "invalid", message: "Malformed presentation template" };
    }
    // The guidance is worth nothing without the package it tells the agent to
    // read, so it is emitted only for a row this run actually mounts.
    if (!mountedUserPresentationTemplateIds.includes(rowId)) {
      return { status: "invalid", message: "Presentation template not found" };
    }
    return buildUserPresentationTemplatePrompt(rowId);
  }
  // Presentation picker selections are valid only when they resolve to a
  // self-contained runbook package. The legacy multi-resource registry flow has
  // been retired, so ids without a runbook package are rejected.
  const runbookPackage = findPresentationRunbookPackage(templateId);
  if (!runbookPackage) {
    return { status: "invalid", message: "Unknown generation template" };
  }
  return buildPresentationRunbookPrompt(generationTemplate, runbookPackage);
}

/**
 * Guidance for a deck the user imported.
 *
 * The package is mounted as an ordinary skill, so the prompt names the skill
 * rather than a path: the skills root differs per framework and the prompt is
 * built before a framework is chosen.
 *
 * The authoring rules are the point of the whole feature. The package
 * describes a visual language, not a renderer: there is no deck schema, no
 * layout id service, and no JSON-to-HTML compiler behind it, so an agent that
 * reaches for its usual intermediate representation produces something the
 * package cannot inform.
 */
function buildUserPresentationTemplatePrompt(
  rowId: string,
): GenerationTemplatePromptResult {
  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a presentation"),
      `Selected presentation template: the user's own imported deck, mounted at ./${userPresentationTemplateDirectory(rowId)}.`,
      "",
      "To produce the presentation:",
      `- Read ./${userPresentationTemplateDirectory(rowId)}/SKILL.md fully and follow only the files and assets it names.`,
      "- Author the finished deck directly as semantic HTML, CSS, and SVG for this request's content.",
      "- Do not produce slide JSON, read a `tokens.json`, call a layout-id API, or run a template-specific JSON-to-HTML renderer first. None of those exist for this package; the guidance describes a visual language, not a renderer.",
      "- Lay out live rows, columns, and text flow with CSS Grid or Flexbox. Absolute positioning is for backgrounds, fixed chrome, decoration, and intentional overlays.",
      "- Background images from the package are optional visual material. New text, charts, tables, labels, and diagrams stay live HTML or SVG so they reflow and stay legible.",
      "- Use the slide count the user asks for; if unspecified, default to 8 pages.",
      PRESENTATION_IMAGE_BATCH_INSTRUCTION,
      PRESENTATION_STATIC_HTML_INSTRUCTION,
      "- Host the finished deck: okou host <output-dir> --site <slug> --artifact-kind presentation-html",
      "- Return only the generated HTML deck as the final deliverable.",
    ].join("\n"),
  };
}

function buildPresentationRunbookPrompt(
  generationTemplate: PresentationGenerationTemplateInput,
  runbookPackage: PresentationRunbookPackage,
): GenerationTemplatePromptResult {
  const color = resolvePresentationRunbookColorToken(
    runbookPackage,
    generationTemplate.selection.colorSystemId,
  );
  if ("error" in color) {
    return {
      status: "invalid",
      message: "Unknown generation template color system",
    };
  }

  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a presentation"),
      ...buildPresentationRunbookInstructionLines({
        runbookPackage,
        colorSystemToken: color.token,
      }),
    ].join("\n"),
  };
}

function buildWebsiteGenerationTemplatePrompt(
  generationTemplate: WebsiteGenerationTemplateInput,
): GenerationTemplatePromptResult {
  const item = findWebsiteTemplateItem(
    generationTemplate.selection.websiteTemplateId,
  );
  if (!item) {
    return { status: "invalid", message: "Unknown website template" };
  }

  const pkg = findWebsiteTemplatePackage(item.templateId);
  if (!pkg) {
    return { status: "invalid", message: "Unknown website template" };
  }

  return buildWebsiteTemplatePackagePrompt(item, pkg);
}

function buildWebsiteTemplatePackagePrompt(
  item: WebsiteTemplateItem,
  pkg: WebsiteTemplatePackage,
): GenerationTemplatePromptResult {
  const packageDir = `./generated/resources/${pkg.slug}`;

  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a website"),
      "Selected website template:",
      "- Artifact type: website",
      `- Template: ${item.title} (${item.id})`,
      `- Template description: ${pkg.description}`,
      `- Template package id: ${pkg.templateId}`,
      `- Package resource: ${pkg.resourceId}`,
      `- Template archive SHA-256: ${pkg.source.archive.sha256}`,
      "",
      "When you produce a website from the user's request:",
      `- Pull the package: okou resource pull ${pkg.resourceId} --dir ./generated/resources`,
      `- Work from ${packageDir}. Inspect the bundled package metadata and instructions before editing.`,
      `- Read ${packageDir}/SKILL.md before authoring; it owns this package's contract.`,
      "- Assemble the page once with `node tools/compose.mjs <section-ids...>`, then author the composed index.html directly. The command refuses a second compose pass; bypassing that guard would discard authored work.",
      `- ${WEBSITE_IMAGE_BATCH_INSTRUCTION}`,
      "- Repair every blocking failure from `bash checks/verify.sh index.html qa` until it prints QA_READY.",
      "- Stage and host once: `node tools/stage.mjs publish` writes a clean ./publish directory, then `okou host ./publish --site <slug>`.",
      "- Check the deployed page with `bash checks/verify-published.sh <url>`; a local pass is not evidence about the deployment.",
      "- Use this built-in R2-backed package; do not substitute generic Open Design website templates for the selected template.",
      "- Return the hosted website URL and keep the generated static site as the final deliverable.",
    ].join("\n"),
  };
}

function buildBrandMotionGenerationTemplatePrompt(
  generationTemplate: BrandMotionGenerationTemplateInput,
  enabled: boolean,
): GenerationTemplatePromptResult {
  const resolved = resolveBrandMotionTemplate(
    generationTemplate.selection.templateId,
    enabled,
  );
  if (resolved.status === "invalid") {
    return resolved;
  }
  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a brand motion video"),
      ...brandMotionInstructionLines(resolved.template),
    ].join("\n"),
  };
}

function buildVideoGenerationTemplatePrompt(
  generationTemplate: VideoGenerationTemplateInput,
  introVideoEnabled: boolean,
): GenerationTemplatePromptResult {
  if (generationTemplate.selection.stylePresetId === INTRO_VIDEO_TEMPLATE_ID) {
    if (!introVideoEnabled) {
      return { status: "invalid", message: "Intro video is not available" };
    }
    const options = generationTemplate.selection.explainerOptions;
    if (!options) {
      return {
        status: "invalid",
        message: "Intro video settings are missing",
      };
    }
    return {
      status: "resolved",
      prompt: [
        ...templateFraming("an intro video"),
        ...introVideoInstructionLines(options),
      ].join("\n"),
    };
  }
  const avatarId = parseAvatarTemplateStylePresetId(
    generationTemplate.selection.stylePresetId,
  );
  if (avatarId !== undefined) {
    const avatarOptions = readAvatarTemplateOptions(
      generationTemplate.selection,
    );
    return buildAvatarGenerationTemplatePrompt(
      avatarId,
      avatarOptions.voiceId,
      avatarOptions.aspectRatio,
    );
  }

  const template = findVideoTemplate(
    generationTemplate.selection.stylePresetId,
  );
  if (!template) {
    return { status: "invalid", message: "Unknown video template" };
  }
  const sourceRepo = template.source.repo;
  const sourceRef = template.source.ref;
  const sourcePath = template.source.path;
  const templateSource = `${sourceRepo}@${sourceRef}:${sourcePath}`;
  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a video"),
      "Selected video template:",
      "- Artifact type: video",
      `- Template: ${template.name} (${template.id})`,
      `- Template description: ${template.description}`,
      `- Template source: ${templateSource}`,
      "",
      "When you produce a video from the user's request:",
      `- Run once to fetch the locked video authoring packet: okou generate video --provider built-in --template ${template.id} --prompt "<user request>"`,
      `- The packet points back to the selected template source (${templateSource}); read its SKILL.md before final generation.`,
      "- Then run final direct video generation from the resolved prompt and parameters without `--template`.",
      "- If a connector/provider is requested, follow connector guidance instead.",
      "- If a flag above no longer applies, run `okou generate video -h` to discover the current flags, models, and providers.",
    ].join("\n"),
  };
}

function buildAvatarGenerationTemplatePrompt(
  avatarId: number,
  voiceId: string | undefined,
  aspectRatio: "portrait" | "landscape" | "square" | undefined,
): GenerationTemplatePromptResult {
  const selectedVoiceLines = voiceId
    ? [`- Public JoggAI voice ID: ${voiceId}`]
    : [];
  const voiceInstructionLines = voiceId
    ? [
        `- Keep voice ID ${voiceId} exactly; do not list voices or substitute a different voice.`,
      ]
    : [
        "- List the available voices with `okou generate avatar-video --provider built-in --list-voices --json`, applying a voice-language filter when the user specifies a language, then choose a suitable voice.",
      ];
  const generationVoiceId = voiceId ?? "<voice-id>";
  const generationAspectRatio = aspectRatio ?? "portrait";
  return {
    status: "resolved",
    prompt: [
      ...templateFraming("a talking-avatar video"),
      "Selected talking-avatar template:",
      "- Artifact type: talking-avatar video",
      `- Public JoggAI avatar ID: ${avatarId}`,
      ...selectedVoiceLines,
      `- Aspect ratio: ${generationAspectRatio}`,
      "",
      "When you produce a talking-avatar video from the user's request:",
      `- Keep avatar ID ${avatarId} exactly; do not list avatars or substitute a different avatar.`,
      "- Run `okou generate avatar-video -h` to inspect the current supported flags.",
      ...voiceInstructionLines,
      `- Generate with \`okou generate avatar-video --provider built-in --avatar-id ${avatarId} --voice-id ${generationVoiceId} --aspect-ratio ${generationAspectRatio} --script "<script>"\`.`,
      "- If the user provides a public audio URL, use `--audio-url` instead of `--script`.",
      "- Return the generated `/f/` video URL as the final deliverable.",
      "- Use a connector/provider only when the user explicitly requests one.",
    ].join("\n"),
  };
}

function buildIllustrationGenerationTemplatePrompt(
  generationTemplate: IllustrationGenerationTemplateInput,
): GenerationTemplatePromptResult {
  const imageStyle = findImageStyle(
    generationTemplate.selection.illustrationStyleId,
  );
  if (!imageStyle) {
    return { status: "invalid", message: "Unknown generation image style" };
  }
  const styleSource = `private R2 registry resource ${imageStyle.id}`;
  const compileCommand = `okou generate image --provider built-in --style ${imageStyle.id} --prompt "<user request>" --compile --style-source r2`;
  const sourceInstruction =
    "Follow the returned packet completely, including pulling the private R2 package and reading its extracted SKILL.md. If the R2 source is unavailable, stop without generating; do not fall back to GitHub.";

  return {
    status: "resolved",
    prompt: [
      ...templateFraming("an illustration or image"),
      "Selected illustration style:",
      "- Artifact type: illustration",
      `- Style: ${imageStyle.name} (${imageStyle.id})`,
      `- Style description: ${imageStyle.description}`,
      `- Style source: ${styleSource}`,
      "",
      "When you produce an illustration or image from the user's request:",
      `- Run once: ${compileCommand}`,
      `- ${sourceInstruction}`,
      '- Then run `okou generate image --provider built-in --compiled-prompt "<compiled prompt>"` with the resolved compatible CLI options and required reference image URLs, without `--style`.',
      "- If a flag above no longer applies, run `okou generate image -h` to discover the current flags, models, providers, and styles.",
    ].join("\n"),
  };
}
