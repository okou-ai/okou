import { describe, expect, it } from "vitest";
import { testContext } from "../../__tests__/test-context";
import { beginTestCaseCleanup } from "../case-owner";
import {
  pgliteDatabase,
  withPgliteDatabase,
  type PgliteTestOwner,
} from "../pglite-database";
import {
  createDeferredPromise,
  settleIncludingAbort,
} from "../../signals/utils";

const context = testContext();

describe("case-owned PGlite lifecycle", () => {
  it("fails closed outside an owner", () => {
    expect(() => {
      pgliteDatabase();
    }).toThrow("outside its test owner");
  });

  it("matches node-postgres int8 and numeric text without precision loss", async () => {
    await withPgliteDatabase(async (owner) => {
      expect(
        (
          await owner.engine.query(
            "SELECT 9007199254740993::bigint AS seq_id, 12345678901234567890.123456789::numeric AS amount",
          )
        ).rows,
      ).toStrictEqual([
        {
          seq_id: "9007199254740993",
          amount: "12345678901234567890.123456789",
        },
      ]);
    });
  });

  it("keeps concurrent owners on different engines without shared rows", async () => {
    const controller = new AbortController();
    const ready = createDeferredPromise<void>(controller.signal);
    let ownersReady = 0;
    const owners: PgliteTestOwner[] = [];
    const run = async (value: number) => {
      return await withPgliteDatabase(async (owner) => {
        owners.push(owner);
        await owner.engine.exec(
          "CREATE TABLE fixture_owner (value integer NOT NULL)",
        );
        await owner.engine.query("INSERT INTO fixture_owner VALUES ($1)", [
          value,
        ]);
        ownersReady++;
        if (ownersReady === 2) {
          ready.resolve();
        }
        await ready.promise;
        return (
          await pgliteDatabase().execute("SELECT value FROM fixture_owner")
        ).rows;
      });
    };
    const operations = [run(1), run(2)];
    const result = await settleIncludingAbort(Promise.all(operations));
    controller.abort();
    await Promise.allSettled(operations);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value).toStrictEqual([[{ value: 1 }], [{ value: 2 }]]);
    expect(owners[0]?.engine).not.toBe(owners[1]?.engine);
    for (const owner of owners) {
      expect(owner.signal.aborted).toBeTruthy();
      expect(owner.engine.closed).toBeTruthy();
    }
    expect(() => {
      pgliteDatabase();
    }).toThrow("outside its test owner");
  });

  it("keeps API cleanup alive after foreground abort and cancels it before close", async () => {
    const cleanupSignal = await withPgliteDatabase(
      async (owner) => {
        expect(context.signal).toBe(owner.signal);
        beginTestCaseCleanup(new DOMException("case finished", "AbortError"));
        expect(owner.signal.aborted).toBeTruthy();
        expect(context.signal).not.toBe(owner.signal);
        expect(context.signal.aborted).toBeFalsy();
        expect(
          (await owner.engine.query("SELECT 1 AS alive")).rows,
        ).toStrictEqual([{ alive: 1 }]);
        return context.signal;
      },
      async () => {
        expect(context.signal.aborted).toBeTruthy();
      },
    );
    expect(cleanupSignal.aborted).toBeTruthy();
  });

  it("aborts and drains native work before closing after initialization failure", async () => {
    const events: string[] = [];
    let captured: PgliteTestOwner | undefined;
    let detached: Promise<void> = Promise.resolve();
    const work = withPgliteDatabase(
      async (owner) => {
        captured = owner;
        expect(context.signal).toBe(owner.signal);
        const aborted = createDeferredPromise<void>(context.signal);
        detached = aborted.promise.then(
          () => {},
          async () => {
            events.push("aborted");
            expect(owner.signal.aborted).toBeTruthy();
            expect(owner.engine.closed).toBeFalsy();
            expect(
              (await owner.engine.query("SELECT 1 AS alive")).rows,
            ).toStrictEqual([{ alive: 1 }]);
            events.push("native-drained");
          },
        );
        await owner.engine.exec("CREATE TABLE invalid_initial_sql (");
      },
      async () => {
        await detached;
        events.push("drained");
      },
    );
    await expect(work).rejects.toThrow("syntax error");
    expect(events).toStrictEqual(["aborted", "native-drained", "drained"]);
    expect(captured?.engine.closed).toBeTruthy();
  });

  it("preserves work and drainage failures after closing the engine", async () => {
    let captured: PgliteTestOwner | undefined;
    const workFailure = new Error("work failed");
    const drainFailure = new Error("drain failed");
    const result = await settleIncludingAbort(
      withPgliteDatabase(
        async (owner) => {
          captured = owner;
          throw workFailure;
        },
        async () => {
          throw drainFailure;
        },
      ),
    );
    expect(result.ok).toBeFalsy();
    if (result.ok) {
      throw new Error("Expected both failures to propagate");
    }
    expect(result.error).toBeInstanceOf(AggregateError);
    if (!(result.error instanceof AggregateError)) {
      throw result.error;
    }
    expect(result.error.errors).toStrictEqual([workFailure, drainFailure]);
    expect(captured?.signal.aborted).toBeTruthy();
    expect(captured?.engine.closed).toBeTruthy();
  });

  it("closes the engine even when drainage fails", async () => {
    let captured: PgliteTestOwner | undefined;
    const failure = new Error("drain failed");
    await expect(
      withPgliteDatabase(
        async (owner) => {
          captured = owner;
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(captured?.signal.aborted).toBeTruthy();
    expect(captured?.engine.closed).toBeTruthy();
  });
});
