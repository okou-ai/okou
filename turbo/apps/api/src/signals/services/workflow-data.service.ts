import { executionAgentId } from "./execution-agent";
import { command, computed, type Computed } from "ccstate";
import type { WorkflowAttachments } from "@okouai/db/jsonb-contracts/workflow";
import type {
  WorkflowImportSource,
  WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { agents } from "@okouai/db/schema/agent";
import { workflows } from "@okouai/db/schema/workflow";
import { and, asc, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";

import { db$ } from "../external/db";
import { pgTextDecoder } from "../../lib/db-structured-result";
import {
  acceptedOfficialWorkflowCatalogReadPlan,
  acceptedCatalogFromRow,
} from "./official-workflow-catalog-read.service";
import {
  officialWorkflowCatalogState,
  officialWorkflowCatalogReleases,
} from "@okouai/db/schema/official-workflow-catalog";

export interface WorkflowMember {
  readonly userId: string;
  readonly role: string;
}

export interface WorkflowRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly instruction: string | null;
  readonly attachments: WorkflowAttachments | null;
  readonly contentBundle: (typeof workflows.$inferSelect)["contentBundle"];
  readonly ownerUserId: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly officialDefinitionName: string | null;
  readonly officialInstallationState: "installing" | "installed" | null;
  readonly importSource: WorkflowImportSource | null;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type WorkflowSummaryRow = Pick<
  WorkflowRow,
  | "id"
  | "name"
  | "visibility"
  | "ownerUserId"
  | "displayName"
  | "description"
  | "officialDefinitionName"
  | "officialInstallationState"
  | "importSource"
  | "createdAt"
>;

/**
 * Execution profile fields retained for existing API consumers.
 */
export type WorkflowAgentInfo = Pick<
  typeof agents.$inferSelect,
  "id" | "name" | "displayName"
>;

export function workflowExecutionProfileColumns() {
  return { id: agents.id, name: agents.name, displayName: agents.displayName };
}

interface WorkflowShadow {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

/**
 * Whether the caller may edit, delete, or demote the workflow.
 * - private: owner only.
 * - public: workflow owner or a workspace admin.
 */
function canManageWorkflow(
  workflow: WorkflowSummaryRow,
  member: WorkflowMember,
): boolean {
  if (workflow.officialDefinitionName !== null) {
    return false;
  }
  if (workflow.visibility === "private") {
    return workflow.ownerUserId === member.userId;
  }
  return workflow.ownerUserId === member.userId || member.role === "admin";
}

function canPublishWorkflow(
  workflow: WorkflowSummaryRow,
  member: WorkflowMember,
): boolean {
  if (workflow.officialDefinitionName !== null) {
    return false;
  }
  return (
    workflow.visibility === "private" &&
    workflow.ownerUserId === member.userId &&
    member.role === "admin"
  );
}

export function requireWorkflowPermission(
  workflow: WorkflowRow,
  member: WorkflowMember,
  action: string,
) {
  if (canManageWorkflow(workflow, member)) {
    return null;
  }
  const ownerLabel =
    workflow.visibility === "private"
      ? "the private workflow owner"
      : "the workflow owner or workspace admin";
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

/** The caller supplies the workspace boundary for this visibility predicate. */
export function visibleWorkflowCondition(member: WorkflowMember): SQL {
  return and(
    or(
      isNull(workflows.officialDefinitionName),
      eq(workflows.officialInstallationState, "installed"),
    ),
    or(
      eq(workflows.visibility, "public"),
      eq(workflows.ownerUserId, member.userId),
    ),
  ) as SQL;
}

export interface VisibleWorkflow {
  readonly workflow: WorkflowRow;
  readonly agent: WorkflowAgentInfo | null;
}

export const loadVisibleWorkflowById$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly workflowId: string;
      readonly includeInstallingOfficial?: boolean;
    },
    signal: AbortSignal,
  ): Promise<(VisibleWorkflow & { readonly observedXmin: string }) | null> => {
    const [row] = await get(db$)
      .select({
        workflow: workflows,
        observedXmin: sql`${workflows}.xmin::text`.mapWith(pgTextDecoder),
        agent: workflowExecutionProfileColumns(),
      })
      .from(workflows)
      .leftJoin(
        agents,
        eq(agents.id, executionAgentId(workflows.orgId, args.member.userId)),
      )
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

    signal.throwIfAborted();

    if (!row) {
      return null;
    }
    return {
      workflow: row.workflow,
      agent: row.agent,
      observedXmin: row.observedXmin,
    };
  },
);

export function workflowSummary(args: {
  readonly workflow: WorkflowSummaryRow;
  readonly agent: WorkflowAgentInfo | null;
  readonly member: WorkflowMember;
  readonly shadowedBy?: WorkflowShadow | null;
  readonly officialDefinitionLifecycle?: "active" | "retired" | "unavailable";
}): WorkflowSummary {
  return {
    id: args.workflow.id,
    agentId: args.agent?.id ?? null,
    agentName: args.agent?.name ?? null,
    agentDisplayName: args.agent?.displayName ?? null,
    name: args.workflow.name,
    displayName: args.workflow.displayName,
    description: args.workflow.description,
    visibility: args.workflow.visibility,
    ownerUserId: args.workflow.ownerUserId,
    createdAt: args.workflow.createdAt.toISOString(),
    canManage: canManageWorkflow(args.workflow, args.member),
    canPublish: canPublishWorkflow(args.workflow, args.member),
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
    importSource: args.workflow.importSource,
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
    const key = row.workflow.name;
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

export const readWorkflowShadowWinner$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly workflow: WorkflowRow;
    },
    signal: AbortSignal,
  ): Promise<WorkflowShadow | null> => {
    const db = get(db$);
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
          eq(workflows.name, args.workflow.name),
          injectableWorkflowCondition(args.member.userId),
        ),
      )
      .orderBy(...workflowRunPrioritySort(args.member.userId))
      .limit(1);

    signal.throwIfAborted();
    if (!winner || winner.id === args.workflow.id) {
      return null;
    }
    return winner;
  },
);

