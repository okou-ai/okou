import { artifactPreviewInstructions } from "./artifact-preview-instructions";

export const PRESENTATION_IMAGE_BATCH_INSTRUCTION =
  "- Image workflow: use supplied images first; when generated images are needed, write one outside-output TSV row per image (`asset-id<TAB>raw prompt[<TAB>size]`, with optional size chosen per image; omitted size uses the image model default), then `okou generate image-batch start <manifest.tsv> <state-dir>` once → author the deck while it runs → `okou generate image-batch wait <state-dir>` once before verification → read each returned `asset-id<TAB>URL-or-relative-path` from `<state-dir>/results.tsv`; private images are optimized WebP files under `<state-dir>/assets/` (ffmpeg required), so copy them into the output bundle and use relative paths with the original dimensions; never embed authenticated API URLs or expiring signatures; public URL results remain embeddable; with no manifest skip this workflow, keep its state outside the hosted output, let the command own generation settings/concurrency/retry, and never call `okou generate image` directly.";

export const PRESENTATION_STATIC_HTML_INSTRUCTION =
  "- Keep all slides and visible content in index.html; render the first slide without JavaScript, which may only enhance controls, themes, or animation.";

export const PRESENTATION_DELIVERY_INSTRUCTION =
  "- Presentation delivery: first author the deck as HTML and complete its content and layout checks. The agent must choose a suitable delivery format from the current request, relevant remembered preferences, and intended use. Honor an explicit current request over remembered preferences. When neither specifies a format, infer it from the task: PPTX for editing in PowerPoint or handing off editable slides; hosted HTML for browser viewing, link sharing, or interaction. `PPT`, `slides`, and `deck` alone name the artifact, not a format. Calling `okou generate presentation` or selecting a template does not imply PPTX delivery. Deliver one format unless the user requests multiple formats.";

export function presentationDeliveryInstructions(
  options: {
    readonly hostCommand?: string;
    readonly artifactPreviewsEnabled?: boolean;
  } = {},
): readonly string[] {
  const hostCommand =
    options.hostCommand ??
    `okou host <output-dir> --site <slug> --artifact-kind presentation-html${options.artifactPreviewsEnabled ? " --preview ./generated/previews/cover.png --json" : ""}`;
  return [
    PRESENTATION_DELIVERY_INSTRUCTION,
    "- Only when the agent selects PPTX, follow the platform's conversion instructions. Keep HTML as an intermediate source; publish it only if the user also requests HTML. Skip conversion when HTML is selected.",
    "- The following preview and hosting steps apply only to HTML delivery.",
    ...(options.artifactPreviewsEnabled ? artifactPreviewInstructions() : []),
    `- For HTML delivery, host the finished deck: ${hostCommand}`,
    "- Return the exact URL printed by the selected delivery command.",
  ];
}
