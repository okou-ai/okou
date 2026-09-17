import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import chalk from "chalk";
import { Command } from "commander";
import {
  type UserMessageInputDocument,
  userMessageInputDocumentSchema,
} from "@okouai/api-contracts/contracts/chat-threads";

import {
  getChatThreadAgentId,
  sendChatEvent,
} from "../../lib/api/domains/chat";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { printChatUsageError, resolveChatThreadId } from "./shared";

// Non-authoritative plain-text views of a document that carries no text part.
// The API re-derives the agent prompt from the document itself; the web app
// sends the same file placeholder for attachment-only messages.
const ATTACHED_FILES_PROMPT = "(see attached files)";
const MESSAGE_PARTS_PROMPT = "(see message parts)";

const USER_MESSAGE_JSON_HELP = `
User message JSON (--user-message-file), one version 1 document:
  { "version": 1, "parts": [ <part>, ... ] }            at least one part

  text         { "type": "text", "text": "..." }
  chat_thread  { "type": "chat_thread", "threadId": "<uuid>",
                 "titleSnapshot": "..." }
  template     { "type": "template", "titleSnapshot": "...",
                 "template": { "type": "presentation" | "video" |
                   "illustration" | "workflow" | "website",
                   "selection": { ... } } }
  file         { "type": "file", "fileId": "...",
                 "filenameSnapshot": "...", "contentType": "..." }
  feedback     { "type": "feedback", "quote": "...",
                 "note": [ text | chat_thread | template parts ],
                 "source": { "type": "mail", "id": "...",
                   "status": "draft" | "sent", "sentId": "..." } }`;

interface SendOptions {
  readonly json?: boolean;
  readonly text?: string;
  readonly threadId?: string;
  readonly userMessageFile?: string;
}

interface ResolvedUserMessage {
  readonly userMessage: UserMessageInputDocument;
  readonly prompt: string;
  readonly hasTextContent: boolean;
}

function readMessageText(optionText: string | undefined): string {
  let text = optionText;
  if (text === undefined && !process.stdin.isTTY) {
    try {
      text = readFileSync("/dev/stdin", "utf8");
    } catch {
      // stdin is not readable (for example in a test runner); the validation
      // below prints the same usage error as an interactive invocation.
    }
  }

  const trimmed = text?.trim();
  if (!trimmed) {
    printChatUsageError(
      "Chat message text is required",
      'Pass --text "message", pipe the message on stdin, or pass --user-message-file <path>.',
    );
  }
  return trimmed;
}

function documentText(document: UserMessageInputDocument): string {
  return document.parts
    .map((part) => {
      return part.type === "text" ? part.text : "";
    })
    .join("")
    .trim();
}

function promptForDocument(document: UserMessageInputDocument): string {
  const text = documentText(document);
  if (text) {
    return text;
  }
  const hasFilePart = document.parts.some((part) => {
    return part.type === "file";
  });
  return hasFilePart ? ATTACHED_FILES_PROMPT : MESSAGE_PARTS_PROMPT;
}

function readUserMessageDocument(path: string): UserMessageInputDocument {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printChatUsageError(
      `Failed to read user message file "${path}": ${message}`,
      "Pass a readable JSON file. Run: okou chat send --help",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printChatUsageError(
      `User message file "${path}" is not valid JSON: ${message}`,
      "Run: okou chat send --help",
    );
  }

  const result = userMessageInputDocumentSchema.safeParse(parsed);
  if (!result.success) {
    printChatUsageError(
      `User message file "${path}" is not a valid UserMessageDocument`,
      result.error.issues
        .map((issue) => {
          const issuePath = issue.path.join(".");
          return `${issuePath === "" ? "(root)" : issuePath}: ${issue.message}`;
        })
        .join("\n  "),
    );
  }
  return result.data;
}

function resolveUserMessage(options: SendOptions): ResolvedUserMessage {
  if (options.userMessageFile === undefined) {
    const text = readMessageText(options.text);
    return {
      userMessage: {
        version: 1,
        parts: [{ type: "text", text }],
      },
      prompt: text,
      hasTextContent: true,
    };
  }

  if (options.text !== undefined) {
    printChatUsageError(
      "Pass either --text or --user-message-file, not both",
      "Use --text for a plain message and --user-message-file for a full document.",
    );
  }

  const userMessage = readUserMessageDocument(options.userMessageFile);
  return {
    userMessage,
    prompt: promptForDocument(userMessage),
    hasTextContent: documentText(userMessage).length > 0,
  };
}

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a web chat thread")
  .option(
    "--thread-id <id>",
    "Chat thread ID (defaults to OKOU_CHAT_THREAD_ID)",
  )
  .option("-t, --text <message>", "Message text (or read it from stdin)")
  .option(
    "--user-message-file <path>",
    "JSON file holding one full UserMessageDocument (excludes --text)",
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Send to this chat:  okou chat send --text "Continue the analysis"
  Send to a thread:   okou chat send --thread-id <thread-id> --text "Continue"
  Pipe a message:     printf "Continue" | okou chat send --thread-id <thread-id>
  Send a document:    okou chat send --user-message-file ./message.json
  Print JSON:         okou chat send --text "Continue" --json
${USER_MESSAGE_JSON_HELP}

Notes:
  - --text wraps the message in a version 1 UserMessageDocument with one text part
  - --user-message-file sends the document as written, validated before the request
  - file parts reference an uploaded web file id (okou web upload-file)
  - The API derives the agent prompt and title state from the document itself
  - Every normal message enters the thread queue first; an idle queue may dispatch it immediately
  - Sending starts or queues the target run but does not wait for completion; that run has an independent lifetime
  - Cancel a dispatched run with --run-id, or a queued message with its --event-id, using okou chat cancel
  - Authenticates via OKOU_TOKEN (requires chat-thread:read and chat-event:write capabilities)`,
  )
  .action(
    withErrorHandler(async (options: SendOptions) => {
      const threadId = resolveChatThreadId(options.threadId);
      const message = resolveUserMessage(options);
      const agentId = await getChatThreadAgentId({ threadId });
      const eventId = randomUUID();

      const result = await sendChatEvent({
        agentId,
        threadId,
        prompt: message.prompt,
        hasTextContent: message.hasTextContent,
        clientEventId: eventId,
        chatThreadSortEventId: randomUUID(),
        userMessage: message.userMessage,
      });
      const queued = result.runId === null;

      if (options.json) {
        console.log(
          JSON.stringify({
            threadId: result.threadId,
            eventId,
            runId: result.runId,
            status: result.status ?? null,
            createdAt: result.createdAt ?? null,
            messageQueued: queued,
          }),
        );
        return;
      }

      console.log(
        chalk.green(
          queued ? "✓ Chat message queued" : "✓ Chat message dispatched",
        ),
      );
      console.log(chalk.dim(`  Thread: ${result.threadId}`));
      console.log(chalk.dim(`  Event:  ${eventId}`));
      if (result.runId) {
        console.log(chalk.dim(`  Run:    ${result.runId}`));
      }
      if (result.status) {
        console.log(chalk.dim(`  Status: ${result.status}`));
      }
    }),
  );
