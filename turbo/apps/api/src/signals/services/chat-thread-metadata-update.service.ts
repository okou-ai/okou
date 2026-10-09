import { z } from "zod";
import {
  parseRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import {
  modelSettingsSchema,
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  type ChatThreadServiceTier,
  type CodexServiceTier,
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
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import { loadModelCatalog$, type ModelCatalog } from "./model-catalog.service";
import {
  resolveModelSelectionPin$,
  validateCodexServiceTier,
  type ModelFirstPin,
} from "./model-selection.service";
import { agents } from "@okouai/db/schema/agent";
import { command } from "ccstate";
import { settle } from "../utils";

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
  ModelFirstPin | { readonly status: number; readonly body: unknown } | null;

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
      selectedModel: pin.selectedModel,
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
    // The event carries the resolved model the snapshot stores, so replay
    // never restores a replaced model.
    ...(columns
      ? [
          {
            ...base,
            kind: "model_selection_updated" as const,
            selectedModel: columns.selectedModel,
            modelSettingsPatch: columns.modelSettingsPatch,
            eventId: args.eventIds?.model,
          },
        ]
      : []),
    ...(columns && args.emitServiceTierEvent
      ? [
          {
            ...base,
            kind: "service_tier_updated" as const,
            serviceTier: chatThreadServiceTierFromCodex(
              columns.codexServiceTier,
            ),
            eventId: args.eventIds?.serviceTier,
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
    const catalog = await set(loadModelCatalog$, signal);
    signal.throwIfAborted();
    if (args.patch.model === null) {
      return { catalog, pin: null };
    }
    const pin = await set(
      resolveModelSelectionPin$,
      {
        purpose: "configure",
        ...args.principal,
        catalog,
        modelSelection: {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: args.patch.model,
        },
      },
      signal,
    );
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
      const { catalog, pin } = proposal.value;
      if (catalog === null) {
        throw new Error("Prepared model catalog is missing");
      }
      const model = resolveModelColumns(catalog, args, current, pin);
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
        await tx.execute(chatThreadEventInsertSql(event));
        signal.throwIfAborted();
      }
      if (!state) {
        throw new Error("Updated chat thread state is missing");
      }
      return metadataResult(state);
    });
  },
);

const titleMetadataStateSchema = z.object({
  threadId: z.string().uuid(),
  title: z.string().nullable(),
  titleTruncated: z.boolean(),
  selectedModel: z.string().nullable(),
  codexServiceTier: z.enum(["fast"]).nullable(),
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
      return state ? metadataResult(state) : { kind: "not_found" };
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
    return state ? metadataResult(state) : { kind: "not_found" };
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
    // Ownership remains the first returned refusal even if independent model
    // preparation fails. No preparation error enters the write transaction.
    const prepared = await settle(
      set(prepareMetadataModel$, args, signal),
      signal,
    );
    signal.throwIfAborted();
    return await set(commitMetadata$, args, prepared, signal);
  },
);
