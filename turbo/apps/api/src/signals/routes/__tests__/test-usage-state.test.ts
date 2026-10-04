import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  readConnectorCredentialStorageState,
  seedOwnedConnectorSecret,
} from "./helpers/connector-credential-storage-state";
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
  it("cascades connector credentials when deleting fixture connectors", async () => {
    const fixture = await store.set(
      seedUsageStateFixture$,
      undefined,
      context.signal,
    );
    await seedOwnedConnectorSecret(context, {
      ...fixture,
      connectorSlug: "fixture-connector",
      authMethod: "api-token",
      storageVersion: 1,
      name: "FIXTURE_CONNECTOR_TOKEN",
      encryptedValue: "fixture-value",
      description: null,
    });

    await store.set(deleteUsageStateFixture$, fixture, context.signal);

    const storageState = await readConnectorCredentialStorageState(context, {
      ...fixture,
      connectorSlug: "fixture-connector",
      secretNames: ["FIXTURE_CONNECTOR_TOKEN"],
    });
    expect(storageState).toMatchObject({
      connector: null,
      secrets: [],
      variables: [],
    });
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
