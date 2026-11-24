import { artifactPreviewInstructions } from "./artifact-preview-instructions";
import type { PresentationOutputFormat } from "./presentation-output-format";

const PRESENTATION_IMAGE_BATCH_INSTRUCTION =
  "- Image workflow: use supplied images first; when generated images are needed, write one outside-output TSV row per image (`asset-id<TAB>raw prompt[<TAB>size]`, with optional size chosen per image; omitted size uses the image model default), then `okou generate image-batch start <manifest.tsv> <state-dir>` once → author the deck while it runs → `okou generate image-batch wait <state-dir>` once before verification → read each returned `asset-id<TAB>URL-or-relative-path` from `<state-dir>/results.tsv`; private images are optimized WebP files under `<state-dir>/assets/` (ffmpeg required), so copy them into the output bundle and use relative paths with the original dimensions; never embed authenticated API URLs or expiring signatures; public URL results remain embeddable; with no manifest skip this workflow, keep its state outside the hosted output, let the command own generation settings/concurrency/retry, and never call `okou generate image` directly.";

export const PRESENTATION_STATIC_HTML_INSTRUCTION =
  "- When authoring HTML, including an HTML-only template's source for PPTX conversion: Keep all slides and visible content in index.html; render the first slide without JavaScript, which may only enhance controls, themes, or animation.";

export const PRESENTATION_DELIVERY_INSTRUCTION =
  "- Presentation delivery: for presentation generation, use an explicit format in the current request first, then the saved default in the CURRENT message's `# Presentation Output Preference` (`- Output format: HTML format` or `- Output format: PPTX format`), then HTML. If no format is explicitly requested and the current message has no saved preference, default to HTML without asking for a format or saving this fallback as a preference. First-use format cards are client-owned and require an explicitly selected Presentation tag with a confirmed unset preference; never trigger one from inferred presentation intent. The preference alone does not request a presentation or change other output types. Do not infer a format from earlier messages, Memory, or intended use, and do not query or update preferences. Resolve the format before following an attached package; an attached native PPTX package does not override an explicit HTML request. The final deliverable must match the resolved output format; template delivery instructions do not override it. When the selected template offers both HTML and PPTX, use its matching version directly. For a new PPTX deck with a matching native PPTX version, follow that package's authoring and verification workflow; do not author HTML first or convert it when this version exists. When no template is selected, choose one for the resolved format with `okou generate presentation --format <html|pptx> --prompt \"<user request>\"`. For HTML output, author and check HTML. If the selected template supports only HTML and the resolved format is PPTX, author with that HTML template, then use the enabled built-in HTML-to-PPTX conversion workflow and deliver the converted .pptx, not the intermediate HTML. The resolved PPTX requirement is sufficient; do not require a separate request to convert. An explicit request to convert an existing HTML deck also uses the enabled conversion workflow without regenerating the deck. If conversion is unavailable or fails, report the blocker; never silently change the output format or substitute another template. Deliver one format unless the user requests multiple formats.";

export function presentationImageInstructions(
  imageGenerationEnabled: boolean,
): readonly string[] {
  return imageGenerationEnabled ? [PRESENTATION_IMAGE_BATCH_INSTRUCTION] : [];
}

export function presentationDeliveryInstructions(
  options: {
    readonly outputFormat?: PresentationOutputFormat;
    readonly hostCommand?: string;
  } = {},
): readonly string[] {
  if (options.outputFormat === "pptx") {
    return [
      PRESENTATION_DELIVERY_INSTRUCTION,
      "- Author an editable native PPTX directly with the selected package when generating a new deck with resolved PPTX output; do not author HTML first or convert an HTML deck.",
      "- Only when the resolved output format is PPTX: Follow the package's PowerPoint export and verification workflow, then render and inspect its slide images before delivery.",
      "- Only when the resolved output format is PPTX: Deliver the final .pptx with this integration's upload-file command. Do not host an HTML deck instead. Deliver one format unless the user requests multiple formats.",
      "- Only when the resolved output format is PPTX: Return the exact URL printed by the file delivery command.",
    ];
  }
  const hostCommand =
    options.hostCommand ??
    "okou host <output-dir> --site <slug> --artifact-kind presentation-html --preview ./generated/previews/cover.png --json";
  return [
    PRESENTATION_DELIVERY_INSTRUCTION,
    "- Follow the selected template's authoring workflow. Follow the HTML preview and hosting steps below only when the resolved output format is HTML. For PPTX delivery, use the matching native PPTX version when available; for an HTML-only template, convert its finished HTML with the enabled built-in workflow instead of hosting it.",
    ...artifactPreviewInstructions(),
    `- For HTML delivery, host the finished deck: ${hostCommand}`,
    "- Return the exact URL printed by the selected delivery command.",
  ];
}
