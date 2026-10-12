import {
  and,
  eq,
  exists,
  getTableColumns,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { bankingConnections, bankingConnectSessions } from "../schema/banking";

/** Sessionless SQL preparation; the command retains the database executor. */
export function prepareBankingConnectSessionReplacement(args: {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly mode: "connect" | "fix";
  readonly institutionLoginId: string | null;
  readonly updatedAt: Date;
}) {
  const qb = new QueryBuilder();
  const lockedConnection = qb.$with("locked_banking_connection").as(
    qb
      .select({ id: bankingConnections.id })
      .from(bankingConnections)
      .where(
        and(
          eq(bankingConnections.id, args.connectionId),
          eq(bankingConnections.orgId, args.orgId),
          eq(bankingConnections.userId, args.userId),
          eq(bankingConnections.provider, "finicity"),
          isNull(bankingConnections.revokedAt),
          isNull(bankingConnections.deletedAt),
          or(
            eq(bankingConnections.status, "active"),
            eq(bankingConnections.status, "repair_required"),
          ),
        ),
      )
      .for("no key update"),
  );
  const candidate = sql`SELECT
    ${sql.param(args.id, bankingConnectSessions.id)},
    ${sql.param(args.orgId, bankingConnectSessions.orgId)},
    ${sql.param(args.userId, bankingConnectSessions.userId)},
    ${lockedConnection.id},
    ${sql.param(args.mode, bankingConnectSessions.mode)},
    ${sql.param(args.institutionLoginId, bankingConnectSessions.institutionLoginId)}
    FROM ${lockedConnection}`;
  const columns = getTableColumns(bankingConnectSessions);
  // The partial unique arbiter sees a pending row committed during the parent
  // lock wait even though that row is absent from this statement's snapshot.
  const replaced = qb.$with("replaced_banking_session", columns).as(sql`
    INSERT INTO ${bankingConnectSessions}
      (id, org_id, user_id, connection_id, mode, institution_login_id)
    ${candidate}
    ON CONFLICT (connection_id) WHERE status = 'pending'
    DO UPDATE SET status = 'superseded',
      updated_at = ${sql.param(args.updatedAt, bankingConnectSessions.updatedAt)}
    WHERE ${eq(bankingConnectSessions.orgId, args.orgId)}
      AND ${eq(bankingConnectSessions.userId, args.userId)}
    RETURNING *
  `);
  const superseded = qb
    .select({ id: replaced.id })
    .from(replaced)
    .where(eq(replaced.status, "superseded"));
  const returned = qb.select({ id: replaced.id }).from(replaced);
  const inserted = qb.$with("inserted_banking_session", columns).as(sql`
    INSERT INTO ${bankingConnectSessions}
      (id, org_id, user_id, connection_id, mode, institution_login_id)
    ${candidate}
    WHERE (${exists(superseded)} OR ${notExists(returned)})
    RETURNING *
  `);
  // No returned upsert row with a nonempty root means a foreign-owner conflict.
  // The ordinary dependent INSERT preserves its 23505 and statement rollback.
  const pending = qb
    .$with("pending_banking_session")
    .as(
      qb
        .select()
        .from(replaced)
        .where(eq(replaced.status, "pending"))
        .unionAll(qb.select().from(inserted)),
    );
  return {
    ctes: [lockedConnection, replaced, inserted, pending],
    lockedConnection,
    pending,
    selection: {
      connectionId: lockedConnection.id,
      session: {
        id: pending.id,
        orgId: pending.orgId,
        userId: pending.userId,
        connectionId: pending.connectionId,
        mode: pending.mode,
        status: pending.status,
        institutionLoginId: pending.institutionLoginId,
        addedAt: pending.addedAt,
        doneAt: pending.doneAt,
        completedAt: pending.completedAt,
        endReason: pending.endReason,
        createdAt: pending.createdAt,
        updatedAt: pending.updatedAt,
      },
    },
  };
}
