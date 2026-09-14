import { computed, type Computed } from "ccstate";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";
import { agents } from "@okouai/db/schema/agent";
import { workflows } from "@okouai/db/schema/workflow";
import { and, asc, desc, eq, isNull, or, type SQL } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { readAcceptedOfficialWorkflowCatalog } from "./official-workflow-catalog-read.service";

export interface WorkflowMember {
  readonly userId: string;
  readonly role: string;
}

export interface WorkflowRow {
  readonly id: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly instruction: string | null;
  readonly ownerUserId: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly officialDefinitionName: string | null;
  readonly officialInstallationState: "installing" | "installed" | null;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type WorkflowSummaryRow = Pick<
  WorkflowRow,
  | "id"
  | "agentId"
  | "name"
  | "visibility"
  | "ownerUserId"
  | "displayName"
  | "description"
  | "officialDefinitionName"
  | "officialInstallationState"
  | "createdAt"
>;

/**
 * The host agent's identity fields needed to evaluate workflow management.
 */
export interface WorkflowAgentInfo {
  readonly id: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly name: string;
  readonly displayName: string | null;
}

interface VisibleWorkflowAgentInfo extends WorkflowAgentInfo {
  readonly orgId: string;
}

interface WorkflowShadow {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

/**
 * Whether the caller may edit/delete the workflow's content.
 * - private: owner only (agent admins cannot even see private workflows).
 * - public: whoever has write-permission on the host agent.
 */
function canManageWorkflow(
  workflow: WorkflowSummaryRow,
  agent: WorkflowAgentInfo,
  member: WorkflowMember,
): boolean {
  if (workflow.officialDefinitionName !== null) {
    return false;
  }
  if (workflow.visibility === "private") {
    return workflow.ownerUserId === member.userId;
  }
  return (
    requireAgentPermission(agent.owner, member, "manage", {
      visibility: agent.visibility,
    }) === null
  );
}

function canPublishWorkflow(
  workflow: WorkflowSummaryRow,
  agent: WorkflowAgentInfo,
  member: WorkflowMember,
): boolean {
  if (workflow.officialDefinitionName !== null) {
    return false;
  }
  return (
    workflow.visibility === "private" &&
    workflow.ownerUserId === member.userId &&
    requireAgentPermission(agent.owner, member, "publish", {
      visibility: agent.visibility,
    }) === null
  );
}

export function requireWorkflowPermission(
  workflow: WorkflowRow,
  agent: WorkflowAgentInfo,
  member: WorkflowMember,
  action: string,
) {
  if (canManageWorkflow(workflow, agent, member)) {
    return null;
  }
  const ownerLabel =
    workflow.visibility === "private"
      ? "the private workflow owner"
      : "an agent owner or org admin";
  return {
    status: 403 as const,
    body: {
      error: {
        message: `Only ${ownerLabel} can ${action}`,
        code: "FORBIDDEN" as const,
      },
    },
  };
}

/**
 * SQL visibility predicate over a (workflow JOIN agent) row for the given
 * member: public workflows on a visible agent, and the caller's own workflows.
 *
 * A public workflow only counts as "public" to the caller when its owning agent
 * is itself visible (public agent, or one the caller owns). A public workflow
 * parked under another user's private agent must stay hidden, so that resolving
 * it returns 404 rather than leaking the agent's existence via a 403.
 */
export function visibleWorkflowCondition(member: WorkflowMember): SQL {
  const agentVisibleToMember = or(
    eq(agents.visibility, "public"),
    eq(agents.owner, member.userId),
  );

  const publicWorkflowOnVisibleAgent = and(
    eq(workflows.visibility, "public"),
    agentVisibleToMember,
  );

  return and(
    or(
      isNull(workflows.officialDefinitionName),
      eq(workflows.officialInstallationState, "installed"),
    ),
    or(publicWorkflowOnVisibleAgent, eq(workflows.ownerUserId, member.userId)),
  ) as SQL;
}

export async function loadVisibleWorkflowById(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly workflowId: string;
    readonly includeInstallingOfficial?: boolean;
  },
): Promise<{ workflow: WorkflowRow; agent: VisibleWorkflowAgentInfo } | null> {
  const [row] = await db
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
        args.includeInstallingOfficial
          ? or(
              visibleWorkflowCondition(args.member),
              and(
                eq(workflows.ownerUserId, args.member.userId),
                eq(workflows.officialInstallationState, "installing"),
              ),
            )
          : visibleWorkflowCondition(args.member),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }
  return { workflow: row.workflow, agent: row.agent };
}

export function workflowSummary(args: {
  readonly workflow: WorkflowSummaryRow;
  readonly agent: WorkflowAgentInfo;
  readonly member: WorkflowMember;
  readonly shadowedBy?: WorkflowShadow | null;
  readonly officialDefinitionLifecycle?: "active" | "retired" | "unavailable";
}): WorkflowSummary {
  return {
    id: args.workflow.id,
    agentId: args.workflow.agentId,
    agentName: args.agent.name,
    agentDisplayName: args.agent.displayName,
    name: args.workflow.name,
    displayName: args.workflow.displayName,
    description: args.workflow.description,
    visibility: args.workflow.visibility,
    ownerUserId: args.workflow.ownerUserId,
    createdAt: args.workflow.createdAt.toISOString(),
    canManage: canManageWorkflow(args.workflow, args.agent, args.member),
    canPublish: canPublishWorkflow(args.workflow, args.agent, args.member),
    official:
      args.workflow.officialDefinitionName === null ||
      args.workflow.officialInstallationState === null
        ? null
        : {
            definitionName: args.workflow.officialDefinitionName,
            installationState: args.workflow.officialInstallationState,
            definitionLifecycle:
              args.officialDefinitionLifecycle ?? "unavailable",
            readOnly: true,
          },
    shadowedBy: args.shadowedBy ?? null,
  };
}

