import { command, createStore } from "ccstate";
import { expect, test } from "vitest";
import { mockNow } from "../../lib/time.ts";
import { debounceCommand, throttleCommand } from "../utils.ts";
import { createTestRuntime, testContext } from "./test-helpers.ts";

const context = testContext();

// The caller supplies the source command and owns these receipts and Stores.
// No Platform or worker state is prepared or inspected.
function issueLabels(deliver: (label: string) => void) {
  return command((_ctx, text: string, copies: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    const label = text.repeat(copies);
    deliver(label);
    return label;
  });
}

test("command-scheduling-001 A superseding label receives its expanded text and cancels the first issuer", async () => {
  const issued: string[] = [];
  const print = debounceCommand(
    issueLabels((label) => {
      return issued.push(label);
    }),
    20,
  );
  const caller = createStore();
  const discarded = caller.set(print, "old", 1, context.signal);
  const current = caller.set(print, "new", 2, context.signal);
  await expect(discarded).rejects.toMatchObject({ name: "AbortError" });
  await expect(current).resolves.toBe("newnew");
  expect(issued).toStrictEqual(["newnew"]);
});

test("command-scheduling-002 Held work observes cancellation before its old result can be returned", async () => {
  const started = context.mocks.deferred<void>();
  const finish = context.mocks.deferred<void>();
  const printed: string[] = [];
  const work$ = command(async (_ctx, text: string, signal: AbortSignal) => {
    if (text === "old") {
      started.resolve();
      await finish.promise;
    }
    signal.throwIfAborted();
    printed.push(text);
    return text;
  });
  const caller = createStore();
  const scheduled = debounceCommand(work$, 20);
  const first = caller.set(scheduled, "old", context.signal);
  await started.promise;
  const replacement = caller.set(scheduled, "new", context.signal);
  finish.resolve();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  await expect(replacement).resolves.toBe("new");
  expect(printed).toStrictEqual(["new"]);
});

test("command-scheduling-003 A retired issuer cannot replace the live issuer's pending label", async () => {
  const retired = createTestRuntime(context);
  const reason = new DOMException("Label tray removed", "AbortError");
  const issued: string[] = [];
  const scheduled = debounceCommand(
    issueLabels((label) => {
      return issued.push(label);
    }),
    20,
  );
  const caller = createStore();
  const discarded = caller.set(scheduled, "discarded", 1, retired.signal);
  retired.dispose(reason);
  const latest = caller.set(scheduled, "latest", 1, context.signal);
  const invalid = caller.set(scheduled, "invalid", 1, retired.signal);
  const [withdrawn, refused, accepted] = await Promise.allSettled([
    discarded,
    invalid,
    latest,
  ]);
  expect(withdrawn).toMatchObject({
    status: "rejected",
    reason: { name: "AbortError", message: String(reason) },
  });
  await expect(invalid).rejects.toBe(reason);
  expect(refused.status).toBe("rejected");
  expect(accepted).toStrictEqual({ status: "fulfilled", value: "latest" });
  expect(issued).toStrictEqual(["latest"]);
});

test("command-scheduling-004 Both waiting issuers receive the final label when the leading job finishes", async () => {
  const started = context.mocks.deferred<void>();
  const finish = context.mocks.deferred<void>();
  const starts: string[] = [];
  const source$ = command(
    async (_ctx, label: string, copies: number, signal: AbortSignal) => {
      starts.push(label);
      if (label === "first") {
        started.resolve();
        await finish.promise;
      }
      signal.throwIfAborted();
      return label.repeat(copies);
    },
  );
  const scheduled = throttleCommand(source$, 1000);
  const caller = createStore();
  mockNow(8000, context.signal);
  const leading = caller.set(scheduled, "first", 1, context.signal);
  await started.promise;
  mockNow(8200, context.signal);
  const earlier = caller.set(scheduled, "discarded", 1, context.signal);
  mockNow(8600, context.signal);
  const later = caller.set(scheduled, "latest", 2, context.signal);
  expect(starts).toStrictEqual(["first"]);
  mockNow(9000, context.signal);
  finish.resolve();
  await expect(Promise.all([leading, earlier, later])).resolves.toStrictEqual([
    "first",
    "latestlatest",
    "latestlatest",
  ]);
  expect(starts).toStrictEqual(["first", "latest"]);
});

test("command-scheduling-006 Two independent issuers can complete the same scheduled command", async () => {
  const printed = new Set<string>();
  const shared = debounceCommand(
    issueLabels((label) => {
      return printed.add(label);
    }),
    20,
  );
  const first = createStore().set(shared, "first", 1, context.signal);
  const second = createStore().set(shared, "second", 1, context.signal);
  expect(printed.size).toBe(0);
  await expect(first).resolves.toBe("first");
  await expect(second).resolves.toBe("second");
  expect(printed).toStrictEqual(new Set(["first", "second"]));
});
