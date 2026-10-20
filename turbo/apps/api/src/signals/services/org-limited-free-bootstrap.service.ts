import { randomUUID } from "node:crypto";

import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  DEFAULT_AGENT_AVATAR_URL,
  DEFAULT_AGENT_DISPLAY_NAME,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SOUND,
} from "./default-agent-profile";
import {
  grantOnboardingUsagePackCredits,
  LIMITED_FREE_ONBOARDING_CREDITS,
  onboardingCreditsExpiresAt,
} from "./onboarding-credit-grants.service";
import {
  upsertOrgPlanEntitlement,
  writeOrgMetadataWithPlanEntitlements,
} from "./org-plan-entitlements.service";

const L = logger("org-limited-free-bootstrap.service");
const PAID_TIERS = ["pro", "team", "custom"] as const;

type DbTransaction = Tx;

interface EnsureOrgLimitedFreeBootstrapArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
}

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

function isPaidTier(tier: string): boolean {
  return PAID_TIERS.some((paidTier) => {
    return paidTier === tier;
  });
}

const reserveBootstrapAgent$ = command(
  async (
    { get, set },
    args: EnsureOrgLimitedFreeBootstrapArgs & { readonly agentId: string },
    signal: AbortSignal,
  ): Promise<BootstrapReservation> => {
    const writeDb = set(writeDb$);
    const cachedAt = nowDate();
    const membership = writeDb
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
      })
      .returning({
        orgId: orgMembersCache.orgId,
        userId: orgMembersCache.userId,
      })
      .getSQL();
    // Both inserted and updated membership identities prepare preferences.
    // Keep the partial target list so omitted fields retain database defaults.
    await writeDb.execute(sql`WITH membership AS (${membership})
      INSERT INTO ${orgMembersMetadata} (
        org_id, user_id, selected_model, created_at, updated_at
      ) SELECT membership.org_id, membership.user_id, ${AUTO_SELECTED_MODEL},
        ${sql.param(cachedAt, orgMembersMetadata.createdAt)},
        ${sql.param(cachedAt, orgMembersMetadata.updatedAt)} FROM membership
      ON CONFLICT DO NOTHING`);
    signal.throwIfAborted();

    // Preparation stays committed if a later ordinary lookup fails.
    const db = get(db$);
    const [orgRow] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (orgRow?.defaultAgentId) {
      const [existing] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.id, orgRow.defaultAgentId),
            eq(agents.orgId, args.orgId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (existing) {
        return { status: "skipped", agentId: existing.id };
      }
    }

    return { status: "reserved", agentId: args.agentId };
  },
);

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
      instructions: SEED_INSTRUCTIONS,
      sound: DEFAULT_AGENT_SOUND,
      avatarUrl: DEFAULT_AGENT_AVATAR_URL,
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

  await grantOnboardingUsagePackCredits(
    tx,
    args.orgId,
    args.ownerUserId,
    LIMITED_FREE_ONBOARDING_CREDITS,
    onboardingCreditsExpiresAt(nowDate()),
  );

  return { bootstrapped: true, agentId: agentRow.id };
}

export const ensureOrgLimitedFreeBootstrap$ = command(
  async (
    { set },
    args: EnsureOrgLimitedFreeBootstrapArgs,
    signal: AbortSignal,
  ): Promise<EnsureOrgLimitedFreeBootstrapResult> => {
    const writeDb = set(writeDb$);
    const agentId = randomUUID();
    const reservation = await set(
      reserveBootstrapAgent$,
      { ...args, agentId },
      signal,
    );
    signal.throwIfAborted();

    if (reservation.status === "skipped") {
      return { bootstrapped: false, agentId: reservation.agentId };
    }

    const bootstrap = (async () => {
      // Bootstrap still commits the default Agent with its billing entitlements.
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0218; new non-billing transactions are prohibited.
      return await writeDb.transaction(
        async (tx) => {
          return await finalizeBootstrap(tx, {
            ...args,
            agentId: reservation.agentId,
          });
        },
        { isolationLevel: "read committed" },
      );
    })();
    const result = await bootstrap;
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
