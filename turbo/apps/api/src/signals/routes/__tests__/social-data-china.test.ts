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
          items: [{ parentId: COMMENT, authorId: UID }],
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
          code: 200,
          data: {
            status_code: 0,
            cursor: 20,
            has_more: 1,
            user_list: [
              { user_info: { uid: UID, sec_uid: SEC_UID, nickname: "Result" } },
            ],
          },
        },
        { body: { keyword: "business", cursor: 0 } },
        { location: "body" },
      );
      const job = await execute(setup, {
        platform: "douyin",
        operation: "search",
        query: "business",
        type: "account",
        limit: 10,
      });
      expect(job.body).toMatchObject({
        status: "completed",
        data: {
          items: [{ id: UID, url: `https://www.douyin.com/user/${SEC_UID}` }],
        },
      });
      expect(executions).toHaveLength(1);
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
          code: 200,
          data: {
            cards: [
              {
                card_type: 9,
                mblog: {
                  idstr: POST,
                  id: Number(POST),
                  text_raw: "Latest public result",
                  user: { idstr: UID, id: Number(UID), screen_name: "Author" },
                },
              },
            ],
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
              id: POST,
              authorId: UID,
              authorUrl: `https://weibo.com/u/${UID}`,
              text: "Latest public result",
            },
          ],
          pagination: { hasMore: null },
        },
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
