import { artifactPreviewInstructions } from "./artifact-preview-instructions";
import type { PresentationOutputFormat } from "./presentation-output-format";

const PRESENTATION_IMAGE_BATCH_INSTRUCTION =
  "- Image workflow: use supplied images first; when generated images are needed, write one outside-output TSV row per image (`asset-id<TAB>raw prompt[<TAB>size]`, with optional size chosen per image; omitted size uses the image model default), then `okou generate image-batch start <manifest.tsv> <state-dir>` once → author the deck while it runs → `okou generate image-batch wait <state-dir>` once before verification → read each returned `asset-id<TAB>URL-or-relative-path` from `<state-dir>/results.tsv`; private images are optimized WebP files under `<state-dir>/assets/` (ffmpeg required), so copy them into the output bundle and use relative paths with the original dimensions; never embed authenticated API URLs or expiring signatures; public URL results remain embeddable; with no manifest skip this workflow, keep its state outside the hosted output, let the command own generation settings/concurrency/retry, and never call `okou generate image` directly.";

export const PRESENTATION_STATIC_HTML_INSTRUCTION =
  "- Keep all slides and visible content in index.html; render the first slide without JavaScript, which may only enhance controls, themes, or animation.";

export const PRESENTATION_DELIVERY_INSTRUCTION =
  "- Presentation delivery: when a native PPTX template is selected, follow its native authoring and verification workflow; do not author or convert HTML first. Otherwise, first author and check the deck as HTML. Deliver HTML by default; convert to PPTX only when the user explicitly requests PowerPoint/PPTX. Do not infer a conversion request from remembered preferences or intended use. Deliver one format unless the user requests multiple formats.";

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
      "- Author an editable native PPTX directly with the selected package; do not author HTML first or convert an HTML deck.",
      "- Follow the package's PowerPoint export and verification workflow, then render and inspect its slide images before delivery.",
      "- Deliver the final .pptx with this integration's upload-file command. Do not host an HTML deck instead. Deliver one format unless the user requests multiple formats.",
      "- Return the exact URL printed by the file delivery command.",
    ];
  }
  const hostCommand =
    options.hostCommand ??
    "okou host <output-dir> --site <slug> --artifact-kind presentation-html --preview ./generated/previews/cover.png --json";
  return [
    PRESENTATION_DELIVERY_INSTRUCTION,
    "- For an explicit PowerPoint/PPTX request, follow the platform's conversion instructions. Otherwise, follow the HTML preview and hosting steps below.",
    ...artifactPreviewInstructions(),
    `- For HTML delivery, host the finished deck: ${hostCommand}`,
    "- Return the exact URL printed by the selected delivery command.",
  ];
}
