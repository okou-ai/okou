import { createHash } from "node:crypto";
import {
  modelSettingsSchema,
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import { agents } from "@okouai/db/schema/agent";
import { command } from "ccstate";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { now, nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  ChatThreadEventIdConflictError,
  chatThreadEventInsertSql,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import { chatThreadModelPinColumns } from "./chat-thread-model.service";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  resolveModelSelectionPin$,
  type ModelFirstPin,
  validateCodexServiceTier,
} from "./model-selection.service";

const UPDATE_RETRY_MS = 24 * 60 * 60 * 1000;
const MODEL_EVENT_NAMESPACE = "be62e24f-d82d-42bf-bdbf-7bc199e18bc8";

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
  readonly mutationId?: string;
}

interface ChatThreadMetadataState {
  readonly threadId: string;
  readonly title: string | null;
  readonly titleTruncated: boolean;
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly serviceTier: "priority" | null;
  readonly updatedAt: Date;
}

type ChatThreadMetadataUpdateResult =
  | {
      readonly kind: "ok";
      readonly state: ChatThreadMetadataState;
      readonly acceptedAt: Date;
      readonly retryUntil: Date;
      readonly replayed: boolean;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "expired"; readonly message: string }
  | {
      readonly kind: "response";
      readonly response: { readonly status: number; readonly body: unknown };
    };

interface ExistingMutation {
  readonly acceptedAt: Date;
}

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

class MetadataMutationConflictError extends Error {}

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

function modelEventId(mutationId: string): string {
  return uuidv5(`${mutationId}:model`, MODEL_EVENT_NAMESPACE);
}

