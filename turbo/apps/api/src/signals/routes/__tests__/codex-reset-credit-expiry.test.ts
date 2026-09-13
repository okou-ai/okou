import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { http, HttpResponse } from "msw";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { meModelProvidersResetSubscriptionRoutes } from "../me-model-providers-reset-subscription";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { codexDeviceAuthRoutes } from "../codex-device-auth";
import { modelProvidersRoutes } from "../model-providers";
import { featureSwitchesRoutes } from "../feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { mockCodexDeviceAuthProvider } from "./helpers/api-bdd-auth-device";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...meModelProvidersListRoutes,
  ...meModelProvidersUpsertRoutes,
]);
const detailsUrl =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function credentials(accountId = randomUUID(), accessToken?: string) {
  const token =
    accessToken ??
    jwt({ exp: Math.floor(now() / 1000) + 7200, jti: randomUUID() });
  return {
    accountId,
    accessToken: token,
    raw: JSON.stringify({
      tokens: {
        access_token: token,
        refresh_token: `refresh-${randomUUID()}`,
        account_id: accountId,
        id_token: jwt({
          email: "expiry@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: accountId,
            chatgpt_plan_type: "plus",
          },
        }),
      },
    }),
  };
}

function expiryResponse(expiry: string | null) {
  return HttpResponse.json({
    credits: [{ status: "available", expires_at: expiry }],
  });
}

function upstream() {
  const control = {
    usageCalls: 0,
    detailsCalls: 0,
    expiry: new Date(now() + 3_600_000).toISOString(),
    details: (_request: Request): Response | Promise<Response> => {
      return expiryResponse(control.expiry);
    },
    usage: (): Response | Promise<Response> => {
      return HttpResponse.json({
        rate_limit_reset_credits: { available_count: control.usageCalls },
      });
    },
  };
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      control.usageCalls += 1;
      return control.usage();
    }),
    http.get(detailsUrl, ({ request }) => {
      control.detailsCalls += 1;
      return control.details(request);
    }),
  );
  return control;
}

async function fixture(
  options: {
    accounts?: boolean;
    auth?: ReturnType<typeof credentials>;
    orgId?: string;
    userId?: string;
  } = {},
) {
  const owner = {
    orgId: options.orgId ?? `org_expiry_${randomUUID()}`,
    userId: options.userId ?? `user_expiry_${randomUUID()}`,
  };
  const auth = options.auth ?? credentials();
  const session = () => {
    return mocks.clerk.session(owner.userId, owner.orgId);
  };
  session();
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.PersonalModelProviderAccounts]: options.accounts ?? false,
  });
  const client = (signal?: AbortSignal) => {
    return setupApp({ context, routes, signal, rethrowErrors: true })(
      personalModelProvidersMainContract,
    );
  };
  const connect = async (next = auth) => {
    session();
    return await accept(
      client().upsert({
        headers,
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: next.raw },
        },
      }),
      [200, 201],
    );
  };
  const connected = await connect();
  return {
    ...owner,
    id: connected.body.provider.id,
    auth,
    connect,
    session,
    list: async (signal?: AbortSignal) => {
      session();
      const result = await accept(client(signal).list({ headers }), [200]);
      return result.body.modelProviders;
    },
    consume: async () => {
      session();
      const idempotencyKey = randomUUID();
      if (options.accounts) {
        return await setupApp({
          context,
          routes: meModelProviderAccountRoutes,
        })(personalModelProviderAccountsByIdContract).resetSubscriptionUsage({
          headers,
          params: { id: connected.body.provider.id },
          body: { idempotencyKey },
        });
      }
      return await setupApp({
        context,
        routes: meModelProvidersResetSubscriptionRoutes,
      })(personalModelProvidersByTypeContract).resetSubscriptionUsage({
        headers,
        params: { type: "codex-oauth-token" },
        body: { idempotencyKey },
      });
    },
  };
}

function expectExpiry(
  providers: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["list"]>>,
  expiry: string | null,
  count?: number,
) {
  expect(providers[0]).toMatchObject({
    subscriptionResetCreditsNextExpiresAt: expiry,
    ...(count === undefined ? {} : { subscriptionResetCredits: count }),
  });
}

function controller() {
  const value = new AbortController();
  onTestFinished(() => {
    return value.abort();
  });
  return value;
}

