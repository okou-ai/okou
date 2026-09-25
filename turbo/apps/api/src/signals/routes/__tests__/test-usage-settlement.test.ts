import { randomUUID } from "node:crypto";

import { testUsageSettlementContract } from "@okouai/api-contracts/contracts/test-usage-settlement";
import { createStore } from "ccstate";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import {
  createUsagePricingFixture,
  deleteUsagePricingRows,
  seedUsagePricingRows,
  type UsagePricingFixture,
  type UsagePricingKey,
} from "../../../test-fixtures/system-config-seeds";
import { testUsageSettlementRoutes } from "../test-usage-settlement";
import {
  attachUsageAllowance$,
  deleteUsageData$,
  deleteUsageStateFixture$,
  insertUsageEvent$,
  readUsageEventState$,
  seedUsageStateFixture$,
  type UsageStateFixture,
} from "./helpers/usage-state";

const context = testContext({ connectorCatalog: true });
const store = createStore();

function client(usagePricingResolution?: UsagePricingFixture["resolution"]) {
  return setupApp({
    context,
    routes: testUsageSettlementRoutes,
    usagePricingResolution,
  })(testUsageSettlementContract);
}

async function setupSettlementFixture(
  credits: number,
): Promise<UsageStateFixture> {
  mockEnv("ENV", "development");
  const fixture = await store.set(
    seedUsageStateFixture$,
    undefined,
    context.signal,
  );
  await accept(
    client().setup({
      body: { org_id: fixture.orgId, credits },
    }),
    [200],
  );
  onTestFinished(async () => {
    await accept(client().cleanup({ body: { org_id: fixture.orgId } }), [200]);
    await store.set(
      deleteUsageData$,
      { scope: "organization", id: fixture.orgId },
      context.signal,
    );
    await store.set(deleteUsageStateFixture$, fixture, context.signal);
  });
  return fixture;
}

async function seedSettlementPricing(): Promise<string> {
  const provider = `settlement-${randomUUID()}`;
  await seedUsagePricingRows([
    {
      kind: "model",
      provider,
      category: "tokens.input",
      unitPrice: 1,
      unitSize: 1,
    },
  ]);
  onTestFinished(async () => {
    await deleteUsagePricingRows({
      kind: "model",
      provider,
      categories: ["tokens.input"],
    });
  });
  return provider;
}

async function createGrant(args: {
  readonly fixture: UsageStateFixture;
  readonly userId?: string;
  readonly grantType: "purchased" | "bonus";
  readonly idempotencyKey: string;
  readonly amount: number;
  readonly expiresAt: string;
}) {
  return await accept(
    client().createGrant({
      body: {
        org_id: args.fixture.orgId,
        user_id: args.userId ?? args.fixture.userId,
        grant_type: args.grantType,
        idempotency_key: args.idempotencyKey,
        amount: args.amount,
        expires_at: args.expiresAt,
      },
    }),
    [200],
  );
}

async function insertModelCharge(args: {
  readonly fixture: UsageStateFixture;
  readonly provider: string;
  readonly category: UsagePricingKey["category"];
  readonly amount: number;
  readonly userId?: string;
  readonly idempotencyKey?: string;
}): Promise<string> {
  const idempotencyKey = args.idempotencyKey ?? randomUUID();
  await store.set(
    insertUsageEvent$,
    {
      ...args.fixture,
      userId: args.userId ?? args.fixture.userId,
      kind: "model",
      provider: args.provider,
      category: args.category,
      quantity: args.amount,
      idempotencyKey,
    },
    context.signal,
  );
  return idempotencyKey;
}

async function insertCharge(args: {
  readonly fixture: UsageStateFixture;
  readonly provider: string;
  readonly amount: number;
  readonly userId?: string;
  readonly idempotencyKey?: string;
}): Promise<string> {
  return await insertModelCharge({ ...args, category: "tokens.input" });
}