function patchFingerprint(patch: ChatThreadMetadataPatch): string {
  const canonical = JSON.stringify({
    title: hasTitle(patch) ? { present: true, value: patch.title } : null,
    model: hasModel(patch) ? { present: true, value: patch.model } : null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const mutationSelection = Object.freeze({
  id: chatThreadEvents.id,
  userId: chatThreadEvents.userId,
  orgId: chatThreadEvents.orgId,
  threadId: chatThreadEvents.chatThreadId,
  agentId: chatThreadEvents.agentId,
  kind: chatThreadEvents.kind,
  title: chatThreadEvents.title,
  selectedModel: chatThreadEvents.selectedModel,
  createdAt: chatThreadEvents.createdAt,
});

type MutationRow = Pick<
  typeof chatThreadEvents.$inferSelect,
  | "id"
  | "userId"
  | "orgId"
  | "chatThreadId"
  | "agentId"
  | "kind"
  | "title"
  | "selectedModel"
  | "createdAt"
> & { readonly threadId: string };

function readMutation(
  args: ChatThreadMetadataUpdateArgs,
  rows: readonly Omit<MutationRow, "chatThreadId">[],
): ExistingMutation | null {
  const mutationId = args.mutationId;
  if (mutationId === undefined) {
    return null;
  }
  const secondaryId = modelEventId(mutationId);
  const primary = rows.find((row) => {
    return row.id === mutationId;
  });
  const secondary = rows.find((row) => {
    return row.id === secondaryId;
  });
  if (!primary && !secondary) {
    return null;
  }
  // Integration threads can move to a new organization default Agent after
  // acceptance. Replay belongs to the original principal and thread identity.
  const matchesIdentity = (row: (typeof rows)[number]) => {
    return (
      row.userId === args.principal.userId &&
      row.orgId === args.principal.orgId &&
      row.threadId === args.threadId
    );
  };
  if (!primary || !matchesIdentity(primary)) {
    throw new MetadataMutationConflictError();
  }

  let acceptedPatch: ChatThreadMetadataPatch;
  if (primary.kind === "renamed" && primary.title !== null) {
    if (secondary) {
      if (
        !matchesIdentity(secondary) ||
        secondary.agentId !== primary.agentId ||
        secondary.kind !== "model_selection_updated" ||
        secondary.createdAt.getTime() !== primary.createdAt.getTime()
      ) {
        throw new MetadataMutationConflictError();
      }
      acceptedPatch = {
        title: primary.title,
        model: secondary.selectedModel,
      };
    } else {
      acceptedPatch = { title: primary.title };
    }
  } else if (
    primary.kind === "model_selection_updated" &&
    secondary === undefined
  ) {
    acceptedPatch = { model: primary.selectedModel };
  } else {
    throw new MetadataMutationConflictError();
  }
  if (patchFingerprint(acceptedPatch) !== patchFingerprint(args.patch)) {
    throw new MetadataMutationConflictError();
  }
  return { acceptedAt: primary.createdAt };
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

function mutationIds(args: ChatThreadMetadataUpdateArgs) {
  return args.mutationId === undefined
    ? []
    : [args.mutationId, modelEventId(args.mutationId)];
}

type PreparedPin =
  | ModelFirstPin
  | { readonly status: number; readonly body: unknown }
  | null;

function metadataResult(
  state: Omit<ChatThreadMetadataState, "serviceTier">,
  acceptedAt: Date,
  replayed: boolean,
): ChatThreadMetadataUpdateResult {
  if (replayed && acceptedAt.getTime() + UPDATE_RETRY_MS <= now()) {
    return {
      kind: "expired",
      message:
        "The 24-hour update retry window has expired. Inspect the conversation before making a new change; this request was not applied again.",
    };
  }
  return {
    kind: "ok",
    state: {
      threadId: state.threadId,
      title: state.title,
      titleTruncated: state.titleTruncated,
      selectedModel: state.selectedModel,
      codexServiceTier: state.codexServiceTier,
      updatedAt: state.updatedAt,
      serviceTier: chatThreadServiceTierFromCodex(state.codexServiceTier),
    },
    acceptedAt,
    retryUntil: new Date(acceptedAt.getTime() + UPDATE_RETRY_MS),
    replayed,
  };
}

function resolveModelColumns(
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
    selectedModel: pin.selectedModel,
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
  const tierError = validateCodexServiceTier({ pin, codexServiceTier });
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
            eventId: args.mutationId ?? args.eventIds?.title,
            strict: args.mutationId !== undefined,
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
            eventId:
              args.mutationId === undefined
                ? args.eventIds?.model
                : hasTitle(args.patch)
                  ? modelEventId(args.mutationId)
                  : args.mutationId,
            strict: args.mutationId !== undefined,
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
            strict: false,
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
    const ids = mutationIds(args);
    const existing = ids.length
      ? await db
          .select(mutationSelection)
          .from(chatThreadEvents)
          .where(inArray(chatThreadEvents.id, ids))
      : [];
    signal.throwIfAborted();
    if (readMutation(args, existing)) {
      return null;
    }
    return await set(
      resolveModelSelectionPin$,
      {
        ...args.principal,
        modelSelection: {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: args.patch.model,
        },
      },
      signal,
    );
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
      const ids = mutationIds(args);
      const rows = ids.length
        ? await tx
            .select(mutationSelection)
            .from(chatThreadEvents)
            .where(inArray(chatThreadEvents.id, ids))
        : [];
      signal.throwIfAborted();
      const existing = readMutation(args, rows);
      if (existing) {
        return metadataResult(current, existing.acceptedAt, true);
      }
      const model = resolveModelColumns(args, current, pin);
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
        const { rowCount } = await tx.execute(chatThreadEventInsertSql(event));
        signal.throwIfAborted();
        if (event.strict && rowCount === 0) {
          throw new ChatThreadEventIdConflictError();
        }
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
      return metadataResult(state, updatedAt, false);
    });
  },
);

export const updateChatThreadMetadata$ = command(
  async (
    { set },
    args: ChatThreadMetadataUpdateArgs,
    signal: AbortSignal,
  ): Promise<ChatThreadMetadataUpdateResult> => {
    signal.throwIfAborted();
    const outcome = await settle(
      (async () => {
        const pin = await set(prepareMetadataModel$, args, signal);
        signal.throwIfAborted();
        return await set(commitMetadata$, args, pin, signal);
      })(),
      signal,
    );
    if (!outcome.ok) {
      if (
        outcome.error instanceof MetadataMutationConflictError ||
        outcome.error instanceof ChatThreadEventIdConflictError
      ) {
        return {
          kind: "conflict",
          message:
            "requestId is already in use for a different thread update. Retry only with the original thread and exact patch.",
        };
      }
      throw outcome.error;
    }
    return outcome.value;
  },
);
