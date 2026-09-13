import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
  type WorkflowCreateRequest,
} from "@okouai/api-contracts/contracts/workflows";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { storages } from "@okouai/db/schema/storage";
import {
  workflowUserAutomationThreads,
  workflowAutomations,
  workflowWebhookAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, asc, eq, ne, sql } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishChatThreadWorkflowsChangedSafely } from "../external/realtime";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "../services/api-dispatch-timing.service";
import { autonomyBudgetExhausted, conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import {
  deleteOrphanedWorkflowVolume$,
  deleteWorkflow$,
} from "../services/workflow-delete.service";
import { workflowDetail } from "../services/workflow-detail.service";
import {
  ensureWorkflowUserAutomationThread,
  loadWorkflowUserAutomationThreadId,
} from "../services/workflow-user-automation-thread.service";
import { updateWorkflow$ } from "../services/workflow-update.service";
import { createUserMessageDocument } from "../services/chat-user-message.service";
import { loadWorkflowVolumeFiles } from "../services/workflow-volume.service";
import {
  encryptWorkflowWebhookSecret,
  encryptWorkflowWebhookToken,
  hashWorkflowWebhookToken,
  mintWorkflowWebhookSecret,
  mintWorkflowWebhookToken,
} from "../services/workflow-webhook-automation.service";
import {
  insertWorkflowAutomation,
  workflowAutomationColumns,
} from "../services/autonomy-budget-schema.service";
import {
  childAutonomyBudget,
  loadOwnedRunAutonomyBudget,
} from "../services/autonomy-budget.service";
import { awaitWithSignal, bestEffort, onRejection } from "../utils";
import { reconcileGmailWatchesForUser } from "../services/gmail-automation-event.service";
import { reconcileGoogleCalendarWatchesForUser } from "../services/google-calendar-automation-event.service";
import { lockConnectorAccountTarget } from "../services/auth-state-lock.service";
import { reprojectWorkflowAutomationsForOwner } from "../services/workflow-automation-account-projection.service";
import {
  workflowAutomationAccountConnectorSlug,
  type WorkflowAutomationAccountConnectorSlug,
} from "../services/workflow-automation-account-classification.service";
import { reconcileGoogleFormsWatchesForUser } from "../services/google-forms-automation-event.service";
import { reconcileGoogleMeetSubscriptionsForUser } from "../services/google-meet-automation-event.service";
import {
  loadVisibleWorkflowById,
  requireWorkflowPermission,
  workflowSummary,
  workflowList,
  type WorkflowAgentInfo,
  type WorkflowMember,
  type WorkflowRow,
} from "../services/workflow-data.service";
import type { RouteEntry } from "../route-entry";
import { sendNormalEvent$ } from "../services/chat-events.command";
import type { Tx } from "../../lib/db-types";
import {
  OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK,
  OFFICIAL_WORKFLOW_READ_ONLY_MESSAGE,
} from "../services/official-workflow-constants";
import {
  readAcceptedOfficialWorkflowDefinition,
  readAcceptedOfficialWorkflowRevision,
} from "../services/official-workflow-catalog-read.service";
import { resolveOfficialWorkflowBlueprintForReconciliation } from "../services/official-workflow-installation.service";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import {
  commitPreparedVolumeServerSide,
  ensureVolumeStorage$,
  prepareVolumeServerSideWithDb$,
  prepareVolumeServerSide$,
  type PreparedServerSideVolume,
} from "../services/storage-volume-publication.service";

const workflowReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const workflowWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

function memberFromAuth(auth: {
  readonly userId: string;
  readonly orgRole?: string | null;
}): WorkflowMember {
  return { userId: auth.userId, role: auth.orgRole ?? "member" };
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

function workflowNotFound(workflowId: string) {
  return notFound(`Workflow not found: ${workflowId}`);
}

interface ConfigurableAgent {
  readonly id: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly name: string;
  readonly displayName: string | null;
}

async function loadAgentForConfiguration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly lock?: boolean;
  },
): Promise<ConfigurableAgent | null> {
  const query = db
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(and(eq(agents.orgId, args.orgId), eq(agents.id, args.agentId)))
    .limit(1);
  const [agent] = await (args.lock ? query.for("update") : query);

  return agent ?? null;
}

function requireAgentWritePermission(
  agent: { readonly owner: string; readonly visibility: "public" | "private" },
  member: WorkflowMember,
  action: string,
) {
  return requireAgentPermission(agent.owner, member, action, {
    visibility: agent.visibility,
  });
}

function requireVisibleAgentForPrivateWorkflowCreate(
  agent: { readonly owner: string; readonly visibility: "public" | "private" },
  member: WorkflowMember,
) {
  if (agent.visibility === "public" || agent.owner === member.userId) {
    return null;
  }

  return forbidden(
    "Only the private agent owner can create private workflows on this agent",
  );
}

async function publicWorkflowSlugExists(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly name: string;
    readonly excludeWorkflowId?: string;
  },
): Promise<boolean> {
  const [existing] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.agentId, args.agentId),
        eq(workflows.name, args.name),
        eq(workflows.visibility, "public"),
        args.excludeWorkflowId
          ? ne(workflows.id, args.excludeWorkflowId)
          : undefined,
      ),
    )
    .limit(1);

  return existing !== undefined;
}

function workflowSlugConflict(visibility: "public" | "private", name: string) {
  return conflict(
    visibility === "public"
      ? `A public workflow named "/${name}" already exists on this agent. Rename this workflow or keep it private.`
      : `You already have a private workflow named "/${name}" on this agent. Rename the existing workflow or choose a different name.`,
  );
}

async function requirePublicWorkflowSlugAvailable(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly name: string;
    readonly excludeWorkflowId?: string;
  },
) {
  const exists = await publicWorkflowSlugExists(db, args);
  return exists ? workflowSlugConflict("public", args.name) : null;
}

async function privateWorkflowSlugExists(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly ownerUserId: string;
    readonly name: string;
    readonly excludeWorkflowId?: string;
  },
): Promise<boolean> {
  const [existing] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.agentId, args.agentId),
        eq(workflows.ownerUserId, args.ownerUserId),
        eq(workflows.name, args.name),
        eq(workflows.visibility, "private"),
        args.excludeWorkflowId
          ? ne(workflows.id, args.excludeWorkflowId)
          : undefined,
      ),
    )
    .limit(1);

  return existing !== undefined;
}

