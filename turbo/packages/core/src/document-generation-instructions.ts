import type { DocumentTemplateItem } from "./document-template-items";

/** Shared by explicit UI selections and the CLI's built-in template path. */
export function documentTemplateInstructionLines(
  item: DocumentTemplateItem,
): readonly string[] {
  const { source } = item;
  const sourceBaseUrl = `https://raw.githubusercontent.com/${source.repo}/${source.ref}`;
  const sourceUrl = (path: string) => {
    return `${sourceBaseUrl}/${path.split("/").map(encodeURIComponent).join("/")}`;
  };
  return [
    `Selected document template: ${item.title}`,
    `- Public upstream original (fixed commit/path): ${sourceUrl(source.path)}`,
    ...(source.supportingPaths?.length
      ? [
          `- Supporting upstream files (same fixed commit): ${source.supportingPaths.map(sourceUrl).join(", ")}`,
        ]
      : []),
    `- Layout previews: ${item.previewPages.join(", ")}`,
    "- Read the complete upstream template, including its supporting files and referenced content, styles, fonts, and assets at their pinned versions. Preserve its content organization and visual design together: typography, color, columns, tables, charts, and callouts. Use the previews to check fidelity to the original.",
    "- Replace sample content, branding, and payment links with the user's facts; leave missing details as placeholders. Recalculate totals and keep dates, units, identifiers, and repeated values consistent.",
  ];
}
