import { Client } from "pg";
import { z } from "zod";
import { closeDbPool } from "../lib/db";
import { settleIncludingAbort } from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
} from "./database-transaction-barrier";

/** A real server failure after message writes, before or at the watermark.
 * The API cannot deliberately stall a backend. A test-owned watermark row lock
 * makes the real upsert wait; only this transaction gets a short statement
 * deadline. PostgreSQL and Drizzle produce the failure and rollback without
 * fabricated errors.
 */
export async function withChatSearchStatementFailureFixture<T>(
  chatThreadId: string,
  failure: "timeout" | "cancel",
  work: () => Promise<T>,
): Promise<T> {
  await closeDbPool();
  const original = Client.prototype.query;
  let injected = false;
  let serverStatementTimeout = false;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const text = barrierQueryText(queryArgs);
      if (
        injected ||
        !text.startsWith(
          'insert into "chat_event_search_message_watermarks"',
        ) ||
        !barrierQueryBinds(queryArgs, chatThreadId)
      ) {
        return Reflect.apply(target, receiver, queryArgs);
      }
      injected = true;
      return (async () => {
        if (failure === "timeout") {
          // This transaction already has the production 1s lock timeout and
          // 5s statement timeout. Shorten only its statement deadline, just
          // before the real watermark write waits on the test-owned row.
          await Reflect.apply(target, receiver, [
            "SET LOCAL statement_timeout = '300ms'",
          ]);
        } else {
          await Reflect.apply(target, receiver, [
            "SELECT pg_cancel_backend(pg_backend_pid())",
          ]);
        }
        const outcome = await settleIncludingAbort(
          Reflect.apply(target, receiver, queryArgs) as Promise<unknown>,
        );
        if (!outcome.ok) {
          if (failure === "timeout") {
            serverStatementTimeout = z
              .object({
                code: z.literal("57014"),
                message: z.literal(
                  "canceling statement due to statement timeout",
                ),
              })
              .safeParse(outcome.error).success;
          }
          throw outcome.error;
        }
        return outcome.value;
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
  if (!injected) {
    throw new Error("Owned projection did not reach the failure fixture");
  }
  if (failure === "timeout" && !serverStatementTimeout) {
    throw new Error("Owned watermark write did not hit statement_timeout");
  }
  return result.value;
}
