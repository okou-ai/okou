import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  readWorkflowCopySnapshot$,
  commitWorkflowCopy$,
} from "./workflow-copy-publication";
import {
  workflowCopyAgentQuery,
  workflowCopyVisibleQuery,
  workflowCopyStorageQuery,
  type WorkflowCopySource,
} from "./workflow-copy-source";
import {
  workflowCopySlugQuery,
  copySlugConflict,
  type PreparedCopiedWebhook,
  type CopyWorkflowDatabaseResult,
} from "./workflow-copy-publication-plans";
import {
  publicationGenerationValues,
  publicationKeyCondition,
  retirePublicationSql,
  lockPublicationScopeSql,
  workflowPublicationKey,
} from "../services/storage-publication-fence.service";
import { preparedVolumePublicationSql } from "../services/storage-volume-publication-sql";
import { StorageVersionIdentityConflictError } from "../services/storage-version-registration.service";
import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
  type WorkflowCreateRequest,
  type WorkflowImportSource,
} from "@okouai/api-contracts/contracts/workflows";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { storages } from "@okouai/db/schema/storage";
import {
  storagePublicationGenerations,
  storagePublicationTokens,
} from "@okouai/db/schema/storage-publication-fence";
import {
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, isNull, isNotNull, ne } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { publishChatThreadWorkflowsChangedSafely } from "../external/realtime";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "../services/api-dispatch-timing.service";
import {
  autonomyBudgetExhausted,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { isUniqueViolation } from "../../lib/pg-errors";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import {
  deleteOrphanedWorkflowVolume$,
  deleteWorkflow$,
} from "../services/workflow-delete.service";
import {
  clerk$,
  clerkRateLimit,
  clerkReadUnavailable,
} from "../external/clerk";
import { loadWorkflowOwnerProfile } from "../services/workflow-owner-profile.service";
import { workflowDetail$ } from "../services/workflow-detail.service";
import {
  ensureWorkflowUserAutomationThread$,
  prepareWorkflowUserAutomationThread$,
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
} from "../services/workflow-webhook-automation-config.service";
import { childAutonomyBudget } from "../services/autonomy-budget.service";
import { awaitWithSignal, bestEffort, onRejection, settle } from "../utils";
import { reconcileGmailWatchesForUser$ } from "../services/gmail-automation-watch.service";
import { reconcileGoogleCalendarWatchesForUser$ } from "../services/google-calendar-automation-watch.service";
import { reconcileGoogleFormsWatchesForUser$ } from "../services/google-forms-automation-watch.service";
import { reconcileGoogleMeetSubscriptionsForUser$ } from "../services/google-meet-automation-watch.service";
import {
  loadVisibleWorkflowById,
  visibleWorkflowCondition,
  requireWorkflowPermission,
  workflowSummary,
  workflowList,
  type WorkflowAgentInfo,
  type WorkflowMember,
  type WorkflowRow,
} from "../services/workflow-data.service";
import type { RouteEntry } from "../route-entry";
import { sendNormalEvent$ } from "../services/chat-events.command";
import { OFFICIAL_WORKFLOW_READ_ONLY_MESSAGE } from "../services/official-workflow-constants";
import {
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

function requireAgentWritePermission(
  agent: {
    readonly owner: string;
    readonly visibility: "public" | "private";
  },
  member: WorkflowMember,
  action: string,
) {
  return requireAgentPermission(agent.owner, member, action, {
    visibility: agent.visibility,
  });
}
function requireVisibleAgentForPrivateWorkflowCreate(
  agent: {
    readonly owner: string;
    readonly visibility: "public" | "private";
  },
  member: WorkflowMember,
) {
  if (agent.visibility === "public" || agent.owner === member.userId) {
    return null;
  }
  return forbidden(
    "Only the private agent owner can create private workflows on this agent",
  );
}

interface WorkflowSlugScope {
  readonly orgId: string;
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly excludeWorkflowId?: string;
}

function workflowSlugCondition(args: WorkflowSlugScope) {
  return and(
    eq(workflows.orgId, args.orgId),
    eq(workflows.agentId, args.agentId),
    args.visibility === "private"
      ? eq(workflows.ownerUserId, args.ownerUserId)
      : undefined,
    eq(workflows.name, args.name),
    eq(workflows.visibility, args.visibility),
    args.excludeWorkflowId
      ? ne(workflows.id, args.excludeWorkflowId)
      : undefined,
  );
}

function workflowSlugConflict(visibility: "public" | "private", name: string) {
  return conflict(
    visibility === "public"
      ? `A public workflow named "/${name}" already exists on this agent. Rename this workflow or keep it private.`
      : `You already have a private workflow named "/${name}" on this agent. Rename the existing workflow or choose a different name.`,
  );
}

const requireWorkflowSlugAvailable$ = command(
  async ({ get }, args: WorkflowSlugScope, signal: AbortSignal) => {
    const [existing] = await get(db$)
      .select({ id: workflows.id })
      .from(workflows)
      .where(workflowSlugCondition(args))
      .limit(1);
    signal.throwIfAborted();
    return existing ? workflowSlugConflict(args.visibility, args.name) : null;
  },
);

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

const listComposerWorkflowsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const { agentId } = get(queryOf(workflowsCollectionContract.composer));
  const workflows = await get(
    workflowList({ orgId: auth.orgId, member: memberFromAuth(auth), agentId }),
  );
  return {
    status: 200 as const,
    body: workflows.flatMap((workflow) => {
      // A private override shadows the public workflow of the same name, so
      // only the override is a command the composer can offer.
      return workflow.shadowedBy
        ? []
        : [
            {
              id: workflow.id,
              name: workflow.name,
              displayName: workflow.displayName,
              description: workflow.description,
            },
          ];
    }),
  };
});

