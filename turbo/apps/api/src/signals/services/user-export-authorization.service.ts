import { command, computed } from "ccstate";
import { and, asc, count, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { storages } from "@okouai/db/schema/storage";
import { workflows } from "@okouai/db/schema/workflow";
import { userExportEntries } from "@okouai/db/schema/user-export-entry";
import { clerk$, createClerkReadContext } from "../external/clerk";
import { listAllUserOrganizationMemberships } from "../external/clerk-organization-lists";
import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
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
      readonly db: Db;
      readonly jobId: string;
      readonly userId: string;
      readonly cursor: number;
    },
    signal: AbortSignal,
  ): Promise<{ readonly cursor: number; readonly done: boolean }> => {
    const { db, userId } = args;
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

export function currentUserExportMemberships(
  userId: string,
  signal: AbortSignal,
) {
  return computed(async (get): Promise<readonly string[]> => {
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
  });
}

type AuthorityDb = Pick<Tx, "select" | "selectDistinct">;

function authorityIds(
  db: AuthorityDb,
  args: PublicationAuthority,
  kinds: readonly string[],
  field: string,
) {
  return db
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

async function requireLockedResources(
  db: AuthorityDb,
  ids: SQL,
  readable: SQL,
  signal: AbortSignal,
): Promise<void> {
  // Aggregate in PostgreSQL so the terminal fence does not load every source
  // into the function. Share locks prevent a visibility/ownership write from
  // committing between this check and the publication in the same transaction.
  const [expected] = await db
    .select({ count: count() })
    .from(sql`(${ids}) expected_resources`);
  signal.throwIfAborted();
  const [actual] = await db
    .select({ count: count() })
    .from(sql`(${readable}) locked_resources`);
  signal.throwIfAborted();
  if (!expected || !actual) {
    throw new Error("Publication authority count query returned no row");
  }
  if (expected.count !== actual.count) {
    throw new Error(
      "Access to an exported resource changed before publication",
    );
  }
}

/** Re-entry must always reacquire this terminal authority, never trust a saved authorization cursor. */
export async function lockUserExportPublicationAuthority(
  db: AuthorityDb,
  args: PublicationAuthority,
  signal: AbortSignal,
): Promise<void> {
  const agentIds = authorityIds(db, args, ["agent"], "agentId");
  await requireLockedResources(
    db,
    agentIds.getSQL(),
    db
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
    signal,
  );
  const workflowIds = authorityIds(db, args, ["workflow"], "workflowId");
  await requireLockedResources(
    db,
    workflowIds.getSQL(),
    db
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
    signal,
  );
  const threadIds = authorityIds(
    db,
    args,
    ["chat-thread", "chat-snapshot", "chat-tail"],
    "threadId",
  );
  await requireLockedResources(
    db,
    threadIds.getSQL(),
    db
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
    signal,
  );
  const storageIds = authorityIds(db, args, ["memory"], "storageId");
  await requireLockedResources(
    db,
    storageIds.getSQL(),
    db
      .select({ id: storages.id })
      .from(storages)
      .where(
        and(inArray(storages.id, storageIds), eq(storages.userId, args.userId)),
      )
      .orderBy(asc(storages.id))
      .for("share")
      .getSQL(),
    signal,
  );
}
