import { command, computed } from "ccstate";
import { agentInstructionsContract } from "@okouai/api-contracts/contracts/agents";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { nowDate } from "../../lib/time";
import { agentResponse } from "../services/agent-data.service";
import { lockCanonicalAgentMutation } from "../services/agent-mutation-lock.service";
import {
  beginPiStableContextPublication,
  PI_STABLE_CONTEXT_AGENT_INSTRUCTIONS_PUBLICATION_KEY,
} from "../services/pi-stable-context-generation.service";
import { writeAgentInstructionsStorageInTransaction$ } from "../services/agent-instructions-storage.service";
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

    const writeDb = set(writeDb$);
    const result = await writeDb.transaction(async (tx) => {
      await lockCanonicalAgentMutation(tx, params.id);

      const [current] = await tx
        .select({
          id: agents.id,
          name: agents.name,
          owner: agents.owner,
          visibility: agents.visibility,
        })
        .from(agents)
        .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, params.id)))
        .for("update")
        .limit(1);
      if (!current) {
        return { kind: "missing" as const };
      }

      const permissionError = requireAgentPermission(
        current.owner,
        member,
        "update agent instructions",
        { visibility: current.visibility },
      );
      if (permissionError) {
        return { kind: "forbidden" as const, response: permissionError };
      }

      const stableContextPublication = await beginPiStableContextPublication(
        tx,
        {
          orgId: auth.orgId,
          agentId: current.id,
        },
        PI_STABLE_CONTEXT_AGENT_INSTRUCTIONS_PUBLICATION_KEY,
      );

      await set(
        writeAgentInstructionsStorageInTransaction$,
        {
          tx,
          orgId: auth.orgId,
          agentName: current.name,
          instructions: body.data.content,
          stableContextPublication,
        },
        signal,
      );
      signal.throwIfAborted();

      await tx
        .update(agents)
        .set({ updatedAt: nowDate() })
        .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, current.id)));

      const [updated] = await tx
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
        .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, current.id)))
        .limit(1);
      if (!updated) {
        throw new Error(`Canonical Agent missing after update: ${current.id}`);
      }
      return { kind: "updated" as const, agent: updated };
    });
    signal.throwIfAborted();

    if (result.kind === "missing") {
      return notFound(`Agent not found: ${params.id}`);
    }
    if (result.kind === "forbidden") {
      return result.response;
    }

    return {
      status: 200 as const,
      body: agentResponse(result.agent),
    };
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
