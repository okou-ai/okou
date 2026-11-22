import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import {
  and,
  eq,
  exists,
  getTableColumns,
  sql,
  SQL,
  type Column,
} from "drizzle-orm";
import { QueryBuilder, type PgTable } from "drizzle-orm/pg-core";
import { boolean, literal, object } from "zod";
import { nowDate } from "../../lib/time";
import {
  LIMITED_FREE_ONBOARDING_CREDITS,
  onboardingCreditGrantPlan,
  onboardingCreditsExpiresAt,
} from "./onboarding-credit-grants.service";
import {
  orgPlanEntitlementValues,
  resolveStripeSubscriptionSnapshot,
} from "./org-plan-entitlements.service";
import { usagePackCreditGrantValues } from "./usage-pack-credit.service";

interface BootstrapPublicationArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
}

export const orgLimitedFreeBootstrapPublicationRow = object({
  receiptAlreadyGranted: boolean(),
  complete: literal(1),
});

function publicationFields(
  table: PgTable,
  values: Readonly<Record<string, unknown>>,
) {
  const columns: Readonly<Record<string, Column>> = getTableColumns(table);
  return Object.entries(values).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }
    const column = columns[key];
    if (!column) {
      throw new Error("Bootstrap publication contains an unknown column");
    }
    return [
      {
        key,
        name: sql.identifier(column.name),
        value: value instanceof SQL ? value : sql.param(value, column),
      },
    ];
  });
}

function publicationInsert(
  table: PgTable,
  values: Readonly<Record<string, unknown>>,
  source: SQL,
  conflict: SQL,
  returning: SQL,
) {
  const fields = publicationFields(table, values);
  return sql`INSERT INTO ${table} (${sql.join(
    fields.map((field) => {
      return field.name;
    }),
    sql`, `,
  )}) SELECT ${sql.join(
    fields.map((field) => {
      return field.value;
    }),
    sql`, `,
  )} ${source} ${conflict} RETURNING ${returning}`;
}

function bootstrapMetadataPublication(args: BootstrapPublicationArgs): SQL {
  const at = nowDate();
  // Serialize initialization against subscription changes on the same workspace row.
  return sql`INSERT INTO ${orgMetadataCanonicalWrites} (org_id, tier, updated_at)
    VALUES (${args.orgId}, 'limited-free-1', ${sql.param(at, orgMetadataCanonicalWrites.updatedAt)})
    ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
    WHERE ${orgMetadataCanonicalWrites.tier} = 'limited-free-1'
    RETURNING org_id, tier`;
}

function bootstrapEntitlementPublication(orgId: string): SQL {
  const args = {
    orgId,
    tier: "limited-free-1",
    source: "org_metadata_bootstrap",
  } as const;
  const values = orgPlanEntitlementValues(
    args,
    resolveStripeSubscriptionSnapshot(args),
  );
  return publicationInsert(
    orgPlanEntitlements,
    values,
    sql`FROM bootstrap_org`,
    sql`ON CONFLICT (org_id) DO NOTHING`,
    sql`org_id`,
  );
}

export function orgLimitedFreeBootstrapPublicationSql(
  args: BootstrapPublicationArgs,
): SQL {
  const query = new QueryBuilder();
  const metadata = bootstrapMetadataPublication(args);
  const entitlement = bootstrapEntitlementPublication(args.orgId);
  const plan = onboardingCreditGrantPlan(
    args.orgId,
    args.ownerUserId,
    LIMITED_FREE_ONBOARDING_CREDITS,
    onboardingCreditsExpiresAt(nowDate()),
  );
  const receipt = publicationInsert(
    creditExpiresRecord,
    plan.receipt,
    sql`FROM bootstrap_org WHERE tier = 'limited-free-1'
      AND (SELECT count(*) FROM bootstrap_entitlement) >= 0`,
    sql`ON CONFLICT DO NOTHING`,
    sql`id`,
  );
  const grant = publicationInsert(
    usagePackCreditGrants,
    usagePackCreditGrantValues(plan.grant),
    sql`FROM bootstrap_receipt WHERE true`,
    sql`ON CONFLICT (idempotency_key) DO NOTHING`,
    sql`id`,
  );
  // Match the existing Date.getTime() comparison, including driver truncation
  // of PostgreSQL timestamp precision to milliseconds. Never reset remaining.
  const existingGrant = query
    .select({ id: usagePackCreditGrants.id })
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.idempotencyKey, plan.grant.idempotencyKey),
        eq(usagePackCreditGrants.orgId, plan.grant.orgId),
        eq(usagePackCreditGrants.userId, plan.grant.userId),
        eq(usagePackCreditGrants.grantType, plan.grant.grantType),
        eq(usagePackCreditGrants.originalAmount, plan.grant.amount),
        sql`date_trunc('milliseconds', ${usagePackCreditGrants.expiresAt}) = ${sql.param(plan.grant.expiresAt, usagePackCreditGrants.expiresAt)}`,
      ),
    );
  return sql`WITH bootstrap_org AS (${metadata}),
    bootstrap_entitlement AS (${entitlement}),
    bootstrap_receipt AS (${receipt}),
    bootstrap_grant AS (${grant})
    SELECT (EXISTS (SELECT 1 FROM bootstrap_org WHERE tier = 'limited-free-1')
        AND NOT EXISTS (SELECT 1 FROM bootstrap_receipt)) AS "receiptAlreadyGranted",
      1 / CASE WHEN
        ((SELECT count(*) FROM bootstrap_grant) = (SELECT count(*) FROM bootstrap_receipt)
          OR (EXISTS (SELECT 1 FROM bootstrap_receipt) AND NOT EXISTS (SELECT 1 FROM bootstrap_grant)
            AND ${exists(existingGrant)}))
        THEN 1 ELSE 0 END AS complete`;
}
