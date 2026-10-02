import { preparedVolumePublicationSql } from "./storage-volume-publication-sql";
import { StorageVersionIdentityConflictError } from "./storage-version-registration.service";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
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
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, exists, ne, notInArray, sql } from "drizzle-orm";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { prepareAgentInstructionsStorage$ } from "./agent-instructions-storage.service";
import type { PreparedServerSideVolume } from "./storage-volume-publication.service";
import {
  storageObjectCleanupJobValues,
  executeStorageObjectCleanupWork$,
} from "./storage-object-cleanup.service";
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
import { onRejection, settleIncludingAbort } from "../utils";
import { modelCatalog$, type ModelCatalog } from "./model-catalog.service";

const L = logger("org-limited-free-bootstrap.service");
const PAID_TIERS = ["pro", "team", "custom"] as const;

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

function bootstrapStorageValues(
  orgId: string,
  storage: BootstrapInstructionsStorage,
) {
  return {
    id: storage.id,
    orgId,
    userId: VOLUME_ORG_USER_ID,
    name: getInstructionsStorageName(DEFAULT_AGENT_NAME),
    s3Prefix: storage.s3Prefix,
  };
}

async function ensureBootstrapInstructionsStorage(
  tx: DbTransaction,
  orgId: string,
  candidate: BootstrapInstructionsStorage,
) {
  const [inserted] = await tx
    .insert(storages)
    .values(bootstrapStorageValues(orgId, candidate))
    .onConflictDoNothing({
      target: [storages.orgId, storages.userId, storages.name],
    })
    .returning({ id: storages.id });
  // Take the strong parent lock directly, not NO KEY UPDATE then an upgrade:
  // version writers may already own FK KEY SHARE before updating this row.
  const [storage] = await tx
    .select({
      id: storages.id,
      s3Prefix: storages.s3Prefix,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, getInstructionsStorageName(DEFAULT_AGENT_NAME)),
      ),
    )
    .for("update");
  if (!storage) {
    throw new Error("Canonical bootstrap instructions Storage disappeared");
  }
  return { ...storage, insertedCandidate: inserted?.id === storage.id };
}

async function enqueueBootstrapPrefixCleanup(
  tx: DbTransaction,
  args: EnsureOrgLimitedFreeBootstrapArgs,
  s3Prefix: string,
  signal: AbortSignal,
): Promise<string> {
  const receipt = storageObjectCleanupJobValues({
    bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
    target: { kind: "prefix", value: s3Prefix },
    orgId: args.orgId,
    userId: args.ownerUserId,
  });
  await tx
    .insert(backgroundJobs)
    .values(receipt)
    .onConflictDoNothing({ target: backgroundJobs.id });
  signal.throwIfAborted();
  return receipt.id;
}

