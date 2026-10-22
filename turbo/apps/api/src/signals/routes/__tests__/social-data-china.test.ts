import { randomUUID } from "node:crypto";
import { cronReconcileSocialKitDownloadsContract } from "@okouai/api-contracts/contracts/cron";
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
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { socialDataRoutes } from "../social-data";
import { cronReconcileSocialKitDownloadRoutes } from "../cron-reconcile-socialkit-downloads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicBillingScenario } from "./helpers/public-billing-scenario";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const ROUTES = Object.freeze([
  ...socialDataRoutes,
  ...cronReconcileSocialKitDownloadRoutes,
]);
const CRON_SECRET = "social-china-adapter-operator";
const SEC_UID = "MS4wLjABAAAA_public_example";
const UID = "1722594714";
const POST = "5283919831764022";
const COMMENT = "7354669356632638218";
const DOUYIN_SEARCH_ACCOUNT = Object.freeze({
  user_id: SEC_UID,
  nick_name: "Result",
  fans_cnt: 123,
  publish_cnt: 4,
  avatar_url: "https://p3.douyinpic.com/example.jpeg",
});
const WEIBO_SEARCH_POST = Object.freeze({
  weibo_id: "5356786167057917",
  user_name: "Example",
  user_nick: "Example",
  user_url: "//weibo.com/1678512213?refer_flag=1001030103_",
  post_url: "//weibo.com/1678512213/RnPgAtC5n?refer_flag=1001030103_",
  content: "Public test content",
  publish_time: "19秒前",
  weibo_type: "original",
  media: { has_image: false, has_video: false, images: [], videos: [] },
  interaction: { repost_count: 1, comment_count: 2, like_count: 3 },
});

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function scenario() {
  // The production reconciliation cron is explicitly under test. Its global
  // sweep requires an isolated database. The staff identity is test-owned.
  const app = await setupApp({ context, routes: ROUTES, isolatePg: true });
  const actor = createBddApi(context).user({
    orgId: createUniqueStaffOrgIdFixture(),
  });
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
  mockEnv("OKOU_SOCIAL_MONID_API_KEY", "social-china-test-key");
  mockEnv("CRON_SECRET", CRON_SECRET);
  return {
    actor,
    run: billing.run,
    social: app(socialDataContract),
    cron: app(cronReconcileSocialKitDownloadsContract),
  };
}

type Parameter = {
  readonly type?: string;
  readonly anyOf?: readonly { readonly type: string }[];
};
function monid(
  endpoint: string,
  parameters: Readonly<Record<string, Parameter>>,
  output: unknown,
  expectedInput: unknown,
  {
    location = "queryParams",
    sourceStatus = 200,
  }: {
    readonly location?: "body" | "queryParams";
    readonly sourceStatus?: number;
  } = {},
) {
  const executions: unknown[] = [];
  server.use(
    http.post("https://api.monid.ai/v1/inspect", async ({ request }) => {
      await expect(request.json()).resolves.toStrictEqual({
        provider: "tikhub",
        endpoint,
      });
      return HttpResponse.json({
        provider: "tikhub",
        endpoint,
        input: { [location]: { type: "object", properties: parameters } },
        price: { type: "PER_CALL", amount: { value: 0.001, currency: "USD" } },
      });
    }),
    http.post("https://api.monid.ai/v1/run", async ({ request }) => {
      const body: unknown = await request.json();
      executions.push(body);
      expect(body).toStrictEqual({
        provider: "tikhub",
        endpoint,
        input: expectedInput,
      });
      return HttpResponse.json({
        runId: `social_${randomUUID()}`,
        provider: "tikhub",
        endpoint,
        status: "COMPLETED",
        output,
        providerResponse: { httpStatus: sourceStatus },
        billedUnits: 1,
        cost: { value: 0.001, currency: "USD", unit: "USD" },
      });
    }),
  );
  return executions;
}

