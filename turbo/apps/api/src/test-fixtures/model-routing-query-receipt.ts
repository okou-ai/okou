import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "pg";

import { closeDbPool } from "../lib/db";
import { settleIncludingAbort } from "../signals/utils";
import { barrierQueryText } from "./database-transaction-barrier";

export interface ModelRoutingQueryReceipt {
  readonly planReads: number;
  readonly policyReads: number;
  readonly featureSwitchReads: number;
  readonly personalMetadataReads: number;
  readonly personalAccountReads: number;
}

const PERSONAL_METADATA_READ =
  'select "type", "model_provider_id", "is_active", "needs_reconnect" from "model_provider_accounts"';

function countTableReads(statements: readonly string[], table: string): number {
  const source = `from "${table}"`;
  return statements.filter((statement) => {
    return statement.startsWith("select") && statement.includes(source);
  }).length;
}

/**
 * Infrastructure exception: SQL statements are not part of the public chat
 * contract. This fixture leaves the real chat route and PostgreSQL results
 * unchanged while returning only non-sensitive routing table read counts for
 * the request owned by `work`.
 */
export async function withModelRoutingQueryReceipt<T>(
  work: () => Promise<T>,
): Promise<{
  readonly result: T;
  readonly receipt: ModelRoutingQueryReceipt;
}> {
  await closeDbPool();
  const scope = new AsyncLocalStorage<true>();
  const statements: string[] = [];
  const original = Client.prototype.query;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      if (scope.getStore()) {
        statements.push(barrierQueryText(queryArgs));
      }
      return Reflect.apply(target, receiver, queryArgs);
    },
  });
  const result = await settleIncludingAbort(scope.run(true, work));
  Client.prototype.query = original;
  const closed = await settleIncludingAbort(closeDbPool());
  if (!result.ok) {
    throw result.error;
  }
  if (!closed.ok) {
    throw closed.error;
  }
  return {
    result: result.value,
    receipt: Object.freeze({
      planReads: countTableReads(statements, "org_plan_entitlements"),
      policyReads: countTableReads(statements, "org_model_policies"),
      featureSwitchReads: countTableReads(statements, "user_feature_switches"),
      personalMetadataReads: statements.filter((statement) => {
        return statement.startsWith(PERSONAL_METADATA_READ);
      }).length,
      personalAccountReads: countTableReads(
        statements,
        "model_provider_accounts",
      ),
    }),
  };
}
