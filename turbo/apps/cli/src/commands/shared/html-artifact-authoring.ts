import type {
  GenerationOutputKind,
  GenerationTarget,
} from "@okouai/core/resource-registry";
import type { ArtifactVisibility } from "./artifact-visibility";

/** Generation targets authored as static HTML from a target-specific resource index. */
export type HtmlArtifactKind = Extract<
  GenerationTarget,
  | "website"
  | "report"
  | "poster"
  | "dashboard-design"
  | "mobile-app-design"
  | "docs-design"
>;

const HTML_RESOURCE_INDEX_BASE_URL =
  "https://static.okou.io/html-resources/9e005c4ace807d67338dfa701877df10175a4d2a1c677dea1414aba76867493d";
const WEBSITE_RESOURCE_INDEX_URL =
  "https://static.okou.io/html-resources/website/v1/d7138a8fc889c7fda5e57e463d178c37e97a1bb4fd752f56a793dc2e53c1935a/website.json";

const HTML_RESOURCE_INDEX_URLS: Record<HtmlArtifactKind, string> = {
  website: WEBSITE_RESOURCE_INDEX_URL,
  report: `${HTML_RESOURCE_INDEX_BASE_URL}/report.json`,
  poster: `${HTML_RESOURCE_INDEX_BASE_URL}/poster.json`,
  "dashboard-design": `${HTML_RESOURCE_INDEX_BASE_URL}/dashboard-design.json`,
  "mobile-app-design": `${HTML_RESOURCE_INDEX_BASE_URL}/mobile-app-design.json`,
  "docs-design": `${HTML_RESOURCE_INDEX_BASE_URL}/docs-design.json`,
};

interface HtmlArtifactAuthoringOptions {
  readonly kind: HtmlArtifactKind;
  readonly prompt: string;
  readonly slugSource?: string;
  readonly siteSlug?: string;
  readonly visibility?: ArtifactVisibility;
  readonly details: readonly string[];
  readonly artifactRules: readonly string[];
}

interface HtmlArtifactSelectionOutputSchema {
  readonly skills: "string[]";
  readonly templates: "string[]";
  readonly designSystems: "string[]";
  readonly rationale: "string";
}

interface HtmlArtifactAuthoringPacket {
  readonly type: "generation-source-selection";
  readonly kind: HtmlArtifactKind;
  readonly prompt: string;
  readonly artifact: {
    readonly outputMode: "primary-artifact-with-supporting-assets";
    readonly primaryArtifact: {
      readonly kind: GenerationOutputKind;
      readonly path: string;
    };
    readonly supportingAssets: readonly {
      readonly kind: GenerationOutputKind | "metadata";
      readonly path: string;
      readonly optional: boolean;
    }[];
    readonly previewKind: "hosted-url";
    readonly outputDir: string;
  };
  readonly selection: {
    readonly indexUrl: string;
    readonly outputSchema: HtmlArtifactSelectionOutputSchema;
  };
  readonly authoring: {
    readonly details: readonly string[];
    readonly artifactRules: readonly string[];
  };
  readonly outputDir: string;
  readonly site: string;
  readonly hostCommand: string;
  readonly instructions: string;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return slug.length >= 3 ? slug : "html-artifact";
}

function titleForKind(kind: HtmlArtifactKind): string {
  const titles: Record<HtmlArtifactKind, string> = {
    website: "hosted website",
    "dashboard-design": "dashboard design prototype",
    "mobile-app-design": "mobile app design prototype",
    poster: "poster",
    report: "report",
    "docs-design": "documentation design prototype",
  };

  return titles[kind];
}

function outputDirForSite(site: string): string {
  return `./generated/mockups/${site}`;
}

