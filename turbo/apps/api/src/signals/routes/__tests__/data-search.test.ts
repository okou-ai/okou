import { randomUUID } from "node:crypto";
import {
  dataSearchContract,
  type DataSearchRequest,
} from "@okouai/api-contracts/contracts/data-search";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { financeContract } from "@okouai/api-contracts/contracts/finance";
import { cronReconcileSocialKitDownloadsContract } from "@okouai/api-contracts/contracts/cron";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { dataSearchRoutes } from "../data-search";
import { billingStatusRoutes } from "../billing-status";
import { financeRoutes } from "../finance";
import { cronReconcileSocialKitDownloadRoutes } from "../cron-reconcile-socialkit-downloads";
import appsGuide from "./fixtures/data-search/play-google-com-openapi.json";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicBillingScenario } from "./helpers/public-billing-scenario";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const REQUEST = {
  capability: "people.search",
  input: { query: "Founder" },
  limit: 2,
} as const;
const ENRICHMENT = {
  capability: "people.enrich",
  input: {
    fields: ["work-email"],
    name: "Ethan Zhang",
    domain: "example.com",
  },
  limit: 1,
} satisfies DataSearchRequest;
function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}
async function scenario({ operator = false } = {}) {
  const routes = [
    ...dataSearchRoutes,
    ...billingStatusRoutes,
    ...financeRoutes,
    ...(operator ? cronReconcileSocialKitDownloadRoutes : []),
  ];
  // Only the explicitly operator-scoped regression scans global jobs. Select
  // its isolated database before the entitlement fixture makes any request.
  const app = operator
    ? await setupApp({ context, routes, isolatePg: true })
    : setupApp({ context, routes });
  const actor = createBddApi(context).user({
    orgId: createUniqueStaffOrgIdFixture(),
  });
  if (!actor.orgId) {
    throw new Error("Data Search tests require an organization");
  }
  const billing = createPublicBillingScenario(context);
  let restoreSetup: (() => void) | undefined;
  billing.releaseBeforeDrain(() => {
    return restoreSetup?.();
  });
  await billing.run(() => {
    return createRunsApi(context).grantProEntitlement(actor, {
      run: billing.run,
      onExternalStateReady(restore) {
        restoreSetup = restore;
        billing.captureExternalState();
      },
    });
  });
  restoreSetup = undefined;
  mockEnv("OKOU_SOCIAL_MONID_API_KEY", "data-search-test-source-key");
  return {
    actor: { ...actor, orgId: actor.orgId },
    run: billing.run,
    data: app(dataSearchContract),
    billing: app(billingStatusContract),
    finance: app(financeContract),
    cron: app(cronReconcileSocialKitDownloadsContract),
  };
}
function source({
  pending = false,
  workEmail = false,
  empty = false,
  startGate,
  onStarting,
  inspectGate,
  onInspecting,
  startResponse = "receipt",
  stopConfirms = true,
}: {
  readonly pending?: boolean;
  readonly workEmail?: boolean;
  readonly empty?: boolean;
  readonly startGate?: Promise<void>;
  readonly onStarting?: () => void;
  readonly inspectGate?: Promise<void>;
  readonly onInspecting?: () => void;
  readonly startResponse?: "receipt" | "lost" | "unparseable";
  readonly stopConfirms?: boolean;
} = {}) {
  const observed = {
    starts: 0,
    stops: 0,
    stopped: false,
    completed: !pending,
    readUnavailable: false,
    readGate: undefined as Promise<void> | undefined,
    onReading: undefined as (() => void) | undefined,
  };
  const provider = workEmail ? "hunterio" : "apollo";
  const endpoint = workEmail ? "/email-finder" : "/mixed_people/api_search";
  const runId = `run_${randomUUID()}`;
  const receipt = () => {
    return {
      runId,
      provider,
      endpoint,
      status: observed.stopped
        ? "STOPPED"
        : observed.completed
          ? "COMPLETED"
          : "RUNNING",
      providerResponse: { httpStatus: 200 },
      output: workEmail
        ? {
            data: empty
              ? null
              : {
                  email: "ethan@example.com",
                  score: 98,
                  sources: [
                    { domain: "example.com", uri: "https://example.com/team" },
                  ],
                },
          }
        : {
            people: [
              {
                id: "p1",
                first_name: "Ethan",
                last_name_obfuscated: "Z***",
                title: "Founder",
                has_email: true,
              },
            ],
          },
      cost: { value: workEmail ? 0.0245 : 0, currency: "USD" },
    };
  };
  server.use(
    http.post("https://api.monid.ai/v1/inspect", async () => {
      onInspecting?.();
      await inspectGate;
      return HttpResponse.json({
        provider,
        endpoint,
        input: workEmail
          ? {
              queryParams: {
                type: "object",
                properties: {
                  domain: { type: "string" },
                  full_name: { type: "string" },
                  max_duration: { type: "integer", minimum: 3, maximum: 20 },
                },
                additionalProperties: false,
              },
            }
          : {
              queryParams: {
                type: "object",
                properties: {
                  q_keywords: { type: "string" },
                  page: { type: "integer" },
                  per_page: { type: "integer" },
                },
                additionalProperties: false,
              },
            },
        price: {
          type: workEmail ? "PER_RESULT" : "PER_CALL",
          amount: { value: workEmail ? 0.0245 : 0, currency: "USD" },
        },
      });
    }),
    http.post("https://api.monid.ai/v1/run", async () => {
      observed.starts += 1;
      onStarting?.();
      await startGate;
      if (startResponse === "lost") {
        return HttpResponse.error();
      }
      if (startResponse === "unparseable") {
        return HttpResponse.json({ accepted: true });
      }
      return HttpResponse.json(receipt());
    }),
    http.get(`https://api.monid.ai/v1/runs/${runId}`, async () => {
      observed.onReading?.();
      await observed.readGate;
      if (observed.readUnavailable) {
        return HttpResponse.json(
          { error: "Source temporarily unavailable" },
          { status: 503 },
        );
      }
      return HttpResponse.json(receipt());
    }),
    http.post(`https://api.monid.ai/v1/runs/${runId}/stop`, () => {
      observed.stops += 1;
      if (stopConfirms) {
        observed.stopped = true;
      }
      return HttpResponse.json({ runId, status: "STOPPING" }, { status: 202 });
    }),
  );
  return observed;
}

