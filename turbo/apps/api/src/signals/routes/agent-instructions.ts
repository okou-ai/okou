import { command, computed } from "ccstate";
import { agentInstructionsContract } from "@okouai/api-contracts/contracts/agents";
import { getInstructionsStorageName } from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { Tx } from "../../lib/db-types";
import { conflict, notFound } from "../../lib/error";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { nowDate } from "../../lib/time";
import { agentResponse } from "../services/agent-data.service";
import {
  beginPiStableContextPublication,
  completePiStableContextPublication,
  lockPiStableContextPublication,
  PI_STABLE_CONTEXT_AGENT_INSTRUCTIONS_PUBLICATION_KEY,
  type PiStableContextPublicationFence,
} from "../services/pi-stable-context-generation.service";
import {
  commitPreparedAgentInstructionsStorageInTransaction,
  prepareAgentInstructionsStorage$,
} from "../services/agent-instructions-storage.service";
import { lockAgentInstructionsStoragesInTransaction } from "../services/agent-instructions-storage-transaction.service";
import {
  resolveCanonicalVolumeStorage,
  type ServerSideVolumeStorage,
} from "../services/storage-volume-publication.service";
import { agentInstructions } from "../services/agent-instructions.service";
import { onRejection } from "../utils";
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

interface ReservedInstructionPublication {
  readonly orgId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly storage: ServerSideVolumeStorage;
  readonly fence: PiStableContextPublicationFence;
}

async function lockInstructionAgent(tx: Tx, orgId: string, agentId: string) {
  const [agent] = await tx
    .select({
      id: agents.id,
      name: agents.name,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
    .for("update")
    .limit(1);
  return agent;
}

interface PublishInstructionArgs {
  readonly reservation: ReservedInstructionPublication;
  readonly member: { readonly userId: string; readonly role: string };
  readonly instructions: string;
}

const prepareAndPublishAgentInstructions$ = command(
  async ({ set }, args: PublishInstructionArgs, signal: AbortSignal) => {
    signal.throwIfAborted();
    const reservation = args.reservation;
    // The reservation transaction has committed. No transaction is borrowed
    // while materializing files, building the archive/index or uploading bytes.
    const volume = await set(
      prepareAgentInstructionsStorage$,
      {
        orgId: reservation.orgId,
        agentName: reservation.agentName,
        instructions: args.instructions,
        storage: reservation.storage,
      },
      signal,
    );
    const writeDb = set(writeDb$);
    const result = await writeDb.transaction(async (tx) => {
      const current = await lockInstructionAgent(
        tx,
        reservation.orgId,
        reservation.agentId,
      );
      signal.throwIfAborted();
      if (!current) {
        return { kind: "missing" as const };
      }
      const permissionError = requireAgentPermission(
        current.owner,
        args.member,
        "update agent instructions",
        { visibility: current.visibility },
      );
      if (permissionError) {
        return { kind: "forbidden" as const, response: permissionError };
      }
      if (current.name !== reservation.agentName) {
        return { kind: "conflict" as const };
      }

      // Source deletion and publication both take Storage before Pi locks.
      const [storage] = await lockAgentInstructionsStoragesInTransaction(tx, [
        { orgId: reservation.orgId, agentName: current.name },
      ]);
      signal.throwIfAborted();
      if (
        storage?.id !== reservation.storage.id ||
        storage.s3Prefix !== reservation.storage.s3Prefix ||
        volume.version.storageId !== storage.id ||
        volume.version.s3Key !==
          `${storage.s3Prefix}/${volume.version.versionId}`
      ) {
        return { kind: "conflict" as const };
      }
      if (!(await lockPiStableContextPublication(tx, reservation.fence))) {
        signal.throwIfAborted();
        return { kind: "conflict" as const };
      }
      signal.throwIfAborted();
      await commitPreparedAgentInstructionsStorageInTransaction(
        { tx, volume, stableContextPublication: reservation.fence },
        signal,
      );
      await tx
        .update(agents)
        .set({ updatedAt: nowDate() })
        .where(
          and(eq(agents.orgId, reservation.orgId), eq(agents.id, current.id)),
        );
      signal.throwIfAborted();

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
        .where(
          and(eq(agents.orgId, reservation.orgId), eq(agents.id, current.id)),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!updated) {
        throw new Error(`Canonical Agent missing after update: ${current.id}`);
      }
      return { kind: "updated" as const, agent: updated };
    });
    signal.throwIfAborted();
    return result;
  },
);

const reserveAgentInstructionPublication$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly agentId: string;
      readonly member: { readonly userId: string; readonly role: string };
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    let reservedFence: PiStableContextPublicationFence | undefined;
    const reservation = writeDb.transaction(async (tx) => {
      const current = await lockInstructionAgent(tx, args.orgId, args.agentId);
      signal.throwIfAborted();
      if (!current) {
        return { kind: "missing" as const };
      }
      const permissionError = requireAgentPermission(
        current.owner,
        args.member,
        "update agent instructions",
        { visibility: current.visibility },
      );
      if (permissionError) {
        return { kind: "forbidden" as const, response: permissionError };
      }
      const reservedStorage = await resolveCanonicalVolumeStorage(
        tx,
        {
          orgId: args.orgId,
          storageName: getInstructionsStorageName(current.name),
        },
        signal,
      );
      const [storage] = await lockAgentInstructionsStoragesInTransaction(tx, [
        { orgId: args.orgId, agentName: current.name },
      ]);
      signal.throwIfAborted();
      if (
        storage?.id !== reservedStorage.id ||
        storage.s3Prefix !== reservedStorage.s3Prefix
      ) {
        throw new Error(
          "Agent instructions Storage changed during reservation",
        );
      }
      // Reserve BEFORE IO: a slow older preparation must never supersede a
      // request that started preparing later and already published its HEAD.
      const fence = await beginPiStableContextPublication(
        tx,
        { orgId: args.orgId, agentId: current.id },
        PI_STABLE_CONTEXT_AGENT_INSTRUCTIONS_PUBLICATION_KEY,
      );
      reservedFence = fence;
      signal.throwIfAborted();
      return {
        kind: "reserved" as const,
        reservation: {
          orgId: args.orgId,
          agentId: current.id,
          agentName: current.name,
          storage,
          fence,
        },
      };
    });
    return await onRejection(reservation, async () => {
      // The COMMIT receipt can fail after the token was written. Settle only
      // the fence we observed, whether the reservation committed or rolled back.
      if (reservedFence) {
        await settleInstructionPublication(writeDb, reservedFence);
      }
    });
  },
);

