import {
  completePiStableContextPublicationSql,
  piStableContextGenerationReceiptSchema,
  publicationScopeCondition,
  publicationScopePendingSql,
  publicationReadinessSql,
  beginPiStableContextPublicationSql,
  piStableContextPublicationFromReceipt,
  PI_STABLE_CONTEXT_AGENT_INSTRUCTIONS_PUBLICATION_KEY,
  type PiStableContextPublicationFence,
} from "../services/pi-stable-context-generation.service";
import { piStableContextPublications } from "@okouai/db/schema/pi-stable-context";
import { and, eq, sql } from "drizzle-orm";
import { preparedVolumePublicationSql } from "../services/storage-volume-publication-sql";
import { StorageVersionIdentityConflictError } from "../services/storage-version-registration.service";
import { parseRawRows } from "../../lib/db-raw-rows";

import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import { agentInstructionsContract } from "@okouai/api-contracts/contracts/agents";
import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { storages } from "@okouai/db/schema/storage";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { conflict, notFound } from "../../lib/error";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { nowDate } from "../../lib/time";
import { agentResponse } from "../services/agent-data.service";

import { prepareAgentInstructionsStorage$ } from "../services/agent-instructions-storage.service";
import {
  resolveCanonicalVolumeStorage,
  type PreparedServerSideVolume,
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

const instructionAgentColumns = Object.freeze({
  id: agents.id,
  name: agents.name,
  owner: agents.owner,
  visibility: agents.visibility,
});
const instructionStorageColumns = Object.freeze({
  id: storages.id,
  s3Prefix: storages.s3Prefix,
});

const instructionResponseColumns = Object.freeze({
  agentId: agents.id,
  owner: agents.owner,
  displayName: agents.displayName,
  description: agents.description,
  sound: agents.sound,
  avatarUrl: agents.avatarUrl,
  visibility: agents.visibility,
});

interface PublishInstructionArgs {
  readonly reservation: ReservedInstructionPublication;
  readonly member: { readonly userId: string; readonly role: string };
  readonly instructions: string;
}

function instructionPublicationAdmission(
  current:
    | Pick<typeof agents.$inferSelect, "id" | "name" | "owner" | "visibility">
    | undefined,
  member: PublishInstructionArgs["member"],
  agentName: string,
) {
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
  if (current.name !== agentName) {
    return { kind: "conflict" as const };
  }

  return { kind: "admitted" as const, current };
}

const publishPreparedAgentInstructions$ = command(
  async (
    { set },
    args: Omit<PublishInstructionArgs, "instructions"> & {
      readonly volume: PreparedServerSideVolume;
    },
    signal: AbortSignal,
  ) => {
    const reservation = args.reservation;
    const volume = args.volume;
    const writeDb = set(writeDb$);
    const result = await writeDb.transaction(async (tx) => {
      const current = (
        await tx
          .select(instructionAgentColumns)
          .from(agents)
          .where(
            and(
              eq(agents.orgId, reservation.orgId),
              eq(agents.id, reservation.agentId),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
      signal.throwIfAborted();
      const admission = instructionPublicationAdmission(
        current,
        args.member,
        reservation.agentName,
      );
      if (admission.kind !== "admitted") {
        return admission;
      }
      const admittedAgent = admission.current;
      // Source deletion and publication both take Storage before Pi locks.
      const storage = (
        await tx
          .select(instructionStorageColumns)
          .from(storages)
          .where(
            and(
              eq(storages.orgId, reservation.orgId),
              eq(storages.userId, VOLUME_ORG_USER_ID),
              eq(storages.name, getInstructionsStorageName(admittedAgent.name)),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
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
      const { rowCount: admittedScope } = await tx.execute(
        publicationScopePendingSql(reservation.fence.scope, nowDate()),
      );
      signal.throwIfAborted();
      if (admittedScope !== 1) {
        return { kind: "conflict" as const };
      }
      const [piMutation0Publication] = await tx
        .select({ token: piStableContextPublications.token })
        .from(piStableContextPublications)
        .where(publicationScopeCondition(reservation.fence))
        .limit(1);
      signal.throwIfAborted();
      await tx.execute(
        publicationReadinessSql(reservation.fence.scope, nowDate()),
      );
      signal.throwIfAborted();

      if (!(piMutation0Publication !== undefined)) {
        signal.throwIfAborted();
        return { kind: "conflict" as const };
      }
      signal.throwIfAborted();
      const { rowCount: publishedStorageCount } = await tx.execute(
        preparedVolumePublicationSql(volume, nowDate()),
      );
      signal.throwIfAborted();
      if (publishedStorageCount !== 1) {
        throw new StorageVersionIdentityConflictError(volume.version.versionId);
      }
      // Reservation invalidates every scoped input. No demand can register while
      // this scope is pending; next use recaptures the newly committed source.
      const { rowCount: completedPublicationCount } = await tx.execute(
        completePiStableContextPublicationSql(reservation.fence),
      );
      signal.throwIfAborted();
      await tx.execute(
        publicationReadinessSql(reservation.fence.scope, nowDate()),
      );
      signal.throwIfAborted();
      if (!(completedPublicationCount === 1)) {
        throw new Error(
          "Stable-context publication fence changed while locked",
        );
      }
      const [updated] = await tx
        .update(agents)
        .set({ updatedAt: nowDate() })
        .where(
          and(
            eq(agents.orgId, reservation.orgId),
            eq(agents.id, admittedAgent.id),
          ),
        )
        .returning({
          ...instructionResponseColumns,
          defaultAgentId:
            sql`(${tx.select({ defaultAgentId: orgMetadata.defaultAgentId }).from(orgMetadata).where(eq(orgMetadata.orgId, reservation.orgId))})`.mapWith(
              orgMetadata.defaultAgentId,
            ),
        });
      signal.throwIfAborted();
      signal.throwIfAborted();
      if (!updated) {
        throw new Error(
          `Canonical Agent missing after update: ${admittedAgent.id}`,
        );
      }
      return { kind: "updated" as const, agent: updated };
    });
    signal.throwIfAborted();
    return result;
  },
);

const prepareAndPublishAgentInstructions$ = command(
  async ({ set }, args: PublishInstructionArgs, signal: AbortSignal) => {
    signal.throwIfAborted();
    const reservation = args.reservation;
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
    return await set(
      publishPreparedAgentInstructions$,
      { reservation, member: args.member, volume },
      signal,
    );
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
      const current = (
        await tx
          .select(instructionAgentColumns)
          .from(agents)
          .where(and(eq(agents.orgId, args.orgId), eq(agents.id, args.agentId)))
          .for("update")
          .limit(1)
      )[0];
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
      const storage = (
        await tx
          .select(instructionStorageColumns)
          .from(storages)
          .where(
            and(
              eq(storages.orgId, args.orgId),
              eq(storages.userId, VOLUME_ORG_USER_ID),
              eq(storages.name, getInstructionsStorageName(current.name)),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
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
      const piMutation1Scope = { orgId: args.orgId, agentId: current.id };
      const piMutation1Key =
        PI_STABLE_CONTEXT_AGENT_INSTRUCTIONS_PUBLICATION_KEY;
      const piMutation1Token = randomUUID();
      const fence = piStableContextPublicationFromReceipt(
        parseRawRows(
          piStableContextGenerationReceiptSchema,
          await tx.execute(
            beginPiStableContextPublicationSql(
              piMutation1Scope,
              piMutation1Key,
              piMutation1Token,
              nowDate(),
            ),
          ),
        ),
        piMutation1Scope,
        piMutation1Key,
        piMutation1Token,
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
    await tx.execute(publicationScopePendingSql(fence.scope, nowDate()));
    await tx.execute(completePiStableContextPublicationSql(fence));
    await tx.execute(publicationReadinessSql(fence.scope, nowDate()));
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