async function requirePrivateWorkflowSlugAvailable(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly ownerUserId: string;
    readonly name: string;
    readonly excludeWorkflowId?: string;
  },
) {
  const exists = await privateWorkflowSlugExists(db, args);
  return exists ? workflowSlugConflict("private", args.name) : null;
}

async function requireWorkflowSlugAvailableForVisibility(
  db: Db,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly ownerUserId: string;
    readonly name: string;
    readonly visibility: "public" | "private";
    readonly excludeWorkflowId?: string;
  },
) {
  if (args.visibility === "public") {
    return await requirePublicWorkflowSlugAvailable(db, args);
  }

  return await requirePrivateWorkflowSlugAvailable(db, args);
}

async function loadMatchingWorkflowCreationThreadId(
  db: Db,
  args: {
    readonly userId: string;
    readonly agentId: string;
    readonly chatThreadId: string;
  },
): Promise<string | null> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, args.chatThreadId),
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.agentId, args.agentId),
      ),
    )
    .limit(1)
    .for("update");

  return thread?.id ?? null;
}

async function publishCreatedWorkflow(
  userId: string,
  chatThreadId: string | null,
  signal: AbortSignal,
): Promise<void> {
  if (chatThreadId) {
    await publishChatThreadWorkflowsChangedSafely(userId, chatThreadId);
    signal.throwIfAborted();
  }
}

const createWorkflowBody$ = bodyResultOf(workflowsCollectionContract.create);
const updateWorkflowBody$ = bodyResultOf(workflowsDetailContract.update);
const copyWorkflowBody$ = bodyResultOf(workflowsDetailContract.copy);

const listWorkflowsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(workflowsCollectionContract.list));
  const workflows = await get(
    workflowList({
      orgId: auth.orgId,
      member: memberFromAuth(auth),
      ...(query.agentId ? { agentId: query.agentId } : {}),
    }),
  );
  return { status: 200 as const, body: [...workflows] };
});

interface WorkflowCreationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly body: WorkflowCreateRequest;
  readonly visibility: "public" | "private";
}

async function validateWorkflowCreation(
  db: Db,
  args: WorkflowCreationInput,
  lockAgent: boolean,
  signal: AbortSignal,
) {
  const agent = await loadAgentForConfiguration(db, {
    orgId: args.orgId,
    agentId: args.body.agentId,
    lock: lockAgent,
  });
  signal.throwIfAborted();
  if (!agent) {
    return notFound(`Agent not found: ${args.body.agentId}`);
  }
  const permissionError =
    args.visibility === "public"
      ? requireAgentWritePermission(
          agent,
          args.member,
          "create workflows on this agent",
        )
      : requireVisibleAgentForPrivateWorkflowCreate(agent, args.member);
  if (permissionError) {
    return permissionError;
  }
  const slugError = await requireWorkflowSlugAvailableForVisibility(db, {
    orgId: args.orgId,
    agentId: agent.id,
    ownerUserId: args.member.userId,
    name: args.body.name,
    visibility: args.visibility,
  });
  signal.throwIfAborted();
  return slugError;
}

async function createPreparedWorkflow(
  db: Db,
  args: WorkflowCreationInput & {
    readonly workflowId: string;
    readonly volume: PreparedServerSideVolume;
  },
  signal: AbortSignal,
) {
  return await db.transaction(async (tx) => {
    const error = await validateWorkflowCreation(tx, args, true, signal);
    if (error) {
      return { kind: "error" as const, response: error };
    }

    // Cleanup takes this same lock before checking Workflow absence, so even
    // an uncertain COMMIT cannot let cleanup race a late publication.
    const [storage] = await tx
      .select({ id: storages.id })
      .from(storages)
      .where(eq(storages.id, args.volume.version.storageId))
      .for("update");
    signal.throwIfAborted();
    if (!storage) {
      throw new Error(
        `Prepared workflow storage not found: ${args.workflowId}`,
      );
    }

    const { body, member, visibility } = args;
    const currentTime = nowDate();
    const [workflow] = await tx
      .insert(workflows)
      .values({
        id: args.workflowId,
        orgId: args.orgId,
        agentId: body.agentId,
        name: body.name,
        visibility,
        instruction: body.instruction ?? null,
        ownerUserId: member.userId,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        createdBy: member.userId,
        updatedBy: member.userId,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .onConflictDoNothing()
      .returning({ id: workflows.id });
    signal.throwIfAborted();
    if (!workflow) {
      return {
        kind: "error" as const,
        response: workflowSlugConflict(visibility, body.name),
      };
    }

    const chatThreadId = body.chatThreadId
      ? await loadMatchingWorkflowCreationThreadId(tx, {
          userId: member.userId,
          agentId: body.agentId,
          chatThreadId: body.chatThreadId,
        })
      : null;
    signal.throwIfAborted();
    if (chatThreadId) {
      await tx.insert(workflowUserAutomationThreads).values({
        orgId: args.orgId,
        userId: member.userId,
        workflowId: workflow.id,
        chatThreadId,
        createdAt: currentTime,
        updatedAt: currentTime,
      });
      signal.throwIfAborted();
    }
    await commitPreparedVolumeServerSide(
      { db: tx, volume: args.volume },
      signal,
    );
    return { kind: "created" as const, workflow, chatThreadId };
  });
}

const cleanupUnpublishedWorkflow$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly workflowId: string },
  ): Promise<void> => {
    // Cleanup gets its own bounded lifetime, including when create was aborted.
    // Its failure (including timeout) must never replace the creation error.
    const signal = AbortSignal.timeout(5000);
    const [result] = await Promise.allSettled([
      awaitWithSignal(set(deleteOrphanedWorkflowVolume$, args, signal), signal),
    ]);
    if (result.status === "rejected") {
      logger("WorkflowCreate").warn(
        "Failed to clean up unpublished workflow volume",
        {
          ...args,
          error: result.reason,
        },
      );
    }
  },
);

