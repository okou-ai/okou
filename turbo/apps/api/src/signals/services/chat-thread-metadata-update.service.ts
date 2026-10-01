import {
  modelSettingsSchema,
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type {
  ChatThreadServiceTier,
  CodexServiceTier,
} from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  chatThreadServiceTierFromCodex,
  chatThreadEventInsertSql,
} from "./chat-thread-event.service";
import { chatThreadModelPinColumns } from "./chat-thread-model.service";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import { loadModelCatalog, type ModelCatalog } from "./model-catalog.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  resolveModelSelectionPin,
  validateCodexServiceTier,
  type ModelFirstPin,
} from "./model-selection.service";
import { agents } from "@okouai/db/schema/agent";
import { command } from "ccstate";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

interface ChatThreadMetadataPatch {
  readonly title?: string;
  readonly model?: string | null;
  readonly reasoningEffort?: ReasoningEffort;
}

interface EventIds {
  readonly title?: string;
  readonly model?: string;
  readonly serviceTier?: string;
}

interface ChatThreadMetadataUpdateArgs {
  readonly principal: Principal;
  readonly threadId: string;
  readonly patch: ChatThreadMetadataPatch;
  readonly codexServiceTier:
    | { readonly kind: "preserve" }
    | { readonly kind: "set"; readonly value: CodexServiceTier | null };
  readonly emitServiceTierEvent: boolean;
  readonly eventIds?: EventIds;
}

interface ChatThreadMetadataState {
  readonly threadId: string;
  readonly title: string | null;
  readonly titleTruncated: boolean;
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly updatedAt: Date;
}

type ChatThreadMetadataUpdateResult =
  | {
      readonly kind: "ok";
      readonly state: ChatThreadMetadataState;
    }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "response";
      readonly response: { readonly status: number; readonly body: unknown };
    };

interface CurrentModelState {
  readonly modelSettings: ModelSettings;
  readonly codexServiceTier: CodexServiceTier | null;
}

interface ModelColumns {
  readonly modelProviderId: null;
  readonly modelProviderType: null;
  readonly modelProviderCredentialScope: null;
  readonly selectedModel: string | null;
  readonly modelSettings: ModelSettings;
  readonly modelSettingsPatch: ModelSettingsPatch | undefined;
  readonly codexServiceTier: CodexServiceTier | null;
}

type UpdateOperationResult = Exclude<
  ChatThreadMetadataUpdateResult,
  { readonly kind: "not_found" }
>;

function hasTitle(
  patch: ChatThreadMetadataPatch,
): patch is ChatThreadMetadataPatch & {
  readonly title: string;
} {
  return Object.hasOwn(patch, "title");
}

function hasModel(
  patch: ChatThreadMetadataPatch,
): patch is ChatThreadMetadataPatch & {
  readonly model: string | null;
} {
  return Object.hasOwn(patch, "model");
}

const currentSelection = Object.freeze({
  agentId: chatThreads.agentId,
  modelSettings: chatThreads.modelSettings,
  codexServiceTier: chatThreads.codexServiceTier,
  threadId: chatThreads.id,
  title: sql`left(${chatThreads.title}, 500)`.mapWith(
    nullableDriverValueDecoder(chatThreads.title),
  ),
  titleTruncated:
    sql`coalesce(length(${chatThreads.title}) > 500, false)`.mapWith(
      pgBooleanDecoder,
    ),
  selectedModel: chatThreads.selectedModel,
  updatedAt: chatThreads.updatedAt,
});

function threadCondition(args: ChatThreadMetadataUpdateArgs) {
  return and(
    eq(chatThreads.id, args.threadId),
    eq(chatThreads.userId, args.principal.userId),
    isNotNull(chatThreads.agentId),
    sql`EXISTS (SELECT 1 FROM ${agents} WHERE ${agents.id} = ${chatThreads.agentId} AND ${agents.orgId} = ${args.principal.orgId})`,
  );
}

type PreparedPin =
  | ModelFirstPin
  | { readonly status: number; readonly body: unknown }
  | null;

function metadataResult(
  state: Omit<ChatThreadMetadataState, "serviceTier">,
): ChatThreadMetadataUpdateResult {
  return {
    kind: "ok",
    state: {
      ...state,
      serviceTier: chatThreadServiceTierFromCodex(state.codexServiceTier),
    },
  };
}

