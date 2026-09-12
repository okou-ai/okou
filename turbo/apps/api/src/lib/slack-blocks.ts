import type {
  SlackAnyBlock,
  SlackMarkdownBlock,
} from "../signals/external/slack-block-kit";

const MARKDOWN_BLOCK_MAX_LENGTH = 12_000;

function buildMarkdownMessage(content: string): SlackAnyBlock[] {
  const truncationSuffix = "\n\n_(Message too long to view in Slack.)_";
  const truncated =
    content.length > MARKDOWN_BLOCK_MAX_LENGTH
      ? content.substring(
          0,
          MARKDOWN_BLOCK_MAX_LENGTH - truncationSuffix.length,
        ) + truncationSuffix
      : content;

  const block: SlackMarkdownBlock = {
    type: "markdown",
    text: truncated,
  };

  return [block];
}

export function buildAgentResponseMessage(
  content: string,
  footerText?: string,
): SlackAnyBlock[] {
  const blocks: SlackAnyBlock[] = [...buildMarkdownMessage(content)];

  if (footerText) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: footerText,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build a divider + context block pair for message footers.
 */
export function buildFooterBlocks(text: string): SlackAnyBlock[] {
  return [
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text,
        },
      ],
    },
  ];
}
