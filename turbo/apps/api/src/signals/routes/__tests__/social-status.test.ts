import { randomUUID } from "node:crypto";

import { socialContract } from "@okouai/api-contracts/contracts/social";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { socialRoutes } from "../social";
import { billingStatusRoutes } from "../billing-status";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const STATUS_URL = "https://api.socialkit.dev/status";
const OBSERVED_AT = "2026-09-14T09:00:00.000Z";
const HEADERS = { authorization: "Bearer clerk-session" } as const;
const TWITTER_IDS = [
  "profile",
  "tweet",
  "thread",
  "tweets",
  "transcript",
] as const;

function tool(id: string, status = "green", updatedAt = OBSERVED_AT) {
  return {
    id,
    status,
    updatedAt,
    channel: "Example",
    name: "Example",
    message: null,
  };
}

function feed(
  tools: readonly unknown[],
  overall = "green",
  generatedAt = OBSERVED_AT,
) {
  return { success: true, data: { overall, generatedAt, tools } };
}

function twitterFeed(status = "green") {
  return feed(
    TWITTER_IDS.map((id) => {
      return tool(`twitter.${id}`, status);
    }),
    status,
  );
}

function client() {
  return setupApp({ context, routes: socialRoutes })(socialContract);
}

function statusActor() {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Social status tests require an organization");
  }
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  mockNow(new Date(OBSERVED_AT));
  return { ...actor, orgId: actor.orgId };
}