describe("Codex expiry metadata resilience", () => {
  it.each([false, true])(
    "caches successful dates and nulls for five minutes, accounts=%s",
    async (accounts) => {
      mockNow(Date.UTC(2030, 0, 1));
      const remote = upstream();
      const user = await fixture({ accounts });
      const start = now();
      expectExpiry(await user.list(), remote.expiry, 2);
      remote.details = () => {
        return expiryResponse(null);
      };
      mockNow(start + 299_999);
      expectExpiry(await user.list(), remote.expiry, 3);
      expect(remote.detailsCalls).toBe(2);
      mockNow(start + 300_000);
      expectExpiry(await user.list(), null, 4);
      remote.details = () => {
        return expiryResponse(remote.expiry);
      };
      mockNow(start + 599_999);
      expectExpiry(await user.list(), null, 5);
      expect(remote.detailsCalls).toBe(3);
      mockNow(start + 600_000);
      expectExpiry(await user.list(), remote.expiry, 6);
      expect(remote.detailsCalls).toBe(4);
    },
  );

  it("omits past expiry both on a cache hit and in upstream details", async () => {
    mockNow(Date.UTC(2030, 0, 1));
    const remote = upstream();
    const user = await fixture();
    remote.expiry = new Date(now() + 1000).toISOString();
    expectExpiry(await user.list(), remote.expiry);
    mockNow(now() + 1000);
    expectExpiry(await user.list(), null);
    mockNow(now() + 300_000);
    expectExpiry(await user.list(), null);
    expect(remote.detailsCalls).toBe(3);
  });

  it.each([false, true])(
    "cools down after 503 and restores expiry at 60 seconds, accounts=%s",
    async (accounts) => {
      mockNow(Date.UTC(2030, 0, 1));
      const remote = upstream();
      const user = await fixture({ accounts });
      remote.details = () => {
        return new HttpResponse(null, {
          status: 503,
          headers: { "Retry-After": "120" },
        });
      };
      const start = now();
      expectExpiry(await user.list(), null, 2);
      expectExpiry(await user.list(), null, 3);
      mockNow(start + 59_999);
      expectExpiry(await user.list(), null, 4);
      expect(remote.detailsCalls).toBe(2);

      remote.details = () => {
        return expiryResponse(remote.expiry);
      };
      mockNow(start + 60_000);
      expectExpiry(await user.list(), remote.expiry, 5);
      expect(remote.detailsCalls).toBe(3);
      expectExpiry(await user.list(), remote.expiry, 6);
      expect(remote.detailsCalls).toBe(3);
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "does not revive a cached date after its TTL expires during a 503 outage, accounts=%s",
    async (accounts) => {
      mockNow(Date.UTC(2030, 0, 1));
      const remote = upstream();
      const user = await fixture({ accounts });
      const start = now();
      expectExpiry(await user.list(), remote.expiry, 2);
      remote.details = () => {
        return new HttpResponse(null, { status: 503 });
      };
      mockNow(start + 299_999);
      expectExpiry(await user.list(), remote.expiry, 3);
      expect(remote.detailsCalls).toBe(2);
      mockNow(start + 300_000);
      expectExpiry(await user.list(), null, 4);
      expect(remote.detailsCalls).toBe(3);
      mockNow(start + 359_999);
      expectExpiry(await user.list(), null, 5);
      expect(remote.detailsCalls).toBe(3);
      mockNow(start + 360_000);
      expectExpiry(await user.list(), null, 6);
      expect(remote.detailsCalls).toBe(4);

      const recoveredExpiry = new Date(start + 7_200_000).toISOString();
      remote.details = () => {
        return expiryResponse(recoveredExpiry);
      };
      mockNow(start + 419_999);
      expectExpiry(await user.list(), null, 7);
      expect(remote.detailsCalls).toBe(4);
      mockNow(start + 420_000);
      expectExpiry(await user.list(), recoveredExpiry, 8);
      expect(remote.detailsCalls).toBe(5);
    },
  );

  it.each([false, true])(
    "shares a concurrent 503 attempt and its cooldown while refreshing each count, accounts=%s",
    async (accounts) => {
      mockNow(Date.UTC(2030, 0, 1));
      const remote = upstream();
      const user = await fixture({ accounts });
      const started = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<Response>(context.signal);
      const bothUsage = createDeferredPromise<void>(context.signal);
      remote.details = () => {
        started.resolve();
        return release.promise;
      };
      remote.usage = () => {
        if (remote.usageCalls === 3) {
          bothUsage.resolve();
        }
        return HttpResponse.json({
          rate_limit_reset_credits: { available_count: remote.usageCalls },
        });
      };
      const first = user.list();
      await started.promise;
      const second = user.list();
      await bothUsage.promise;
      release.resolve(new HttpResponse(null, { status: 503 }));
      const results = await Promise.all([first, second]);
      expectExpiry(results[0], null, 2);
      expectExpiry(results[1], null, 3);
      expectExpiry(await user.list(), null, 4);
      expect(remote.detailsCalls).toBe(2);
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["120", 120_000],
    ["Tue, 01 Jan 2030 00:02:00 GMT", 120_000],
    ["Tuesday, 01-Jan-30 00:02:00 GMT", 120_000],
    ["Tue Jan  1 00:02:00 2030", 120_000],
    [null, 60_000],
    ["garbage", 60_000],
    ["Fri, 30 Feb 2030 00:02:00 GMT", 60_000],
    ["Tue, 01 Jan 2030 99:02:00 GMT", 60_000],
    ["-10", 60_000],
    ["0", 60_000],
    ["1.5", 60_000],
    ["999999999999999999999999999", 60_000],
    ["Tue, 01 Jan 2030 00:00:00 GMT", 60_000],
    ["Mon, 31 Dec 2029 23:59:59 GMT", 60_000],
  ] as const)(
    "honors Retry-After %s without retrying usage or expiry",
    async (retryAfter, cooldown) => {
      mockNow(Date.UTC(2030, 0, 1));
      const remote = upstream();
      const user = await fixture();
      remote.details = () => {
        return new HttpResponse(null, {
          status: 429,
          headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
        });
      };
      const start = now();
      expectExpiry(await user.list(), null, 2);
      expect(remote.detailsCalls).toBe(2);
      mockNow(start + cooldown - 1);
      expectExpiry(await user.list(), null, 3);
      expect(remote.detailsCalls).toBe(2);
      remote.details = () => {
        return expiryResponse(remote.expiry);
      };
      mockNow(start + cooldown);
      expectExpiry(await user.list(), remote.expiry, 4);
      expect(remote.detailsCalls).toBe(3);
    },
  );

  it("coalesces readers and isolates one caller's TimeoutError cancellation", async () => {
    const remote = upstream();
    const user = await fixture();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Response>(context.signal);
    const bothUsage = createDeferredPromise<void>(context.signal);
    let detailsSignal: AbortSignal | undefined;
    remote.details = (request) => {
      detailsSignal = request.signal;
      started.resolve();
      return release.promise;
    };
    remote.usage = () => {
      if (remote.usageCalls === 3) {
        bothUsage.resolve();
      }
      return HttpResponse.json({
        rate_limit_reset_credits: { available_count: remote.usageCalls },
      });
    };
    const firstController = controller();
    const first = user.list(firstController.signal);
    const cancelled = (async () => {
      await expect(first).rejects.toThrow("caller deadline");
    })();
    await started.promise;
    const second = user.list();
    await bothUsage.promise;
    firstController.abort(new DOMException("caller deadline", "TimeoutError"));
    await cancelled;
    expect(detailsSignal?.aborted).toBeFalsy();
    release.resolve(expiryResponse(remote.expiry));
    expectExpiry(await second, remote.expiry, 3);
    expect(remote.detailsCalls).toBe(2);
    expectExpiry(await user.list(), remote.expiry, 4);
    expect(remote.detailsCalls).toBe(2);
  });

  it("aborts all-waiter work and lets a new flight survive late cleanup", async () => {
    const remote = upstream();
    const user = await fixture();
    const started = createDeferredPromise<void>(context.signal);
    const aborted = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Response>(context.signal);
    remote.details = (request) => {
      request.signal.addEventListener(
        "abort",
        () => {
          return aborted.resolve();
        },
        {
          once: true,
        },
      );
      started.resolve();
      return release.promise;
    };
    const owner = controller();
    const cancelled = (async () => {
      await expect(user.list(owner.signal)).rejects.toThrow("cancelled");
    })();
    await started.promise;
    owner.abort(new DOMException("cancelled", "AbortError"));
    await cancelled;
    await aborted.promise;
    remote.expiry = new Date(now() + 7_200_000).toISOString();
    remote.details = () => {
      return expiryResponse(remote.expiry);
    };
    expectExpiry(await user.list(), remote.expiry);
    release.resolve(expiryResponse(new Date(now() + 1000).toISOString()));
    expectExpiry(await user.list(), remote.expiry);
    expect(remote.detailsCalls).toBe(3);
  });

  it("uses only the local five-second deadline for a timeout cooldown", async () => {
    mockNow(Date.UTC(2030, 0, 1));
    const remote = upstream();
    const user = await fixture();
    const started = createDeferredPromise<void>(context.signal);
    const deadline = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Response>(context.signal);
    remote.details = () => {
      started.resolve();
      return release.promise;
    };
    context.mocks.signalTimers.delay.mockImplementation((ms) => {
      expect(ms).toBe(5000);
      return deadline.promise;
    });
    const attempt = user.list();
    await started.promise;
    deadline.resolve();
    expectExpiry(await attempt, null, 2);
    release.resolve(expiryResponse(remote.expiry));
    mockNow(now() + 59_999);
    expectExpiry(await user.list(), null, 3);
    expect(remote.detailsCalls).toBe(2);
    context.mocks.signalTimers.delay.mockReset();
    remote.details = () => {
      return expiryResponse(remote.expiry);
    };
    mockNow(now() + 1);
    expectExpiry(await user.list(), remote.expiry, 4);
    expect(remote.detailsCalls).toBe(3);
  });

  it.each([401, 500, "json", "schema", "transport"] as const)(
    "omits the expiry after an unexpected %s failure and preserves the count",
    async (failure) => {
      const remote = upstream();
      const user = await fixture();
      remote.details = () => {
        return failure === "json"
          ? new HttpResponse("{invalid json", {
              headers: { "Content-Type": "application/json" },
            })
          : failure === "schema"
            ? HttpResponse.json({ credits: "invalid" })
            : failure === "transport"
              ? HttpResponse.error()
              : new HttpResponse(null, { status: failure });
      };
      expectExpiry(await user.list(), null, 2);
      expect(remote.detailsCalls).toBe(2);
    },
  );

  it.each([false, true])(
    "invalidates on ambiguous consume failure, accounts=%s",
    async (accounts) => {
      const remote = upstream();
      const user = await fixture({ accounts });
      expectExpiry(await user.list(), remote.expiry);
      let consumeCalls = 0;
      server.use(
        http.post(`${detailsUrl}/consume`, async ({ request }) => {
          consumeCalls += 1;
          expect(request.headers.get("chatgpt-account-id")).toBe(
            user.auth.accountId,
          );
          await expect(request.json()).resolves.toStrictEqual({
            redeem_request_id: expect.any(String),
          });
          return HttpResponse.error();
        }),
      );
      const result = await user.consume();
      expect(result.status).toBe(500);
      remote.expiry = new Date(now() + 7_200_000).toISOString();
      expectExpiry(await user.list(), remote.expiry);
      expect(remote.detailsCalls).toBe(3);
      expect(consumeCalls).toBe(1);
    },
  );

  it.each(["consume", "reconnect", "replace-account"] as const)(
    "fences an in-flight expiry across %s",
    async (mutation) => {
      const remote = upstream();
      const user = await fixture({ accounts: mutation === "replace-account" });
      const started = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<Response>(context.signal);
      remote.details = () => {
        started.resolve();
        return release.promise;
      };
      const oldRead = user.list();
      await started.promise;
      remote.details = () => {
        return expiryResponse(null);
      };
      if (mutation === "consume") {
        server.use(
          http.post(`${detailsUrl}/consume`, () => {
            return HttpResponse.json({ code: "reset" });
          }),
        );
        expect((await user.consume()).status).toBe(200);
      } else {
        await user.connect(
          mutation === "replace-account" ? credentials() : user.auth,
        );
      }
      expectExpiry(await oldRead, null);
      const freshExpiry = new Date(now() + 7_200_000).toISOString();
      remote.details = () => {
        return expiryResponse(freshExpiry);
      };
      expectExpiry(await user.list(), freshExpiry);
      release.resolve(expiryResponse(remote.expiry));
      expectExpiry(await user.list(), freshExpiry);
    },
  );

  it("rechecks invalidation after expiry settled while the main usage read is pending", async () => {
    const remote = upstream();
    const user = await fixture();
    expectExpiry(await user.list(), remote.expiry);
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Response>(context.signal);
    remote.usage = () => {
      started.resolve();
      return release.promise;
    };
    const oldRead = user.list();
    await started.promise;
    server.use(
      http.post(`${detailsUrl}/consume`, () => {
        return HttpResponse.json({ code: "reset" });
      }),
    );
    expect((await user.consume()).status).toBe(200);
    release.resolve(
      HttpResponse.json({ rate_limit_reset_credits: { available_count: 7 } }),
    );
    expectExpiry(await oldRead, null, 7);
  });

  it.each(["user", "org"] as const)(
    "isolates identical upstream credentials by %s",
    async (dimension) => {
      const remote = upstream();
      const first = await fixture();
      remote.details = () => {
        return new HttpResponse(null, { status: 429 });
      };
      expectExpiry(await first.list(), null);
      remote.details = () => {
        return expiryResponse(remote.expiry);
      };
      const second = await fixture({
        auth: first.auth,
        ...(dimension === "user"
          ? { orgId: first.orgId }
          : { userId: first.userId }),
      });
      expectExpiry(await second.list(), remote.expiry);
      expectExpiry(await first.list(), null);
      expect(remote.detailsCalls).toBe(4);
    },
  );

  it("preserves another concrete account's cooldown across connect and reconnect", async () => {
    const remote = upstream();
    const first = await fixture({ accounts: true });
    remote.details = () => {
      return new HttpResponse(null, {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    };
    expectExpiry(await first.list(), null);
    remote.details = (request) => {
      expect(request.headers.get("chatgpt-account-id")).not.toBe(
        first.auth.accountId,
      );
      return expiryResponse(remote.expiry);
    };
    first.session();
    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: randomUUID(),
    });
    const device = setupApp({ context, routes: codexDeviceAuthRoutes })(
      codexDeviceAuthContract,
    );
    const connect = async (id?: string) => {
      const started = await accept(
        device.start({
          headers,
          body: {
            scope: "personal",
            mode: id ? "reconnect" : "add",
            modelProviderId: id,
          },
        }),
        [200],
      );
      const completed = await accept(
        device.complete({
          headers,
          body: { sessionToken: started.body.sessionToken },
        }),
        [200],
      );
      if (completed.body.status !== "complete") {
        throw new Error("Expected device auth completion");
      }
      return completed.body.provider.id;
    };
    const secondId = await connect();
    await connect(secondId);
    const before = remote.detailsCalls;
    const listed = await first.list();
    expect(listed).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          subscriptionResetCreditsNextExpiresAt: null,
        }),
        expect.objectContaining({
          id: secondId,
          subscriptionResetCreditsNextExpiresAt: remote.expiry,
        }),
      ]),
    );
    expect(remote.detailsCalls).toBe(before + 1);
    await expect(first.list()).resolves.toHaveLength(2);
    expect(remote.detailsCalls).toBe(before + 1);
  });

  it("isolates org connect metadata from the personal cooldown", async () => {
    const remote = upstream();
    const user = await fixture();
    remote.details = () => {
      return new HttpResponse(null, { status: 429 });
    };
    expectExpiry(await user.list(), null);
    remote.details = () => {
      return expiryResponse(remote.expiry);
    };
    user.session();
    const result = await accept(
      setupApp({ context, routes: modelProvidersRoutes })(
        modelProvidersMainContract,
      ).upsert({
        headers,
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: user.auth.raw },
        },
      }),
      [200, 201],
    );
    expect(result.body.provider.type).toBe("codex-oauth-token");
    expect(remote.detailsCalls).toBe(3);
    expectExpiry(await user.list(), null);
    expect(remote.detailsCalls).toBe(3);
  });

  it.each(["credential", "account"] as const)(
    "does not reuse expiry after changing %s",
    async (dimension) => {
      const remote = upstream();
      const user = await fixture();
      expectExpiry(await user.list(), remote.expiry);
      const next = credentials(
        dimension === "account" ? randomUUID() : user.auth.accountId,
      );
      await user.connect(next);
      remote.expiry = new Date(now() + 7_200_000).toISOString();
      expectExpiry(await user.list(), remote.expiry);
      expect(remote.detailsCalls).toBe(4);
    },
  );

  it("fences an old flight when current credentials rotate without reconnect", async () => {
    mockNow(Date.UTC(2030, 0, 1));
    const remote = upstream();
    const user = await fixture({ accounts: true });
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Response>(context.signal);
    remote.details = () => {
      started.resolve();
      return release.promise;
    };
    const oldRead = user.list();
    await started.promise;
    const freshToken = `fresh-${randomUUID()}`;
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        return HttpResponse.json({
          access_token: freshToken,
          refresh_token: `rotated-${randomUUID()}`,
          expires_in: 3600,
        });
      }),
    );
    mockNow(now() + 7_201_000);
    const freshExpiry = new Date(now() + 3_600_000).toISOString();
    remote.details = (request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${freshToken}`);
      return expiryResponse(freshExpiry);
    };
    expectExpiry(await user.list(), freshExpiry);
    expectExpiry(await oldRead, null);
    release.resolve(expiryResponse(remote.expiry));
    expectExpiry(await user.list(), freshExpiry);
    expect(remote.detailsCalls).toBe(3);
  });

  it("evicts old identity entries at bounded capacity", async () => {
    const remote = upstream();
    const first = await fixture();
    expectExpiry(await first.list(), remote.expiry);
    const userIds = Array.from({ length: 129 }, () => {
      return `user_expiry_${randomUUID()}`;
    });
    const owners = new Set(userIds);
    context.mocks.clerk.authenticateRequest.mockImplementation((request) => {
      if (!(request instanceof Request)) {
        throw new Error("Expected a Clerk authentication request");
      }
      const userId = request.headers.get("authorization")?.slice(7);
      if (!userId || !owners.has(userId)) {
        throw new Error("Expected a capacity-test owner token");
      }
      return Promise.resolve({
        isAuthenticated: true,
        toAuth: () => {
          return { userId, orgId: first.orgId, orgRole: "org:admin" };
        },
      });
    });
    const app = setupApp({
      context,
      routes: [...routes, ...featureSwitchesRoutes],
    });
    const providers = app(personalModelProvidersMainContract);
    const switches = app(featureSwitchesContract);
    // Fresh users in this non-staff organization already use legacy bindings.
    // Verify that public context once instead of writing the same disabled
    // override for all 129 independent owners.
    const defaults = await accept(
      switches.get({ headers: { authorization: `Bearer ${userIds[0]}` } }),
      [200],
    );
    expect(defaults.body.effectiveSwitches).toMatchObject({
      [FeatureSwitchKey.PersonalModelProviderAccounts]: false,
    });
    // Each API-created owner occupies a connect binding and a legacy binding.
    // More than 256 bindings must evict the oldest, without time manipulation.
    // Token-scoped Clerk responses let independent owners prepare concurrently
    // without racing the shared session mock or creating unrelated organizations.
    // Keep eight owners in flight without waiting for a whole batch's slowest
    // request before starting the next owner.
    const remainingOwners = userIds.values();
    const preparations = await Promise.allSettled(
      Array.from({ length: 8 }, async () => {
        for (const userId of remainingOwners) {
          const ownerHeaders = { authorization: `Bearer ${userId}` };
          await accept(
            providers.upsert({
              headers: ownerHeaders,
              body: {
                type: "codex-oauth-token",
                authMethod: "auth_json",
                secrets: { CODEX_AUTH_JSON: credentials().raw },
              },
            }),
            [200, 201],
          );
          const listed = await accept(
            providers.list({ headers: ownerHeaders }),
            [200],
          );
          expectExpiry(listed.body.modelProviders, remote.expiry);
        }
      }),
    );
    // Join every worker before restoring the first owner's session, including
    // when another owner's request or expiry assertion fails.
    for (const preparation of preparations) {
      if (preparation.status === "rejected") {
        throw preparation.reason;
      }
    }
    const before = remote.detailsCalls;
    remote.expiry = new Date(now() + 7_200_000).toISOString();
    expectExpiry(await first.list(), remote.expiry);
    expect(remote.detailsCalls).toBe(before + 1);
  });
});
