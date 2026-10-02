import { Client } from "pg";
import { z } from "zod";
import { closeDbPool } from "../lib/db";
import { settleIncludingAbort } from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
} from "./database-transaction-barrier";

/**
 * Fail only the first bootstrap permission read for one test-owned identity.
 * No production API can request a database cancellation. PostgreSQL produces
 * the real error; later reads remain healthy, so a retry would be observable
 * as a launched run instead of the required input rejection.
 */
export async function withAgentBootstrapFailureFixture<T>(
  identity: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
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
      if (
        injected ||
        !text.includes('from "user_permission_grants"') ||
        !barrierQueryBinds(queryArgs, identity.userId) ||
        !barrierQueryBinds(queryArgs, identity.orgId) ||
        !barrierQueryBinds(queryArgs, identity.agentId)
      ) {
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
