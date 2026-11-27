import { artifactPreviewInstructions } from "./artifact-preview-instructions";
import type { PresentationOutputFormat } from "./presentation-output-format";

const PRESENTATION_IMAGE_BATCH_INSTRUCTION =
  "- Image workflow: use supplied images first; when generated images are needed, write one outside-output TSV row per image (`asset-id<TAB>raw prompt[<TAB>size]`, with optional size chosen per image; omitted size uses the image model default), then `okou generate image-batch start <manifest.tsv> <state-dir>` once → author the deck while it runs → `okou generate image-batch wait <state-dir>` once before verification → read each returned `asset-id<TAB>URL-or-relative-path` from `<state-dir>/results.tsv`; private images are optimized WebP files under `<state-dir>/assets/` (ffmpeg required), so copy them into the output bundle and use relative paths with the original dimensions; never embed authenticated API URLs or expiring signatures; public URL results remain embeddable; with no manifest skip this workflow, keep its state outside the hosted output, let the command own generation settings/concurrency/retry, and never call `okou generate image` directly.";

export const PRESENTATION_STATIC_HTML_INSTRUCTION =
  "- Keep all slides and visible content in index.html; render the first slide without JavaScript, which may only enhance controls, themes, or animation.";

const PRESENTATION_FORMAT_INSTRUCTION =
  "- New presentation format: the current message's explicit format (including its selected template format) wins, then this input's frozen presentation default, then HTML. A resolved package format is not itself an explicit user choice. A default does not request a presentation or change other artifact types. Do not query or update preferences, or infer a default from history or Memory. With no selected template, use `okou generate presentation --format <html|pptx> --prompt \"<user request>\"` for the resolved format. Use the matching format of a selected built-in style before pulling or authoring. Only after delivering a new presentation whose format was chosen by the saved default, end with one short sentence naming that default (PowerPoint or web slides) and offering the other format or Settings → Chat.";

export const PRESENTATION_DELIVERY_INSTRUCTION = [
  PRESENTATION_FORMAT_INSTRUCTION,
  "- Presentation delivery: use a selected native PPTX package's native authoring and verification workflow, not HTML conversion. Author HTML-only templates as HTML; if a new presentation's resolved output is PPTX, use conversion only when the platform supports it. Report unavailable or failed output instead of silently changing format or style. An existing HTML deck requires an explicit conversion request; a default alone does not request its conversion. Deliver one format unless the user requests multiple formats.",
].join("\n");

export function presentationPreferencePrompt(
  format: PresentationOutputFormat | null,
): string {
  const label =
    format === null
      ? "unset"
      : format === "pptx"
        ? "PPTX (PowerPoint)"
        : "HTML (web slides)";
  return `# Presentation Output Preference\nThis input's saved default: ${label}.`;
}

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
      PRESENTATION_FORMAT_INSTRUCTION,
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
    "- If the resolved new-presentation output is PPTX but the selected template is HTML-only, follow the platform's available conversion instructions. Otherwise, follow the HTML preview and hosting steps below.",
    ...artifactPreviewInstructions(),
    `- For HTML delivery, host the finished deck: ${hostCommand}`,
    "- Return the exact URL printed by the selected delivery command.",
  ];
}
