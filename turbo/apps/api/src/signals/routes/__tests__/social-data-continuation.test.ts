import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  socialDataContract,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { billingStatusRoutes } from "../billing-status";
import { socialDataRoutes } from "../social-data";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createPublicBillingScenario } from "./helpers/public-billing-scenario";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const ROUTES = Object.freeze([...socialDataRoutes, ...billingStatusRoutes]);
const SEC_UID = "MS4wLjABAAAA_public_continuation_example";
const ENDPOINT = "/api/v1/douyin/app/v3/fetch_user_post_videos";
const REQUEST = {
  platform: "douyin",
  operation: "posts",
  url: `https://www.douyin.com/user/${SEC_UID}`,
  limit: 3,
} as const satisfies SocialDataRequest;

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function scenario() {
  const orgId = createUniqueStaffOrgIdFixture();
  const actor = createBddApi(context).user({ orgId });
  const billing = createPublicBillingScenario(context);
  let restoreSetup: (() => void) | undefined;
  billing.releaseBeforeDrain(() => {
    restoreSetup?.();
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
  mockEnv("OKOU_SOCIAL_MONID_API_KEY", "social-continuation-test-key");
  await billing.run(() => {
    return updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.SocialDataExpansion]: true,
      },
    );
  });
  const app = setupApp({ context, routes: ROUTES });
  const social = app(socialDataContract);
  return {
    actor,
    orgId,
    run: billing.run,
    social,
    async credits() {
      const response = await accept(
        app(billingStatusContract).get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body.credits;
    },
    get(jobId: string) {
      return accept(
        social.get({ headers: authenticate(actor), params: { jobId } }),
        [200],
      );
    },
  };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

interface Page {
  readonly cursor: number;
  readonly count: number;
  readonly ids: readonly string[];
  readonly nextCursor?: number;
  readonly hasMore?: boolean;
  readonly state?: "RUNNING" | "COMPLETED";
  readonly settled?: boolean;
}

function douyinPages(pages: readonly Page[]) {
  const runs: unknown[] = [];
  const inspections: unknown[] = [];
  const receipts = new Map<string, object>();
  server.use(
    http.post("https://api.monid.ai/v1/inspect", async ({ request }) => {
      const body: unknown = await request.json();
      inspections.push(body);
      expect(body).toStrictEqual({ provider: "tikhub", endpoint: ENDPOINT });
      return HttpResponse.json({
        provider: "tikhub",
        endpoint: ENDPOINT,
        input: {
          queryParams: {
            type: "object",
            properties: {
              sec_user_id: { type: "string" },
              max_cursor: { type: "integer" },
              count: { type: "integer" },
              sort_type: { type: "integer" },
              channel: { type: "string" },
            },
          },
        },
        price: { type: "PER_CALL", amount: { value: 0.001, currency: "USD" } },
      });
    }),
    http.post("https://api.monid.ai/v1/run", async ({ request }) => {
      const page = pages[runs.length];
      if (!page) {
        throw new Error("Unexpected additional paid Social page");
      }
      const body: unknown = await request.json();
      runs.push(body);
      expect(body).toStrictEqual({
        provider: "tikhub",
        endpoint: ENDPOINT,
        input: {
          queryParams: {
            sec_user_id: SEC_UID,
            max_cursor: page.cursor,
            count: page.count,
            sort_type: 0,
            channel: "normal",
          },
        },
      });
      const runId = `social_${randomUUID()}`;
      const receipt = {
        runId,
        provider: "tikhub",
        endpoint: ENDPOINT,
        status: page.state ?? "COMPLETED",
        output: {
          code: 200,
          data: {
            status_code: 0,
            ...(page.hasMore === undefined
              ? {}
              : { has_more: page.hasMore ? 1 : 0 }),
            ...(page.nextCursor === undefined
              ? {}
              : { max_cursor: page.nextCursor }),
            aweme_list: page.ids.map((id) => {
              return { aweme_id: id, desc: `Public post ${id}` };
            }),
          },
        },
        providerResponse: { httpStatus: 200 },
        billedUnits: 1,
        ...(page.settled === false
          ? {}
          : {
              cost: { value: 0.001, currency: "USD", unit: "USD" },
            }),
      };
      receipts.set(runId, receipt);
      return HttpResponse.json(receipt, {
        status: page.state === "RUNNING" ? 202 : 200,
      });
    }),
    http.get("https://api.monid.ai/v1/runs/:runId", ({ params }) => {
      const receipt = receipts.get(String(params.runId));
      if (!receipt) {
        throw new Error("Unexpected Social provider receipt lookup");
      }
      return HttpResponse.json(receipt);
    }),
  );
  return { runs, inspections };
}

function create(setup: Scenario, limit: number = REQUEST.limit) {
  return accept(
    setup.social.create({
      headers: authenticate(setup.actor),
      body: { ...REQUEST, limit, requestId: randomUUID() },
    }),
    [202],
  );
}

async function completed(setup: Scenario, jobId: string) {
  // The public GET drives recovery if the accepted request's background work
  // still owns the page. Wait for the observable settlement, never a timer.
  await expect
    .poll(async () => {
      const response = await setup.get(jobId);
      return {
        status: response.body.status,
        billing: response.body.billing.state,
      };
    })
    .toEqual({ status: "completed", billing: "settled" });
  return setup.get(jobId);
}

function quoteNext(setup: Scenario, jobId: string) {
  return setup.social.quoteContinuation({
    headers: authenticate(setup.actor),
    params: { jobId },
    body: {},
  });
}

function continuePage(
  setup: Scenario,
  jobId: string,
  requestId = randomUUID(),
  maxCredits?: number,
) {
  return setup.social.continue({
    headers: authenticate(setup.actor),
    params: { jobId },
    body: { requestId, ...(maxCredits === undefined ? {} : { maxCredits }) },
  });
}

describe("Social data explicit page continuation", () => {
  it("quotes for free and bills exactly once per explicit page while retaining the root limit and deduplicating IDs", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const provider = douyinPages([
        { cursor: 0, count: 3, ids: ["101"], nextCursor: 100, hasMore: true },
        {
          cursor: 100,
          count: 2,
          ids: ["101", "102"],
          nextCursor: 200,
          hasMore: true,
        },
        { cursor: 200, count: 1, ids: ["103"], nextCursor: 300, hasMore: true },
      ]);
      const before = await setup.credits();
      const initialQuote = await accept(
        setup.social.quote({
          headers: authenticate(setup.actor),
          body: REQUEST,
        }),
        [200],
      );
      expect(initialQuote.body).toMatchObject({
        estimatedCredits: 2,
        maxCredits: 2,
        quantity: 1,
        unit: "request",
      });
      await expect(setup.credits()).resolves.toBe(before);
      expect(provider.runs).toHaveLength(0);

      const root = await create(setup);
      const first = await completed(setup, root.body.jobId);
      expect(first.body).toMatchObject({
        data: { items: [{ id: "101" }], pagination: { hasMore: true } },
        collection: {
          requestedItems: 3,
          itemsReturned: 1,
          cumulativeItemsReturned: 1,
          hasMore: true,
          continuationAvailable: true,
        },
        billing: { state: "settled", creditsCharged: 2 },
      });
      await setup.get(root.body.jobId);
      expect(provider.runs).toHaveLength(1);
      await expect(setup.credits()).resolves.toBe(before - 2);

      const quoted = await accept(quoteNext(setup, root.body.jobId), [200]);
      expect(quoted.body).toMatchObject({
        estimatedCredits: 2,
        maxCredits: 2,
        quantity: 1,
        unit: "request",
      });
      expect(provider.runs).toHaveLength(1);
      await expect(setup.credits()).resolves.toBe(before - 2);
      await accept(
        continuePage(setup, root.body.jobId, randomUUID(), 1),
        [402],
      );
      expect(provider.runs).toHaveLength(1);
      await expect(setup.credits()).resolves.toBe(before - 2);

      const requestId = randomUUID();
      const child = await accept(
        continuePage(setup, root.body.jobId, requestId, quoted.body.maxCredits),
        [202],
      );
      const second = await completed(setup, child.body.jobId);
      expect(second.body).toMatchObject({
        requestId,
        data: { items: [{ id: "102" }] },
        collection: {
          sourceJobId: root.body.jobId,
          requestedItems: 3,
          itemsReturned: 1,
          cumulativeItemsReturned: 2,
          continuationAvailable: true,
        },
        billing: { state: "settled", creditsCharged: 2 },
      });
      expect(provider.runs).toHaveLength(2);
      await expect(setup.credits()).resolves.toBe(before - 4);
      const inspectionsBeforeReplay = provider.inspections.length;
      const replay = await accept(
        continuePage(setup, root.body.jobId, requestId, quoted.body.maxCredits),
        [202],
      );
      expect(replay.body.jobId).toBe(child.body.jobId);
      expect(replay.body.billing).toStrictEqual(second.body.billing);
      const conflict = await accept(
        continuePage(setup, root.body.jobId),
        [409],
      );
      expect(conflict.body.error.code).toBe(
        "SOCIAL_DATA_PAGE_ALREADY_CONTINUED",
      );
      expect(provider.inspections).toHaveLength(inspectionsBeforeReplay);
      await setup.get(child.body.jobId);
      expect(provider.runs).toHaveLength(2);
      await expect(setup.credits()).resolves.toBe(before - 4);

      const last = await accept(continuePage(setup, child.body.jobId), [202]);
      const third = await completed(setup, last.body.jobId);
      expect(third.body).toMatchObject({
        data: { items: [{ id: "103" }] },
        collection: {
          requestedItems: 3,
          itemsReturned: 1,
          cumulativeItemsReturned: 3,
          hasMore: true,
          continuationAvailable: false,
        },
        billing: { state: "settled", creditsCharged: 2 },
      });
      const inspectionsBeforeExhaustion = provider.inspections.length;
      const exhaustedQuote = await accept(
        quoteNext(setup, last.body.jobId),
        [409],
      );
      const exhaustedCreate = await accept(
        continuePage(setup, last.body.jobId),
        [409],
      );
      expect(exhaustedQuote.body.error.code).toBe(
        "SOCIAL_DATA_NO_CONTINUATION",
      );
      expect(exhaustedCreate.body.error.code).toBe(
        "SOCIAL_DATA_NO_CONTINUATION",
      );
      expect(provider.inspections).toHaveLength(inspectionsBeforeExhaustion);
      expect(provider.runs).toHaveLength(3);
      await expect(setup.credits()).resolves.toBe(before - 6);
    });
  });

  it("continues Weibo using the checked next page and stops at a declared source end", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const endpoint = "/api/v1/weibo/app/fetch_user_timeline";
      const uid = "1722594714";
      const runs: unknown[] = [];
      server.use(
        http.post("https://api.monid.ai/v1/inspect", async ({ request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            provider: "tikhub",
            endpoint,
          });
          return HttpResponse.json({
            provider: "tikhub",
            endpoint,
            input: {
              queryParams: {
                type: "object",
                properties: {
                  uid: { type: "string" },
                  page: { type: "integer" },
                  filter_type: { type: "string" },
                },
              },
            },
            price: {
              type: "PER_CALL",
              amount: { value: 0.001, currency: "USD" },
            },
          });
        }),
        http.post("https://api.monid.ai/v1/run", async ({ request }) => {
          const page = runs.length + 1;
          expect(page).toBeLessThanOrEqual(2);
          const body: unknown = await request.json();
          runs.push(body);
          expect(body).toStrictEqual({
            provider: "tikhub",
            endpoint,
            input: { queryParams: { uid, page, filter_type: "all" } },
          });
          return HttpResponse.json({
            runId: `social_${randomUUID()}`,
            provider: "tikhub",
            endpoint,
            status: "COMPLETED",
            output: {
              code: 200,
              data: {
                has_more: page === 1,
                statuses: [
                  { idstr: String(500 + page), text_raw: "Public Weibo post" },
                ],
              },
            },
            providerResponse: { httpStatus: 200 },
            billedUnits: 1,
            cost: { value: 0.001, currency: "USD", unit: "USD" },
          });
        }),
      );
      const before = await setup.credits();
      const root = await accept(
        setup.social.create({
          headers: authenticate(setup.actor),
          body: {
            platform: "weibo",
            operation: "posts",
            url: `https://weibo.com/u/${uid}`,
            limit: 3,
            requestId: randomUUID(),
          },
        }),
        [202],
      );
      const first = await completed(setup, root.body.jobId);
      expect(first.body.collection).toMatchObject({
        requestedItems: 3,
        cumulativeItemsReturned: 1,
        hasMore: true,
        continuationAvailable: true,
      });
      await accept(quoteNext(setup, root.body.jobId), [200]);
      await setup.get(root.body.jobId);
      expect(runs).toHaveLength(1);
      await expect(setup.credits()).resolves.toBe(before - 2);
      const next = await accept(continuePage(setup, root.body.jobId), [202]);
      const last = await completed(setup, next.body.jobId);
      expect(last.body).toMatchObject({
        data: { items: [{ id: "502" }], pagination: { hasMore: false } },
        collection: {
          sourceJobId: root.body.jobId,
          requestedItems: 3,
          cumulativeItemsReturned: 2,
          hasMore: false,
          continuationAvailable: false,
        },
        billing: { state: "settled", creditsCharged: 2 },
      });
      await accept(quoteNext(setup, next.body.jobId), [409]);
      await accept(continuePage(setup, next.body.jobId), [409]);
      expect(runs).toHaveLength(2);
      await expect(setup.credits()).resolves.toBe(before - 4);
    });
  });

  it("keeps expanded pages opt-in for old lists and recovers owned results after the flag is disabled", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const provider = douyinPages([
        { cursor: 0, count: 3, ids: ["201"], nextCursor: 100, hasMore: true },
      ]);
      const root = await create(setup);
      const saved = await completed(setup, root.body.jobId);
      const oldList = await accept(
        setup.social.list({
          headers: authenticate(setup.actor),
          query: { limit: 20 },
        }),
        [200],
      );
      expect(oldList.body.jobs).toStrictEqual([]);
      const expandedList = await accept(
        setup.social.list({
          headers: authenticate(setup.actor),
          query: { limit: 20, includeExpanded: "true" },
        }),
        [200],
      );
      expect(
        expandedList.body.jobs.map((job) => {
          return job.jobId;
        }),
      ).toStrictEqual([root.body.jobId]);

      const other = createBddApi(context).user({ orgId: setup.orgId });
      const before = await setup.credits();
      const inspectionsBefore = provider.inspections.length;
      await accept(
        setup.social.get({
          headers: authenticate(other),
          params: { jobId: root.body.jobId },
        }),
        [404],
      );
      await accept(
        setup.social.quoteContinuation({
          headers: authenticate(other),
          params: { jobId: root.body.jobId },
          body: {},
        }),
        [404],
      );
      await accept(
        setup.social.continue({
          headers: authenticate(other),
          params: { jobId: root.body.jobId },
          body: { requestId: randomUUID() },
        }),
        [404],
      );
      expect(provider.inspections).toHaveLength(inspectionsBefore);
      expect(provider.runs).toHaveLength(1);
      await expect(setup.credits()).resolves.toBe(before);

      await updateFeatureSwitchesForUser(
        context,
        { ...setup.actor, orgId: setup.orgId },
        {
          [FeatureSwitchKey.SocialDataExpansion]: false,
        },
      );
      await accept(
        setup.social.quote({
          headers: authenticate(setup.actor),
          body: REQUEST,
        }),
        [403],
      );
      await accept(
        setup.social.create({
          headers: authenticate(setup.actor),
          body: { ...REQUEST, requestId: randomUUID() },
        }),
        [403],
      );
      await accept(quoteNext(setup, root.body.jobId), [403]);
      await accept(continuePage(setup, root.body.jobId), [403]);
      const recoveredList = await accept(
        setup.social.list({
          headers: authenticate(setup.actor),
          query: { limit: 20, includeExpanded: "true" },
        }),
        [200],
      );
      expect(recoveredList.body.jobs).toStrictEqual([saved.body]);
      const otherList = await accept(
        setup.social.list({
          headers: authenticate(other),
          query: { limit: 20, includeExpanded: "true" },
        }),
        [200],
      );
      expect(otherList.body.jobs).toStrictEqual([]);
      const recovered = await setup.get(root.body.jobId);
      expect(recovered.body.data).toStrictEqual(saved.body.data);
      expect(recovered.body.billing).toStrictEqual(saved.body.billing);
      expect(provider.inspections).toHaveLength(inspectionsBefore);
      expect(provider.runs).toHaveLength(1);
      await expect(setup.credits()).resolves.toBe(before);
    });
  });

  it.each([
    { label: "unknown upstream end", hasMore: undefined, expected: null },
    { label: "proven upstream end", hasMore: false, expected: false },
  ] as const)(
    "distinguishes $label without inventing a paid next page",
    async ({ hasMore, expected }) => {
      const setup = await scenario();
      await setup.run(async () => {
        const provider = douyinPages([
          { cursor: 0, count: 3, ids: ["301"], hasMore },
        ]);
        const root = await create(setup);
        const result = await completed(setup, root.body.jobId);
        expect(result.body).toMatchObject({
          data: { pagination: { hasMore: expected } },
          collection: {
            hasMore: expected,
            continuationAvailable: false,
            cumulativeItemsReturned: 1,
          },
        });
        const before = await setup.credits();
        const inspectionsBefore = provider.inspections.length;
        const quote = await accept(quoteNext(setup, root.body.jobId), [409]);
        const continued = await accept(
          continuePage(setup, root.body.jobId),
          [409],
        );
        expect(quote.body.error.code).toBe("SOCIAL_DATA_NO_CONTINUATION");
        expect(continued.body.error.code).toBe("SOCIAL_DATA_NO_CONTINUATION");
        expect(provider.inspections).toHaveLength(inspectionsBefore);
        expect(provider.runs).toHaveLength(1);
        await expect(setup.credits()).resolves.toBe(before);
      });
    },
  );

  it.each([
    { label: "running", state: "RUNNING", settled: true },
    {
      label: "awaiting a settlement receipt",
      state: "COMPLETED",
      settled: false,
    },
  ] as const)(
    "refuses continuation while the parent is $label",
    async ({ state, settled }) => {
      const setup = await scenario();
      await setup.run(async () => {
        const provider = douyinPages([
          {
            cursor: 0,
            count: 3,
            ids: ["401"],
            nextCursor: 100,
            hasMore: true,
            state,
            settled,
          },
        ]);
        const before = await setup.credits();
        const root = await create(setup);
        await expect
          .poll(async () => {
            const response = await setup.get(root.body.jobId);
            return response.body.status;
          })
          .toBe("running");
        const pending = await setup.get(root.body.jobId);
        expect(pending.body.billing).toMatchObject({
          state: "pending",
          creditsCharged: 0,
        });
        const inspectionsBefore = provider.inspections.length;
        const quote = await accept(quoteNext(setup, root.body.jobId), [409]);
        const continued = await accept(
          continuePage(setup, root.body.jobId),
          [409],
        );
        expect(quote.body.error.code).toBe("SOCIAL_DATA_PAGE_NOT_SETTLED");
        expect(continued.body.error.code).toBe("SOCIAL_DATA_PAGE_NOT_SETTLED");
        expect(provider.inspections).toHaveLength(inspectionsBefore);
        expect(provider.runs).toHaveLength(1);
        await expect(setup.credits()).resolves.toBe(before);
      });
    },
  );
});
