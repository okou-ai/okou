import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { LIMITED_FREE1_DEFAULT_RUN_MODEL } from "@okouai/api-contracts/contracts/model-providers";
import { SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { agents } from "@okouai/db/schema/agent";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { storages } from "@okouai/db/schema/storage";
import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";
import { nowDate } from "../../lib/time";
import { writeAgentInstructionsStorage$ } from "./agent-instructions-storage.service";
import { newStorageS3Location } from "./storage-s3-prefix.utils";
import { grantOnboardingCredits$ } from "./onboarding-credit-grants.service";
import { upsertOrgNoSecretModelProvider$ } from "./model-provider.service";
import {
  DEFAULT_AGENT_AVATAR_URL,
  DEFAULT_AGENT_DISPLAY_NAME,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SOUND,
} from "./default-agent-profile";
import { onRejection, settle } from "../utils";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";

const L = logger("org-limited-free-bootstrap.service");

interface EnsureOrgLimitedFreeBootstrapArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
}

interface EnsureOrgLimitedFreeBootstrapResult {
  readonly bootstrapped: boolean;
  readonly agentId: string | null;
}

interface BootstrapCandidate extends EnsureOrgLimitedFreeBootstrapArgs {
  readonly agentId: string;
  readonly agentName: string;
  readonly storageId: string;
  readonly s3Prefix: string;
}

class BootstrapPublicationLost extends Error {}

const PAID_BOOTSTRAP_TIERS: readonly string[] = ["pro", "team", "custom"];

const prepareBootstrapMembership$ = command(
  async (
    { set },
    args: EnsureOrgLimitedFreeBootstrapArgs,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const cachedAt = nowDate();
    await db.transaction(async (tx) => {
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
    });
    signal.throwIfAborted();
    const [existing] = await db
      .select({ id: agents.id })
      .from(orgMetadata)
      .innerJoin(
        agents,
        and(
          eq(agents.id, orgMetadata.defaultAgentId),
          eq(agents.orgId, orgMetadata.orgId),
        ),
      )
      .where(eq(orgMetadata.orgId, args.orgId));
    signal.throwIfAborted();
    return existing?.id ?? null;
  },
);

const publishBootstrapCandidate$ = command(
  async (
    { set },
    candidate: BootstrapCandidate,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      // DB/API rollout: outgoing writers publish the default unconditionally.
      // Remove in Release 2 after pre-Release-1 requests drain and all serving
      // and rollback API versions use conditional default publication.
      await tx.execute(
        // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
        sql`SELECT pg_advisory_xact_lock(hashtext('org_bootstrap:' || ${candidate.orgId}))`,
      );
      const [metadata] = await tx
        .select({
          tier: orgMetadata.tier,
          defaultAgentId: orgMetadata.defaultAgentId,
        })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, candidate.orgId));
      if (!metadata) {
        throw new Error(
          "Organization disappeared before bootstrap publication",
        );
      }
      if (metadata.defaultAgentId) {
        throw new BootstrapPublicationLost();
      }
      const paid = PAID_BOOTSTRAP_TIERS.includes(metadata.tier);
      if (!paid) {
        const [grant] = await tx
          .select({ id: creditExpiresRecord.id })
          .from(creditExpiresRecord)
          .where(
            and(
              eq(creditExpiresRecord.orgId, candidate.orgId),
              eq(
                creditExpiresRecord.stripeInvoiceId,
                "limited-free-onboarding",
              ),
            ),
          );
        if (!grant) {
          // A paid-to-free transition raced preparation. Retry the bootstrap
          // through its normal entrypoint instead of publishing without credit.
          throw new Error(
            "Onboarding credit grant is required before default publication",
          );
        }
      }
      const createdAt = nowDate();
      await tx.insert(agents).values({
        id: candidate.agentId,
        orgId: candidate.orgId,
        name: candidate.agentName,
        owner: candidate.ownerUserId,
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
      });
      const [published] = await tx
        .update(orgMetadata)
        .set({
          defaultAgentId: candidate.agentId,
          ...(!paid
            ? { tier: "limited-free-1", onboardingPaymentPending: false }
            : {}),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(orgMetadata.orgId, candidate.orgId),
            isNull(orgMetadata.defaultAgentId),
            // The paid/free decision above was read without a row lock; a
            // concurrent tier change must not be overwritten by this CAS.
            paid
              ? inArray(orgMetadata.tier, [...PAID_BOOTSTRAP_TIERS])
              : eq(orgMetadata.tier, metadata.tier),
          ),
        )
        .returning({ agentId: orgMetadata.defaultAgentId });
      if (!published) {
        const [current] = await tx
          .select({ defaultAgentId: orgMetadata.defaultAgentId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, candidate.orgId));
        if (current?.defaultAgentId) {
          // The candidate Agent must never become visible after losing the CAS.
          throw new BootstrapPublicationLost();
        }
        // Like the paid-to-free grant race above: retry through the normal
        // entrypoint, which re-reads the tier before publishing.
        throw new Error(
          "Organization tier changed during bootstrap publication",
        );
      }
      if (!paid) {
        const entitlement = orgPlanEntitlementValues(
          {
            orgId: candidate.orgId,
            tier: "limited-free-1",
            source: "org_metadata_bootstrap",
          },
          { stripeSubscriptionId: null, sourceMetadata: {} },
        );
        await tx
          .insert(orgPlanEntitlements)
          .values(entitlement)
          .onConflictDoUpdate({
            target: orgPlanEntitlements.orgId,
            set: { ...entitlement, stripeProductId: null, metadataHash: null },
          });
      }
      signal.throwIfAborted();
    });
  },
);