function resolveModelColumns(
  catalog: ModelCatalog,
  args: ChatThreadMetadataUpdateArgs,
  current: CurrentModelState,
  preparedPin: PreparedPin,
):
  | { readonly kind: "ok"; readonly columns: ModelColumns | undefined }
  | Extract<UpdateOperationResult, { readonly kind: "response" }> {
  if (!hasModel(args.patch)) {
    return { kind: "ok", columns: undefined };
  }
  const pin =
    args.patch.model === null
      ? {
          modelProviderId: null,
          modelProviderType: null,
          modelProviderCredentialScope: null,
          selectedModel: null,
        }
      : preparedPin;
  if (pin === null) {
    throw new Error("Prepared model selection is missing");
  }
  if ("status" in pin) {
    return { kind: "response", response: pin };
  }
  const effort = resolveChatReasoningEffort({
    catalog,
    selectedModel: pin.selectedModel,
    modelProviderType: pin.modelProviderType,
    modelSettings: modelSettingsSchema.parse(current.modelSettings),
    requested: args.patch.reasoningEffort,
  });
  if ("status" in effort) {
    return { kind: "response", response: effort };
  }
  const codexServiceTier =
    args.codexServiceTier.kind === "preserve"
      ? current.codexServiceTier
      : args.codexServiceTier.value;
  const tierError = validateCodexServiceTier({
    catalog,
    pin,
    codexServiceTier,
  });
  if (tierError) {
    return { kind: "response", response: tierError };
  }
  return {
    kind: "ok",
    columns: {
      ...chatThreadModelPinColumns(pin),
      modelSettings: effort.modelSettings,
      modelSettingsPatch: effort.modelSettingsPatch,
      codexServiceTier,
    },
  };
}

function metadataEvents(
  args: ChatThreadMetadataUpdateArgs,
  agentId: string,
  columns: ModelColumns | undefined,
  createdAt: Date,
) {
  const base = {
    userId: args.principal.userId,
    orgId: args.principal.orgId,
    chatThreadId: args.threadId,
    agentId,
    createdAt,
  };
  return [
    ...(hasTitle(args.patch)
      ? [
          {
            ...base,
            kind: "renamed" as const,
            title: args.patch.title,
            eventId: args.eventIds?.title,
          },
        ]
      : []),
    ...(hasModel(args.patch)
      ? [
          {
            ...base,
            kind: "model_selection_updated" as const,
            selectedModel: args.patch.model,
            modelSettingsPatch: columns?.modelSettingsPatch,
            eventId: args.eventIds?.model,
          },
        ]
      : []),
    ...(hasModel(args.patch) && args.emitServiceTierEvent
      ? [
          {
            ...base,
            kind: "service_tier_updated" as const,
            serviceTier: chatThreadServiceTierFromCodex(
              columns?.codexServiceTier ?? null,
            ),
            eventId: args.eventIds?.serviceTier,
          },
        ]
      : []),
  ];
}

const prepareMetadataModel$ = command(
  async (
    { set },
    args: ChatThreadMetadataUpdateArgs,
    signal: AbortSignal,
  ): Promise<PreparedPin> => {
    if (!hasModel(args.patch) || args.patch.model === null) {
      return null;
    }
    const db = set(writeDb$);
    const [thread] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(threadCondition(args))
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      return null;
    }
    return await resolveModelSelectionPin({
      db: set(writeDb$),
      ...args.principal,
      modelSelection: {
        modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
        selectedModel: args.patch.model,
      },
    });
  },
);

const commitMetadata$ = command(
  async (
    { set },
    args: ChatThreadMetadataUpdateArgs,
    pin: PreparedPin,
    signal: AbortSignal,
  ): Promise<ChatThreadMetadataUpdateResult> => {
    const db = set(writeDb$);
    const catalog = await loadModelCatalog(db);
    signal.throwIfAborted();
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select(currentSelection)
        .from(chatThreads)
        .where(threadCondition(args))
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (!current?.agentId) {
        return { kind: "not_found" };
      }
      const model = resolveModelColumns(catalog, args, current, pin);
      if (model.kind === "response") {
        return model;
      }
      const updatedAt = nowDate();
      await tx
        .update(chatThreads)
        .set({
          updatedAt,
          ...(hasTitle(args.patch)
            ? { title: args.patch.title, renamedAt: updatedAt }
            : {}),
          ...model.columns,
        })
        .where(eq(chatThreads.id, args.threadId));
      signal.throwIfAborted();
      for (const event of metadataEvents(
        args,
        current.agentId,
        model.columns,
        updatedAt,
      )) {
        await tx.execute(chatThreadEventInsertSql(event));
        signal.throwIfAborted();
      }
      const [state] = await tx
        .select(currentSelection)
        .from(chatThreads)
        .where(threadCondition(args))
        .limit(1);
      signal.throwIfAborted();
      if (!state) {
        throw new Error("Updated chat thread state is missing");
      }
      return metadataResult(state);
    });
  },
);

export const updateChatThreadMetadata$ = command(
  async (
    { set },
    args: ChatThreadMetadataUpdateArgs,
    signal: AbortSignal,
  ): Promise<ChatThreadMetadataUpdateResult> => {
    const pin = await set(prepareMetadataModel$, args, signal);
    return await set(commitMetadata$, args, pin, signal);
  },
);
