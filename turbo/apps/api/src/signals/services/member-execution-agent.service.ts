import { agents } from "@okouai/db/schema/agent";
import { and, eq, or } from "drizzle-orm";
import { sharedExecutorCondition } from "./agent-data.service";
import { executionAgentId, selectedExecutionAgent } from "./execution-agent";
import { computed } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";

export const memberExecutionAgentId$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const [executor] = await get(db$)
    .select()
    .from(selectedExecutionAgent(auth.orgId, auth.userId));
  if (!executor) {
    throw new Error("Member executor is unavailable");
  }
  return executor.id;
});

/** Older clients may send the workspace bootstrap ID or the member's execution ID. */
export function workflowExecutorHintAllowed(id: string) {
  return computed(async (get) => {
    const auth = get(organizationAuthContext$);
    const [permitted] = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, id),
          eq(agents.orgId, auth.orgId),
          or(
            sharedExecutorCondition(auth.orgId),
            eq(agents.id, executionAgentId(auth.orgId, auth.userId)),
          ),
        ),
      )
      .limit(1);
    return permitted !== undefined;
  });
}
