import { sql } from "drizzle-orm";
import { connectors } from "@okouai/db/schema/connector";

/**
 * Row-level arbitration for one member's builtin connector accounts.
 *
 * Locks every existing account row of `(org, user, slug)` in id order with
 * `FOR NO KEY UPDATE`, the same order custom-account writers use. It replaces
 * the former `connector_state` advisory key for writers that change the
 * account set, its default, or state that must not outlive an account. It
 * does not block foreign-key KEY SHARE checks from selections or queue rows.
 *
 * An absent owner locks nothing: without an account row there is no account
 * state to protect, and first-account creation is arbitrated by the
 * `idx_connectors_org_user_slug_default` unique index.
 *
 * This is a pure SQL builder; execute it inside the owning command's
 * transaction before any dependent row.
 */
export function builtinConnectorAccountRowsLockSql(owner: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
}) {
  return sql`SELECT ${connectors.id} FROM ${connectors}
    WHERE ${connectors.orgId} = ${owner.orgId}
      AND ${connectors.userId} = ${owner.userId}
      AND ${connectors.connectorSlug} = ${owner.connectorSlug}
    ORDER BY ${connectors.id}
    FOR NO KEY UPDATE`;
}
