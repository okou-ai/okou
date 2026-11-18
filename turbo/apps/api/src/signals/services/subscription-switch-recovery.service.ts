import type { PersonalSubscriptionProviderType } from "./model-provider-account.service";
import { command, computed } from "ccstate";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  ne,
  notExists,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { db$ } from "../external/db";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import {
  enqueueIntegrationRecovery$,
  unchangedFailedIntegrationConversation,
  type IntegrationRecoveryInput,
} from "./integration-recovery-input.service";

const target = alias(modelProviderAccounts, "recovery_switch_target");

/** Capture only conversations still blocked on the account this switch replaces. */
export function subscriptionSwitchRecoveries(
  args: {
    readonly orgId: string;
    readonly userId: string;
  } & (
    | { readonly id: string }
    | { readonly type: PersonalSubscriptionProviderType }
  ),
) {
  return computed(async (get) => {
    const database = get(db$);
    const rows = await database
      .select({
        eventId: chatEvents.id,
        selectedModel: chatThreads.selectedModel,
        accountId: modelProviderAccounts.id,
        failureReason: agentRuns.failureReason,
      })
      .from(chatEvents)
      .innerJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .innerJoin(
        modelProviderAccounts,
        eq(modelProviderAccounts.id, agentRuns.modelProviderId),
      )
      .where(
        and(
          "id" in args
            ? exists(
                database
                  .select({ id: target.id })
                  .from(target)
                  .where(
                    and(
                      eq(target.id, args.id),
                      eq(target.orgId, args.orgId),
                      eq(target.userId, args.userId),
                      eq(
                        target.modelProviderId,
                        modelProviderAccounts.modelProviderId,
                      ),
                      eq(target.needsReconnect, false),
                      isNull(target.disconnectedAt),
                      ne(target.id, modelProviderAccounts.id),
                    ),
                  ),
              )
            : eq(modelProviderAccounts.type, args.type),
          eq(modelProviderAccounts.isActive, true),
          isNull(modelProviderAccounts.disconnectedAt),
          eq(modelProviderAccounts.userId, args.userId),
          eq(modelProviderAccounts.orgId, args.orgId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.modelProviderCredentialScope, "member"),
          eq(agentRuns.status, "failed"),
          inArray(agentRuns.triggerSource, [
            "slack",
            "discord",
            "feishu",
            "lark",
            "teams",
            "telegram",
            "wechat",
            "email",
            "agentphone",
          ]),
          inArray(agentRuns.failureReason, [
            "usage_limit",
            "invalid_api_key",
            "invalid_credentials",
            "reconnect_required",
            "account_verification_required",
          ]),
          eq(chatThreads.userId, args.userId),
          eq(agents.orgId, args.orgId),
          eq(chatThreads.archived, false),
          eq(chatThreads.selectedModel, agentRuns.selectedModel),
          eq(chatEvents.eventType, "run.failed"),
          notExists(
            database
              .select({ id: chatThreadEvents.id })
              .from(chatThreadEvents)
              .where(
                and(
                  eq(chatThreadEvents.chatThreadId, chatThreads.id),
                  eq(chatThreadEvents.kind, "model_selection_updated"),
                  gt(chatThreadEvents.createdAt, agentRuns.createdAt),
                ),
              ),
          ),
          unchangedFailedIntegrationConversation(),
        ),
      );
    return rows;
  });
}

type SubscriptionRecovery = Awaited<
  ReturnType<ReturnType<typeof subscriptionSwitchRecoveries>["read"]>
>[number];

/** A saved inactive account does not restore access; use only the committed active account. */
export const enqueueSubscriptionRecovery$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly recovery: SubscriptionRecovery;
      readonly account: ModelProviderResponse;
      readonly change: "switch" | "credentials";
    },
    signal: AbortSignal,
  ): Promise<IntegrationRecoveryInput | null> => {
    if (
      args.account.isActive !== true ||
      args.account.needsReconnect ||
      (args.recovery.accountId === args.account.id &&
        (args.change === "switch" ||
          args.recovery.failureReason === "usage_limit"))
    ) {
      return null;
    }
    return await set(
      enqueueIntegrationRecovery$,
      { orgId: args.orgId, userId: args.userId, ...args.recovery },
      signal,
    );
  },
);
