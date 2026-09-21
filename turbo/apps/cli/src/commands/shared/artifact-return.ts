export const ARTIFACT_PRESENTATION_CONTEXT =
  "inlineMarkdownLink remains a link in normal prose. previewMarkdownBlock displays a standalone preview when placed in its own Markdown paragraph, with a blank line before and after it, outside code fences. Both forms reference the same artifact; including both creates two user-facing references.";

function escapeMarkdownLabel(label: string): string {
  return label
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\\/gu, String.raw`\\`)
    .replace(/\[/gu, String.raw`\[`)
    .replace(/\]/gu, String.raw`\]`);
}

export function createArtifactPresentation(
  label: string,
  url: string,
  usageContext?: string,
) {
  const escapedLabel = escapeMarkdownLabel(label);
  const json = {
    inlineMarkdownLink: `[${escapedLabel}](<${url}>)`,
    previewMarkdownBlock: `![${escapedLabel}](<${url}>)`,
    artifactPresentationContext: [usageContext, ARTIFACT_PRESENTATION_CONTEXT]
      .filter(Boolean)
      .join(" "),
  };
  const text = [
    "Artifact presentation context:",
    "",
    "Inline Markdown link:",
    json.inlineMarkdownLink,
    "This form remains a link in normal prose.",
    "",
    "Rich preview Markdown:",
    "",
    json.previewMarkdownBlock,
    "",
    "The rich-preview form is displayed as a standalone preview when it occupies its own Markdown paragraph, with a blank line before and after it, and is outside a code fence.",
    "",
    "Both forms reference the same artifact. Including both in one response creates two user-facing references.",
    ...(usageContext ? [usageContext] : []),
  ].join("\n");
  return { json, text };
}
