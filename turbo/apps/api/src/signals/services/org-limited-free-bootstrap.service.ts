import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { LIMITED_FREE1_DEFAULT_RUN_MODEL } from "@okouai/api-contracts/contracts/model-providers";
import { SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { storages } from "@okouai/db/schema/storage";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";
import { nowDate } from "../../lib/time";
import { writeAgentInstructionsStorageInTransaction$ } from "./agent-instructions-storage.service";
import { newStorageS3Location } from "./storage-s3-prefix.utils";
import {
  grantOnboardingCredits,
  LIMITED_FREE_ONBOARDING_CREDITS,
  onboardingCreditsExpiresAt,
} from "./onboarding-credit-grants.service";
import { upsertOrgNoSecretModelProvider$ } from "./model-provider.service";
import {
  DEFAULT_AGENT_AVATAR_URL,
  DEFAULT_AGENT_DISPLAY_NAME,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SOUND,
} from "./default-agent-profile";
import {
  upsertOrgPlanEntitlement,
  writeOrgMetadataWithPlanEntitlements,
} from "./org-plan-entitlements.service";
import type { Tx } from "../../lib/db-types";
import { onRejection } from "../utils";

const L = logger("org-limited-free-bootstrap.service");

type DbTransaction = Tx;

interface EnsureOrgLimitedFreeBootstrapArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
}

type BootstrapOwnerMembershipArgs = EnsureOrgLimitedFreeBootstrapArgs;

type BootstrapReservation =
  | {
      readonly status: "skipped";
      readonly agentId: string;
    }
  | {
      readonly status: "reserved";
      readonly agentId: string;
    };

interface EnsureOrgLimitedFreeBootstrapResult {
  readonly bootstrapped: boolean;
  readonly agentId: string | null;
}

interface BootstrapInstructionsStorage {
  readonly id: string;
  readonly s3Prefix: string;
}

async function ensureBootstrapInstructionsStorage(
  tx: DbTransaction,
  orgId: string,
): Promise<BootstrapInstructionsStorage> {
  const { storageId, s3Prefix } = newStorageS3Location(orgId);
  const [storage] = await tx
    .insert(storages)
    .values({
      id: storageId,
      orgId,
      userId: VOLUME_ORG_USER_ID,
      name: getInstructionsStorageName(DEFAULT_AGENT_NAME),
      s3Prefix,
    })
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name],
      // Own the real parent before deciding whether seed publication is still
      // needed. Preserve the canonical identity, HEAD and timestamps on reuse.
      set: { name: sql`${storages.name}` },
    })
    .returning({ id: storages.id, s3Prefix: storages.s3Prefix });
  if (!storage) {
    throw new Error("Expected bootstrap instructions Storage after upsert");
  }
  return storage;
}

async function lockOrgBootstrap(
  tx: DbTransaction,
  orgId: string,
): Promise<void> {
  await tx.execute(
    // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
    sql`SELECT pg_advisory_xact_lock(hashtext('org_bootstrap:' || ${orgId}))`,
  );
}

async function existingDefaultAgentId(
  tx: DbTransaction,
  orgId: string,
): Promise<string | null> {
  const [orgRow] = await tx
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!orgRow?.defaultAgentId) {
    return null;
  }

  const [existing] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, orgRow.defaultAgentId), eq(agents.orgId, orgId)))
    .limit(1);

  return existing?.id ?? null;
}

async function upsertBootstrapOwnerMembership(
  tx: DbTransaction,
  args: BootstrapOwnerMembershipArgs,
): Promise<void> {
  const cachedAt = nowDate();
  await tx
    .insert(orgMembersCache)
    .values({
      orgId: args.orgId,
      userId: args.ownerUserId,
      role: "admin",
      cachedAt,
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: { role: "admin", cachedAt },
    });

  await tx
    .insert(orgMembersMetadata)
    .values({
      orgId: args.orgId,
      userId: args.ownerUserId,
      createdAt: cachedAt,
      updatedAt: cachedAt,
    })
    .onConflictDoNothing();
}

function isPaidTier(tier: string): boolean {
  return tier === "pro" || tier === "team" || tier === "custom";
}

async function reserveBootstrapAgent(
  tx: DbTransaction,
  args: BootstrapOwnerMembershipArgs & { readonly agentId: string },
): Promise<BootstrapReservation> {
  await upsertBootstrapOwnerMembership(tx, args);

  const existingAgentId = await existingDefaultAgentId(tx, args.orgId);
  if (existingAgentId) {
    return { status: "skipped", agentId: existingAgentId };
  }

  return { status: "reserved", agentId: args.agentId };
}

