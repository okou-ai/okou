import { command } from "ccstate";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { writeDb$ } from "../external/db";
import { waitUntil } from "../context/wait-until";
import { now } from "../../lib/time";
import { drainEmailOutboxBatch$ } from "./email-common.service";
const EMAIL_CHANNEL_ADDRESS = "okou@okou.io";
export interface EmailChannelMessage {
  readonly id: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly messageId: string;
  readonly inReplyTo: string;
  readonly references: readonly string[];
  readonly userLinkId?: string;
  readonly attachment?: {
    readonly filename: string;
    readonly contentType: string;
    readonly path: string;
  };
}

export function emailChannelOutboxValues(args: EmailChannelMessage) {
  return {
    id: args.id,
    fromAddress: "Okou <okou@okou.io>",
    toAddresses: args.to,
    subject: args.subject,
    replyTo: EMAIL_CHANNEL_ADDRESS,
    headers: {
      "Message-ID": args.messageId,
      "In-Reply-To": args.inReplyTo,
      References: [...args.references, args.inReplyTo].slice(-100).join(" "),
      "Auto-Submitted": "auto-replied",
      "X-Auto-Response-Suppress": "All",
    },
    template: {
      template: "email-channel",
      props: {
        text: args.text,
        ...(args.userLinkId ? { userLinkId: args.userLinkId } : {}),
        ...(args.attachment ? { attachments: [args.attachment] } : {}),
      },
    },
  };
}

export const enqueueEmailText$ = command(
  async ({ set }, args: EmailChannelMessage, signal: AbortSignal) => {
    await set(writeDb$)
      .insert(emailOutbox)
      .values(emailChannelOutboxValues(args))
      .onConflictDoNothing({ target: emailOutbox.id });
    signal.throwIfAborted();
    waitUntil(set(drainEmailOutboxBatch$, { currentTimeMs: now() }, signal));
  },
);
