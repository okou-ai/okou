import type { RegistryEntry } from "@okouai/core/resource-registry";

interface StyledImageCompilationOptions {
  readonly prompt: string;
  readonly details: readonly string[];
  readonly style: RegistryEntry;
  readonly sourceMode: "github" | "r2";
}

function formatStyleSource(
  style: RegistryEntry,
  sourceMode: StyledImageCompilationOptions["sourceMode"],
): readonly string[] {
  const source = style.source;
  if (sourceMode === "github" && source.repo && source.ref) {
    return [
      `- Repository: \`${source.repo}@${source.ref}\``,
      `- Path: \`${source.path}\``,
    ];
  }
  if (sourceMode === "r2" && source.archive) {
    return [
      `- Registry resource: \`${style.id}\``,
      `- Pull command: \`okou resource pull ${style.id} --dir ./generated/resources\``,
      `- Path after pull: \`./generated/resources/${source.path}\``,
    ];
  }
  throw new Error(
    `Image style ${style.id} does not support ${sourceMode} source resolution`,
  );
}

const outputDir = "./generated/images";
const artifactRules = [
  "Resolve the selected style source before compiling or generating.",
  "Use explicit requirements in the user prompt first, locked style requirements second, and CLI fallback values last.",
  "Keep visual style requirements in the compiled prompt; map only compatible execution settings to CLI flags (`--background` accepts only `auto`, `opaque`, or `transparent`).",
  "Generate with `--compiled-prompt`, without `--style`, and pass only required reference inputs.",
] as const;

export function createStyledImageCompilationInstructions(
  options: StyledImageCompilationOptions,
): string {
  const sourceResolutionRule =
    options.sourceMode === "r2"
      ? "Run the listed `okou resource pull` command once, then read the extracted style package before compiling."
      : "Read the selected GitHub style source before compiling.";
  return [
    `# Okou generate image prompt compile ${options.style.id}`,
    "",
    "This is an image prompt-compilation packet for the current agent.",
    "Okou is not generating this image yet. The image style has already been selected — resolve its source, compile the user prompt into a final image prompt, then generate with `--compiled-prompt`.",
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Selected Image Style",
    `- \`${options.style.id}\` — ${options.style.name}`,
    `- ${options.style.description}`,
    "",
    "## Style Source",
    ...formatStyleSource(options.style, options.sourceMode),
    "",
    "## Prompt Compiler Task",
    `- ${sourceResolutionRule}`,
    "- Read the selected style source before compiling, especially `SKILL.md`, references, examples, and templates. If unavailable, stop without generating.",
    "- Rewrite the user prompt into one final image-generation prompt that obeys the selected style.",
    "- Include style-specific composition, medium, palette, subject handling, reference usage, and must-avoid constraints in the final prompt.",
    "- Keep user intent intact; expand only the visual details needed to satisfy the style.",
    "- Return only the compiled prompt text when preparing the next command.",
    "",
    "## Artifact Output Model",
    `- Primary artifact: \`image\` under \`${outputDir}/\`.`,
    "- Output mode: `primary-image`.",
    "- Supporting metadata may live inside the same output directory when useful.",
    "",
    "## Requested Parameters",
    ...options.details.map((detail) => {
      return `- ${detail}`;
    }),
    "",
    "## Image Authoring Rules",
    ...artifactRules.map((rule) => {
      return `- ${rule}`;
    }),
    "",
    "## Next Command Template",
    "```bash",
    'okou generate image --compiled-prompt "<compiled prompt>"',
    "```",
    "",
    "## Verification",
    "- Verify the final image exists and is nonblank.",
    "- Check that the selected style's required reference anchors or source assets were used when applicable.",
    "- Report the final image URL or path and the selected registry resource ID.",
  ].join("\n");
}