export function workflowList(args: {
  readonly orgId: string;
  readonly member: WorkflowMember;
}): Computed<Promise<readonly WorkflowSummary[]>> {
  return computed(async (get): Promise<readonly WorkflowSummary[]> => {
    const db = get(db$);
    const rows = await db
      .select({
        workflow: {
          id: workflows.id,
          name: workflows.name,
          visibility: workflows.visibility,
          ownerUserId: workflows.ownerUserId,
          displayName: workflows.displayName,
          description: workflows.description,
          officialDefinitionName: workflows.officialDefinitionName,
          officialInstallationState: workflows.officialInstallationState,
          importSource: workflows.importSource,
          createdAt: workflows.createdAt,
        },
        agent: workflowExecutionProfileColumns(),
      })
      .from(workflows)
      .leftJoin(
        agents,
        eq(agents.id, executionAgentId(workflows.orgId, args.member.userId)),
      )
      .where(
        and(
          eq(workflows.orgId, args.orgId),
          visibleWorkflowCondition(args.member),
        ),
      )
      .orderBy(asc(workflows.name));

    const hasOfficialWorkflow = rows.some((row) => {
      return row.workflow.officialDefinitionName !== null;
    });
    const catalogPlan = acceptedOfficialWorkflowCatalogReadPlan();
    const [catalogRow] = hasOfficialWorkflow
      ? await db
          .select(catalogPlan.columns)
          .from(officialWorkflowCatalogState)
          .innerJoin(officialWorkflowCatalogReleases, catalogPlan.join)
          .where(catalogPlan.condition)
          .limit(1)
      : [];
    const acceptedCatalog = acceptedCatalogFromRow(catalogRow);
    const officialLifecycleByName = new Map(
      acceptedCatalog?.payload.definitions.map((definition) => {
        return [definition.name, definition.lifecycle] as const;
      }) ?? [],
    );

    const winners = shadowWinnerFromRows(rows, args.member);
    return rows.map((row) => {
      const key = row.workflow.name;
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
