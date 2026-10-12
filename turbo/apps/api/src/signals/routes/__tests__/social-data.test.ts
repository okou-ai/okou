import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  socialDataContract,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import { HttpResponse, http } from "msw";
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
const COMMENT_REQUEST = {
  platform: "youtube",
  operation: "comments",
  url: "https://www.youtube.com/watch?v=abcdefghijk",
  limit: 2,
} as const satisfies SocialDataRequest;
const INSTAGRAM_POSTS = {
  platform: "instagram",
  operation: "posts",
  url: "https://www.instagram.com/example/",
  limit: 2,
} as const satisfies SocialDataRequest;
function authenticate(actor: ApiTestUser | null) {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}
type SocialActor = Awaited<ReturnType<typeof seedActor>>;
function client() {
  const app = setupApp({ context, routes: ROUTES });
  return app;
}
async function seedActor() {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Social tests require an organization");
  }
  const scenario = createPublicBillingScenario(context);
  scenario.own({ ...actor, orgId: actor.orgId });
  let restoreSetup: (() => void) | undefined;
  scenario.releaseBeforeDrain(() => {
    restoreSetup?.();
  });
  await scenario.run(() => {
    return createRunsApi(context).grantProEntitlement(actor, {
      run: scenario.run,
      onExternalStateReady(restore) {
        restoreSetup = restore;
        scenario.captureExternalState();
      },
    });
  });
  restoreSetup = undefined;
  mockEnv("OKOU_SOCIAL_MONID_API_KEY", "test-social-source-key");
  return { ...actor, orgId: actor.orgId, run: scenario.run };
}
async function credits(actor: SocialActor): Promise<number> {
  const response = await actor.run(() => {
    return accept(
      client()(billingStatusContract).get({
        headers: authenticate(actor),
      }),
      [200],
    );
  });
  return response.body.credits;
}
function source() {
  const observed = { runRequests: 0 };
  server.use(
    http.post("https://api.monid.ai/v1/run", () => {
      observed.runRequests += 1;
      return HttpResponse.json({});
    }),
  );
  return observed;
}

describe("Social data jobs", () => {
  it("requires authentication", async () => {
    const actor = await seedActor();
    await actor.run(async () => {
      const before = await actor.run(() => {
        return credits(actor);
      });
      await actor.run(() => {
        return accept(
          client()(socialDataContract).quote({
            headers: authenticate(null),
            body: COMMENT_REQUEST,
          }),
          [401],
        );
      });
      await actor.run(() => {
        return expect(credits(actor)).resolves.toBe(before);
      });
    });
  });

  it("rejects an Instagram profile request beyond the bounded recent feed", async () => {
    const actor = await seedActor();
    await actor.run(async () => {
      const observed = source();

      const rejected = await actor.run(() => {
        return accept(
          client()(socialDataContract).quote({
            headers: authenticate(actor),
            body: { ...INSTAGRAM_POSTS, limit: 50 },
          }),
          [422],
        );
      });

      expect(rejected.body).toMatchObject({
        error: { code: "SOCIAL_DATA_UNSUPPORTED" },
      });
      expect(observed.runRequests).toBe(0);
    });
  });

  it("rejects an input that would expand into unbounded source searches", async () => {
    const actor = await seedActor();
    await actor.run(async () => {
      const observed = source();
      const before = await actor.run(() => {
        return credits(actor);
      });
      const rejected = await actor.run(() => {
        return accept(
          client()(socialDataContract).quote({
            headers: authenticate(actor),
            body: {
              platform: "facebook",
              operation: "search",
              query: "business software\nteam productivity",
              limit: 2,
            },
          }),
          [422],
        );
      });
      expect(rejected.body.error.code).toBe("SOCIAL_DATA_UNSUPPORTED");
      expect(observed.runRequests).toBe(0);
      await actor.run(() => {
        return expect(credits(actor)).resolves.toBe(before);
      });
    });
  });

  it("rejects unsupported new-platform targets before execution", async () => {
    const actor = await seedActor();
    await actor.run(async () => {
      const observed = source();
      for (const body of [
        {
          platform: "threads",
          operation: "posts",
          url: "https://www.threads.com/@example",
          limit: 10,
        },
        {
          platform: "wechat",
          operation: "inspect",
          url: "https://mp.weixin.qq.com/mp/homepage",
          limit: 1,
        },
      ] as const satisfies readonly SocialDataRequest[]) {
        await actor.run(() => {
          return accept(
            client()(socialDataContract).quote({
              headers: authenticate(actor),
              body,
            }),
            [422],
          );
        });
      }
      expect(observed.runRequests).toBe(0);
    });
  });
});
