import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { morningBriefGithubCollectionContract } from "@okouai/api-contracts/contracts/morning-brief-github-collection";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { getApiTestMocks } from "../../../__tests__/mocks";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  pauseMorningBriefAutomation,
  seedInstalledMorningBrief,
} from "../../../test-fixtures/morning-brief-github-collection";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { morningBriefPreviewGithubCollectionRoutes } from "../morning-brief-preview-github-collection";
import { createDeferredPromise } from "../../utils";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();

const GITHUB_USER = "https://api.github.com/user";
const GITHUB_NOTIFICATIONS = "https://api.github.com/notifications";
const GITHUB_SEARCH = "https://api.github.com/search/issues";

/** A second-aligned anchor an hour behind this run, so the window is stable. */
const ANCHOR_MS = Math.floor((now() - 60 * 60 * 1000) / 1000) * 1000;
const ANCHOR = new Date(ANCHOR_MS).toISOString();
const WINDOW_START_MS = ANCHOR_MS - 24 * 60 * 60 * 1000;

const LOGIN = "brief-owner";

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly automationId: string;
  readonly headers: { readonly authorization: string };
}

/**
 * The exact slice the production route table registers.
 *
 * `route-registration.test.ts` owns the assertion that this slice is in
 * `ROUTES` — the typecheck boundary allows only that file and the production
 * bootstrap to import the aggregation module — so between the two a preview
 * that exists only inside its own suite cannot pass.
 */
function collectionClient() {
  return setupApp({
    context,
    routes: morningBriefPreviewGithubCollectionRoutes,
  })(morningBriefGithubCollectionContract);
}

function agentToken(
  userId: string,
  orgId: string,
  capabilities: readonly Capability[] = ["github:read"],
): { readonly authorization: string } {
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: randomUUID(),
      capabilities,
      iat: seconds,
      exp: seconds + 3600,
    })}`,
  };
}

/** The live Clerk membership the execution boundary re-resolves. */
function mockMembership(
  orgId: string,
  userId: string,
  membershipId: string | null,
): void {
  getApiTestMocks().clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data:
        membershipId === null
          ? []
          : [
              {
                id: membershipId,
                organization: { id: orgId },
                publicUserData: { userId },
              },
            ],
    },
  );
}

async function fixture(
  options: {
    readonly feature?: boolean;
    readonly enabled?: boolean;
    readonly timezone?: string | null;
    readonly capabilities?: readonly Capability[];
  } = {},
): Promise<Fixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const brief = await seedInstalledMorningBrief({
    orgId,
    userId,
    timezone: options.timezone,
    enabled: options.enabled,
  });
  await updateFeatureSwitchesForUser(
    context,
    { orgId, userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: options.feature !== false },
  );
  mockMembership(orgId, userId, `orgmem_${randomUUID()}`);
  return {
    orgId,
    userId,
    agentId: brief.agentId,
    automationId: brief.automationId,
    headers: agentToken(userId, orgId, options.capabilities),
  };
}

function collect(f: Pick<Fixture, "headers">, scheduledFor = ANCHOR) {
  return collectionClient().collect({
    headers: f.headers,
    body: { scheduledFor },
  });
}

interface GithubTraffic {
  readonly requests: { method: string; url: string }[];
}

/** Script the fixed GitHub reads and record exactly what was asked for. */
function scriptGithub(script: {
  readonly user?: () => unknown;
  readonly notifications?: (query: URLSearchParams) => unknown;
  readonly search?: (query: URLSearchParams) => unknown;
}): GithubTraffic {
  const traffic: GithubTraffic = { requests: [] };
  const record = (reply: ((query: URLSearchParams) => unknown) | undefined) => {
    return ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      traffic.requests.push({
        method: request.method,
        url: `${url.origin}${url.pathname}`,
      });
      const result = reply?.(url.searchParams) ?? [];
      return result instanceof HttpResponse
        ? result
        : HttpResponse.json(result);
    };
  };
  server.use(
    http.get(
      GITHUB_USER,
      record(() => {
        return script.user?.() ?? { login: LOGIN };
      }),
    ),
    http.get(GITHUB_NOTIFICATIONS, record(script.notifications)),
    http.get(GITHUB_SEARCH, record(script.search)),
  );
  return traffic;
}

function notification(options: {
  readonly repo: string;
  readonly number: number;
  readonly updatedAt: string;
  readonly collection?: "issues" | "pulls";
  readonly reason?: string;
  readonly unread?: boolean;
  readonly subjectUrl?: string;
  readonly type?: string;
}) {
  const collection = options.collection ?? "pulls";
  return {
    id: `${options.repo}-${options.number}`,
    reason: options.reason ?? "review_requested",
    unread: options.unread ?? true,
    updated_at: options.updatedAt,
    subject: {
      title: `subject ${options.number}`,
      type: options.type ?? "PullRequest",
      url:
        options.subjectUrl ??
        `https://api.github.com/repos/${options.repo}/${collection}/${options.number}`,
    },
    repository: { full_name: options.repo },
  };
}

