import {
  completePublicationSql,
  publicationGenerationReceiptSchema,
  publicationScopeCondition,
  lockPublicationScopeSql,
  beginPublicationSql,
  publicationFenceFromReceipt,
  AGENT_INSTRUCTIONS_PUBLICATION_KEY,
  type StoragePublicationFence,
} from "../services/storage-publication-fence.service";
import { and, eq, sql } from "drizzle-orm";
import { preparedVolumePublicationSql } from "../services/storage-volume-publication-sql";
import { newStorageS3Location } from "../services/storage-s3-prefix.utils";
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
import { storagePublicationTokens } from "@okouai/db/schema/storage-publication-fence";
import { storages } from "@okouai/db/schema/storage";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { conflict, notFound } from "../../lib/error";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { nowDate } from "../../lib/time";
import { agentResponse } from "../services/agent-data.service";

import { prepareAgentInstructionsStorage$ } from "../services/agent-instructions-storage.service";
import {
  canonicalVolumeStorageValues,
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
  readonly fence: StoragePublicationFence;
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
        lockPublicationScopeSql(reservation.fence.scope, nowDate()),
      );
      signal.throwIfAborted();
      if (admittedScope !== 1) {
        return { kind: "conflict" as const };
      }
      const [fenceIsCurrent] = await tx
        .select({ token: storagePublicationTokens.token })
        .from(storagePublicationTokens)
        .where(publicationScopeCondition(reservation.fence))
        .limit(1);
      signal.throwIfAborted();

      if (!fenceIsCurrent) {
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
      const { rowCount: completedPublicationCount } = await tx.execute(
        completePublicationSql(reservation.fence),
      );
      signal.throwIfAborted();
      if (!(completedPublicationCount === 1)) {
        throw new Error(
          "Agent instructions publication fence changed while locked",
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
    let reservedFence: StoragePublicationFence | undefined;
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
      const storageInput = {
        orgId: args.orgId,
        storageName: getInstructionsStorageName(current.name),
      };
      await tx
        .insert(storages)
        .values(
          canonicalVolumeStorageValues({
            ...storageInput,
            ...newStorageS3Location(args.orgId),
          }),
        )
        .onConflictDoNothing();
      signal.throwIfAborted();
      const [reservedStorage] = await tx
        .select({ id: storages.id, s3Prefix: storages.s3Prefix })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, storageInput.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(storages.name, storageInput.storageName),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!reservedStorage) {
        throw new Error(
          `Failed to create storage for ${storageInput.storageName}`,
        );
      }
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
      const piMutation1Key = AGENT_INSTRUCTIONS_PUBLICATION_KEY;
      const piMutation1Token = randomUUID();
      const fence = publicationFenceFromReceipt(
        parseRawRows(
          publicationGenerationReceiptSchema,
          await tx.execute(
            beginPublicationSql(
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
        await set(settleInstructionPublication$, reservedFence);
      }
    });
  },
);

const settleInstructionPublication$ = command(
  async ({ set }, fence: StoragePublicationFence): Promise<void> => {
    const db = set(writeDb$);
    // Deliberately outlive request cancellation; await exact-token settlement.
    // Scope ownership and exact-token removal commit together in reservation order.
    await db.transaction(async (tx) => {
      await tx.execute(lockPublicationScopeSql(fence.scope, nowDate()));
      await tx.execute(completePublicationSql(fence));
    });
  },
);

const publishOwnedAgentInstructions$ = command(
  async ({ set }, args: PublishInstructionArgs, signal: AbortSignal) => {
    return await onRejection(
      set(prepareAndPublishAgentInstructions$, args, signal),
      async () => {
        await set(settleInstructionPublication$, args.reservation.fence);
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
      await set(settleInstructionPublication$, preflight.reservation.fence);
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
