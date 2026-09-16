import { randomUUID } from "node:crypto";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { testUsageStateContract } from "@okouai/api-contracts/contracts/test-usage-state";
import { usageMembersContract } from "@okouai/api-contracts/contracts/usage";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settle } from "../../utils";
import { authMeRoutes } from "../auth-me";
import { orgReadRoutes } from "../org-read";
import { orgMembersRoutes } from "../org-members";
import { testUsageStateRoutes } from "../test-usage-state";
import { usageMembersRoutes } from "../usage-members";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function userResponse(id: string, email = `${id}@example.test`) {
  return {
    object: "user",
    id,
    email_addresses: [{ id: `email_${id}`, email_address: email }],
    primary_email_address_id: `email_${id}`,
    first_name: "Test",
    last_name: "User",
    username: null,
    image_url: "https://example.test/avatar.png",
    private_metadata: {},
  };
}

function observeUserRequests(
  read: (request: Request) => Response | Promise<Response>,
) {
  const requests: URL[] = [];
  server.use(
    http.get("https://api.clerk.com/v1/users*", ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      if (url.pathname === "/v1/users/count") {
        return HttpResponse.json({ object: "total_count", total_count: 1 });
      }
      return read(request);
    }),
  );
  return requests;
}

function profileClient() {
  const userId = `user_${randomUUID()}`;
  mocks.clerk.session(userId, null);
  const client = setupApp({ context, routes: authMeRoutes })(authContract);
  return {
    userId,
    read: () => {
      return client.me({ headers });
    },
  };
}

function organizationClient() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId, "org:admin");
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ role: "org:admin", organization: { id: orgId } }],
  });
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: orgId,
    name: "User read test",
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [{ role: "org:admin", publicUserData: { userId } }],
    },
  );
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
    { data: [] },
  );
  server.use(
    http.get(
      `https://api.clerk.com/v1/organizations/${orgId}/membership_requests`,
      () => {
        return HttpResponse.json({ data: [] });
      },
    ),
  );
  const client = setupApp({
    context,
    routes: [...orgReadRoutes, ...orgMembersRoutes],
  })(orgMembersContract);
  return { userId, orgId, client };
}