export interface WorkflowCreationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly body: WorkflowCreateRequest;
  readonly visibility: "public" | "private";
  /** Set only by the skill import, for the tool the skill came from. */
  readonly importSource?: WorkflowImportSource | null;
}

function workflowCreationRowValues(
  args: WorkflowCreationInput & { readonly workflowId: string },
  currentTime: Date,
): typeof workflows.$inferInsert {
  const { body, member, visibility } = args;
  return {
    id: args.workflowId,
    orgId: args.orgId,
    agentId: body.agentId,
    name: body.name,
    visibility,
    instruction: body.instruction ?? null,
    ownerUserId: member.userId,
    displayName: body.displayName ?? null,
    description: body.description ?? null,
    importSource: args.importSource ?? null,
    createdBy: member.userId,
    updatedBy: member.userId,
    createdAt: currentTime,
    updatedAt: currentTime,
  };
}

const validateWorkflowCreation$ = command(
  async ({ get, set }, args: WorkflowCreationInput, signal: AbortSignal) => {
    const [agent] = await get(db$)
      .select({
        id: agents.id,
        owner: agents.owner,
        visibility: agents.visibility,
        name: agents.name,
        displayName: agents.displayName,
      })
      .from(agents)
      .where(
        and(eq(agents.orgId, args.orgId), eq(agents.id, args.body.agentId)),
      )
      .limit(1);
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
    return await set(
      requireWorkflowSlugAvailable$,
      {
        orgId: args.orgId,
        agentId: agent.id,
        ownerUserId: args.member.userId,
        name: args.body.name,
        visibility: args.visibility,
      },
      signal,
    );
  },
);

