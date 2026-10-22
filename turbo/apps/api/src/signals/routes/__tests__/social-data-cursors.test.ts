import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  socialDataContract,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { billingStatusRoutes } from "../billing-status";
import { socialDataRoutes } from "../social-data";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicBillingScenario } from "./helpers/public-billing-scenario";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const ROUTES = Object.freeze([...socialDataRoutes, ...billingStatusRoutes]);
const SEC_UID = "MS4wLjABAAAA_public_cursor_example";
const UID = "1722594714";
const POST = "7354669356632638218";
const COMMENT = "7354669356632638219";
const NEXT_COMMENT = "7354669356632638220";

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function scenario() {
  const actor = createBddApi(context).user();
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
  mockEnv("OKOU_SOCIAL_MONID_API_KEY", "social-cursors-test-key");
  const app = setupApp({ context, routes: ROUTES });
  const social = app(socialDataContract);
  return {
    actor,
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
  readonly query: Readonly<Record<string, string | number>>;
  readonly data: Readonly<Record<string, unknown>>;
}

// Only Monid's external inspect/run/receipt protocol is mocked. Each paid
// request must match the cursor reconstructed by the production route lifecycle.
function monidPages(
  endpoint: string,
  parameters: Readonly<Record<string, "string" | "integer">>,
  pages: readonly Page[],
) {
  const runs: unknown[] = [];
  const receipts = new Map<string, object>();
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
            properties: Object.fromEntries(
              Object.entries(parameters).map(([name, type]) => {
                return [name, { type }];
              }),
            ),
          },
        },
        price: { type: "PER_CALL", amount: { value: 0.001, currency: "USD" } },
      });
    }),
    http.post("https://api.monid.ai/v1/run", async ({ request }) => {
      const page = pages[runs.length];
      if (!page) {
        throw new Error("Unexpected additional paid cursor page");
      }
      const body: unknown = await request.json();
      runs.push(body);
      expect(body).toStrictEqual({
        provider: "tikhub",
        endpoint,
        input: { queryParams: page.query },
      });
      const runId = `social_${randomUUID()}`;
      const receipt = {
        runId,
        provider: "tikhub",
        endpoint,
        status: "COMPLETED",
        output: { code: 200, data: page.data },
        providerResponse: { httpStatus: 200 },
        billedUnits: 1,
        cost: { value: 0.001, currency: "USD", unit: "USD" },
      };
      receipts.set(runId, receipt);
      return HttpResponse.json(receipt);
    }),
    http.get("https://api.monid.ai/v1/runs/:runId", ({ params }) => {
      const receipt = receipts.get(String(params.runId));
      if (!receipt) {
        throw new Error("Unexpected cursor page receipt lookup");
      }
      return HttpResponse.json(receipt);
    }),
  );
  return { runs };
}

