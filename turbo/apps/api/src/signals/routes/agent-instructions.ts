import { pgTextDecoder } from "../../lib/db-structured-result";
import { publishContentBundle$ } from "../services/content-bundle.service";
import { and, eq, or, sql } from "drizzle-orm";
import { command, computed } from "ccstate";
import { agentInstructionsContract } from "@okouai/api-contracts/contracts/agents";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { conflict, notFound } from "../../lib/error";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { nowDate } from "../../lib/time";
import { agentResponse } from "../services/agent-data.service";
import { agentInstructions } from "../services/agent-instructions.service";
import type { RouteEntry } from "../route-entry";

const agentReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const agentWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

const getAgentInstructionsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(agentInstructionsContract.get));
  const result = await get(
    agentInstructions({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  if (!result) {
    return notFound(`Agent not found: ${params.id}`);
  }
  return { status: 200 as const, body: result };
});

const updateAgentInstructionsBody$ = bodyResultOf(
  agentInstructionsContract.update,
);

const instructionResponseColumns = Object.freeze({
  agentId: agents.id,
  owner: agents.owner,
  displayName: agents.displayName,
  description: agents.description,
  sound: agents.sound,
  avatarUrl: agents.avatarUrl,
  visibility: agents.visibility,
});

const updateAgentInstructionsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = { userId: auth.userId, role: auth.orgRole ?? "member" };
    const params = get(pathParamsOf(agentInstructionsContract.update));
    const body = await get(updateAgentInstructionsBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const db = set(writeDb$);
    const [observed] = await db
      .select({
        version: sql`${agents}.xmin::text`.mapWith(pgTextDecoder),
        owner: agents.owner,
        visibility: agents.visibility,
      })
      .from(agents)
      .where(and(eq(agents.id, params.id), eq(agents.orgId, auth.orgId)))
      .limit(1);
    signal.throwIfAborted();
    if (!observed) {
      return notFound(`Agent not found: ${params.id}`);
    }
    const denied = requireAgentPermission(
      observed.owner,
      member,
      "update agent instructions",
      { visibility: observed.visibility },
    );
    if (denied) {
      return denied;
    }
    const instructionsBundle = await set(
      publishContentBundle$,
      [
        {
          path: "instructions.md",
          content: Buffer.from(body.data.content, "utf8"),
        },
      ],
      signal,
    );
    const updatedAt = nowDate();
    // Authorization is part of the write predicate, including concurrent visibility changes.
    const [updated] = await db
      .update(agents)
      .set({ instructions: body.data.content, instructionsBundle, updatedAt })
      .where(
        and(
          eq(agents.orgId, auth.orgId),
          eq(agents.id, params.id),
          sql`${agents}.xmin::text = ${observed.version}`,
          or(
            eq(agents.owner, member.userId),
            member.role === "admin"
              ? eq(agents.visibility, "public")
              : undefined,
          ),
        ),
      )
      .returning({
        ...instructionResponseColumns,
        defaultAgentId:
          sql`(${db.select({ defaultAgentId: orgMetadata.defaultAgentId }).from(orgMetadata).where(eq(orgMetadata.orgId, auth.orgId))})`
            .mapWith(orgMetadata.defaultAgentId)
            .as("default_agent_id"),
      });
    signal.throwIfAborted();
    if (updated) {
      return { status: 200 as const, body: agentResponse(updated) };
    }
    const [current] = await db
      .select({
        owner: agents.owner,
        visibility: agents.visibility,
      })
      .from(agents)
      .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, params.id)))
      .limit(1);
    signal.throwIfAborted();
    if (!current) {
      return notFound(`Agent not found: ${params.id}`);
    }
    const permissionError = requireAgentPermission(
      current.owner,
      member,
      "update agent instructions",
      { visibility: current.visibility },
    );
    if (permissionError) {
      return permissionError;
    }
    // A second concurrent permission change may have made the Agent writable again.
    return conflict(
      "Agent instructions or permissions changed during this update; retry",
    );
  },
);

export const agentInstructionsRoutes: readonly RouteEntry[] = [
  {
    route: agentInstructionsContract.get,
    handler: authRoute(agentReadAuth, getAgentInstructionsInner$),
  },
  {
    route: agentInstructionsContract.update,
    handler: authRoute(agentWriteAuth, updateAgentInstructionsInner$),
  },
];
