import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNull,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import {
  emailChannelMessages,
  emailChatThreadRoutes,
  emailUserLinks,
} from "@okouai/db/schema/email-integration";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { emailChannelOutboxValues } from "./email-channel-delivery.service";
import type { EmailRunSource } from "./email-run-source.service";

/** Retire this exact binding and queue a fixed confirmation in one statement. */
export const changeEmailSession$ = command(
  async (
    { set },
    args: {
      readonly source: EmailRunSource;
      readonly userId: string;
      readonly orgId: string;
      readonly workspace?: { readonly id: string; readonly name: string };
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const source = args.source;
    const scope = and(
      eq(emailUserLinks.id, source.userLinkId),
      eq(emailUserLinks.userId, args.userId),
      eq(emailUserLinks.orgId, args.orgId),
      isNull(emailUserLinks.disconnectedAt),
    );
    // Keep provider/RFC deduplication receipts across binding replacement.
    // Clear their route and unprocessed content so replays cannot launch tasks.
    const receipts = db.$with("retained_email_receipts").as(
      db
        .update(emailChannelMessages)
        .set({
          routeId: null,
          text: "",
          attachmentIds: [],
          attachmentNames: [],
        })
        .where(
          inArray(
            emailChannelMessages.routeId,
            db
              .select({ id: emailChatThreadRoutes.id })
              .from(emailChatThreadRoutes)
              .innerJoin(
                emailUserLinks,
                eq(emailUserLinks.id, emailChatThreadRoutes.userLinkId),
              )
              .where(scope),
          ),
        )
        .returning({ id: emailChannelMessages.id }),
    );
    // This dependency completes receipt preservation before FK cascades run,
    // including when the binding has no routed messages.
    const retirementScope = and(
      scope,
      gte(db.select({ total: count() }).from(receipts), 0),
    );
    const retired = db
      .$with("retired_email_session")
      .as(
        args.workspace
          ? db.delete(emailUserLinks).where(retirementScope).returning()
          : db
              .update(emailUserLinks)
              .set({ disconnectedAt: nowDate() })
              .where(retirementScope)
              .returning(),
      );
    // A new identity retires the old sender routes, queued inputs and callbacks.
    // Never ignore a replacement conflict: it must roll back the retirement.
    const workspace = args.workspace;
    const replacement = workspace
      ? db.$with("replacement_email_session", { id: emailUserLinks.id }).as(sql`
          INSERT INTO ${emailUserLinks} (email_address, user_id, org_id)
          SELECT ${retired.emailAddress}, ${retired.userId}, ${workspace.id}
          FROM ${retired} RETURNING id
        `)
      : null;
    const changed: SQLWrapper = replacement ?? retired;
    const id = randomUUID();
    const values = emailChannelOutboxValues({
      id,
      to: source.emailAddress,
      subject: /^re:/iu.test(source.subject)
        ? source.subject
        : `Re: ${source.subject}`,
      text: workspace
        ? `Your email ${source.emailAddress} is now connected to workspace "${workspace.name}" (${workspace.id}). Future emails use this workspace. Existing chats stay in their original workspace.`
        : `Your email ${source.emailAddress} has been disconnected from Okou Email. Your Okou account and mailbox connectors are unchanged. Reconnect explicitly from App Works.`,
      messageId: `<${id}@okou.io>`,
      inReplyTo: source.messageId,
      references: source.references,
      // This fixed control receipt must survive revocation of the old binding.
    });
    const confirmation = db.$with("email_session_confirmation", {
      id: emailOutbox.id,
    }).as(sql`
      INSERT INTO ${emailOutbox}
        (id, from_address, to_addresses, subject, reply_to, headers, template)
      SELECT ${sql.param(values.id, emailOutbox.id)},
        ${sql.param(values.fromAddress, emailOutbox.fromAddress)},
        ${sql.param(values.toAddresses, emailOutbox.toAddresses)},
        ${sql.param(values.subject, emailOutbox.subject)},
        ${sql.param(values.replyTo, emailOutbox.replyTo)},
        ${sql.param(values.headers, emailOutbox.headers)},
        ${sql.param(values.template, emailOutbox.template)}
      FROM ${changed} RETURNING id
    `);
    const [result] = await db
      .with(
        receipts,
        retired,
        ...(replacement ? [replacement] : []),
        confirmation,
      )
      .select({ id: confirmation.id })
      .from(confirmation);
    signal.throwIfAborted();
    if (!result) {
      return false;
    }
    await publishUserSignal([args.userId], "email:changed");
    signal.throwIfAborted();
    return true;
  },
);
