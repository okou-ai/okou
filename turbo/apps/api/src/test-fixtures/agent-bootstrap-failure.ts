import { Client } from "pg";
import { z } from "zod";
import { closeDbPool } from "../lib/db";
import { settleIncludingAbort } from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
} from "./database-transaction-barrier";

/**
 * Fail only the first selected bootstrap read in the test-owned request.
 * Organization reads match the fixture identity; global key/pricing reads
 * run only while this isolated test owns the fixture's PostgreSQL client.
 * Both callers belong to vitest.config.ts's api-bootstrap-failure project,
 * which explicitly isolates workers and runs its files and cases serially.
 * No production API can request a database cancellation. PostgreSQL produces
 * the real error; later reads remain healthy, so a retry would be observable
 * as a launched run instead of the required input rejection.
 */
export async function withAgentBootstrapFailureFixture<T>(
  identity: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly read?: "managed-keys" | "org-providers" | "gateways" | "pricing";
  },
  work: () => Promise<T>,
): Promise<T> {
  await closeDbPool();
  const original = Client.prototype.query;
  let injected = false;
  let cancelled = false;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const text = barrierQueryText(queryArgs);
      const selected =
        identity.read === "managed-keys"
          ? text.includes('from "built_in_model_keys"')
          : identity.read === "pricing"
            ? text.includes('from "usage_pricing"')
            : identity.read === "org-providers"
              ? text.includes('from "model_providers"') &&
                barrierQueryBinds(queryArgs, identity.orgId) &&
                barrierQueryBinds(queryArgs, "__org__")
              : identity.read === "gateways"
                ? text.includes('from "model_provider_surfaces"') &&
                  barrierQueryBinds(queryArgs, identity.orgId)
                : text.includes('from "user_permission_grants"') &&
                  barrierQueryBinds(queryArgs, identity.userId) &&
                  barrierQueryBinds(queryArgs, identity.orgId) &&
                  barrierQueryBinds(queryArgs, identity.agentId);
      if (injected || !selected) {
        return Reflect.apply(target, receiver, queryArgs);
      }
      injected = true;
      const completion = queryArgs.at(-1);
      if (typeof completion === "function") {
        return Reflect.apply(target, receiver, [
          "SELECT pg_cancel_backend(pg_backend_pid())",
          (...callbackArgs: unknown[]) => {
            cancelled = z
              .object({ code: z.literal("57014") })
              .safeParse(callbackArgs[0]).success;
            return Reflect.apply(completion, receiver, callbackArgs);
          },
        ]);
      }
      return (async () => {
        const outcome = await settleIncludingAbort(
          Reflect.apply(target, receiver, [
            "SELECT pg_cancel_backend(pg_backend_pid())",
          ]) as Promise<unknown>,
        );
        if (!outcome.ok) {
          cancelled = z
            .object({ code: z.literal("57014") })
            .safeParse(outcome.error).success;
          throw outcome.error;
        }
        throw new Error(
          "Expected PostgreSQL to cancel the owned bootstrap read",
        );
      })();
    },
  });
  const result = await settleIncludingAbort(work());
  const closed = await settleIncludingAbort(closeDbPool());
  Client.prototype.query = original;
  if (!result.ok) {
    throw result.error;
  }
  if (!closed.ok) {
    throw closed.error;
  }
  if (!injected || !cancelled) {
    throw new Error("Owned bootstrap did not reach PostgreSQL cancellation");
  }
  return result.value;
}