describe("saved Data Search jobs", () => {
  it("honors a saved Data Search credit reservation before admitting existing managed Finance", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      source({ pending: true });
      mockEnv("OKOU_FINANCE_APIDOJO_TOKEN", "finance-reservation-test-key");
      const before = await accept(
        setup.billing.get({ headers: authenticate(setup.actor) }),
        [200],
      );
      expect(before.body.credits).toBeGreaterThan(0);
      const created = await accept(
        setup.data.create({
          headers: authenticate(setup.actor),
          body: {
            ...REQUEST,
            requestId: randomUUID(),
            maxCredits: before.body.credits,
          },
        }),
        [202],
      );
      await flushWaitUntilForTest();
      const held = await accept(
        setup.data.get({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
        }),
        [200],
      );
      expect(held.body.billing.reservedCredits).toBe(before.body.credits);
      const denied = await accept(
        setup.finance.quote({
          headers: authenticate(setup.actor),
          body: { symbol: "AAPL" },
        }),
        [402],
      );
      expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
      await flushWaitUntilForTest();
    });
  });
  it("saves a genuine zero-price quote and replays exactly once, with tenant isolation and explicit unsupported continuation", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const upstream = source();
      const quote = await accept(
        setup.data.quote({ headers: authenticate(setup.actor), body: REQUEST }),
        [200],
      );
      expect(quote.body).toMatchObject({ estimatedCredits: 0, maxCredits: 0 });
      const body = { ...REQUEST, requestId: randomUUID(), maxCredits: 0 };
      const created = await accept(
        setup.data.create({ headers: authenticate(setup.actor), body }),
        [202],
      );
      await flushWaitUntilForTest();
      const saved = await accept(
        setup.data.get({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
        }),
        [200],
      );
      expect(saved.body).toMatchObject({
        status: "completed",
        billing: { state: "settled", creditsCharged: 0, reservedCredits: 0 },
        data: { items: [expect.objectContaining({ id: "p1" })] },
      });
      const replay = await accept(
        setup.data.create({ headers: authenticate(setup.actor), body }),
        [202],
      );
      expect(replay.body.jobId).toBe(created.body.jobId);
      const conflict = await accept(
        setup.data.create({
          headers: authenticate(setup.actor),
          body: { ...body, limit: 1 },
        }),
        [409],
      );
      expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
      for (const actor of [
        createBddApi(context).user({ orgId: setup.actor.orgId }),
        createBddApi(context).user(),
      ]) {
        await accept(
          setup.data.get({
            headers: authenticate(actor),
            params: { jobId: created.body.jobId },
          }),
          [404],
        );
        const listed = await accept(
          setup.data.list({
            headers: authenticate(actor),
            query: { limit: 20 },
          }),
          [200],
        );
        expect(listed.body.jobs).toStrictEqual([]);
      }
      const unsupported = await accept(
        setup.data.continue({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
          body: { requestId: randomUUID(), maxCredits: 0 },
        }),
        [422],
      );
      expect(unsupported.body.error.code).toBe(
        "DATA_SEARCH_CONTINUATION_UNSUPPORTED",
      );
      expect(upstream.starts).toBe(1);
    });
  });
  it("retains a cancellation request and settles only a confirmed source stop receipt", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const upstream = source({ pending: true });
      const created = await accept(
        setup.data.create({
          headers: authenticate(setup.actor),
          body: { ...REQUEST, requestId: randomUUID(), maxCredits: 0 },
        }),
        [202],
      );
      await flushWaitUntilForTest();
      await accept(
        setup.data.cancel({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
          body: {},
        }),
        [200],
      );
      await flushWaitUntilForTest();
      const stopped = await accept(
        setup.data.get({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
        }),
        [200],
      );
      expect(stopped.body).toMatchObject({
        status: "cancelled",
        billing: { state: "settled", reservedCredits: 0, creditsCharged: 0 },
      });
      expect(upstream.stops).toBe(1);
      expect(upstream.starts).toBe(1);
    });
  });
  it("honors cancellation recorded while the source is still accepting the job", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const accepting = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const upstream = source({
        pending: true,
        startGate: release.promise,
        onStarting: accepting.resolve,
      });
      const created = await accept(
        setup.data.create({
          headers: authenticate(setup.actor),
          body: { ...REQUEST, requestId: randomUUID(), maxCredits: 0 },
        }),
        [202],
      );
      const cancellation = await settleIncludingAbort(
        (async () => {
          await accepting.promise;
          await accept(
            setup.data.cancel({
              headers: authenticate(setup.actor),
              params: { jobId: created.body.jobId },
              body: {},
            }),
            [200],
          );
        })(),
      );
      release.resolve();
      if (!cancellation.ok) {
        throw cancellation.error;
      }
      await flushWaitUntilForTest();
      await accept(
        setup.data.get({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      const stopped = await accept(
        setup.data.get({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
        }),
        [200],
      );
      expect(stopped.body).toMatchObject({
        status: "cancelled",
        billing: { state: "settled", reservedCredits: 0 },
      });
      expect(upstream.stops).toBe(1);
      expect(upstream.starts).toBe(1);
    });
  });
  it("returns paid enriched contacts and charges the confirmed source receipt", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      source({ workEmail: true });
      const created = await accept(
        setup.data.create({
          headers: authenticate(setup.actor),
          body: {
            ...ENRICHMENT,
            requestId: randomUUID(),
            maxCredits: 31,
          },
        }),
        [202],
      );
      await flushWaitUntilForTest();
      const saved = await accept(
        setup.data.get({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
        }),
        [200],
      );
      expect(saved.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              email: "ethan@example.com",
              source: { provider: "hunterio", capability: "people.enrich" },
            },
          ],
        },
        billing: { state: "settled", creditsCharged: 31, reservedCredits: 0 },
      });
    });
  });

  it.each(["lost", "unparseable"] as const)(
    "keeps the paid reservation after a %s start response across same-ID recovery, reads and cancellation",
    async (startResponse) => {
      const setup = await scenario();
      await setup.run(async () => {
        const upstream = source({ workEmail: true, startResponse });
        const headers = authenticate(setup.actor);
        const before = await accept(setup.billing.get({ headers }), [200]);
        const body = { ...ENRICHMENT, requestId: randomUUID(), maxCredits: 40 };
        const created = await accept(
          setup.data.create({ headers, body }),
          [202],
        );
        await flushWaitUntilForTest();
        const replay = await accept(
          setup.data.create({ headers, body }),
          [202],
        );
        expect(replay.body.jobId).toBe(created.body.jobId);
        const params = { jobId: created.body.jobId };
        const recovered = await accept(
          setup.data.get({ headers, params }),
          [200],
        );
        expect(recovered.body).toMatchObject({
          status: "unknown",
          billing: { state: "pending", reservedCredits: 40, creditsCharged: 0 },
        });
        await accept(setup.data.cancel({ headers, params, body: {} }), [200]);
        await flushWaitUntilForTest();
        const saved = await accept(setup.data.get({ headers, params }), [200]);
        expect(saved.body).toMatchObject({
          jobId: created.body.jobId,
          status: "unknown",
          billing: { state: "pending", reservedCredits: 40, creditsCharged: 0 },
        });
        const after = await accept(setup.billing.get({ headers }), [200]);
        expect(after.body.credits).toBe(before.body.credits);
        // The held budget is still unavailable to another genuine paid request.
        const denied = await accept(
          setup.data.create({
            headers,
            body: {
              ...ENRICHMENT,
              requestId: randomUUID(),
              maxCredits: before.body.credits,
            },
          }),
          [402],
        );
        expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
        await flushWaitUntilForTest();
        expect(upstream.starts).toBe(1);
        expect(upstream.stops).toBe(0);
      });
    },
  );

  it("keeps an uncertain synchronous Firecrawl purchase reserved without replay or a guessed cancellation refund", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      mockEnv("OKOU_SCRAPE_FIRECRAWL_TOKEN", "data-search-firecrawl-test-key");
      mockEnv("OKOU_DATA_FIRECRAWL_USD_MICROS_PER_CREDIT", 1000);
      let starts = 0;
      server.use(
        http.get(appsGuide._review.sourceUrl, () => {
          return HttpResponse.json(appsGuide);
        }),
        http.post("https://api.firecrawl.dev/v2/scrape", () => {
          starts += 1;
          return HttpResponse.error();
        }),
      );
      const headers = authenticate(setup.actor);
      const before = await accept(setup.billing.get({ headers }), [200]);
      const body = {
        capability: "apps.profile",
        input: { package: "com.whatsapp" },
        limit: 1,
        requestId: randomUUID(),
        maxCredits: 10,
      };
      const created = await accept(setup.data.create({ headers, body }), [202]);
      await flushWaitUntilForTest();
      const replay = await accept(setup.data.create({ headers, body }), [202]);
      expect(replay.body.jobId).toBe(created.body.jobId);
      const params = { jobId: created.body.jobId };
      await accept(setup.data.get({ headers, params }), [200]);
      await accept(setup.data.cancel({ headers, params, body: {} }), [200]);
      await flushWaitUntilForTest();
      const saved = await accept(setup.data.get({ headers, params }), [200]);
      expect(saved.body).toMatchObject({
        status: "unknown",
        billing: { state: "pending", reservedCredits: 10, creditsCharged: 0 },
      });
      const after = await accept(setup.billing.get({ headers }), [200]);
      expect(after.body.credits).toBe(before.body.credits);
      await flushWaitUntilForTest();
      expect(starts).toBe(1);
    });
  });

  it("admits concurrent same-ID paid creates as one saved job and one external purchase", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const inspecting = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let inspections = 0;
      const upstream = source({
        workEmail: true,
        pending: true,
        inspectGate: release.promise,
        onInspecting() {
          inspections += 1;
          if (inspections === 2) {
            inspecting.resolve();
          }
        },
      });
      const headers = authenticate(setup.actor);
      const before = await accept(setup.billing.get({ headers }), [200]);
      const body = { ...ENRICHMENT, requestId: randomUUID(), maxCredits: 40 };
      const creates = Promise.all([
        accept(setup.data.create({ headers, body }), [202]),
        accept(setup.data.create({ headers, body }), [202]),
      ]);
      // Both callers have reached a genuine external quote before either
      // admission can finish; no database or private service gate is used.
      const inspected = await settleIncludingAbort(inspecting.promise);
      release.resolve();
      if (!inspected.ok) {
        throw inspected.error;
      }
      const [first, second] = await creates;
      expect(first.body.jobId).toBe(second.body.jobId);
      await flushWaitUntilForTest();
      const listed = await accept(
        setup.data.list({ headers, query: {} }),
        [200],
      );
      expect(listed.body.jobs).toMatchObject([
        {
          jobId: first.body.jobId,
          billing: { state: "pending", reservedCredits: 40, creditsCharged: 0 },
        },
      ]);
      expect(listed.body.jobs).toHaveLength(1);
      const after = await accept(setup.billing.get({ headers }), [200]);
      expect(after.body.credits).toBe(before.body.credits);
      expect(upstream.starts).toBe(1);
    });
  });

  it("admits only one concurrent paid request when their reservations compete for the same wallet capacity", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const inspecting = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let inspections = 0;
      const upstream = source({
        workEmail: true,
        pending: true,
        inspectGate: release.promise,
        onInspecting() {
          inspections += 1;
          if (inspections === 2) {
            inspecting.resolve();
          }
        },
      });
      const headers = authenticate(setup.actor);
      const before = await accept(setup.billing.get({ headers }), [200]);
      const budget = before.body.credits;
      expect(budget).toBeGreaterThan(31);
      const bodies = [randomUUID(), randomUUID()].map((requestId) => {
        return { ...ENRICHMENT, requestId, maxCredits: budget };
      });
      const creates = Promise.all(
        bodies.map((body) => {
          return accept(setup.data.create({ headers, body }), [202, 402, 409]);
        }),
      );
      const inspected = await settleIncludingAbort(inspecting.promise);
      release.resolve();
      if (!inspected.ok) {
        throw inspected.error;
      }
      const results = await creates;
      expect(
        results.filter((result) => {
          return result.status === 202;
        }),
      ).toHaveLength(1);
      const rejectedIndex = results.findIndex((result) => {
        return result.status !== 202;
      });
      const rejected = results[rejectedIndex];
      if (!rejected || rejected.status === 202) {
        throw new Error("Expected one capacity rejection");
      }
      expect([
        "INSUFFICIENT_CREDITS",
        "DATA_SEARCH_ADMISSION_CHANGED",
      ]).toContain(rejected.body.error.code);
      await flushWaitUntilForTest();
      const listed = await accept(
        setup.data.list({ headers, query: {} }),
        [200],
      );
      expect(listed.body.jobs).toHaveLength(1);
      expect(listed.body.jobs[0]?.billing).toMatchObject({
        state: "pending",
        reservedCredits: budget,
        creditsCharged: 0,
      });
      const rejectedBody = bodies[rejectedIndex];
      if (!rejectedBody) {
        throw new Error("Expected the rejected caller's request body");
      }
      const retry = await accept(
        setup.data.create({ headers, body: rejectedBody }),
        [402],
      );
      expect(retry.body.error.code).toBe("INSUFFICIENT_CREDITS");
      const after = await accept(setup.billing.get({ headers }), [200]);
      expect(after.body.credits).toBe(before.body.credits);
      expect(upstream.starts).toBe(1);
    });
  });

  it.each(["GET/GET", "GET/cancel"] as const)(
    "charges one paid terminal receipt and releases its reservation once during concurrent %s",
    async (readers) => {
      const setup = await scenario();
      await setup.run(async () => {
        const upstream = source({
          workEmail: true,
          pending: true,
          stopConfirms: false,
        });
        const headers = authenticate(setup.actor);
        const before = await accept(setup.billing.get({ headers }), [200]);
        const created = await accept(
          setup.data.create({
            headers,
            body: { ...ENRICHMENT, requestId: randomUUID(), maxCredits: 40 },
          }),
          [202],
        );
        await flushWaitUntilForTest();
        const reading = createDeferredPromise<void>(context.signal);
        const release = createDeferredPromise<void>(context.signal);
        let reads = 0;
        upstream.completed = true;
        upstream.readGate = release.promise;
        upstream.onReading = () => {
          reads += 1;
          if (reads === 2) {
            reading.resolve();
          }
        };
        const params = { jobId: created.body.jobId };
        const ready = await settleIncludingAbort(async () => {
          await Promise.all([
            accept(setup.data.get({ headers, params }), [200]),
            readers === "GET/GET"
              ? accept(setup.data.get({ headers, params }), [200])
              : accept(setup.data.cancel({ headers, params, body: {} }), [200]),
          ]);
          // Hold both source reads until the competing public requests have
          // reached the supplier. Both will then receive the same paid receipt.
          await reading.promise;
        });
        release.resolve();
        if (!ready.ok) {
          throw ready.error;
        }
        await flushWaitUntilForTest();
        const saved = await accept(setup.data.get({ headers, params }), [200]);
        expect(saved.body).toMatchObject({
          status: "completed",
          billing: { state: "settled", creditsCharged: 31, reservedCredits: 0 },
        });
        await accept(setup.data.cancel({ headers, params, body: {} }), [200]);
        const after = await accept(setup.billing.get({ headers }), [200]);
        expect(after.body.credits).toBe(before.body.credits - 31);
        // Reserving the full remaining wallet proves the old hold was released,
        // not merely hidden in the saved receipt's presentation.
        const nextSource = source({ workEmail: true });
        const next = await accept(
          setup.data.create({
            headers,
            body: {
              ...ENRICHMENT,
              requestId: randomUUID(),
              maxCredits: after.body.credits,
            },
          }),
          [202],
        );
        await flushWaitUntilForTest();
        const nextSaved = await accept(
          setup.data.get({ headers, params: { jobId: next.body.jobId } }),
          [200],
        );
        expect(nextSaved.body.billing).toMatchObject({
          state: "settled",
          creditsCharged: 31,
          reservedCredits: 0,
        });
        const final = await accept(setup.billing.get({ headers }), [200]);
        expect(final.body.credits).toBe(before.body.credits - 62);
        expect(upstream.starts).toBe(1);
        expect(nextSource.starts).toBe(1);
      });
    },
  );

  it("holds paid credits after an unconfirmed stop until a terminal source receipt confirms actual cost", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const upstream = source({
        workEmail: true,
        pending: true,
        stopConfirms: false,
      });
      const headers = authenticate(setup.actor);
      const before = await accept(setup.billing.get({ headers }), [200]);
      const created = await accept(
        setup.data.create({
          headers,
          body: { ...ENRICHMENT, requestId: randomUUID(), maxCredits: 40 },
        }),
        [202],
      );
      await flushWaitUntilForTest();
      const params = { jobId: created.body.jobId };
      await accept(setup.data.cancel({ headers, params, body: {} }), [200]);
      await flushWaitUntilForTest();
      const stopping = await accept(setup.data.get({ headers, params }), [200]);
      expect(stopping.body).toMatchObject({
        status: "running",
        billing: { state: "pending", creditsCharged: 0, reservedCredits: 40 },
      });
      const pendingBalance = await accept(
        setup.billing.get({ headers }),
        [200],
      );
      expect(pendingBalance.body.credits).toBe(before.body.credits);
      await flushWaitUntilForTest();
      expect(upstream.stops).toBe(1);
      upstream.stopped = true;
      await accept(setup.data.get({ headers, params }), [200]);
      await flushWaitUntilForTest();
      const stopped = await accept(setup.data.get({ headers, params }), [200]);
      expect(stopped.body).toMatchObject({
        status: "cancelled",
        billing: { state: "settled", creditsCharged: 31, reservedCredits: 0 },
      });
      const after = await accept(setup.billing.get({ headers }), [200]);
      expect(after.body.credits).toBe(before.body.credits - 31);
      expect(upstream.starts).toBe(1);
      expect(upstream.stops).toBe(1);
    });
  });

  it("operator reconciliation progresses healthy paid jobs past a failing source read while retaining the failed job's hold", async () => {
    // Explicit operator boundary: the real authenticated cron scans all tenants.
    // All jobs still originate from public creates; only this case isolates PG.
    const setup = await scenario({ operator: true });
    await setup.run(async () => {
      mockEnv("CRON_SECRET", "data-search-reconciliation-test-secret");
      const baseTime = now();
      const headers = authenticate(setup.actor);
      const before = await accept(setup.billing.get({ headers }), [200]);
      const jobs: string[] = [];
      const suppliers: ReturnType<typeof source>[] = [];
      for (let index = 0; index < 3; index += 1) {
        mockNow(baseTime + index * 1000);
        const supplier = source({ workEmail: true, pending: true });
        suppliers.push(supplier);
        const created = await accept(
          setup.data.create({
            headers,
            body: { ...ENRICHMENT, requestId: randomUUID(), maxCredits: 40 },
          }),
          [202],
        );
        jobs.push(created.body.jobId);
        await flushWaitUntilForTest();
      }
      const [failing, healthy, later] = suppliers;
      if (!failing || !healthy || !later) {
        throw new Error("Expected three supplier-owned runs");
      }
      failing.readUnavailable = true;
      healthy.completed = true;
      later.completed = true;
      mockNow(baseTime + 3000);
      await accept(
        setup.cron.reconcile({
          headers: {
            authorization: "Bearer data-search-reconciliation-test-secret",
          },
        }),
        [200],
      );
      // List is a public observation without scheduling a competing GET advance.
      const first = await accept(
        setup.data.list({ headers, query: {} }),
        [200],
      );
      expect(
        first.body.jobs.find((job) => {
          return job.jobId === jobs[0];
        }),
      ).toMatchObject({
        billing: { state: "pending", creditsCharged: 0, reservedCredits: 40 },
        error: { code: "DATA_SEARCH_UNAVAILABLE" },
      });
      expect(
        first.body.jobs.find((job) => {
          return job.jobId === jobs[1];
        }),
      ).toMatchObject({
        status: "completed",
        billing: { state: "settled", creditsCharged: 31, reservedCredits: 0 },
      });
      mockNow(baseTime + 4000);
      await accept(
        setup.cron.reconcile({
          headers: {
            authorization: "Bearer data-search-reconciliation-test-secret",
          },
        }),
        [200],
      );
      const second = await accept(
        setup.data.list({ headers, query: {} }),
        [200],
      );
      expect(
        second.body.jobs.find((job) => {
          return job.jobId === jobs[2];
        }),
      ).toMatchObject({
        status: "completed",
        billing: { state: "settled", creditsCharged: 31, reservedCredits: 0 },
      });
      expect(
        second.body.jobs.find((job) => {
          return job.jobId === jobs[0];
        }),
      ).toMatchObject({
        billing: { state: "pending", creditsCharged: 0, reservedCredits: 40 },
      });
      const after = await accept(setup.billing.get({ headers }), [200]);
      expect(after.body.credits).toBe(before.body.credits - 62);
      expect(
        suppliers.map((supplier) => {
          return supplier.starts;
        }),
      ).toStrictEqual([1, 1, 1]);
    });
  });
});