const prepareAndCreateWorkflow$ = command(
  async ({ set }, args: WorkflowCreationInput, signal: AbortSignal) => {
    const workflowId = randomUUID();
    const cleanup = { orgId: args.orgId, workflowId };
    const result = await onRejection(
      (async () => {
        const volume = await set(
          prepareVolumeServerSide$,
          {
            orgId: args.orgId,
            storageName: getCustomSkillStorageName(workflowId),
            piResourceIndex: true,
            files: [
              {
                path: "SKILL.md",
                content: synthesizeWorkflowSkillMd({
                  name: args.body.name,
                  description: args.body.description ?? null,
                  instruction: args.body.instruction ?? null,
                }),
              },
              ...(args.body.files ?? []),
            ],
          },
          signal,
        );
        const created = await createPreparedWorkflow(
          set(writeDb$),
          { ...args, workflowId, volume },
          signal,
        );
        if (created.kind === "error") {
          await set(cleanupUnpublishedWorkflow$, cleanup);
        }
        return created;
      })(),
      async () => {
        await set(cleanupUnpublishedWorkflow$, cleanup);
      },
    );
    signal.throwIfAborted();
    return result;
  },
);

const createWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const bodyResult = await get(createWorkflowBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.data;
    if (SEED_SKILLS.includes(body.name)) {
      return conflict(
        `Workflow name "${body.name}" conflicts with a built-in workflow`,
      );
    }
    const args = {
      orgId: auth.orgId,
      member,
      body,
      visibility: body.visibility ?? "private",
    };
    const writeDb = set(writeDb$);
    const error = await validateWorkflowCreation(writeDb, args, false, signal);
    if (error) {
      return error;
    }
    const inserted = await set(prepareAndCreateWorkflow$, args, signal);
    // Publication has committed. Notification, response or cancellation failures
    // from this point must leave the valid Workflow and its volume intact.
    signal.throwIfAborted();
    if (inserted.kind === "error") {
      return inserted.response;
    }
    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: inserted.workflow.id,
    });
    signal.throwIfAborted();
    if (!visible) {
      throw new Error(`Created workflow not found: ${inserted.workflow.id}`);
    }
    const summary = workflowSummary({
      workflow: visible.workflow,
      agent: visible.agent,
      member,
    });
    await publishCreatedWorkflow(auth.userId, inserted.chatThreadId, signal);
    return { status: 201 as const, body: summary };
  },
);

const getWorkflowDetailInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(workflowsDetailContract.get));
  const result = await get(
    workflowDetail({
      orgId: auth.orgId,
      member: memberFromAuth(auth),
      workflowId: params.workflowId,
    }),
  );
  if (!result) {
    return workflowNotFound(params.workflowId);
  }
  return { status: 200 as const, body: result };
});

const updateWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(workflowsDetailContract.update));
    const bodyResult = await get(updateWorkflowBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const writeDb = set(writeDb$);
    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    });
    signal.throwIfAborted();
    if (!visible) {
      return workflowNotFound(params.workflowId);
    }
    if (visible.workflow.officialDefinitionName !== null) {
      return conflict(OFFICIAL_WORKFLOW_READ_ONLY_MESSAGE);
    }

    const permissionError = requireWorkflowPermission(
      visible.workflow,
      visible.agent,
      member,
      "update workflow",
    );
    if (permissionError) {
      return permissionError;
    }

    if (
      bodyResult.data.name !== undefined &&
      bodyResult.data.name !== visible.workflow.name
    ) {
      if (SEED_SKILLS.includes(bodyResult.data.name)) {
        return conflict(
          `Workflow name "${bodyResult.data.name}" conflicts with a built-in workflow`,
        );
      }

      const slugConflict = await requireWorkflowSlugAvailableForVisibility(
        writeDb,
        {
          orgId: auth.orgId,
          agentId: visible.workflow.agentId,
          ownerUserId: visible.workflow.ownerUserId,
          name: bodyResult.data.name,
          visibility: visible.workflow.visibility,
          excludeWorkflowId: visible.workflow.id,
        },
      );
      signal.throwIfAborted();
      if (slugConflict) {
        return slugConflict;
      }
    }

    await set(
      updateWorkflow$,
      {
        workflow: visible.workflow,
        body: bodyResult.data,
        updatedByUserId: auth.userId,
      },
      signal,
    );
    signal.throwIfAborted();

    const detail = await get(
      workflowDetail({
        orgId: auth.orgId,
        member,
        workflowId: params.workflowId,
      }),
    );
    signal.throwIfAborted();
    if (!detail) {
      return workflowNotFound(params.workflowId);
    }
    return { status: 200 as const, body: detail };
  },
);

const deleteWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(workflowsDetailContract.delete));

    const writeDb = set(writeDb$);
    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    });
    signal.throwIfAborted();
    if (!visible) {
      return workflowNotFound(params.workflowId);
    }
    if (visible.workflow.officialDefinitionName !== null) {
      return conflict(
        "Uninstall Official Workflows through the Official installation endpoint",
      );
    }

    const permissionError = requireWorkflowPermission(
      visible.workflow,
      visible.agent,
      member,
      "delete workflow",
    );
    if (permissionError) {
      return permissionError;
    }

    const deleted = await set(
      deleteWorkflow$,
      { orgId: auth.orgId, workflowId: params.workflowId },
      signal,
    );
    signal.throwIfAborted();

    if (!deleted) {
      return workflowNotFound(params.workflowId);
    }

    return { status: 204 as const, body: undefined };
  },
);

type WorkflowCopyTransaction = Tx;

interface CopyWorkflowRuntimeArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly sourceWorkflow: WorkflowRow;
  readonly targetAgentId: string;
  readonly targetWorkflowId: string;
  readonly currentTime: Date;
  readonly inheritedAutonomyBudget?: number;
  readonly sourceAutomations?: readonly (typeof workflowAutomations.$inferSelect)[];
}

interface CopyWorkflowScopedRowsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly sourceWorkflowId: string;
  readonly targetWorkflowId: string;
  readonly currentTime: Date;
  readonly inheritedAutonomyBudget?: number;
}

