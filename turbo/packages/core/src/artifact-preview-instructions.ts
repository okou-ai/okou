/** One cover workflow for generation packets and runs without a selected template. */
export function artifactPreviewInstructions(
  options: {
    readonly outputDir?: string;
    readonly previewPath?: string;
    readonly spaFallback?: boolean;
  } = {},
): readonly string[] {
  const outputDir = options.outputDir ?? "<output-dir>";
  const previewPath = options.previewPath ?? "./generated/previews/cover.png";
  return [
    "- If you choose hosted HTML delivery, follow these platform publishing steps after content QA. Template limits on QA screenshots apply only to content QA.",
    `- Before publishing or updating HTML, run \`okou host screenshot ${outputDir} --out ${previewPath}${options.spaFallback ? " --spa" : ""}\` and inspect the cover. Keep the image and receipt outside the bundle; re-capture after edits. A user-selected local PNG/JPEG may replace capture.`,
    "- Publish the same bundle with the cover's path in --preview <image> --json, preserving the site, artifact kind, SPA, and visibility. Confirm a nonempty previewImageUrl before returning the exact artifact URL.",
    "- Repair failures or report the blocker; do not omit --preview to bypass a failure. A file-only deliverable does not require HTML hosting.",
  ];
}
