import { command } from "ccstate";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  chatEmailContext,
  emailChannelMessages,
  emailChatThreadRoutes,
  emailUserLinks,
} from "@okouai/db/schema/email-integration";
import { conflict } from "../../lib/error";
import { db$, writeDb$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { ownsVerifiedEmail } from "./email-channel.service";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { emailChannelOutboxValues } from "./email-channel-delivery.service";
import { emailTemplateSchema } from "./email-common.service";

const EMAIL_FILE_NAMESPACE = "e53641d0-d394-4fc5-858c-d5cfc557c60c";
interface EmailFileDestination {
  readonly chatThreadId: string;
  readonly userLinkId: string;
  readonly emailAddress: string;
  readonly routeId: string;
  readonly subject: string;
  readonly messageId: string;
  readonly references: readonly string[];
}

export const emailFileDestination$ = command(
  async (
    { get, set },
    args: {
      readonly runId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) => {
    const [destination] = await get(db$)
      .select({
        chatThreadId: chatEmailContext.chatThreadId,
        userLinkId: emailUserLinks.id,
        emailAddress: emailUserLinks.emailAddress,
        routeId: emailChatThreadRoutes.id,
        subject: emailChannelMessages.subject,
        messageId: emailChannelMessages.messageId,
        references: emailChannelMessages.references,
      })
      .from(agentRuns)
      .innerJoin(
        chatEvents,
        and(
          eq(chatEvents.runId, agentRuns.id),
          eq(chatEvents.contextType, "email"),
        ),
      )
      .innerJoin(
        chatEmailContext,
        and(
          eq(chatEmailContext.id, chatEvents.contextId),
          eq(chatEmailContext.chatThreadId, agentRuns.chatThreadId),
        ),
      )
      .innerJoin(
        emailChannelMessages,
        eq(emailChannelMessages.id, chatEmailContext.emailMessageId),
      )
      .innerJoin(
        emailChatThreadRoutes,
        and(
          eq(emailChatThreadRoutes.id, emailChannelMessages.routeId),
          eq(emailChatThreadRoutes.chatThreadId, agentRuns.chatThreadId),
        ),
      )
      .innerJoin(
        emailUserLinks,
        and(
          eq(emailUserLinks.id, chatEmailContext.userLinkId),
          eq(emailUserLinks.id, emailChatThreadRoutes.userLinkId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
          eq(emailUserLinks.userId, args.userId),
          eq(emailUserLinks.orgId, args.orgId),
          isNull(emailUserLinks.disconnectedAt),
        ),
      )
      .orderBy(desc(chatEvents.seqId))
      .limit(1);
    signal.throwIfAborted();
    if (!destination) {
      return null;
    }
    const user = await findClerkUser(get(clerk$), args.userId, signal);
    signal.throwIfAborted();
    if (!user || !ownsVerifiedEmail(user, destination.emailAddress)) {
      return null;
    }
    const role = await set(
      getMemberRoleAndUpdateCache$,
      args.orgId,
      args.userId,
      signal,
    );
    signal.throwIfAborted();
    return role.kind === "member" ? destination : null;
  },
);

/** The receipt and outbox publish atomically. An expired outbox is never recreated. */
export const enqueueEmailFile$ = command(
  async (
    { set },
    args: {
      readonly uploadId: string;
      readonly destination: EmailFileDestination;
      readonly file: {
        readonly filename: string;
        readonly contentType: string;
        readonly path: string;
      };
      readonly text?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const source = args.destination;
    const id = uuidv5(
      `${source.routeId}:${args.uploadId}`,
      EMAIL_FILE_NAMESPACE,
    );
    const values = emailChannelOutboxValues({
      id,
      to: source.emailAddress,
      subject: /^re:/iu.test(source.subject)
        ? source.subject
        : `Re: ${source.subject}`,
      text: args.text ?? `Attached file: ${args.file.filename}`,
      messageId: `<${id}@okou.io>`,
      inReplyTo: source.messageId,
      references: source.references,
      userLinkId: source.userLinkId,
      attachment: args.file,
    });
    const insertReceipt = db
      .insert(emailChannelMessages)
      .values({
        id,
        providerEmailId: `outbound:${id}`,
        sender: source.emailAddress,
        messageId: `<${id}@okou.io>`,
        subject: source.subject,
        text: "",
        authenticated: true,
        routeId: source.routeId,
        inReplyTo: source.messageId,
        references: [...source.references, source.messageId],
      })
      .onConflictDoNothing({ target: emailChannelMessages.id })
      .returning({ id: emailChannelMessages.id });
    const fields = [
      { column: emailOutbox.id, value: values.id },
      { column: emailOutbox.fromAddress, value: values.fromAddress },
      { column: emailOutbox.toAddresses, value: values.toAddresses },
      { column: emailOutbox.subject, value: values.subject },
      { column: emailOutbox.replyTo, value: values.replyTo },
      { column: emailOutbox.headers, value: values.headers },
      { column: emailOutbox.template, value: values.template },
    ];
    await db.execute(sql`
      WITH new_email_file_receipt AS (${insertReceipt.getSQL()})
      INSERT INTO ${emailOutbox} (${sql.join(
        fields.map(({ column }) => {
          return sql.identifier(column.name);
        }),
        sql`, `,
      )})
      SELECT ${sql.join(
        fields.map(({ column, value }) => {
          return sql.param(value, column);
        }),
        sql`, `,
      )} FROM new_email_file_receipt
    `);
    signal.throwIfAborted();
    const [outbox] = await db
      .select({
        status: emailOutbox.status,
        resendId: emailOutbox.resendId,
        error: emailOutbox.lastError,
        template: emailOutbox.template,
      })
      .from(emailOutbox)
      .where(eq(emailOutbox.id, id))
      .limit(1);
    signal.throwIfAborted();
    if (!outbox) {
      return conflict(
        "The delivery receipt has expired. Its outcome is unknown; do not resend automatically.",
      );
    }
    const template = emailTemplateSchema.parse(outbox.template);
    if (template.template !== "email-channel") {
      throw new Error("Email file receipt has an invalid template");
    }
    if (args.text !== undefined && args.text !== template.props.text) {
      return conflict(
        "This upload already has a different caption. Resume it without changing --text.",
      );
    }
    return { operationId: id, delivery: emailFileDelivery(outbox) };
  },
);

function emailFileDelivery(outbox: {
  readonly status: string;
  readonly resendId: string | null;
  readonly error: string | null;
}) {
  switch (outbox.status) {
    case "sent": {
      if (!outbox.resendId) {
        throw new Error("Accepted email is missing its provider receipt");
      }
      return { status: "accepted", providerId: outbox.resendId } as const;
    }
    case "pending":
    case "sending": {
      return { status: "pending" } as const;
    }
    case "failed": {
      if (!outbox.error) {
        throw new Error("Failed email is missing its failure reason");
      }
      return { status: "failed", message: outbox.error } as const;
    }
    default: {
      throw new Error(`Unsupported Email outbox status: ${outbox.status}`);
    }
  }
}
