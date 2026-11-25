import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { resourceUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";

// A paused preference must remain accessible to its owner.
export const proactivePreferenceAccess$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "agent") {
      return null;
    }
    const [run] = await get(db$)
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, auth.runId),
          eq(agentRuns.orgId, auth.orgId),
          eq(agentRuns.userId, auth.userId),
          eq(agentRuns.status, "running"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return run
      ? null
      : resourceUnavailable(
          "Proactive settings are available only to a running Okou session.",
        );
  },
);