interface CopyWorkflowAutomationRowsArgs extends CopyWorkflowScopedRowsArgs {
  readonly targetAgentId: string;
  readonly workflowTitle: string;
  readonly sourceAutomations?: readonly (typeof workflowAutomations.$inferSelect)[];
}

interface OfficialCopyMaterialization {
  readonly sourceWorkflow: WorkflowRow;
  readonly sourceAutomations: readonly (typeof workflowAutomations.$inferSelect)[];
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

type OfficialCopyResolution =
  | {
      readonly kind: "ok";
      readonly materialization: OfficialCopyMaterialization;
    }
  | { readonly kind: "conflict"; readonly message: string };

const OFFICIAL_COPY_RECONFIGURE_MESSAGE =
  "Official Workflow cannot be copied from mixed or stale state; Reconfigure it and retry";

async function resolveOfficialCopyMaterialization(
  tx: WorkflowCopyTransaction,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly sourceWorkflow: WorkflowRow;
  },
): Promise<OfficialCopyResolution> {
  const definitionName = args.sourceWorkflow.officialDefinitionName;
  if (!definitionName) {
    throw new Error(
      "Official copy materialization requires an Official source",
    );
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtext(${OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK}))`,
  );
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${args.orgId}))`);

  const [sourceWorkflow] = await tx
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, args.sourceWorkflow.id),
        eq(workflows.orgId, args.orgId),
        eq(workflows.ownerUserId, args.userId),
        eq(workflows.officialDefinitionName, definitionName),
        eq(workflows.officialInstallationState, "installed"),
      ),
    )
    .for("update")
    .limit(1);
  if (!sourceWorkflow) {
    return { kind: "conflict", message: OFFICIAL_COPY_RECONFIGURE_MESSAGE };
  }

  const definition = await readAcceptedOfficialWorkflowDefinition(
    tx,
    definitionName,
  );
  if (!definition) {
    return { kind: "conflict", message: OFFICIAL_COPY_RECONFIGURE_MESSAGE };
  }
  const revision = await readAcceptedOfficialWorkflowRevision(tx, {
    name: definition.name,
    revision: definition.revision,
  });
  if (!revision) {
    return { kind: "conflict", message: OFFICIAL_COPY_RECONFIGURE_MESSAGE };
  }
  const rows = await tx
    .select(workflowAutomationColumns())
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.workflowId, sourceWorkflow.id),
      ),
    )
    .orderBy(asc(workflowAutomations.officialBlueprintKey))
    .for("update");
  if (rows.length !== revision.definition.blueprints.length) {
    return { kind: "conflict", message: OFFICIAL_COPY_RECONFIGURE_MESSAGE };
  }
  const rowsByBlueprint = new Map(
    rows.map((row) => {
      return [row.officialBlueprintKey, row] as const;
    }),
  );
  const sourceAutomations: (typeof workflowAutomations.$inferSelect)[] = [];
  for (const blueprint of revision.definition.blueprints) {
    const row = rowsByBlueprint.get(blueprint.key);
    if (
      !row ||
      row.officialAppliedFingerprint !== blueprint.fingerprint ||
      row.officialReconciliationStatus !== "current" ||
      row.officialParameterBindings === null
    ) {
      return { kind: "conflict", message: OFFICIAL_COPY_RECONFIGURE_MESSAGE };
    }
    const resolved = resolveOfficialWorkflowBlueprintForReconciliation(
      blueprint,
      row.officialParameterBindings,
      [],
      row.timezone,
    );
    if (!resolved.ok) {
      return { kind: "conflict", message: OFFICIAL_COPY_RECONFIGURE_MESSAGE };
    }
    sourceAutomations.push(row);
  }
  return {
    kind: "ok",
    materialization: {
      sourceWorkflow: {
        ...sourceWorkflow,
        instruction: revision.definition.workflow.instruction,
        displayName: revision.definition.workflow.displayName,
        description: revision.definition.workflow.description,
        officialDefinitionName: null,
        officialInstallationState: null,
      },
      sourceAutomations,
      files: revision.definition.workflow.files,
    },
  };
}

