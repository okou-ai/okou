import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  emailChannelMessages,
  emailChatThreadRoutes,
  emailUserLinks,
} from "@okouai/db/schema/email-integration";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import {
  emailChatCallbackPayloadSchema,
  type EmailDeliveryTarget,
} from "./email-chat-callback-payload";
import { enqueueEmailText$ } from "./email-channel-delivery.service";
import {
  canonicalChatEventContent,
  canonicalChatEventError,
} from "./canonical-chat-event-read.service";
import { formatIntegrationChatMessage$ } from "./integration-run-errors.service";

const OUTPUT_NAMESPACE = "8dc52243-b606-4bd3-b633-5aa9c0c6c5db";

export const deliverEmailChatAdmissionFailure$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly chatThreadId: string;
      readonly target: EmailDeliveryTarget;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [source] = await db
      .select({
        sender: emailChannelMessages.sender,
        messageId: emailChannelMessages.messageId,
        subject: emailChannelMessages.subject,
        references: emailChannelMessages.references,
        routeId: emailChatThreadRoutes.id,
        content: canonicalChatEventContent(),
        error: canonicalChatEventError(),
      })
      .from(emailChannelMessages)
      .innerJoin(
        emailChatThreadRoutes,
        and(
          eq(emailChatThreadRoutes.id, emailChannelMessages.routeId),
          eq(emailChatThreadRoutes.chatThreadId, args.chatThreadId),
        ),
      )
      .innerJoin(
        emailUserLinks,
        and(
          eq(emailUserLinks.id, emailChatThreadRoutes.userLinkId),
          eq(emailUserLinks.id, args.target.userLinkId),
          eq(emailUserLinks.userId, args.userId),
          eq(emailUserLinks.orgId, args.orgId),
          isNull(emailUserLinks.disconnectedAt),
        ),
      )
      .innerJoin(
        chatEvents,
        and(
          eq(chatEvents.id, args.chatEventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
        ),
      )
      .where(eq(emailChannelMessages.id, args.target.emailMessageId))
      .limit(1);
    signal.throwIfAborted();
    if (!source?.content) {
      return;
    }
    const user = await findClerkUser(get(clerk$), args.userId, signal);
    signal.throwIfAborted();
    if (
      !user ||
      user.banned ||
      !user.emailAddresses.some((entry) => {
        return (
          entry.emailAddress.toLowerCase() === source.sender &&
          entry.verification?.status === "verified"
        );
      })
    ) {
      return;
    }
    const role = await set(
      getMemberRoleAndUpdateCache$,
      args.orgId,
      args.userId,
      signal,
    );
    signal.throwIfAborted();
    if (role.kind !== "member") {
      return;
    }
    const content = await set(
      formatIntegrationChatMessage$,
      {
        orgId: args.orgId,
        userId: args.userId,
        content: source.content,
        error: source.error,
      },
      signal,
    );
    signal.throwIfAborted();
    const id = uuidv5(
      `${args.target.emailMessageId}:${args.chatEventId}`,
      OUTPUT_NAMESPACE,
    );
    const messageId = `<${id}@okou.io>`;
    // Persist the outbound reference before delivery, so a very fast reply routes
    // to its original chat, not a new conversation or another sender's thread.
    await db
      .insert(emailChannelMessages)
      .values({
        id,
        providerEmailId: `outbound:${id}`,
        sender: source.sender,
        messageId,
        subject: source.subject,
        text: "",
        authenticated: true,
        routeId: source.routeId,
        inReplyTo: source.messageId,
        references: [...source.references, source.messageId],
      })
      .onConflictDoNothing({ target: emailChannelMessages.id });
    signal.throwIfAborted();
    await set(
      enqueueEmailText$,
      {
        id,
        to: source.sender,
        subject: /^re:/iu.test(source.subject)
          ? source.subject
          : `Re: ${source.subject}`,
        text: content,
        messageId,
        inReplyTo: source.messageId,
        references: source.references,
        userLinkId: args.target.userLinkId,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

/** Replays enqueue the same outbox identity and immutable provider request. */
export const dispatchEmailChatDeliveryOnce$ = command(
  async (
    { set },
    callbackId: string,
    _status: "completed" | "failed",
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [callback] = await db
      .select({
        payload: agentRunCallbacks.payload,
        runId: agentRunCallbacks.runId,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        chatThreadId: agentRuns.chatThreadId,
      })
      .from(agentRunCallbacks)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
      .where(
        and(
          eq(agentRunCallbacks.id, callbackId),
          eq(agentRunCallbacks.internalKind, "email:chat"),
          eq(agentRunCallbacks.status, "pending"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!callback?.chatThreadId) {
      return;
    }
    const payload = emailChatCallbackPayloadSchema.parse(callback.payload);
    await set(
      deliverEmailChatAdmissionFailure$,
      {
        userId: callback.userId,
        orgId: callback.orgId,
        chatThreadId: callback.chatThreadId,
        target: payload,
        chatEventId: payload.chatEventId,
      },
      signal,
    );
    signal.throwIfAborted();
    await db
      .update(agentRunCallbacks)
      .set({ status: "delivered", deliveredAt: nowDate() })
      .where(
        and(
          eq(agentRunCallbacks.id, callbackId),
          eq(agentRunCallbacks.status, "pending"),
        ),
      );
    signal.throwIfAborted();
  },
);
