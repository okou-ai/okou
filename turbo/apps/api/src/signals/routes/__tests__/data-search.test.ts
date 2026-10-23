import { randomUUID } from "node:crypto";
import { dataSearchContract } from "@okouai/api-contracts/contracts/data-search";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { dataSearchRoutes } from "../data-search";
import { billingStatusRoutes } from "../billing-status";
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
function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}
async function scenario() {
  const app = setupApp({
    context,
    routes: [...dataSearchRoutes, ...billingStatusRoutes],
  });
  const actor = createBddApi(context).user();
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
  };
}
function source({
  pending = false,
  workEmail = false,
  stopPending = false,
  startGate,
  onStarting,
}: {
  readonly pending?: boolean;
  readonly workEmail?: boolean;
  readonly stopPending?: boolean;
  readonly startGate?: Promise<void>;
  readonly onStarting?: () => void;
} = {}) {
  const observed = { starts: 0, stops: 0, stopped: false };
  const provider = workEmail ? "hunterio" : "apollo";
  const endpoint = workEmail ? "/email-finder" : "/mixed_people/api_search";
  const runId = `run_${randomUUID()}`;
  const receipt = () => {
    return {
      runId,
      provider,
      endpoint,
      status: observed.stopped ? "STOPPED" : pending ? "RUNNING" : "COMPLETED",
      providerResponse: { httpStatus: 200 },
      output: workEmail
        ? {
            data: {
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
      ...(observed.stopped || !pending
        ? { cost: { value: workEmail ? 0.0245 : 0, currency: "USD" } }
        : {}),
    };
  };
  server.use(
    http.post("https://api.monid.ai/v1/inspect", () => {
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
      const { cost, ...run } = receipt();
      return HttpResponse.json({
        ...run,
        ...(cost
          ? {
              billing: {
                actualCost: {
                  value: Math.round(cost.value * 1_000_000),
                  currency: "USD",
                  unit: "MICRO_DOLLAR",
                },
              },
            }
          : {}),
      });
    }),
    http.get(`https://api.monid.ai/v1/runs/${runId}`, () => {
      return HttpResponse.json(receipt());
    }),
    http.post(`https://api.monid.ai/v1/runs/${runId}/stop`, () => {
      observed.stops += 1;
      observed.stopped = !stopPending;
      return HttpResponse.json({ runId, status: "STOPPING" }, { status: 202 });
    }),
  );
  return {
    starts: () => {
      return observed.starts;
    },
    stops: () => {
      return observed.stops;
    },
    confirmStop() {
      observed.stopped = true;
    },
  };
}

describe("saved Data Search jobs", () => {
  it("saves a genuine zero-price quote and shares one job across concurrent identical creates", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const upstream = source();
      const quote = await accept(
        setup.data.quote({ headers: authenticate(setup.actor), body: REQUEST }),
        [200],
      );
      expect(quote.body).toMatchObject({ estimatedCredits: 0, maxCredits: 0 });
      const body = { ...REQUEST, requestId: randomUUID(), maxCredits: 0 };
      const creates = await Promise.all([
        accept(
          setup.data.create({ headers: authenticate(setup.actor), body }),
          [202],
        ),
        accept(
          setup.data.create({ headers: authenticate(setup.actor), body }),
          [202],
        ),
      ]);
      const [created, concurrent] = creates;
      expect(concurrent.body.jobId).toBe(created.body.jobId);
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
      const listed = await accept(
        setup.data.list({
          headers: authenticate(setup.actor),
          query: { limit: 20 },
        }),
        [200],
      );
      expect(listed.body.jobs).toStrictEqual([saved.body]);
      expect(upstream.starts()).toBe(1);
    });
  });
  it("retains paid cancellation reservation until the confirmed source cost settles", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const upstream = source({
        pending: true,
        workEmail: true,
        stopPending: true,
      });
      const before = await accept(
        setup.billing.get({ headers: authenticate(setup.actor) }),
        [200],
      );
      const created = await accept(
        setup.data.create({
          headers: authenticate(setup.actor),
          body: {
            capability: "people.enrich",
            input: {
              fields: ["work-email"],
              name: "Ethan Zhang",
              domain: "example.com",
            },
            limit: 1,
            requestId: randomUUID(),
            maxCredits: 100,
          },
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
      const pending = await accept(
        setup.data.get({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
        }),
        [200],
      );
      expect(pending.body).toMatchObject({
        status: "running",
        billing: { state: "pending", reservedCredits: 100 },
      });
      const held = await accept(
        setup.billing.get({ headers: authenticate(setup.actor) }),
        [200],
      );
      expect(held.body.credits).toBe(before.body.credits);
      await flushWaitUntilForTest();
      upstream.confirmStop();
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
        billing: { state: "settled", reservedCredits: 0, creditsCharged: 31 },
      });
      const after = await accept(
        setup.billing.get({ headers: authenticate(setup.actor) }),
        [200],
      );
      expect(after.body.credits).toBe(before.body.credits - 31);
      expect(upstream.stops()).toBe(1);
      expect(upstream.starts()).toBe(1);
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
      expect(upstream.stops()).toBe(1);
      expect(upstream.starts()).toBe(1);
    });
  });
});
