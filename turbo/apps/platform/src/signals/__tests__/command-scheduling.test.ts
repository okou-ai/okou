import { command } from "ccstate";
import { expect, test } from "vitest";
import { mockNow } from "../../lib/time.ts";
import { debounceCommand, throttleCommand } from "../command-scheduling.ts";
import { createChildAbortController } from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

// Exercise the public scheduling state machine through real ccstate commands.
// Page and Worker protocol tests separately cover the production consumers.
test("Debounced commands preserve arguments and return only the latest result", async () => {
  const executions: string[] = [];
  const format$ = command(
    (_ctx, value: string, copies: number, _signal: AbortSignal) => {
      executions.push(value);
      return value.repeat(copies);
    },
  );
  const debounced$ = debounceCommand(format$, 20);

  const first = context.store.set(debounced$, "old", 1, context.signal);
  const latest: Promise<string> = context.store.set(
    debounced$,
    "new",
    2,
    context.signal,
  );

  await Promise.all([
    expect(first).rejects.toMatchObject({ name: "AbortError" }),
    expect(latest).resolves.toBe("newnew"),
  ]);
  expect(executions).toStrictEqual(["new"]);
});

test("New debounced work cancels an active command cooperatively", async () => {
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const save$ = command(async (_ctx, value: string, signal: AbortSignal) => {
    if (value === "old") {
      started.resolve();
      await release.promise;
      signal.throwIfAborted();
    }
    return value;
  });
  const debounced$ = debounceCommand(save$, 20);
  const first = context.store.set(debounced$, "old", context.signal);
  await started.promise;

  const latest = context.store.set(debounced$, "new", context.signal);
  release.resolve();

  await Promise.all([
    expect(first).rejects.toMatchObject({ name: "AbortError" }),
    expect(latest).resolves.toBe("new"),
  ]);
});

test("A cancelled debounce can be reused without running the discarded command", async () => {
  const executions: string[] = [];
  const read$ = command((_ctx, value: string, _signal: AbortSignal) => {
    executions.push(value);
    return value;
  });
  const debounced$ = debounceCommand(read$, 20);
  // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
  const caller = createChildAbortController(context.signal);
  const reason = new DOMException("Search closed", "AbortError");
  const pending = context.store.set(debounced$, "discarded", caller.signal);
  caller.abort(reason);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });

  // A pre-aborted invocation must not cancel another caller's valid work.
  const latest = context.store.set(debounced$, "latest", context.signal);
  await expect(
    context.store.set(debounced$, "invalid", caller.signal),
  ).rejects.toBe(reason);
  await expect(latest).resolves.toBe("latest");
  expect(executions).toStrictEqual(["latest"]);
});

test("Throttled commands serialize a leading call and share the latest trailing result", async () => {
  mockNow(10_000, context.signal);
  const release = context.mocks.deferred<void>();
  const executions: string[] = [];
  const format$ = command(
    async (_ctx, value: string, copies: number, signal: AbortSignal) => {
      executions.push(value);
      if (value === "first") {
        await release.promise;
        signal.throwIfAborted();
      }
      return value.repeat(copies);
    },
  );
  const throttled$ = throttleCommand(format$, 1000);
  const first = context.store.set(throttled$, "first", 1, context.signal);
  expect(executions).toStrictEqual(["first"]);

  mockNow(10_200, context.signal);
  const second = context.store.set(throttled$, "discarded", 1, context.signal);
  mockNow(10_600, context.signal);
  const latest = context.store.set(throttled$, "latest", 2, context.signal);
  expect(executions).toStrictEqual(["first"]);

  mockNow(11_000, context.signal);
  release.resolve();
  await expect(Promise.all([first, second, latest])).resolves.toStrictEqual([
    "first",
    "latestlatest",
    "latestlatest",
  ]);
  expect(executions).toStrictEqual(["first", "latest"]);
});

test("A failed trailing command rejects every caller and allows another execution", async () => {
  mockNow(20_000, context.signal);
  const failure = new Error("Request failed");
  const read$ = command((_ctx, value: string, _signal: AbortSignal) => {
    if (value === "fail") {
      throw failure;
    }
    return value;
  });
  const throttled$ = throttleCommand(read$, 20);
  await expect(
    context.store.set(throttled$, "first", context.signal),
  ).resolves.toBe("first");

  mockNow(20_019, context.signal);
  const first = context.store.set(throttled$, "fail", context.signal);
  const second = context.store.set(throttled$, "fail", context.signal);
  await Promise.all([
    expect(first).rejects.toBe(failure),
    expect(second).rejects.toBe(failure),
  ]);

  mockNow(20_040, context.signal);
  await expect(
    context.store.set(throttled$, "recovered", context.signal),
  ).resolves.toBe("recovered");
});

test.each([
  { name: "debounce", schedule: debounceCommand, immediate: [] },
  {
    name: "throttle",
    schedule: throttleCommand,
    immediate: ["first", "second"],
  },
])(
  "$name scheduling is isolated between Stores",
  async ({ schedule, immediate }) => {
    const executions: string[] = [];
    const read$ = command((_ctx, value: string, _signal: AbortSignal) => {
      executions.push(value);
      return value;
    });
    const scheduled$ = schedule(read$, 20);
    const first = context.store.set(scheduled$, "first", context.signal);
    const second = context.workerStore.set(
      scheduled$,
      "second",
      context.signal,
    );

    expect(executions).toStrictEqual(immediate);
    await expect(Promise.all([first, second])).resolves.toStrictEqual([
      "first",
      "second",
    ]);
    expect(executions).toStrictEqual(["first", "second"]);
  },
);