async function settleInstructionPublication(
  db: Db,
  fence: PiStableContextPublicationFence,
): Promise<void> {
  // Deliberately outlive request cancellation; await exact-token settlement.
  await db.transaction(async (tx) => {
    await completePiStableContextPublication(tx, fence);
  });
}

const publishOwnedAgentInstructions$ = command(
  async ({ set }, args: PublishInstructionArgs, signal: AbortSignal) => {
    const writeDb = set(writeDb$);
    return await onRejection(
      set(prepareAndPublishAgentInstructions$, args, signal),
      async () => {
        await settleInstructionPublication(writeDb, args.reservation.fence);
      },
    );
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
    const preflight = await set(
      reserveAgentInstructionPublication$,
      { orgId: auth.orgId, agentId: params.id, member },
      signal,
    );
    if (preflight.kind !== "reserved") {
      signal.throwIfAborted();
      return preflight.kind === "missing"
        ? notFound(`Agent not found: ${params.id}`)
        : preflight.response;
    }

    const result = await set(
      publishOwnedAgentInstructions$,
      {
        reservation: preflight.reservation,
        member,
        instructions: body.data.content,
      },
      signal,
    );
    if (result.kind !== "updated") {
      await settleInstructionPublication(
        set(writeDb$),
        preflight.reservation.fence,
      );
      signal.throwIfAborted();
      if (result.kind === "missing") {
        return notFound(`Agent not found: ${params.id}`);
      }
      if (result.kind === "forbidden") {
        return result.response;
      }
      return conflict(
        "Agent instructions changed while this update was preparing. Retry with current instructions.",
      );
    }
    signal.throwIfAborted();
    return { status: 200 as const, body: agentResponse(result.agent) };
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
