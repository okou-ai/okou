import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import {
  workflowVisibilityPublicationSql,
  workflowVisibilityGenerationChanged,
} from "../services/workflow-visibility-publication-sql";
import { boolean, literal, object } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  readWorkflowCopySnapshot$,
  commitWorkflowCopy$,
} from "./workflow-copy-publication";
import {
  workflowCopyAgentQuery,
  workflowCopyVisibleQuery,
  type WorkflowCopySource,
} from "./workflow-copy-source";
import {
  workflowCopySlugQuery,
  copySlugConflict,
  type PreparedCopiedWebhook,
  type CopyWorkflowDatabaseResult,
} from "./workflow-copy-publication-plans";
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
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import {
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import {
  and,
  DrizzleQueryError,
  eq,
  isNull,
  isNotNull,
  ne,
  or,
  exists,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  pgBooleanDecoder,
  nullableDriverValueDecoder,
} from "../../lib/db-structured-result";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { publishChatThreadWorkflowsChangedSafely } from "../external/realtime";
import { publishSkillImportAfterCommit } from "../services/skill-import-telemetry";
import { ApiDispatchTimingCollector } from "../services/api-dispatch-timing.service";
import {
  autonomyBudgetExhausted,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { now, nowDate } from "../../lib/time";
import { isOrdinaryWorkflowNameConflict } from "./workflow-name-conflicts";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { deleteWorkflow$ } from "../services/workflow-delete.service";
import { clerkRateLimit, clerkReadUnavailable } from "../external/clerk";
import { loadWorkflowOwnerProfile$ } from "../services/workflow-owner-profile.service";
import { workflowDetail$ } from "../services/workflow-detail.service";
import {
  ensureWorkflowUserAutomationThread$,
  prepareWorkflowUserAutomationThread$,
  loadWorkflowUserAutomationThreadId$,
} from "../services/workflow-user-automation-thread.service";
import { updateWorkflow$ } from "../services/workflow-update.service";
import { createUserMessageDocument } from "../services/chat-user-message.service";
import {
  prepareWorkflowAttachments$,
  publishWorkflowContentBundle$,
  workflowAttachmentFiles,
  type PreparedWorkflowAttachments,
} from "../services/workflow-attachments.service";
import {
  consumeWorkflowAttachmentCandidateSql,
  restoreWorkflowAttachmentCandidateSql,
} from "../services/workflow-attachment-cleanup.service";
import {
  encryptWorkflowWebhookSecret,
  encryptWorkflowWebhookToken,
  hashWorkflowWebhookToken,
  mintWorkflowWebhookSecret,
  mintWorkflowWebhookToken,
} from "../services/workflow-webhook-automation-config.service";
import { childAutonomyBudget } from "../services/autonomy-budget.service";
import { bestEffort, settle } from "../utils";
import { reconcileGmailWatchesForUser$ } from "../services/gmail-automation-watch.service";
import { reconcileGoogleCalendarWatchesForUser$ } from "../services/google-calendar-automation-watch.service";
import { reconcileGoogleFormsWatchesForUser$ } from "../services/google-forms-automation-watch.service";
import { reconcileGoogleMeetSubscriptionsForUser$ } from "../services/google-meet-automation-watch.service";
import {
  loadVisibleWorkflowById$,
  type VisibleWorkflow,
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
import {
  OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE,
  OFFICIAL_WORKFLOW_READ_ONLY_MESSAGE,
} from "../services/official-workflow-constants";

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
    isNull(workflows.officialDefinitionName),
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
      return workflow.official || workflow.shadowedBy
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
  readonly importSessionId?: string | null;
}

function workflowCreationRowValues(
  args: WorkflowCreationInput & { readonly workflowId: string },
  currentTime: Date,
) {
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
    importSessionId: args.importSessionId ?? null,
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

interface PreparedWorkflowCreation
  extends WorkflowCreationInput, PreparedWorkflowAttachments {
  readonly workflowId: string;
  readonly contentBundle: ContentBundle;
}

/** Statement data only; execution and every write belong to the creation owner. */
function workflowCreationAdmissionPlan(args: PreparedWorkflowCreation) {
  const query = new QueryBuilder();
  const { body, member } = args;
  const agent = query.$with("creation_agent").as(
    query
      .select({
        id: agents.id,
        owner: agents.owner,
        visibility: agents.visibility,
      })
      .from(agents)
      .where(and(eq(agents.orgId, args.orgId), eq(agents.id, body.agentId)))
      .limit(1)
      .for("share"),
  );
  // Use the returned locked Agent, including changes committed while waiting.
  // These are the same owner/admin and private-visibility rules as preflight.
  const permitted =
    args.visibility === "public"
      ? or(
          eq(agent.owner, member.userId),
          and(eq(agent.visibility, "public"), sql`${member.role === "admin"}`),
        )
      : or(eq(agent.visibility, "public"), eq(agent.owner, member.userId));
  const admitted = query
    .$with("creation_admitted")
    .as(query.select({ id: agent.id }).from(agent).where(permitted));
  const slug = query.$with("creation_slug").as(
    query
      .select({ id: workflows.id })
      .from(workflows)
      .innerJoin(admitted, eq(workflows.agentId, admitted.id))
      .where(
        workflowSlugCondition({
          orgId: args.orgId,
          agentId: body.agentId,
          ownerUserId: member.userId,
          name: body.name,
          visibility: args.visibility,
        }),
      )
      .limit(1),
  );
  const thread = query.$with("creation_thread").as(
    query
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .crossJoin(admitted)
      .where(
        and(
          body.chatThreadId
            ? eq(chatThreads.id, body.chatThreadId)
            : sql`false`,
          eq(chatThreads.userId, member.userId),
          eq(chatThreads.agentId, body.agentId),
        ),
      )
      .limit(1)
      .for("update", { of: chatThreads }),
  );
  return { agent, admitted, slug, thread };
}

interface WorkflowCreationOutcomeRow {
  readonly agentOwner: string | null;
  readonly agentVisibility: "public" | "private" | null;
  readonly slugExists: boolean;
  readonly workflowId: string | null;
  readonly chatThreadId: string | null;
}

function workflowCreationOutcome(
  args: PreparedWorkflowCreation,
  result: WorkflowCreationOutcomeRow | undefined,
) {
  const { body, member } = args;
  if (!result) {
    throw new Error("Expected one workflow creation outcome");
  }
  if (result.agentOwner === null || result.agentVisibility === null) {
    return {
      kind: "error" as const,
      response: notFound(`Agent not found: ${body.agentId}`),
    };
  }
  const lockedAgent = {
    owner: result.agentOwner,
    visibility: result.agentVisibility,
  };
  const permissionError =
    args.visibility === "public"
      ? requireAgentWritePermission(
          lockedAgent,
          member,
          "create workflows on this agent",
        )
      : requireVisibleAgentForPrivateWorkflowCreate(lockedAgent, member);
  if (permissionError) {
    return { kind: "error" as const, response: permissionError };
  }
  if (result.slugExists) {
    return {
      kind: "error" as const,
      response: workflowSlugConflict(args.visibility, body.name),
    };
  }
  if (result.workflowId === null) {
    return {
      kind: "error" as const,
      response: conflict(
        "Workflow attachment preparation changed; retry creation",
      ),
    };
  }
  return {
    kind: "created" as const,
    workflow: { id: result.workflowId },
    chatThreadId: result.chatThreadId,
  };
}

function workflowCreationSource(
  args: PreparedWorkflowCreation,
  at: Date,
  published: SQL,
) {
  const v = workflowCreationRowValues(args, at);
  return new QueryBuilder()
    .select({
      id: sql`${sql.param(v.id, workflows.id)}`.mapWith(workflows.id).as("id"),
      orgId: sql`${sql.param(v.orgId, workflows.orgId)}`
        .mapWith(workflows.orgId)
        .as("org_id"),
      agentId: sql`${sql.param(v.agentId, workflows.agentId)}`
        .mapWith(workflows.agentId)
        .as("agent_id"),
      name: sql`${sql.param(v.name, workflows.name)}`
        .mapWith(workflows.name)
        .as("name"),
      visibility: sql`${sql.param(v.visibility, workflows.visibility)}`
        .mapWith(workflows.visibility)
        .as("visibility"),
      instruction: sql`${sql.param(v.instruction, workflows.instruction)}`
        .mapWith(nullableDriverValueDecoder(workflows.instruction))
        .as("instruction"),
      attachments: sql`${sql.param(args.attachments, workflows.attachments)}`
        .mapWith(nullableDriverValueDecoder(workflows.attachments))
        .as("attachments"),
      contentBundle:
        sql`${sql.param(args.contentBundle, workflows.contentBundle)}`
          .mapWith(nullableDriverValueDecoder(workflows.contentBundle))
          .as("content_bundle"),
      ownerUserId: sql`${sql.param(v.ownerUserId, workflows.ownerUserId)}`
        .mapWith(workflows.ownerUserId)
        .as("owner_user_id"),
      displayName: sql`${sql.param(v.displayName, workflows.displayName)}`
        .mapWith(nullableDriverValueDecoder(workflows.displayName))
        .as("display_name"),
      description: sql`${sql.param(v.description, workflows.description)}`
        .mapWith(nullableDriverValueDecoder(workflows.description))
        .as("description"),
      officialDefinitionName: sql`NULL`
        .mapWith(nullableDriverValueDecoder(workflows.officialDefinitionName))
        .as("official_definition_name"),
      officialInstallationState: sql`NULL`
        .mapWith(
          nullableDriverValueDecoder(workflows.officialInstallationState),
        )
        .as("official_installation_state"),
      importSource: sql`${sql.param(v.importSource, workflows.importSource)}`
        .mapWith(nullableDriverValueDecoder(workflows.importSource))
        .as("import_source"),
      importSessionId:
        sql`${sql.param(v.importSessionId, workflows.importSessionId)}`
          .mapWith(nullableDriverValueDecoder(workflows.importSessionId))
          .as("import_session_id"),
      createdBy: sql`${sql.param(v.createdBy, workflows.createdBy)}`
        .mapWith(workflows.createdBy)
        .as("created_by"),
      updatedBy: sql`${sql.param(v.updatedBy, workflows.updatedBy)}`
        .mapWith(workflows.updatedBy)
        .as("updated_by"),
      createdAt: sql`${sql.param(v.createdAt, workflows.createdAt)}`
        .mapWith(workflows.createdAt)
        .as("created_at"),
      updatedAt: sql`${sql.param(v.updatedAt, workflows.updatedAt)}`
        .mapWith(workflows.updatedAt)
        .as("updated_at"),
    })
    .from(published);
}

const commitPreparedWorkflow$ = command(
  async ({ set }, args: PreparedWorkflowCreation, signal: AbortSignal) => {
    const db = set(writeDb$);
    const { member } = args;
    const { agent, admitted, slug, thread } =
      workflowCreationAdmissionPlan(args);
    const currentTime = nowDate();
    const candidate = db
      .$with("consumed_attachment_candidate", {})
      .as(consumeWorkflowAttachmentCandidateSql(args.cleanupJobId));
    const created = db.$with("created_workflow").as(
      db
        .insert(workflows)
        .select(
          workflowCreationSource(
            args,
            currentTime,
            sql`${admitted}, ${candidate}`,
          ).where(notExists(db.select({ id: slug.id }).from(slug))),
        )
        .returning({ id: workflows.id }),
    );
    const linked = db.$with("creation_link").as(
      db
        .insert(workflowUserAutomationThreads)
        .select(
          db
            .select({
              id: sql`gen_random_uuid()`
                .mapWith(workflowUserAutomationThreads.id)
                .as("id"),
              orgId:
                sql`${sql.param(args.orgId, workflowUserAutomationThreads.orgId)}`
                  .mapWith(workflowUserAutomationThreads.orgId)
                  .as("org_id"),
              userId:
                sql`${sql.param(member.userId, workflowUserAutomationThreads.userId)}`
                  .mapWith(workflowUserAutomationThreads.userId)
                  .as("user_id"),
              workflowId: created.id,
              chatThreadId: thread.id,
              createdAt:
                sql`${sql.param(currentTime, workflowUserAutomationThreads.createdAt)}`
                  .mapWith(workflowUserAutomationThreads.createdAt)
                  .as("created_at"),
              updatedAt:
                sql`${sql.param(currentTime, workflowUserAutomationThreads.updatedAt)}`
                  .mapWith(workflowUserAutomationThreads.updatedAt)
                  .as("updated_at"),
            })
            .from(created)
            .crossJoin(thread),
        )
        .returning({
          chatThreadId: workflowUserAutomationThreads.chatThreadId,
        }),
    );
    const restored = db
      .$with("restored_attachment_candidate", {})
      .as(
        restoreWorkflowAttachmentCandidateSql(
          args.cleanupJobId,
          sql`SELECT 1 FROM ${created}`,
        ),
      );
    signal.throwIfAborted();
    const [result] = await db
      .with(agent, admitted, slug, thread, candidate, created, restored, linked)
      .select({
        agentOwner: agent.owner,
        agentVisibility: agent.visibility,
        slugExists: exists(db.select({ id: slug.id }).from(slug)).mapWith(
          pgBooleanDecoder,
        ),
        workflowId: created.id,
        chatThreadId: linked.chatThreadId,
      })
      .from(sql`(SELECT true) AS result`)
      .leftJoin(agent, sql`true`)
      .leftJoin(created, sql`true`)
      .leftJoin(linked, sql`true`);
    signal.throwIfAborted();
    return workflowCreationOutcome(args, result);
  },
);

const prepareAndCreateWorkflow$ = command(
  async ({ set }, args: WorkflowCreationInput, signal: AbortSignal) => {
    const workflowId = randomUUID();
    const prepared = await set(
      prepareWorkflowAttachments$,
      {
        orgId: args.orgId,
        workflowId,
        userId: args.member.userId,
        files: args.body.files ?? [],
      },
      signal,
    );
    const contentBundle = await set(
      publishWorkflowContentBundle$,
      {
        orgId: args.orgId,
        workflowId,
        name: args.body.name,
        description: args.body.description ?? null,
        instruction: args.body.instruction ?? null,
        attachments: prepared.attachments,
        files: args.body.files ?? [],
      },
      signal,
    );
    const pendingPublication = set(
      commitPreparedWorkflow$,
      { ...args, workflowId, ...prepared, contentBundle },
      signal,
    );
    // Import observation follows the committed outcome even after request abort.
    if (args.importSource) {
      waitUntil(
        publishSkillImportAfterCommit(pendingPublication, {
          userId: args.member.userId,
          orgId: args.orgId,
          sessionId: args.importSessionId ?? null,
          provider: args.importSource,
        }),
      );
    }
    const publication = await settle(pendingPublication, signal);
    if (!publication.ok) {
      if (!isOrdinaryWorkflowNameConflict(publication.error, args.visibility)) {
        throw publication.error;
      }
      return {
        kind: "error" as const,
        response: workflowSlugConflict(args.visibility, args.body.name),
      };
    }
    signal.throwIfAborted();
    return publication.value;
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
 * statement. Callers own request parsing, their own admission rules, and how
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
    const visible = await set(
      loadVisibleWorkflowById$,
      {
        orgId: auth.orgId,
        member,
        workflowId: inserted.workflowId,
      },
      signal,
    );
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
    const visible = await set(
      loadVisibleWorkflowById$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        workflowId: params.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!visible) {
      return workflowNotFound(params.workflowId);
    }
    set(setResHeader$, "Cache-Control", "no-store");
    const result = await settle(
      set(loadWorkflowOwnerProfile$, visible.workflow.ownerUserId, signal),
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

    const visible = await set(
      loadVisibleWorkflowById$,
      {
        orgId: auth.orgId,
        member,
        workflowId: params.workflowId,
      },
      signal,
    );
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

    const update = await settle(
      set(
        updateWorkflow$,
        {
          workflow: visible.workflow,
          observedXmin: visible.observedXmin,
          body: bodyResult.data,
          updatedByUserId: auth.userId,
          member,
        },
        signal,
      ),
      signal,
    );
    if (!update.ok) {
      if (
        !isOrdinaryWorkflowNameConflict(
          update.error,
          visible.workflow.visibility,
        )
      ) {
        throw update.error;
      }
      return workflowSlugConflict(
        visible.workflow.visibility,
        bodyResult.data.name ?? visible.workflow.name,
      );
    }
    signal.throwIfAborted();
    if (!update.value) {
      return conflict("Workflow changed during update; retry the request");
    }

    const detail = await set(
      workflowDetail$,
      {
        orgId: auth.orgId,
        member,
        workflowId: params.workflowId,
        includeFileContents: false,
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

    const visible = await set(
      loadVisibleWorkflowById$,
      {
        orgId: auth.orgId,
        member,
        workflowId: params.workflowId,
      },
      signal,
    );
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
const prepareCopiedWorkflowContent$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly source: WorkflowCopySource;
    },
    signal: AbortSignal,
  ) => {
    if (args.source.files === null) {
      throw new Error("Workflow attachment source is unavailable");
    }
    const prepared = await set(
      prepareWorkflowAttachments$,
      {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
        files: args.source.files,
      },
      signal,
    );
    const contentBundle = await set(
      publishWorkflowContentBundle$,
      {
        orgId: args.orgId,
        workflowId: args.workflowId,
        name: args.source.sourceWorkflow.name,
        description: args.source.sourceWorkflow.description,
        instruction: args.source.sourceWorkflow.instruction,
        attachments: prepared.attachments,
        files: args.source.files,
      },
      signal,
    );
    return { ...prepared, contentBundle };
  },
);

function copiedWorkflowResponse(
  visible: VisibleWorkflow | null,
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
    // Prepare with ordinary reads before KMS and object storage work. Concurrent
    // source changes may conflict; publication rechecks that exact source.
    const snapshot = await set(readWorkflowCopySnapshot$, args, signal);
    signal.throwIfAborted();
    if (snapshot.kind === "conflict") {
      return conflict(snapshot.message);
    }
    if (snapshot.source.files === null) {
      throw new Error("Workflow attachment source is unavailable");
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
    return await (async () => {
      const content = await set(
        prepareCopiedWorkflowContent$,
        {
          orgId: args.orgId,
          workflowId: targetWorkflowId,
          userId: args.userId,
          source: snapshot.source,
        },
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
            targetAgentId: args.targetAgentId,
            targetWorkflowId,
            threadPreparation,
            currentTime: args.currentTime,
            inheritedAutonomyBudget: args.inheritedAutonomyBudget,
            source: snapshot.source,
            preparedWebhooks,
            ...content,
          },
          signal,
        ),
        signal,
      );
      if (!publication.ok) {
        if (!isOrdinaryWorkflowNameConflict(publication.error, "private")) {
          throw publication.error;
        }
        // A rolled-back candidate remains durably queued for exact cleanup.
        return workflowSlugConflict(
          "private",
          snapshot.source.sourceWorkflow.name,
        );
      }
      const copied = publication.value;
      if (copied.kind === "conflict") {
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
    })();
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
    const sourceFiles =
      sourceWorkflow.officialDefinitionName === null
        ? await get(
            workflowAttachmentFiles({
              orgId: auth.orgId,
              workflowId: sourceWorkflow.id,
              attachments: sourceWorkflow.attachments,
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

    const visible = await set(
      loadVisibleWorkflowById$,
      {
        orgId: auth.orgId,
        member,
        workflowId: params.workflowId,
      },
      signal,
    );
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

  const visible = await set(
    loadVisibleWorkflowById$,
    {
      orgId: auth.orgId,
      member,
      workflowId: params.workflowId,
    },
    signal,
  );
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
  if (workflow.officialDefinitionName !== null) {
    return conflict(OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE);
  }

  const currentTime = nowDate();
  const apiStartTime = currentTime.getTime();
  const timing = new ApiDispatchTimingCollector();
  const mappedChatThreadId = await (async () => {
    const startedAt = performance.now();
    return await (async () => {
      return await set(
        loadWorkflowUserAutomationThreadId$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          workflowId: workflow.id,
        },
        signal,
      );
    })().finally(() => {
      timing.recordDuration(
        "api_dispatch_pre_create_agent_workflow_slash_load_thread_mapping",
        "nested",
        performance.now() - startedAt,
        now(),
      );
    });
  })();
  signal.throwIfAborted();
  const chatThreadId =
    mappedChatThreadId ??
    (await (async () => {
      const startedAt = performance.now();
      return await (async () => {
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
      })().finally(() => {
        timing.recordDuration(
          "api_dispatch_pre_create_agent_workflow_slash_ensure_thread",
          "nested",
          performance.now() - startedAt,
          now(),
        );
      });
    })());
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
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status !== 201) {
    return result;
  }

  return {
    status: 200 as const,
    body: { chatThreadId: result.body.threadId, runId: null },
  };
});

interface VisibilityTransition {
  readonly workflow: WorkflowRow;
  readonly agent: WorkflowAgentInfo;
  readonly member: WorkflowMember;
}

const workflowVisibilityPublicationRow = object({
  changed: boolean(),
  guard: literal(0),
});

function isWorkflowVisibilityGenerationChange(error: unknown): boolean {
  return (
    error instanceof DrizzleQueryError &&
    error.cause instanceof Error &&
    "code" in error.cause &&
    error.cause.code === "22P02" &&
    error.cause.message ===
      `invalid input syntax for type integer: "${workflowVisibilityGenerationChanged}"`
  );
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
  ): Promise<boolean | ReturnType<typeof conflict>> => {
    const db = set(writeDb$);
    const query = workflowVisibilityPublicationSql(args, nowDate());
    const visibilityChanged = await settle(
      (async () => {
        const result = await settle(
          (async () => {
            return parseRawRows(
              workflowVisibilityPublicationRow,
              await db.execute(query),
            );
          })(),
        );
        if (!result.ok) {
          if (isWorkflowVisibilityGenerationChange(result.error)) {
            return false;
          }
          throw result.error;
        }
        const row = result.value[0];
        if (!row) {
          throw new Error("Workflow visibility publication returned no row");
        }
        return row.changed;
      })(),
      signal,
    );
    if (!visibilityChanged.ok) {
      if (
        !isOrdinaryWorkflowNameConflict(
          visibilityChanged.error,
          args.visibility,
        )
      ) {
        throw visibilityChanged.error;
      }
      return workflowSlugConflict(args.visibility, args.workflow.name);
    }
    signal.throwIfAborted();
    return visibilityChanged.value;
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
  if (typeof updated !== "boolean") {
    return updated;
  }
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
  if (typeof updated !== "boolean") {
    return updated;
  }
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
