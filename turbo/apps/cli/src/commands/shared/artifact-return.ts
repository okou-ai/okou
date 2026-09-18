import { getOkouCurrentIntegration } from "../../lib/okou-env";
import type { ArtifactVisibility } from "./artifact-visibility";

export const ARTIFACT_PRESENTATION_CONTEXT =
  "inlineMarkdownLink remains a link in normal prose. previewMarkdownBlock displays a standalone preview when placed in its own Markdown paragraph, with a blank line before and after it, outside code fences. Both forms reference the same artifact; including both creates two user-facing references.";

const INTEGRATION_NAMES = new Map([
  ["web", "Web"],
  ["slack", "Slack"],
  ["feishu", "Feishu"],
  ["lark", "Lark"],
  ["teams", "Microsoft Teams"],
  ["telegram", "Telegram"],
  ["github", "GitHub"],
  ["phone", "AgentPhone"],
]);

function privateFileDeliveryContext(
  file:
    | {
        readonly privateArtifacts?: boolean;
        readonly visibility?: ArtifactVisibility;
      }
    | undefined,
): string | undefined {
  if (!file?.privateArtifacts || (file.visibility ?? "only-me") === "public") {
    return undefined;
  }
  const audience = file.visibility === "org" ? "organization-only" : "only-me";
  const notice = `This is a private artifact link (${audience}) and requires Okou authentication.`;
  const integration = getOkouCurrentIntegration();
  const name = integration ? INTEGRATION_NAMES.get(integration) : undefined;
  if (!name) return notice;

  return `${notice} To display this file in the current ${name} conversation, use the existing local file or download it with \`okou artifact download\`, then upload it with \`okou ${integration} upload-file\`. Run \`okou ${integration} upload-file -h\` for supported file types, size limits, and destination options, and follow the upload result's presentation instructions. If upload is unsupported, return the original link. Keep the artifact's visibility unchanged. Do not upload a file already delivered to this conversation.`;
}

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
  generatedFile?: {
    readonly privateArtifacts?: boolean;
    readonly visibility?: ArtifactVisibility;
  },
) {
  const escapedLabel = escapeMarkdownLabel(label);
  const deliveryContext = privateFileDeliveryContext(generatedFile);
  const json = {
    inlineMarkdownLink: `[${escapedLabel}](<${url}>)`,
    previewMarkdownBlock: `![${escapedLabel}](<${url}>)`,
    artifactPresentationContext: [
      deliveryContext,
      usageContext,
      ARTIFACT_PRESENTATION_CONTEXT,
    ]
      .filter(Boolean)
      .join(" "),
  };
  const text = [
    ...(deliveryContext ? [deliveryContext, ""] : []),
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