const commitPreparedWorkflow$ = command(
  async (
    { set },
    args: WorkflowCreationInput & {
      readonly workflowId: string;
      readonly volume: PreparedServerSideVolume;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      // Publication reads Agent permissions without changing the Agent. SHARE
      // keeps them stable while independent workflows publish concurrently.
      const [agent] = await tx
        .select({
          id: agents.id,
          owner: agents.owner,
          visibility: agents.visibility,
          name: agents.name,
          displayName: agents.displayName,
        })
        .from(agents)
        .where(
          and(eq(agents.orgId, args.orgId), eq(agents.id, args.body.agentId)),
        )
        .limit(1)
        .for("share");
      signal.throwIfAborted();
      if (!agent) {
        return {
          kind: "error" as const,
          response: notFound(`Agent not found: ${args.body.agentId}`),
        };
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
        return { kind: "error" as const, response: permissionError };
      }
      const [existing] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          workflowSlugCondition({
            orgId: args.orgId,
            agentId: agent.id,
            ownerUserId: args.member.userId,
            name: args.body.name,
            visibility: args.visibility,
          }),
        )
        .limit(1);
      signal.throwIfAborted();
      if (existing) {
        return {
          kind: "error" as const,
          response: workflowSlugConflict(args.visibility, args.body.name),
        };
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
        .values(workflowCreationRowValues(args, currentTime))
        .onConflictDoNothing()
        .returning({ id: workflows.id });
      signal.throwIfAborted();
      if (!workflow) {
        return {
          kind: "error" as const,
          response: workflowSlugConflict(visibility, body.name),
        };
      }
      let chatThreadId: string | null = null;
      if (body.chatThreadId) {
        const [thread] = await tx
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, body.chatThreadId),
              eq(chatThreads.userId, member.userId),
              eq(chatThreads.agentId, body.agentId),
            ),
          )
          .limit(1)
          .for("update");
        chatThreadId = thread?.id ?? null;
      }
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
      const { rowCount: published } = await tx.execute(
        preparedVolumePublicationSql(args.volume, nowDate()),
      );
      if (published !== 1) {
        throw new StorageVersionIdentityConflictError(
          args.volume.version.versionId,
        );
      }
      signal.throwIfAborted();
      return { kind: "created" as const, workflow, chatThreadId };
    });
  },
);