const cleanupBootstrapCandidate$ = command(
  async ({ get, set }, candidate: BootstrapCandidate): Promise<void> => {
    const db = set(writeDb$);
    // Lock the publication row before deciding that an uncertain COMMIT lost.
    // A request still committing must release this row before compensation can
    // observe its authoritative outcome. Read failure retains the candidate.
    const canRemove = await db.transaction(async (tx) => {
      await tx
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, candidate.orgId))
        .for("update");
      const [existing] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.orgId, candidate.orgId),
            eq(agents.name, candidate.agentName),
          ),
        );
      if (existing) {
        return false;
      }
      await tx.delete(storages).where(
        and(
          eq(storages.id, candidate.storageId),
          eq(storages.orgId, candidate.orgId),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          eq(storages.s3Prefix, candidate.s3Prefix),
          notExists(
            tx
              .select({ id: agents.id })
              .from(agents)
              .where(
                and(
                  eq(agents.orgId, candidate.orgId),
                  eq(agents.name, candidate.agentName),
                ),
              ),
          ),
        ),
      );
      return true;
    });
    if (!canRemove) {
      return;
    }
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const objects = await get(
      listS3ObjectsUnderPrefix(bucket, candidate.s3Prefix),
    );
    await get(
      deleteS3Objects(
        bucket,
        objects.map((object) => {
          return object.key;
        }),
      ),
    );
  },
);

const prepareAndPublishBootstrapCandidate$ = command(
  async (
    { set },
    candidate: BootstrapCandidate,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.insert(storages).values({
      id: candidate.storageId,
      orgId: candidate.orgId,
      userId: VOLUME_ORG_USER_ID,
      name: getInstructionsStorageName(candidate.agentName),
      s3Prefix: candidate.s3Prefix,
    });
    signal.throwIfAborted();
    await set(
      writeAgentInstructionsStorage$,
      {
        orgId: candidate.orgId,
        agentName: candidate.agentName,
        instructions: SEED_INSTRUCTIONS,
      },
      signal,
    );
    await set(publishBootstrapCandidate$, candidate, signal);
  },
);

export const ensureOrgLimitedFreeBootstrap$ = command(
  async (
    { set },
    args: EnsureOrgLimitedFreeBootstrapArgs,
    signal: AbortSignal,
  ): Promise<EnsureOrgLimitedFreeBootstrapResult> => {
    const existingId = await set(prepareBootstrapMembership$, args, signal);
    if (existingId) {
      return { bootstrapped: false, agentId: existingId };
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
    await set(grantOnboardingCredits$, args.orgId, signal);
    const agentId = randomUUID();
    const candidate: BootstrapCandidate = {
      ...args,
      agentId,
      agentName: `${DEFAULT_AGENT_NAME}-${agentId}`,
      ...newStorageS3Location(args.orgId),
    };
    const attempt = await settle(
      onRejection(
        set(prepareAndPublishBootstrapCandidate$, candidate, signal),
        () => {
          return set(cleanupBootstrapCandidate$, candidate);
        },
      ),
      signal,
    );
    if (!attempt.ok) {
      const db = set(writeDb$);
      const [published] = await db
        .select({ id: agents.id })
        .from(orgMetadata)
        .innerJoin(
          agents,
          and(
            eq(agents.id, orgMetadata.defaultAgentId),
            eq(agents.orgId, orgMetadata.orgId),
          ),
        )
        .where(eq(orgMetadata.orgId, args.orgId));
      signal.throwIfAborted();
      if (
        published?.id === candidate.agentId ||
        attempt.error instanceof BootstrapPublicationLost
      ) {
        return {
          bootstrapped: published?.id === candidate.agentId,
          agentId: published?.id ?? null,
        };
      }
      throw attempt.error;
    }
    signal.throwIfAborted();
    L.debug("Org limited-free bootstrap completed", {
      orgId: args.orgId,
      agentId,
    });
    return { bootstrapped: true, agentId };
  },
);