async function processSettlement(
  orgId: string,
  usagePricingResolution?: UsagePricingFixture["resolution"],
): Promise<void> {
  await accept(
    client(usagePricingResolution).process({ body: { org_id: orgId } }),
    [200],
  );
}

async function readSettlementState(orgId: string) {
  return await accept(client().state({ body: { org_id: orgId } }), [200]);
}

describe("POST /api/test/usage-settlement/process", () => {
  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");

    const response = await accept(
      client().process({ body: { org_id: "org_test" } }),
      [404],
    );

    expect(response.body).toBe("Not found");
    const rollback = await accept(
      client().rollback({ body: { org_id: "org_test" } }),
      [404],
    );
    expect(rollback.body).toBe("Not found");
  });

  it("prices every usage event from server-side pricing", async () => {
    const fixture = await setupSettlementFixture(10_000);
    const modelIdempotencyKey = randomUUID();
    const browserIdempotencyKey = randomUUID();
    const connectorIdempotencyKey = randomUUID();
    const modelProvider = `settlement-model-${randomUUID()}`;
    const connectorProvider = `settlement-test-${randomUUID()}`;
    const browserProvider = `settlement-browser-${randomUUID()}`;

    await seedUsagePricingRows([
      {
        kind: "model",
        provider: modelProvider,
        category: "tokens.input",
        unitPrice: 19,
        unitSize: 100,
      },
      {
        kind: "connector",
        provider: connectorProvider,
        category: "request",
        unitPrice: 5,
        unitSize: 1,
      },
    ]);
    onTestFinished(async () => {
      await deleteUsagePricingRows({
        kind: "model",
        provider: modelProvider,
        categories: ["tokens.input"],
      });
      await deleteUsagePricingRows({
        kind: "connector",
        provider: connectorProvider,
        categories: ["request"],
      });
    });

    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        kind: "model",
        provider: modelProvider,
        category: "tokens.input",
        quantity: 100,
        idempotencyKey: modelIdempotencyKey,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        kind: "connector",
        provider: connectorProvider,
        category: "request",
        quantity: 2,
        idempotencyKey: connectorIdempotencyKey,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        kind: "browser",
        provider: browserProvider,
        category: "provider_cost_usd_micros",
        quantity: 100,
        idempotencyKey: browserIdempotencyKey,
      },
      context.signal,
    );

    await processSettlement(fixture.orgId);

    await expect(
      store.set(readUsageEventState$, modelIdempotencyKey, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 19,
      billingError: null,
    });
    await expect(
      store.set(readUsageEventState$, browserIdempotencyKey, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 0,
      billingError: "missing_pricing",
    });
    await expect(
      store.set(readUsageEventState$, connectorIdempotencyKey, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 10,
      billingError: null,
    });
  });

  it("prices every fixed model token category without leaking fixture scopes", async () => {
    const modelProvider = "deepseek-v4-flash";
    const inputPricingKey: UsagePricingKey = {
      kind: "model",
      provider: modelProvider,
      category: "tokens.input",
    };
    const [configuredPricing, customPricing, missingPricing] =
      await Promise.all([
        createUsagePricingFixture({
          configured: [
            { ...inputPricingKey, unitPrice: 2, unitSize: 1 },
            {
              kind: "model",
              provider: modelProvider,
              category: "tokens.output",
              unitPrice: 3,
              unitSize: 1,
            },
            {
              kind: "model",
              provider: modelProvider,
              category: "tokens.cache_read",
              unitPrice: 5,
              unitSize: 1,
            },
            {
              kind: "model",
              provider: modelProvider,
              category: "tokens.cache_creation",
              unitPrice: 7,
              unitSize: 1,
            },
          ],
        }),
        createUsagePricingFixture({
          configured: [{ ...inputPricingKey, unitPrice: 13, unitSize: 1 }],
        }),
        createUsagePricingFixture({ missing: [inputPricingKey] }),
      ]);
    onTestFinished(async () => {
      await Promise.all([
        configuredPricing.cleanup(),
        customPricing.cleanup(),
        missingPricing.cleanup(),
      ]);
    });

    const [configuredState, customState, missingState] = await Promise.all([
      setupSettlementFixture(10_000),
      setupSettlementFixture(10_000),
      setupSettlementFixture(10_000),
    ]);
    const [
      inputEvent,
      outputEvent,
      cacheReadEvent,
      cacheCreationEvent,
      customEvent,
      missingEvent,
    ] = await Promise.all([
      insertModelCharge({
        fixture: configuredState,
        provider: modelProvider,
        category: "tokens.input",
        amount: 11,
      }),
      insertModelCharge({
        fixture: configuredState,
        provider: modelProvider,
        category: "tokens.output",
        amount: 7,
      }),
      insertModelCharge({
        fixture: configuredState,
        provider: modelProvider,
        category: "tokens.cache_read",
        amount: 5,
      }),
      insertModelCharge({
        fixture: configuredState,
        provider: modelProvider,
        category: "tokens.cache_creation",
        amount: 4,
      }),
      insertModelCharge({
        fixture: customState,
        provider: modelProvider,
        category: "tokens.input",
        amount: 11,
      }),
      insertModelCharge({
        fixture: missingState,
        provider: modelProvider,
        category: "tokens.input",
        amount: 11,
      }),
    ]);

    await Promise.all([
      processSettlement(configuredState.orgId, configuredPricing.resolution),
      processSettlement(customState.orgId, customPricing.resolution),
      processSettlement(missingState.orgId, missingPricing.resolution),
    ]);

    await expect(
      store.set(readUsageEventState$, inputEvent, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 22,
      billingError: null,
    });
    await expect(
      store.set(readUsageEventState$, outputEvent, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 21,
      billingError: null,
    });
    await expect(
      store.set(readUsageEventState$, cacheReadEvent, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 25,
      billingError: null,
    });
    await expect(
      store.set(readUsageEventState$, cacheCreationEvent, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 28,
      billingError: null,
    });
    await expect(
      store.set(readUsageEventState$, customEvent, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 143,
      billingError: null,
    });
    await expect(
      store.set(readUsageEventState$, missingEvent, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 0,
      billingError: "missing_pricing",
    });
  });

  it("persists grants idempotently without changing organization credits", async () => {
    const fixture = await setupSettlementFixture(7);
    const idempotencyKey = `invoice-line-${randomUUID()}`;
    const expiresAt = "2099-01-01T00:00:00.000Z";

    const first = await createGrant({
      fixture,
      grantType: "purchased",
      idempotencyKey,
      amount: 25,
      expiresAt,
    });
    const retry = await createGrant({
      fixture,
      grantType: "purchased",
      idempotencyKey,
      amount: 25,
      expiresAt,
    });
    const state = await readSettlementState(fixture.orgId);

    expect(first.body.created).toBeTruthy();
    expect(retry.body).toStrictEqual({
      grant_id: first.body.grant_id,
      created: false,
    });
    expect(state.body).toStrictEqual({
      org_credits: 7,
      grants: [
        {
          id: first.body.grant_id,
          user_id: fixture.userId,
          grant_type: "purchased",
          idempotency_key: idempotencyKey,
          original_amount: 25,
          remaining_amount: 25,
          expires_at: expiresAt,
        },
      ],
    });
  });

  it("consumes purchased grants by FEFO before bonus and shared credits", async () => {
    const fixture = await setupSettlementFixture(100);
    const provider = await seedSettlementPricing();
    const earlyBonusKey = `bonus-early-${randomUUID()}`;
    const lateBonusKey = `bonus-late-${randomUUID()}`;
    const earlyPurchasedKey = `purchased-early-${randomUUID()}`;
    const latePurchasedKey = `purchased-late-${randomUUID()}`;
    await createGrant({
      fixture,
      grantType: "bonus",
      idempotencyKey: earlyBonusKey,
      amount: 5,
      expiresAt: "2028-01-01T00:00:00.000Z",
    });
    await createGrant({
      fixture,
      grantType: "bonus",
      idempotencyKey: lateBonusKey,
      amount: 6,
      expiresAt: "2031-01-01T00:00:00.000Z",
    });
    await createGrant({
      fixture,
      grantType: "purchased",
      idempotencyKey: latePurchasedKey,
      amount: 4,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await createGrant({
      fixture,
      grantType: "purchased",
      idempotencyKey: earlyPurchasedKey,
      amount: 3,
      expiresAt: "2029-01-01T00:00:00.000Z",
    });

    await insertCharge({ fixture, provider, amount: 5 });
    await processSettlement(fixture.orgId);
    const afterPurchasedFefo = await readSettlementState(fixture.orgId);
    expect(
      Object.fromEntries(
        afterPurchasedFefo.body.grants.map((grant) => {
          return [grant.idempotency_key, grant.remaining_amount];
        }),
      ),
    ).toStrictEqual({
      [earlyBonusKey]: 5,
      [lateBonusKey]: 6,
      [earlyPurchasedKey]: 0,
      [latePurchasedKey]: 2,
    });
    expect(afterPurchasedFefo.body.org_credits).toBe(100);

    await insertCharge({ fixture, provider, amount: 5 });
    await processSettlement(fixture.orgId);
    const afterSourcePriority = await readSettlementState(fixture.orgId);
    expect(
      Object.fromEntries(
        afterSourcePriority.body.grants.map((grant) => {
          return [grant.idempotency_key, grant.remaining_amount];
        }),
      ),
    ).toStrictEqual({
      [earlyBonusKey]: 2,
      [lateBonusKey]: 6,
      [earlyPurchasedKey]: 0,
      [latePurchasedKey]: 0,
    });
    expect(afterSourcePriority.body.org_credits).toBe(100);

    await insertCharge({ fixture, provider, amount: 10 });
    await processSettlement(fixture.orgId);
    const afterBonusFefo = await readSettlementState(fixture.orgId);
    expect(
      Object.fromEntries(
        afterBonusFefo.body.grants.map((grant) => {
          return [grant.idempotency_key, grant.remaining_amount];
        }),
      ),
    ).toStrictEqual({
      [earlyBonusKey]: 0,
      [lateBonusKey]: 0,
      [earlyPurchasedKey]: 0,
      [latePurchasedKey]: 0,
    });
    expect(afterBonusFefo.body.org_credits).toBe(98);
  });

  it("isolates member grants and excludes expired grants", async () => {
    const fixture = await setupSettlementFixture(100);
    const provider = await seedSettlementPricing();
    const otherUserId = `user_${randomUUID()}`;
    const activeKey = `active-${randomUUID()}`;
    const expiredKey = `expired-${randomUUID()}`;
    await createGrant({
      fixture,
      grantType: "purchased",
      idempotencyKey: activeKey,
      amount: 10,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await createGrant({
      fixture,
      grantType: "bonus",
      idempotencyKey: expiredKey,
      amount: 20,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    await insertCharge({ fixture, provider, amount: 6 });
    await insertCharge({
      fixture,
      provider,
      amount: 4,
      userId: otherUserId,
    });

    await processSettlement(fixture.orgId);
    const state = await readSettlementState(fixture.orgId);
    const remainingByKey = Object.fromEntries(
      state.body.grants.map((grant) => {
        return [grant.idempotency_key, grant.remaining_amount];
      }),
    );

    expect(remainingByKey).toStrictEqual({
      [activeKey]: 4,
      [expiredKey]: 20,
    });
    expect(state.body.org_credits).toBe(96);
  });

  it("applies usage allowance before member credits", async () => {
    const fixture = await setupSettlementFixture(0);
    const provider = await seedSettlementPricing();
    await createGrant({
      fixture,
      grantType: "purchased",
      idempotencyKey: `allowance-${randomUUID()}`,
      amount: 10,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const usageEventId = await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        kind: "model",
        provider,
        category: "tokens.input",
        quantity: 8,
      },
      context.signal,
    );
    await store.set(
      attachUsageAllowance$,
      {
        orgId: fixture.orgId,
        runId: null,
        usageEventId,
        unitsApplied: 3,
        consumedUnits: 3,
      },
      context.signal,
    );

    await processSettlement(fixture.orgId);
    const state = await readSettlementState(fixture.orgId);

    expect(state.body.org_credits).toBe(0);
    expect(state.body.grants[0]?.remaining_amount).toBe(5);
  });

  it("admits only the member owning spendable credits", async () => {
    const fixture = await setupSettlementFixture(0);
    const otherUserId = `user_${randomUUID()}`;
    await createGrant({
      fixture,
      grantType: "bonus",
      idempotencyKey: `admission-${randomUUID()}`,
      amount: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    for (const kind of ["run", "managed-media"] as const) {
      const owner = await accept(
        client().admission({
          body: {
            org_id: fixture.orgId,
            user_id: fixture.userId,
            kind,
          },
        }),
        [200],
      );
      const otherMember = await accept(
        client().admission({
          body: {
            org_id: fixture.orgId,
            user_id: otherUserId,
            kind,
          },
        }),
        [200],
      );

      expect(owner.body.allowed).toBeTruthy();
      expect(otherMember.body.allowed).toBeFalsy();
    }
  });

  it("settles concurrent retries exactly once", async () => {
    const fixture = await setupSettlementFixture(30);
    const provider = await seedSettlementPricing();
    const eventKey = randomUUID();
    await createGrant({
      fixture,
      grantType: "purchased",
      idempotencyKey: `concurrent-${randomUUID()}`,
      amount: 10,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await insertCharge({
      fixture,
      provider,
      amount: 10,
      idempotencyKey: eventKey,
    });

    await Promise.all([
      processSettlement(fixture.orgId),
      processSettlement(fixture.orgId),
    ]);
    const state = await readSettlementState(fixture.orgId);

    expect(state.body.org_credits).toBe(30);
    expect(state.body.grants[0]?.remaining_amount).toBe(0);
    await expect(
      store.set(readUsageEventState$, eventKey, context.signal),
    ).resolves.toMatchObject({ status: "processed", creditsCharged: 10 });
  });

  it("rolls back a precommit failure and settles the pending obligation on retry", async () => {
    const fixture = await setupSettlementFixture(20);
    const provider = await seedSettlementPricing();
    const grantKey = `rollback-${randomUUID()}`;
    await createGrant({
      fixture,
      grantType: "purchased",
      idempotencyKey: grantKey,
      amount: 5,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const eventKey = await insertCharge({
      fixture,
      provider,
      amount: 8,
    });

    // No production caller can intentionally fail after the wallet writes but
    // before COMMIT; the guarded test endpoint injects that fault through the
    // real transaction, rather than mocking the ledger or reading DB rows.
    const aborted = await accept(
      client().rollback({ body: { org_id: fixture.orgId } }),
      [200],
    );
    expect(aborted.body).toStrictEqual({ rolled_back: true });
    await expect(
      store.set(readUsageEventState$, eventKey, context.signal),
    ).resolves.toMatchObject({
      status: "pending",
      creditsCharged: null,
    });
    const afterAbort = await readSettlementState(fixture.orgId);
    expect(afterAbort.body.org_credits).toBe(20);
    expect(afterAbort.body.grants[0]?.remaining_amount).toBe(5);

    await processSettlement(fixture.orgId);
    await expect(
      store.set(readUsageEventState$, eventKey, context.signal),
    ).resolves.toMatchObject({ status: "processed", creditsCharged: 8 });
    const afterRetry = await readSettlementState(fixture.orgId);
    expect(afterRetry.body.org_credits).toBe(17);
    expect(afterRetry.body.grants[0]?.remaining_amount).toBe(0);
  });

  it("uses live unsnapshotted pricing and grant expiry on delayed first settlement", async () => {
    onTestFinished(clearMockNow);
    const before = nowDate();
    mockNow(before);
    const fixture = await setupSettlementFixture(100);
    const provider = `settlement-late-${randomUUID()}`;
    await seedUsagePricingRows([
      {
        kind: "model",
        provider,
        category: "tokens.input",
        unitPrice: 1,
        unitSize: 1,
      },
    ]);
    onTestFinished(async () => {
      await deleteUsagePricingRows({
        kind: "model",
        provider,
        categories: ["tokens.input"],
      });
    });
    const eventKey = await insertCharge({
      fixture,
      provider,
      amount: 3,
    });
    const grantKey = `expires-before-first-settlement-${randomUUID()}`;
    await createGrant({
      fixture,
      grantType: "purchased",
      idempotencyKey: grantKey,
      amount: 20,
      expiresAt: new Date(
        before.getTime() + 2 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    // The event was incurred while the grant and original price were active;
    // it has not been committed, so neither is frozen for the first retry.
    mockNow(new Date(before.getTime() + 8 * 24 * 60 * 60 * 1000));
    await seedUsagePricingRows([
      {
        kind: "model",
        provider,
        category: "tokens.input",
        unitPrice: 4,
        unitSize: 1,
      },
    ]);
    await processSettlement(fixture.orgId);

    await expect(
      store.set(readUsageEventState$, eventKey, context.signal),
    ).resolves.toMatchObject({ status: "processed", creditsCharged: 12 });
    const state = await readSettlementState(fixture.orgId);
    expect(state.body.org_credits).toBe(88);
    expect(state.body.grants).toHaveLength(1);
    expect(state.body.grants[0]).toMatchObject({
      idempotency_key: grantKey,
      remaining_amount: 20,
    });
  });

  it("recovers the committed charge across a late settlement retry without another debit", async () => {
    onTestFinished(clearMockNow);
    const before = nowDate();
    mockNow(before);
    const fixture = await setupSettlementFixture(100);
    const provider = await seedSettlementPricing();
    const idempotencyKey = await insertCharge({
      fixture,
      provider,
      amount: 12,
    });
    const purchasedKey = `retry-${randomUUID()}`;
    await createGrant({
      fixture,
      grantType: "purchased",
      idempotencyKey: purchasedKey,
      amount: 4,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    // The first successful transaction has committed, but the original
    // caller may have lost its HTTP acknowledgement. A later retry must
    // find the same processed event rather than settle a second charge.
    await processSettlement(fixture.orgId);
    const first = await store.set(
      readUsageEventState$,
      idempotencyKey,
      context.signal,
    );
    const firstFunds = await readSettlementState(fixture.orgId);
    expect(first).toMatchObject({ status: "processed", creditsCharged: 12 });
    expect(firstFunds.body.org_credits).toBe(92);
    expect(firstFunds.body.grants[0]?.remaining_amount).toBe(0);

    mockNow(new Date(before.getTime() + 8 * 24 * 60 * 60 * 1000));
    await processSettlement(fixture.orgId);
    const replay = await store.set(
      readUsageEventState$,
      idempotencyKey,
      context.signal,
    );
    const replayFunds = await readSettlementState(fixture.orgId);
    expect(replay).toStrictEqual(first);
    expect(replayFunds.body).toStrictEqual(firstFunds.body);
  });

  it("keeps switch-off organizations without allocations on shared credits", async () => {
    const fixture = await setupSettlementFixture(5);
    const provider = await seedSettlementPricing();
    await insertCharge({ fixture, provider, amount: 3 });

    await processSettlement(fixture.orgId);
    const state = await readSettlementState(fixture.orgId);

    expect(state.body).toStrictEqual({ org_credits: 2, grants: [] });
  });
});
