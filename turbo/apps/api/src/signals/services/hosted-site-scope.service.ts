import { agentRuns } from "@okouai/db/runtime/agent-run";
import { hostedSites } from "@okouai/db/schema/hosted-site";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

export class HostedSiteScopeError extends Error {}

/** Lock the run before any site rows, including runs without trigger metadata. */
export async function lockHostedRunChatThreadId(
  tx: Tx,
  runId: string | null | undefined,
): Promise<string | null> {
  // The shipped triggers compare id::text. Preserve that exact match for old
  // text references while using the UUID primary key rather than a table scan.
  if (
    runId === null ||
    runId === undefined ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(runId)
  ) {
    return null;
  }
  const [run] = await tx
    .select({
      chatThreadId: agentRuns.chatThreadId,
      triggerSource: agentRuns.triggerSource,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("share")
    .limit(1);
  return !run || run.triggerSource === null ? null : run.chatThreadId;
}

type SiteScopeInput = Pick<
  typeof hostedSites.$inferInsert,
  "orgId" | "slug" | "requestedSlug" | "chatThreadId" | "createdFromRunId"
>;

/**
 * Use the complete intended scope, then write the returned columns in this
 * transaction. A repair/update must supply the existing site ID; established
 * ownership is checked before deriving a missing owner, just like the trigger.
 */
export async function canonicalizeHostedSiteScope(
  tx: Tx,
  values: SiteScopeInput,
  existingSiteId?: string,
): Promise<{ requestedSlug: string; chatThreadId: string | null }> {
  const derivedChatThreadId =
    values.chatThreadId ??
    (await lockHostedRunChatThreadId(tx, values.createdFromRunId));
  if (existingSiteId !== undefined) {
    const [previous] = await tx
      .select({ chatThreadId: hostedSites.chatThreadId })
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, existingSiteId),
          eq(hostedSites.orgId, values.orgId),
        ),
      )
      .for("update")
      .limit(1);
    if (!previous) {
      throw new Error("Hosted site not found for scope update");
    }
    if (
      previous.chatThreadId !== null &&
      previous.chatThreadId !== (values.chatThreadId ?? null)
    ) {
      throw new HostedSiteScopeError("Hosted site chat ownership is immutable");
    }
  }
  return {
    requestedSlug: values.requestedSlug ?? values.slug,
    chatThreadId: derivedChatThreadId,
  };
}

/** Lock run, then site, and admit the deployment in the caller's transaction. */
export async function assertHostedDeploymentScope(
  tx: Tx,
  args: {
    readonly siteId: string;
    readonly orgId: string;
    readonly runId?: string | null;
  },
): Promise<void> {
  const chatThreadId = await lockHostedRunChatThreadId(tx, args.runId);
  const [site] = await tx
    .select({ chatThreadId: hostedSites.chatThreadId })
    .from(hostedSites)
    .where(
      and(eq(hostedSites.id, args.siteId), eq(hostedSites.orgId, args.orgId)),
    )
    .for("share")
    .limit(1);
  if (!site) {
    throw new Error("Hosted site not found for deployment");
  }
  if (site.chatThreadId !== chatThreadId) {
    throw new HostedSiteScopeError(
      "Hosted site belongs to a different chat; choose another site slug",
    );
  }
}
