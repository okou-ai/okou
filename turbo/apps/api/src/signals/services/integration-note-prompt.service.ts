import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";

/**
 * Surface-specific messaging and file-delivery rules. They belong next to
 * `# Current Integration` rather than in `# Agent Tools`: they only make sense
 * for the surface the run was triggered from, and they are about how the final
 * reply reaches the user, not about which commands exist.
 */
const INTEGRATION_NOTE_HEADING = "# Integration Note";

interface IntegrationNotePromptInputs {
  readonly triggerSource: TriggerSource;
  readonly privateArtifactsEnabled: boolean;
  readonly larkEnabled: boolean;
}

/**
 * A private artifact address is owner-scoped and is not resolved by the chat
 * surface, so linking one alone does not deliver the artifact there. Uploading
 * gives the external surface a displayable copy — except for a site or page,
 * which has no single renderable file — while retaining the private address
 * lets the owner open the artifact after returning to the web app.
 */
function privateArtifactFinalReplyLine(args: {
  readonly surface: string;
  readonly uploadCommand: string;
}): string {
  return `- Private artifacts in the final reply: weigh this only while composing the final reply, never during the run. This upload guidance applies to replies in ${args.surface}. If the user continues the conversation in Web chat, deliver files there and do not continue uploading to ${args.surface} unless the user explicitly requests it. A private \`/artifacts/...\` address is not openable from ${args.surface}, so a link alone shows the user nothing. When you judge that ${args.surface} can display that kind of file — a hosted website or HTML page never qualifies — upload it with \`${args.uploadCommand}\` so the user has something they can open there. If you upload it, also keep the original private \`/artifacts/...\` address from before the upload in the final reply, not the address returned by \`${args.uploadCommand}\`, so the owner can open the original artifact after returning to the web app.`;
}

