import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { resourceUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

// CLI preferences share the Suggestions rollout, independently of whether
// automatic curation is enabled. A paused workflow must remain re-enableable.
export const proactivePreferenceAccess$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "agent") {
      return null;
    }
    const features = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    if (!isFeatureEnabled(FeatureSwitchKey.AgentSuggestion, features)) {
      return resourceUnavailable("Suggestions are not enabled.");
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
