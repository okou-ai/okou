import { Client } from "pg";
import { z } from "zod";
import { closeDbPool } from "../lib/db";
import { flushWaitUntilForTest } from "../signals/context/wait-until";
import { settleIncludingAbort } from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
} from "./database-transaction-barrier";

/**
 * Fail only the first selected bootstrap read in the test-owned request.
 * Permission reads match the fixture identity; global key/pricing reads
 * run only while this isolated test owns the fixture's PostgreSQL client.
 * Vitest isolates files in separate worker contexts; cases within a file
 * run sequentially, so this temporary client override stays case-owned.
 * No production API can request a database cancellation. PostgreSQL produces
 * the real error; later reads remain healthy, so a retry would be observable
 * as a launched run instead of the required HTTP failure or input rejection.
 */
export async function withAgentBootstrapFailureFixture<T>(
  identity: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly read?: "keys" | "pricing";
  },
  work: () => Promise<T>,
): Promise<T> {
  // Setup can also own request background work; finish it before replacing
  // the pool and taking ownership of the cancellation interceptor.
  await flushWaitUntilForTest();
  await closeDbPool();
  const original = Client.prototype.query;
  let injected = false;
  let cancelled = false;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const text = barrierQueryText(queryArgs);
      const selected =
        identity.read === "keys"
          ? text.includes('from "built_in_model_keys"')
          : identity.read === "pricing"
            ? text.includes('from "usage_pricing"')
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
  // A failed HTTP request can return before independent preload reads finish.
  // pg-pool.end() stops servicing queued acquisitions without rejecting them;
  // ending it now would orphan their query/settled waitUntil promises forever.
  // Drain the request-owned work while the healthy pool and interceptor still
  // exist, even if the scenario assertion failed. Preserve every rejection.
  const drained = await settleIncludingAbort(flushWaitUntilForTest());
  const closed = await settleIncludingAbort(closeDbPool());
  Client.prototype.query = original;
  if (!result.ok) {
    throw result.error;
  }
  if (!drained.ok) {
    throw drained.error;
  }
  if (!closed.ok) {
    throw closed.error;
  }
  if (!injected || !cancelled) {
    throw new Error("Owned bootstrap did not reach PostgreSQL cancellation");
  }
  return result.value;
}
