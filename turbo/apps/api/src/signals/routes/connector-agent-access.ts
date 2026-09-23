import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import { connectorAgentAccessContract } from "@okouai/api-contracts/contracts/connector-agent-access";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { agents } from "@okouai/db/schema/agent";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { connectorActionResolver } from "../services/connector-action-resolver.service";

const getConnectorAgentAccess$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(connectorAgentAccessContract.get));
    if (query.builtinSlug && query.customConnectorId) {
      return {
        status: 400 as const,
        body: {
          error: {
            code: "VALIDATION_ERROR" as const,
            message: "Filter by one connector at a time",
          },
        },
      };
    }

    const db = get(db$);
    const visibleAgent = or(
      eq(agents.visibility, "public"),
      eq(agents.owner, auth.userId),
    );
    const [visibleAgents, builtinRows, customRows] = await Promise.all([
      db
        .select({ agentId: agents.id })
        .from(agents)
        .where(and(eq(agents.orgId, auth.orgId), visibleAgent)),
      query.customConnectorId
        ? Promise.resolve([])
        : db
            .select({
              connectorSlug: userBuiltinConnectors.connectorSlug,
              agentId: userBuiltinConnectors.agentId,
            })
            .from(userBuiltinConnectors)
            .innerJoin(
              agents,
              and(
                eq(agents.id, userBuiltinConnectors.agentId),
                eq(agents.orgId, userBuiltinConnectors.orgId),
              ),
            )
            .where(
              and(
                eq(userBuiltinConnectors.orgId, auth.orgId),
                eq(userBuiltinConnectors.userId, auth.userId),
                visibleAgent,
                query.builtinSlug
                  ? eq(userBuiltinConnectors.connectorSlug, query.builtinSlug)
                  : undefined,
              ),
            ),
      query.builtinSlug
        ? Promise.resolve([])
        : db
            .select({
              connectorId: userCustomConnectors.customConnectorId,
              agentId: userCustomConnectors.agentId,
              permissionNames: userCustomConnectors.permissionNames,
            })
            .from(userCustomConnectors)
            .innerJoin(
              agents,
              and(
                eq(agents.id, userCustomConnectors.agentId),
                eq(agents.orgId, userCustomConnectors.orgId),
              ),
            )
            .innerJoin(
              orgCustomConnectors,
              and(
                eq(
                  orgCustomConnectors.id,
                  userCustomConnectors.customConnectorId,
                ),
                eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
              ),
            )
            .where(
              and(
                eq(userCustomConnectors.orgId, auth.orgId),
                eq(userCustomConnectors.userId, auth.userId),
                eq(orgCustomConnectors.enabled, true),
                visibleAgent,
                query.customConnectorId
                  ? eq(
                      userCustomConnectors.customConnectorId,
                      query.customConnectorId,
                    )
                  : undefined,
              ),
            ),
    ]);
    signal.throwIfAborted();

    const resolver =
      builtinRows.length > 0 ? await get(connectorActionResolver()) : null;
    signal.throwIfAborted();
    const availableSlugs = new Set<string>();
    if (resolver) {
      for (const slug of new Set(
        builtinRows.map((row) => {
          return row.connectorSlug;
        }),
      )) {
        const connectorSlug = connectorSlugSchema.parse(slug);
        const resolved = await resolver.resolveSlug({
          connectorSlug,
          requireExecutable: true,
        });
        signal.throwIfAborted();
        if (resolved.ok) {
          availableSlugs.add(slug);
        }
      }
    }

    return {
      status: 200 as const,
      body: {
        visibleAgentIds: visibleAgents.map((agent) => {
          return agent.agentId;
        }),
        builtin: builtinRows
          .filter((row) => {
            return availableSlugs.has(row.connectorSlug);
          })
          .map((row) => {
            return {
              connectorSlug: connectorSlugSchema.parse(row.connectorSlug),
              agentId: row.agentId,
            };
          }),
        custom: customRows.map((row) => {
          return {
            connectorId: row.connectorId,
            agentId: row.agentId,
            permissionNames: [...row.permissionNames],
          };
        }),
      },
    };
  },
);

export const connectorAgentAccessRoutes: readonly RouteEntry[] = [
  {
    route: connectorAgentAccessContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent:read",
      },
      getConnectorAgentAccess$,
    ),
  },
];
