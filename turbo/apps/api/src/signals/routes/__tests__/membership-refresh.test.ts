import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { z } from "zod";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { computerUseRoutes } from "../computer-use";
import { orgReadRoutes } from "../org-read";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { signSandboxJwtForTests } from "../../auth/tokens";

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const membershipUrl =
  "https://api.clerk.com/v1/users/:userId/organization_memberships";

beforeEach(async () => {
  // Keep the shared identity/other-service mocks, but exercise the installed
  // SDK's real serialization, transport and error classification for this read.
  const sdk =
    await vi.importActual<typeof import("@clerk/backend")>("@clerk/backend");
  const client = sdk.createClerkClient({
    secretKey: "sk_test_membership_transport",
  });
  const params = z.object({ userId: z.string(), limit: z.number().optional() });
  context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
    (input: unknown) => {
      return client.users.getOrganizationMembershipList(params.parse(input));
    },
  );
  context.mocks.signalTimers.delay.mockResolvedValue(undefined);
});

function membership(actor: ApiTestUser, role = "org:admin") {
  return {
    data: [
      {
        id: `mem_${actor.userId}`,
        object: "organization_membership",
        role,
        created_at: 1,
        updated_at: 1,
        organization: {
          id: actor.orgId,
          object: "organization",
          name: "Membership test",
          slug: null,
          image_url: "",
          has_image: false,
          created_at: 1,
          updated_at: 1,
        },
        public_user_data: { user_id: actor.userId },
      },
    ],
    total_count: 1,
  };
}

function clerkFailure(status: number) {
  return HttpResponse.json(
    {
      errors: [
        {
          code: status === 404 ? "resource_not_found" : "test_failure",
          message: "Clerk test failure",
        },
      ],
    },
    { status },
  );
}

function statusRequest(token: string, signal: AbortSignal = context.signal) {
  // The auth boundary also emits 500/503, which the command contract does not
  // enumerate. Inspect the real HTTP response, as in the AUTH-05 regression.
  return Promise.resolve(
    createAppWithRoutes({ signal, routes: computerUseRoutes }).request(
      `http://api.test/api/computer-use/commands/${randomUUID()}`,
      { headers: { authorization: `Bearer ${token}` } },
    ),
  );
}

function agentToken(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected test actor to have an org");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: actor.userId,
    orgId: actor.orgId,
    runId: randomUUID(),
    computerUseHostId: randomUUID(),
    capabilities: ["computer-use:write"],
    iat: seconds,
    exp: seconds + 3600,
  });
}

async function credentials() {
  const actor = api.user();
  const pat = await api.createCliToken(actor);
  return { actor, pat: pat.token, agent: agentToken(actor) };
}

