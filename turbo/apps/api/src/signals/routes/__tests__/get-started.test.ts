import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { testUsageSettlementContract } from "@okouai/api-contracts/contracts/test-usage-settlement";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { testUsageSettlementRoutes } from "../test-usage-settlement";
import { randomUUID } from "node:crypto";
import {
  cronGetStartedContract,
  getStartedContract,
} from "@okouai/api-contracts/contracts/get-started";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { getStartedRoutes } from "../get-started";
import {
  scopedReviewContract,
  scopedReviewRoutes,
} from "../test-get-started-rewards";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const client = () => {
  return setupApp({ context, routes: getStartedRoutes })(getStartedContract);
};
const review = (claimIds: string[]) => {
  return accept(
    setupApp({ context, routes: scopedReviewRoutes })(
      scopedReviewContract,
    ).process({ body: { claimIds } }),
    [200],
  );
};
const status = async () => {
  return (await accept(client().status({ headers }), [200])).body;
};
const postId = () => {
  return BigInt(
    `0x${randomUUID().replaceAll("-", "").slice(0, 15)}`,
  ).toString();
};

beforeEach(() => {
  mockEnv("GET_STARTED_REWARDS_ROLLOUT", "all");
  mockEnv("OKOU_SOCIAL_SOCIALKIT_TOKEN", "synthetic-socialkit-token");
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
});

function provider(id: string, text: string) {
  server.use(
    http.get("https://api.socialkit.dev/twitter/tweet", () => {
      return HttpResponse.json({
        success: true,
        data: {
          tweet: {
            id,
            text,
            likes: 0,
            retweets: 0,
            replies: 0,
            views: 0,
            createdAt: "2026-09-15T00:00:00Z",
            author: {
              name: "Example",
              headline: "",
              profileUrl: "https://x.com/example",
            },
            hashtags: [],
            urls: [],
          },
        },
      });
    }),
  );
}

test("status never grants; concurrent check-ins and org switches preserve one award and its exact 168-hour expiry", async () => {
  const userId = `user_${randomUUID()}`;
  mocks.clerk.session(userId, `org_${randomUUID()}`);
  mockNow(new Date("2026-09-15T23:59:59.123Z"));
  expect((await status()).claimedToday).toBeFalsy();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => {
      return accept(client().checkin({ headers }), [200]);
    }),
  );
  const first = results[0]?.body;
  expect(first).toMatchObject({
    status: "granted",
    rewardAmount: 100,
    rewardTarget: "user",
    grantedAt: "2026-09-15T23:59:59.123Z",
    expiresAt: "2026-09-22T23:59:59.123Z",
  });
  expect(
    new Set(
      results.map((result) => {
        return result.body.id;
      }),
    ).size,
  ).toBe(1);
  mocks.clerk.session(userId, `org_${randomUUID()}`);
  expect(
    (await accept(client().checkin({ headers }), [200])).body,
  ).toStrictEqual(first);
  await expect(status()).resolves.toMatchObject({
    claimedToday: true,
    nextResetAt: "2026-09-16T00:00:00.000Z",
  });
  mockNow(new Date("2026-09-16T00:00:00.000Z"));
  expect((await status()).claimedToday).toBeFalsy();
  expect((await accept(client().checkin({ headers }), [200])).body.id).not.toBe(
    first?.id,
  );
  expect(
    (await status()).quests.find((q) => {
      return q.key === "checkin";
    })?.claimedCount,
  ).toBe(2);
});

test("the server rollout rejects rewards for authenticated non-staff users when disabled", async () => {
  mockEnv("GET_STARTED_REWARDS_ROLLOUT", "off");
  await expect(client().checkin({ headers })).resolves.toMatchObject({
    status: 403,
  });
  await accept(
    client().submitShare({
      headers,
      body: { url: "https://x.com/example/status/123" },
    }),
    [403],
  );
  mockEnv("GET_STARTED_REWARDS_ROLLOUT", "staff");
  await expect(client().status({ headers })).resolves.toMatchObject({
    status: 403,
  });
  mocks.clerk.session(
    `user_${randomUUID()}`,
    "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
  );
  await expect(client().checkin({ headers })).resolves.toMatchObject({
    status: 200,
    body: { status: "granted" },
  });
});

test("x submission returns persisted pending state without calling SocialKit; review starts the 7-day lifetime", async () => {
  const id = postId();
  server.use(
    http.get("https://api.socialkit.dev/twitter/tweet", () => {
      throw new Error("Submission must not call the provider");
    }),
  );
  mockNow(new Date("2026-09-15T08:00:00.000Z"));
  const submitted = await accept(
    client().submitShare({
      headers,
      body: { url: `https://twitter.com/example/status/${id}?s=20` },
    }),
    [202],
  );
  expect(submitted.body).toMatchObject({
    status: "pending",
    grantedAt: null,
    expiresAt: null,
  });
  expect((await status()).shareClaim).toStrictEqual(submitted.body);
  mockEnv("GET_STARTED_REWARDS_ROLLOUT", "off");
  expect((await review([submitted.body.id])).body.processed).toBe(0);
  mockEnv("GET_STARTED_REWARDS_ROLLOUT", "all");
  expect(
    (
      await accept(
        client().submitShare({
          headers,
          body: { url: `https://x.com/another/status/${id}` },
        }),
        [202],
      )
    ).body.id,
  ).toBe(submitted.body.id);
  mockNow(new Date("2026-09-16T09:00:00.000Z"));
  provider(id, "Okou saved me time today");
  await Promise.all([review([submitted.body.id]), review([submitted.body.id])]);
  expect((await status()).shareClaim).toMatchObject({
    status: "granted",
    rewardAmount: 2000,
    grantedAt: "2026-09-16T09:00:00.000Z",
    expiresAt: "2026-09-23T09:00:00.000Z",
  });
  expect(
    (await status()).quests.find((q) => {
      return q.key === "share";
    })?.claimedCount,
  ).toBe(1);
});

