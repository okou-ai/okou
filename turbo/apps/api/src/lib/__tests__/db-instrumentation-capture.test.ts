import { trace } from "@opentelemetry/api";
import type { Pool } from "pg";
import { describe, expect, it, onTestFinished } from "vitest";

import { createDeferredPromise } from "../../signals/utils";
import {
  instrumentPgPool,
  withPgPoolAcquisitionCapture,
  type PgPoolAcquisitionCapture,
} from "../db-instrumentation";

describe("manifest pool acquisition capture", () => {
  it("keeps concurrent acquisitions on their originating captures", async () => {
    const controller = new AbortController();
    onTestFinished(() => {
      controller.abort();
    });
    let idleCount = 1;
    let totalCount = 1;
    const pending: (() => void)[] = [];
    const pool = instrumentPgPool(
      {
        options: { max: 1 },
        get idleCount() {
          return idleCount;
        },
        get totalCount() {
          return totalCount;
        },
        waitingCount: 0,
        connect(callback: () => void) {
          pending.push(callback);
        },
        query() {
          throw new Error("Unexpected database query");
        },
      } as unknown as Pool,
      trace.getTracer("db-instrumentation-capture-test"),
    );
    const first: PgPoolAcquisitionCapture = { acquisitions: [] };
    const second: PgPoolAcquisitionCapture = { acquisitions: [] };
    const acquire = (capture: PgPoolAcquisitionCapture) => {
      return withPgPoolAcquisitionCapture(capture, async () => {
        const deferred = createDeferredPromise<void>(controller.signal);
        pool.connect(() => {
          deferred.resolve();
        });
        await deferred.promise;
      });
    };

    const firstIdle = acquire(first);
    idleCount = 0;
    const secondQueued = acquire(second);
    totalCount = 0;
    const firstNew = acquire(first);

    expect(pending).toHaveLength(3);
    for (const index of [1, 2, 0]) {
      const complete = pending[index];
      if (!complete) {
        throw new Error("Expected a pending pool acquisition");
      }
      complete();
    }
    await Promise.all([firstIdle, secondQueued, firstNew]);

    expect(
      first.acquisitions.map(({ path }) => {
        return path;
      }),
    ).toStrictEqual(["new", "idle"]);
    expect(
      second.acquisitions.map(({ path }) => {
        return path;
      }),
    ).toStrictEqual(["queued"]);
    for (const acquisition of [...first.acquisitions, ...second.acquisitions]) {
      expect(Number.isFinite(acquisition.durationMs)).toBeTruthy();
      expect(acquisition.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("records a failed acquisition without changing its error", async () => {
    const controller = new AbortController();
    onTestFinished(() => {
      controller.abort();
    });
    let finish: ((error: Error) => void) | undefined;
    const pool = instrumentPgPool(
      {
        options: { max: 1 },
        idleCount: 0,
        totalCount: 1,
        waitingCount: 0,
        connect(callback: (error: Error) => void) {
          finish = callback;
        },
        query() {
          throw new Error("Unexpected database query");
        },
      } as unknown as Pool,
      trace.getTracer("db-instrumentation-capture-test"),
    );
    const capture: PgPoolAcquisitionCapture = { acquisitions: [] };
    const completion = createDeferredPromise<Error | undefined>(
      controller.signal,
    );
    const acquisition = withPgPoolAcquisitionCapture(capture, async () => {
      pool.connect((error) => {
        completion.resolve(error);
      });
      return await completion.promise;
    });
    const failure = new Error("pool acquisition failed");

    if (!finish) {
      throw new Error("Expected a pending pool acquisition");
    }
    finish(failure);

    await expect(acquisition).resolves.toBe(failure);
    expect(capture.acquisitions).toStrictEqual([
      { durationMs: expect.any(Number), path: "queued" },
    ]);
  });
});
