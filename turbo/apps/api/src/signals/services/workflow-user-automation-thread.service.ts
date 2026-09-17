import {
  userLocaleSchema,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, inArray, sql } from "drizzle-orm";

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
import { recordOfficialWorkflowThreadProvenance } from "./morning-brief-thread-provenance.service";
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

interface WorkflowUserAutomationThreadOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}

/** The one binding row a workflow's automations share for this owner. */
function workflowUserAutomationThreadOwnerCondition(
  owner: WorkflowUserAutomationThreadOwner,
) {
  return and(
    eq(workflowUserAutomationThreads.orgId, owner.orgId),
    eq(workflowUserAutomationThreads.userId, owner.userId),
    eq(workflowUserAutomationThreads.workflowId, owner.workflowId),
  );
}

/**
 * Read the binding without the lock thread deletion conflicts with.
 *
 * Deletion locks a thread and then every binding pointing at it. A reuse that
 * found its destination under the binding lock could only lock that thread
 * afterwards, which is the opposite order, so the destination is discovered
 * with an ordinary read and revalidated once both locks are held.
 */
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
  // Automation creation locks the same binding before it returns, and only
  // after locking the destination this caller already holds. Taking the binding
  // lock here ensures an automation cannot join this thread between the disable
  // update and the thread delete, without either side waiting on the other's
  // first lock.
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

/**
 * Serialize one owner's binding resolution for the rest of the transaction.
 *
 * The row locks below follow thread deletion's thread → binding order, so the
 * destination must be discovered before the binding row is locked. This key
 * keeps a second resolution from binding a destination inside that window: a
 * thread first seen under the binding lock could only be locked after it, which
 * is the inversion this function exists to prevent. Deletion never takes this
 * key, so it adds no new wait to that path.
 */
async function lockWorkflowUserAutomationThreadResolution(
  db: ChatThreadEventTransaction,
  owner: WorkflowUserAutomationThreadOwner,
): Promise<void> {
  const key = `workflow_user_automation_thread:${owner.orgId}:${owner.userId}:${owner.workflowId}`;
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * Make the binding row exist and report the destination it currently holds.
 *
 * A concurrent creator is waited out by the insert itself, which takes no row
 * lock on the conflicting binding, so the destination it committed is visible
 * to the ordinary read that follows and can still be locked first.
 */
async function discoverWorkflowUserAutomationThreadBinding(
  db: ChatThreadEventTransaction,
  args: WorkflowUserAutomationThreadOwner & { readonly currentTime: Date },
): Promise<string | null> {
  const existing = await readWorkflowUserAutomationThreadBinding(db, args);
  if (existing) {
    return existing.chatThreadId;
  }
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
  const inserted = await readWorkflowUserAutomationThreadBinding(db, args);
  return inserted?.chatThreadId ?? null;
}

/** Lock a discovered destination exactly the way thread deletion locks it. */
async function lockBoundAutomationChatThread(
  db: ChatThreadEventTransaction,
  chatThreadId: string,
): Promise<string | null> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .for("update");
  return thread?.id ?? null;
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
  // Acquire the parent FK locks before the binding and shared event sequence.
  // An existing binding with a deleted thread otherwise postpones the workflow
  // FK lock until an automation is inserted, reversing copy's lock order.
  // Agent first also preserves the order used by agent deletion cascades.
  await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, args.orgId), eq(agents.id, args.agentId)))
    .for("key share");
  await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.id, args.workflowId),
        eq(workflows.agentId, args.agentId),
      ),
    )
    .for("key share");

  await lockWorkflowUserAutomationThreadResolution(db, args);

  const discovered = await discoverWorkflowUserAutomationThreadBinding(
    db,
    args,
  );
  const lockedThreadId =
    discovered === null
      ? null
      : await lockBoundAutomationChatThread(db, discovered);
  // The binding lock still serializes creation; it is now taken after the
  // destination it names, so it can no longer close a cycle with deletion.
  const [binding] = await db
    .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
    .from(workflowUserAutomationThreads)
    .where(workflowUserAutomationThreadOwnerCondition(args))
    .limit(1)
    .for("update");
  if (binding?.chatThreadId) {
    if (binding.chatThreadId !== lockedThreadId) {
      // Only deleting a destination detaches a binding, and that deletion needs
      // the row lock taken above; the resolution key keeps a concurrent rebind
      // out of the window before it. Fail instead of locking out of order.
      throw new Error(
        "Workflow automation chat thread binding changed destination",
      );
    }
    // A reused binding is as much a Morning Brief destination as a fresh one,
    // and this thread may predate the classification column entirely.
    await recordOfficialWorkflowThreadProvenance(db, {
      chatThreadId: binding.chatThreadId,
      userId: args.userId,
      orgId: args.orgId,
      workflowIds: [args.workflowId],
    });
    return binding.chatThreadId;
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
  // An automation thread is not ordinary Chat, so it stays unknown unless this
  // workflow is the official Morning Brief, whose destination is excluded from
  // the moment it exists.
  await recordOfficialWorkflowThreadProvenance(db, {
    chatThreadId,
    userId: args.userId,
    orgId: args.orgId,
    workflowIds: [args.workflowId],
  });

  const [updated] = await db
    .update(workflowUserAutomationThreads)
    .set({ chatThreadId, updatedAt: args.currentTime })
    .where(workflowUserAutomationThreadOwnerCondition(args))
    .returning({ chatThreadId: workflowUserAutomationThreads.chatThreadId });
  if (!updated?.chatThreadId) {
    throw new Error("Failed to persist workflow automation chat thread");
  }
  return updated.chatThreadId;
}
