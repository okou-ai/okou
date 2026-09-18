import { createHash } from "node:crypto";
import {
  modelSettingsSchema,
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { Tx } from "../../lib/db-types";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { now, nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  ChatThreadEventIdConflictError,
  appendChatThreadEvent,
  appendChatThreadEventStrict,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import { withChatThreadContentWrite } from "./chat-thread-content-erasure-admission.service";
import { chatThreadModelPinColumns } from "./chat-thread-model.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  resolveModelSelectionPin,
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
  | { readonly kind: "closed" }
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
  { readonly kind: "not_found" | "closed" }
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

async function readMutation(
  tx: Tx,
  args: ChatThreadMetadataUpdateArgs,
  agentId: string,
): Promise<ExistingMutation | null> {
  const mutationId = args.mutationId;
  if (mutationId === undefined) {
    return null;
  }
  const secondaryId = modelEventId(mutationId);
  const rows = await tx
    .select({
      id: chatThreadEvents.id,
      userId: chatThreadEvents.userId,
      orgId: chatThreadEvents.orgId,
      threadId: chatThreadEvents.chatThreadId,
      agentId: chatThreadEvents.agentId,
      kind: chatThreadEvents.kind,
      title: chatThreadEvents.title,
      selectedModel: chatThreadEvents.selectedModel,
      createdAt: chatThreadEvents.createdAt,
    })
    .from(chatThreadEvents)
    .where(inArray(chatThreadEvents.id, [mutationId, secondaryId]));
  const primary = rows.find((row) => {
    return row.id === mutationId;
  });
  const secondary = rows.find((row) => {
    return row.id === secondaryId;
  });
  if (!primary && !secondary) {
    return null;
  }
  const matchesIdentity = (row: (typeof rows)[number]) => {
    return (
      row.userId === args.principal.userId &&
      row.orgId === args.principal.orgId &&
      row.threadId === args.threadId &&
      row.agentId === agentId
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

async function currentState(
  tx: Tx,
  args: ChatThreadMetadataUpdateArgs,
): Promise<ChatThreadMetadataState | null> {
  const [thread] = await tx
    .select({
      threadId: chatThreads.id,
      title: sql`left(${chatThreads.title}, 500)`.mapWith(
        nullableDriverValueDecoder(chatThreads.title),
      ),
      titleTruncated:
        sql`coalesce(length(${chatThreads.title}) > 500, false)`.mapWith(
          pgBooleanDecoder,
        ),
      selectedModel: chatThreads.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
      updatedAt: chatThreads.updatedAt,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.principal.userId),
        chatThreadOrganizationCondition(tx, args.principal.orgId),
        isNotNull(chatThreads.agentId),
      ),
    )
    .limit(1);
  return thread
    ? {
        ...thread,
        serviceTier: chatThreadServiceTierFromCodex(thread.codexServiceTier),
      }
    : null;
}

async function replayMutation(
  tx: Tx,
  args: ChatThreadMetadataUpdateArgs,
  existing: ExistingMutation,
): Promise<UpdateOperationResult> {
  if (existing.acceptedAt.getTime() + UPDATE_RETRY_MS <= now()) {
    return {
      kind: "expired",
      message:
        "The 24-hour update retry window has expired. Inspect the conversation before making a new change; this request was not applied again.",
    };
  }
  const state = await currentState(tx, args);
  if (!state) {
    throw new Error("Updated chat thread state is missing");
  }
  return {
    kind: "ok",
    state,
    acceptedAt: existing.acceptedAt,
    retryUntil: new Date(existing.acceptedAt.getTime() + UPDATE_RETRY_MS),
    replayed: true,
  };
}

async function resolveModelColumns(
  tx: Tx,
  args: ChatThreadMetadataUpdateArgs,
  current: CurrentModelState,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "ok"; readonly columns: ModelColumns | undefined }
  | Extract<UpdateOperationResult, { readonly kind: "response" }>
> {
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
      : await resolveModelSelectionPin({
          db: tx,
          ...args.principal,
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: args.patch.model,
          },
        });
  signal.throwIfAborted();
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

async function appendTitleEvent(
  tx: Tx,
  args: ChatThreadMetadataUpdateArgs,
  agentId: string,
  updatedAt: Date,
): Promise<void> {
  if (!hasTitle(args.patch)) {
    return;
  }
  const event = {
    kind: "renamed" as const,
    userId: args.principal.userId,
    orgId: args.principal.orgId,
    chatThreadId: args.threadId,
    agentId,
    title: args.patch.title,
    createdAt: updatedAt,
  };
  if (args.mutationId !== undefined) {
    await appendChatThreadEventStrict(tx, {
      ...event,
      eventId: args.mutationId,
    });
    return;
  }
  await appendChatThreadEvent(tx, {
    ...event,
    ...(args.eventIds?.title ? { eventId: args.eventIds.title } : {}),
  });
}

async function appendModelEvents(
  tx: Tx,
  args: ChatThreadMetadataUpdateArgs,
  agentId: string,
  modelColumns: ModelColumns | undefined,
  updatedAt: Date,
): Promise<void> {
  if (!hasModel(args.patch)) {
    return;
  }
  const event = {
    kind: "model_selection_updated" as const,
    userId: args.principal.userId,
    orgId: args.principal.orgId,
    chatThreadId: args.threadId,
    agentId,
    selectedModel: args.patch.model,
    modelSettingsPatch: modelColumns?.modelSettingsPatch,
    createdAt: updatedAt,
  };
  if (args.mutationId !== undefined) {
    await appendChatThreadEventStrict(tx, {
      ...event,
      eventId: hasTitle(args.patch)
        ? modelEventId(args.mutationId)
        : args.mutationId,
    });
  } else {
    await appendChatThreadEvent(tx, {
      ...event,
      ...(args.eventIds?.model ? { eventId: args.eventIds.model } : {}),
    });
  }
  if (args.emitServiceTierEvent) {
    await appendChatThreadEvent(tx, {
      kind: "service_tier_updated",
      userId: args.principal.userId,
      orgId: args.principal.orgId,
      chatThreadId: args.threadId,
      agentId,
      ...(args.eventIds?.serviceTier
        ? { eventId: args.eventIds.serviceTier }
        : {}),
      serviceTier: chatThreadServiceTierFromCodex(
        modelColumns?.codexServiceTier ?? null,
      ),
      createdAt: updatedAt,
    });
  }
}

async function writeMetadata(
  tx: Tx,
  args: ChatThreadMetadataUpdateArgs,
  agentId: string,
  signal: AbortSignal,
): Promise<UpdateOperationResult> {
  const existing = await readMutation(tx, args, agentId);
  signal.throwIfAborted();
  if (existing) {
    return await replayMutation(tx, args, existing);
  }

  const [current] = await tx
    .select({
      modelSettings: chatThreads.modelSettings,
      codexServiceTier: chatThreads.codexServiceTier,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, args.threadId))
    .limit(1);
  if (!current) {
    throw new Error("Locked chat thread state is missing");
  }

  const model = await resolveModelColumns(tx, args, current, signal);
  if (model.kind === "response") {
    return model;
  }
  const modelColumns = model.columns;

  const updatedAt = nowDate();
  await tx
    .update(chatThreads)
    .set({
      updatedAt,
      ...(hasTitle(args.patch)
        ? { title: args.patch.title, renamedAt: updatedAt }
        : {}),
      ...modelColumns,
    })
    .where(eq(chatThreads.id, args.threadId));

  await appendTitleEvent(tx, args, agentId, updatedAt);
  await appendModelEvents(tx, args, agentId, modelColumns, updatedAt);
  const state = await currentState(tx, args);
  if (!state) {
    throw new Error("Updated chat thread state is missing");
  }
  return {
    kind: "ok",
    state,
    acceptedAt: updatedAt,
    retryUntil: new Date(updatedAt.getTime() + UPDATE_RETRY_MS),
    replayed: false,
  };
}

export async function updateChatThreadMetadata(
  db: Db,
  args: ChatThreadMetadataUpdateArgs,
  signal: AbortSignal,
): Promise<ChatThreadMetadataUpdateResult> {
  const outcome = await settle(
    withChatThreadContentWrite(
      db,
      {
        chatThreadId: args.threadId,
        threadLock: "update",
        authorize: (identity) => {
          return (
            identity.userId === args.principal.userId &&
            identity.agentId !== null &&
            identity.orgId === args.principal.orgId
          );
        },
      },
      async (tx, identity) => {
        if (!identity.agentId) {
          throw new Error("Admitted chat thread Agent is missing");
        }
        return await writeMetadata(tx, args, identity.agentId, signal);
      },
      signal,
    ),
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
  const result = outcome.value;
  if (result.outcome === "missing") {
    return { kind: "not_found" };
  }
  if (result.outcome === "closed") {
    return { kind: "closed" };
  }
  return result.value;
}
