import {
  chatInputModelSelectionSchema,
  type ChatInputModelSelection,
} from "@okouai/api-contracts/contracts/chat-input-model";
import { isAutoSelectedModel } from "@okouai/core/auto-run-model";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { MODEL_FIRST_SELECTION_PROVIDER_ID } from "@okouai/api-contracts/validators/chat-threads";
import {
  modelSettingsSchema,
  type ModelSettings,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { and, eq } from "drizzle-orm";
import { badRequestMessage } from "../../lib/error";
import { command } from "ccstate";
import { db$ } from "../external/db";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import {
  autoSelectionPin,
  resolveModelSelectionPin$,
  isReplacedModelSelection,
  replacementSubscriptionRequired,
  type ModelSelectionBootstrap,
  type ModelFirstPin,
} from "./model-selection.service";
import {
  loadModelCatalog$,
  resolveCatalogRunModel,
  type ModelCatalog,
} from "./model-catalog.service";
import { isCatalogFastServiceTierSupported } from "./model-route-capabilities.service";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";

function isUnavailablePersonalCapture(
  catalog: ModelCatalog,
  selected: ModelFirstPin,
): boolean {
  return (
    selected.modelProviderCredentialScope === "member" &&
    selected.selectedModel !== null &&
    resolveCatalogRunModel(catalog, selected.selectedModel) === null
  );
}

/** Any account of the subscription type, including a disconnected one. */
const hasPersonalSubscriptionAccount$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly type: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [account] = await get(db$)
      .select({ id: modelProviderAccounts.id })
      .from(modelProviderAccounts)
      .where(
        and(
          eq(modelProviderAccounts.orgId, args.orgId),
          eq(modelProviderAccounts.userId, args.userId),
          eq(modelProviderAccounts.type, args.type),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return account !== undefined;
  },
);

/**
 * The captured pin of a resolved selection, or its explicit error. A replaced
 * model never falls back to the system default or to Built-in billing.
 */
const capturedPin$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly catalog: ModelCatalog;
      readonly selectedModel: string;
      readonly selected: ModelFirstPin | ReturnType<typeof badRequestMessage>;
    },
    signal: AbortSignal,
  ): Promise<ModelFirstPin | ReturnType<typeof badRequestMessage>> => {
    const { catalog, selectedModel, selected } = args;
    if ("status" in selected) {
      return isReplacedModelSelection(catalog, selectedModel)
        ? badRequestMessage(
            `Model "${selectedModel}" was replaced and its replacement has no compatible route`,
          )
        : selected;
    }
    const subscriptionRequired = replacementSubscriptionRequired(
      catalog,
      selectedModel,
      selected,
    );
    // A disconnected account that is still retained keeps the subscription;
    // its queued input reports the reconnect error instead.
    if (
      subscriptionRequired &&
      !(await set(
        hasPersonalSubscriptionAccount$,
        {
          orgId: args.orgId,
          userId: args.userId,
          type: subscriptionRequired.subscriptionType,
        },
        signal,
      ))
    ) {
      return subscriptionRequired.response;
    }
    // A retained personal catalog row identifies ownership, not runtime permission.
    return isUnavailablePersonalCapture(catalog, selected)
      ? badRequestMessage(
          "The selected personal subscription model is unavailable",
        )
      : selected;
  },
);

/**
 * Capture an input's model once. Only Auto or an available personal
 * subscription model is accepted; every other selection fails explicitly.
 */
export const resolveChatInputModelSelection$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly selectedModel: string | null;
      readonly codexServiceTier: CodexServiceTier | null;
      readonly modelSettings: ModelSettings;
      readonly reasoningEffort?: ReasoningEffort;
      /** The organization's plan, when the caller already read it in this request. */
      readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
      /** The request's catalog snapshot, when the caller already loaded it. */
      readonly catalog?: ModelCatalog;
      readonly modelBootstrap?: ModelSelectionBootstrap;
    },
    signal: AbortSignal,
  ) => {
    const catalog = args.catalog ?? (await set(loadModelCatalog$, signal));
    signal.throwIfAborted();
    let selectedModel = args.selectedModel;
    let modelProviderType: string | null = null;
    let codexServiceTier = args.codexServiceTier;
    const selected = selectedModel
      ? await set(
          resolveModelSelectionPin$,
          {
            purpose: "capture",
            orgId: args.orgId,
            userId: args.userId,
            modelSelection: {
              modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
              selectedModel,
            },
            orgPlanCapabilities: args.orgPlanCapabilities,
            catalog,
            modelBootstrap: args.modelBootstrap,
          },
          signal,
        )
      : null;
    const pin =
      selected && selectedModel
        ? await set(
            capturedPin$,
            { ...args, catalog, selectedModel, selected },
            signal,
          )
        : null;
    if (pin && "status" in pin) {
      return pin;
    }
    if (pin) {
      // New writes store the final resolved model.
      selectedModel = pin.selectedModel;
      modelProviderType = pin.modelProviderType;
    } else {
      const auto = autoSelectionPin();
      selectedModel = auto.selectedModel;
      modelProviderType = auto.modelProviderType;
      codexServiceTier = null;
    }
    if (!selectedModel) {
      return badRequestMessage("No valid model route is configured");
    }
    // The replacement of a stored selection keeps the caller's explicit effort
    // when its route accepts it.
    const selectedIsReplacement =
      pin !== null &&
      selectedModel !== args.selectedModel &&
      !isAutoSelectedModel(selectedModel);
    const effort = resolveChatReasoningEffort({
      catalog,
      selectedModel,
      modelProviderType,
      modelSettings: args.modelSettings,
      requested:
        selectedModel === args.selectedModel || selectedIsReplacement
          ? args.reasoningEffort
          : undefined,
    });
    if ("status" in effort) {
      return effort;
    }
    return chatInputModelSelectionSchema.parse({
      selectedModel,
      codexServiceTier: isCatalogFastServiceTierSupported(
        catalog,
        selectedModel,
        modelProviderType,
      )
        ? codexServiceTier
        : null,
      reasoningEffort: effort.reasoningEffort ?? null,
    });
  },
);