async function insertCopiedWorkflowRow(
  tx: WorkflowCopyTransaction,
  args: CopyWorkflowRuntimeArgs,
): Promise<{ readonly id: string } | undefined> {
  const [workflow] = await tx
    .insert(workflows)
    .values({
      id: args.targetWorkflowId,
      orgId: args.orgId,
      agentId: args.targetAgentId,
      name: args.sourceWorkflow.name,
      visibility: "private",
      instruction: args.sourceWorkflow.instruction,
      ownerUserId: args.userId,
      displayName: args.sourceWorkflow.displayName,
      description: args.sourceWorkflow.description,
      createdBy: args.userId,
      updatedBy: args.userId,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .returning({ id: workflows.id });
  return workflow;
}

async function copyWorkflowWebhookAutomationConfig(
  tx: WorkflowCopyTransaction,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly sourceAutomationId: string;
    readonly targetAutomationId: string;
    readonly currentTime: Date;
  },
): Promise<void> {
  const [sourceWebhook] = await tx
    .select({
      encryptedSecret: workflowWebhookAutomations.encryptedSecret,
      secretLastFour: workflowWebhookAutomations.secretLastFour,
    })
    .from(workflowWebhookAutomations)
    .where(eq(workflowWebhookAutomations.automationId, args.sourceAutomationId))
    .limit(1);
  const token = mintWorkflowWebhookToken();
  let encryptedSecret: string;
  let secretLastFour: string;
  if (sourceWebhook) {
    encryptedSecret = sourceWebhook.encryptedSecret;
    secretLastFour = sourceWebhook.secretLastFour;
  } else {
    const secret = mintWorkflowWebhookSecret();
    encryptedSecret = await encryptWorkflowWebhookSecret(secret, {
      orgId: args.orgId,
      userId: args.userId,
    });
    secretLastFour = secret.slice(-4);
  }

  await tx.insert(workflowWebhookAutomations).values({
    automationId: args.targetAutomationId,
    tokenHash: hashWorkflowWebhookToken(token),
    encryptedToken: await encryptWorkflowWebhookToken(token, {
      orgId: args.orgId,
      userId: args.userId,
    }),
    encryptedSecret,
    secretLastFour,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  });
}

async function copyWorkflowAutomationRow(
  tx: WorkflowCopyTransaction,
  args: CopyWorkflowScopedRowsArgs & {
    readonly automation: typeof workflowAutomations.$inferSelect;
  },
): Promise<void> {
  const copiedAutomation = await insertWorkflowAutomation(tx, {
    orgId: args.orgId,
    workflowId: args.targetWorkflowId,
    ownerUserId: args.userId,
    kind: args.automation.kind,
    eventType: args.automation.eventType,
    eventConfig: args.automation.eventConfig,
    scheduleType: args.automation.scheduleType,
    cronExpression: args.automation.cronExpression,
    intervalSeconds: args.automation.intervalSeconds,
    atTime: args.automation.atTime,
    timezone: args.automation.timezone,
    enabled: args.automation.enabled,
    nextRunAt: args.automation.nextRunAt,
    lastRunAt: null,
    lastRunId: null,
    consecutiveFailures: 0,
    autonomyBudget:
      args.inheritedAutonomyBudget ?? args.automation.autonomyBudget,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  });
  if (!copiedAutomation) {
    throw new Error("Failed to copy workflow automation");
  }

  if (
    args.automation.kind === "event" &&
    args.automation.eventType === "webhook-received"
  ) {
    await copyWorkflowWebhookAutomationConfig(tx, {
      orgId: args.orgId,
      userId: args.userId,
      sourceAutomationId: args.automation.id,
      targetAutomationId: copiedAutomation.id,
      currentTime: args.currentTime,
    });
  }
}

async function copyWorkflowUserAutomations(
  tx: WorkflowCopyTransaction,
  args: CopyWorkflowAutomationRowsArgs,
): Promise<{
  readonly accountConnectorSlugs: readonly WorkflowAutomationAccountConnectorSlug[];
}> {
  const rows =
    args.sourceAutomations ??
    (await tx
      .select(workflowAutomationColumns())
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.ownerUserId, args.userId),
          eq(workflowAutomations.workflowId, args.sourceWorkflowId),
        ),
      ));
  if (rows.length === 0) {
    return { accountConnectorSlugs: [] };
  }
  const accountConnectorSlugs = [
    ...new Set(
      rows
        .map((automation) => {
          return workflowAutomationAccountConnectorSlug(automation.eventType);
        })
        .filter(
          (
            connectorSlug,
          ): connectorSlug is WorkflowAutomationAccountConnectorSlug => {
            return connectorSlug !== null;
          },
        ),
    ),
  ].sort();
  for (const connectorSlug of accountConnectorSlugs) {
    await lockConnectorAccountTarget(tx, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "builtin", connectorSlug },
    });
  }

  if (
    rows.some((automation) => {
      return automation.kind === "event";
    })
  ) {
    await ensureWorkflowUserAutomationThread(tx, {
      orgId: args.orgId,
      userId: args.userId,
      workflowId: args.targetWorkflowId,
      agentId: args.targetAgentId,
      workflowTitle: args.workflowTitle,
      currentTime: args.currentTime,
    });
  }
  for (const automation of rows) {
    await copyWorkflowAutomationRow(tx, { ...args, automation });
  }
  return { accountConnectorSlugs };
}

async function copyWorkflowRuntimeConfiguration(
  tx: WorkflowCopyTransaction,
  args: CopyWorkflowRuntimeArgs,
): Promise<
  | {
      readonly workflow: { readonly id: string };
      readonly accountConnectorSlugs: readonly WorkflowAutomationAccountConnectorSlug[];
    }
  | undefined
> {
  const workflow = await insertCopiedWorkflowRow(tx, args);
  if (!workflow) {
    return undefined;
  }

  const scopedRowsArgs = {
    orgId: args.orgId,
    userId: args.userId,
    sourceWorkflowId: args.sourceWorkflow.id,
    targetWorkflowId: workflow.id,
    currentTime: args.currentTime,
    ...(args.inheritedAutonomyBudget === undefined
      ? {}
      : { inheritedAutonomyBudget: args.inheritedAutonomyBudget }),
  };
  const automationProviders = await copyWorkflowUserAutomations(tx, {
    ...scopedRowsArgs,
    targetAgentId: args.targetAgentId,
    workflowTitle: args.sourceWorkflow.displayName ?? args.sourceWorkflow.name,
    ...(args.sourceAutomations
      ? { sourceAutomations: args.sourceAutomations }
      : {}),
  });
  return { workflow, ...automationProviders };
}

type CopyWorkflowDatabaseResult =
  | { readonly kind: "conflict"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly inserted: { readonly id: string };
      readonly accountConnectorSlugs: readonly WorkflowAutomationAccountConnectorSlug[];
    };

async function copyWorkflowDatabaseRows(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly sourceWorkflow: WorkflowRow;
    readonly targetAgentId: string;
    readonly targetWorkflowId: string;
    readonly currentTime: Date;
    readonly inheritedAutonomyBudget: number | undefined;
    readonly sourceFiles:
      | readonly {
          readonly path: string;
          readonly content: string;
        }[]
      | null;
    readonly publishVolume: (
      tx: WorkflowCopyTransaction,
      sourceWorkflow: WorkflowRow,
      sourceFiles:
        | readonly {
            readonly path: string;
            readonly content: string;
          }[]
        | null,
    ) => Promise<void>;
  },
  signal: AbortSignal,
): Promise<CopyWorkflowDatabaseResult> {
  return await db.transaction(async (tx) => {
    const officialResolution = args.sourceWorkflow.officialDefinitionName
      ? await resolveOfficialCopyMaterialization(tx, {
          orgId: args.orgId,
          userId: args.userId,
          sourceWorkflow: args.sourceWorkflow,
        })
      : null;
    if (officialResolution?.kind === "conflict") {
      return officialResolution;
    }
    const materialization = officialResolution?.materialization;
    const sourceWorkflow =
      materialization?.sourceWorkflow ?? args.sourceWorkflow;
    const inserted = await copyWorkflowRuntimeConfiguration(tx, {
      orgId: args.orgId,
      userId: args.userId,
      sourceWorkflow,
      targetAgentId: args.targetAgentId,
      targetWorkflowId: args.targetWorkflowId,
      currentTime: args.currentTime,
      ...(materialization
        ? { sourceAutomations: materialization.sourceAutomations }
        : {}),
      ...(args.inheritedAutonomyBudget === undefined
        ? {}
        : { inheritedAutonomyBudget: args.inheritedAutonomyBudget }),
    });
    if (!inserted) {
      throw new Error("Failed to copy workflow");
    }
    for (const connectorSlug of inserted.accountConnectorSlugs) {
      await reprojectWorkflowAutomationsForOwner(
        tx,
        {
          orgId: args.orgId,
          userId: args.userId,
          target: { kind: "builtin", connectorSlug },
        },
        signal,
      );
    }
    await args.publishVolume(
      tx,
      sourceWorkflow,
      materialization?.files ?? args.sourceFiles,
    );
    return {
      kind: "ok",
      inserted: inserted.workflow,
      accountConnectorSlugs: inserted.accountConnectorSlugs,
    };
  });
}