function workflowRunPrioritySort(userId: string): SQL[] {
  return [
    desc(
      and(
        eq(workflows.visibility, "private"),
        eq(workflows.ownerUserId, userId),
      ) as SQL,
    ),
    asc(workflows.createdAt),
  ];
}

function injectableWorkflowCondition(userId: string): SQL {
  return and(
    isNull(workflows.officialDefinitionName),
    or(eq(workflows.visibility, "public"), eq(workflows.ownerUserId, userId)),
  ) as SQL;
}

function shadowWinnerFromRows(
  rows: readonly { readonly workflow: WorkflowSummaryRow }[],
  member: WorkflowMember,
): Map<string, WorkflowShadow> {
  const groups = new Map<string, WorkflowSummaryRow[]>();
  for (const row of rows) {
    const key = `${row.workflow.agentId}:${row.workflow.name}`;
    groups.set(key, [...(groups.get(key) ?? []), row.workflow]);
  }

  const winners = new Map<string, WorkflowShadow>();
  for (const [key, workflows] of groups) {
    const winner = workflows
      .filter((workflow) => {
        return (
          workflow.officialDefinitionName === null &&
          (workflow.visibility === "public" ||
            workflow.ownerUserId === member.userId)
        );
      })
      .sort((a, b) => {
        const aPrivateOwner =
          a.visibility === "private" && a.ownerUserId === member.userId;
        const bPrivateOwner =
          b.visibility === "private" && b.ownerUserId === member.userId;
        if (aPrivateOwner !== bPrivateOwner) {
          return aPrivateOwner ? -1 : 1;
        }
        return a.createdAt.getTime() - b.createdAt.getTime();
      })[0];
    if (!winner) {
      continue;
    }
    winners.set(key, {
      id: winner.id,
      name: winner.name,
      displayName: winner.displayName,
    });
  }
  return winners;
}

export async function loadWorkflowShadowWinner(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly workflow: WorkflowRow;
  },
): Promise<WorkflowShadow | null> {
  const [winner] = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      displayName: workflows.displayName,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.agentId, args.workflow.agentId),
        eq(workflows.name, args.workflow.name),
        injectableWorkflowCondition(args.member.userId),
      ),
    )
    .orderBy(...workflowRunPrioritySort(args.member.userId))
    .limit(1);

  if (!winner || winner.id === args.workflow.id) {
    return null;
  }
  return winner;
}

export function workflowList(args: {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly agentId?: string;
}): Computed<Promise<readonly WorkflowSummary[]>> {
  return computed(async (get): Promise<readonly WorkflowSummary[]> => {
    const db = get(db$);
    const rows = await db
      .select({
        workflow: {
          id: workflows.id,
          agentId: workflows.agentId,
          name: workflows.name,
          visibility: workflows.visibility,
          ownerUserId: workflows.ownerUserId,
          displayName: workflows.displayName,
          description: workflows.description,
          officialDefinitionName: workflows.officialDefinitionName,
          officialInstallationState: workflows.officialInstallationState,
          createdAt: workflows.createdAt,
        },
        agent: {
          id: agents.id,
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
          args.agentId ? eq(workflows.agentId, args.agentId) : undefined,
          visibleWorkflowCondition(args.member),
        ),
      )
      .orderBy(asc(workflows.name));

    const hasOfficialWorkflow = rows.some((row) => {
      return row.workflow.officialDefinitionName !== null;
    });
    const acceptedCatalog = hasOfficialWorkflow
      ? await readAcceptedOfficialWorkflowCatalog(db)
      : null;
    const officialLifecycleByName = new Map(
      acceptedCatalog?.payload.definitions.map((definition) => {
        return [definition.name, definition.lifecycle] as const;
      }) ?? [],
    );

    const winners = shadowWinnerFromRows(rows, args.member);
    return rows.map((row) => {
      const key = `${row.workflow.agentId}:${row.workflow.name}`;
      const winner = winners.get(key);
      return workflowSummary({
        workflow: row.workflow,
        agent: row.agent,
        member: args.member,
        shadowedBy:
          winner && winner.id !== row.workflow.id ? winner : undefined,
        officialDefinitionLifecycle: row.workflow.officialDefinitionName
          ? (officialLifecycleByName.get(row.workflow.officialDefinitionName) ??
            "unavailable")
          : undefined,
      });
    });
  });
}

export interface RunWorkflowRef {
  readonly name: string;
  readonly workflowId: string;
  readonly officialDefinitionName: string | null;
}

export interface RunWorkflowSourceRow {
  readonly id: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly ownerUserId: string;
  readonly officialDefinitionName: string | null;
  readonly createdAt: Date;
}

export function workflowsForRunFromRows(
  rows: readonly RunWorkflowSourceRow[],
  userId: string,
): readonly RunWorkflowRef[] {
  const prioritizedRows = [...rows].sort((left, right) => {
    const leftPrivateOwner =
      left.visibility === "private" && left.ownerUserId === userId;
    const rightPrivateOwner =
      right.visibility === "private" && right.ownerUserId === userId;
    if (leftPrivateOwner !== rightPrivateOwner) {
      return leftPrivateOwner ? -1 : 1;
    }
    return (
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id)
    );
  });

  const bySlug = new Map<string, RunWorkflowRef>();
  for (const row of prioritizedRows) {
    if (!bySlug.has(row.name)) {
      bySlug.set(row.name, {
        name: row.name,
        workflowId: row.id,
        officialDefinitionName: row.officialDefinitionName,
      });
    }
  }
  return [...bySlug.values()];
}
