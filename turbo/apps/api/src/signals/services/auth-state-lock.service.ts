import { sql } from "drizzle-orm";

/**
 * R1 compatibility only: outgoing (pre-R1) builtin connector writers still
 * serialize selection changes and automation creation under this key without
 * locking account rows. New writers arbitrate with conditional writes and
 * existing unique constraints, and take this key only inside short
 * local transactions where such an outgoing writer could otherwise race.
 * Release 2 deletes it once no serving, in-flight or rollback writer uses it.
 */
export function builtinConnectorStateLockStatement(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
}) {
  // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
  return sql`SELECT pg_advisory_xact_lock(hashtext('connector_state:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.connectorSlug}))`;
}

/**
 * R1 compatibility only: outgoing (origin/main) model provider settings
 * writers and runtime refresh serialize on this key, and read provider state
 * without a row lock before writing secrets. New settings writers take it only
 * as the first statement of their short local transaction; their correctness
 * comes from writing the provider row first (implicit row lock), conditional
 * DELETE ... RETURNING and the unique indexes. Release 2 deletes it once no
 * serving, in-flight or rollback writer uses it.
 */
export function modelProviderStateLockStatement(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}) {
  // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
  return sql`SELECT pg_advisory_xact_lock(hashtext('model_provider_state:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.type}))`;
}
