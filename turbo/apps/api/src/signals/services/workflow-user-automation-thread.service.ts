import {
  userLocaleSchema,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  modelSettingsSchema,
  type ModelSettings,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { writeDb$, type ReadonlyDb } from "../external/db";
import {
  appendChatThreadCreatedEvent,
  insertChatThread,
} from "./chat-thread-create.service";
import {
  chatThreadEventInsertSql,
  chatThreadServiceTierFromCodex,
  type ChatThreadEventTransaction,
} from "./chat-thread-event.service";
import { chatThreadModelPinColumns } from "./chat-thread-model.service";
import {
  resolveDefaultModelFirstPin,
  type DefaultModelFirstPin,
} from "./model-selection.service";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";

const OFFICIAL_WORKFLOW_THREAD_TITLES: Readonly<
  Partial<Record<string, Readonly<Record<UserLocale, string>>>>
> = {
  "morning-brief": {
    "en-US": "Okou Morning Brief",
    "pt-BR": "Okou Resumo da manhã",
    "ja-JP": "Okou モーニングブリーフ",
    "ko-KR": "Okou 모닝 브리핑",
    "id-ID": "Okou Ringkasan pagi",
    "de-DE": "Okou Morgenbriefing",
    "es-ES": "Okou Resumen matinal",
    "it-IT": "Okou Brief del mattino",
    "fr-FR": "Okou Brief du matin",
    "hi-IN": "Okou सुबह की ब्रीफ़",
    "zh-Hans": "Okou 晨间简报",
    "zh-Hant": "Okou 晨間簡報",
  },
};

export interface WorkflowThreadPreparation {
  readonly initialModel: DefaultModelFirstPin;
  readonly title: string;
  readonly modelSettings: ModelSettings;
  readonly cloudBrowserEnabled: boolean;
}

export const prepareWorkflowUserAutomationThread$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly workflowTitle: string;
    },
    signal: AbortSignal,
  ): Promise<WorkflowThreadPreparation> => {
    const db = set(writeDb$);
    const [[context], [member]] = await Promise.all([
      db
        .select({ officialDefinitionName: workflows.officialDefinitionName })
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, args.orgId),
            eq(workflows.id, args.workflowId),
          ),
        )
        .limit(1),
      db
        .select({
          locale: orgMembersMetadata.locale,
          modelSettings: orgMembersMetadata.modelSettings,
          cloudBrowserEnabled: orgMembersMetadata.cloudBrowserEnabledByDefault,
        })
        .from(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.orgId, args.orgId),
            eq(orgMembersMetadata.userId, args.userId),
          ),
        )
        .limit(1),
    ]);
    signal.throwIfAborted();
    let title = args.workflowTitle;
    if (context?.officialDefinitionName) {
      const locale = userLocaleSchema.parse(member?.locale ?? "en-US");
      const localized =
        OFFICIAL_WORKFLOW_THREAD_TITLES[context.officialDefinitionName]?.[
          locale
        ];
      if (localized) {
        title = localized;
      } else {
        const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
        const definition = catalog?.payload.definitions.find((candidate) => {
          return candidate.name === context.officialDefinitionName;
        });
        if (definition) {
          const revision = await set(
            readAcceptedOfficialWorkflowRevision$,
            { name: definition.name, revision: definition.revision },
            signal,
          );
          title = revision?.definition.workflow.displayName ?? title;
        }
      }
    }
    const initialModel = await resolveDefaultModelFirstPin(
      set(writeDb$),
      args.orgId,
      args.userId,
      undefined,
      undefined,
    );
    signal.throwIfAborted();
    return {
      initialModel,
      title,
      modelSettings: modelSettingsSchema.parse(member?.modelSettings ?? {}),
      cloudBrowserEnabled: member?.cloudBrowserEnabled ?? true,
    };
  },
);

interface WorkflowUserAutomationThreadOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}

/** The one binding row a workflow's automations share for this owner. */
export function workflowUserAutomationThreadOwnerCondition(
  owner: WorkflowUserAutomationThreadOwner,
) {
  return and(
    eq(workflowUserAutomationThreads.orgId, owner.orgId),
    eq(workflowUserAutomationThreads.userId, owner.userId),
    eq(workflowUserAutomationThreads.workflowId, owner.workflowId),
  );
}

async function readWorkflowUserAutomationThreadBinding(
  db: Pick<ReadonlyDb, "select">,
  owner: WorkflowUserAutomationThreadOwner,
): Promise<{ readonly chatThreadId: string | null } | null> {
  const [binding] = await db
    .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
    .from(workflowUserAutomationThreads)
    .where(workflowUserAutomationThreadOwnerCondition(owner))
    .limit(1);
  return binding ?? null;
}

