import { DEFAULT_AGENT_NAME } from "./default-agent-profile";
import { executionAgentId } from "./execution-agent";
import { computed, type Computed } from "ccstate";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { agents } from "@okouai/db/schema/agent";
import { and, count, desc, eq, or } from "drizzle-orm";
import { agentAvatarUrlForDefaultAgent } from "@okouai/core/agent-avatar";
import { agentDisplayName } from "@okouai/core/brand-presentation";

import { db$ } from "../external/db";

export function agentResponse(row: {
  readonly agentId: string;
  readonly defaultAgentId: string | null;
  readonly owner: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly sound: string | null;
  readonly avatarUrl: string | null;
  readonly visibility: "public" | "private";
}): AgentResponse {
  return {
    agentId: row.agentId,
    isDefaultAgent: row.agentId === row.defaultAgentId,
    ownerId: row.owner,
    displayName: agentDisplayName({
      agentId: row.agentId,
      defaultAgentId: row.defaultAgentId,
      displayName: row.displayName,
    }),
    description: row.description,
    sound: row.sound,
    avatarUrl: agentAvatarUrlForDefaultAgent({
      agentId: row.agentId,
      defaultAgentId: row.defaultAgentId,
      avatarUrl: row.avatarUrl,
    }),
    visibility: row.visibility,
  };
}

export function publicAgentCountReadPlan(orgId: string) {
  return {
    selection: { value: count() },
    condition: and(eq(agents.orgId, orgId), eq(agents.visibility, "public")),
  };
}

export function sharedExecutorCondition(orgId: string) {
  return and(
    eq(agents.orgId, orgId),
    eq(agents.name, DEFAULT_AGENT_NAME),
    eq(agents.visibility, "public"),
  );
}

function visibleAgentCondition(userId: string) {
  return or(eq(agents.visibility, "public"), eq(agents.owner, userId));
}

export function visibleJoinedAgentCondition(userId: string) {
  return visibleAgentCondition(userId);
}

export function visibleAgentIdentityCondition(scope: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}) {
  return and(
    eq(agents.orgId, scope.orgId),
    eq(agents.id, scope.agentId),
    visibleAgentCondition(scope.userId),
  );
}

export function agentList(
  orgId: string,
  userId: string,
): Computed<Promise<readonly AgentResponse[]>> {
  return computed(async (get): Promise<readonly AgentResponse[]> => {
    const rows = await get(db$)
      .select({
        agentId: agents.id,
        defaultAgentId: executionAgentId(agents.orgId),
        owner: agents.owner,
        displayName: agents.displayName,
        description: agents.description,
        sound: agents.sound,
        avatarUrl: agents.avatarUrl,
        visibility: agents.visibility,
      })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), visibleAgentCondition(userId)))
      .orderBy(desc(agents.updatedAt));

    return rows.map((row) => {
      return agentResponse(row);
    });
  });
}
