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
import {
  beginPiStableContextPublication,
  completePiStableContextPublication,
  refreshPiStableContextStorageDemands,
  PI_STABLE_CONTEXT_AGENT_INSTRUCTIONS_PUBLICATION_KEY,
} from "../services/pi-stable-context-generation.service";
import { prepareAgentInstructionsStorage$ } from "../services/agent-instructions-storage.service";
import { preparedVolumePublicationSql } from "../services/storage-volume-publication-sql";
import { StorageVersionIdentityConflictError } from "../services/storage-version-registration.service";
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

const prepareAgentInstructionsUpdate$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly agentId: string;
      readonly member: { readonly userId: string; readonly role: string };
      readonly content: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    // Authorization is rechecked under the Agent row below. Preparation must
    // not retain that row (or a transaction) across archive and R2 operations.
    const [preflight] = await db
      .select({
        id: agents.id,
        name: agents.name,
        owner: agents.owner,
        visibility: agents.visibility,
      })
      .from(agents)
      .where(and(eq(agents.orgId, args.orgId), eq(agents.id, args.agentId)))
      .limit(1);
    signal.throwIfAborted();
    if (!preflight) {
      return { kind: "missing" as const };
    }
    const preflightPermission = requireAgentPermission(
      preflight.owner,
      args.member,
      "update agent instructions",
      { visibility: preflight.visibility },
    );
    if (preflightPermission) {
      return { kind: "forbidden" as const, response: preflightPermission };
    }
    const volume = await set(
      prepareAgentInstructionsStorage$,
      {
        orgId: args.orgId,
        agentName: preflight.name,
        instructions: args.content,
      },
      signal,
    );
    signal.throwIfAborted();
    return { kind: "prepared" as const, preflight, volume };
  },
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
    const prepared = await set(
      prepareAgentInstructionsUpdate$,
      {
        orgId: auth.orgId,
        agentId: params.id,
        member,
        content: body.data.content,
      },
      signal,
    );
    if (prepared.kind === "missing") {
      return notFound(`Agent not found: ${params.id}`);
    }
    if (prepared.kind === "forbidden") {
      return prepared.response;
    }
    const { preflight, volume } = prepared;
    const result = await writeDb.transaction(async (tx) => {
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

      if (current.name !== preflight.name) {
        throw new Error("Agent name changed during instructions preparation");
      }
      const { rowCount: published } = await tx.execute(
        preparedVolumePublicationSql(volume, nowDate()),
      );
      if (published !== 1) {
        throw new StorageVersionIdentityConflictError(volume.version.versionId);
      }
      signal.throwIfAborted();
      await refreshPiStableContextStorageDemands(tx, stableContextPublication, {
        storageId: volume.version.storageId,
        versionId: volume.version.versionId,
        archiveSize: volume.version.archiveSize,
        fileCount: volume.version.fileCount,
      });
      if (
        !(await completePiStableContextPublication(
          tx,
          stableContextPublication,
        ))
      ) {
        throw new Error(
          "Stable-context publication fence changed while locked",
        );
      }
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