const cleanupUnpublishedWorkflow$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly workflowId: string;
    },
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
        const created = await set(
          commitPreparedWorkflow$,
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
/** Agent visibility, agent existence, and slug conflicts, in that order. */
export interface WorkflowCreationFailure {
  readonly status: 403 | 404 | 409;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}
type WorkflowCreationOutcome =
  | {
      readonly kind: "created";
      readonly workflowId: string;
      readonly chatThreadId: string | null;
    }
  | {
      readonly kind: "error";
      readonly response: WorkflowCreationFailure;
    };

/**
 * Shared creation path for a validated workflow body: the built-in name guard,
 * agent and slug validation, volume preparation, and the publication
 * transaction. Callers own request parsing, their own admission rules, and how
 * they render the created workflow.
 */
export const createWorkflowRecord$ = command(
  async (
    { set },
    args: WorkflowCreationInput,
    signal: AbortSignal,
  ): Promise<WorkflowCreationOutcome> => {
    if (SEED_SKILLS.includes(args.body.name)) {
      return {
        kind: "error",
        response: conflict(
          `Workflow name "${args.body.name}" conflicts with a built-in workflow`,
        ),
      };
    }
    const error = await set(validateWorkflowCreation$, args, signal);
    if (error) {
      return { kind: "error", response: error };
    }
    const inserted = await set(prepareAndCreateWorkflow$, args, signal);
    // Publication has committed. Notification, response or cancellation failures
    // from this point must leave the valid Workflow and its volume intact.
    signal.throwIfAborted();
    if (inserted.kind === "error") {
      return { kind: "error", response: inserted.response };
    }
    return {
      kind: "created",
      workflowId: inserted.workflow.id,
      chatThreadId: inserted.chatThreadId,
    };
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
    const inserted = await set(
      createWorkflowRecord$,
      {
        orgId: auth.orgId,
        member,
        body,
        visibility: body.visibility ?? "private",
      },
      signal,
    );
    if (inserted.kind === "error") {
      return inserted.response;
    }
    const visible = await loadVisibleWorkflowById(set(writeDb$), {
      orgId: auth.orgId,
      member,
      workflowId: inserted.workflowId,
    });
    signal.throwIfAborted();
    if (!visible) {
      throw new Error(`Created workflow not found: ${inserted.workflowId}`);
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

const getWorkflowOwnerProfileInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(workflowsDetailContract.ownerProfile));
    const db = set(writeDb$);
    const visible = await loadVisibleWorkflowById(db, {
      orgId: auth.orgId,
      member: memberFromAuth(auth),
      workflowId: params.workflowId,
    });
    signal.throwIfAborted();
    if (!visible) {
      return workflowNotFound(params.workflowId);
    }
    set(setResHeader$, "Cache-Control", "no-store");
    const result = await settle(
      loadWorkflowOwnerProfile(
        db,
        get(clerk$),
        visible.workflow.ownerUserId,
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      const rateLimit = clerkRateLimit(result.error);
      if (rateLimit) {
        set(setResHeader$, "Retry-After", String(rateLimit.retryAfterSeconds));
        return {
          status: 429 as const,
          body: {
            error: {
              code: "TOO_MANY_REQUESTS",
              message: "Workflow owner profile is temporarily rate limited",
            },
          },
        };
      }
      if (clerkReadUnavailable(result.error)) {
        return providerUnavailable(
          "Workflow owner profile is temporarily unavailable",
        );
      }
      throw result.error;
    }
    const profile = result.value;
    if (profile === undefined) {
      return providerUnavailable("Workflow owner profile lookup is busy");
    }
    return {
      status: 200 as const,
      body: profile ?? { displayName: null, imageUrl: null },
    };
  },
);

const getWorkflowDetailInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(workflowsDetailContract.get));
    const result = await set(
      workflowDetail$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        workflowId: params.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!result) {
      return workflowNotFound(params.workflowId);
    }
    return { status: 200 as const, body: result };
  },
);

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

      const slugConflict = await set(
        requireWorkflowSlugAvailable$,
        {
          orgId: auth.orgId,
          agentId: visible.workflow.agentId,
          ownerUserId: visible.workflow.ownerUserId,
          name: bodyResult.data.name,
          visibility: visible.workflow.visibility,
          excludeWorkflowId: visible.workflow.id,
        },
        signal,
      );
      signal.throwIfAborted();
      if (slugConflict) {
        return slugConflict;
      }
    }

    const updated = await set(
      updateWorkflow$,
      {
        workflow: visible.workflow,
        body: bodyResult.data,
        updatedByUserId: auth.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!updated) {
      return conflict("Workflow changed during update; retry the request");
    }

    const detail = await set(
      workflowDetail$,
      {
        orgId: auth.orgId,
        member,
        workflowId: params.workflowId,
      },
      signal,
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

async function prepareCopiedWebhooks(
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
  source: WorkflowCopySource,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, PreparedCopiedWebhook>> {
  const prepared = new Map<string, PreparedCopiedWebhook>();
  for (const automation of source.sourceAutomations) {
    if (
      automation.kind !== "event" ||
      automation.eventType !== "webhook-received"
    ) {
      continue;
    }
    const sourceWebhook = source.webhooks.find((webhook) => {
      return webhook.automationId === automation.id;
    });
    const token = mintWorkflowWebhookToken();
    let encryptedSecret: string;
    let secretLastFour: string;
    if (sourceWebhook) {
      encryptedSecret = sourceWebhook.encryptedSecret;
      secretLastFour = sourceWebhook.secretLastFour;
    } else {
      const secret = mintWorkflowWebhookSecret();
      encryptedSecret = await encryptWorkflowWebhookSecret(secret, args);
      secretLastFour = secret.slice(-4);
    }
    signal.throwIfAborted();
    const encryptedToken = await encryptWorkflowWebhookToken(token, args);
    signal.throwIfAborted();
    prepared.set(automation.id, {
      tokenHash: hashWorkflowWebhookToken(token),
      encryptedToken,
      encryptedSecret,
      secretLastFour,
    });
  }
  return prepared;
}

function copiedWorkflowVolumeFiles(
  sourceWorkflow: Pick<WorkflowRow, "name" | "description" | "instruction">,
  sourceFiles:
    | readonly {
        readonly path: string;
        readonly content: string;
      }[]
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
const reconcileCopiedWorkflowAutomationWatches$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly copied: Extract<
        CopyWorkflowDatabaseResult,
        {
          kind: "ok";
        }
      >;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const owner = { orgId: args.orgId, userId: args.userId };
    if (args.copied.accountConnectorSlugs.includes("gmail")) {
      await bestEffort(
        set(
          reconcileGmailWatchesForUser$,
          { orgId: args.orgId, userId: args.userId },
          signal,
        ),
        signal,
      );
    }
    if (args.copied.accountConnectorSlugs.includes("google-calendar")) {
      await bestEffort(
        set(reconcileGoogleCalendarWatchesForUser$, owner, signal),
        signal,
      );
    }
    if (args.copied.accountConnectorSlugs.includes("google-forms")) {
      await bestEffort(
        set(
          reconcileGoogleFormsWatchesForUser$,
          {
            orgId: owner.orgId,
            userId: owner.userId,
          },
          signal,
        ),
        signal,
      );
    }
    if (args.copied.accountConnectorSlugs.includes("google-meet")) {
      await bestEffort(
        set(
          reconcileGoogleMeetSubscriptionsForUser$,
          { orgId: owner.orgId, userId: owner.userId },
          signal,
        ),
        signal,
      );
    }
  },
);
function copiedWorkflowVolumeInput(
  orgId: string,
  targetWorkflowId: string,
  source: WorkflowCopySource,
) {
  return {
    orgId,
    storageName: getCustomSkillStorageName(targetWorkflowId),
    piResourceIndex: true as const,
    files: copiedWorkflowVolumeFiles(source.sourceWorkflow, source.files),
  };
}

function copiedWorkflowResponse(
  visible: Awaited<ReturnType<typeof loadVisibleWorkflowById>>,
  member: WorkflowMember,
  workflowId: string,
) {
  if (!visible) {
    throw new Error(`Copied workflow not found: ${workflowId}`);
  }
  return {
    status: 201 as const,
    body: workflowSummary({
      workflow: visible.workflow,
      agent: visible.agent,
      member,
    }),
  };
}

interface CopiedWorkflowPublicationInput {
  readonly orgId: string;
  readonly userId: string;
  readonly member: WorkflowMember;
  readonly sourceWorkflow: WorkflowRow;
  readonly sourceFiles:
    | readonly {
        readonly path: string;
        readonly content: string;
      }[]
    | null;
  readonly sourceStorage: WorkflowCopySource["storage"];
  readonly targetAgentId: string;
  readonly inheritedAutonomyBudget: number | undefined;
  readonly currentTime: Date;
}

const publishCopiedWorkflow$ = command(
  async (
    { get, set },
    args: CopiedWorkflowPublicationInput,
    signal: AbortSignal,
  ) => {
    // Read a coherent source in a short transaction, then release every lock
    // before KMS and object storage work. Publication rechecks that exact source.
    const snapshot = await set(readWorkflowCopySnapshot$, args, signal);
    signal.throwIfAborted();
    if (snapshot.kind === "conflict") {
      return conflict(snapshot.message);
    }
    const preparedWebhooks = await prepareCopiedWebhooks(
      args,
      snapshot.source,
      signal,
    );
    const targetWorkflowId = randomUUID();
    const threadPreparation = await set(
      prepareWorkflowUserAutomationThread$,
      {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: targetWorkflowId,
        workflowTitle:
          snapshot.source.sourceWorkflow.displayName ??
          snapshot.source.sourceWorkflow.name,
      },
      signal,
    );
    const cleanup = { orgId: args.orgId, workflowId: targetWorkflowId };
    return await onRejection(
      (async () => {
        const volume = await set(
          prepareVolumeServerSide$,
          copiedWorkflowVolumeInput(
            args.orgId,
            targetWorkflowId,
            snapshot.source,
          ),
          signal,
        );
        const publication = await settle(
          set(
            commitWorkflowCopy$,
            {
              orgId: args.orgId,
              userId: args.userId,
              member: args.member,
              sourceWorkflow: args.sourceWorkflow,
              sourceFiles: args.sourceFiles,
              sourceStorage: args.sourceStorage,
              targetAgentId: args.targetAgentId,
              targetWorkflowId,
              threadPreparation,
              currentTime: args.currentTime,
              inheritedAutonomyBudget: args.inheritedAutonomyBudget,
              source: snapshot.source,
              preparedWebhooks,
              volume,
            },
            signal,
          ),
          signal,
        );
        if (!publication.ok) {
          if (
            !isUniqueViolation(
              publication.error,
              "idx_workflows_private_owner_agent_name_unique",
            )
          ) {
            throw publication.error;
          }
          // Different sources can race for the same target slug. The whole
          // publication transaction has rolled back before its volume is removed.
          await set(cleanupUnpublishedWorkflow$, cleanup);
          return workflowSlugConflict(
            "private",
            snapshot.source.sourceWorkflow.name,
          );
        }
        const copied = publication.value;
        if (copied.kind === "conflict") {
          await set(cleanupUnpublishedWorkflow$, cleanup);
          return conflict(copied.message);
        }
        await set(
          reconcileCopiedWorkflowAutomationWatches$,
          {
            orgId: args.orgId,
            userId: args.userId,
            copied,
          },
          signal,
        );
        const [visible] = await get(db$)
          .select({
            workflow: workflows,
            agent: {
              id: agents.id,
              orgId: agents.orgId,
              owner: agents.owner,
              visibility: agents.visibility,
              name: agents.name,
              displayName: agents.displayName,
            },
          })
          .from(workflows)
          .innerJoin(agents, eq(workflows.agentId, agents.id))
          .where(
            and(
              eq(workflows.orgId, args.orgId),
              eq(workflows.id, targetWorkflowId),
              visibleWorkflowCondition(args.member),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        return copiedWorkflowResponse(
          visible ?? null,
          args.member,
          targetWorkflowId,
        );
      })(),
      async () => {
        await set(cleanupUnpublishedWorkflow$, cleanup);
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
    const db = get(db$);
    let inheritedAutonomyBudget: number | undefined;
    if (auth.tokenType === "agent") {
      const [run] = await db
        .select({ autonomyBudget: agentRuns.autonomyBudget })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, auth.runId),
            eq(agentRuns.orgId, auth.orgId),
            eq(agentRuns.userId, auth.userId),
            isNotNull(agentRuns.triggerSource),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      const sourceAutonomyBudget = run?.autonomyBudget ?? null;
      if (sourceAutonomyBudget === null) {
        return notFound("Source run not found");
      }
      const derived = childAutonomyBudget(sourceAutonomyBudget);
      if (derived.kind === "exhausted") {
        return autonomyBudgetExhausted();
      }
      inheritedAutonomyBudget = derived.autonomyBudget;
    }
    const [sourceWorkflow] = await db.select().from(
      workflowCopyVisibleQuery({
        orgId: auth.orgId,
        member,
        workflowId: params.workflowId,
      }),
    );
    signal.throwIfAborted();
    if (!sourceWorkflow) {
      return workflowNotFound(params.workflowId);
    }
    const [targetAgent] = await db
      .select()
      .from(workflowCopyAgentQuery(auth.orgId, bodyResult.data.toAgentId));
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
    const [slug] = await db.select().from(
      workflowCopySlugQuery({
        orgId: auth.orgId,
        userId: auth.userId,
        targetAgentId: targetAgent.id,
        sourceWorkflow,
      }),
    );
    signal.throwIfAborted();
    const slugError = slug
      ? conflict(copySlugConflict(sourceWorkflow.name))
      : null;
    if (slugError) {
      return slugError;
    }
    const sourceStorage =
      sourceWorkflow.officialDefinitionName === null
        ? ((
            await db
              .select()
              .from(
                workflowCopyStorageQuery(
                  { orgId: auth.orgId, sourceWorkflow },
                  false,
                ),
              )
          )[0] ?? null)
        : null;
    const sourceFiles = sourceStorage?.headVersionId
      ? await get(
          loadWorkflowVolumeFiles({
            orgId: auth.orgId,
            workflowId: sourceWorkflow.id,
            version: {
              storageId: sourceStorage.id,
              versionId: sourceStorage.headVersionId,
            },
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
        orgId: auth.orgId,
        userId: auth.userId,
        member,
        sourceWorkflow: sourceWorkflow,
        sourceFiles,
        sourceStorage,
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
    const chatThreadId = await set(
      ensureWorkflowUserAutomationThread$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        workflowId: workflow.id,
        agentId: agent.id,
        workflowTitle: workflow.displayName ?? workflow.name,
        currentTime,
      },
      signal,
    );
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
        return await set(
          ensureWorkflowUserAutomationThread$,
          {
            orgId: auth.orgId,
            userId: auth.userId,
            workflowId: workflow.id,
            agentId: agent.id,
            workflowTitle: workflow.displayName ?? workflow.name,
            currentTime,
          },
          signal,
        );
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
      preloadedAgent: agent,
      agentRunPreCreateSource: "workflow_slash_command",
      getStartedWorkflowId: workflow.id,
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

const applyWorkflowVisibility$ = command(
  async (
    { set },
    args: {
      readonly workflow: Pick<
        WorkflowRow,
        | "id"
        | "orgId"
        | "agentId"
        | "ownerUserId"
        | "name"
        | "officialDefinitionName"
        | "visibility"
      >;
      readonly updatedByUserId: string;
      readonly visibility: "public" | "private";
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const visibilityChanged = await db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, args.workflow.agentId),
            eq(agents.orgId, args.workflow.orgId),
          ),
        )
        .for("key share")
        .limit(1);
      if (!agent) {
        return false;
      }
      const workflowCondition = and(
        eq(workflows.id, args.workflow.id),
        eq(workflows.orgId, args.workflow.orgId),
        eq(workflows.agentId, args.workflow.agentId),
        eq(workflows.ownerUserId, args.workflow.ownerUserId),
        eq(workflows.visibility, args.workflow.visibility),
        isNull(workflows.officialDefinitionName),
      );
      const [locked] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(workflowCondition)
        .for("update")
        .limit(1);
      if (!locked) {
        return false;
      }

      const scopes = [
        { orgId: args.workflow.orgId, agentId: args.workflow.agentId },
        {
          orgId: args.workflow.orgId,
          agentId: args.workflow.agentId,
          userId: args.workflow.ownerUserId,
        },
      ] as const;
      await tx
        .insert(storagePublicationGenerations)
        .values(publicationGenerationValues(scopes))
        .onConflictDoNothing();
      const publicationKey = workflowPublicationKey(args.workflow.id);
      const currentScope =
        args.workflow.visibility === "public" ? scopes[0] : scopes[1];
      const [publication] = await tx
        .select({ token: storagePublicationTokens.token })
        .from(storagePublicationTokens)
        .innerJoin(
          storagePublicationGenerations,
          and(
            eq(
              storagePublicationGenerations.orgId,
              storagePublicationTokens.orgId,
            ),
            eq(
              storagePublicationGenerations.agentId,
              storagePublicationTokens.agentId,
            ),
            eq(
              storagePublicationGenerations.subject,
              storagePublicationTokens.subject,
            ),
          ),
        )
        .where(publicationKeyCondition(currentScope, publicationKey))
        .limit(1);
      if (publication) {
        return false;
      }

      const [updated] = await tx
        .update(workflows)
        .set({
          visibility: args.visibility,
          updatedBy: args.updatedByUserId,
          updatedAt: nowDate(),
        })
        .where(workflowCondition)
        .returning({ id: workflows.id });
      if (!updated) {
        return false;
      }
      for (const scope of scopes) {
        await tx.execute(lockPublicationScopeSql(scope, nowDate()));
        await tx.execute(retirePublicationSql(scope, publicationKey));
      }
      return true;
    });
    signal.throwIfAborted();
    return visibilityChanged;
  },
);

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

const loadVisibilityTransition$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly workflowId: string;
    },
    signal: AbortSignal,
  ): Promise<VisibilityTransition | NotFoundResponse> => {
    const [visible] = await get(db$)
      .select({
        workflow: workflows,
        agent: {
          id: agents.id,
          orgId: agents.orgId,
          owner: agents.owner,
          visibility: agents.visibility,
          name: agents.name,
          displayName: agents.displayName,
        },
      })
      .from(workflows)
      .innerJoin(agents, eq(workflows.agentId, agents.id))
      .where(
        and(
          eq(workflows.orgId, args.orgId),
          eq(workflows.id, args.workflowId),
          visibleWorkflowCondition(args.member),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!visible) {
      return workflowNotFound(args.workflowId);
    }
    return { ...visible, member: args.member };
  },
);

const publishInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = memberFromAuth(auth);
  const params = get(pathParamsOf(workflowVisibilityContract.publish));

  const loaded = await set(
    loadVisibilityTransition$,
    {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    },
    signal,
  );
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

  const slugError = await set(
    requireWorkflowSlugAvailable$,
    {
      orgId: auth.orgId,
      agentId: workflow.agentId,
      ownerUserId: workflow.ownerUserId,
      visibility: "public",
      name: workflow.name,
      excludeWorkflowId: workflow.id,
    },
    signal,
  );
  signal.throwIfAborted();
  if (slugError) {
    return slugError;
  }

  const updated = await set(
    applyWorkflowVisibility$,
    {
      workflow,
      updatedByUserId: auth.userId,
      visibility: "public",
    },
    signal,
  );
  signal.throwIfAborted();
  if (!updated) {
    return conflict("Workflow changed during publish; retry the request");
  }
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

  const loaded = await set(
    loadVisibilityTransition$,
    {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    },
    signal,
  );
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

  const slugError = await set(
    requireWorkflowSlugAvailable$,
    {
      orgId: auth.orgId,
      agentId: loaded.workflow.agentId,
      ownerUserId: loaded.workflow.ownerUserId,
      visibility: "private",
      name: loaded.workflow.name,
    },
    signal,
  );
  signal.throwIfAborted();
  if (slugError) {
    return slugError;
  }

  const updated = await set(
    applyWorkflowVisibility$,
    {
      workflow: loaded.workflow,
      updatedByUserId: auth.userId,
      visibility: "private",
    },
    signal,
  );
  signal.throwIfAborted();
  if (!updated) {
    return conflict("Workflow changed during demotion; retry the request");
  }
  return {
    status: 200 as const,
    body: summaryFrom(loaded, {
      visibility: "private",
    }),
  };
});

export const workflowsRoutes: readonly RouteEntry[] = [
  {
    route: workflowsDetailContract.ownerProfile,
    handler: authRoute(workflowReadAuth, getWorkflowOwnerProfileInner$),
  },
  {
    route: workflowsCollectionContract.list,
    handler: authRoute(workflowReadAuth, listWorkflowsInner$),
  },
  // Registered before the `/:workflowId` routes so the static path wins.
  {
    route: workflowsCollectionContract.composer,
    handler: authRoute(workflowReadAuth, listComposerWorkflowsInner$),
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