export async function loadWorkflowUserAutomationThreadId(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  const binding = await readWorkflowUserAutomationThreadBinding(db, args);
  return binding?.chatThreadId ?? null;
}

/**
 * Pause every enabled automation that shares a workflow-user chat thread.
 * The caller deletes the thread in the same transaction; the bindings are
 * deleted here and their returned workflows identify the affected automations.
 */
export async function disableThreadBoundWorkflowAutomations(
  db: ChatThreadEventTransaction,
  args: {
    readonly userId: string;
    readonly chatThreadId: string;
    readonly currentTime: Date;
  },
): Promise<
  readonly Pick<
    typeof workflowAutomations.$inferSelect,
    "orgId" | "ownerUserId" | "eventType" | "eventConfig" | "eventConnectorId"
  >[]
> {
  // Detach by deleting the bindings with a conditional DELETE. Creation and
  // reuse both write the binding row through its unique owner key before they
  // insert an automation, so this DELETE either waits for that commit and then
  // disables the automation it added, or commits first and a later creator
  // inserts a fresh binding with a new destination thread.
  const bindings = await db
    .delete(workflowUserAutomationThreads)
    .where(
      and(
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.chatThreadId, args.chatThreadId),
      ),
    )
    .returning({ workflowId: workflowUserAutomationThreads.workflowId });
  if (bindings.length === 0) {
    return [];
  }

  // A disabled Forms automation may be preparing a new interval remotely.
  // Invalidate that observation too before the bound thread is deleted.
  const disabled = await db
    .update(workflowAutomations)
    .set({ enabled: false, nextRunAt: null, updatedAt: args.currentTime })
    .where(
      and(
        eq(workflowAutomations.ownerUserId, args.userId),
        inArray(
          workflowAutomations.workflowId,
          bindings.map((binding) => {
            return binding.workflowId;
          }),
        ),
      ),
    )
    .returning({
      id: workflowAutomations.id,
      officialBlueprintKey: workflowAutomations.officialBlueprintKey,
      officialIntendedEnabled: workflowAutomations.officialIntendedEnabled,
      orgId: workflowAutomations.orgId,
      ownerUserId: workflowAutomations.ownerUserId,
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
      eventConnectorId: workflowAutomations.eventConnectorId,
    });
  const resetForms = disabled
    .filter((row) => {
      return (
        row.eventType === "google-forms-response-submitted" &&
        (row.officialBlueprintKey === null ||
          row.officialIntendedEnabled === false)
      );
    })
    .map((row) => {
      return row.id;
    });
  if (resetForms.length > 0) {
    await db
      .delete(googleFormsAutomationCursors)
      .where(inArray(googleFormsAutomationCursors.automationId, resetForms));
  }
  return disabled.map((row) => {
    return {
      orgId: row.orgId,
      ownerUserId: row.ownerUserId,
      eventType: row.eventType,
      eventConfig: row.eventConfig,
      eventConnectorId: row.eventConnectorId,
    };
  });
}

async function createAutomationChatThread(
  db: ChatThreadEventTransaction,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly title: string;
    readonly currentTime: Date;
    readonly preparation: WorkflowThreadPreparation;
  },
): Promise<string> {
  const pin = args.preparation.initialModel;
  if (!pin.selectedModel) {
    throw new Error("A model selection is required");
  }
  const pinColumns = chatThreadModelPinColumns(pin);
  const thread = await insertChatThread(db, {
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.agentId,
    title: args.title,
    modelSettings: args.preparation.modelSettings,
    cloudBrowserEnabled: args.preparation.cloudBrowserEnabled,
    modelProviderId: pinColumns.modelProviderId,
    modelProviderType: pinColumns.modelProviderType,
    modelProviderCredentialScope: pinColumns.modelProviderCredentialScope,
    selectedModel: pinColumns.selectedModel,
    codexServiceTier:
      pin.serviceTier === "priority"
        ? "fast"
        : pin.serviceTier === "ultrafast"
          ? "ultrafast"
          : null,
    lastMessageAt: args.currentTime,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  });
  if (!thread) {
    throw new Error("Failed to create workflow automation chat thread");
  }
  await appendChatThreadCreatedEvent(db, { orgId: args.orgId, thread });
  return thread.id;
}

/**
 * Upsert this owner's binding through its unique key and return it.
 *
 * `ON CONFLICT DO UPDATE` writes the existing row (a no-op assignment), so the
 * binding is this transaction's until it commits: a concurrent creator waits
 * and then observes the committed destination, and thread deletion's
 * conditional DELETE cannot detach it between this read and the caller's
 * automation INSERT. A binding deleted concurrently is simply inserted anew.
 */
