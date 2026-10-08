import { command } from "ccstate";
import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { storages } from "@okouai/db/schema/storage";
import { workflows } from "@okouai/db/schema/workflow";
import { userExportEntries } from "@okouai/db/schema/user-export-entry";
import { clerk$, createClerkReadContext } from "../external/clerk";
import { listAllUserOrganizationMemberships } from "../external/clerk-organization-lists";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { db$ } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { visibleWorkflowCondition } from "./workflow-data.service";

function identifiers(
  rows: readonly { readonly metadata: Record<string, unknown> }[],
  key: string,
): string[] {
  return [
    ...new Set(
      rows.flatMap((row) => {
        const value = row.metadata[key];
        return typeof value === "string" ? [value] : [];
      }),
    ),
  ];
}
function requireAll(
  actual: readonly unknown[],
  expected: readonly string[],
): void {
  if (actual.length !== expected.length) {
    throw new Error("Access to an exported resource changed during collection");
  }
}

/** Recheck current product visibility before publishing a long-running export. */
export const authorizeUserExportPage$ = command(
  async (
    { get },
    args: {
      readonly jobId: string;
      readonly userId: string;
      readonly cursor: number;
    },
    signal: AbortSignal,
  ): Promise<{ readonly cursor: number; readonly done: boolean }> => {
    const db = get(db$);
    const { userId } = args;
    const rows = await db
      .select({
        ordinal: userExportEntries.ordinal,
        metadata: userExportEntries.metadata,
      })
      .from(userExportEntries)
      .where(
        and(
          eq(userExportEntries.jobId, args.jobId),
          gt(userExportEntries.ordinal, args.cursor - 1),
        ),
      )
      .orderBy(asc(userExportEntries.ordinal))
      .limit(100);
    signal.throwIfAborted();
    const agentIds = identifiers(
      rows.filter((row) => {
        return row.metadata.sourceKind === "agent";
      }),
      "agentId",
    );
    const workflowIds = identifiers(rows, "workflowId");
    const threadIds = identifiers(rows, "threadId");
    const storageIds = identifiers(rows, "storageId");
    if (agentIds.length > 0 || workflowIds.length > 0) {
      const memberships = await listAllUserOrganizationMemberships(
        get(clerk$).users,
        userId,
        createClerkReadContext(),
        signal,
      );
      signal.throwIfAborted();
      const orgIds = memberships.map((membership) => {
        return membership.organization.id;
      });
      if (agentIds.length > 0) {
        const visible = await db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              inArray(agents.id, agentIds),
              inArray(agents.orgId, orgIds),
              visibleJoinedAgentCondition(userId),
            ),
          );
        signal.throwIfAborted();
        requireAll(visible, agentIds);
      }
      if (workflowIds.length > 0) {
        const visible = await db
          .select({ id: workflows.id })
          .from(workflows)
          .innerJoin(agents, eq(agents.id, workflows.agentId))
          .where(
            and(
              inArray(workflows.id, workflowIds),
              inArray(workflows.orgId, orgIds),
              visibleWorkflowCondition({ userId, role: "member" }),
            ),
          );
        signal.throwIfAborted();
        requireAll(visible, workflowIds);
      }
    }
    if (threadIds.length > 0) {
      const owned = await db
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(
          and(
            inArray(chatThreads.id, threadIds),
            eq(chatThreads.userId, userId),
          ),
        );
      signal.throwIfAborted();
      requireAll(owned, threadIds);
    }
    if (storageIds.length > 0) {
      const owned = await db
        .select({ id: storages.id })
        .from(storages)
        .where(
          and(inArray(storages.id, storageIds), eq(storages.userId, userId)),
        );
      signal.throwIfAborted();
      requireAll(owned, storageIds);
    }
    return {
      cursor: (rows.at(-1)?.ordinal ?? args.cursor - 1) + 1,
      done: rows.length < 100,
    };
  },
);

interface PublicationAuthority {
  readonly jobId: string;
  readonly userId: string;
  readonly orgIds: readonly string[];
}

export const currentUserExportMemberships$ = command(
  async (
    { get },
    userId: string,
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    const memberships = await listAllUserOrganizationMemberships(
      get(clerk$).users,
      userId,
      createClerkReadContext(),
      signal,
    );
    signal.throwIfAborted();
    return memberships.map((membership) => {
      return membership.organization.id;
    });
  },
);

function authorityIds(
  args: PublicationAuthority,
  kinds: readonly string[],
  field: string,
) {
  return new QueryBuilder()
    .selectDistinct({
      id: sql`(${userExportEntries.metadata}->>${field})::uuid`,
    })
    .from(userExportEntries)
    .where(
      and(
        eq(userExportEntries.jobId, args.jobId),
        inArray(sql`${userExportEntries.metadata}->>'sourceKind'`, kinds),
      ),
    );
}

/** Re-entry must always reacquire this terminal authority, never trust a saved authorization cursor. */
export function userExportPublicationChecks(
  args: PublicationAuthority,
): readonly { readonly expected: SQL; readonly readable: SQL }[] {
  const db = new QueryBuilder();
  const checks: { readonly expected: SQL; readonly readable: SQL }[] = [];
  const agentIds = authorityIds(args, ["agent"], "agentId");
  checks.push({
    expected: agentIds.getSQL(),
    readable: db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          inArray(agents.id, agentIds),
          inArray(agents.orgId, args.orgIds),
          visibleJoinedAgentCondition(args.userId),
        ),
      )
      .orderBy(asc(agents.id))
      .for("share")
      .getSQL(),
  });
  const workflowIds = authorityIds(args, ["workflow"], "workflowId");
  checks.push({
    expected: workflowIds.getSQL(),
    readable: db
      .select({ id: workflows.id })
      .from(workflows)
      .innerJoin(agents, eq(agents.id, workflows.agentId))
      .where(
        and(
          inArray(workflows.id, workflowIds),
          inArray(workflows.orgId, args.orgIds),
          visibleWorkflowCondition({ userId: args.userId, role: "member" }),
        ),
      )
      .orderBy(asc(workflows.id))
      .for("share", { of: [workflows, agents] })
      .getSQL(),
  });
  const threadIds = authorityIds(
    args,
    ["chat-thread", "chat-snapshot", "chat-tail"],
    "threadId",
  );
  checks.push({
    expected: threadIds.getSQL(),
    readable: db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          inArray(chatThreads.id, threadIds),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .orderBy(asc(chatThreads.id))
      .for("share")
      .getSQL(),
  });
  const storageIds = authorityIds(args, ["memory"], "storageId");
  checks.push({
    expected: storageIds.getSQL(),
    readable: db
      .select({ id: storages.id })
      .from(storages)
      .where(
        and(inArray(storages.id, storageIds), eq(storages.userId, args.userId)),
      )
      .orderBy(asc(storages.id))
      .for("share")
      .getSQL(),
  });
  return checks;
}
