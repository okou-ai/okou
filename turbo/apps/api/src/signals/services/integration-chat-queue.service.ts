import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatDiscordContext } from "@okouai/db/schema/chat-discord-context";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { feishuChatIngress } from "@okouai/db/schema/feishu-chat-ingress";
import { slackChatIngress } from "@okouai/db/schema/slack-chat-ingress";
import { command } from "ccstate";
import { eq, and } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { prepareChatEvent } from "./chat-event.service";
import {
  applyThreadModelReplacement,
  type ThreadModelReplacement,
} from "./chat-input-model.service";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";

type IntegrationIngressReceipt =
  | {
      readonly kind: "discord";
      readonly ingressId: string;
      readonly routeId: string;
      readonly claimToken: string;
    }
  | { readonly kind: "slack" | "feishu"; readonly ingressId: string };

type IntegrationContext = Exclude<
  NonNullable<ReturnType<typeof prepareChatEvent>["displayContext"]>,
  { readonly type: "agent_run" | "automation" }
>;

/** The provider context row the integration input references. */
async function insertIntegrationContext(
  tx: Tx,
  context: IntegrationContext,
  chatThreadId: string,
  createdAt: Date,
): Promise<void> {
  if (context.type === "discord") {
    await tx
      .insert(chatDiscordContext)
      .values({
        ...context.snapshot,
        id: context.id,
        chatThreadId,
        createdAt,
      })
      .onConflictDoNothing({ target: chatDiscordContext.id });
  } else if (context.type === "slack") {
    await tx
      .insert(chatSlackContext)
      .values({ ...context, createdAt })
      .onConflictDoNothing();
  } else if (context.type === "feishu") {
    await tx
      .insert(chatFeishuContext)
      .values({ ...context, createdAt })
      .onConflictDoNothing();
  } else if (context.type === "teams") {
    await tx
      .insert(chatTeamsContext)
      .values({ ...context, createdAt })
      .onConflictDoNothing();
  } else if (context.type === "telegram") {
    await tx
      .insert(chatTelegramContext)
      .values({ ...context, createdAt })
      .onConflictDoNothing();
  } else {
    await tx
      .insert(chatAgentphoneContext)
      .values({ ...context, createdAt })
      .onConflictDoNothing();
  }
}

/**
 * One integration input, its context, its thread's model replacement and the
 * existing ingress receipt commit together.
 */
export const enqueueIntegrationChatInput$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly input: Parameters<typeof prepareChatEvent>[0];
      readonly threadModelReplacement: ThreadModelReplacement | null;
      readonly ingress?: IntegrationIngressReceipt;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const prepared = prepareChatEvent(args.input);
    const context = prepared.displayContext;
    if (
      !context ||
      context.type === "agent_run" ||
      context.type === "automation"
    ) {
      throw new Error("Integration input requires its provider context");
    }
    const { createdAt, chatThreadId } = prepared.row;
    const currentTime = nowDate();
    return await db.transaction(async (tx) => {
      if (args.ingress?.kind === "discord") {
        const [claimed] = await tx
          .update(discordChatIngress)
          .set({
            status: "processed",
            claimToken: null,
            claimedAt: null,
            retryAt: null,
            lastErrorClass: null,
            lastError: null,
            updatedAt: currentTime,
          })
          .where(
            and(
              eq(discordChatIngress.id, args.ingress.ingressId),
              eq(discordChatIngress.status, "processing"),
              eq(discordChatIngress.claimToken, args.ingress.claimToken),
              eq(discordChatIngress.routeId, args.ingress.routeId),
            ),
          )
          .returning({ id: discordChatIngress.id });
        if (!claimed) {
          return null;
        }
      }
      await insertIntegrationContext(tx, context, chatThreadId, createdAt);
      const [event] = parseRawRows(
        chatEventAppendResultSchema,
        await tx.execute(appendCanonicalChatEventsSql([prepared.row], "id")),
      );
      if (args.ingress?.kind === "slack") {
        await tx
          .update(slackChatIngress)
          .set({
            status: "processed",
            retryAt: null,
            lastErrorClass: null,
            lastError: null,
            updatedAt: currentTime,
          })
          .where(
            and(
              eq(slackChatIngress.id, args.ingress.ingressId),
              eq(slackChatIngress.status, "processing"),
            ),
          );
      } else if (args.ingress?.kind === "feishu") {
        await tx
          .update(feishuChatIngress)
          .set({ status: "processed", lastError: null, updatedAt: currentTime })
          .where(
            and(
              eq(feishuChatIngress.id, args.ingress.ingressId),
              eq(feishuChatIngress.status, "processing"),
            ),
          );
      }
      if (event) {
        await applyThreadModelReplacement(tx, args.threadModelReplacement);
        // The queue row is locked last and only advances queuedAt; a live
        // claim lease stays with its holder (docs/chat-run-pick.md).
        const plan = queuedChatThreadEnqueuePlan({
          chatThreadId,
          orgId: args.orgId,
        });
        await tx
          .insert(queuedChatThreads)
          .values(plan.values)
          .onConflictDoUpdate(plan.conflict);
        signal.throwIfAborted();
      }
      return event?.id ?? null;
    });
  },
);
