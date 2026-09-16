import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Command } from "commander";
import { z } from "zod";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getGmailToken, getOkouChatThreadId } from "../../lib/okou-env";
import { currentAgentId } from "./shared";

const GMAIL_DRAFT_UPLOAD_URL =
  "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media";
const MAX_MESSAGE_BYTES = 35 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;
const gmailDraftResultSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
});

async function readMessageFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MESSAGE_BYTES) {
      throw new Error(
        "Use a nonempty regular RFC822 file no larger than 35 MiB",
      );
    }
    // One extra byte detects growth without an unbounded read of a changing file.
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset !== stat.size) {
      throw new Error(
        "The message file changed while reading; keep it unchanged during upload",
      );
    }
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function uncertainDraftError(): Error {
  return new Error(
    "Gmail draft creation could not be confirmed. It may have succeeded. Inspect Gmail drafts before retrying to avoid a duplicate; no automatic retry was made.",
  );
}

async function createGmailDraft(
  message: Buffer,
  token: string,
): Promise<string> {
  const controller = new AbortController();
  let response: Response;
  try {
    // The run supplies the selected account's managed credential binding. This
    // request uses the same connector firewall as the existing Gmail draft API.
    response = await fetch(GMAIL_DRAFT_UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "message/rfc822",
      },
      body: new Uint8Array(message),
      redirect: "error",
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      ]),
    });
  } catch {
    throw uncertainDraftError();
  }
  if (!response.ok) {
    controller.abort();
    if (response.status >= 500 || response.status === 408) {
      throw uncertainDraftError();
    }
    throw new Error(
      `Gmail rejected draft creation (HTTP ${response.status}). Run okou connector check --url https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts --method POST --connector gmail for connection and permission guidance.`,
    );
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw uncertainDraftError();
  }
  const parsed = gmailDraftResultSchema.safeParse(result);
  if (!parsed.success) {
    throw uncertainDraftError();
  }
  return parsed.data.id;
}

export const draftCommand = new Command()
  .name("draft")
  .description(
    "Create a Gmail draft from an RFC822 message file for user review",
  )
  .requiredOption(
    "-f, --file <path>",
    "RFC822 .eml file, including headers and MIME attachments (max 35 MiB)",
  )
  .option("--json", "Print the Gmail draft ID and next step as JSON")
  .addHelpText(
    "after",
    `
Examples:
  okou mail draft --file message.eml
  okou mail draft --file message.eml --json

Notes:
  - Uses the Gmail account selected for this run; run okou mail list to inspect it
  - Prepare a complete RFC822 message, including From, To, Subject and MIME headers
  - Include plain-text and HTML alternatives, the sender's signature, and any attachments in the file
  - Creates a draft only; it never sends email or automatically retries a write
  - In Web chat, run okou mail link <gmail-draft-id>, return the review URL, and let the user send
  - Outside Web chat, ask the user to review and send the draft in Gmail
  - Reuse existing drafts when recovering from a blocked send; do not create duplicates`,
  )
  .action(
    withErrorHandler(async (options: { file: string; json?: boolean }) => {
      currentAgentId();
      const token = getGmailToken()?.trim();
      if (!token) {
        throw new Error(
          "Gmail is unavailable in this run. Run okou mail connect gmail, then start a new run after connecting.",
        );
      }
      const message = await readMessageFile(options.file);
      const gmailDraftId = await createGmailDraft(message, token);
      const nextStep = getOkouChatThreadId()?.trim()
        ? `Run okou mail link ${gmailDraftId}, return the review URL, and let the user review and send.`
        : "Ask the user to review and send this draft in Gmail. Web review links require a Web chat thread.";
      if (options.json) {
        console.log(JSON.stringify({ gmailDraftId, sent: false, nextStep }));
      } else {
        console.log(`Gmail draft created: ${gmailDraftId}\n${nextStep}`);
      }
    }),
  );