/**
 * The successor a captured input runs for a thread selection of a replaced
 * model, or null when the thread already stores what the input runs.
 */
export function capturedModelReplacement(
  catalog: ModelCatalog,
  storedModel: string | null,
  captured: ChatInputModelSelection,
): string | null {
  return storedModel !== null &&
    captured.selectedModel !== storedModel &&
    isReplacedModelSelection(catalog, storedModel)
    ? captured.selectedModel
    : null;
}

/** A thread selection of a replaced model, rewritten when its input enqueues. */
export interface ThreadModelReplacement {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly replacedModel: string;
  readonly selectedModel: string;
  readonly replacedCodexServiceTier: CodexServiceTier | null;
  readonly codexServiceTier: CodexServiceTier | null;
}

export interface EnqueuedChatInputModel {
  readonly modelSelection: ChatInputModelSelection;
  readonly threadModelReplacement: ThreadModelReplacement | null;
}

/**
 * Guarded snapshot update for the atomic enqueue owner, after its input
 * event. Only a thread still on the replaced selection changes, so a concurrent
 * model change wins. The owner appends model/tier events only after this wins.
 */
export function threadModelReplacementWritePlan(
  replacement: ThreadModelReplacement,
  updatedAt: Date,
) {
  // The tier is written only with its event, so a concurrent tier change the
  // replacement does not clear stays with the snapshot that recorded it.
  const tierChanged =
    replacement.codexServiceTier !== replacement.replacedCodexServiceTier;
  return {
    table: chatThreads,
    eventScope: { replacement, updatedAt, tierChanged },
    values: {
      selectedModel: replacement.selectedModel,
      ...(tierChanged
        ? { codexServiceTier: replacement.codexServiceTier }
        : {}),
      updatedAt,
    },
    where: and(
      eq(chatThreads.id, replacement.chatThreadId),
      eq(chatThreads.userId, replacement.userId),
      eq(chatThreads.selectedModel, replacement.replacedModel),
    ),
    returning: { id: chatThreads.id },
  };
}

/**
 * Integration and automation inputs follow the same existing-thread rule. A
 * stored selection of a replaced model captures its successor, and the
 * enqueue transaction rewrites the thread to it. A stored selection that no
 * longer captures is enqueued unchanged so the queue pick rejects it visibly
 * instead of silently switching models.
 */
export const resolveEnqueuedChatInputModel$ = command(
  async (
    { get, set },
    args: {
      readonly threadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<EnqueuedChatInputModel> => {
    const db = get(db$);
    const [[thread], catalog] = await Promise.all([
      db
        .select({
          userId: chatThreads.userId,
          agentId: chatThreads.agentId,
          selectedModel: chatThreads.selectedModel,
          codexServiceTier: chatThreads.codexServiceTier,
          modelSettings: chatThreads.modelSettings,
        })
        .from(chatThreads)
        .where(eq(chatThreads.id, args.threadId))
        .limit(1),
      set(loadModelCatalog$, signal),
    ]);
    signal.throwIfAborted();
    if (!thread) {
      throw new Error("Chat thread not found while enqueuing input");
    }
    const selection = await set(
      resolveChatInputModelSelection$,
      {
        ...args,
        selectedModel: thread.selectedModel,
        codexServiceTier: thread.codexServiceTier,
        modelSettings: modelSettingsSchema.parse(thread.modelSettings),
        catalog,
      },
      signal,
    );
    if (!("status" in selection)) {
      const successor = capturedModelReplacement(
        catalog,
        thread.selectedModel,
        selection,
      );
      return {
        modelSelection: selection,
        threadModelReplacement:
          successor && thread.selectedModel && thread.agentId
            ? {
                chatThreadId: args.threadId,
                userId: thread.userId,
                orgId: args.orgId,
                agentId: thread.agentId,
                replacedModel: thread.selectedModel,
                selectedModel: successor,
                replacedCodexServiceTier: thread.codexServiceTier,
                codexServiceTier: selection.codexServiceTier,
              }
            : null,
      };
    }
    if (!thread.selectedModel) {
      throw new Error(selection.body.error.message);
    }
    return {
      modelSelection: chatInputModelSelectionSchema.parse({
        selectedModel: thread.selectedModel,
        codexServiceTier: thread.codexServiceTier,
        reasoningEffort: null,
      }),
      threadModelReplacement: null,
    };
  },
);
