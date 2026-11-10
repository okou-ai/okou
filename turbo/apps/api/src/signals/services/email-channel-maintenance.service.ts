import { command } from "ccstate";
import { and, eq, isNull, lt } from "drizzle-orm";
import { uuid, string } from "zod";
import {
  emailChannelMessages,
  emailConnectionCodes,
  emailUserLinks,
} from "@okouai/db/schema/email-integration";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";

/** Resend may replace Message-ID; retain the actual provider ID for replies. */
export const recordSentEmailMessageId$ = command(
  async (
    { set },
    args: { readonly outboxId: unknown; readonly messageId: unknown },
    signal: AbortSignal,
  ) => {
    const id = uuid().safeParse(args.outboxId);
    const messageId = string()
      .max(998)
      .regex(/^<[^<>\s]+>$/u)
      .safeParse(args.messageId);
    if (!id.success || !messageId.success) {
      return;
    }
    await set(writeDb$)
      .update(emailChannelMessages)
      .set({ messageId: messageId.data })
      .where(
        and(
          eq(emailChannelMessages.id, id.data),
          eq(emailChannelMessages.providerEmailId, `outbound:${id.data}`),
        ),
      );
    signal.throwIfAborted();
  },
);

export const cleanupUnconnectedEmailMessages$ = command(
  async ({ set }, signal: AbortSignal) => {
    const cutoff = new Date(nowDate().getTime() - 30 * 24 * 60 * 60 * 1000);
    await set(writeDb$)
      .delete(emailConnectionCodes)
      .where(lt(emailConnectionCodes.expiresAt, cutoff));
    signal.throwIfAborted();
    await set(writeDb$)
      .delete(emailChannelMessages)
      .where(
        and(
          isNull(emailChannelMessages.routeId),
          lt(emailChannelMessages.createdAt, cutoff),
        ),
      );
    signal.throwIfAborted();
  },
);

/** Revoke reply capabilities while retaining canonical conversation history. */
export const deleteEmailOwnerData$ = command(
  async (
    { set },
    owner:
      | {
          readonly kind: "owner";
          readonly orgId: string;
          readonly userId: string;
        }
      | { readonly kind: "organization"; readonly orgId: string }
      | { readonly kind: "user"; readonly userId: string },
    signal: AbortSignal,
  ) => {
    await set(writeDb$)
      .delete(emailConnectionCodes)
      .where(
        owner.kind === "owner"
          ? and(
              eq(emailConnectionCodes.orgId, owner.orgId),
              eq(emailConnectionCodes.userId, owner.userId),
            )
          : owner.kind === "organization"
            ? eq(emailConnectionCodes.orgId, owner.orgId)
            : eq(emailConnectionCodes.userId, owner.userId),
      );
    signal.throwIfAborted();
    await set(writeDb$)
      .delete(emailUserLinks)
      .where(
        owner.kind === "owner"
          ? and(
              eq(emailUserLinks.orgId, owner.orgId),
              eq(emailUserLinks.userId, owner.userId),
            )
          : owner.kind === "organization"
            ? eq(emailUserLinks.orgId, owner.orgId)
            : eq(emailUserLinks.userId, owner.userId),
      );
    signal.throwIfAborted();
  },
);
