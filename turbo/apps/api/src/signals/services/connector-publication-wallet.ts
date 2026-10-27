import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { getTableColumns, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { tokenPublicationFields } from "./builtin-token-connection-metadata";
import { slackRewardWalletEntitlement } from "./slack-installation-reward";

/** The original missing/denied outcome still publishes initial wallet metadata. */
export function tokenConnectionWalletClauses(orgId: string): SQL[] {
  const wallet = new PgDialect().buildInsertQuery({
    table: orgMetadataCanonicalWrites,
    values: [{ orgId: sql.param(orgId, orgMetadataCanonicalWrites.orgId) }],
    onConflict: sql`do nothing`,
    returning: [{ path: ["orgId"], field: orgMetadataCanonicalWrites.orgId }],
  });
  const entitlement = slackRewardWalletEntitlement(orgId);
  const fields = tokenPublicationFields(
    getTableColumns(orgPlanEntitlements),
    entitlement,
  );
  return [
    sql`token_wallet AS (${wallet})`,
    sql`token_wallet_entitlement AS (INSERT INTO ${orgPlanEntitlements} (${sql.join(
      fields.map(({ column }) => {
        return sql.identifier(column.name);
      }),
      sql`, `,
    )})
      SELECT ${sql.join(
        fields.map(({ value }) => {
          return value;
        }),
        sql`, `,
      )} FROM token_wallet
      ON CONFLICT (org_id) DO NOTHING RETURNING org_id)`,
  ];
}
