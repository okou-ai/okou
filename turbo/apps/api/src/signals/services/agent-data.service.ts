import { DEFAULT_AGENT_NAME } from "./default-agent-profile";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { computed, type Computed } from "ccstate";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { legacyAgentApiProfiles } from "@okouai/db/schema/legacy-agent-api-profile";
import { and, count, desc, eq, or, sql } from "drizzle-orm";
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
    condition: and(
      eq(legacyAgentApiProfiles.orgId, orgId),
      eq(legacyAgentApiProfiles.visibility, "public"),
    ),
  };
}

const isDefaultProfile = and(
  eq(legacyAgentApiProfiles.name, DEFAULT_AGENT_NAME),
  eq(legacyAgentApiProfiles.visibility, "public"),
);

export const defaultProfileId =
  sql`CASE WHEN ${isDefaultProfile} THEN ${legacyAgentApiProfiles.id} END`.mapWith(
    nullableDriverValueDecoder(legacyAgentApiProfiles.id),
  );

export function defaultProfileCondition(orgId: string) {
  return and(eq(legacyAgentApiProfiles.orgId, orgId), isDefaultProfile);
}

function visibleAgentCondition(userId: string) {
  return or(
    eq(legacyAgentApiProfiles.visibility, "public"),
    eq(legacyAgentApiProfiles.owner, userId),
  );
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
    eq(legacyAgentApiProfiles.orgId, scope.orgId),
    eq(legacyAgentApiProfiles.id, scope.agentId),
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
        agentId: legacyAgentApiProfiles.id,
        defaultAgentId: defaultProfileId,
        owner: legacyAgentApiProfiles.owner,
        displayName: legacyAgentApiProfiles.displayName,
        description: legacyAgentApiProfiles.description,
        sound: legacyAgentApiProfiles.sound,
        avatarUrl: legacyAgentApiProfiles.avatarUrl,
        visibility: legacyAgentApiProfiles.visibility,
      })
      .from(legacyAgentApiProfiles)
      .where(
        and(
          eq(legacyAgentApiProfiles.orgId, orgId),
          visibleAgentCondition(userId),
        ),
      )
      .orderBy(desc(legacyAgentApiProfiles.updatedAt));

    return rows.map((row) => {
      return agentResponse(row);
    });
  });
}
