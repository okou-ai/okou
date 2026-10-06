import {
  chatInputModelSelectionSchema,
  type ChatInputModelSelection,
} from "@okouai/api-contracts/contracts/chat-input-model";
import { AUTO_RUN_MODEL } from "@okouai/core/auto-run-model";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  modelSettingsSchema,
  type ModelSettings,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { eq } from "drizzle-orm";
import { badRequestMessage } from "../../lib/error";
import { command } from "ccstate";
import { db$ } from "../external/db";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  resolveDefaultModelFirstPin$,
  resolveModelSelectionPin$,
  isReplacedModelSelection,
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
  selected: ModelFirstPin | ReturnType<typeof badRequestMessage> | null,
): boolean {
  return (
    selected !== null &&
    !("status" in selected) &&
    selected.modelProviderCredentialScope === "member" &&
    selected.selectedModel !== null &&
    resolveCatalogRunModel(catalog, selected.selectedModel) === null
  );
}

/**
 * Capture an input's model once. Personal selections keep their credential
 * source or fail explicitly; retired Custom choices normalize to fixed Auto.
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
    if (isUnavailablePersonalCapture(catalog, selected)) {
      // A retained personal catalog row identifies ownership, not runtime permission.
      return badRequestMessage(
        "The selected personal subscription model is unavailable",
      );
    }
    if (
      selected &&
      "status" in selected &&
      selectedModel &&
      isReplacedModelSelection(catalog, selectedModel)
    ) {
      // A replaced model with no compatible route is an explicit error; it never
      // falls back to the system default or to Built-in billing.
      return badRequestMessage(
        `Model "${selectedModel}" was replaced and its replacement has no compatible route in this workspace`,
      );
    }
    if (!selected || "status" in selected) {
      const workspaceDefault = await set(
        resolveDefaultModelFirstPin$,
        {
          orgId: args.orgId,
          userId: args.userId,
          defaultSource: "workspace",
          orgPlanCapabilities: args.orgPlanCapabilities,
          catalog,
          modelBootstrap: args.modelBootstrap,
        },
        signal,
      );
      selectedModel = workspaceDefault.selectedModel;
      modelProviderType = workspaceDefault.modelProviderType;
      codexServiceTier = null;
    } else {
      // New writes store the final resolved model.
      selectedModel = selected.selectedModel;
      modelProviderType = selected.modelProviderType;
    }
    if (!selectedModel) {
      return badRequestMessage(
        "No valid model route is configured for this workspace",
      );
    }
    // The replacement of a stored selection keeps the caller's explicit effort
    // when its route accepts it.
    const selectedIsReplacement =
      selected !== null &&
      !("status" in selected) &&
      selectedModel !== args.selectedModel &&
      selectedModel !== AUTO_RUN_MODEL;
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

/** Integration and automation inputs follow the same existing-thread rule. */
export const resolveEnqueuedChatInputModel$ = command(
  async (
    { get, set },
    args: {
      readonly threadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<ChatInputModelSelection> => {
    const db = get(db$);
    const [thread] = await db
      .select({
        selectedModel: chatThreads.selectedModel,
        codexServiceTier: chatThreads.codexServiceTier,
        modelSettings: chatThreads.modelSettings,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, args.threadId))
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      throw new Error("Chat thread not found while enqueuing input");
    }
    const selection = await set(
      resolveChatInputModelSelection$,
      {
        ...args,
        ...thread,
        modelSettings: modelSettingsSchema.parse(thread.modelSettings),
      },
      signal,
    );
    if ("status" in selection) {
      throw new Error(selection.body.error.message);
    }
    return selection;
  },
);
