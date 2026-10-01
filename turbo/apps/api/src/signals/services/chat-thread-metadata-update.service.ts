import { z } from "zod";
import {
  parseRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { createHash } from "node:crypto";
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
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { now, nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  ChatThreadEventIdConflictError,
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
  readonly serviceTier: ChatThreadServiceTier | null;
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

interface PreparedMetadataModel {
  readonly catalog: ModelCatalog | null;
  readonly pin: PreparedPin;
}

type PreparedMetadataOutcome =
  | { readonly ok: true; readonly value: PreparedMetadataModel }
  | { readonly ok: false; readonly error: unknown };

/** Capture one catalog snapshot and resolve routing before the SQL write. */
const prepareMetadataModel$ = command(
  async (
    { set },
    args: ChatThreadMetadataUpdateArgs,
    signal: AbortSignal,
  ): Promise<PreparedMetadataModel> => {
    if (!hasModel(args.patch)) {
      return { catalog: null, pin: null };
    }
    const catalog = await loadModelCatalog(set(writeDb$));
    signal.throwIfAborted();
    if (args.patch.model === null) {
      return { catalog, pin: null };
    }
    const pin = await resolveModelSelectionPin({
      db: set(writeDb$),
      ...args.principal,
      catalog,
      modelSelection: {
        modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
        selectedModel: args.patch.model,
      },
    });
    signal.throwIfAborted();
    return { catalog, pin };
  },
);

function metadataPreparationDisposition(prepared: PreparedMetadataOutcome) {
  if (!prepared.ok) {
    return { kind: "error" as const, error: prepared.error };
  }
  const pin = prepared.value.pin;
  if (pin !== null && "status" in pin) {
    return { kind: "response" as const, response: pin };
  }
  return { kind: "ready" as const, value: prepared.value };
}

const commitMetadata$ = command(
  async (
    { set },
    args: ChatThreadMetadataUpdateArgs,
    prepared: PreparedMetadataOutcome,
    signal: AbortSignal,
  ): Promise<ChatThreadMetadataUpdateResult> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const proposal = metadataPreparationDisposition(prepared);
    if (proposal.kind !== "ready") {
      const [owned] = await db
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(threadCondition(args))
        .limit(1);
      signal.throwIfAborted();
      if (!owned) {
        return { kind: "not_found" };
      }
      if (proposal.kind === "error") {
        throw proposal.error;
      }
      return proposal;
    }
    // Preserve the current model settings and service tier while applying the
    // model change and its ordered events. This is the only metadata write
    // that needs a read/write snapshot; renames use one gated statement.
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
      const { catalog, pin } = proposal.value;
      if (hasModel(args.patch) && catalog === null) {
        throw new Error("Prepared model catalog is missing");
      }
      const model =
        catalog === null
          ? { kind: "ok" as const, columns: undefined }
          : resolveModelColumns(catalog, args, current, pin);
      if (model.kind === "response") {
        return model;
      }
      const updatedAt = nowDate();
      const [state] = await tx
        .update(chatThreads)
        .set({
          updatedAt,
          ...(hasTitle(args.patch)
            ? { title: args.patch.title, renamedAt: updatedAt }
            : {}),
          ...model.columns,
        })
        .where(eq(chatThreads.id, args.threadId))
        .returning(currentSelection);
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
      if (!state) {
        throw new Error("Updated chat thread state is missing");
      }
      return metadataResult(state, updatedAt, false);
    });
  },
);

const titleMetadataStateSchema = z.object({
  threadId: z.string().uuid(),
  title: z.string().nullable(),
  titleTruncated: z.boolean(),
  selectedModel: z.string().nullable(),
  codexServiceTier: z.enum(["fast", "ultrafast"]).nullable(),
  updatedAt: pgTimestampWithoutTimezoneToDateSchema,
});

/** One statement owns a manual rename and its ordered list event. */
const commitTitleMetadata$ = command(
  async (
    { set },
    args: ChatThreadMetadataUpdateArgs,
    signal: AbortSignal,
  ): Promise<ChatThreadMetadataUpdateResult> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const updatedAt = nowDate();
    const update = db
      .update(chatThreads)
      .set({
        updatedAt,
        ...(hasTitle(args.patch)
          ? { title: args.patch.title, renamedAt: updatedAt }
          : {}),
      })
      .where(threadCondition(args));
    if (!hasTitle(args.patch)) {
      const [state] = await update.returning(currentSelection);
      signal.throwIfAborted();
      return state
        ? metadataResult(state, updatedAt, false)
        : { kind: "not_found" };
    }
    const updated = update.returning({
      id: chatThreads.id,
      title: chatThreads.title,
      selectedModel: chatThreads.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
      updatedAt: chatThreads.updatedAt,
      agentId: chatThreads.agentId,
    });
    const [state] = parseRawRows(
      titleMetadataStateSchema,
      await db.execute(
        chatThreadEventInsertSql(
          {
            kind: "renamed",
            userId: args.principal.userId,
            orgId: args.principal.orgId,
            chatThreadId: args.threadId,
            title: args.patch.title,
            eventId: args.eventIds?.title,
            createdAt: updatedAt,
          },
          {
            cte: sql`updated AS (${updated.getSQL()})`,
            gate: sql`EXISTS (SELECT 1 FROM updated)`,
            agentId: sql`(SELECT agent_id FROM updated)`,
            result: sql`SELECT id AS "threadId", left(title, 500) AS title,
        COALESCE(length(title) > 500, false) AS "titleTruncated",
        selected_model AS "selectedModel", codex_service_tier AS "codexServiceTier",
        updated_at::text AS "updatedAt" FROM updated`,
          },
        ),
      ),
    );
    signal.throwIfAborted();
    return state
      ? metadataResult(state, updatedAt, false)
      : { kind: "not_found" };
  },
);

export const updateChatThreadMetadata$ = command(
  async (
    { set },
    args: ChatThreadMetadataUpdateArgs,
    signal: AbortSignal,
  ): Promise<ChatThreadMetadataUpdateResult> => {
    signal.throwIfAborted();
    if (!hasModel(args.patch)) {
      return await set(commitTitleMetadata$, args, signal);
    }
    const outcome = await settle(
      (async () => {
        // A missing/foreign thread keeps its 404 even if independent model
        // preparation failed. The write owner checks tenant ownership first.
        const prepared = await settle(
          set(prepareMetadataModel$, args, signal),
          signal,
        );
        signal.throwIfAborted();
        return await set(commitMetadata$, args, prepared, signal);
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
