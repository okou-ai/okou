import { createStore } from "ccstate";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  deleteUsageStateFixture$,
  insertUsageEvent$,
  materializeHourlyUsage$,
  readUsageStorageCounts$,
  seedUsageStateFixture$,
} from "./helpers/usage-state";

const context = testContext();
const store = createStore();

describe("usage state test state", () => {
  it("clears owned raw and hourly facts without deleting another fixture", async () => {
    const owned = await store.set(
      seedUsageStateFixture$,
      undefined,
      context.signal,
    );
    const foreign = await store.set(
      seedUsageStateFixture$,
      undefined,
      context.signal,
    );
    onTestFinished(async () => {
      await store.set(deleteUsageStateFixture$, owned, context.signal);
      await store.set(deleteUsageStateFixture$, foreign, context.signal);
    });
    for (const fixture of [owned, foreign]) {
      await store.set(
        insertUsageEvent$,
        {
          ...fixture,
          runId: null,
          status: "processed",
          processedAt: new Date("2026-07-28T10:45:00.000Z"),
        },
        context.signal,
      );
      await store.set(
        materializeHourlyUsage$,
        { ...fixture, runId: null },
        context.signal,
      );
      await store.set(
        insertUsageEvent$,
        {
          ...fixture,
          runId: null,
          status: "processed",
          count: 2,
          processedAt: new Date("2026-07-28T10:45:00.000Z"),
        },
        context.signal,
      );
      await expect(
        store.set(
          readUsageStorageCounts$,
          { scope: "organization", id: fixture.orgId },
          context.signal,
        ),
      ).resolves.toStrictEqual({ raw: 2, hourly: 1 });
    }

    await store.set(deleteUsageStateFixture$, owned, context.signal);
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: owned.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 0, hourly: 0 });
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: foreign.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 2, hourly: 1 });
  });

  it("moves processed fixture usage to hourly storage", async () => {
    const fixture = await store.set(
      seedUsageStateFixture$,
      undefined,
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        runId: null,
        status: "processed",
        creditsCharged: 10,
        processedAt: new Date("2026-07-28T10:45:00.000Z"),
      },
      context.signal,
    );

    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: fixture.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 0 });
    await expect(
      store.set(
        materializeHourlyUsage$,
        { ...fixture, runId: null },
        context.signal,
      ),
    ).resolves.toBe(1);
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: fixture.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 0, hourly: 1 });

    await store.set(deleteUsageStateFixture$, fixture, context.signal);
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: fixture.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 0, hourly: 0 });
  });
});
