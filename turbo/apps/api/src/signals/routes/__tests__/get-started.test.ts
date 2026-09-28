import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { testUsageSettlementContract } from "@okouai/api-contracts/contracts/test-usage-settlement";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { testUsageSettlementRoutes } from "../test-usage-settlement";
import { randomUUID } from "node:crypto";
import {
  GET_STARTED_REWARDS_CHANGED_EVENT,
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
import { setGetStartedEnabled } from "./helpers/get-started";

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
const personalCredits = async () => {
  return (
    await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers }),
      [200],
    )
  ).body;
};
const postId = () => {
  return BigInt(
    `0x${randomUUID().replaceAll("-", "").slice(0, 15)}`,
  ).toString();
};

async function enabledSession(
  userId = `user_${randomUUID()}`,
  orgId = `org_${randomUUID()}`,
  orgRole: "org:admin" | "org:member" = "org:admin",
) {
  const actor = { userId, orgId, orgRole };
  await setGetStartedEnabled(context, actor);
  return actor;
}

beforeEach(async () => {
  mockEnv("OKOU_SOCIAL_SOCIALKIT_TOKEN", "synthetic-socialkit-token");
  await enabledSession(`user_${randomUUID()}`, `org_${randomUUID()}`);
});

/** A fresh author per post by default: share rewards are unique per X author. */
function authorHandle() {
  return `a${randomUUID().replaceAll("-", "").slice(0, 14)}`;
}

function postResponse(
  id: string,
  text: string,
  profileUrl = `https://x.com/${authorHandle()}`,
) {
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
          profileUrl,
        },
        hashtags: [],
        urls: [],
      },
    },
  });
}

function provider(
  id: string,
  text: string,
  profileUrl = `https://x.com/${authorHandle()}`,
) {
  server.use(
    http.get("https://api.socialkit.dev/twitter/tweet", () => {
      return postResponse(id, text, profileUrl);
    }),
  );
}

test("status never grants; concurrent check-ins and org switches preserve one award and its exact 168-hour expiry", async () => {
  const userId = `user_${randomUUID()}`;
  await enabledSession(userId, `org_${randomUUID()}`);
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
  const balance = await accept(
    setupApp({ context, routes: billingUsagePackCreditsRoutes })(
      billingUsagePackCreditsContract,
    ).get({ headers }),
    [200],
  );
  expect(balance.body.bonusCredits).toBe(100);
  expect(balance.body.creditGrants).toStrictEqual([
    expect.objectContaining({
      grantType: "bonus",
      amount: 100,
      remaining: 100,
      expiresAt: "2026-09-22T23:59:59.123Z",
    }),
  ]);
  await enabledSession(userId, `org_${randomUUID()}`);
  expect(
    (await accept(client().checkin({ headers }), [200])).body,
  ).toStrictEqual(first);
  await expect(status()).resolves.toMatchObject({
    claimedToday: true,
    nextResetAt: "2026-09-16T00:00:00.000Z",
    checkinStreak: 1,
  });
  mockNow(new Date("2026-09-16T00:00:00.000Z"));
  // A new UTC day has started and nothing is claimed in it yet, so the streak
  // is still alive on yesterday rather than broken back to zero.
  await expect(status()).resolves.toMatchObject({
    claimedToday: false,
    checkinStreak: 1,
  });
  expect((await accept(client().checkin({ headers }), [200])).body.id).not.toBe(
    first?.id,
  );
  expect(
    (await status()).quests.find((q) => {
      return q.key === "checkin";
    })?.claimedCount,
  ).toBe(2);
  expect((await status()).checkinStreak).toBe(2);
});

test("the shared getStartedQuests switch gates API rewards and supports the same persisted overrides", async () => {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(actor.userId, actor.orgId);
  await expect(client().status({ headers })).resolves.toMatchObject({
    status: 403,
  });
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
  await setGetStartedEnabled(context, actor);
  await expect(client().status({ headers })).resolves.toMatchObject({
    status: 200,
  });
  await expect(client().checkin({ headers })).resolves.toMatchObject({
    status: 200,
    body: { status: "granted" },
  });
  await setGetStartedEnabled(context, actor, false);
  await expect(client().checkin({ headers })).resolves.toMatchObject({
    status: 403,
  });

  const staff = {
    userId: `user_${randomUUID()}`,
    orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
  };
  mocks.clerk.session(staff.userId, staff.orgId);
  // The shared staff identity is read-only; credit writes use unique orgs above.
  await expect(client().status({ headers })).resolves.toMatchObject({
    status: 200,
  });
});

