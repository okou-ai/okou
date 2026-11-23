import { artifactPreviewInstructions } from "./artifact-preview-instructions";
import type { PresentationOutputFormat } from "./presentation-output-format";

const PRESENTATION_IMAGE_BATCH_INSTRUCTION =
  "- Image workflow: use supplied images first; when generated images are needed, write one outside-output TSV row per image (`asset-id<TAB>raw prompt[<TAB>size]`, with optional size chosen per image; omitted size uses the image model default), then `okou generate image-batch start <manifest.tsv> <state-dir>` once → author the deck while it runs → `okou generate image-batch wait <state-dir>` once before verification → read each returned `asset-id<TAB>URL-or-relative-path` from `<state-dir>/results.tsv`; private images are optimized WebP files under `<state-dir>/assets/` (ffmpeg required), so copy them into the output bundle and use relative paths with the original dimensions; never embed authenticated API URLs or expiring signatures; public URL results remain embeddable; with no manifest skip this workflow, keep its state outside the hosted output, let the command own generation settings/concurrency/retry, and never call `okou generate image` directly.";

export const PRESENTATION_STATIC_HTML_INSTRUCTION =
  "- Only when the resolved output format is HTML: Keep all slides and visible content in index.html; render the first slide without JavaScript, which may only enhance controls, themes, or animation.";

export const PRESENTATION_DELIVERY_INSTRUCTION =
  "- Presentation delivery: for presentation generation, use an explicit format in the current request first, then the saved default in the CURRENT message's `# Presentation Output Preference` (`- Output format: HTML format` or `- Output format: PPTX format`), then HTML. The preference alone does not request a presentation or change other output types. Do not infer a format from earlier messages, Memory, or intended use, and do not query or update preferences. Resolve the format before following an attached package; an attached native PPTX package does not override an explicit HTML request. For a new PPTX deck, follow the matching native PPTX package's authoring and verification workflow; when no template is selected, choose one with `okou generate presentation --format pptx --prompt \"<user request>\"`. Do not author HTML first or convert it. For HTML output, author and check HTML. If an imported template only supports HTML and the resolved format is PPTX, explain the incompatibility and stop; do not substitute a template or convert it. Only an explicit current request to convert an existing HTML deck uses the enabled conversion workflow instead of new-deck generation. Deliver one format unless the user requests multiple formats.";

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
    "- Follow the HTML authoring, preview, and hosting steps below only when the resolved output format is HTML. For a new PPTX deck, follow the matching native PPTX workflow instead.",
    ...artifactPreviewInstructions(),
    `- For HTML delivery, host the finished deck: ${hostCommand}`,
    "- Return the exact URL printed by the selected delivery command.",
  ];
}
