export const ARTIFACT_PUBLICATION_INSTRUCTION =
  "Template packages own content, visual style, and content QA; platform publishing instructions own artifact covers and delivery. READY_TO_PUBLISH means content QA has passed, not that delivery is complete. Template limits on extra screenshots apply to repeated layout QA and visual review, not the cover capture and inspection required for publication.";

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
    `- ${ARTIFACT_PUBLICATION_INSTRUCTION}`,
    "- Artifact previews are enabled. Apply this cover workflow whenever publishing or redeploying HTML, including Custom templates and follow-up edits without an attached template. A file-only deliverable does not require HTML hosting or a hosted cover.",
    `- After content QA passes, finalize the directory to publish, then run \`okou host screenshot ${outputDir} --out ${previewPath}${options.spaFallback ? " --spa" : ""}\`. Keep the PNG and its bundle receipt outside that directory; the capture uploads nothing.`,
    "- Open and inspect the cover once. Fix blank, loading, clipped, or incomplete content and re-capture after any bundle edits. Repeated QA screenshots, contact sheets, and a website's og:image do not replace the publication cover.",
    "- For asynchronous charts, set window.__OKOU_PREVIEW_READY__ to false until their first complete frame, then true (or expose a promise). Capture waits for visible images and fonts. A user-selected local PNG/JPEG may replace capture; covers must be at most 5 MiB and 16 megapixels.",
    `- Publish that same final directory with \`--preview ${previewPath} --json\`, retaining its artifact kind, site, SPA, and visibility options. Confirm a nonempty previewImageUrl in the result before returning the exact artifact URL; preserve the user's chosen visibility.`,
    "- Do not omit --preview to bypass a capture failure or request a server screenshot. Repair the failure or report the blocker. If a publication already succeeded without a confirmed cover, report that status instead of claiming the cover is complete or blindly publishing again.",
  ];
}
