import { Client } from "pg";
import { z } from "zod";

import { closeDbPool } from "../lib/db";
import { settleIncludingAbort } from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
} from "./database-transaction-barrier";

/**
 * Cancel the first read of one owned queued automation's context. No API can
 * cause a PostgreSQL cancellation at this boundary. The real server produces
 * the error, and only this event's first query is affected; rejection and
 * schedule settlement use the healthy database afterwards.
 */
export async function withWorkflowQueueAssemblyFailureFixture(
  queueEventId: string,
  work: () => Promise<void>,
): Promise<void> {
  await closeDbPool();
  const original = Client.prototype.query;
  let injected = false;
  let cancelled = false;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const text = barrierQueryText(queryArgs);
      if (
        injected ||
        !text.startsWith("select ") ||
        !text.includes('from "chat_automation_context"') ||
        !barrierQueryBinds(queryArgs, queueEventId)
      ) {
        return Reflect.apply(target, receiver, queryArgs);
      }
      injected = true;
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
        throw new Error("Expected PostgreSQL to cancel the owned query");
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
    throw new Error(
      "Owned queue assembly did not reach PostgreSQL cancellation",
    );
  }
}
