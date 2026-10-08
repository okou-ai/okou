import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { stubTestTimezone } from "../../../__tests__/env-stub";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { withXResourceClock } from "../../../test-fixtures/x-resource-usage";
import {
  testXResourceReadsContract,
  testXResourceReadsRoutes,
  type TestXResourceReadsAction,
} from "../test-x-resource-reads";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";

const context = testContext();

function resourceId(): string {
  // UUID-owned decimal identifiers fit the production resource-ID contract.
  return BigInt(`0x${randomUUID().replaceAll("-", "")}`)
    .toString()
    .slice(-32);
}

async function action(body: TestXResourceReadsAction) {
  const response = await accept(
    setupApp({ context, routes: testXResourceReadsRoutes })(
      testXResourceReadsContract,
    ).action({ body }),
    [200],
  );
  return response.body;
}

async function historicalFixture(
  rows: Extract<TestXResourceReadsAction, { action: "seed" }>["rows"],
) {
  const resourceIds = [
    ...new Set(
      rows.map((row) => {
        return row.resourceId;
      }),
    ),
  ];
  const owner = createFixtureOperationOwner(async () => {
    await action({ action: "delete", resourceIds });
  });
  await owner.run(async () => {
    await action({ action: "seed", rows });
  });
  return {
    read: async () => {
      return await owner.run(async () => {
        return await action({ action: "read", resourceIds });
      });
    },
    cleanup: async (clock: () => Date) => {
      return await owner.run(async () => {
        return await withXResourceClock(clock, async () => {
          return await action({ action: "cleanup", resourceIds });
        });
      });
    },
  };
}

// Infrastructure exception: production ingestion cannot create expired rows.
// The test route names only these fixtures' IDs, never the production cron sweep.
describe("X resource read retention", () => {
  afterEach(() => {
    stubTestTimezone("UTC");
  });

  it("retains today and yesterday in UTC and never cleans another fixture", async () => {
    stubTestTimezone("Asia/Shanghai");
    const id = resourceId();
    const rows = ["2026-09-15", "2026-09-16", "2026-09-17"].map((utcDay) => {
      return {
        utcDay,
        resourceType: "post" as const,
        resourceId: id,
      };
    });
    const fixture = await historicalFixture(rows);
    const otherRows = [
      {
        utcDay: "2026-09-15",
        resourceType: "post" as const,
        resourceId: resourceId(),
      },
    ];
    const other = await historicalFixture(otherRows);

    const result = await fixture.cleanup(() => {
      return new Date("2026-09-17T23:59:59.999Z");
    });
    expect(result.deleted).toBe(1);
    expect((await fixture.read()).rows).toStrictEqual(rows.slice(1));
    expect((await other.read()).rows).toStrictEqual(otherRows);

    const nextDay = await fixture.cleanup(() => {
      return new Date("2026-09-18T00:00:00.000Z");
    });
    expect(nextDay.deleted).toBe(1);
    expect((await fixture.read()).rows).toStrictEqual(rows.slice(2));
  });

  it("matches the complete day, type and resource key without deleting retained rows", async () => {
    const id = resourceId();
    const rows = [
      { utcDay: "2026-09-15", resourceType: "post" as const, resourceId: id },
      { utcDay: "2026-09-15", resourceType: "user" as const, resourceId: id },
      { utcDay: "2026-09-16", resourceType: "post" as const, resourceId: id },
      { utcDay: "2026-09-17", resourceType: "user" as const, resourceId: id },
    ];
    const fixture = await historicalFixture(rows);
    expect(
      (
        await fixture.cleanup(() => {
          return new Date("2026-09-17T12:00:00.000Z");
        })
      ).deleted,
    ).toBe(2);
    expect((await fixture.read()).rows).toStrictEqual(rows.slice(2));
  });

  it("deletes at most 1000 rows and drains the remaining expired rows next tick", async () => {
    const id = resourceId();
    const rows = Array.from({ length: 1000 }, (_, index) => {
      const date = new Date("2020-01-01T00:00:00.000Z");
      date.setUTCDate(date.getUTCDate() + index);
      return {
        utcDay: date.toISOString().slice(0, 10),
        resourceType: "post" as const,
        resourceId: id,
      };
    });
    const fixture = await historicalFixture(rows);
    await action({
      action: "seed",
      rows: [{ utcDay: "2023-01-01", resourceType: "post", resourceId: id }],
    });
    const clock = () => {
      return new Date("2026-09-17T00:00:00.000Z");
    };

    expect((await fixture.cleanup(clock)).deleted).toBe(1000);
    expect((await fixture.read()).rows).toStrictEqual([
      { utcDay: "2023-01-01", resourceType: "post", resourceId: id },
    ]);
    expect((await fixture.cleanup(clock)).deleted).toBe(1);
    expect((await fixture.cleanup(clock)).deleted).toBe(0);
    expect((await fixture.read()).rows).toStrictEqual([]);
  });
});
