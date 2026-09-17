/** Infrastructure exception: precise issued-window consumption, replaced
 * entitlement timing, depleted historical packs and arbitrary threshold amounts
 * have no product API writer. UUID-owned fixtures exercise the real DB readers
 * and workers; no shared production identity or global table mutation is used. */
import { randomUUID } from "node:crypto";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { eq, inArray, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { db } from "../lib/db";

export const builtinMemoryQuotaCases = [
  "short-below",
  "short-exact",
  "short-above",
  "weekly-below",
  "weekly-exact",
  "weekly-above",
  "short-exhausted",
  "weekly-overconsumed",
  "uncreated-windows",
  "window-expired",
  "window-future",
  "entitlement-replaced",
  "entitlement-future",
  "entitlement-canceled",
  "entitlement-expired",
  "entitlement-stale",
  "past-due-grace",
  "unpaid-outside-grace",
  "past-due-current-low",
  "pool-below",
  "pool-exact",
  "pool-above",
  "pool-zero",
  "pool-aggregate",
  "pool-expired",
  "pool-future",
  "other-member",
  "other-org",
  "no-grants",
  "pool-replenished",
  "pool-beyond-page",
  "pool-other-healthy",
  "large-exact-pool",
  "large-low-pool",
] as const;
type BuiltinMemoryQuotaCase = (typeof builtinMemoryQuotaCases)[number];

function createQuotaFixture(
  owner: { orgId: string; userId: string },
  at: Date,
) {
  const before = new Date(at.getTime() - 3_600_000);
  const after = new Date(at.getTime() + 3_600_000);
  const grantIds: string[] = [];
  const entitlementId = randomUUID();
  onTestFinished(async () => {
    await db()
      .delete(orgUsageAllowanceEntitlements)
      .where(eq(orgUsageAllowanceEntitlements.id, entitlementId));
    if (grantIds.length) {
      await db()
        .delete(usagePackCreditGrants)
        .where(inArray(usagePackCreditGrants.id, grantIds));
    }
  });
  async function grant(
    original: string,
    remaining: string,
    overrides: {
      userId?: string;
      orgId?: string;
      expired?: boolean;
      future?: boolean;
      bonus?: boolean;
    } = {},
  ) {
    const id = randomUUID();
    grantIds.push(id);
    await db()
      .insert(usagePackCreditGrants)
      .values({
        id,
        orgId: overrides.orgId ?? owner.orgId,
        userId: overrides.userId ?? owner.userId,
        idempotencyKey: id,
        grantType: overrides.bonus ? "bonus" : "purchased",
        originalAmount: sql`${original}::bigint`,
        remainingAmount: sql`${remaining}::bigint`,
        createdAt: overrides.future ? after : before,
        expiresAt: overrides.expired
          ? before
          : new Date(after.getTime() + 3_600_000),
      });
  }
  return { owner, at, before, after, grantIds, entitlementId, grant };
}

type QuotaFixture = ReturnType<typeof createQuotaFixture>;

async function seedMemberPool(
  fixture: QuotaFixture,
  scenario: BuiltinMemoryQuotaCase,
) {
  const { owner, before, after, grantIds, grant } = fixture;
  let denied = false;
  switch (scenario) {
    case "pool-beyond-page": {
      const grants = Array.from({ length: 1025 }, () => {
        const id = randomUUID();
        grantIds.push(id);
        return {
          id,
          orgId: owner.orgId,
          userId: owner.userId,
          idempotencyKey: id,
          grantType: "purchased" as const,
          originalAmount: 1,
          remainingAmount: 0,
          createdAt: before,
          expiresAt: after,
        };
      });
      await db().insert(usagePackCreditGrants).values(grants);
      await grant("100", "100", { bonus: true });
      denied = true;
      break;
    }
    case "pool-other-healthy": {
      await grant("10000", "1000");
      await grant("10000", "10000", { userId: randomUUID() });
      denied = true;
      break;
    }
    case "pool-below": {
      await grant("10000", "2499");
      denied = true;
      break;
    }
    case "pool-exact": {
      await grant("10000", "2500");
      break;
    }
    case "pool-above": {
      await grant("10000", "2501");
      break;
    }
    case "pool-zero": {
      await grant("10000", "0");
      denied = true;
      break;
    }
    case "pool-aggregate": {
      await grant("7500", "0");
      await grant("2500", "2500", { bonus: true });
      break;
    }
    case "pool-expired": {
      await grant("10000", "0", { expired: true });
      break;
    }
    case "pool-future": {
      await grant("10000", "0", { future: true });
      break;
    }
    case "other-member": {
      await grant("10000", "0", { userId: randomUUID() });
      break;
    }
    case "other-org": {
      await grant("10000", "0", { orgId: randomUUID() });
      break;
    }
    case "pool-replenished": {
      await grant("10000", "0");
      await grant("10000", "10000", { bonus: true });
      break;
    }
    case "large-exact-pool": {
      await grant("9007199254740996", "2251799813685249");
      break;
    }
    case "large-low-pool": {
      await grant("9007199254740993", "2251799813685248");
      denied = true;
      break;
    }
  }
  return { denied };
}

function allowanceStatus(scenario: BuiltinMemoryQuotaCase): string {
  if (scenario === "entitlement-canceled") {
    return "canceled";
  }
  if (scenario.startsWith("past-due")) {
    return "past_due";
  }
  if (scenario.startsWith("unpaid")) {
    return "unpaid";
  }
  return "manual_active";
}

async function seedAllowance(
  fixture: QuotaFixture,
  scenario: BuiltinMemoryQuotaCase,
) {
  const { owner, at, before, after, entitlementId, grant } = fixture;
  let denied = false;

  const expired = [
    "entitlement-expired",
    "entitlement-stale",
    "past-due-grace",
    "unpaid-outside-grace",
  ].includes(scenario);
  const stale = [
    "entitlement-stale",
    "past-due-grace",
    "unpaid-outside-grace",
  ].includes(scenario);
  const effective =
    scenario === "entitlement-replaced"
      ? new Date(at.getTime() - 1000)
      : scenario === "entitlement-future"
        ? after
        : new Date(at.getTime() - 3 * 86_400_000);
  await db()
    .insert(orgUsageAllowanceEntitlements)
    .values({
      id: entitlementId,
      orgId: owner.orgId,
      status: allowanceStatus(scenario),
      shortWindowSeconds: 18_000,
      shortWindowUnits: 10_000,
      weeklyWindowSeconds: 604_800,
      weeklyWindowUnits: 100_000,
      effectiveAt: effective,
      expiresAt: expired
        ? new Date(
            at.getTime() -
              (scenario === "unpaid-outside-grace" ? 25 : 1) * 3_600_000,
          )
        : null,
      stripeSubscriptionId: stale ? `sub_${randomUUID()}` : null,
    });
  if (scenario !== "uncreated-windows") {
    const kind = scenario.startsWith("weekly") ? "weekly" : "short";
    const original = kind === "short" ? 10_000 : 100_000;
    let consumed = original - 1;
    if (scenario.endsWith("-below")) {
      consumed = original * 0.75 + 1;
    }
    if (scenario.endsWith("-exact")) {
      consumed = original * 0.75;
    }
    if (scenario.endsWith("-above")) {
      consumed = original * 0.75 - 1;
    }
    if (scenario.endsWith("-exhausted")) {
      consumed = original;
    }
    if (scenario.endsWith("-overconsumed")) {
      consumed = original + 1;
    }
    await db()
      .insert(orgUsageAllowanceWindows)
      .values({
        orgId: owner.orgId,
        entitlementId,
        kind,
        unitLimit: original,
        consumedUnits: consumed,
        startsAt: scenario === "window-future" ? after : before,
        expiresAt:
          scenario === "window-expired"
            ? at
            : new Date(after.getTime() + 3_600_000),
      });
    denied =
      scenario.endsWith("-below") ||
      scenario.endsWith("-exhausted") ||
      scenario.endsWith("-overconsumed") ||
      scenario === "past-due-current-low";
  }
  // A healthy member reserve must never hide a low org allowance.
  await grant("10000", "10000");
  return { denied };
}

export async function seedMemoryQuotaCase(
  owner: { orgId: string; userId: string },
  at: Date,
  scenario: BuiltinMemoryQuotaCase,
) {
  const fixture = createQuotaFixture(owner, at);
  return scenario.startsWith("pool-") ||
    scenario.startsWith("large-") ||
    scenario.startsWith("other-") ||
    scenario === "no-grants"
    ? await seedMemberPool(fixture, scenario)
    : await seedAllowance(fixture, scenario);
}
