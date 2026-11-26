import { escapeText } from "entities/escape";
import type { SlackKnownBlock } from "../signals/external/slack-block-kit";

export interface ArtifactLinkPreview {
  readonly title: string;
  readonly imageUrl: string | null;
  readonly description?: string;
}

export function slackArtifactPreviewBlocks(
  url: string,
  metadata: ArtifactLinkPreview,
): SlackKnownBlock[] {
  const title = metadata.title.trim().slice(0, 150) || "Okou artifact";
  const escaped = (text: string) => {
    return escapeText(text).replaceAll("&nbsp;", "\u00a0");
  };
  const href = escaped(url.replaceAll("|", "%7C"));
  return [
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${href}|${escaped(title)}>*`,
        verbatim: true,
      },
    },
    ...(metadata.description
      ? [
          {
            type: "section" as const,
            text: {
              type: "plain_text" as const,
              text: metadata.description,
              emoji: false,
            },
          },
        ]
      : []),
    ...(metadata.imageUrl && metadata.imageUrl.length <= 3000
      ? [
          {
            type: "image" as const,
            image_url: metadata.imageUrl,
            alt_text: title,
          },
        ]
      : []),
  ];
}