export function createHtmlArtifactAuthoringPacket(
  options: HtmlArtifactAuthoringOptions,
): HtmlArtifactAuthoringPacket {
  const site =
    options.siteSlug ?? slugify(options.slugSource ?? options.prompt);
  const outputDir = outputDirForSite(site);
  const visibilityFlag =
    options.visibility === undefined
      ? ""
      : ` --visibility ${options.visibility}`;
  const hostCommand = `okou host ${outputDir} --site ${site}${
    options.kind === "website" ? " --spa" : ""
  }${visibilityFlag}`;
  const title = titleForKind(options.kind);
  const resourceIndexUrl = HTML_RESOURCE_INDEX_URLS[options.kind];
  const selectionSchema: HtmlArtifactSelectionOutputSchema = {
    skills: "string[]",
    templates: "string[]",
    designSystems: "string[]",
    rationale: "string",
  };
  const selectionLines = [
    "## Stage 1: Resource Selection",
    "- Download only the target-specific Resource Index listed below.",
    "- The index contains templates and target-specific skills for this target, plus design systems for HTML generation.",
    "- Derive keywords from the user prompt and search the index's `id`, `name`, and `description` fields.",
    "- Select resources only when they are useful for the request. There is no fixed selection count for any resource type.",
    "- Choose only IDs present in the index; do not invent resource IDs.",
    "- Treat the selection JSON as internal working state, then continue to authoring.",
    "",
    "## Selection Output Schema",
    "```json",
    JSON.stringify(selectionSchema, null, 2),
    "```",
    "",
    "## Resource Index",
    `URL: \`${resourceIndexUrl}\``,
    "",
  ];
  const resolutionLines = [
    "## Stage 2: Resolve Selected Resources",
    "- Resolve and download only resources selected from the index. Do not fetch unselected resources.",
    "- For a selected entry without `source.archive`, resolve its `source.path` from the index's pinned `source.repo@source.ref`. Do not run `okou resource pull` for it.",
    ...(options.kind === "website"
      ? [
          "- For a selected entry with `source.archive`, run its exact `source.pull.command`, then use `source.pull.resolvedPath`. Do not construct or guess a direct R2 URL.",
          "- The Website index includes Okou built-in R2 template packages as template entries with `source.archive`.",
          "- Each built-in Website template entry includes the exact pull command and extracted package path in `source.pull`.",
        ]
      : []),
    "- For directory refs, inspect the most relevant files such as `SKILL.md`, `DESIGN.md`, `README.md`, tokens, examples, and templates.",
    "- If a source file cannot be fetched, state that limitation and fall back to the index metadata for that resource.",
    "",
  ];
  const artifact = {
    outputMode: "primary-artifact-with-supporting-assets",
    primaryArtifact: {
      kind: options.kind,
      path: `${outputDir}/index.html`,
    },
    supportingAssets: [
      {
        kind: "image",
        path: `${outputDir}/assets/`,
        optional: true,
      },
      {
        kind: "audio",
        path: `${outputDir}/assets/`,
        optional: true,
      },
      {
        kind: "video",
        path: `${outputDir}/assets/`,
        optional: true,
      },
      {
        kind: "metadata",
        path: `${outputDir}/metadata.json`,
        optional: true,
      },
    ],
    previewKind: "hosted-url",
    outputDir,
  } as const;
  const instructions = [
    `# Okou generate ${options.kind}`,
    "",
    "This is a generation source-selection packet for the current agent.",
    `Okou is not generating this ${title} on the server. You select resources, resolve them, and author the artifact.`,
    "",
    "## User Prompt",
    options.prompt,
    "",
    ...selectionLines,
    ...resolutionLines,
    "## Stage 3: Author Artifact",
    `Author a production-quality ${title} as a static HTML artifact using the selected generation resources.`,
    "",
    "## Artifact Output Model",
    `- Primary artifact: \`${artifact.primaryArtifact.kind}\` at \`${artifact.primaryArtifact.path}\`.`,
    `- Output mode: \`${artifact.outputMode}\`.`,
    "- Supporting images, audio, video, or metadata may live inside the same output directory when the result needs them.",
    "- Treat the output directory as a project bundle when multiple media types are generated, while keeping the HTML entry point primary.",
    "",
    "## Output Contract",
    `- Write the artifact under \`${outputDir}/\`.`,
    `- The entry file must be \`${outputDir}/index.html\`.`,
    "- Keep every local asset inside the same output directory.",
    "- Keep supporting generated media at its default visibility and bundle local copies. The selected visibility applies to the final artifact; do not make supporting media public separately.",
    "- For private generated media, use `okou web download-file --help` to download by file ID, artifact URL, or /artifacts/<hash> reference; bundle the downloaded assets using relative paths. Never embed private artifact references (absolute or hostless) or expiring preview/provider signatures in HTML.",
    "- Image batch results may be relative asset paths rooted at the batch state directory. Copy its optimized WebP assets into this output bundle, reference them with relative paths, and preserve image dimensions.",
    "- Do not reference files from another project path.",
    "- Use descriptive filenames and canonical HTML: close non-void tags and double-quote attributes.",
    "- Prefer a single self-contained HTML file unless the artifact genuinely needs separate assets.",
    "",
    "## Requested Parameters",
    ...options.details.map((detail) => {
      return `- ${detail}`;
    }),
    "",
    "## Authoring Rules",
    "- Let the selected template define structure, the selected design system define visual language, and the selected skills define process.",
    "- Read the local codebase, brand assets, and existing design systems when the prompt depends on this repository.",
    "- Avoid generic AI design defaults: no stock SaaS gradients, no emoji-as-icons, no filler stats, no decorative chrome that does not help the artifact.",
    "- Build the actual artifact first, not a marketing explanation of the artifact.",
    "- Make controls and interactions real when they are visible.",
    "- Keep text readable at desktop and mobile preview sizes.",
    ...options.artifactRules.map((rule) => {
      return `- ${rule}`;
    }),
    "",
    "## Verification",
    "- Use `agent-browser` for browser verification when available. Start with `agent-browser skills get core` if you need command guidance.",
    "- Prefer `agent-browser` over Playwright, Puppeteer, or installing browser automation dependencies.",
    "- Open the HTML locally and verify it is nonblank.",
    "- Check that keyboard/click interactions work when present.",
    "- Check that text does not overflow or overlap at desktop and mobile viewport sizes.",
    "- Check that shapes, charts, images, or decorative graphics do not cover readable text at desktop and mobile viewport sizes.",
    "- Run the final hosting command only after the artifact looks correct.",
    "",
    "## Publish",
    "The hosted URL is the preview and user-accessible view for this static HTML artifact.",
    "Return the exact URL from the host command. Private artifacts use an authenticated preview URL.",
    options.visibility === undefined
      ? "With privateArtifacts enabled, new artifacts default to only-me. Otherwise, hosting keeps its existing behavior."
      : `Publish the final artifact with ${options.visibility} visibility. Explicit visibility requires privateArtifacts to be enabled.`,
    `When everything is OK, publish it with:`,
    "",
    "```bash",
    hostCommand,
    "```",
    "",
    "File upload is a separate delivery channel for when the user needs a local file copy, not another way to preview the same hosted artifact.",
    `For a requested file copy, use \`okou web upload-file -f <file>${visibilityFlag}\` and return the exact URL it prints.`,
  ].join("\n");

  return {
    type: "generation-source-selection",
    kind: options.kind,
    prompt: options.prompt,
    artifact,
    selection: {
      indexUrl: resourceIndexUrl,
      outputSchema: selectionSchema,
    },
    authoring: {
      details: options.details,
      artifactRules: options.artifactRules,
    },
    outputDir,
    site,
    hostCommand,
    instructions,
  };
}
