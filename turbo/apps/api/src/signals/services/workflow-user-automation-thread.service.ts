import {
  userLocaleSchema,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, inArray } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import {
  chatThreadModelPinColumns,
  resolveRequiredDefaultChatThreadModelPin,
} from "./chat-thread-model.service";
import {
  appendChatThreadEvent,
  type ChatThreadEventTransaction,
} from "./chat-thread-event.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";
import {
  readAcceptedOfficialWorkflowDefinition,
  readAcceptedOfficialWorkflowRevision,
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
  },
};

async function loadOfficialWorkflowDisplayName(
  db: ReadonlyDb,
  definitionName: string,
): Promise<string | null> {
  const definition = await readAcceptedOfficialWorkflowDefinition(
    db,
    definitionName,
  );
  if (!definition) {
    return null;
  }
  const revision = await readAcceptedOfficialWorkflowRevision(db, {
    name: definition.name,
    revision: definition.revision,
  });
  return revision?.definition.workflow.displayName ?? null;
}

async function resolveAutomationChatThreadTitle(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly workflowTitle: string;
  },
): Promise<string> {
  const [context] = await db
    .select({
      officialDefinitionName: workflows.officialDefinitionName,
      locale: orgMembersMetadata.locale,
    })
    .from(workflows)
    .leftJoin(
      orgMembersMetadata,
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .where(
      and(eq(workflows.orgId, args.orgId), eq(workflows.id, args.workflowId)),
    )
    .limit(1);
  if (!context?.officialDefinitionName) {
    return args.workflowTitle;
  }

  const locale = userLocaleSchema.parse(context.locale ?? "en-US");
  const localizedTitle =
    OFFICIAL_WORKFLOW_THREAD_TITLES[context.officialDefinitionName]?.[locale];
  if (localizedTitle) {
    return localizedTitle;
  }

  return (
    (await loadOfficialWorkflowDisplayName(
      db,
      context.officialDefinitionName,
    )) ?? args.workflowTitle
  );
}

export async function loadWorkflowUserAutomationThreadId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  const [thread] = await db
    .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
    .from(workflowUserAutomationThreads)
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.workflowId, args.workflowId),
      ),
    )
    .limit(1);
  return thread?.chatThreadId ?? null;
}

/**
 * Pause every enabled automation that shares a workflow-user chat thread.
 * The caller deletes the thread in the same transaction, so the binding still
 * identifies the affected workflows while this update runs.
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
  // Automation creation locks the same binding before it returns. Taking that
  // lock first ensures an automation cannot join this thread between the
  // disable update and the thread delete.
  const bindings = await db
    .select({ workflowId: workflowUserAutomationThreads.workflowId })
    .from(workflowUserAutomationThreads)
    .where(
      and(
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.chatThreadId, args.chatThreadId),
      ),
    )
    .for("update");
  if (bindings.length === 0) {
    return [];
  }

  return await db
    .update(workflowAutomations)
    .set({ enabled: false, nextRunAt: null, updatedAt: args.currentTime })
    .where(
      and(
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.enabled, true),
        inArray(
          workflowAutomations.workflowId,
          bindings.map((binding) => {
            return binding.workflowId;
          }),
        ),
      ),
    )
    .returning({
      orgId: workflowAutomations.orgId,
      ownerUserId: workflowAutomations.ownerUserId,
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
      eventConnectorId: workflowAutomations.eventConnectorId,
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
  },
): Promise<string> {
  const pin = await resolveRequiredDefaultChatThreadModelPin(db, {
    orgId: args.orgId,
    userId: args.userId,
  });
  const mediaModels = await loadNewChatThreadMediaModels(db, {
    orgId: args.orgId,
    userId: args.userId,
  });
  const modelSettings = await loadNewChatThreadModelSettings(db, {
    orgId: args.orgId,
    userId: args.userId,
  });
  const pinColumns = chatThreadModelPinColumns(pin);
  const [thread] = await db
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentId: args.agentId,
      title: args.title,
      modelProviderId: pinColumns.modelProviderId,
      modelProviderType: pinColumns.modelProviderType,
      modelProviderCredentialScope: pinColumns.modelProviderCredentialScope,
      selectedModel: pinColumns.selectedModel,
      modelSettings,
      codexServiceTier: pin.serviceTier === "priority" ? "fast" : null,
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
      selectedVideoModel: mediaModels.selectedVideoModel,
      selectedImageModel: mediaModels.selectedImageModel,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create workflow automation chat thread");
  }
  await appendChatThreadEvent(db, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentId: args.agentId,
    title: args.title,
    selectedModel: pin.selectedModel,
    modelSettings,
    serviceTier: pin.serviceTier,
    ...mediaModels,
    createdAt: thread.createdAt,
  });
  return thread.id;
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
  },
): Promise<string> {
  const [existing] = await db
    .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
    .from(workflowUserAutomationThreads)
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.workflowId, args.workflowId),
      ),
    )
    .limit(1)
    .for("update");
  if (existing?.chatThreadId) {
    return existing.chatThreadId;
  }

  if (!existing) {
    const [inserted] = await db
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
      })
      .returning({ id: workflowUserAutomationThreads.id });
    if (!inserted) {
      const [conflicting] = await db
        .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
        .from(workflowUserAutomationThreads)
        .where(
          and(
            eq(workflowUserAutomationThreads.orgId, args.orgId),
            eq(workflowUserAutomationThreads.userId, args.userId),
            eq(workflowUserAutomationThreads.workflowId, args.workflowId),
          ),
        )
        .limit(1)
        .for("update");
      if (conflicting?.chatThreadId) {
        return conflicting.chatThreadId;
      }
    }
  }

  const title = await resolveAutomationChatThreadTitle(db, {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.workflowId,
    workflowTitle: args.workflowTitle,
  });
  const chatThreadId = await createAutomationChatThread(db, {
    userId: args.userId,
    orgId: args.orgId,
    agentId: args.agentId,
    title,
    currentTime: args.currentTime,
  });

  const [updated] = await db
    .update(workflowUserAutomationThreads)
    .set({ chatThreadId, updatedAt: args.currentTime })
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.workflowId, args.workflowId),
      ),
    )
    .returning({ chatThreadId: workflowUserAutomationThreads.chatThreadId });
  if (!updated?.chatThreadId) {
    throw new Error("Failed to persist workflow automation chat thread");
  }
  return updated.chatThreadId;
}