test("an interrupted review is reclaimed after its lease without duplicating a grant", async () => {
  mockNow(new Date("2026-09-15T08:00:00.000Z"));
  const id = postId();
  const submitted = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${id}` },
    }),
    [202],
  );
  const controller = new AbortController();
  const reason = new DOMException("Review worker interrupted", "AbortError");
  server.use(
    http.get("https://api.socialkit.dev/twitter/tweet", () => {
      controller.abort(reason);
      return HttpResponse.error();
    }),
  );
  await expect(
    setupApp({
      context,
      routes: scopedReviewRoutes,
      signal: controller.signal,
      rethrowErrors: true,
    })(scopedReviewContract).process({
      body: { claimIds: [submitted.body.id] },
    }),
  ).rejects.toThrow("Review worker interrupted");
  expect((await status()).shareClaim?.status).toBe("reviewing");
  expect((await review([submitted.body.id])).body.processed).toBe(0);
  mockNow(new Date("2026-09-15T08:01:01.000Z"));
  provider(id, "Okou saved me time");
  await review([submitted.body.id]);
  const granted = (await status()).shareClaim;
  expect(granted).toMatchObject({
    status: "granted",
    grantedAt: "2026-09-15T08:01:01.000Z",
    expiresAt: "2026-09-22T08:01:01.000Z",
  });
  await review([submitted.body.id]);
  expect((await status()).shareClaim).toStrictEqual(granted);
});

test("transient or mismatched provider evidence stays retryable, definite rejection allows another post", async () => {
  mockNow(new Date("2026-09-15T10:00:00.000Z"));
  const id = postId();
  const submitted = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${id}` },
    }),
    [202],
  );
  server.use(
    http.get("https://api.socialkit.dev/twitter/tweet", () => {
      return new HttpResponse(null, { status: 429 });
    }),
  );
  await review([submitted.body.id]);
  expect((await status()).shareClaim?.status).toBe("pending");
  mockNow(new Date("2026-09-15T11:00:00.000Z"));
  provider(postId(), "Okou");
  await review([submitted.body.id]);
  expect((await status()).shareClaim).toMatchObject({
    status: "pending",
    reason: "post_id_mismatch",
  });
  mockNow(new Date("2026-09-15T12:00:00.000Z"));
  provider(id, "An unrelated post");
  await review([submitted.body.id]);
  expect((await status()).shareClaim).toMatchObject({
    status: "rejected",
    reason: "post_must_mention_okou",
  });
  const secondId = postId();
  const replacement = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${secondId}` },
    }),
    [202],
  );
  provider(secondId, "Try @Okou today");
  await review([replacement.body.id]);
  expect((await status()).shareClaim?.status).toBe("granted");
});

test("only a successful award reserves a post globally, including after the bonus expires", async () => {
  const id = postId();
  const first = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${id}` },
    }),
    [202],
  );
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const second = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${id}` },
    }),
    [202],
  );
  provider(id, "Okou is useful");
  await review([second.body.id]);
  await review([first.body.id]);
  expect((await status()).shareClaim?.status).toBe("granted");
  mockNow(new Date("2027-01-01T00:00:00Z"));
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  expect(
    (
      await accept(
        client().submitShare({
          headers,
          body: { url: `https://x.com/example/status/${id}` },
        }),
        [202],
      )
    ).body,
  ).toMatchObject({ status: "ineligible", reason: "already_redeemed" });
});

test("invalid URLs and missing cron authorization are rejected", async () => {
  for (const url of [
    "https://example.com/status/123",
    "https://x.com@evil.example/status/123",
    "https://x.com/example/status/1e20",
    "http://x.com/example/status/123",
  ]) {
    await expect(
      client().submitShare({ headers, body: { url } }),
    ).resolves.toMatchObject({ status: 400 });
  }
  await accept(
    setupApp({ context, routes: getStartedRoutes })(
      cronGetStartedContract,
    ).process({ headers: {} }),
    [401],
  );
});

test("a personal bonus is spendable without a purchased Usage Pack and disappears exactly at expiry", async () => {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId, "org:member");
  const settlement = setupApp({ context, routes: testUsageSettlementRoutes })(
    testUsageSettlementContract,
  );
  await accept(
    settlement.setup({ body: { org_id: orgId, credits: 0 } }),
    [200],
  );
  const admission = () => {
    return Promise.all(
      (["run", "managed-media"] as const).map(async (kind) => {
        return (
          await accept(
            settlement.admission({
              body: { org_id: orgId, user_id: userId, kind },
            }),
            [200],
          )
        ).body.allowed;
      }),
    );
  };
  mockNow(new Date("2026-09-15T06:30:00.500Z"));
  await accept(client().checkin({ headers }), [200]);
  const credits = () => {
    return accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers }),
      [200],
    );
  };
  expect((await credits()).body).toMatchObject({
    hasUsagePack: false,
    purchasedCredits: 0,
    bonusCredits: 100,
    totalCredits: 100,
  });
  await expect(admission()).resolves.toStrictEqual([true, true]);
  mockNow(new Date("2026-09-22T06:30:00.499Z"));
  expect((await credits()).body.bonusCredits).toBe(100);
  mockNow(new Date("2026-09-22T06:30:00.500Z"));
  expect((await credits()).body).toMatchObject({
    bonusCredits: 0,
    totalCredits: 0,
    creditGrants: [],
  });
  await expect(admission()).resolves.toStrictEqual([false, false]);
  expect(
    (await status()).quests.find((q) => {
      return q.key === "checkin";
    })?.claimedCount,
  ).toBe(1);
});
