import { artifactPreviewInstructions } from "./artifact-preview-instructions";

const PRESENTATION_IMAGE_BATCH_INSTRUCTION =
  "- Image workflow: use supplied images first; when generated images are needed, write one outside-output TSV row per image (`asset-id<TAB>raw prompt[<TAB>size]`, with optional size chosen per image; omitted size uses the image model default), then `okou generate image-batch start <manifest.tsv> <state-dir>` once → author the deck while it runs → `okou generate image-batch wait <state-dir>` once before verification → read each returned `asset-id<TAB>URL-or-relative-path` from `<state-dir>/results.tsv`; private images are optimized WebP files under `<state-dir>/assets/` (ffmpeg required), so copy them into the output bundle and use relative paths with the original dimensions; never embed authenticated API URLs or expiring signatures; public URL results remain embeddable; with no manifest skip this workflow, keep its state outside the hosted output, let the command own generation settings/concurrency/retry, and never call `okou generate image` directly.";

export const PRESENTATION_STATIC_HTML_INSTRUCTION =
  "- Keep all slides and visible content in index.html; render the first slide without JavaScript, which may only enhance controls, themes, or animation.";

export const PRESENTATION_DELIVERY_INSTRUCTION =
  "- Presentation delivery: first author and check the deck as HTML, then choose HTML or PPTX from the user's request, remembered preferences, and intended use. Explicit requests take priority. Deliver one format unless the user requests multiple formats.";

export const IMAGE_ASSET_INSTRUCTION =
  "Image workflow: use supplied images first. When new images are needed, use an image tool exposed in the current agent context or an authorized connector. Bundle durable local copies in the output; never embed authenticated API URLs or expiring signatures.";

export function presentationImageInstructions(
  imageGenerationEnabled: boolean,
): string {
  return imageGenerationEnabled
    ? PRESENTATION_IMAGE_BATCH_INSTRUCTION
    : `- ${IMAGE_ASSET_INSTRUCTION}`;
}

export function presentationDeliveryInstructions(
  options: {
    readonly hostCommand?: string;
  } = {},
): readonly string[] {
  const hostCommand =
    options.hostCommand ??
    "okou host <output-dir> --site <slug> --artifact-kind presentation-html --preview ./generated/previews/cover.png --json";
  return [
    PRESENTATION_DELIVERY_INSTRUCTION,
    "- For PPTX, follow the platform's conversion instructions. For HTML, follow the preview and hosting steps below.",
    ...artifactPreviewInstructions(),
    `- For HTML delivery, host the finished deck: ${hostCommand}`,
    "- Return the exact URL printed by the selected delivery command.",
  ];
}
