import { sql } from "drizzle-orm";

/**
 * R1 compatibility only: outgoing (pre-R1) builtin connector writers still
 * serialize selection changes and automation creation under this key without
 * locking account rows. New writers arbitrate with ordered account row locks
 * (builtin-connector-account-rows.ts) and take this key only inside short
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
 * Settings writers serialize model provider state. Lifecycle callers acquire
 * existing thread/session/run row locks before this lock. Settings only lock
 * provider/account/secret state after it; their run-reference checks are MVCC
 * reads, never run row locks.
 */
export function modelProviderStateLockStatement(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}) {
  // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
  return sql`SELECT pg_advisory_xact_lock(hashtext('model_provider_state:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.type}))`;
}