describe("Clerk user reads at the HTTP boundary", () => {
  it("fills the signed-in profile with one user request and no count request", async () => {
    const profile = profileClient();
    const requests = observeUserRequests((request) => {
      expect(request.headers.get("Authorization")).toBe(
        "Bearer sk_test_dummy_for_unit_tests",
      );
      return HttpResponse.json([userResponse(profile.userId)]);
    });

    const response = await accept(profile.read(), [200]);
    expect(response.body).toStrictEqual({
      userId: profile.userId,
      email: `${profile.userId}@example.test`,
      orgId: null,
    });
    await accept(profile.read(), [200]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/users");
    expect(requests[0]?.searchParams.getAll("user_id")).toStrictEqual([
      profile.userId,
    ]);
  });

  it("preserves an empty email lookup as a missing member without a count", async () => {
    const { client } = organizationClient();
    const email = `missing+${randomUUID()}@example.test`;
    const requests = observeUserRequests(() => {
      return HttpResponse.json([]);
    });

    const response = await accept(
      client.removeMember({ headers, body: { email } }),
      [404],
    );
    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.getAll("email_address")).toStrictEqual([
      email,
    ]);
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("continues profile batches after a deleted ID and includes the last member", async () => {
    const admin = organizationClient();
    const members = [
      admin,
      ...Array.from({ length: 100 }, () => {
        return {
          userId: `user_${randomUUID()}`,
        };
      }),
    ];
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      (params) => {
        const { offset } = z
          .object({ offset: z.number().default(0) })
          .parse(params);
        return Promise.resolve({
          data: members.slice(offset, offset + 100).map((member) => {
            return {
              role: "org:member",
              publicUserData: { userId: member.userId },
              createdAt: Date.parse("2026-01-01T00:00:00Z"),
            };
          }),
        });
      },
    );
    const deletedId = members[1]?.userId;
    const requests = observeUserRequests((request) => {
      const ids = new URL(request.url).searchParams.getAll("user_id");
      return HttpResponse.json(
        ids
          .filter((id) => {
            return id !== deletedId;
          })
          .map((id) => {
            return userResponse(id);
          }),
      );
    });

    const response = await accept(admin.client.members({ headers }), [200]);
    expect(response.body.members).toHaveLength(101);
    expect(response.body.members).toContainEqual(
      expect.objectContaining({ userId: deletedId, email: "" }),
    );
    const lastMember = members[100];
    expect(response.body.members).toContainEqual(
      expect.objectContaining({
        userId: lastMember?.userId,
        email: `${lastMember?.userId}@example.test`,
      }),
    );
    expect(
      requests.map((url) => {
        return url.pathname;
      }),
    ).toStrictEqual(["/v1/users", "/v1/users"]);
    expect(
      requests.map((url) => {
        return url.searchParams.getAll("user_id").length;
      }),
    ).toStrictEqual([100, 1]);
    expect(
      requests.map((url) => {
        return url.searchParams.get("limit");
      }),
    ).toStrictEqual(["100", "100"]);
  });

  it("surfaces a user-list 429 immediately with Retry-After", async () => {
    const { client } = organizationClient();
    const requests = observeUserRequests(() => {
      return HttpResponse.json(
        {
          errors: [
            { code: "rate_limit_exceeded", message: "Too many requests" },
          ],
        },
        { status: 429, headers: { "Retry-After": "7" } },
      );
    });

    const response = await accept(client.members({ headers }), [503]);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(
      requests.map((url) => {
        return url.pathname;
      }),
    ).toStrictEqual(["/v1/users"]);
  });

  it.each(["5xx", "transport"])(
    "recovers a %s failure without repeating a count request",
    async (failure) => {
      const profile = profileClient();
      context.mocks.signalTimers.delay.mockResolvedValue(undefined);
      let attempts = 0;
      const requests = observeUserRequests(() => {
        attempts += 1;
        if (attempts === 1) {
          return failure === "5xx"
            ? HttpResponse.text("Unavailable", { status: 503 })
            : HttpResponse.error();
        }
        return HttpResponse.json([userResponse(profile.userId)]);
      });

      expect((await accept(profile.read(), [200])).body.userId).toBe(
        profile.userId,
      );
      expect(
        requests.map((url) => {
          return url.pathname;
        }),
      ).toStrictEqual(["/v1/users", "/v1/users"]);
    },
  );

  it.each(["5xx", "transport"])(
    "bounds a persistent %s failure to three user requests",
    async (failure) => {
      const profile = profileClient();
      context.mocks.signalTimers.delay.mockResolvedValue(undefined);
      const requests = observeUserRequests(() => {
        return failure === "5xx"
          ? HttpResponse.text("Unavailable", { status: 502 })
          : HttpResponse.error();
      });

      await accept(profile.read(), [500]);
      expect(
        requests.map((url) => {
          return url.pathname;
        }),
      ).toStrictEqual(["/v1/users", "/v1/users", "/v1/users"]);
    },
  );

  it.each(["empty", "404", "401", "invalid-json", "invalid-user"])(
    "does not retry or cache a %s user response as a valid profile",
    async (failure) => {
      const profile = profileClient();
      const requests = observeUserRequests(() => {
        switch (failure) {
          case "empty": {
            return HttpResponse.json([]);
          }
          case "404": {
            return HttpResponse.json({ errors: [] }, { status: 404 });
          }
          case "401": {
            return HttpResponse.json({ errors: [] }, { status: 401 });
          }
          case "invalid-json": {
            return HttpResponse.text("{", {
              headers: { "Content-Type": "application/json" },
            });
          }
          default: {
            return HttpResponse.json([{ id: profile.userId }]);
          }
        }
      });

      await accept(profile.read(), [500]);
      expect(
        requests.map((url) => {
          return url.pathname;
        }),
      ).toStrictEqual(["/v1/users"]);
      const recovery = observeUserRequests(() => {
        return HttpResponse.json([userResponse(profile.userId)]);
      });
      expect((await accept(profile.read(), [200])).body.email).toBe(
        `${profile.userId}@example.test`,
      );
      expect(recovery).toHaveLength(1);
    },
  );

  it("cancels an in-flight profile batch with its request owner", async () => {
    const admin = organizationClient();
    const controller = new AbortController();
    const entered = createDeferredPromise<AbortSignal>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      controller.abort();
    });
    const requests = observeUserRequests(async (request) => {
      entered.resolve(request.signal);
      await release.promise;
      return HttpResponse.json([userResponse(admin.userId)]);
    });
    const client = setupApp({
      context,
      routes: orgReadRoutes,
      signal: AbortSignal.any([context.signal, controller.signal]),
      rethrowErrors: true,
    })(orgMembersContract);
    const request = settle(client.members({ headers }), context.signal);
    const upstreamSignal = await entered.promise;
    controller.abort(new Error("User read cancelled"));
    release.resolve();
    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { message: "User read cancelled" },
    });
    expect(upstreamSignal.aborted).toBeTruthy();
    expect(
      requests.map((url) => {
        return url.pathname;
      }),
    ).toStrictEqual(["/v1/users"]);
  });

  it("resolves usage emails in bounded batches, retaining usage for missing users", async () => {
    const admin = organizationClient();
    // Settled charges are produced by billing infrastructure, not a user-write
    // endpoint. Use the usage fixture API, then verify the production read API.
    const fixture = setupApp({ context, routes: testUsageStateRoutes })(
      testUsageStateContract,
    );
    const userIds = Array.from({ length: 101 }, () => {
      return `user_${randomUUID()}`;
    }).sort();
    for (const userId of userIds) {
      await accept(
        fixture.action({
          body: {
            action: "insert-usage-event",
            org_id: admin.orgId,
            user_id: userId,
            status: "processed",
            credits_charged: 3,
            quantity: 1,
          },
        }),
        [200],
      );
    }
    const deletedId = userIds[0];
    const requests = observeUserRequests((request) => {
      const ids = new URL(request.url).searchParams.getAll("user_id");
      if (ids.length > 100) {
        return HttpResponse.json({ errors: [] }, { status: 422 });
      }
      return HttpResponse.json(
        ids
          .filter((id) => {
            return id !== deletedId;
          })
          .map((id) => {
            return userResponse(id);
          }),
      );
    });
    const client = setupApp({ context, routes: usageMembersRoutes })(
      usageMembersContract,
    );
    const response = await accept(
      client.get({ headers, query: { range: "24h", tz: "UTC" } }),
      [200],
    );

    expect(response.body.members).toHaveLength(101);
    expect(response.body.members).toContainEqual(
      expect.objectContaining({
        userId: deletedId,
        email: "unknown",
        creditsCharged: 3,
      }),
    );
    expect(
      response.body.members.filter((member) => {
        return member.email !== "unknown";
      }),
    ).toHaveLength(100);
    expect(
      requests.map((url) => {
        return url.pathname;
      }),
    ).toStrictEqual(["/v1/users", "/v1/users"]);
    expect(
      requests.map((url) => {
        return url.searchParams.getAll("user_id").length;
      }),
    ).toStrictEqual([100, 1]);
  });
});