function integrationNoteLines(
  args: IntegrationNotePromptInputs,
): readonly string[] {
  switch (args.triggerSource) {
    case "web":
    case "agent": {
      return [
        "- Web chat files: use `okou web download-file -h` when a web chat message includes a `[Web file]` block. `okou web upload-file -h` can share a local file back to the web chat user when file delivery is needed.",
        `- Cross-integration messages from web chat: if the user explicitly asks you to send or post through another integration, use the integration CLI and ask for the destination when it is missing. Feishu: \`okou feishu message send --help\` for chats, DMs, and replies.${args.larkEnabled ? " Lark: `okou lark message send --help` for chats, DMs, and replies." : ""} Microsoft Teams: \`okou teams message send --help\` for conversations and thread replies. Telegram: \`okou telegram bot list\` to choose the bot, then \`okou telegram message send --help\` for chats, replies, and forum topics. Phone/SMS: \`okou phone message --help\`. GitHub does not currently have a dedicated Okou message-send command, so do not invent \`okou github message\` commands.`,
        "- Email from web chat: use the Gmail skill and `GMAIL_TOKEN` to create the draft directly in Gmail. Before composing, list `GET /gmail/v1/users/me/settings/sendAs`; select the entry matching the message's From address, or the `isDefault` entry when no From address is specified. Include a `multipart/alternative` body with plain-text and HTML versions. Keep each plain-text paragraph on one logical line, never hard-wrap prose to a fixed column width, and use HTML paragraph elements so Gmail wraps the message naturally. If the selected entry has a non-empty HTML `signature`, append that signature exactly once to the HTML body and include a readable text equivalent in the plain-text body. For attachments, upload a valid RFC822 multipart message through Gmail's draft media-upload endpoint. Never call `messages.send` or `drafts.send`. After Gmail returns the draft ID, run `okou mail link <gmail-draft-id>` and return the link from the command to the user.",
        "- Email draft revisions: a linked draft stays editable until the user sends it. When the user asks to change the sender, add or remove attachments, or rewrite the content, update that same Gmail draft in place with `PUT /gmail/v1/users/me/drafts/<gmail-draft-id>` and reuse the existing link instead of creating a second draft. When you hand a draft over, tell the user they can ask you for those changes.",
        "- Email send handoff: after `okou mail link` returns the review URL, share it and end the turn so the user can review and send the draft. Do not add a mail callback prompt.",
        "- Email send confirmation: on the round that follows a send, confirm the send against Gmail before reporting it — read the draft's thread with `GET /gmail/v1/users/me/threads/<gmail-thread-id>` and verify the message carries the `SENT` label. Never assume the user sent the email.",
        "- Email reply tracking: after a send is confirmed, check whether a Gmail automation already tracks replies for this conversation — `okou workflow list` shows the workflows, and `okou workflow automation list <workflow>` shows one workflow's triggers. When none tracks it, tell the user you can watch for the reply and set it up with the `workflow-setup` skill as a `gmail-new-message` automation narrowed to that recipient and subject. Create it only after the user agrees.",
        "- Email reply handling: when a tracked reply arrives, summarize it for the user, and when a response is warranted prepare the follow-up as a new linked Gmail draft. Never send a reply automatically; the user always sends.",
        "- Diagrams in web chat: only Mermaid flowchart/graph syntax is supported. ```mermaid fenced flowcharts are rendered in the chat message, and the user can still open the source. Use a Mermaid block by default for flowcharts and for other diagram requests that can reasonably be represented as a flowchart. Do not emit Mermaid sequence, state, ER, class, architecture, mindmap, gantt, timeline, or other diagram types; use a flowchart representation or concise prose/table instead. Never draw box-and-arrow diagrams as ASCII art, and do not generate an image or publish an HTML page unless the user asked for that format or a flowchart cannot express the diagram.",
      ];
    }
    case "slack": {
      return [
        "- Slack messaging and files: only your final reply is delivered to the originating thread, so do not duplicate it; nothing you produce while the run is in progress reaches Slack on its own. Use Slack commands for different channels/threads or explicit extra messages. Use `okou slack download-file -h` for `[Slack file]` blocks and `okou web download-file -h` for canonical `[Web file]` blocks. `okou slack upload-file -h` can attach a local file to Slack when file delivery is needed. Never use SLACK_TOKEN directly — it's a user OAuth token.",
        ...(args.privateArtifactsEnabled
          ? [
              privateArtifactFinalReplyLine({
                surface: "Slack",
                uploadCommand: "okou slack upload-file",
              }),
            ]
          : []),
      ];
    }
    case "discord": {
      return [
        "- Discord messaging and files: only your final reply is delivered to the Discord channel or thread in the integration context, so do not duplicate it with `okou discord message send`; nothing you produce while the run is in progress reaches Discord on its own. Use Discord commands only for a different channel or thread, or for an explicit extra message or file. Files attached to the Discord message arrive as canonical `[Web file]` blocks; read them with `okou web download-file -h`. Use `okou discord download-file -h` for another Discord attachment identified by its channel, message, and attachment IDs. `okou discord upload-file -h` can attach a local file to a Discord channel or thread when file delivery is needed; use the Channel ID from the integration context to deliver into this conversation.",
        ...(args.privateArtifactsEnabled
          ? [
              privateArtifactFinalReplyLine({
                surface: "Discord",
                uploadCommand: "okou discord upload-file",
              }),
            ]
          : []),
      ];
    }
    case "feishu":
    case "lark": {
      const platform = args.triggerSource;
      const providerName = FEISHU_PLATFORMS[platform].name;
      return [
        `- ${providerName} messaging and files: use \`okou ${platform} --help\`. Only your final reply is delivered to the originating conversation, and nothing you produce while the run is in progress reaches ${providerName} on its own, so ${providerName} commands are for a different chat, DM, reply target, or explicit extra message/file. Use \`okou ${platform} message send --help\` for extra messages, \`okou ${platform} download-file -h\` for \`[${providerName} file]\` blocks, and \`okou ${platform} upload-file -h\` when file delivery is needed. The current installation, chat, message, and sender IDs are in the integration context. Specify \`--installation\` when the organization has multiple ${providerName} bots.`,
        ...(args.privateArtifactsEnabled
          ? [
              privateArtifactFinalReplyLine({
                surface: providerName,
                uploadCommand: `okou ${platform} upload-file`,
              }),
            ]
          : []),
      ];
    }
    case "teams": {
      return [
        "- Microsoft Teams messaging and files: use `okou teams --help`. Only your final reply is delivered to the originating conversation, and nothing you produce while the run is in progress reaches Teams on its own, so Teams commands are for different conversations, thread replies, or explicit extra messages/files. Use `okou teams message send -h` for extra messages, `okou teams download-file -h` for `[Teams file]` blocks, and `okou teams upload-file -h` when file delivery is needed. Do not use Slack or Telegram commands for Microsoft Teams delivery.",
        ...(args.privateArtifactsEnabled
          ? [
              privateArtifactFinalReplyLine({
                surface: "Microsoft Teams",
                uploadCommand: "okou teams upload-file",
              }),
            ]
          : []),
      ];
    }
    case "github": {
      return [
        "- GitHub issue/PR files: use `okou github --help`. Only your final reply is delivered to the originating issue or pull request, and nothing you produce while the run is in progress is posted there on its own, so GitHub commands are for explicit extra file delivery. Use `okou github download-file -h` for `[GitHub file]` blocks. `okou github upload-file -h` can share a local file back to the issue or pull request when file delivery is needed.",
        ...(args.privateArtifactsEnabled
          ? [
              privateArtifactFinalReplyLine({
                surface: "GitHub",
                uploadCommand: "okou github upload-file",
              }),
            ]
          : []),
      ];
    }
    case "telegram": {
      return [
        "- Telegram messaging and files: use `okou telegram --help`. Only your final reply is delivered to the originating chat, and nothing you produce while the run is in progress reaches Telegram on its own, so Telegram commands are for different chats, topics, reply targets, or explicit extra messages. Use `okou telegram bot list` to inspect available bots, `okou telegram download-file -h` for `[Telegram file]` blocks, and `okou telegram upload-file -h` when file delivery is needed. When sending or uploading, explicitly choose the bot with `--bot-id`; if you do not know which bot to use, ask the user before sending.",
        ...(args.privateArtifactsEnabled
          ? [
              privateArtifactFinalReplyLine({
                surface: "Telegram",
                uploadCommand: "okou telegram upload-file",
              }),
            ]
          : []),
      ];
    }
    case "agentphone": {
      return [
        "- Phone messaging and files: use `okou phone --help`. Only your final reply is delivered to the originating conversation, and nothing you produce while the run is in progress is sent on its own, so phone commands are for explicit extra messages or file delivery. Use `okou phone download-file -h` for `[Phone file]` blocks. `okou phone upload-file -h` can share a local file when the phone channel supports the requested file delivery.",
        ...(args.privateArtifactsEnabled
          ? [
              privateArtifactFinalReplyLine({
                surface: "the phone channel",
                uploadCommand: "okou phone upload-file",
              }),
            ]
          : []),
      ];
    }
    default: {
      return [];
    }
  }
}

/**
 * A run whose trigger source has no conversational surface — webhooks,
 * automations, goals — never renders `# Current Integration`, so it keeps its
 * fallback delivery guidance in `# Agent Tools` instead.
 */
export function hasIntegrationNote(triggerSource: TriggerSource): boolean {
  return (
    integrationNoteLines({
      triggerSource,
      privateArtifactsEnabled: false,
      larkEnabled: false,
    }).length > 0
  );
}

function buildIntegrationNotePrompt(args: IntegrationNotePromptInputs): string {
  const lines = integrationNoteLines(args);
  if (lines.length === 0) {
    return "";
  }
  return [INTEGRATION_NOTE_HEADING, "", ...lines].join("\n");
}

export function resolveIntegrationNotePrompt(args: {
  readonly triggerSource: TriggerSource;
  readonly featureSwitchContext: FeatureSwitchContext;
}): string {
  return buildIntegrationNotePrompt({
    triggerSource: args.triggerSource,
    privateArtifactsEnabled: isFeatureEnabled(
      FeatureSwitchKey.PrivateArtifacts,
      args.featureSwitchContext,
    ),
    larkEnabled: isFeatureEnabled(
      FeatureSwitchKey.LarkIntegration,
      args.featureSwitchContext,
    ),
  });
}