async function execute(
  setup: Awaited<ReturnType<typeof scenario>>,
  request: SocialDataRequest,
) {
  const created = await accept(
    setup.social.create({
      headers: authenticate(setup.actor),
      body: { ...request, requestId: randomUUID() },
    }),
    [202],
  );
  await accept(
    setup.cron.reconcile({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
  );
  // A live create-request claim can make cron return before its owner finishes.
  // Wait for that registered work before asserting the public terminal result.
  await flushWaitUntilForTest();
  return accept(
    setup.social.get({
      headers: authenticate(setup.actor),
      params: { jobId: created.body.jobId },
    }),
    [200],
  );
}

describe("Douyin and Weibo Social adapters", () => {
  it("inspects a Douyin profile from the live root user envelope", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/douyin/web/handler_user_profile",
        { sec_user_id: { type: "string" } },
        {
          status_code: 0,
          status_msg: null,
          user: {
            uid: UID,
            sec_uid: SEC_UID,
            nickname: "Example creator",
            unique_id: "example_creator",
            signature: "A fictional public profile",
            follower_count: 12,
            following_count: 3,
            aweme_count: 4,
          },
        },
        { queryParams: { sec_user_id: SEC_UID } },
      );
      const job = await execute(setup, {
        platform: "douyin",
        operation: "inspect",
        url: `https://www.douyin.com/user/${SEC_UID}`,
        limit: 1,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              id: UID,
              url: `https://www.douyin.com/user/${SEC_UID}`,
              username: "example_creator",
              displayName: "Example creator",
              description: "A fictional public profile",
              followers: 12,
              following: 3,
              posts: 4,
            },
          ],
        },
        collection: { itemsReturned: 1, continuationAvailable: false },
      });
    });
  });

  it("delivers live root Douyin comments without confusing post and parent IDs", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/douyin/app/v3/fetch_video_comments",
        {
          aweme_id: { type: "string" },
          cursor: { type: "integer" },
          count: { type: "integer" },
        },
        {
          status_code: 0,
          comments: [
            {
              cid: COMMENT,
              aweme_id: POST,
              text: "A fictional comment",
              user: { uid: UID, sec_uid: SEC_UID, nickname: "Example reader" },
              reply_id: "0",
              digg_count: 2,
              reply_comment_total: 1,
            },
          ],
          cursor: 20,
          has_more: 0,
          total: 1,
        },
        { queryParams: { aweme_id: POST, cursor: 0, count: 20 } },
      );
      const job = await execute(setup, {
        platform: "douyin",
        operation: "comments",
        url: `https://www.douyin.com/video/${POST}`,
        limit: 10,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              id: COMMENT,
              text: "A fictional comment",
              authorId: UID,
              authorUrl: `https://www.douyin.com/user/${SEC_UID}`,
              parentId: "0",
              likes: 2,
              replies: 1,
            },
          ],
          pagination: { hasMore: false },
        },
        collection: { itemsReturned: 1, continuationAvailable: false },
      });
    });
  });

  it("delivers typed Douyin posts with stable author identity and allowed media", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const executions = monid(
        "/api/v1/douyin/app/v3/fetch_user_post_videos",
        {
          sec_user_id: { type: "string" },
          max_cursor: { type: "integer" },
          count: { type: "integer" },
          sort_type: { type: "integer" },
          channel: { type: "string" },
        },
        {
          code: 200,
          data: {
            status_code: 0,
            has_more: 1,
            max_cursor: 100,
            aweme_list: [
              {
                aweme_id: POST,
                desc: "Public post",
                author: { uid: UID, sec_uid: SEC_UID, nickname: "Creator" },
                video: {
                  play_addr: {
                    url_list: [
                      "https://v.example.douyinvod.com/public.mp4",
                      "https://untrusted.example/track",
                    ],
                  },
                },
                statistics: { digg_count: 7 },
              },
            ],
          },
        },
        {
          queryParams: {
            sec_user_id: SEC_UID,
            max_cursor: 0,
            count: 2,
            sort_type: 0,
            channel: "normal",
          },
        },
      );
      const job = await execute(setup, {
        platform: "douyin",
        operation: "posts",
        url: `https://www.douyin.com/user/${SEC_UID}`,
        limit: 2,
      });
      expect(job.body.status).toBe("completed");
      expect(job.body.data).toMatchObject({
        items: [
          {
            id: POST,
            authorId: UID,
            authorUrl: `https://www.douyin.com/user/${SEC_UID}`,
            likes: 7,
            mediaUrls: ["https://v.example.douyinvod.com/public.mp4"],
          },
        ],
        pagination: { hasMore: true },
      });
      expect(executions).toHaveLength(1);
    });
  });

  it("keeps Douyin reply post and parent-comment IDs distinct", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/douyin/app/v3/fetch_video_comment_replies",
        {
          item_id: { type: "string" },
          comment_id: { type: "string" },
          cursor: { type: "integer" },
          count: { type: "integer" },
        },
        {
          code: 200,
          data: {
            status_code: 0,
            has_more: 0,
            cursor: 0,
            comments: [
              {
                cid: "7354669356632638219",
                text: "Reply",
                user: { uid: UID, sec_uid: SEC_UID },
              },
            ],
          },
        },
        {
          queryParams: {
            item_id: POST,
            comment_id: COMMENT,
            cursor: 0,
            count: 20,
          },
        },
      );
      const job = await execute(setup, {
        platform: "douyin",
        operation: "replies",
        url: `https://www.douyin.com/video/${POST}`,
        commentId: COMMENT,
        limit: 1,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            { id: "7354669356632638219", parentId: COMMENT, authorId: UID },
          ],
          pagination: { hasMore: false },
        },
      });
    });
  });

  it("exposes following initialization as a single billed page, not a completed collection", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const executions = monid(
        "/api/v1/douyin/web/fetch_user_following_list",
        {
          sec_user_id: { type: "string" },
          max_time: { type: "string" },
          source_type: { type: "integer" },
          count: { type: "integer" },
        },
        {
          code: 200,
          data: { status_code: 0, followings: [], max_time: "1720000000" },
        },
        {
          queryParams: {
            sec_user_id: SEC_UID,
            max_time: "0",
            source_type: 2,
            count: 20,
          },
        },
      );
      const job = await execute(setup, {
        platform: "douyin",
        operation: "following",
        url: `https://www.douyin.com/user/${SEC_UID}`,
        limit: 10,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: { items: [], pagination: { hasMore: true } },
      });
      expect(executions).toHaveLength(1);
    });
  });

  it("reports a private Douyin following list as unavailable without charging credits", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/douyin/web/fetch_user_following_list",
        {
          sec_user_id: { type: "string" },
          max_time: { type: "string" },
          source_type: { type: "integer" },
          count: { type: "integer" },
        },
        {
          status_code: 2096,
          followings: null,
          status_msg: "由于该用户隐私设置，列表不可见",
        },
        {
          queryParams: {
            sec_user_id: SEC_UID,
            max_time: "0",
            source_type: 2,
            count: 20,
          },
        },
      );
      const job = await execute(setup, {
        platform: "douyin",
        operation: "following",
        url: `https://www.douyin.com/user/${SEC_UID}`,
        limit: 10,
      });
      expect(job.body).toMatchObject({
        status: "failed",
        error: {
          code: "SOCIAL_DATA_SOURCE_UNAVAILABLE",
          message:
            "The source account's privacy settings prevent access to this list.",
        },
        data: null,
        billing: { creditsCharged: 0, reservedCredits: 0 },
      });
    });
  });

  it("reports other Douyin business failures as source errors without exposing upstream text", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/douyin/web/handler_user_profile",
        { sec_user_id: { type: "string" } },
        { status_code: 1, status_msg: "Example upstream diagnostic" },
        { queryParams: { sec_user_id: SEC_UID } },
      );
      const job = await execute(setup, {
        platform: "douyin",
        operation: "inspect",
        url: `https://www.douyin.com/user/${SEC_UID}`,
        limit: 1,
      });
      expect(job.body).toMatchObject({
        status: "failed",
        error: {
          code: "SOCIAL_DATA_SOURCE_ERROR",
          message: "The source platform could not complete this operation.",
        },
        data: null,
        billing: { creditsCharged: 0, reservedCredits: 0 },
      });
    });
  });

  it("searches Douyin accounts without a second profile lookup", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const executions = monid(
        "/api/v1/douyin/search/fetch_user_search_v2",
        {
          keyword: { type: "string" },
          cursor: { type: "integer" },
        },
        {
          code: 0,
          data: {
            user_list: [DOUYIN_SEARCH_ACCOUNT],
            has_more: true,
            cursor: 30,
          },
          message: "",
        },
        { body: { keyword: "business", cursor: 0 } },
        { location: "body" },
      );
      const job = await execute(setup, {
        platform: "douyin",
        operation: "search",
        query: "business",
        type: "account",
        limit: 2,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              id: SEC_UID,
              url: `https://www.douyin.com/user/${SEC_UID}`,
              displayName: "Result",
              followers: 123,
              posts: 4,
              mediaUrls: ["https://p3.douyinpic.com/example.jpeg"],
            },
          ],
          pagination: { hasMore: true },
        },
        collection: {
          requestedItems: 2,
          itemsReturned: 1,
          continuationAvailable: true,
        },
      });
      expect(executions).toHaveLength(1);

      const nextExecutions = monid(
        "/api/v1/douyin/search/fetch_user_search_v2",
        { keyword: { type: "string" }, cursor: { type: "integer" } },
        {
          code: 0,
          data: { user_list: [], has_more: false, cursor: 30 },
          message: "",
        },
        { body: { keyword: "business", cursor: 30 } },
        { location: "body" },
      );
      const continued = await accept(
        setup.social.continue({
          headers: authenticate(setup.actor),
          params: { jobId: job.body.jobId },
          body: { requestId: randomUUID() },
        }),
        [202],
      );
      await accept(
        setup.cron.reconcile({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      const next = await accept(
        setup.social.get({
          headers: authenticate(setup.actor),
          params: { jobId: continued.body.jobId },
        }),
        [200],
      );
      expect(next.body).toMatchObject({
        status: "completed",
        data: { items: [], pagination: { hasMore: false } },
        collection: { itemsReturned: 0, continuationAvailable: false },
      });
      expect(nextExecutions).toHaveLength(1);
    });
  });

  it("caps Douyin search results and returned count at the requested limit", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/douyin/search/fetch_user_search_v2",
        { keyword: { type: "string" }, cursor: { type: "integer" } },
        {
          code: 0,
          data: {
            user_list: [
              DOUYIN_SEARCH_ACCOUNT,
              { ...DOUYIN_SEARCH_ACCOUNT, user_id: `${SEC_UID}_second` },
            ],
            has_more: true,
            cursor: 30,
          },
          message: "",
        },
        { body: { keyword: "business", cursor: 0 } },
        { location: "body" },
      );
      const job = await execute(setup, {
        platform: "douyin",
        operation: "search",
        query: "business",
        type: "account",
        limit: 1,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [{ id: SEC_UID }],
          pagination: { hasMore: true },
        },
        collection: {
          requestedItems: 1,
          itemsReturned: 1,
          cumulativeItemsReturned: 1,
          continuationAvailable: false,
        },
      });
    });
  });

  it("inspects a Weibo numeric profile using an explicitly typed nullable schema", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/weibo/web_v2/fetch_user_info",
        {
          uid: { anyOf: [{ type: "string" }, { type: "null" }] },
          custom: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        {
          code: 200,
          data: {
            userInfo: {
              idstr: UID,
              screen_name: "Public profile",
              followers_count: 10,
            },
          },
        },
        { queryParams: { uid: UID } },
      );
      const job = await execute(setup, {
        platform: "weibo",
        operation: "inspect",
        url: `https://weibo.com/u/${UID}`,
        limit: 1,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            { id: UID, url: `https://weibo.com/u/${UID}`, followers: 10 },
          ],
        },
      });
    });
  });

  it("inspects a Weibo profile from the live root user envelope", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/weibo/web_v2/fetch_user_info",
        { uid: { type: "string" } },
        {
          user: {
            id: Number(UID),
            idstr: UID,
            screen_name: "Example publisher",
            description: "A fictional Weibo profile",
            followers_count: 15,
            friends_count: 5,
            statuses_count: 7,
          },
        },
        { queryParams: { uid: UID } },
      );
      const job = await execute(setup, {
        platform: "weibo",
        operation: "inspect",
        url: `https://weibo.com/u/${UID}`,
        limit: 1,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              id: UID,
              url: `https://weibo.com/u/${UID}`,
              displayName: "Example publisher",
              description: "A fictional Weibo profile",
              followers: 15,
              following: 5,
              posts: 7,
            },
          ],
        },
        collection: { itemsReturned: 1, continuationAvailable: false },
      });
    });
  });

  it("delivers grouped and direct Weibo timeline feeds and stops at moreInfo.noMore", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const parameters = {
        uid: { type: "string" },
        page: { type: "integer" },
        filter_type: { type: "string" },
      };
      monid(
        "/api/v1/weibo/app/fetch_user_timeline",
        parameters,
        {
          items: [
            { category: "card", data: { card_type: 216 } },
            {
              category: "group",
              items: [
                { category: "card", data: { card_type: 8 } },
                {
                  category: "feed",
                  data: {
                    idstr: POST,
                    text: "A fictional grouped post",
                    user: {
                      id: Number(UID),
                      idstr: UID,
                      screen_name: "Example publisher",
                    },
                    attitudes_count: 3,
                    comments_count: 2,
                    reposts_count: 1,
                    pic_infos: {
                      fictional_picture: {
                        large: {
                          url: "https://wx1.sinaimg.cn/large/fictional-picture.jpg",
                        },
                      },
                    },
                  },
                },
              ],
            },
            {
              category: "feed",
              data: {
                idstr: "6000000000000002",
                text: "A fictional direct post",
                user: { idstr: UID },
              },
            },
          ],
          moreInfo: {
            pagingType: "cursor",
            params: { max_id: 0, page: 2, count: 20 },
            noMore: false,
          },
        },
        { queryParams: { uid: UID, page: 1, filter_type: "all" } },
      );
      const job = await execute(setup, {
        platform: "weibo",
        operation: "posts",
        url: `https://weibo.com/u/${UID}`,
        limit: 10,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              id: POST,
              url: `https://weibo.com/${UID}/${POST}`,
              text: "A fictional grouped post",
              authorId: UID,
              authorUrl: `https://weibo.com/u/${UID}`,
              likes: 3,
              comments: 2,
              shares: 1,
              mediaUrls: ["https://wx1.sinaimg.cn/large/fictional-picture.jpg"],
            },
            {
              id: "6000000000000002",
              text: "A fictional direct post",
              authorId: UID,
            },
          ],
          pagination: { hasMore: true },
        },
        collection: { itemsReturned: 2, continuationAvailable: true },
      });
      monid(
        "/api/v1/weibo/app/fetch_user_timeline",
        parameters,
        {
          items: [
            {
              category: "feed",
              data: {
                idstr: "6000000000000003",
                text: "A fictional final post",
                user: { idstr: UID },
              },
            },
          ],
          moreInfo: {
            pagingType: "cursor",
            params: { max_id: 0, page: 3, count: 20 },
            noMore: true,
          },
        },
        { queryParams: { uid: UID, page: 2, filter_type: "all" } },
      );
      const continued = await accept(
        setup.social.continue({
          headers: authenticate(setup.actor),
          params: { jobId: job.body.jobId },
          body: { requestId: randomUUID() },
        }),
        [202],
      );
      await accept(
        setup.cron.reconcile({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      const next = await accept(
        setup.social.get({
          headers: authenticate(setup.actor),
          params: { jobId: continued.body.jobId },
        }),
        [200],
      );
      expect(next.body).toMatchObject({
        status: "completed",
        data: {
          items: [{ id: "6000000000000003", text: "A fictional final post" }],
          pagination: { hasMore: false },
        },
        collection: {
          itemsReturned: 1,
          cumulativeItemsReturned: 3,
          continuationAvailable: false,
        },
      });
    });
  });

  it("uses a parent comment rather than post ID for Weibo sub-comments", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/weibo/web_v2/fetch_post_sub_comments",
        {
          id: { type: "string" },
          count: { type: "integer" },
          max_id: { type: "string" },
        },
        {
          code: 200,
          data: {
            data: [
              {
                idstr: "5283574244704556",
                text: "Reply",
                user: { idstr: UID },
              },
            ],
            max_id: "",
          },
        },
        { queryParams: { id: COMMENT, count: 10 } },
      );
      const job = await execute(setup, {
        platform: "weibo",
        operation: "replies",
        url: `https://weibo.com/${UID}/${POST}`,
        commentId: COMMENT,
        limit: 10,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [{ parentId: COMMENT, authorId: UID }],
          pagination: { hasMore: null },
        },
      });
    });
  });

  it("searches Weibo realtime posts and preserves string author IDs", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/weibo/web_v2/fetch_realtime_search",
        {
          query: { type: "string" },
          page: { type: "integer" },
        },
        {
          parsed_data: {
            results: [WEIBO_SEARCH_POST],
            result_count: 1,
            pagination: {},
            search_stats: {},
            parse_success: true,
          },
        },
        { queryParams: { query: "business", page: 1 } },
      );
      const job = await execute(setup, {
        platform: "weibo",
        operation: "search",
        query: "business",
        type: "post",
        limit: 10,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              id: "5356786167057917",
              url: "https://weibo.com/1678512213/RnPgAtC5n",
              authorId: "1678512213",
              authorUrl: "https://weibo.com/u/1678512213",
              text: "Public test content",
              publishedAt: "19秒前",
              likes: 3,
              comments: 2,
              shares: 1,
            },
          ],
          pagination: { hasMore: null },
        },
        collection: {
          itemsReturned: 1,
          hasMore: null,
          continuationAvailable: false,
        },
      });
    });
  });

  it.each([
    {
      name: "a Douyin search account without its canonical sec UID",
      platform: "douyin",
      type: "account",
      endpoint: "/api/v1/douyin/search/fetch_user_search_v2",
      output: {
        code: 0,
        data: {
          user_list: [{ ...DOUYIN_SEARCH_ACCOUNT, user_id: undefined }],
          has_more: false,
          cursor: 0,
        },
        message: "",
      },
      expectedInput: { body: { keyword: "business", cursor: 0 } },
      location: "body",
    },
    {
      name: "a failed Weibo realtime parse despite usable post data",
      platform: "weibo",
      type: "post",
      endpoint: "/api/v1/weibo/web_v2/fetch_realtime_search",
      output: {
        parsed_data: {
          results: [WEIBO_SEARCH_POST],
          result_count: 1,
          pagination: {},
          search_stats: {},
          parse_success: false,
        },
      },
      expectedInput: { queryParams: { query: "business", page: 1 } },
      location: "queryParams",
    },
  ] as const)("rejects $name", async (testCase) => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        testCase.endpoint,
        testCase.location === "body"
          ? { keyword: { type: "string" }, cursor: { type: "integer" } }
          : { query: { type: "string" }, page: { type: "integer" } },
        testCase.output,
        testCase.expectedInput,
        { location: testCase.location },
      );
      const job = await execute(setup, {
        platform: testCase.platform,
        operation: "search",
        query: "business",
        type: testCase.type,
        limit: 1,
      });
      expect(job.body).toMatchObject({
        status: "failed",
        error: { code: "SOCIAL_DATA_INVALID_RESULT" },
        data: null,
        billing: { creditsCharged: 0, reservedCredits: 0 },
      });
    });
  });

  it("requires an explicit parent comment only for reply operations", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      for (const body of [
        {
          platform: "douyin",
          operation: "replies",
          url: `https://www.douyin.com/video/${POST}`,
          limit: 10,
        },
        {
          platform: "douyin",
          operation: "comments",
          url: `https://www.douyin.com/video/${POST}`,
          commentId: COMMENT,
          limit: 10,
        },
      ] as const satisfies readonly SocialDataRequest[]) {
        await expect(
          setup.social.quote({ headers: authenticate(setup.actor), body }),
        ).resolves.toMatchObject({ status: 400 });
      }
    });
  });

  it("rejects redirect links and ambiguous Weibo post slugs before quoting", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      for (const body of [
        {
          platform: "douyin",
          operation: "comments",
          url: "https://v.douyin.com/share/",
          limit: 10,
        },
        {
          platform: "weibo",
          operation: "comments",
          url: `https://weibo.com/${UID}/QabcDe123`,
          limit: 10,
        },
      ] as const satisfies readonly SocialDataRequest[]) {
        const rejected = await accept(
          setup.social.quote({ headers: authenticate(setup.actor), body }),
          [422],
        );
        expect(rejected.body).toMatchObject({
          error: { code: "SOCIAL_DATA_UNSUPPORTED" },
        });
      }
    });
  });

  it("retains source failure instead of accepting a plausible successful payload", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid(
        "/api/v1/weibo/web_v2/fetch_post_comments",
        {
          id: { type: "string" },
          count: { type: "integer" },
        },
        {
          code: 200,
          data: {
            data: [
              { idstr: COMMENT, text: "Not a successful source response" },
            ],
          },
        },
        { queryParams: { id: POST, count: 10 } },
        { sourceStatus: 403 },
      );
      const job = await execute(setup, {
        platform: "weibo",
        operation: "comments",
        url: `https://weibo.com/${UID}/${POST}`,
        limit: 10,
      });
      expect(job.body).toMatchObject({
        status: "failed",
        error: { code: "SOCIAL_DATA_SOURCE_ERROR" },
        data: null,
      });
    });
  });

  it("fails closed when a Monid parameter has no declared type", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const executions = monid(
        "/api/v1/weibo/web_v2/fetch_user_info",
        { uid: {} },
        {},
        {},
      );
      const rejected = await accept(
        setup.social.quote({
          headers: authenticate(setup.actor),
          body: {
            platform: "weibo",
            operation: "inspect",
            url: `https://weibo.com/u/${UID}`,
            limit: 1,
          },
        }),
        [422],
      );
      expect(rejected.body).toMatchObject({
        error: { code: "SOCIAL_DATA_UNBOUNDED_PRICE" },
      });
      expect(executions).toHaveLength(0);
    });
  });

  it("rejects newly added operations for old platforms before obtaining a provider quote", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const rejected = await accept(
        setup.social.quote({
          headers: authenticate(setup.actor),
          body: {
            platform: "instagram",
            operation: "followers",
            url: "https://www.instagram.com/example/",
            limit: 10,
          },
        }),
        [422],
      );
      expect(rejected.body).toMatchObject({
        error: { code: "SOCIAL_DATA_UNSUPPORTED" },
      });
    });
  });
});
