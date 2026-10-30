import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { agents } from "@okouai/db/schema/agent";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import {
  and,
  eq,
  exists,
  getTableColumns,
  isNotNull,
  isNull,
  notInArray,
  notExists,
  sql,
  SQL,
  type Column,
} from "drizzle-orm";
import { QueryBuilder, type PgTable } from "drizzle-orm/pg-core";
import { boolean, literal, object, string } from "zod";
import { nowDate } from "../../lib/time";
import {
  DEFAULT_AGENT_AVATAR_URL,
  DEFAULT_AGENT_DISPLAY_NAME,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SOUND,
} from "./default-agent-profile";
import {
  LIMITED_FREE_ONBOARDING_CREDITS,
  onboardingCreditGrantPlan,
  onboardingCreditsExpiresAt,
} from "./onboarding-credit-grants.service";
import {
  orgPlanEntitlementValues,
  orgPlanEntitlementUpdateValues,
  resolveStripeSubscriptionSnapshot,
} from "./org-plan-entitlements.service";
import { usagePackCreditGrantValues } from "./usage-pack-credit.service";

const PAID_TIERS = ["pro", "team", "custom"] as const;

interface BootstrapPublicationArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly agentId: string;
  readonly instructionsBundle: ContentBundle;
}

export const orgLimitedFreeBootstrapPublicationRow = object({
  agentId: string().nullable(),
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

function bootstrapAgentValues(args: BootstrapPublicationArgs) {
  const createdAt = nowDate();
  return {
    id: args.agentId,
    orgId: args.orgId,
    name: DEFAULT_AGENT_NAME,
    owner: args.ownerUserId,
    visibility: "public",
    displayName: DEFAULT_AGENT_DISPLAY_NAME,
    description: null,
    instructions: SEED_INSTRUCTIONS,
    instructionsBundle: args.instructionsBundle,
    sound: DEFAULT_AGENT_SOUND,
    avatarUrl: DEFAULT_AGENT_AVATAR_URL,
    createdAt,
    updatedAt: createdAt,
  };
}

function bootstrapMetadataPublication(args: BootstrapPublicationArgs): SQL {
  const at = nowDate();
  const nonPaid = notInArray(orgMetadataCanonicalWrites.tier, [...PAID_TIERS]);
  // Both existing branches bind only an unbound reference. The actual conflict
  // row decides whether the paid plan survives, including after a key wait.
  return sql`INSERT INTO ${orgMetadataCanonicalWrites}
    (org_id, default_agent_id, tier, onboarding_payment_pending, onboarding_complete, updated_at)
    SELECT ${args.orgId}, bootstrap_agent.id, 'limited-free-1', false, false,
      ${sql.param(at, orgMetadataCanonicalWrites.updatedAt)} FROM bootstrap_agent WHERE true
    ON CONFLICT (org_id) DO UPDATE SET
      default_agent_id = EXCLUDED.default_agent_id,
      tier = CASE WHEN ${nonPaid} THEN EXCLUDED.tier ELSE ${orgMetadataCanonicalWrites.tier} END,
      onboarding_payment_pending = CASE WHEN ${nonPaid}
        THEN EXCLUDED.onboarding_payment_pending ELSE ${orgMetadataCanonicalWrites.onboardingPaymentPending} END,
      updated_at = EXCLUDED.updated_at
    WHERE ${isNull(orgMetadataCanonicalWrites.defaultAgentId)}
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
  const updated = publicationFields(
    orgPlanEntitlements,
    orgPlanEntitlementUpdateValues(values),
  );
  return publicationInsert(
    orgPlanEntitlements,
    values,
    sql`FROM bootstrap_org WHERE tier = 'limited-free-1'`,
    sql`ON CONFLICT (org_id) DO UPDATE SET ${sql.join(
      updated.map((field) => {
        return sql`${field.name} = ${field.value}`;
      }),
      sql`, `,
    )}`,
    sql`org_id`,
  );
}

export function orgLimitedFreeBootstrapPublicationSql(
  args: BootstrapPublicationArgs,
): SQL {
  const query = new QueryBuilder();
  const existingDefault = query
    .select({ id: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(
      and(
        eq(orgMetadata.orgId, args.orgId),
        isNotNull(orgMetadata.defaultAgentId),
      ),
    );
  const agent = publicationInsert(
    agents,
    bootstrapAgentValues(args),
    sql`WHERE ${notExists(existingDefault)}`,
    sql`ON CONFLICT DO NOTHING`,
    sql`id`,
  );
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
  return sql`WITH bootstrap_agent AS (${agent}),
    bootstrap_org AS (${metadata}),
    bootstrap_entitlement AS (${entitlement}),
    bootstrap_receipt AS (${receipt}),
    bootstrap_grant AS (${grant})
    SELECT (SELECT id::text FROM bootstrap_agent) AS "agentId",
      (EXISTS (SELECT 1 FROM bootstrap_org WHERE tier = 'limited-free-1')
        AND NOT EXISTS (SELECT 1 FROM bootstrap_receipt)) AS "receiptAlreadyGranted",
      1 / CASE WHEN
        (SELECT count(*) FROM bootstrap_org) = (SELECT count(*) FROM bootstrap_agent)
        AND (SELECT count(*) FROM bootstrap_entitlement) =
          (SELECT count(*) FROM bootstrap_org WHERE tier = 'limited-free-1')
        AND ((SELECT count(*) FROM bootstrap_grant) = (SELECT count(*) FROM bootstrap_receipt)
          OR (EXISTS (SELECT 1 FROM bootstrap_receipt) AND NOT EXISTS (SELECT 1 FROM bootstrap_grant)
            AND ${exists(existingGrant)}))
        THEN 1 ELSE 0 END AS complete`;
}
