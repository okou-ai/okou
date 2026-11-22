import { pgTextDecoder } from "../../lib/db-structured-result";
import { publishContentBundle$ } from "../services/content-bundle.service";
import { and, eq, or, sql } from "drizzle-orm";
import { command, computed } from "ccstate";
import { agentInstructionsContract } from "@okouai/api-contracts/contracts/agents";
import { legacyAgentApiProfiles } from "@okouai/db/schema/legacy-agent-api-profile";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { conflict, notFound } from "../../lib/error";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { nowDate } from "../../lib/time";
import {
  agentResponse,
  defaultProfileId,
} from "../services/agent-data.service";
import {
  agentInstructions,
  agentInstructionsContent,
} from "../services/agent-instructions.service";
import { publishOrgSignal } from "../external/realtime";
import { waitUntil } from "../context/wait-until";
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
  agentId: legacyAgentApiProfiles.id,
  owner: legacyAgentApiProfiles.owner,
  displayName: legacyAgentApiProfiles.displayName,
  description: legacyAgentApiProfiles.description,
  sound: legacyAgentApiProfiles.sound,
  avatarUrl: legacyAgentApiProfiles.avatarUrl,
  visibility: legacyAgentApiProfiles.visibility,
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
        version: sql`${legacyAgentApiProfiles}.xmin::text`.mapWith(
          pgTextDecoder,
        ),
        owner: legacyAgentApiProfiles.owner,
        visibility: legacyAgentApiProfiles.visibility,
        instructions: legacyAgentApiProfiles.instructions,
      })
      .from(legacyAgentApiProfiles)
      .where(
        and(
          eq(legacyAgentApiProfiles.id, params.id),
          eq(legacyAgentApiProfiles.orgId, auth.orgId),
        ),
      )
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
    if (
      body.data.ifContent !== undefined &&
      body.data.ifContent !== agentInstructionsContent(observed.instructions)
    ) {
      return conflict(
        "Instructions changed; reload the saved version before saving",
      );
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
      .update(legacyAgentApiProfiles)
      .set({ instructions: body.data.content, instructionsBundle, updatedAt })
      .where(
        and(
          eq(legacyAgentApiProfiles.orgId, auth.orgId),
          eq(legacyAgentApiProfiles.id, params.id),
          sql`${legacyAgentApiProfiles}.xmin::text = ${observed.version}`,
          or(
            eq(legacyAgentApiProfiles.owner, member.userId),
            member.role === "admin"
              ? eq(legacyAgentApiProfiles.visibility, "public")
              : undefined,
          ),
        ),
      )
      .returning({
        ...instructionResponseColumns,
        defaultAgentId: defaultProfileId.as("default_agent_id"),
      });
    signal.throwIfAborted();
    if (updated) {
      // Invalidate without publishing private Agent identities or instruction text.
      waitUntil(publishOrgSignal(auth.orgId, "agentInstructionsChanged"));
      return { status: 200 as const, body: agentResponse(updated) };
    }
    const [current] = await db
      .select({
        owner: legacyAgentApiProfiles.owner,
        visibility: legacyAgentApiProfiles.visibility,
      })
      .from(legacyAgentApiProfiles)
      .where(
        and(
          eq(legacyAgentApiProfiles.orgId, auth.orgId),
          eq(legacyAgentApiProfiles.id, params.id),
        ),
      )
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