function copiedWorkflowVolumeFiles(
  sourceWorkflow: Pick<WorkflowRow, "name" | "description" | "instruction">,
  sourceFiles:
    | readonly { readonly path: string; readonly content: string }[]
    | null,
) {
  const skillMd = synthesizeWorkflowSkillMd({
    name: sourceWorkflow.name,
    description: sourceWorkflow.description,
    instruction: sourceWorkflow.instruction,
  });
  const attachedFiles = (sourceFiles ?? [])
    .filter((file) => {
      return file.path !== "SKILL.md";
    })
    .map((file) => {
      return { path: file.path, content: file.content };
    });
  return [{ path: "SKILL.md", content: skillMd }, ...attachedFiles];
}

async function reconcileCopiedWorkflowAutomationWatches(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly copied: Extract<CopyWorkflowDatabaseResult, { kind: "ok" }>;
  },
  signal: AbortSignal,
): Promise<void> {
  const owner = { db: args.db, orgId: args.orgId, userId: args.userId };
  if (args.copied.accountConnectorSlugs.includes("gmail")) {
    await bestEffort(reconcileGmailWatchesForUser(owner, signal), signal);
  }
  if (args.copied.accountConnectorSlugs.includes("google-calendar")) {
    await bestEffort(
      reconcileGoogleCalendarWatchesForUser(owner, signal),
      signal,
    );
  }
  if (args.copied.accountConnectorSlugs.includes("google-forms")) {
    await bestEffort(reconcileGoogleFormsWatchesForUser(owner, signal), signal);
  }
  if (args.copied.accountConnectorSlugs.includes("google-meet")) {
    await bestEffort(
      reconcileGoogleMeetSubscriptionsForUser(owner, signal),
      signal,
    );
  }
}

const publishCopiedWorkflow$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly orgId: string;
      readonly userId: string;
      readonly member: WorkflowMember;
      readonly sourceWorkflow: WorkflowRow;
      readonly sourceFiles:
        | readonly { readonly path: string; readonly content: string }[]
        | null;
      readonly targetAgentId: string;
      readonly inheritedAutonomyBudget: number | undefined;
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ) => {
    // Reserve the target volume identity first, then keep the exact-source
    // locks, new Workflow, final Automation states, and volume HEAD in one
    // transaction. The Workflow and its runnable Automations therefore become
    // visible only after the prepared S3 objects are durable.
    const targetWorkflowId = randomUUID();
    const cleanupSignal = new AbortController().signal;
    return await onRejection(
      (async () => {
        await set(
          ensureVolumeStorage$,
          {
            orgId: args.orgId,
            storageName: getCustomSkillStorageName(targetWorkflowId),
          },
          signal,
        );
        signal.throwIfAborted();

        const copied = await copyWorkflowDatabaseRows(
          args.db,
          {
            orgId: args.orgId,
            userId: args.userId,
            sourceWorkflow: args.sourceWorkflow,
            sourceFiles: args.sourceFiles,
            targetAgentId: args.targetAgentId,
            targetWorkflowId,
            currentTime: args.currentTime,
            inheritedAutonomyBudget: args.inheritedAutonomyBudget,
            publishVolume: async (
              tx,
              copiedSourceWorkflow,
              copiedSourceFiles,
            ) => {
              const volume = await set(
                prepareVolumeServerSideWithDb$,
                {
                  db: tx,
                  input: {
                    orgId: args.orgId,
                    storageName: getCustomSkillStorageName(targetWorkflowId),
                    piResourceIndex: true,
                    files: copiedWorkflowVolumeFiles(
                      copiedSourceWorkflow,
                      copiedSourceFiles,
                    ),
                  },
                },
                signal,
              );
              await commitPreparedVolumeServerSide({ db: tx, volume }, signal);
              signal.throwIfAborted();
            },
          },
          signal,
        );
        signal.throwIfAborted();
        if (copied.kind === "conflict") {
          await set(
            deleteOrphanedWorkflowVolume$,
            { orgId: args.orgId, workflowId: targetWorkflowId },
            cleanupSignal,
          );
          return conflict(copied.message);
        }
        await reconcileCopiedWorkflowAutomationWatches(
          {
            db: args.db,
            orgId: args.orgId,
            userId: args.userId,
            copied,
          },
          signal,
        );

        const visible = await loadVisibleWorkflowById(args.db, {
          orgId: args.orgId,
          member: args.member,
          workflowId: targetWorkflowId,
        });
        signal.throwIfAborted();
        if (!visible) {
          throw new Error(`Copied workflow not found: ${targetWorkflowId}`);
        }
        return {
          status: 201 as const,
          body: workflowSummary({
            workflow: visible.workflow,
            agent: visible.agent,
            member: args.member,
          }),
        };
      })(),
      async () => {
        await set(
          deleteWorkflow$,
          { orgId: args.orgId, workflowId: targetWorkflowId },
          cleanupSignal,
        );
        await set(
          deleteOrphanedWorkflowVolume$,
          { orgId: args.orgId, workflowId: targetWorkflowId },
          cleanupSignal,
        );
      },
    );
  },
);

const copyWorkflowInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(workflowsDetailContract.copy));
    const bodyResult = await get(copyWorkflowBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const writeDb = set(writeDb$);
    let inheritedAutonomyBudget: number | undefined;
    if (auth.tokenType === "agent") {
      const sourceAutonomyBudget = await loadOwnedRunAutonomyBudget(writeDb, {
        runId: auth.runId,
        orgId: auth.orgId,
        userId: auth.userId,
      });
      signal.throwIfAborted();
      if (sourceAutonomyBudget === null) {
        return notFound("Source run not found");
      }
      const derived = childAutonomyBudget(sourceAutonomyBudget);
      if (derived.kind === "exhausted") {
        return autonomyBudgetExhausted();
      }
      inheritedAutonomyBudget = derived.autonomyBudget;
    }
    const source = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    });
    signal.throwIfAborted();
    if (!source) {
      return workflowNotFound(params.workflowId);
    }
    const targetAgent = await loadAgentForConfiguration(writeDb, {
      orgId: auth.orgId,
      agentId: bodyResult.data.toAgentId,
    });
    signal.throwIfAborted();
    if (!targetAgent) {
      return notFound(`Agent not found: ${bodyResult.data.toAgentId}`);
    }

    const permissionError = requireAgentWritePermission(
      targetAgent,
      member,
      "copy workflows onto this agent",
    );
    if (permissionError) {
      return permissionError;
    }

    const slugError = await requirePrivateWorkflowSlugAvailable(writeDb, {
      orgId: auth.orgId,
      agentId: targetAgent.id,
      ownerUserId: auth.userId,
      name: source.workflow.name,
    });
    signal.throwIfAborted();
    if (slugError) {
      return slugError;
    }

    const sourceFiles =
      source.workflow.officialDefinitionName === null
        ? await get(
            loadWorkflowVolumeFiles({
              orgId: auth.orgId,
              workflowId: source.workflow.id,
            }),
          )
        : null;
    signal.throwIfAborted();

    // A copy is a fork owned by the caller: a new private workflow under the
    // target agent. User-scoped runtime configuration is cloned only for the
    // caller so copies do not leak another user's automations.
    return await set(
      publishCopiedWorkflow$,
      {
        db: writeDb,
        orgId: auth.orgId,
        userId: auth.userId,
        member,
        sourceWorkflow: source.workflow,
        sourceFiles,
        targetAgentId: targetAgent.id,
        inheritedAutonomyBudget,
        currentTime: nowDate(),
      },
      signal,
    );
  },
);

function workflowSlashPrompt(workflow: Pick<WorkflowRow, "name">): string {
  return `/${workflow.name}`;
}

function workflowRefinePrompt(workflow: Pick<WorkflowRow, "name">): string {
  return `help me refine the workflow ${workflowSlashPrompt(workflow)}`;
}

const prepareWorkflowChatThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = memberFromAuth(auth);
    const params = get(pathParamsOf(workflowsDetailContract.chatThread));

    const writeDb = set(writeDb$);
    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    });
    signal.throwIfAborted();
    if (!visible) {
      return workflowNotFound(params.workflowId);
    }
    const { workflow, agent } = visible;
    if (workflow.officialDefinitionName !== null) {
      return conflict(OFFICIAL_WORKFLOW_READ_ONLY_MESSAGE);
    }

    if (agent.visibility === "private" && agent.owner !== auth.userId) {
      return forbidden("Only the private agent owner can chat with this agent");
    }

    const currentTime = nowDate();
    const chatThreadId = await writeDb.transaction(async (tx) => {
      return await ensureWorkflowUserAutomationThread(tx, {
        orgId: auth.orgId,
        userId: auth.userId,
        workflowId: workflow.id,
        agentId: agent.id,
        workflowTitle: workflow.displayName ?? workflow.name,
        currentTime,
      });
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        chatThreadId,
        prompt: workflowRefinePrompt(workflow),
      },
    };
  },
);

const runWorkflowInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = memberFromAuth(auth);
  const params = get(pathParamsOf(workflowsDetailContract.run));

  const writeDb = set(writeDb$);
  const visible = await loadVisibleWorkflowById(writeDb, {
    orgId: auth.orgId,
    member,
    workflowId: params.workflowId,
  });
  signal.throwIfAborted();
  if (!visible) {
    return workflowNotFound(params.workflowId);
  }
  const { workflow, agent } = visible;
  // The workflow is run on its owning agent; the caller must be able to run
  // that agent (public agents are runnable by any member, private ones only by
  // their owner).
  if (agent.visibility === "private" && agent.owner !== auth.userId) {
    return forbidden("Only the private agent owner can run this agent");
  }

  const currentTime = nowDate();
  const apiStartTime = currentTime.getTime();
  const timing = new ApiDispatchTimingCollector();
  const mappedChatThreadId = await measureApiDispatchTiming(
    timing,
    "api_dispatch_pre_create_agent_workflow_slash_load_thread_mapping",
    "nested",
    async () => {
      return await loadWorkflowUserAutomationThreadId(writeDb, {
        orgId: auth.orgId,
        userId: auth.userId,
        workflowId: workflow.id,
      });
    },
  );
  signal.throwIfAborted();
  const chatThreadId =
    mappedChatThreadId ??
    (await measureApiDispatchTiming(
      timing,
      "api_dispatch_pre_create_agent_workflow_slash_ensure_thread",
      "nested",
      async () => {
        return await writeDb.transaction(async (tx) => {
          return await ensureWorkflowUserAutomationThread(tx, {
            orgId: auth.orgId,
            userId: auth.userId,
            workflowId: workflow.id,
            agentId: agent.id,
            workflowTitle: workflow.displayName ?? workflow.name,
            currentTime,
          });
        });
      },
    ));
  signal.throwIfAborted();

  // Invoking a workflow is exactly typing its slash command in chat.
  const prompt = workflowSlashPrompt(workflow);
  const body = {
    prompt,
    userMessage: createUserMessageDocument({ text: prompt }),
    hasTextContent: true,
    agentId: agent.id,
    threadId: chatThreadId,
  };
  timing.recordElapsed(
    "api_dispatch_pre_create_agent_workflow_slash_prepare_normal_send",
    "nested",
    apiStartTime,
  );
  const result = await set(
    sendNormalEvent$,
    {
      auth,
      body,
      userId: auth.userId,
      orgId: auth.orgId,
      apiStartTime,
      publicBrand: PUBLIC_BRAND,
      preloadedAgent: agent,
      timing,
      agentRunPreCreateSource: "workflow_slash_command",
      ...(workflow.officialDefinitionName === null
        ? {}
        : { requiredOfficialWorkflowIds: [workflow.id] }),
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status !== 201) {
    return result;
  }

  return {
    status: 200 as const,
    body: { chatThreadId: result.body.threadId, runId: result.body.runId },
  };
});