test("x submission returns persisted pending state without calling SocialKit; review starts the 7-day lifetime", async () => {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  await enabledSession(userId, orgId);
  const id = postId();
  let providerCalls = 0;
  server.use(
    http.get("https://api.socialkit.dev/twitter/tweet", () => {
      providerCalls++;
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
    // The post travels back with the claim: a user waiting on review has no
    // other way to see which link is in the queue. It is the canonical form
    // the submit route stored, not the one that was pasted -- the handle and
    // the tracking parameter are dropped on the way in.
    postUrl: `https://x.com/i/status/${id}`,
  });
  expect((await status()).shareClaim).toStrictEqual(submitted.body);
  expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
    GET_STARTED_REWARDS_CHANGED_EVENT,
    null,
  );
  expect(providerCalls).toBe(0);
  await setGetStartedEnabled(context, { userId, orgId }, false);
  await review([submitted.body.id]);
  expect(providerCalls).toBe(0);
  await setGetStartedEnabled(context, { userId, orgId });
  expect((await status()).shareClaim).toMatchObject({
    status: "pending",
    reason: "feature_disabled",
    grantedAt: null,
  });
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
  expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(`user:${userId}`);
  expect(context.mocks.ably.channelGet).not.toHaveBeenCalledWith(
    `org:${orgId}`,
  );
  expect(context.mocks.ably.publish).toHaveBeenCalledWith(
    GET_STARTED_REWARDS_CHANGED_EVENT,
    null,
  );
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
  expect(context.mocks.ably.publish).toHaveBeenCalledWith(
    GET_STARTED_REWARDS_CHANGED_EVENT,
    null,
  );
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

test("a realtime delivery failure leaves the reviewed reward committed and spendable", async () => {
  const id = postId();
  const submitted = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${id}` },
    }),
    [202],
  );
  provider(id, "Okou helps my team");
  context.mocks.ably.publish.mockRejectedValue(new Error("Ably unavailable"));
  await review([submitted.body.id]);
  expect((await status()).shareClaim?.status).toBe("granted");
  const balance = await accept(
    setupApp({ context, routes: billingUsagePackCreditsRoutes })(
      billingUsagePackCreditsContract,
    ).get({ headers }),
    [200],
  );
  expect(balance.body.bonusCredits).toBe(2000);
});

test("concurrent claims reserve a post once globally, including after the bonus expires", async () => {
  const id = postId();
  const firstActor = await enabledSession();
  const submissions = await Promise.all(
    Array.from({ length: 2 }, () => {
      return accept(
        client().submitShare({
          headers,
          body: { url: `https://x.com/example/status/${id}` },
        }),
        [202],
      );
    }),
  );
  const first = submissions[0];
  if (!first) {
    throw new Error("Missing submitted claim");
  }
  expect(submissions[1]?.body.id).toBe(first.body.id);
  const secondActor = await enabledSession();
  const second = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${id}` },
    }),
    [202],
  );
  provider(id, "Okou is useful");
  await Promise.all([
    review([first.body.id]),
    review([second.body.id]),
    review([first.body.id]),
  ]);
  const outcomes = [];
  for (const actor of [firstActor, secondActor]) {
    mocks.clerk.session(actor.userId, actor.orgId);
    const share = (await status()).shareClaim;
    if (!share) {
      throw new Error("Missing share claim");
    }
    outcomes.push(share.status === "granted" ? "granted" : "declined");
    const balance = await personalCredits();
    if (share.status === "granted") {
      expect(balance.bonusCredits).toBe(2000);
      expect(balance.creditGrants).toHaveLength(1);
    } else {
      // The review sees the author's grant first, or loses the race to the
      // unique reward key; either way nothing is granted twice.
      expect([
        "ineligible:already_redeemed",
        "rejected:author_already_rewarded",
      ]).toContain(`${share.status}:${share.reason}`);
      expect(balance.bonusCredits).toBe(0);
      expect(balance.creditGrants).toStrictEqual([]);
    }
  }
  expect(outcomes.sort()).toStrictEqual(["declined", "granted"]);
  mockNow(new Date("2027-01-01T00:00:00Z"));
  await enabledSession(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const late = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${id}` },
    }),
    [202],
  );
  await review([late.body.id]);
  expect((await status()).shareClaim).toMatchObject({
    status: "rejected",
    reason: "author_already_rewarded",
  });
});