async function finalizeBootstrap(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly agentId: string;
  },
): Promise<EnsureOrgLimitedFreeBootstrapResult> {
  const existingAgentId = await existingDefaultAgentId(tx, args.orgId);
  if (existingAgentId) {
    return { bootstrapped: false, agentId: existingAgentId };
  }

  const createdAt = nowDate();
  await tx
    .insert(agents)
    .values({
      id: args.agentId,
      orgId: args.orgId,
      name: DEFAULT_AGENT_NAME,
      owner: args.ownerUserId,
      visibility: "public",
      displayName: DEFAULT_AGENT_DISPLAY_NAME,
      description: null,
      sound: DEFAULT_AGENT_SOUND,
      avatarUrl: DEFAULT_AGENT_AVATAR_URL,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      createdAt,
      updatedAt: createdAt,
    })
    .onConflictDoNothing();

  const [agentRow] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.orgId, args.orgId), eq(agents.name, DEFAULT_AGENT_NAME)),
    )
    .limit(1);
  if (!agentRow) {
    throw new Error("Expected canonical Agent after bootstrap upsert");
  }

  const [orgRow] = await tx
    .select({ tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);
  const tier = orgRow?.tier ?? "limited-free-1";

  if (isPaidTier(tier)) {
    await tx
      .update(orgMetadata)
      .set({ defaultAgentId: agentRow.id, updatedAt: nowDate() })
      .where(eq(orgMetadata.orgId, args.orgId));
    return { bootstrapped: true, agentId: agentRow.id };
  }

  await writeOrgMetadataWithPlanEntitlements(tx, {
    writeOrgMetadata: async (writeTx) => {
      return await writeTx
        .insert(orgMetadataCanonicalWrites)
        .values({
          orgId: args.orgId,
          defaultAgentId: agentRow.id,
          tier: "limited-free-1",
          onboardingPaymentPending: false,
          onboardingComplete: false,
          updatedAt: nowDate(),
        })
        .onConflictDoUpdate({
          target: orgMetadataCanonicalWrites.orgId,
          set: {
            defaultAgentId: agentRow.id,
            tier: "limited-free-1",
            onboardingPaymentPending: false,
            updatedAt: nowDate(),
          },
        })
        .returning({
          orgId: orgMetadata.orgId,
        });
    },
    writePlanEntitlement: async (writeTx, row) => {
      await upsertOrgPlanEntitlement(writeTx, {
        orgId: row.orgId,
        tier: "limited-free-1",
        source: "org_metadata_bootstrap",
      });
    },
  });

  await grantOnboardingCredits(
    tx,
    args.orgId,
    LIMITED_FREE_ONBOARDING_CREDITS,
    onboardingCreditsExpiresAt(nowDate()),
  );

  return { bootstrapped: true, agentId: agentRow.id };
}

export const ensureOrgLimitedFreeBootstrap$ = command(
  async (
    { get, set },
    args: EnsureOrgLimitedFreeBootstrapArgs,
    signal: AbortSignal,
  ): Promise<EnsureOrgLimitedFreeBootstrapResult> => {
    const writeDb = set(writeDb$);
    const agentId = randomUUID();
    const reservation = await writeDb.transaction(async (tx) => {
      return await reserveBootstrapAgent(tx, {
        ...args,
        agentId,
      });
    });
    signal.throwIfAborted();

    if (reservation.status === "skipped") {
      return { bootstrapped: false, agentId: reservation.agentId };
    }

    await set(
      upsertOrgNoSecretModelProvider$,
      {
        orgId: args.orgId,
        type: "built-in",
        selectedModel: LIMITED_FREE1_DEFAULT_RUN_MODEL,
      },
      signal,
    );
    signal.throwIfAborted();

    // Retain the actual generation outside the transaction: a newly inserted
    // parent can roll back after uploading bytes, leaving no row to find later.
    let instructionsStorage: BootstrapInstructionsStorage | undefined;
    const cleanupUnclaimedInstructions = async (): Promise<void> => {
      const attemptedStorage = instructionsStorage;
      if (!attemptedStorage) {
        return;
      }
      const s3Prefix = await writeDb.transaction(
        async (tx) => {
          await lockOrgBootstrap(tx, args.orgId);
          const identity = and(
            eq(storages.id, attemptedStorage.id),
            eq(storages.orgId, args.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(storages.name, getInstructionsStorageName(DEFAULT_AGENT_NAME)),
          );
          const [storage] = await tx
            .select({ s3Prefix: storages.s3Prefix })
            .from(storages)
            .where(identity)
            .for("update");
          if (!storage) {
            // This generation was rolled back or already deleted. A replacement
            // has its own UUID/prefix and must never be adopted by compensation.
            return attemptedStorage.s3Prefix;
          }
          if (await existingDefaultAgentId(tx, args.orgId)) {
            return null;
          }
          const [deleted] = await tx
            .delete(storages)
            .where(identity)
            .returning({ s3Prefix: storages.s3Prefix });
          if (!deleted) {
            throw new Error(
              "Locked bootstrap instructions Storage disappeared",
            );
          }
          return deleted.s3Prefix;
        },
        { isolationLevel: "read committed" },
      );

      if (!s3Prefix) {
        return;
      }
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const objects = await get(listS3ObjectsUnderPrefix(bucket, s3Prefix));
      await get(
        deleteS3Objects(
          bucket,
          objects.map((object) => {
            return object.key;
          }),
        ),
      );
    };

    const bootstrap = writeDb.transaction(
      async (tx) => {
        // Keep the advisory key until every serving/rollback writer owns the
        // Storage parent before its fresh default-Agent decision.
        await lockOrgBootstrap(tx, args.orgId);
        instructionsStorage = await ensureBootstrapInstructionsStorage(
          tx,
          args.orgId,
        );
        signal.throwIfAborted();
        const existingAgentId = await existingDefaultAgentId(tx, args.orgId);
        if (existingAgentId) {
          return { bootstrapped: false, agentId: existingAgentId };
        }

        await set(
          writeAgentInstructionsStorageInTransaction$,
          {
            tx,
            orgId: args.orgId,
            agentName: DEFAULT_AGENT_NAME,
            instructions: SEED_INSTRUCTIONS,
          },
          signal,
        );
        signal.throwIfAborted();

        return await finalizeBootstrap(tx, {
          orgId: args.orgId,
          ownerUserId: args.ownerUserId,
          agentId: reservation.agentId,
        });
      },
      { isolationLevel: "read committed" },
    );
    const result = await onRejection(bootstrap, cleanupUnclaimedInstructions);
    signal.throwIfAborted();

    if (result.bootstrapped) {
      L.debug("Org limited-free bootstrap completed", {
        orgId: args.orgId,
        agentId: result.agentId,
      });
    }

    return result;
  },
);