async function claimWorkflowUserAutomationThreadBinding(
  db: ChatThreadEventTransaction,
  args: WorkflowUserAutomationThreadOwner & { readonly currentTime: Date },
): Promise<{ readonly chatThreadId: string | null }> {
  const [binding] = await db
    .insert(workflowUserAutomationThreads)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      workflowId: args.workflowId,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .onConflictDoUpdate({
      target: [
        workflowUserAutomationThreads.orgId,
        workflowUserAutomationThreads.userId,
        workflowUserAutomationThreads.workflowId,
      ],
      set: {
        chatThreadId: sql`${workflowUserAutomationThreads.chatThreadId}`,
      },
    })
    .returning({ chatThreadId: workflowUserAutomationThreads.chatThreadId });
  if (!binding) {
    throw new Error("Failed to claim workflow automation thread binding");
  }
  return binding;
}

/** Publish a new destination only into a binding that still has none. */
async function bindWorkflowUserAutomationThread(
  db: ChatThreadEventTransaction,
  args: WorkflowUserAutomationThreadOwner & { readonly currentTime: Date },
  chatThreadId: string,
): Promise<string> {
  const [updated] = await db
    .update(workflowUserAutomationThreads)
    .set({ chatThreadId, updatedAt: args.currentTime })
    .where(
      and(
        workflowUserAutomationThreadOwnerCondition(args),
        isNull(workflowUserAutomationThreads.chatThreadId),
      ),
    )
    .returning({ chatThreadId: workflowUserAutomationThreads.chatThreadId });
  if (!updated?.chatThreadId) {
    throw new Error("Failed to persist workflow automation chat thread");
  }
  return updated.chatThreadId;
}

export async function ensureWorkflowUserAutomationThread(
  db: ChatThreadEventTransaction,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly agentId: string;
    readonly workflowTitle: string;
    readonly currentTime: Date;
    readonly preparation: WorkflowThreadPreparation;
  },
): Promise<string> {
  const binding = await claimWorkflowUserAutomationThreadBinding(db, args);
  if (binding.chatThreadId) {
    return binding.chatThreadId;
  }

  const title = args.preparation.title;
  const chatThreadId = await createAutomationChatThread(db, {
    userId: args.userId,
    orgId: args.orgId,
    agentId: args.agentId,
    title,
    preparation: args.preparation,
    currentTime: args.currentTime,
  });
  return await bindWorkflowUserAutomationThread(db, args, chatThreadId);
}

interface WorkflowThreadOwner extends WorkflowUserAutomationThreadOwner {
  readonly agentId: string;
  readonly workflowTitle: string;
  readonly currentTime: Date;
}

export function preparedWorkflowThreadValues(
  args: WorkflowThreadOwner,
  preparation: WorkflowThreadPreparation,
  threadId: string,
) {
  const pin = preparation.initialModel;
  if (!pin.selectedModel) {
    throw new Error("A model selection is required");
  }
  return {
    id: threadId,
    userId: args.userId,
    agentId: args.agentId,
    title: preparation.title,
    selectedModel: pin.selectedModel,
    codexServiceTier:
      pin.serviceTier === "priority"
        ? ("fast" as const)
        : pin.serviceTier === "ultrafast"
          ? ("ultrafast" as const)
          : null,
    modelSettings: preparation.modelSettings,
    cloudBrowserEnabled: preparation.cloudBrowserEnabled,
    lastMessageAt: args.currentTime,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  };
}

/** Lazy trigger repair owns its complete binding, thread and event publication. */
export const ensureWorkflowUserAutomationThread$ = command(
  async (
    { set },
    args: WorkflowThreadOwner,
    signal: AbortSignal,
  ): Promise<string> => {
    const preparation = await set(
      prepareWorkflowUserAutomationThread$,
      args,
      signal,
    );
    const db = set(writeDb$);
    const result = await db.transaction(async (tx) => {
      const binding = await claimWorkflowUserAutomationThreadBinding(tx, args);
      if (binding.chatThreadId) {
        return binding.chatThreadId;
      }
      const values = preparedWorkflowThreadValues(
        args,
        preparation,
        randomUUID(),
      );
      await tx.insert(chatThreads).values(values);
      await tx.execute(
        chatThreadEventInsertSql({
          kind: "created",
          orgId: args.orgId,
          userId: args.userId,
          agentId: args.agentId,
          chatThreadId: values.id,
          title: values.title,
          selectedModel: values.selectedModel,
          modelSettings: values.modelSettings,
          cloudBrowserEnabled: values.cloudBrowserEnabled,
          serviceTier: chatThreadServiceTierFromCodex(values.codexServiceTier),
          createdAt: values.createdAt,
        }),
      );
      const chatThreadId = await bindWorkflowUserAutomationThread(
        tx,
        args,
        values.id,
      );
      signal.throwIfAborted();
      return chatThreadId;
    });
    signal.throwIfAborted();
    return result;
  },
);
