import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { dataSearchContract } from "@okouai/api-contracts/contracts/data-search";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { financeContract } from "@okouai/api-contracts/contracts/finance";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { generateOkouToken } from "../../auth/tokens";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { dataSearchRoutes } from "../data-search";
import { billingStatusRoutes } from "../billing-status";
import { financeRoutes } from "../finance";
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
    routes: [...dataSearchRoutes, ...billingStatusRoutes, ...financeRoutes],
  });
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
  };
}
function source({
  pending = false,
  workEmail = false,
  empty = false,
  startGate,
  onStarting,
}: {
  readonly pending?: boolean;
  readonly workEmail?: boolean;
  readonly empty?: boolean;
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
      return HttpResponse.json(receipt());
    }),
    http.get(`https://api.monid.ai/v1/runs/${runId}`, () => {
      return HttpResponse.json(receipt());
    }),
    http.post(`https://api.monid.ai/v1/runs/${runId}/stop`, () => {
      observed.stops += 1;
      observed.stopped = true;
      return HttpResponse.json({ runId, status: "STOPPING" }, { status: 202 });
    }),
  );
  return observed;
}

// External auth fixture: a correctly signed agent bearer carrying search scope
// only. The production verifier, not a mocked auth context, enforces the grant.
function searchOnlyHeaders(actor: { userId: string; orgId: string }) {
  const token = generateOkouToken(actor.userId, randomUUID(), actor.orgId);
  const unsigned = token.slice("vm0_sandbox_".length).split(".");
  const header = unsigned[0];
  const original = unsigned[1];
  if (!header || !original) {
    throw new Error("Missing signed token payload");
  }
  const claims: unknown = JSON.parse(
    Buffer.from(original, "base64url").toString(),
  );
  if (typeof claims !== "object" || claims === null) {
    throw new Error("Invalid auth fixture");
  }
  const payload = Buffer.from(
    JSON.stringify({ ...claims, capabilities: ["data-search:read"] }),
  ).toString("base64url");
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex"),
      "",
      "jwt-sandbox-signing",
      32,
    ),
  );
  const signature = createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return {
    authorization: `Bearer vm0_sandbox_${header}.${payload}.${signature}`,
  };
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
  it("requires enrichment scope for saved contacts, discovery, cancel and listing", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      source({ workEmail: true });
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
            maxCredits: 31,
          },
        }),
        [202],
      );
      await flushWaitUntilForTest();
      const headers = searchOnlyHeaders(setup.actor);
      await accept(
        setup.data.get({ headers, params: { jobId: created.body.jobId } }),
        [404],
      );
      await accept(
        setup.data.cancel({
          headers,
          params: { jobId: created.body.jobId },
          body: {},
        }),
        [404],
      );
      const listed = await accept(
        setup.data.list({ headers, query: { limit: 20 } }),
        [200],
      );
      expect(listed.body.jobs).toStrictEqual([]);
      const catalog = await accept(
        setup.data.capabilities({ headers, query: {} }),
        [200],
      );
      expect(
        catalog.body.capabilities.map((item) => {
          return item.id;
        }),
      ).not.toContain("people.enrich");
      const saved = await accept(
        setup.data.get({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
        }),
        [200],
      );
      expect(saved.body.billing).toMatchObject({
        state: "settled",
        creditsCharged: 31,
        reservedCredits: 0,
      });
    });
  });
});