describe("membership refresh through public PAT and Agent requests", () => {
  it("authenticates simultaneous PAT and Agent requests on a cold cache", async () => {
    const { actor, pat, agent } = await credentials();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(membershipUrl, async () => {
        if (!started.settled()) {
          started.resolve();
        }
        await release.promise;
        return HttpResponse.json(membership(actor));
      }),
    );
    const pending = Array.from({ length: 16 }, (_, i) => {
      return statusRequest(i % 2 ? pat : agent);
    });
    await started.promise;
    release.resolve();
    const responses = await Promise.all(pending);
    expect(
      responses.map((response) => {
        return response.status;
      }),
    ).toStrictEqual(
      Array.from({ length: 16 }, () => {
        return 404;
      }),
    );
    await accept(statusRequest(pat), [404]);
  });

  it("preserves the positive expiry across hits, demotion and revocation", async () => {
    const { actor, pat, agent } = await credentials();
    const base = now();
    mockNow(base);
    let role: string | null = "org:admin";
    let reads = 0;
    server.use(
      http.get(membershipUrl, () => {
        reads += 1;
        return HttpResponse.json(
          role ? membership(actor, role) : { data: [], total_count: 0 },
        );
      }),
    );
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      name: "Membership test",
    });
    const readOrg = () => {
      return setupApp({ context, routes: orgReadRoutes })(orgContract).get({
        headers: { authorization: `Bearer ${pat}` },
      });
    };
    expect((await accept(readOrg(), [200])).body.role).toBe("admin");
    role = "org:member";
    mockNow(base + 59_999);
    expect((await accept(readOrg(), [200])).body.role).toBe("admin");
    expect(reads).toBe(1);
    mockNow(base + 60_000);
    expect((await accept(readOrg(), [200])).body.role).toBe("member");
    expect(reads).toBe(2);
    role = null;
    mockNow(base + 120_000);
    await accept(statusRequest(agent), [401]);
    expect(reads).toBe(3);
    const degraded = await api.requestReadMeWithBearer(pat, actor, [200]);
    expect(degraded.body).toMatchObject({ userId: actor.userId, orgId: null });
  });

  it.each([429, 503, "transport"] as const)(
    "fails closed on %s and preserves provider recovery",
    async (failure) => {
      const { actor, pat, agent } = await credentials();
      let recovered = false;
      let reads = 0;
      server.use(
        http.get(membershipUrl, () => {
          reads += 1;
          if (recovered) {
            return HttpResponse.json(membership(actor));
          }
          return failure === "transport"
            ? HttpResponse.error()
            : clerkFailure(failure);
        }),
      );
      const failed = await statusRequest(pat);
      // MSW's network error is "Failed to fetch", not the gateway's narrowly
      // retryable Node "fetch failed" signature; it must remain unclassified.
      expect(failed.status).toBe(failure === 503 ? 503 : 500);
      expect(reads).toBe(failure === 503 ? 3 : 1);
      if (failure === 503) {
        expect(failed.headers.get("Cache-Control")).toBe("no-store");
      }
      const failedReads = reads;
      recovered = true;
      await accept(statusRequest(agent), [404]);
      expect(reads).toBe(failedReads + 1);
    },
  );

  it("checks membership for the requested user and organization", async () => {
    const actor = api.user();
    const otherOrg = api.user({ userId: actor.userId });
    const otherUser = api.user({ orgId: actor.orgId });
    const seen: string[] = [];
    server.use(
      http.get(membershipUrl, ({ params }) => {
        seen.push(String(params.userId));
        return HttpResponse.json(
          membership(params.userId === otherUser.userId ? otherUser : otherOrg),
        );
      }),
    );
    await accept(statusRequest(agentToken(actor)), [401]);
    await accept(statusRequest(agentToken(otherOrg)), [404]);
    await accept(statusRequest(agentToken(otherUser)), [404]);
    expect(seen).toStrictEqual([
      actor.userId,
      otherOrg.userId,
      otherUser.userId,
    ]);
  });

  it("keeps surviving callers alive when the first caller cancels", async () => {
    const { actor, agent } = await credentials();
    const controller = new AbortController();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(membershipUrl, async () => {
        if (!started.settled()) {
          started.resolve();
        }
        await release.promise;
        return HttpResponse.json(membership(actor));
      }),
    );
    const cancelled = statusRequest(agent, controller.signal);
    const survivors = Array.from({ length: 8 }, () => {
      return statusRequest(agent);
    });
    await started.promise;
    controller.abort();
    expect((await cancelled).status).toBe(500);
    release.resolve();
    for (const survivor of await Promise.all(survivors)) {
      expect(survivor.status).toBe(404);
    }
  });

  it("ignores a late Clerk result after caller cancellation", async () => {
    const { actor, agent } = await credentials();
    const controller = new AbortController();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const late = createDeferredPromise<void>(context.signal);
    let reads = 0;
    server.use(
      http.get(membershipUrl, async () => {
        reads += 1;
        if (reads === 1) {
          started.resolve();
          await release.promise;
          late.resolve();
          return clerkFailure(404);
        }
        return HttpResponse.json(membership(actor));
      }),
    );
    const cancelled = statusRequest(agent, controller.signal);
    await started.promise;
    controller.abort();
    expect((await cancelled).status).toBe(500);
    await accept(statusRequest(agent), [404]);
    release.resolve();
    await late.promise;
    await accept(statusRequest(agent), [404]);
    expect(reads).toBe(2);
  });
});
