import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import {
  GET_STARTED_REWARDS_CHANGED_EVENT,
  cronGetStartedContract,
  getStartedContract,
} from "@okouai/api-contracts/contracts/get-started";
import { http } from "msw";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { getStartedRoutes } from "../get-started";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const client = () => {
  return setupApp({ context, routes: getStartedRoutes })(getStartedContract);
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

function signedInSession(
  userId = `user_${randomUUID()}`,
  orgId = `org_${randomUUID()}`,
  orgRole: "org:admin" | "org:member" = "org:admin",
) {
  const actor = { userId, orgId, orgRole };
  mocks.clerk.session(userId, orgId, orgRole);
  return actor;
}

beforeEach(() => {
  mockEnv("OKOU_SOCIAL_SOCIALKIT_TOKEN", "synthetic-socialkit-token");
  signedInSession(`user_${randomUUID()}`, `org_${randomUUID()}`);
});

test("status never grants; concurrent check-ins and org switches preserve one award and its exact 168-hour expiry", async () => {
  const userId = `user_${randomUUID()}`;
  signedInSession(userId, `org_${randomUUID()}`);
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
  signedInSession(userId, `org_${randomUUID()}`);
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

test("concurrent check-ins across organizations return one personal award and publish credits only in the winning organization", async () => {
  const userId = `user_${randomUUID()}`;
  const orgIds = [`org_${randomUUID()}`, `org_${randomUUID()}`];
  const orgHeaders = orgIds.map((orgId) => {
    return { authorization: `Bearer ${orgId}` };
  });
  context.mocks.clerk.authenticateRequest.mockImplementation((request) => {
    if (!(request instanceof Request)) {
      throw new Error("Expected a Clerk authentication request");
    }
    const orgId = request.headers.get("authorization")?.slice(7);
    if (!orgId || !orgIds.includes(orgId)) {
      throw new Error("Expected a check-in organization token");
    }
    return Promise.resolve({
      isAuthenticated: true,
      toAuth: () => {
        return { userId, orgId, orgRole: "org:admin" };
      },
    });
  });
  mockNow(new Date("2026-09-15T08:00:00.000Z"));

  const results = await Promise.all(
    orgHeaders.flatMap((requestHeaders) => {
      return Array.from({ length: 5 }, () => {
        return accept(client().checkin({ headers: requestHeaders }), [200]);
      });
    }),
  );
  const award = results[0]?.body;
  expect(award).toMatchObject({
    status: "granted",
    rewardAmount: 100,
    rewardTarget: "user",
    grantedAt: "2026-09-15T08:00:00.000Z",
    expiresAt: "2026-09-22T08:00:00.000Z",
  });
  for (const result of results) {
    expect(result.body).toStrictEqual(award);
  }
  for (const requestHeaders of orgHeaders) {
    const current = await accept(
      client().status({ headers: requestHeaders }),
      [200],
    );
    expect(current.body.claimedToday).toBeTruthy();
    expect(
      current.body.quests.find((quest) => {
        return quest.key === "checkin";
      }),
    ).toMatchObject({ claimedCount: 1, earnedCredits: 100 });
  }

  const balances = await Promise.all(
    orgHeaders.map((requestHeaders) => {
      return accept(
        setupApp({ context, routes: billingUsagePackCreditsRoutes })(
          billingUsagePackCreditsContract,
        ).get({ headers: requestHeaders }),
        [200],
      );
    }),
  );
  expect(
    balances
      .map((balance) => {
        return balance.body.bonusCredits;
      })
      .sort((a, b) => {
        return a - b;
      }),
  ).toStrictEqual([0, 100]);
  expect(
    balances.flatMap((balance) => {
      return balance.body.creditGrants;
    }),
  ).toStrictEqual([
    expect.objectContaining({
      grantType: "bonus",
      amount: 100,
      remaining: 100,
      expiresAt: "2026-09-22T08:00:00.000Z",
    }),
  ]);
});

test("x submission returns canonical pending state and deduplicates without calling SocialKit", async () => {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  signedInSession(userId, orgId);
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
});

test("concurrent submissions return the same pending claim to their owner", async () => {
  const id = postId();
  signedInSession();
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
  expect((await status()).shareClaim).toStrictEqual(first.body);
  expect((await personalCredits()).bonusCredits).toBe(0);
});

test("different posts have distinct pending claims across organizations", async () => {
  const firstActor = signedInSession();
  const firstId = postId();
  const first = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${firstId}` },
    }),
    [202],
  );
  const secondActor = signedInSession(firstActor.userId);
  const secondId = postId();
  const second = await accept(
    client().submitShare({
      headers,
      body: { url: `https://x.com/example/status/${secondId}` },
    }),
    [202],
  );
  expect(second.body.id).not.toBe(first.body.id);
  expect(first.body.status).toBe("pending");
  expect(second.body.status).toBe("pending");
  const pending = (await status()).shareClaim;
  expect([first.body.id, second.body.id]).toContain(pending?.id);
  expect(pending?.status).toBe("pending");
  for (const actor of [firstActor, secondActor]) {
    mocks.clerk.session(actor.userId, actor.orgId);
    expect((await status()).shareClaim).toStrictEqual(pending);
    expect((await personalCredits()).bonusCredits).toBe(0);
  }
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

test("a personal check-in bonus is visible without a purchased Usage Pack and disappears exactly at expiry", async () => {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  signedInSession(userId, orgId, "org:member");
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
  mockNow(new Date("2026-09-22T06:30:00.499Z"));
  expect((await credits()).body.bonusCredits).toBe(100);
  mockNow(new Date("2026-09-22T06:30:00.500Z"));
  expect((await credits()).body).toMatchObject({
    bonusCredits: 0,
    totalCredits: 0,
    creditGrants: [],
  });
  expect(
    (await status()).quests.find((q) => {
      return q.key === "checkin";
    })?.claimedCount,
  ).toBe(1);
});
