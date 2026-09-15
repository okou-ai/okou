import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { HttpResponse } from "msw";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { historicalCodexReconnectFixture } from "../../../test-fixtures/historical-subscription-writer";
import { createDeferredPromise } from "../../utils";
import { codexDeviceAuthRoutes } from "../codex-device-auth";
import { mockCodexDeviceAuthProvider } from "./helpers/api-bdd-auth-device";
import {
  createCodexExpiryFixture,
  credentials,
  expiryResponse,
  headers,
  jwt,
  upstream,
} from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const fixture = createCodexExpiryFixture(context);

async function addAccount(accountId: string) {
  mockCodexDeviceAuthProvider({ tokenScope: "personal", accountId });
  const device = setupApp({ context, routes: codexDeviceAuthRoutes })(
    codexDeviceAuthContract,
  );
  const started = await accept(
    device.start({ headers, body: { scope: "personal", mode: "add" } }),
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
}

async function legacyRotation(
  owner: { orgId: string; userId: string },
  auth: ReturnType<typeof credentials>,
) {
  // Today's API cannot execute API 1.595.0's singleton-only transaction.
  await historicalCodexReconnectFixture(owner, {
    accessToken: auth.accessToken,
    accountId: auth.accountId,
    refreshToken: `legacy-refresh-${randomUUID()}`,
    idToken: jwt({ email: "expiry@example.com" }),
    expiresAt: new Date(now() + 7_200_000),
  });
}

describe("legacy subscription import expiry isolation", () => {
  it.each([false, true])(
    "preserves unrelated Retry-After across an old same-identity rotation, priority=%s",
    async (priority) => {
      mockNow(Date.UTC(2030, 0, 1));
      const remote = upstream();
      const a = await fixture({
        accounts: true,
        priority,
        orgId: `org_${randomUUID()}`,
        userId: `user_${randomUUID()}`,
      });
      const bIdentity = randomUUID();
      const b = await addAccount(bIdentity);
      const bRequests: string[] = [];
      remote.details = (request) => {
        if (request.headers.get("chatgpt-account-id") === bIdentity) {
          bRequests.push(request.url);
          return new HttpResponse(null, {
            status: 429,
            headers: { "Retry-After": "120" },
          });
        }
        return expiryResponse(remote.expiry);
      };
      const cooled = await a.list();
      expect(cooled).toContainEqual(
        expect.objectContaining({
          id: b,
          subscriptionResetCreditsNextExpiresAt: null,
        }),
      );
      expect(bRequests).toHaveLength(1);
      const start = now();
      const rotated = credentials(a.auth.accountId);
      await legacyRotation(a, rotated);
      remote.details = (request) => {
        if (request.headers.get("chatgpt-account-id") === bIdentity) {
          bRequests.push(request.url);
        } else {
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${rotated.accessToken}`,
          );
        }
        return expiryResponse(remote.expiry);
      };
      for (const elapsed of [0, 119_999]) {
        mockNow(start + elapsed);
        const listed = await a.list();
        expect(listed).toContainEqual(
          expect.objectContaining({
            id: a.id,
            isActive: true,
            subscriptionResetCreditsNextExpiresAt: remote.expiry,
          }),
        );
        expect(listed).toContainEqual(
          expect.objectContaining({
            id: b,
            subscriptionResetCreditsNextExpiresAt: null,
          }),
        );
        expect(bRequests).toHaveLength(1);
      }
      mockNow(start + 120_000);
      await expect(a.list()).resolves.toContainEqual(
        expect.objectContaining({
          id: b,
          subscriptionResetCreditsNextExpiresAt: remote.expiry,
        }),
      );
      expect(bRequests).toHaveLength(2);
    },
  );

  it("preserves an unrelated cached expiry across an old same-identity rotation", async () => {
    mockNow(Date.UTC(2030, 0, 1));
    const remote = upstream();
    const a = await fixture({
      accounts: true,
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    });
    const bIdentity = randomUUID();
    const b = await addAccount(bIdentity);
    await expect(a.list()).resolves.toContainEqual(
      expect.objectContaining({
        id: b,
        subscriptionResetCreditsNextExpiresAt: remote.expiry,
      }),
    );
    await legacyRotation(a, credentials(a.auth.accountId));
    const requests: (string | null)[] = [];
    const freshExpiry = new Date(now() + 7_200_000).toISOString();
    remote.details = (request) => {
      requests.push(request.headers.get("chatgpt-account-id"));
      return expiryResponse(freshExpiry);
    };
    await expect(a.list()).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: a.id,
          subscriptionResetCreditsNextExpiresAt: freshExpiry,
        }),
        expect.objectContaining({
          id: b,
          subscriptionResetCreditsNextExpiresAt: remote.expiry,
        }),
      ]),
    );
    expect(requests).toStrictEqual([a.auth.accountId]);
  });

  it.each(["same-identity", "replacement", "reuse"] as const)(
    "preserves B's held HTTP flight and fences affected A across legacy %s",
    async (mutation) => {
      const remote = upstream();
      const a = await fixture({
        accounts: true,
        orgId: `org_${randomUUID()}`,
        userId: `user_${randomUUID()}`,
      });
      const bIdentity = randomUUID();
      const b = await addAccount(bIdentity);
      const reusedIdentity = randomUUID();
      const reused =
        mutation === "reuse" ? await addAccount(reusedIdentity) : null;
      const aStarted = createDeferredPromise<void>(context.signal);
      const bStarted = createDeferredPromise<void>(context.signal);
      const reusedStarted = createDeferredPromise<void>(context.signal);
      const releaseA = createDeferredPromise<Response>(context.signal);
      const releaseB = createDeferredPromise<Response>(context.signal);
      const requests: (string | null)[] = [];
      let bSignal: AbortSignal | undefined;
      remote.details = (request) => {
        const identity = request.headers.get("chatgpt-account-id");
        requests.push(identity);
        if (identity === bIdentity) {
          bSignal = request.signal;
          bStarted.resolve();
          return releaseB.promise;
        }
        if (identity === a.auth.accountId) {
          aStarted.resolve();
        } else {
          reusedStarted.resolve();
        }
        return releaseA.promise;
      };
      const oldRead = a.list();
      const reads = [oldRead];
      onTestFinished(async () => {
        if (!releaseA.settled()) {
          releaseA.resolve(expiryResponse(null));
        }
        if (!releaseB.settled()) {
          releaseB.resolve(expiryResponse(null));
        }
        await Promise.allSettled(reads);
      });
      await Promise.all([aStarted.promise, bStarted.promise]);
      if (reused) {
        await reusedStarted.promise;
      }
      const next = credentials(
        mutation === "same-identity"
          ? a.auth.accountId
          : mutation === "reuse"
            ? reusedIdentity
            : randomUUID(),
      );
      await legacyRotation(a, next);
      const imported = createDeferredPromise<void>(context.signal);
      const freshExpiry = new Date(now() + 7_200_000).toISOString();
      remote.details = (request) => {
        requests.push(request.headers.get("chatgpt-account-id"));
        if (request.headers.get("chatgpt-account-id") === next.accountId) {
          expect(request.headers.get("authorization")).toBe(
            `Bearer ${next.accessToken}`,
          );
          imported.resolve();
        }
        return expiryResponse(freshExpiry);
      };
      const freshRead = a.list();
      reads.push(freshRead);
      await imported.promise;
      expect(bSignal).toMatchObject({ aborted: false });
      releaseB.resolve(expiryResponse(remote.expiry));
      const current = await freshRead;
      expect(current).toContainEqual(
        expect.objectContaining({
          id: b,
          subscriptionResetCreditsNextExpiresAt: remote.expiry,
        }),
      );
      expect(current).toContainEqual(
        expect.objectContaining({
          ...(mutation === "same-identity"
            ? { id: a.id }
            : reused
              ? { id: reused }
              : {}),
          isActive: true,
          subscriptionResetCreditsNextExpiresAt: freshExpiry,
        }),
      );
      const stale = await oldRead;
      expect(stale).toContainEqual(
        expect.objectContaining({
          id: a.id,
          subscriptionResetCreditsNextExpiresAt: null,
        }),
      );
      if (reused) {
        expect(stale).toContainEqual(
          expect.objectContaining({
            id: reused,
            subscriptionResetCreditsNextExpiresAt: null,
          }),
        );
      }
      releaseA.resolve(expiryResponse(remote.expiry));
      const listed = await a.list();
      expect(listed).toContainEqual(
        expect.objectContaining({
          id: b,
          subscriptionResetCreditsNextExpiresAt: remote.expiry,
        }),
      );
      expect(listed).toContainEqual(
        expect.objectContaining({
          isActive: true,
          subscriptionResetCreditsNextExpiresAt: freshExpiry,
        }),
      );
      expect(
        requests.filter((identity) => {
          return identity === bIdentity;
        }),
      ).toHaveLength(1);
    },
  );
});