async function publishBootstrap(
  catalogSnapshot: ModelCatalog,
  tx: DbTransaction,
  args: EnsureOrgLimitedFreeBootstrapArgs & {
    readonly agentId: string;
    readonly candidate: BootstrapInstructionsStorage;
    readonly volume: PreparedServerSideVolume;
  },
  signal: AbortSignal,
): Promise<{
  readonly result: EnsureOrgLimitedFreeBootstrapResult;
  readonly cleanupJobIds: readonly string[];
}> {
  const storage = await ensureBootstrapInstructionsStorage(
    tx,
    args.orgId,
    args.candidate,
  );
  signal.throwIfAborted();
  const existingAgentId = await existingDefaultAgentId(tx, args.orgId);
  signal.throwIfAborted();
  const cleanupJobIds: string[] = [];
  if (
    storage.id === args.candidate.id &&
    storage.s3Prefix !== args.candidate.s3Prefix
  ) {
    throw new Error("Bootstrap candidate Storage generation changed");
  }
  if (existingAgentId || storage.headVersionId) {
    // A concurrent winner (including edited seed instructions) owns this HEAD.
    // INSERT RETURNING, not identity equality, owns unpublished retirement.
    if (storage.insertedCandidate) {
      await tx.delete(storages).where(eq(storages.id, args.candidate.id));
      signal.throwIfAborted();
    }
    if (storage.id !== args.candidate.id || storage.insertedCandidate) {
      cleanupJobIds.push(
        await enqueueBootstrapPrefixCleanup(
          tx,
          args,
          args.candidate.s3Prefix,
          signal,
        ),
      );
    }
    if (!existingAgentId && storage.headVersionId) {
      const [head] = await tx
        .select({ id: storageVersions.id })
        .from(storageVersions)
        .where(
          and(
            eq(storageVersions.id, storage.headVersionId),
            eq(storageVersions.storageId, storage.id),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!head) {
        throw new Error(
          "Bootstrap instructions HEAD belongs to another Storage",
        );
      }
    }
    const result = existingAgentId
      ? { bootstrapped: false, agentId: existingAgentId }
      : await finalizeBootstrap(catalogSnapshot, tx, args);
    signal.throwIfAborted();
    return { result, cleanupJobIds };
  }

  if (storage.id !== args.candidate.id) {
    const [version] = await tx
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .where(eq(storageVersions.storageId, storage.id))
      .limit(1);
    signal.throwIfAborted();
    if (version) {
      throw new Error(
        "Bootstrap instructions Storage has versions but no HEAD",
      );
    }
    // The locked incumbent has never published content. Retire its exact
    // generation; never rebind our logical version to its UUID or prefix.
    await tx.delete(storages).where(eq(storages.id, storage.id));
    signal.throwIfAborted();
    await tx
      .insert(storages)
      .values(bootstrapStorageValues(args.orgId, args.candidate));
    signal.throwIfAborted();
    cleanupJobIds.push(
      await enqueueBootstrapPrefixCleanup(tx, args, storage.s3Prefix, signal),
    );
  }

  const publishedStorage = await tx.execute(
    preparedVolumePublicationSql(args.volume, nowDate()),
  );
  signal.throwIfAborted();
  if (publishedStorage.rowCount !== 1) {
    throw new StorageVersionIdentityConflictError(
      args.volume.version.versionId,
    );
  }
  const result = await finalizeBootstrap(catalogSnapshot, tx, args);
  signal.throwIfAborted();
  return { result, cleanupJobIds };
}

const cleanupBootstrapCandidate$ = command(
  async (
    { set },
    args: EnsureOrgLimitedFreeBootstrapArgs & {
      readonly candidate: BootstrapInstructionsStorage;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const jobId = await db.transaction(async (tx) => {
      // Bound recovery SQL independently of the cancelled request. Publication
      // may still be settling for this exact candidate; a timeout is not proof
      // that it rolled back.
      await tx.execute(sql`SELECT
        set_config('statement_timeout', '5000ms', true),
        set_config('lock_timeout', '1000ms', true)`);
      signal.throwIfAborted();
      // Arbitrate only the captured primary key. The private probe name cannot
      // wait on/adopt a peer's canonical generation. A pending commit involving
      // this exact UUID must settle before absence can mean rollback.
      const [probe] = await tx
        .insert(storages)
        .values({
          ...bootstrapStorageValues(args.orgId, args.candidate),
          name: `${getInstructionsStorageName(DEFAULT_AGENT_NAME)}--cleanup-${args.candidate.id}`,
        })
        .onConflictDoNothing()
        .returning({ id: storages.id });
      signal.throwIfAborted();
      const [storage] = await tx
        .select({ id: storages.id })
        .from(storages)
        .where(
          and(
            eq(storages.id, args.candidate.id),
            eq(storages.orgId, args.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(storages.s3Prefix, args.candidate.s3Prefix),
          ),
        );
      signal.throwIfAborted();
      if (storage && !probe) {
        // An uncertain commit succeeded. Never delete a live captured parent,
        // and never redirect compensation to the current same-name generation.
        return null;
      }
      if (probe) {
        await tx.delete(storages).where(eq(storages.id, probe.id));
        signal.throwIfAborted();
      }
      return await enqueueBootstrapPrefixCleanup(
        tx,
        args,
        args.candidate.s3Prefix,
        signal,
      );
    });
    signal.throwIfAborted();
    if (jobId) {
      await set(executeStorageObjectCleanupWork$, { jobIds: [jobId] }, signal);
    }
  },
);

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
  return PAID_TIERS.some((paidTier) => {
    return paidTier === tier;
  });
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
  catalogSnapshot: ModelCatalog,
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

  const systemDefaultModel = catalogSnapshot.systemDefaultModel;
  const hasConfiguredPolicies = exists(
    tx
      .select({ id: orgModelPolicies.id })
      .from(orgModelPolicies)
      .where(
        and(
          eq(orgModelPolicies.orgId, args.orgId),
          ne(orgModelPolicies.model, systemDefaultModel),
        ),
      ),
  );
  const initialized = await writeOrgMetadataWithPlanEntitlements(tx, {
    writeOrgMetadata: async (writeTx) => {
      return await writeTx
        .insert(orgMetadataCanonicalWrites)
        .values({
          orgId: args.orgId,
          defaultAgentId: agentRow.id,
          tier: "limited-free-1",
          onboardingPaymentPending: false,
          onboardingComplete: false,
          // A policy can be configured before metadata exists. Preserve the
          // Custom policy contract on INSERT as well as on conflict. Unconfigured
          // new organizations use Auto; the schema's Custom default is unchanged.
          modelMode: sql`CASE WHEN ${hasConfiguredPolicies} THEN 'custom' ELSE 'auto' END`,
          updatedAt: nowDate(),
        })
        .onConflictDoUpdate({
          target: orgMetadataCanonicalWrites.orgId,
          set: {
            defaultAgentId: agentRow.id,
            tier: "limited-free-1",
            onboardingPaymentPending: false,
            // Another writer may have created the row first. Only an org with
            // no configured non-default model becomes Auto; configured models
            // keep the stored mode.
            modelMode: sql`CASE WHEN ${hasConfiguredPolicies} THEN ${orgMetadataCanonicalWrites.modelMode} ELSE 'auto' END`,
            updatedAt: nowDate(),
          },
          // The earlier tier read is not write authority. Stripe can commit
          // a paid tier before this upsert owns the conflicting metadata row.
          setWhere: notInArray(orgMetadataCanonicalWrites.tier, [
            ...PAID_TIERS,
          ]),
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

  if (initialized.length === 0) {
    // A paid writer won the metadata row. Conflict handling still owns that
    // row; complete only the Agent reference and preserve its paid snapshot.
    await tx
      .update(orgMetadata)
      .set({ defaultAgentId: agentRow.id, updatedAt: nowDate() })
      .where(eq(orgMetadata.orgId, args.orgId));
    return { bootstrapped: true, agentId: agentRow.id };
  }

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
        selectedModel: (await get(modelCatalog$)).systemDefaultModel,
      },
      signal,
    );
    signal.throwIfAborted();

    const location = newStorageS3Location(args.orgId);
    const candidate = { id: location.storageId, s3Prefix: location.s3Prefix };
    const bootstrap = (async () => {
      // No canonical parent is reserved and no transaction/lock spans the PUTs.
      // Every competing preparation has its own logical and physical generation.
      const volume = await set(
        prepareAgentInstructionsStorage$,
        {
          orgId: args.orgId,
          agentName: DEFAULT_AGENT_NAME,
          instructions: SEED_INSTRUCTIONS,
          storage: candidate,
        },
        signal,
      );
      return await writeDb.transaction(
        async (tx) => {
          return await publishBootstrap(
            await get(modelCatalog$),
            tx,
            { ...args, agentId: reservation.agentId, candidate, volume },
            signal,
          );
        },
        { isolationLevel: "read committed" },
      );
    })();
    const publication = await onRejection(bootstrap, async () => {
      // Cancellation ends request work, not the owned compensation obligation.
      // Preserve the original error even if inventory persistence is unavailable.
      const cleanup = await settleIncludingAbort(
        set(
          cleanupBootstrapCandidate$,
          { ...args, candidate },
          AbortSignal.timeout(5000),
        ),
      );
      if (!cleanup.ok) {
        L.warn("Bootstrap candidate cleanup failed", {
          orgId: args.orgId,
          storageId: candidate.id,
          error: cleanup.error,
        });
      }
    });
    signal.throwIfAborted();
    if (publication.cleanupJobIds.length > 0) {
      // Inventory is already committed; an interrupted attempt remains retryable.
      await settleIncludingAbort(
        set(
          executeStorageObjectCleanupWork$,
          { jobIds: publication.cleanupJobIds },
          AbortSignal.timeout(5000),
        ),
      );
    }
    signal.throwIfAborted();
    const result = publication.result;

    if (result.bootstrapped) {
      L.debug("Org limited-free bootstrap completed", {
        orgId: args.orgId,
        agentId: result.agentId,
      });
    }

    return result;
  },
);
