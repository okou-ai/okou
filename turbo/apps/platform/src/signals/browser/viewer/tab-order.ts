import { browserTabOrderSchema } from "@okouai/api-contracts/validators/browser-tab-order";
import { command } from "ccstate";
import { localStorageSignals } from "../../external/local-storage.ts";
import type { BrowserConnection } from "../browser.ts";
import type { ViewerInventory } from "./types.ts";
import { jsonParseOr, throwIfAbort } from "../../utils.ts";

/** Retain unsent local order across navigation; only scoped membership admits IDs. */
export function createTabOrder(connection: BrowserConnection) {
  const storage = localStorageSignals(
    `browser-tab-order:${connection.threadId}`,
  );
  // Remove the missing-binding rollout path after pre-order APIs are neither
  // serving nor retained for rollback; tracked with the rollout in #45844.
  const binding = connection.tabOrder;
  const read$ = command(
    async ({ set }, signal: AbortSignal): Promise<readonly string[]> => {
      signal.throwIfAborted();
      const saved = binding?.targetIds ?? [];
      if (!binding) {
        return saved;
      }
      const [read] = await Promise.allSettled([
        (async () => {
          return await Promise.resolve(set(storage.readFresh$));
        })(),
      ]);
      signal.throwIfAborted();
      if (read.status === "fulfilled") {
        const raw = read.value;
        const cached = browserTabOrderSchema.safeParse(
          raw === null ? null : jsonParseOr(raw, null),
        );
        if (
          cached.success &&
          cached.data.instanceId === binding.instanceId &&
          cached.data.windowId === binding.windowId
        ) {
          return [...new Set([...saved, ...cached.data.targetIds])];
        }
      } else {
        throwIfAbort(read.reason);
      }
      return saved;
    },
  );
  const save$ = command(
    async ({ set }, inventory: ViewerInventory, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (inventory.status !== "complete") {
        return;
      }
      const targetIds = inventory.targets.map((target) => {
        return target.id;
      });
      if (!binding) {
        return;
      }
      const [saved] = await Promise.allSettled([
        (async () => {
          const value = JSON.stringify({ ...binding, targetIds });
          if (set(storage.readFresh$) !== value) {
            await Promise.resolve(set(storage.set$, value));
          }
        })(),
      ]);
      signal.throwIfAborted();
      if (saved.status === "rejected") {
        throwIfAbort(saved.reason);
      }
    },
  );
  return { read$, save$ };
}
