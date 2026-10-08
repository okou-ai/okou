import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  userLocaleSchema,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, inArray } from "drizzle-orm";

import {
  modelSettingsSchema,
  type ModelSettings,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { writeDb$, type ReadonlyDb } from "../external/db";
import {
  chatThreadCreatedEventSql,
  prepareChatThreadInsert,
  createdChatThreadFromRow,
} from "./chat-thread-create.service";
import {
  chatThreadEventInsertSql,
  chatThreadServiceTierFromCodex,
  type ChatThreadEventTransaction,
} from "./chat-thread-event.service";
import {
  resolveDefaultModelFirstPin$,
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
    const initialModel = await set(
      resolveDefaultModelFirstPin$,
      {
        orgId: args.orgId,
        userId: args.userId,
        orgPlanCapabilities: undefined,
      },
      signal,
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
 * The caller deletes the thread in the same transaction, so the binding still
 * identifies the affected workflows while this update runs.
 */
/** Pure predicate for the deletion owner's conditional automation UPDATE. */
export function threadBoundWorkflowAutomationsPredicate(args: {
  readonly userId: string;
  readonly chatThreadId: string;
}) {
  return and(
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.enabled, true),
    inArray(
      workflowAutomations.workflowId,
      new QueryBuilder()
        .select({ workflowId: workflowUserAutomationThreads.workflowId })
        .from(workflowUserAutomationThreads)
        .where(
          and(
            eq(workflowUserAutomationThreads.userId, args.userId),
            eq(workflowUserAutomationThreads.chatThreadId, args.chatThreadId),
          ),
        ),
    ),
  );
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
  const threadPlan = prepareChatThreadInsert({
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.agentId,
    title: args.title,
    modelSettings: args.preparation.modelSettings,
    cloudBrowserEnabled: args.preparation.cloudBrowserEnabled,
    selectedModel: pin.selectedModel,
    codexServiceTier: pin.serviceTier === "priority" ? "fast" : null,
    lastMessageAt: args.currentTime,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  });
  const [threadRow] = await db
    .with(...threadPlan.defaults)
    .insert(chatThreads)
    .values(threadPlan.values)
    .onConflictDoNothing()
    .returning({
      id: chatThreads.id,
      userId: chatThreads.userId,
      title: chatThreads.title,
      selectedModel: chatThreads.selectedModel,
      modelSettings: chatThreads.modelSettings,
      codexServiceTier: chatThreads.codexServiceTier,
      computerUseHostId: chatThreads.computerUseHostId,
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
      createdAt: chatThreads.createdAt,
    });
  const thread = threadRow
    ? createdChatThreadFromRow(threadRow, threadPlan.values.agentId)
    : undefined;
  if (!thread) {
    throw new Error("Failed to create workflow automation chat thread");
  }
  await db.execute(chatThreadCreatedEventSql({ orgId: args.orgId, thread }));
  return thread.id;
}

/** Insert this owner's binding if missing and return its destination. */
async function upsertWorkflowUserAutomationThreadBinding(
  db: ChatThreadEventTransaction,
  args: WorkflowUserAutomationThreadOwner & { readonly currentTime: Date },
): Promise<{ readonly chatThreadId: string | null }> {
  await db
    .insert(workflowUserAutomationThreads)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      workflowId: args.workflowId,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .onConflictDoNothing({
      target: [
        workflowUserAutomationThreads.orgId,
        workflowUserAutomationThreads.userId,
        workflowUserAutomationThreads.workflowId,
      ],
    });
  const binding = await readWorkflowUserAutomationThreadBinding(db, args);
  return { chatThreadId: binding?.chatThreadId ?? null };
}

async function bindWorkflowUserAutomationThread(
  db: ChatThreadEventTransaction,
  args: WorkflowUserAutomationThreadOwner & { readonly currentTime: Date },
  chatThreadId: string,
): Promise<string> {
  await db
    .update(workflowUserAutomationThreads)
    .set({ chatThreadId, updatedAt: args.currentTime })
    .where(workflowUserAutomationThreadOwnerCondition(args));
  return chatThreadId;
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
  const binding = await upsertWorkflowUserAutomationThreadBinding(db, args);
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
  return {
    id: threadId,
    userId: args.userId,
    agentId: args.agentId,
    title: preparation.title,
    selectedModel: pin.selectedModel,
    codexServiceTier: pin.serviceTier === "priority" ? ("fast" as const) : null,
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
      // The binding, created thread and created event are one publication.
      await tx
        .insert(workflowUserAutomationThreads)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          workflowId: args.workflowId,
          createdAt: args.currentTime,
          updatedAt: args.currentTime,
        })
        .onConflictDoNothing({
          target: [
            workflowUserAutomationThreads.orgId,
            workflowUserAutomationThreads.userId,
            workflowUserAutomationThreads.workflowId,
          ],
        });
      const [binding] = await tx
        .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
        .from(workflowUserAutomationThreads)
        .where(workflowUserAutomationThreadOwnerCondition(args))
        .limit(1);
      if (binding?.chatThreadId) {
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
      await tx
        .update(workflowUserAutomationThreads)
        .set({ chatThreadId: values.id, updatedAt: args.currentTime })
        .where(workflowUserAutomationThreadOwnerCondition(args));
      const chatThreadId = values.id;
      signal.throwIfAborted();
      return chatThreadId;
    });
    signal.throwIfAborted();
    return result;
  },
);
