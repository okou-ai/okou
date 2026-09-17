import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { codexDeviceAuthRoutes } from "../codex-device-auth";
import { modelProvidersRoutes } from "../model-providers";
import { mockCodexDeviceAuthProvider } from "./helpers/api-bdd-auth-device";
import {
  createCodexExpiryFixture,
  credentials,
  detailsUrl,
  expectExpiry,
  expiryResponse,
  headers,
  upstream,
} from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const fixture = createCodexExpiryFixture(context);

describe("Codex expiry invalidation and identity isolation", () => {
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
});