describe("GET /api/social/status", () => {
  it.each([
    ["green", "healthy"],
    ["yellow", "degraded"],
    ["red", "unavailable"],
  ])(
    "maps %s to %s for ordinary users and projects only selected public operations",
    async (color, health) => {
      statusActor();
      server.use(
        http.get(STATUS_URL, () => {
          return HttpResponse.json(twitterFeed(color));
        }),
      );
      const response = await accept(
        client().status({ headers: HEADERS, query: { platform: "twitter" } }),
        [200],
      );
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.body).toMatchObject({
        observedAt: OBSERVED_AT,
        staleAfterSeconds: 300,
        overall: { status: health, updatedAt: OBSERVED_AT, reason: null },
      });
      expect(response.body.operations).toHaveLength(5);
      expect(
        response.body.operations.every((entry) => {
          return entry.platform === "twitter" && entry.status === health;
        }),
      ).toBeTruthy();
      expect(response.body.operations).toContainEqual({
        platform: "twitter",
        operation: "inspect",
        variant: "thread",
        status: health,
        updatedAt: OBSERVED_AT,
        reason: null,
      });
    },
  );

  it("retains service-wide degradation when filtering healthy operations", async () => {
    statusActor();
    server.use(
      http.get(STATUS_URL, () => {
        return HttpResponse.json({
          ...twitterFeed(),
          data: { ...twitterFeed().data, overall: "yellow" },
        });
      }),
    );
    const response = await accept(
      client().status({ headers: HEADERS, query: { platform: "twitter" } }),
      [200],
    );
    expect(response.body.overall.status).toBe("degraded");
    expect(
      response.body.operations.every((entry) => {
        return entry.status === "healthy";
      }),
    ).toBeTruthy();
  });

  it("uses async download health and excludes unsupported upstream capabilities", async () => {
    statusActor();
    server.use(
      http.get(STATUS_URL, () => {
        return HttpResponse.json(
          feed([
            tool("youtube.download", "green"),
            tool("youtube.async-download", "red"),
            tool("youtube.transcript.bulk", "green"),
            tool("video.transcript", "green"),
          ]),
        );
      }),
    );
    const response = await accept(
      client().status({ headers: HEADERS, query: {} }),
      [200],
    );
    expect(response.body.operations).toContainEqual({
      platform: "youtube",
      operation: "download",
      variant: "video",
      status: "unavailable",
      updatedAt: OBSERVED_AT,
      reason: null,
    });
    expect(response.body.overall.status).toBe("unavailable");
    expect(JSON.stringify(response.body)).not.toMatch(
      /bulk|async-download|socialkit/iu,
    );
    expect(
      response.body.operations.some((entry) => {
        return entry.variant === "profile" && entry.platform === "linkedin";
      }),
    ).toBeTruthy();
  });

  it.each([
    ["missing_entry", []],
    ["duplicate_entry", [tool("twitter.tweet"), tool("twitter.tweet", "red")]],
    ["invalid_response", [{ id: "twitter.tweet", status: "green" }]],
    ["invalid_timestamp", [tool("twitter.tweet", "green", "not-a-date")]],
    ["invalid_response", [tool("twitter.tweet", "blue")]],
  ])(
    "keeps %s unknown without hiding other fresh operations",
    async (reason, entries) => {
      statusActor();
      const otherTools = TWITTER_IDS.filter((id) => {
        return id !== "tweet";
      }).map((id) => {
        return tool(`twitter.${id}`);
      });
      server.use(
        http.get(STATUS_URL, () => {
          return HttpResponse.json(feed([...otherTools, ...entries]));
        }),
      );
      const response = await accept(
        client().status({ headers: HEADERS, query: { platform: "twitter" } }),
        [200],
      );
      expect(response.body.overall).toMatchObject({
        status: "unknown",
        reason,
      });
      expect(
        response.body.operations.find((entry) => {
          return entry.variant === "post";
        }),
      ).toMatchObject({ status: "unknown", reason });
      expect(
        response.body.operations.find((entry) => {
          return entry.variant === "profile" && entry.operation === "inspect";
        }),
      ).toMatchObject({ status: "healthy", reason: null });
    },
  );

  it.each([
    ["snapshot", -300_000, "healthy", null],
    ["snapshot", -300_001, "unknown", "stale"],
    ["entry", -300_001, "unknown", "stale"],
    ["snapshot", 60_001, "unknown", "invalid_timestamp"],
    ["entry", 60_001, "unknown", "invalid_timestamp"],
  ])(
    "checks %s freshness at offset %s",
    async (scope, offset, status, reason) => {
      statusActor();
      const shifted = new Date(
        Date.parse(OBSERVED_AT) + Number(offset),
      ).toISOString();
      const timestamp = scope === "entry" ? shifted : OBSERVED_AT;
      server.use(
        http.get(STATUS_URL, () => {
          return HttpResponse.json(
            feed(
              TWITTER_IDS.map((id) => {
                return tool(`twitter.${id}`, "green", timestamp);
              }),
              "green",
              scope === "snapshot" ? shifted : OBSERVED_AT,
            ),
          );
        }),
      );
      const response = await accept(
        client().status({ headers: HEADERS, query: { platform: "twitter" } }),
        [200],
      );
      expect(response.body.overall).toMatchObject({ status, reason });
      expect(
        response.body.operations.every((entry) => {
          return entry.status === status;
        }),
      ).toBeTruthy();
    },
  );

  it.each([
    [
      "status_unavailable",
      () => {
        return HttpResponse.json(
          { success: false, message: "internal upstream diagnostic" },
          { status: 503 },
        );
      },
    ],
    [
      "status_unavailable",
      () => {
        return new HttpResponse(null, { status: 500 });
      },
    ],
    [
      "network_error",
      () => {
        return HttpResponse.error();
      },
    ],
    [
      "network_error",
      () => {
        return new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.error(
                new DOMException("upstream body aborted", "AbortError"),
              );
            },
          }),
        );
      },
    ],
    [
      "network_error",
      () => {
        return new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.error(
                new DOMException("status body timed out", "TimeoutError"),
              );
            },
          }),
        );
      },
    ],
    [
      "invalid_response",
      () => {
        return HttpResponse.text("not JSON");
      },
    ],
    [
      "invalid_response",
      () => {
        return HttpResponse.json({
          success: true,
          data: { overall: "green", tools: null },
        });
      },
    ],
    [
      "invalid_response",
      () => {
        return HttpResponse.text("x".repeat(256 * 1024 + 1));
      },
    ],
  ])(
    "reports %s when the status feed cannot establish health",
    async (reason, responseFactory) => {
      statusActor();
      server.use(http.get(STATUS_URL, responseFactory));
      const response = await accept(
        client().status({ headers: HEADERS, query: { platform: "twitter" } }),
        [200],
      );
      expect(response.body.overall).toStrictEqual({
        status: "unknown",
        updatedAt: null,
        reason,
      });
      expect(
        response.body.operations.every((entry) => {
          return entry.status === "unknown";
        }),
      ).toBeTruthy();
      expect(JSON.stringify(response.body)).not.toContain(
        "internal upstream diagnostic",
      );
    },
  );

  it("does not forward credentials, expose account data, or charge an empty balance", async () => {
    const actor = statusActor();
    await createBddApi(context).completeOnboarding(actor);
    await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 0 });
    mockEnv("OKOU_SOCIAL_SOCIALKIT_TOKEN", "status-must-not-forward");
    server.use(
      http.get(STATUS_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(new URL(request.url).search).toBe("");
        return HttpResponse.json({
          ...twitterFeed(),
          provider: "socialkit",
          accountCredits: 12_345,
        });
      }),
    );
    const response = await accept(
      client().status({ headers: HEADERS, query: { platform: "twitter" } }),
      [200],
    );
    expect(response.body.overall.status).toBe("healthy");
    expect(JSON.stringify(response.body)).not.toMatch(
      /credits|socialkit|status-must-not-forward/iu,
    );
    const balance = await accept(
      setupApp({ context, routes: billingStatusRoutes })(
        billingStatusContract,
      ).get({ headers: HEADERS }),
      [200],
    );
    expect(balance.body.credits).toBe(0);
  });

  it("rejects unauthenticated callers", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const response = await accept(
      client().status({ headers: {}, query: {} }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("requires an organization for authenticated callers", async () => {
    const actor = createBddApi(context).user({ orgId: null });
    createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
    const response = await accept(
      client().status({ headers: HEADERS, query: {} }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("requires social:read for sandbox callers", async () => {
    const actor = statusActor();
    const seconds = Date.parse(OBSERVED_AT) / 1000;
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: randomUUID(),
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });
    const response = await accept(
      client().status({
        headers: { authorization: `Bearer ${token}` },
        query: {},
      }),
      [403],
    );
    expect(response.body.error.message).toBe(
      "Missing required capability: social:read",
    );
  });

  it("accepts a sandbox caller with social:read", async () => {
    const actor = statusActor();
    await createBddApi(context).completeOnboarding(actor);
    const seconds = Date.parse(OBSERVED_AT) / 1000;
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: randomUUID(),
      capabilities: ["social:read"],
      iat: seconds,
      exp: seconds + 60,
    });
    server.use(
      http.get(STATUS_URL, () => {
        return HttpResponse.json(twitterFeed());
      }),
    );
    const response = await accept(
      client().status({
        headers: { authorization: `Bearer ${token}` },
        query: { platform: "twitter" },
      }),
      [200],
    );
    expect(response.body.overall.status).toBe("healthy");
    expect(JSON.stringify(response.body)).not.toMatch(/socialkit|provider/iu);
  });

  it("propagates caller cancellation instead of returning a status observation", async () => {
    statusActor();
    const controller = new AbortController();
    let providerAborted = false;
    server.use(
      http.get(STATUS_URL, ({ request }) => {
        controller.abort();
        providerAborted = request.signal.aborted;
        return HttpResponse.json(twitterFeed());
      }),
    );
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: socialRoutes,
    });
    const response = await app.request(
      new Request("http://api.test/api/social/status?platform=twitter", {
        headers: HEADERS,
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(500);
    expect(providerAborted).toBeTruthy();
  });
});
