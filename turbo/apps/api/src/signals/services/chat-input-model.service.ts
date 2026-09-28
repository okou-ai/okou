import {
  chatInputModelSelectionSchema,
  type ChatInputModelSelection,
} from "@okouai/api-contracts/contracts/chat-input-model";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  modelSettingsSchema,
  type ModelSettings,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { eq } from "drizzle-orm";
import type { Db } from "../external/db";
import { badRequestMessage } from "../../lib/error";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  isCodexFastServiceTierSupported,
  resolveDefaultModelFirstPin,
  resolveModelSelectionPin,
} from "./model-selection.service";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";

/** Capture an input's model once, using the workspace default when unavailable. */
export async function resolveChatInputModelSelection(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly selectedModel: string | null;
    readonly codexServiceTier: CodexServiceTier | null;
    readonly modelSettings: ModelSettings;
    readonly reasoningEffort?: ReasoningEffort;
    /** The organization's plan, when the caller already read it in this request. */
    readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
  },
) {
  let selectedModel = args.selectedModel;
  let codexServiceTier = args.codexServiceTier;
  const selected = selectedModel
    ? await resolveModelSelectionPin({
        db,
        orgId: args.orgId,
        userId: args.userId,
        modelSelection: {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel,
        },
        orgPlanCapabilities: args.orgPlanCapabilities,
      })
    : null;
  if (!selected || "status" in selected) {
    const workspaceDefault = await resolveDefaultModelFirstPin(
      db,
      args.orgId,
      args.userId,
      "workspace",
      args.orgPlanCapabilities,
    );
    selectedModel = workspaceDefault.selectedModel;
    codexServiceTier = null;
  }
  if (!selectedModel) {
    return badRequestMessage(
      "No valid model route is configured for this workspace",
    );
  }
  const effort = resolveChatReasoningEffort({
    selectedModel,
    modelSettings: args.modelSettings,
    requested:
      selectedModel === args.selectedModel ? args.reasoningEffort : undefined,
  });
  if ("status" in effort) {
    return effort;
  }
  return chatInputModelSelectionSchema.parse({
    selectedModel,
    codexServiceTier: isCodexFastServiceTierSupported({ selectedModel })
      ? codexServiceTier
      : null,
    reasoningEffort: effort.reasoningEffort ?? null,
  });
}

/** Integration and automation inputs follow the same existing-thread rule. */
export async function resolveEnqueuedChatInputModel(
  db: Db,
  args: {
    readonly threadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<ChatInputModelSelection> {
  const [thread] = await db
    .select({
      selectedModel: chatThreads.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
      modelSettings: chatThreads.modelSettings,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, args.threadId))
    .limit(1);
  if (!thread) {
    throw new Error("Chat thread not found while enqueuing input");
  }
  const selection = await resolveChatInputModelSelection(db, {
    ...args,
    ...thread,
    modelSettings: modelSettingsSchema.parse(thread.modelSettings),
  });
  if ("status" in selection) {
    throw new Error(selection.body.error.message);
  }
  return selection;
}