test("different posts reviewed concurrently share one personal reward across organizations", async () => {
  const firstActor = await enabledSession();
  const firstId = postId();
  const first = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${firstId}` },
    }),
    [202],
  );
  const secondActor = await enabledSession(firstActor.userId);
  const secondId = postId();
  const second = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${secondId}` },
    }),
    [202],
  );
  expect(second.body.id).not.toBe(first.body.id);
  server.use(
    http.get("https://api.socialkit.dev/twitter/tweet", ({ request }) => {
      const url = new URL(request.url).searchParams.get("url");
      const id = [firstId, secondId].find((candidate) => {
        return url === `https://x.com/i/status/${candidate}`;
      });
      if (!id) {
        throw new Error("Unexpected post verification URL");
      }
      return postResponse(id, "Okou helps my team");
    }),
  );

  await Promise.all([review([first.body.id]), review([second.body.id])]);

  const balances = [];
  for (const actor of [firstActor, secondActor]) {
    mocks.clerk.session(actor.userId, actor.orgId);
    expect((await status()).quests).toContainEqual(
      expect.objectContaining({
        key: "share",
        claimedCount: 1,
        earnedCredits: 2000,
        pendingCount: 0,
        canEarnMore: false,
      }),
    );
    balances.push(await personalCredits());
  }
  expect(
    balances.reduce((total, balance) => {
      return total + balance.bonusCredits;
    }, 0),
  ).toBe(2000);
  expect(
    balances.flatMap((balance) => {
      return balance.creditGrants;
    }),
  ).toHaveLength(1);
});

/** Submit a post as a fresh user and review it with the given provider evidence. */
async function reviewedShare(text: string, profileUrl?: string) {
  await enabledSession();
  const id = postId();
  const submitted = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${id}` },
    }),
    [202],
  );
  provider(id, text, profileUrl);
  await review([submitted.body.id]);
  return {
    share: (await status()).shareClaim,
    bonusCredits: (await personalCredits()).bonusCredits,
  };
}

test("a post by an official Okou account is rejected, not retried", async () => {
  for (const profileUrl of [
    "https://x.com/okou_ai",
    "https://twitter.com/Okou_AI/",
  ]) {
    await expect(
      reviewedShare("Okou ships scheduled workflows today", profileUrl),
    ).resolves.toStrictEqual({
      share: expect.objectContaining({
        status: "rejected",
        reason: "post_by_official_account",
      }),
      bonusCredits: 0,
    });
  }
});

test("a post whose author cannot be identified is rejected", async () => {
  for (const profileUrl of [
    "",
    "https://example.com/someone",
    "https://x.com/i/web",
  ]) {
    await expect(
      reviewedShare("Okou is great", profileUrl),
    ).resolves.toStrictEqual({
      share: expect.objectContaining({
        status: "rejected",
        reason: "post_author_unavailable",
      }),
      bonusCredits: 0,
    });
  }
});

test("an X author earns the share reward once, even for a different post and claimant", async () => {
  const handle = authorHandle();
  await expect(
    reviewedShare("Okou saved me an hour", `https://x.com/${handle}`),
  ).resolves.toMatchObject({
    share: { status: "granted" },
    bonusCredits: 2000,
  });
  await expect(
    reviewedShare(
      "Okou again, from the same account",
      `https://twitter.com/${handle.toUpperCase()}`,
    ),
  ).resolves.toStrictEqual({
    share: expect.objectContaining({
      status: "rejected",
      reason: "author_already_rewarded",
    }),
    bonusCredits: 0,
  });
});

test("the mention check accepts handles, hashtags and possessives but not a longer word", async () => {
  for (const text of [
    "Loving @okou_ai for my inbox",
    "#okou changed my week",
    "Okou's scheduler is neat",
    "我在用Okou整理邮件",
  ]) {
    await expect(reviewedShare(text)).resolves.toMatchObject({
      share: { status: "granted" },
      bonusCredits: 2000,
    });
  }
  await expect(reviewedShare("Dinner at tokou tonight")).resolves.toMatchObject(
    {
      share: { status: "rejected", reason: "post_must_mention_okou" },
      bonusCredits: 0,
    },
  );
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
  await enabledSession(userId, orgId, "org:member");
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
