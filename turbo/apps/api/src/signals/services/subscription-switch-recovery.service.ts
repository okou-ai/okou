import { isPersonalSubscriptionUsageLimitFailure } from "@okouai/api-contracts/contracts/errors";
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
  or,
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
import { waitUntil } from "../context/wait-until";
import {
  enqueueIntegrationRecovery$,
  unchangedFailedIntegrationConversation,
} from "./integration-recovery-input.service";
import { continueIntegrationRecovery$ } from "./integration-recovery-continuation.service";

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
        error: agentRuns.error,
        type: modelProviderAccounts.type,
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
          or(
            inArray(agentRuns.failureReason, [
              "usage_limit",
              "invalid_api_key",
              "invalid_credentials",
              "reconnect_required",
              "account_verification_required",
            ]),
            isNull(agentRuns.failureReason),
          ),
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
    return rows
      .filter((row) => {
        return (
          row.failureReason !== null ||
          isPersonalSubscriptionUsageLimitFailure({
            failureReason: row.failureReason,
            modelProviderType: row.type,
            message: row.error ?? "",
          })
        );
      })
      .map(({ eventId, selectedModel, accountId, failureReason }) => {
        return {
          eventId,
          selectedModel,
          accountId,
          failureReason: failureReason ?? "usage_limit",
        };
      });
  });
}

type SubscriptionRecovery = Awaited<
  ReturnType<ReturnType<typeof subscriptionSwitchRecoveries>["read"]>
>[number];

/** A saved inactive account does not restore access; use only the committed active account. */
export const resumeSubscriptionConversations$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly recoveries: readonly SubscriptionRecovery[];
      readonly account: ModelProviderResponse;
      readonly change: "switch" | "credentials";
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.account.isActive !== true || args.account.needsReconnect) {
      return;
    }
    for (const recovery of args.recoveries) {
      if (
        recovery.accountId === args.account.id &&
        (args.change === "switch" || recovery.failureReason === "usage_limit")
      ) {
        continue;
      }
      const input = await set(
        enqueueIntegrationRecovery$,
        { orgId: args.orgId, userId: args.userId, ...recovery },
        signal,
      );
      if (input) {
        waitUntil(set(continueIntegrationRecovery$, input, signal));
      }
    }
  },
);