async function completed(setup: Scenario, jobId: string) {
  // GET is the public recovery boundary; synchronize on settled output rather
  // than calling a private worker, an operator sweep, or sleeping.
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

function continuePage(setup: Scenario, jobId: string, maxCredits?: number) {
  return setup.social.continue({
    headers: authenticate(setup.actor),
    params: { jobId },
    body: {
      requestId: randomUUID(),
      ...(maxCredits === undefined ? {} : { maxCredits }),
    },
  });
}

async function twoPages(
  setup: Scenario,
  request: SocialDataRequest,
  provider: ReturnType<typeof monidPages>,
  firstHasMore: boolean | null = true,
) {
  const before = await setup.credits();
  const root = await accept(
    setup.social.create({
      headers: authenticate(setup.actor),
      body: { ...request, requestId: randomUUID() },
    }),
    [202],
  );
  const first = await completed(setup, root.body.jobId);
  expect(first.body).toMatchObject({
    collection: {
      requestedItems: request.limit,
      hasMore: firstHasMore,
      continuationAvailable: true,
    },
    billing: { state: "settled", creditsCharged: 2 },
  });
  await expect(setup.credits()).resolves.toBe(before - 2);
  const quote = await accept(quoteNext(setup, root.body.jobId), [200]);
  expect(quote.body).toMatchObject({
    estimatedCredits: 2,
    maxCredits: 2,
    quantity: 1,
    unit: "request",
  });
  await setup.get(root.body.jobId);
  expect(provider.runs).toHaveLength(1);
  await expect(setup.credits()).resolves.toBe(before - 2);

  const child = await accept(
    continuePage(setup, root.body.jobId, quote.body.maxCredits),
    [202],
  );
  const second = await completed(setup, child.body.jobId);
  expect(second.body).toMatchObject({
    collection: { sourceJobId: root.body.jobId, requestedItems: request.limit },
    billing: { state: "settled", creditsCharged: 2 },
  });
  await expect(setup.credits()).resolves.toBe(before - 4);
  expect(provider.runs).toHaveLength(2);
  return { first, second };
}

async function noSuccessor(
  setup: Scenario,
  jobId: string,
  provider: ReturnType<typeof monidPages>,
) {
  const before = await setup.credits();
  const quote = await accept(quoteNext(setup, jobId), [409]);
  const continued = await accept(continuePage(setup, jobId), [409]);
  expect(quote.body.error.code).toBe("SOCIAL_DATA_NO_CONTINUATION");
  expect(continued.body.error.code).toBe("SOCIAL_DATA_NO_CONTINUATION");
  await setup.get(jobId);
  const listed = await accept(
    setup.social.list({
      headers: authenticate(setup.actor),
      query: { limit: 20, includeExpanded: "true" },
    }),
    [200],
  );
  expect(listed.body.jobs).toHaveLength(2);
  expect(provider.runs).toHaveLength(2);
  await expect(setup.credits()).resolves.toBe(before);
}

const COMMENT_REQUEST = {
  platform: "douyin",
  operation: "comments",
  url: `https://www.douyin.com/video/${POST}`,
  limit: 5,
} as const satisfies SocialDataRequest;

function commentPages(nextCursor: number, hasMore: number) {
  return monidPages(
    "/api/v1/douyin/app/v3/fetch_video_comments",
    { aweme_id: "string", cursor: "integer", count: "integer" },
    [
      {
        query: { aweme_id: POST, cursor: 0, count: 20 },
        data: {
          status_code: 0,
          has_more: 1,
          cursor: 20,
          comments: [
            {
              cid: COMMENT,
              text: "First comment",
              user: { uid: UID, sec_uid: SEC_UID },
            },
          ],
        },
      },
      {
        query: { aweme_id: POST, cursor: 20, count: 20 },
        data: {
          status_code: 0,
          has_more: hasMore,
          cursor: nextCursor,
          comments: [
            {
              cid: NEXT_COMMENT,
              text: "Next comment",
              user: { uid: UID, sec_uid: SEC_UID },
            },
          ],
        },
      },
    ],
  );
}

describe("Social data persisted China cursor protocols", () => {
  it("reconstructs a Douyin comment cursor and stops at the declared source end", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const provider = commentPages(40, 0);
      const { first, second } = await twoPages(
        setup,
        COMMENT_REQUEST,
        provider,
      );
      expect(first.body.data).toMatchObject({
        items: [{ id: COMMENT, text: "First comment", authorId: UID }],
      });
      expect(second.body).toMatchObject({
        data: {
          items: [
            {
              id: NEXT_COMMENT,
              text: "Next comment",
              authorUrl: `https://www.douyin.com/user/${SEC_UID}`,
            },
          ],
          pagination: { hasMore: false },
        },
        collection: {
          itemsReturned: 1,
          cumulativeItemsReturned: 2,
          hasMore: false,
          continuationAvailable: false,
        },
      });
      await noSuccessor(setup, second.body.jobId, provider);
    });
  });

  it("persists following initialization max-time and changes source_type from 2 to 1", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const provider = monidPages(
        "/api/v1/douyin/web/fetch_user_following_list",
        {
          sec_user_id: "string",
          max_time: "string",
          source_type: "integer",
          count: "integer",
        },
        [
          {
            query: {
              sec_user_id: SEC_UID,
              max_time: "0",
              source_type: 2,
              count: 20,
            },
            // Initialization is not proof of end, even with an empty array and has_more=0.
            data: {
              status_code: 0,
              has_more: 0,
              max_time: "1720000000",
              followings: [],
            },
          },
          {
            query: {
              sec_user_id: SEC_UID,
              max_time: "1720000000",
              source_type: 1,
              count: 20,
            },
            data: {
              status_code: 0,
              has_more: 0,
              max_time: "1719999999",
              followings: [
                {
                  uid: UID,
                  sec_uid: SEC_UID,
                  nickname: "Business creator",
                  unique_id: "business_creator",
                },
              ],
            },
          },
        ],
      );
      const { first, second } = await twoPages(
        setup,
        {
          platform: "douyin",
          operation: "following",
          url: `https://www.douyin.com/user/${SEC_UID}`,
          limit: 5,
        },
        provider,
      );
      expect(first.body).toMatchObject({
        data: { items: [], pagination: { hasMore: true } },
        collection: { itemsReturned: 0, cumulativeItemsReturned: 0 },
      });
      expect(second.body).toMatchObject({
        data: {
          items: [
            {
              id: UID,
              displayName: "Business creator",
              username: "business_creator",
              url: `https://www.douyin.com/user/${SEC_UID}`,
            },
          ],
          pagination: { hasMore: false },
        },
        collection: {
          itemsReturned: 1,
          cumulativeItemsReturned: 1,
          continuationAvailable: false,
        },
      });
      await noSuccessor(setup, second.body.jobId, provider);
    });
  });

  it("delivers positive follower pages while reconstructing their max-time without a following source_type", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const provider = monidPages(
        "/api/v1/douyin/app/v3/fetch_user_fans_list",
        { sec_user_id: "string", max_time: "string", count: "integer" },
        [
          {
            query: { sec_user_id: SEC_UID, max_time: "0", count: 20 },
            data: {
              status_code: 0,
              has_more: 1,
              max_time: "1720000100",
              followers: [
                {
                  uid: UID,
                  sec_uid: SEC_UID,
                  nickname: "First follower",
                  follower_count: 12,
                },
              ],
            },
          },
          {
            query: { sec_user_id: SEC_UID, max_time: "1720000100", count: 20 },
            data: {
              status_code: 0,
              has_more: 0,
              max_time: "1720000000",
              followers: [
                {
                  uid: "1722594715",
                  sec_uid: "MS4wLjABAAAA_second_follower",
                  nickname: "Next follower",
                  following_count: 8,
                },
              ],
            },
          },
        ],
      );
      const { first, second } = await twoPages(
        setup,
        {
          platform: "douyin",
          operation: "followers",
          url: `https://www.douyin.com/user/${SEC_UID}`,
          limit: 5,
        },
        provider,
      );
      expect(first.body.data).toMatchObject({
        items: [
          {
            id: UID,
            displayName: "First follower",
            followers: 12,
            url: `https://www.douyin.com/user/${SEC_UID}`,
          },
        ],
      });
      expect(second.body).toMatchObject({
        data: {
          items: [
            { id: "1722594715", displayName: "Next follower", following: 8 },
          ],
          pagination: { hasMore: false },
        },
        collection: {
          itemsReturned: 1,
          cumulativeItemsReturned: 2,
          continuationAvailable: false,
        },
      });
      await noSuccessor(setup, second.body.jobId, provider);
    });
  });

  it("reconstructs a Weibo comment max-id as an exact string and recognizes its zero end marker", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const maxId = "9007199254740993123";
      const provider = monidPages(
        "/api/v1/weibo/web_v2/fetch_post_comments",
        { id: "string", count: "integer", max_id: "string" },
        [
          {
            query: { id: POST, count: 10 },
            data: {
              ok: 1,
              max_id: maxId,
              data: [
                {
                  idstr: COMMENT,
                  text: "First Weibo comment",
                  user: { idstr: UID, screen_name: "Public commenter" },
                },
              ],
            },
          },
          {
            query: { id: POST, count: 10, max_id: maxId },
            data: {
              ok: 1,
              max_id: "0",
              data: [
                {
                  idstr: NEXT_COMMENT,
                  text: "Last Weibo comment",
                  user: { idstr: UID },
                },
              ],
            },
          },
        ],
      );
      // The provider's max-id allows continuation even without a has_more flag;
      // that unknown end state must not be represented as a proven source end.
      const { first, second } = await twoPages(
        setup,
        {
          platform: "weibo",
          operation: "comments",
          url: `https://weibo.com/${UID}/${POST}`,
          limit: 5,
        },
        provider,
        null,
      );
      expect(first.body.data).toMatchObject({
        items: [{ id: COMMENT, authorId: UID }],
      });
      expect(second.body).toMatchObject({
        data: {
          items: [
            {
              id: NEXT_COMMENT,
              text: "Last Weibo comment",
              authorUrl: `https://weibo.com/u/${UID}`,
            },
          ],
          pagination: { hasMore: false },
        },
        collection: {
          cumulativeItemsReturned: 2,
          hasMore: false,
          continuationAvailable: false,
        },
      });
      await noSuccessor(setup, second.body.jobId, provider);
    });
  });

  it("suppresses a repeated cursor despite new rows and has_more, without another successor or charge", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const provider = commentPages(20, 1);
      const { second } = await twoPages(setup, COMMENT_REQUEST, provider);
      expect(second.body).toMatchObject({
        data: { items: [{ id: NEXT_COMMENT }], pagination: { hasMore: null } },
        collection: {
          itemsReturned: 1,
          cumulativeItemsReturned: 2,
          hasMore: null,
          continuationAvailable: false,
        },
      });
      await noSuccessor(setup, second.body.jobId, provider);
    });
  });
});
