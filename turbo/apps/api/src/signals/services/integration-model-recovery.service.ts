import { command, computed } from "ccstate";
import { and, eq, gt, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { object, string, uuid } from "zod";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { db$ } from "../external/db";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { webUrl } from "../../lib/web-url";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import {
  publishChatThreadDetailChangedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { memberModelRouteContext } from "./effective-model-route.service";
import { memberSubscriptionModels } from "./member-subscription-models.service";
import { catalogDisplayName, loadModelCatalog$ } from "./model-catalog.service";
import { updateChatThreadMetadata$ } from "./chat-thread-metadata-update.service";

export const MODEL_RECOVERY_ACTION = "switch_model";
export const MODEL_RECOVERY_STALE =
  "This model choice is no longer current or you do not have access. Open the conversation in Okou to change its model.";

const MODEL_FAILURES = Object.freeze([
  "provider_insufficient_credits",
  "invalid_api_key",
  "invalid_credentials",
  "terms_acceptance_required",
  "account_verification_required",
  "provider_rate_limited",
  "provider_overloaded",
  "provider_stream_timeout",
  "provider_queue_timeout",
  "provider_server_error",
  "reconnect_required",
  "codex_access_program_unavailable",
  "unsupported_model",
  "provider_model_restricted",
  "usage_limit",
]);

export const modelRecoveryStateSchema = object({
  eventId: uuid(),
  selectedModel: string().min(1).max(255),
  updatedAt: string().min(1).max(64),
});

interface ModelRecoveryIdentity {
  readonly eventId: string;
  readonly userId: string;
  readonly orgId: string;
}

/** The event is the identity of the recovery, never a client-supplied thread. */
const loadIntegrationModelRecovery$ = command(
  async ({ get, set }, args: ModelRecoveryIdentity, signal: AbortSignal) => {
    if (!uuid().safeParse(args.eventId).success) {
      return null;
    }
    const feature = await set(
      loadUserFeatureSwitchContext$,
      args.orgId,
      args.userId,
      signal,
    );
    if (!isFeatureEnabled(FeatureSwitchKey.IntegrationModelRecovery, feature)) {
      return null;
    }
    const [event] = await get(db$)
      .select({
        threadId: chatThreads.id,
        selectedModel: chatThreads.selectedModel,
        updatedAt: sql`${chatThreads.updatedAt}::text`.mapWith(pgTextDecoder),
        failureReason: chatEvents.failureReason,
        runFailureReason: agentRuns.failureReason,
        payload: chatEvents.payload,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .leftJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatThreads.userId, args.userId),
          eq(agents.orgId, args.orgId),
          inArray(chatEvents.eventType, ["run.failed", "output.error"]),
          // Title/archive changes must not hide recovery; model changes do.
          or(
            isNull(agentRuns.id),
            eq(chatThreads.selectedModel, agentRuns.selectedModel),
          ),
          notExists(
            get(db$)
              .select({ id: chatThreadEvents.id })
              .from(chatThreadEvents)
              .where(
                and(
                  eq(chatThreadEvents.chatThreadId, chatThreads.id),
                  eq(chatThreadEvents.kind, "model_selection_updated"),
                  gt(
                    chatThreadEvents.createdAt,
                    sql`coalesce(${agentRuns.createdAt}, ${chatEvents.createdAt})`,
                  ),
                ),
              ),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!event) {
      return null;
    }
    const reason = event.runFailureReason ?? event.failureReason;
    const admissionModelError =
      reason === null &&
      ([
        "NO_MODEL_PROVIDER",
        "MODEL_PROVIDER_UNAVAILABLE",
        "CODEX_AUTH_JSON_SHAPE_INVALID",
        "CODEX_FREE_PLAN_REJECTED",
      ].includes(event.payload?.error ?? "") ||
        /(?:personal subscription|selected subscription account is unavailable|model.*(?:unavailable|not available|no longer available|replaced|retired)|reconnect (?:Claude|ChatGPT|Codex))/iu.test(
          event.payload?.content ?? "",
        ));
    if (
      !(reason !== null && MODEL_FAILURES.includes(reason)) &&
      !admissionModelError
    ) {
      return null;
    }
    const membership = await set(
      getMemberRoleAndUpdateCache$,
      args.orgId,
      args.userId,
      signal,
    );
    if (membership.kind !== "member") {
      return null;
    }
    return {
      ...args,
      threadId: event.threadId,
      selectedModel: event.selectedModel,
      updatedAt: event.updatedAt,
      url: `${webUrl()}/chats/${event.threadId}`,
    };
  },
);

/** An optional recovery control must never prevent delivery of the original error. */
export const integrationModelRecoveryForDelivery$ = command(
  async (
    { set },
    args: ModelRecoveryIdentity & { readonly error: string | null },
    signal: AbortSignal,
  ) => {
    if (!args.error) {
      return null;
    }
    const result = await settle(
      set(loadIntegrationModelRecovery$, args, signal),
      signal,
    );
    if (!result.ok) {
      logger("IntegrationModelRecovery").warn(
        "Could not prepare optional model recovery control",
        { eventId: args.eventId, error: result.error },
      );
      return null;
    }
    return result.value;
  },
);

export const loadIntegrationModelChoices$ = command(
  async ({ get, set }, args: ModelRecoveryIdentity, signal: AbortSignal) => {
    const recovery = await set(loadIntegrationModelRecovery$, args, signal);
    if (!recovery) {
      return null;
    }
    const identity$ = computed(() => {
      return {
        orgId: args.orgId,
        userId: args.userId,
      };
    });
    const [subscriptions, catalog] = await Promise.all([
      get(memberSubscriptionModels(memberModelRouteContext(identity$))),
      set(loadModelCatalog$, signal),
    ]);
    signal.throwIfAborted();
    return {
      ...recovery,
      currentModelLabel: catalogDisplayName(catalog, recovery.selectedModel),
      choices: [
        {
          value: AUTO_SELECTED_MODEL,
          label: "Auto",
          description: "Uses workspace credits",
        },
        ...subscriptions
          .filter((model) => {
            return !model.needsReconnect;
          })
          .map((model) => {
            return {
              value: model.model,
              label: model.displayName,
              description:
                model.providerType === "codex-oauth-token"
                  ? "Your ChatGPT subscription"
                  : "Your Claude subscription",
            };
          }),
      ],
    };
  },
);

/** Shares Web's validated write and event publication; never launches a Run. */
export const saveIntegrationModelChoice$ = command(
  async (
    { set },
    args: ModelRecoveryIdentity & {
      readonly model: string;
      readonly expectedModelState: {
        readonly selectedModel: string;
        readonly updatedAt: string;
      };
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const recovery = await set(loadIntegrationModelChoices$, args, signal);
    if (
      !recovery ||
      recovery.selectedModel !== args.expectedModelState.selectedModel ||
      recovery.updatedAt !== args.expectedModelState.updatedAt
    ) {
      return MODEL_RECOVERY_STALE;
    }
    const model = recovery.choices.find((choice) => {
      return choice.value === args.model;
    });
    if (!model) {
      return "This model is no longer available. Open the model selector again.";
    }
    const result = await set(
      updateChatThreadMetadata$,
      {
        principal: { orgId: args.orgId, userId: args.userId },
        threadId: recovery.threadId,
        patch: { model: args.model },
        codexServiceTier: { kind: "set", value: null },
        emitServiceTierEvent: true,
        expectedModelState: args.expectedModelState,
      },
      signal,
    );
    if (result.kind === "response") {
      return "The model could not be selected. Open the model selector again.";
    }
    if (result.kind !== "ok") {
      return MODEL_RECOVERY_STALE;
    }
    await publishChatThreadDetailChangedSafely(args.userId, recovery.threadId);
    signal.throwIfAborted();
    await publishThreadListChangedSafely({
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();
    return `Switched to ${model.label}. Send your previous request again to continue.`;
  },
);
