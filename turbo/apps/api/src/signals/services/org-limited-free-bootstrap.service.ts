import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import {
  usagePackCreditGrantValues,
  usagePackCreditGrantReadPlan,
  requireUsagePackCreditGrant,
} from "./usage-pack-credit.service";
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
  onboardingCreditGrantPlan,
  logOnboardingCreditsAlreadyGranted,
  LIMITED_FREE_ONBOARDING_CREDITS,
  onboardingCreditsExpiresAt,
} from "./onboarding-credit-grants.service";
import {
  orgPlanEntitlementValues,
  orgPlanEntitlementUpdateValues,
  resolveStripeSubscriptionSnapshot,
} from "./org-plan-entitlements.service";

const L = logger("org-limited-free-bootstrap.service");
const PAID_TIERS = ["pro", "team", "custom"] as const;

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

function bootstrapAgentValues(
  args: EnsureOrgLimitedFreeBootstrapArgs,
  agentId: string,
) {
  const createdAt = nowDate();
  return {
    id: agentId,
    orgId: args.orgId,
    name: DEFAULT_AGENT_NAME,
    owner: args.ownerUserId,
    visibility: "public" as const,
    displayName: DEFAULT_AGENT_DISPLAY_NAME,
    description: null,
    instructions: SEED_INSTRUCTIONS,
    sound: DEFAULT_AGENT_SOUND,
    avatarUrl: DEFAULT_AGENT_AVATAR_URL,
    createdAt,
    updatedAt: createdAt,
  };
}

function bootstrapMetadataWritePlan(orgId: string, agentId: string) {
  return {
    values: {
      orgId,
      defaultAgentId: agentId,
      tier: "limited-free-1",
      onboardingPaymentPending: false,
      onboardingComplete: false,
      updatedAt: nowDate(),
    },
    conflict: {
      target: orgMetadataCanonicalWrites.orgId,
      set: {
        defaultAgentId: agentId,
        tier: "limited-free-1",
        onboardingPaymentPending: false,
        updatedAt: nowDate(),
      },
      // The earlier tier read is not write authority. Preserve a concurrent paid writer.
      setWhere: notInArray(orgMetadataCanonicalWrites.tier, [...PAID_TIERS]),
    },
  };
}

function bootstrapEntitlementValues(orgId: string) {
  const args = {
    orgId,
    tier: "limited-free-1",
    source: "org_metadata_bootstrap",
  } as const;
  return orgPlanEntitlementValues(
    args,
    resolveStripeSubscriptionSnapshot(args),
  );
}

function completedBootstrapResult(
  args: EnsureOrgLimitedFreeBootstrapArgs,
  result: EnsureOrgLimitedFreeBootstrapResult,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (result.bootstrapped) {
    L.debug("Org limited-free bootstrap completed", {
      orgId: args.orgId,
      agentId: result.agentId,
    });
  }
  return result;
}

export const ensureOrgLimitedFreeBootstrap$ = command(
  async (
    { set },
    args: EnsureOrgLimitedFreeBootstrapArgs,
    signal: AbortSignal,
  ): Promise<EnsureOrgLimitedFreeBootstrapResult> => {
    const writeDb = set(writeDb$);
    const reservation = await set(
      reserveBootstrapAgent$,
      { ...args, agentId: randomUUID() },
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
          const [existingOrg] = await tx
            .select({ defaultAgentId: orgMetadata.defaultAgentId })
            .from(orgMetadata)
            .where(eq(orgMetadata.orgId, args.orgId))
            .limit(1);
          if (existingOrg?.defaultAgentId) {
            const [existing] = await tx
              .select({ id: agents.id })
              .from(agents)
              .where(
                and(
                  eq(agents.id, existingOrg.defaultAgentId),
                  eq(agents.orgId, args.orgId),
                ),
              )
              .limit(1);
            if (existing) {
              return { bootstrapped: false, agentId: existing.id };
            }
          }
          await tx
            .insert(agents)
            .values(bootstrapAgentValues(args, reservation.agentId))
            .onConflictDoNothing();
          const [agentRow] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.orgId, args.orgId),
                eq(agents.name, DEFAULT_AGENT_NAME),
              ),
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
          if (isPaidTier(orgRow?.tier ?? "limited-free-1")) {
            await tx
              .update(orgMetadata)
              .set({ defaultAgentId: agentRow.id, updatedAt: nowDate() })
              .where(eq(orgMetadata.orgId, args.orgId));
            return { bootstrapped: true, agentId: agentRow.id };
          }
          const metadata = bootstrapMetadataWritePlan(args.orgId, agentRow.id);
          const initialized = await tx
            .insert(orgMetadataCanonicalWrites)
            .values(metadata.values)
            .onConflictDoUpdate(metadata.conflict)
            .returning({ orgId: orgMetadata.orgId });
          for (const row of initialized) {
            const values = bootstrapEntitlementValues(row.orgId);
            await tx
              .insert(orgPlanEntitlements)
              .values(values)
              .onConflictDoUpdate({
                target: orgPlanEntitlements.orgId,
                set: orgPlanEntitlementUpdateValues(values),
              });
          }
          if (initialized.length === 0) {
            // A paid writer won the row; complete only the Agent reference.
            await tx
              .update(orgMetadata)
              .set({ defaultAgentId: agentRow.id, updatedAt: nowDate() })
              .where(eq(orgMetadata.orgId, args.orgId));
            return { bootstrapped: true, agentId: agentRow.id };
          }
          const plan = onboardingCreditGrantPlan(
            args.orgId,
            args.ownerUserId,
            LIMITED_FREE_ONBOARDING_CREDITS,
            onboardingCreditsExpiresAt(nowDate()),
          );
          // The shared receipt prevents duplicate awards across rolling API versions.
          const rows = await tx
            .insert(creditExpiresRecord)
            .values(plan.receipt)
            .onConflictDoNothing()
            .returning({ id: creditExpiresRecord.id });
          if (rows.length === 0) {
            logOnboardingCreditsAlreadyGranted(args.orgId);
            return { bootstrapped: true, agentId: agentRow.id };
          }
          const [inserted] = await tx
            .insert(usagePackCreditGrants)
            .values(usagePackCreditGrantValues(plan.grant))
            .onConflictDoNothing({
              target: usagePackCreditGrants.idempotencyKey,
            })
            .returning({ id: usagePackCreditGrants.id });
          if (!inserted) {
            const read = usagePackCreditGrantReadPlan(plan.grant);
            const [existing] = await tx
              .select(read.columns)
              .from(usagePackCreditGrants)
              .where(read.condition)
              .limit(1);
            requireUsagePackCreditGrant(existing, plan.grant);
          }
          return { bootstrapped: true, agentId: agentRow.id };
        },
        { isolationLevel: "read committed" },
      );
    })();
    return completedBootstrapResult(args, await bootstrap, signal);
  },
);
