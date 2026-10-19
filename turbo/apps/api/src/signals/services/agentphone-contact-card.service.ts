import { agentphoneContactCardDeliveries } from "@okouai/db/schema/agentphone-contact-card-delivery";
import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { command } from "ccstate";
import { and, eq, gte, sql } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import {
  canSendAgentPhoneConversationMedia,
  getAgentPhoneMessagesAfter,
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import { db$, writeDb$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import type { AgentPhoneDeliveryTarget } from "./agentphone-chat-callback-payload";

const L = logger("api:agentphone:contact-card");
const CONTACT_CARD_URL =
  "https://static.vm0.io/agentphone-contact/a0a9471cbcf783bd04620f1be71dd8efaf0f49c6a23eb77e3cb4584e731fd685/okou.vcf";
const CONTACT_CARD_TEXT =
  "Save Okou to your contacts so you can find this chat anytime.";

function failedContactCardStatus(
  error: unknown,
): "pending" | "failed" | "unknown" {
  if (!isAgentPhoneApiError(error)) {
    return "unknown";
  }
  if (
    error.status === 422 &&
    error.code === "CONVERSATION_CONTENT_RESTRICTED"
  ) {
    return "pending";
  }
  return error.status >= 400 && error.status < 500 ? "failed" : "unknown";
}

export const prepareAgentPhoneContactCard$ = command(
  async ({ set }, userLinkId: string, signal: AbortSignal): Promise<void> => {
    await set(writeDb$)
      .insert(agentphoneContactCardDeliveries)
      .values({ userLinkId, createdAt: nowDate() })
      .onConflictDoNothing({
        target: agentphoneContactCardDeliveries.userLinkId,
      });
    signal.throwIfAborted();
  },
);

const reconcileAgentPhoneContactCard$ = command(
  async (
    { set },
    delivery: typeof agentphoneContactCardDeliveries.$inferSelect,
    target: AgentPhoneDeliveryTarget,
    signal: AbortSignal,
  ): Promise<void> => {
    if (
      !delivery.conversationId ||
      !delivery.attemptedAt ||
      !delivery.attemptMessageId
    ) {
      throw new Error("AgentPhone contact card attempt identity is missing");
    }
    const history = await getAgentPhoneMessagesAfter(
      delivery.conversationId,
      delivery.attemptedAt,
      signal,
    );
    if (!history) {
      return;
    }
    const attemptedAt = delivery.attemptedAt;
    const accepted = history.data.find((message) => {
      return (
        message.direction === "outbound" &&
        message.fromNumber === target.toNumber &&
        message.toNumber === target.phoneHandle &&
        message.body === CONTACT_CARD_TEXT &&
        (message.mediaUrl === CONTACT_CARD_URL ||
          message.mediaUrls.includes(CONTACT_CARD_URL)) &&
        (message.status === "sent" ||
          message.status === "delivered" ||
          message.status === "read") &&
        new Date(message.receivedAt) >= attemptedAt
      );
    });
    if (accepted) {
      await set(writeDb$)
        .update(agentphoneContactCardDeliveries)
        .set({ status: "sent", providerMessageId: accepted.id })
        .where(
          and(
            eq(agentphoneContactCardDeliveries.userLinkId, delivery.userLinkId),
            eq(agentphoneContactCardDeliveries.status, "unknown"),
            eq(
              agentphoneContactCardDeliveries.attemptMessageId,
              delivery.attemptMessageId,
            ),
          ),
        );
      signal.throwIfAborted();
    }
    // Absence from a bounded history page is not proof that a send failed.
    // This also covers an in-flight sender and a crash after provider acceptance.
  },
);

export const sendPendingAgentPhoneContactCard$ = command(
  async (
    { get, set },
    target: AgentPhoneDeliveryTarget,
    signal: AbortSignal,
  ): Promise<void> => {
    if (target.isGroup || !target.conversationId) {
      return;
    }

    const [candidate] = await get(db$)
      .select({
        delivery: agentphoneContactCardDeliveries,
        body: agentphoneMessages.body,
      })
      .from(agentphoneContactCardDeliveries)
      .innerJoin(
        agentphoneUserLinks,
        eq(agentphoneUserLinks.id, agentphoneContactCardDeliveries.userLinkId),
      )
      .innerJoin(
        agentphoneMessages,
        and(
          eq(agentphoneMessages.agentphoneUserLinkId, agentphoneUserLinks.id),
          eq(agentphoneMessages.agentphoneMessageId, target.messageId),
          eq(agentphoneMessages.agentphoneAgentId, target.agentphoneAgentId),
          eq(agentphoneMessages.direction, "inbound"),
          gte(
            agentphoneMessages.createdAt,
            agentphoneContactCardDeliveries.createdAt,
          ),
        ),
      )
      .where(
        and(
          eq(agentphoneContactCardDeliveries.userLinkId, target.userLinkId),
          eq(agentphoneUserLinks.phoneHandle, target.phoneHandle),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    const body = candidate?.body?.trim();
    if (!candidate || !body || /^\d{8}$/u.test(body) || body.startsWith("/")) {
      return;
    }
    const { delivery } = candidate;
    if (delivery.status === "sent" || delivery.status === "failed") {
      return;
    }

    if (delivery.status === "unknown") {
      return set(reconcileAgentPhoneContactCard$, delivery, target, signal);
    }

    if (delivery.attemptMessageId === target.messageId) {
      return;
    }
    if (
      !(await canSendAgentPhoneConversationMedia(target.conversationId, signal))
    ) {
      return;
    }
    signal.throwIfAborted();

    // Record uncertainty before starting the external effect. Only this atomic
    // transition may send; another callback can reconcile but never replay it.
    const [attempt] = await set(writeDb$)
      .update(agentphoneContactCardDeliveries)
      .set({
        status: "unknown",
        conversationId: target.conversationId,
        attemptMessageId: target.messageId,
        attemptedAt: nowDate(),
      })
      .where(
        and(
          eq(agentphoneContactCardDeliveries.userLinkId, target.userLinkId),
          eq(agentphoneContactCardDeliveries.status, "pending"),
          sql`${agentphoneContactCardDeliveries.attemptMessageId} IS DISTINCT FROM ${target.messageId}`,
        ),
      )
      .returning({ userLinkId: agentphoneContactCardDeliveries.userLinkId });
    signal.throwIfAborted();
    if (!attempt) {
      return;
    }

    const sent = await settleIncludingAbort(
      sendAgentPhoneMessage(
        {
          agentphoneAgentId: target.agentphoneAgentId,
          toNumber: target.phoneHandle,
          body: CONTACT_CARD_TEXT,
          mediaUrls: [CONTACT_CARD_URL],
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    const status = sent.ok ? "sent" : failedContactCardStatus(sent.error);

    await set(writeDb$)
      .update(agentphoneContactCardDeliveries)
      .set({ status, providerMessageId: sent.ok ? sent.value.id : null })
      .where(
        and(
          eq(agentphoneContactCardDeliveries.userLinkId, target.userLinkId),
          eq(agentphoneContactCardDeliveries.status, "unknown"),
          eq(
            agentphoneContactCardDeliveries.attemptMessageId,
            target.messageId,
          ),
        ),
      );
    signal.throwIfAborted();
    if (!sent.ok && status !== "pending") {
      L.warn("AgentPhone contact card send did not complete", {
        outcome: status,
        error: sent.error,
      });
    }
  },
);
