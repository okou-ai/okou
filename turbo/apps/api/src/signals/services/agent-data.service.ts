import { computed, type Computed } from "ccstate";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { agents } from "@okouai/db/schema/agent";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { agentAvatarUrlForDefaultAgent } from "@okouai/core/agent-avatar";
import { agentDisplayName } from "@okouai/core/public-brand";

import { db$ } from "../external/db";

export function agentResponse(row: {
  readonly agentId: string;
  readonly defaultAgentId: string | null;
  readonly owner: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly sound: string | null;
  readonly avatarUrl: string | null;
  readonly modelProviderId: string | null;
  readonly selectedModel: string | null;
  readonly preferPersonalProvider: boolean;
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
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: row.visibility,
  };
}

function visibleAgentCondition(userId: string) {
  return or(eq(agents.visibility, "public"), eq(agents.owner, userId));
}

export function visibleJoinedAgentCondition(userId: string) {
  return visibleAgentCondition(userId);
}

export function agentExists(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const [agent] = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, args.orgId),
          eq(agents.id, args.agentId),
          visibleAgentCondition(args.userId),
        ),
      )
      .limit(1);

    return Boolean(agent);
  });
}

export function agentList(
  orgId: string,
  userId: string,
): Computed<Promise<readonly AgentResponse[]>> {
  return computed(async (get): Promise<readonly AgentResponse[]> => {
    const rows = await get(db$)
      .select({
        agentId: agents.id,
        defaultAgentId: orgMetadata.defaultAgentId,
        owner: agents.owner,
        displayName: agents.displayName,
        description: agents.description,
        sound: agents.sound,
        avatarUrl: agents.avatarUrl,
        modelProviderId: agents.modelProviderId,
        selectedModel: agents.selectedModel,
        preferPersonalProvider: agents.preferPersonalProvider,
        visibility: agents.visibility,
      })
      .from(agents)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
      .where(and(eq(agents.orgId, orgId), visibleAgentCondition(userId)))
      .orderBy(desc(agents.updatedAt));

    return rows.map((row) => {
      return agentResponse(row);
    });
  });
}

export function agentDetail(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<Promise<AgentResponse | null>> {
  return computed(async (get): Promise<AgentResponse | null> => {
    const [row] = await get(db$)
      .select({
        agentId: agents.id,
        defaultAgentId: orgMetadata.defaultAgentId,
        owner: agents.owner,
        displayName: agents.displayName,
        description: agents.description,
        sound: agents.sound,
        avatarUrl: agents.avatarUrl,
        modelProviderId: agents.modelProviderId,
        selectedModel: agents.selectedModel,
        preferPersonalProvider: agents.preferPersonalProvider,
        visibility: agents.visibility,
      })
      .from(agents)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
      .where(
        and(
          eq(agents.orgId, args.orgId),
          eq(agents.id, args.agentId),
          visibleAgentCondition(args.userId),
        ),
      )
      .limit(1);

    return row ? agentResponse(row) : null;
  });
}

export function agentEnabledConnectorSlugs(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<Promise<readonly ConnectorSlug[]>> {
  return computed(async (get): Promise<readonly ConnectorSlug[]> => {
    const rows = await get(db$)
      .select({ connectorSlug: userBuiltinConnectors.connectorSlug })
      .from(userBuiltinConnectors)
      .where(
        and(
          eq(userBuiltinConnectors.orgId, args.orgId),
          eq(userBuiltinConnectors.userId, args.userId),
          eq(userBuiltinConnectors.agentId, args.agentId),
        ),
      )
      .orderBy(asc(userBuiltinConnectors.connectorSlug));

    return rows.map((row) => {
      return connectorSlugSchema.parse(row.connectorSlug);
    });
  });
}

export function agentCustomConnectorGrants(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<Promise<readonly AgentCustomConnectorGrant[]>> {
  return computed(
    async (get): Promise<readonly AgentCustomConnectorGrant[]> => {
      const rows = await get(db$)
        .select({
          customConnectorId: userCustomConnectors.customConnectorId,
          permissionNames: userCustomConnectors.permissionNames,
        })
        .from(userCustomConnectors)
        .innerJoin(
          orgCustomConnectors,
          and(
            eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
            eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
          ),
        )
        .where(
          and(
            eq(userCustomConnectors.orgId, args.orgId),
            eq(userCustomConnectors.userId, args.userId),
            eq(userCustomConnectors.agentId, args.agentId),
            eq(orgCustomConnectors.enabled, true),
          ),
        )
        .orderBy(asc(userCustomConnectors.customConnectorId));

      return rows.map((row) => {
        return {
          customConnectorId: row.customConnectorId,
          permissionNames: [...row.permissionNames],
        };
      });
    },
  );
}