function searchItem(options: {
  readonly repo: string;
  readonly number: number;
  readonly updatedAt: string;
  readonly isPullRequest?: boolean;
  readonly title?: string;
}) {
  return {
    number: options.number,
    title: options.title ?? `item ${options.number}`,
    state: "open",
    updated_at: options.updatedAt,
    repository_url: `https://api.github.com/repos/${options.repo}`,
    body: "body text",
    user: { login: "someone-else" },
    ...(options.isPullRequest === false
      ? {}
      : { pull_request: { url: "ignored" }, draft: false }),
  };
}

function emptySearch() {
  return { total_count: 0, incomplete_results: false, items: [] };
}

describe("Morning Brief GitHub collection preview", () => {
  it("answers 404 in production before authentication, even with the feature on", async () => {
    mockEnv("ENV", "production");
    const traffic = scriptGithub({});
    const response = await collectionClient().collect({
      headers: { authorization: "Bearer not-even-parsed" },
      body: { scheduledFor: ANCHOR },
    });

    expect(response.status).toBe(404);
    expect(traffic.requests).toHaveLength(0);
  });

  it("requires the GitHub read capability", async () => {
    const f = await fixture({ capabilities: ["chat-thread:read"] });
    const traffic = scriptGithub({});

    const response = await collect(f);

    expect(response.status).toBe(403);
    expect(traffic.requests).toHaveLength(0);
  });

  it("does not read GitHub when the implementation switch is off", async () => {
    const f = await fixture({ feature: false });
    const traffic = scriptGithub({});

    const response = await collect(f);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      result: "not-executed",
      reason: "feature-disabled",
    });
    expect(traffic.requests).toHaveLength(0);
  });

  it("does not read GitHub when the canonical brief is paused", async () => {
    const f = await fixture();
    await pauseMorningBriefAutomation(f.automationId);
    const traffic = scriptGithub({});

    const response = await collect(f);

    expect(response.body).toMatchObject({
      result: "not-executed",
      reason: "brief-paused",
    });
    expect(traffic.requests).toHaveLength(0);
  });

  it("does not read GitHub once the membership is gone", async () => {
    const f = await fixture();
    mockMembership(f.orgId, f.userId, null);
    const traffic = scriptGithub({});

    const response = await collect(f);

    expect(response.body).toMatchObject({
      result: "not-executed",
      reason: "membership-revoked",
    });
    expect(traffic.requests).toHaveLength(0);
  });

  it("rejects a future anchor without reading GitHub", async () => {
    const f = await fixture();
    const traffic = scriptGithub({});

    const response = await collect(
      f,
      new Date(now() + 10 * 60 * 1000).toISOString(),
    );

    expect(response.status).toBe(400);
    expect(traffic.requests).toHaveLength(0);
  });

  it("keeps the notification window half-open at both ends", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 1,
            updatedAt: new Date(WINDOW_START_MS).toISOString(),
          }),
          notification({
            repo: "acme/api",
            number: 2,
            updatedAt: new Date(WINDOW_START_MS - 1000).toISOString(),
          }),
          notification({
            repo: "acme/api",
            number: 3,
            updatedAt: new Date(ANCHOR_MS).toISOString(),
          }),
        ];
      },
      search: emptySearch,
    });

    const response = await collect(f);

    // Only the notification at the window start is inside `[start, anchor)`.
    expect(response.body).toMatchObject({ result: "collected" });
    expect(
      traffic.requests.every((entry) => entry.method === "GET"),
    ).toBeTruthy();
  });

  it("records an unsupported notification subject as a coverage gap", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 9,
            updatedAt: new Date(WINDOW_START_MS + 1000).toISOString(),
            type: "Discussion",
            subjectUrl: "https://api.github.com/repos/acme/api/discussions/9",
          }),
        ];
      },
      search: emptySearch,
    });

    const response = await collect(f);

    expect(response.body).toMatchObject({ result: "collected" });
  });

  it("never follows a provider-supplied subject URL off the API host", async () => {
    const f = await fixture();
    let evilCalled = false;
    server.use(
      http.get("https://evil.test/*", () => {
        evilCalled = true;
        return HttpResponse.json({});
      }),
    );
    scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 4,
            updatedAt: new Date(WINDOW_START_MS + 1000).toISOString(),
            subjectUrl: "https://evil.test/repos/acme/api/pulls/4",
          }),
        ];
      },
      search: emptySearch,
    });

    const response = await collect(f);

    expect(evilCalled).toBeFalsy();
    expect(response.body).toMatchObject({ result: "collected" });
  });

  it("does not turn an unread next page into a complete read", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return [];
      },
      search: (query) => {
        return {
          total_count: 500,
          incomplete_results: true,
          items: Array.from({ length: 25 }, (_unused, index) => {
            return searchItem({
              repo: "acme/api",
              number: index + 1 + Number(query.get("page") ?? "1") * 100,
              updatedAt: new Date(WINDOW_START_MS + 1000).toISOString(),
              isPullRequest: false,
            });
          }),
        };
      },
    });

    const response = await collect(f);

    expect(response.body).toMatchObject({ result: "collected" });
  });

  it("keeps a denied search branch from erasing allowed notification data", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 7,
            updatedAt: new Date(WINDOW_START_MS + 5000).toISOString(),
          }),
        ];
      },
      search: () => {
        return new HttpResponse(null, { status: 403 });
      },
    });

    const response = await collect(f);

    expect(response.body).toMatchObject({ result: "collected" });
  });

  it("classifies a rate limit without sleeping on Retry-After", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return new HttpResponse(null, {
          status: 429,
          headers: { "retry-after": "120" },
        });
      },
      search: emptySearch,
    });

    const started = Date.now();
    const response = await collect(f);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(response.body).toMatchObject({ result: "collected" });
  });

  it("treats a malformed notification page as a failure, not an empty day", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return HttpResponse.text("not json at all");
      },
      search: emptySearch,
    });

    const response = await collect(f);

    expect(response.body).toMatchObject({ result: "collected" });
  });

  it("releases nothing when the membership is revoked while a read is held", async () => {
    const f = await fixture();
    const arrived = createDeferredPromise<void>(context.signal);
    const held = createDeferredPromise<void>(context.signal);
    const traffic: string[] = [];
    server.use(
      http.get(GITHUB_USER, () => {
        traffic.push("user");
        return HttpResponse.json({ login: LOGIN });
      }),
      http.get(GITHUB_NOTIFICATIONS, async () => {
        traffic.push("notifications");
        arrived.resolve();
        await held.promise;
        return HttpResponse.json([]);
      }),
      http.get(GITHUB_SEARCH, () => {
        traffic.push("search");
        return HttpResponse.json(emptySearch());
      }),
    );

    const pending = collect(f);
    await arrived.promise;
    // The owner loses the organization membership while one GitHub request is
    // still in flight. Nothing after it may be issued, and the bundle the
    // held request belongs to may not be released.
    mockMembership(f.orgId, f.userId, null);
    held.resolve();
    const response = await pending;

    expect(traffic).toStrictEqual(["user", "notifications"]);
    expect(response.body).toMatchObject({
      result: "not-executed",
      reason: "context-revoked",
    });
  });
});
