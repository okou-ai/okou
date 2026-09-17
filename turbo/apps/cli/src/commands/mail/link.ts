import { Command, Option } from "commander";

import { linkMailDraft } from "../../lib/api/domains/mail";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getOkouChatThreadId } from "../../lib/okou-env";
import {
  connectorActionCallbackAvailable,
  finalizeActionUrl,
  printCallbackTurnInstruction,
} from "../connector/action-url";
import { currentAgentId } from "./shared";

function currentChatThreadId(): string {
  const threadId = getOkouChatThreadId()?.trim();
  if (!threadId) {
    throw new Error("OKOU_CHAT_THREAD_ID is not set", {
      cause: new Error("Run this command from a web chat thread"),
    });
  }
  return threadId;
}

function mailDraftReviewUrl(args: {
  readonly mailDraftUrl: string;
  readonly agentId: string;
  readonly callbackPrompt: string | undefined;
}): string {
  const actionUrl = new URL(args.mailDraftUrl);
  if (args.callbackPrompt !== undefined) {
    actionUrl.searchParams.set("agentId", args.agentId);
  }
  return finalizeActionUrl(actionUrl, args.callbackPrompt, args.agentId);
}

const callbackPromptOption = new Option(
  "--callback-prompt <prompt>",
  "Start the next web chat round with this prompt after the user sends the email",
);
const callbackPromptAvailable = connectorActionCallbackAvailable();
if (!callbackPromptAvailable) {
  callbackPromptOption.hideHelp();
}
const callbackPromptNotes = callbackPromptAvailable
  ? "  - --callback-prompt remains available for nonstandard callers, but the standard web email handoff must omit it\n"
  : "";

export const linkCommand = new Command()
  .name("link")
  .description("Link an existing Gmail draft to the current web chat")
  .argument("<gmail-draft-id>", "Gmail draft ID")
  .addOption(callbackPromptOption)
  .addHelpText(
    "after",
    `
Examples:
  okou mail link r-test-draft

Notes:
  - Links an existing Gmail draft; it does not create, update, or send email
  - Return the exact review URL, tell the user the draft remains editable, and end the turn so the user can review and send it
  - For the standard web email handoff, do not add a mail callback prompt
${callbackPromptNotes}  - Revise the same Gmail draft in place and reuse its link instead of creating a second draft
  - Never assume the user sent it; verify the Gmail thread has the SENT label before reporting a send`,
  )
  .action(
    withErrorHandler(
      async (gmailDraftId: string, opts: { callbackPrompt?: string }) => {
        const agentId = currentAgentId();
        const threadId = currentChatThreadId();
        const result = await linkMailDraft({
          threadId,
          agentId,
          gmailDraftId,
        });
        const reviewUrl = mailDraftReviewUrl({
          mailDraftUrl: result.mailDraftUrl,
          agentId,
          callbackPrompt: opts.callbackPrompt,
        });
        console.log(
          `Return the exact review URL on its own line, separated from other text by blank lines. Example reply:\n\nYour email draft is ready to review and send.\n\n${reviewUrl}`,
        );
        if (opts.callbackPrompt !== undefined) {
          printCallbackTurnInstruction();
        }
      },
    ),
  );
