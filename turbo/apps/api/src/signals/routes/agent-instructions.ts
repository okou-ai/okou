import { randomUUID } from "node:crypto";
import { z } from "zod";
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
import { parseRawRows } from "../../lib/db-raw-rows";
import { agentResponse } from "../services/agent-data.service";
import { agentInstructions } from "../services/agent-instructions.service";
import {
  AGENT_INSTRUCTIONS_PUBLICATION_KEY,
  beginPublicationCtesSql,
} from "../services/storage-publication-fence.service";
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

const instructionUpdateRowSchema = z.object({
  agentId: z.string(),
  owner: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  sound: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  visibility: z.enum(["public", "private"]),
  defaultAgentId: z.string().nullable(),
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
    const updatedAt = nowDate();
    // Authorization is part of the write predicate, including concurrent visibility changes.
    const updatedAgent = db
      .update(agents)
      .set({ instructions: body.data.content, updatedAt })
      .where(
        and(
          eq(agents.orgId, auth.orgId),
          eq(agents.id, params.id),
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
    // Keep the outgoing bridge's Agent-before-scope/token order. UPSERT must
    // replace even a reservation committed after this statement's snapshot
    // while its Agent UPDATE waited. A DELETE-only barrier cannot do that.
    // This bounded token remains until replaced, Agent deletion or release-3 cleanup.
    const [updated] = parseRawRows(
      instructionUpdateRowSchema,
      await db.execute(sql`
      WITH updated_agent AS (${updatedAgent.getSQL()}),
      ${beginPublicationCtesSql(
        { orgId: auth.orgId, agentId: params.id },
        AGENT_INSTRUCTIONS_PUBLICATION_KEY,
        randomUUID(),
        updatedAt,
        sql`updated_agent`,
      )}
      SELECT id AS "agentId", owner, display_name AS "displayName", description,
        sound, avatar_url AS "avatarUrl", visibility, default_agent_id AS "defaultAgentId"
      FROM updated_agent
    `),
    );
    signal.throwIfAborted();
    if (updated) {
      return { status: 200 as const, body: agentResponse(updated) };
    }
    const [current] = await db
      .select({ owner: agents.owner, visibility: agents.visibility })
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
      "Agent permissions changed during this instruction update; retry",
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