interface VisibilityTransition {
  readonly workflow: WorkflowRow;
  readonly agent: WorkflowAgentInfo;
  readonly member: WorkflowMember;
}

async function applyVisibilityUpdate(
  db: Db,
  args: {
    readonly workflowId: string;
    readonly updatedByUserId: string;
    readonly patch: {
      readonly visibility?: "public" | "private";
    };
  },
): Promise<void> {
  await db
    .update(workflows)
    .set({
      ...args.patch,
      updatedBy: args.updatedByUserId,
      updatedAt: nowDate(),
    })
    .where(eq(workflows.id, args.workflowId));
}

function summaryFrom(
  args: VisibilityTransition,
  patch: {
    readonly visibility?: "public" | "private";
  },
) {
  const updatedWorkflow: WorkflowRow = {
    ...args.workflow,
    ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
  };
  return workflowSummary({
    workflow: updatedWorkflow,
    agent: args.agent,
    member: args.member,
  });
}

type NotFoundResponse = ReturnType<typeof notFound>;

async function loadVisibilityTransition(
  db: Db,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly workflowId: string;
  },
): Promise<VisibilityTransition | NotFoundResponse> {
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: args.workflowId,
  });
  if (!visible) {
    return workflowNotFound(args.workflowId);
  }
  return { ...visible, member: args.member };
}

const publishInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = memberFromAuth(auth);
  const params = get(pathParamsOf(workflowVisibilityContract.publish));

  const writeDb = set(writeDb$);
  const loaded = await loadVisibilityTransition(writeDb, {
    orgId: auth.orgId,
    member,
    workflowId: params.workflowId,
  });
  signal.throwIfAborted();
  if ("status" in loaded) {
    return loaded;
  }
  const { workflow, agent } = loaded;
  if (workflow.officialDefinitionName !== null) {
    return conflict(OFFICIAL_WORKFLOW_READ_ONLY_MESSAGE);
  }

  if (workflow.ownerUserId !== member.userId) {
    return forbidden("Only the workflow owner can publish this workflow");
  }
  if (workflow.visibility === "public") {
    return { status: 200 as const, body: summaryFrom(loaded, {}) };
  }

  const publishError = requireAgentWritePermission(agent, member, "publish");
  if (publishError) {
    return publishError;
  }

  const slugError = await requirePublicWorkflowSlugAvailable(writeDb, {
    orgId: auth.orgId,
    agentId: workflow.agentId,
    name: workflow.name,
    excludeWorkflowId: workflow.id,
  });
  signal.throwIfAborted();
  if (slugError) {
    return slugError;
  }

  await applyVisibilityUpdate(writeDb, {
    workflowId: workflow.id,
    updatedByUserId: auth.userId,
    patch: {
      visibility: "public",
    },
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: summaryFrom(loaded, {
      visibility: "public",
    }),
  };
});

const demoteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = memberFromAuth(auth);
  const params = get(pathParamsOf(workflowVisibilityContract.demote));

  const writeDb = set(writeDb$);
  const loaded = await loadVisibilityTransition(writeDb, {
    orgId: auth.orgId,
    member,
    workflowId: params.workflowId,
  });
  signal.throwIfAborted();
  if ("status" in loaded) {
    return loaded;
  }
  if (loaded.workflow.officialDefinitionName !== null) {
    return conflict(OFFICIAL_WORKFLOW_READ_ONLY_MESSAGE);
  }
  const reviewError = requireAgentWritePermission(
    loaded.agent,
    member,
    "demote public workflows",
  );
  if (reviewError) {
    return reviewError;
  }

  const slugError = await requirePrivateWorkflowSlugAvailable(writeDb, {
    orgId: auth.orgId,
    agentId: loaded.workflow.agentId,
    ownerUserId: loaded.workflow.ownerUserId,
    name: loaded.workflow.name,
  });
  signal.throwIfAborted();
  if (slugError) {
    return slugError;
  }

  await applyVisibilityUpdate(writeDb, {
    workflowId: loaded.workflow.id,
    updatedByUserId: auth.userId,
    patch: {
      visibility: "private",
    },
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: summaryFrom(loaded, {
      visibility: "private",
    }),
  };
});

export const workflowsRoutes: readonly RouteEntry[] = [
  {
    route: workflowsCollectionContract.list,
    handler: authRoute(workflowReadAuth, listWorkflowsInner$),
  },
  {
    route: workflowsCollectionContract.create,
    handler: authRoute(workflowWriteAuth, createWorkflowInner$),
  },
  {
    route: workflowsDetailContract.get,
    handler: authRoute(workflowReadAuth, getWorkflowDetailInner$),
  },
  {
    route: workflowsDetailContract.update,
    handler: authRoute(workflowWriteAuth, updateWorkflowInner$),
  },
  {
    route: workflowsDetailContract.delete,
    handler: authRoute(workflowWriteAuth, deleteWorkflowInner$),
  },
  {
    route: workflowsDetailContract.copy,
    handler: authRoute(workflowWriteAuth, copyWorkflowInner$),
  },
  {
    route: workflowsDetailContract.chatThread,
    handler: authRoute(workflowReadAuth, prepareWorkflowChatThreadInner$),
  },
  {
    route: workflowsDetailContract.run,
    handler: authRoute(workflowWriteAuth, runWorkflowInner$),
  },
  {
    route: workflowVisibilityContract.publish,
    handler: authRoute(workflowWriteAuth, publishInner$),
  },
  {
    route: workflowVisibilityContract.demote,
    handler: authRoute(workflowWriteAuth, demoteInner$),
  },
];
