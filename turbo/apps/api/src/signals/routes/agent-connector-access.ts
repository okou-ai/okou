import { computed } from "ccstate";
import { agentConnectorAccessContract } from "@okouai/api-contracts/contracts/agent-connector-access";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { agents } from "@okouai/db/schema/agent";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { asc } from "drizzle-orm";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  agentEnabledConnectorSlugsCondition,
  agentCustomConnectorGrantJoinCondition,
  agentCustomConnectorGrantsCondition,
  visibleAgentIdentityCondition,
} from "../services/agent-data.service";
import { createExecutableConnectorSlugs } from "../services/connector-action-resolver.service";

const builtinConnectorSlugs$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const { id: agentId } = get(pathParamsOf(agentConnectorAccessContract.agent));
  const owner = { orgId: auth.orgId, userId: auth.userId, agentId };
  const rows = await get(db$)
    .select({ connectorSlug: userBuiltinConnectors.connectorSlug })
    .from(userBuiltinConnectors)
    .where(agentEnabledConnectorSlugsCondition(owner))
    .orderBy(asc(userBuiltinConnectors.connectorSlug));

  return rows.map((row) => {
    return connectorSlugSchema.parse(row.connectorSlug);
  });
});

const executableConnectorSlugs$ = createExecutableConnectorSlugs(
  builtinConnectorSlugs$,
);

const agent$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const { id: agentId } = get(pathParamsOf(agentConnectorAccessContract.agent));
  const owner = { orgId: auth.orgId, userId: auth.userId, agentId };
  const [visibleAgent] = await get(db$)
    .select({ id: agents.id })
    .from(agents)
    .where(visibleAgentIdentityCondition(owner))
    .limit(1);
  const exists = Boolean(visibleAgent);
  if (!exists) {
    return notFound(`Agent not found: ${agentId}`);
  }
  const [, grants] = await Promise.all([
    get(builtinConnectorSlugs$),
    (async () => {
      const rows = await get(db$)
        .select({
          customConnectorId: userCustomConnectors.customConnectorId,
          permissionNames: userCustomConnectors.permissionNames,
        })
        .from(userCustomConnectors)
        .innerJoin(
          orgCustomConnectors,
          agentCustomConnectorGrantJoinCondition(),
        )
        .where(agentCustomConnectorGrantsCondition(owner))
        .orderBy(asc(userCustomConnectors.customConnectorId));

      return rows.map((row) => {
        return {
          customConnectorId: row.customConnectorId,
          permissionNames: [...row.permissionNames],
        };
      });
    })(),
  ]);
  const enabledConnectorSlugs = await get(executableConnectorSlugs$);
  return {
    status: 200 as const,
    body: {
      enabledConnectorSlugs,
      customConnectorIds: grants.map((grant) => {
        return grant.customConnectorId;
      }),
    },
  };
});

export const agentConnectorAccessRoutes: readonly RouteEntry[] = [
  {
    route: agentConnectorAccessContract.agent,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["session"],
      },
      agent$,
    ),
  },
];
