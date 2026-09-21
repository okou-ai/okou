import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { and, count, eq, gte, or } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

/**
 * The agent a skill import session writes to: the org's default agent, but only
 * when the requesting user can see it. A private default agent owned by someone
 * else resolves to null, so the session is refused instead of minting a token
 * whose uploads would all be rejected.
 */
export async function resolveSkillImportAgentId(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
): Promise<string | null> {
  const [row] = await db
    .select({ agentId: agents.id })
    .from(orgMetadata)
    .innerJoin(
      agents,
      and(
        eq(agents.id, orgMetadata.defaultAgentId),
        eq(agents.orgId, orgMetadata.orgId),
      ),
    )
    .where(
      and(
        eq(orgMetadata.orgId, args.orgId),
        or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
      ),
    )
    .limit(1);

  return row?.agentId ?? null;
}

/**
 * Skills the session has already created. There is no session table: the cap is
 * derived from the workflows this user created on this agent since the token
 * was issued.
 */
export async function countSkillsImportedInSession(
  db: ReadonlyDb,
  args: {
    readonly agentId: string;
    readonly userId: string;
    readonly since: Date;
  },
): Promise<number> {
  const [row] = await db
    .select({ imported: count() })
    .from(workflows)
    .where(
      and(
        eq(workflows.agentId, args.agentId),
        eq(workflows.createdBy, args.userId),
        gte(workflows.createdAt, args.since),
      ),
    );

  return row?.imported ?? 0;
}

/**
 * The caller's own private workflow under this slug, if any. A repeated import
 * of the same skill is reported as skipped rather than duplicated or
 * overwritten.
 */
export async function findOwnPrivateWorkflowIdByName(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly ownerUserId: string;
    readonly name: string;
  },
): Promise<string | null> {
  const [row] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.agentId, args.agentId),
        eq(workflows.ownerUserId, args.ownerUserId),
        eq(workflows.name, args.name),
        eq(workflows.visibility, "private"),
      ),
    )
    .limit(1);

  return row?.id ?? null;
}
