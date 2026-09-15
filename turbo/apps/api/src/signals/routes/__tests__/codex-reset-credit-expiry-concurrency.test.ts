import { describe, expect, it, onTestFinished } from "vitest";
import { HttpResponse } from "msw";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import {
  createCodexExpiryFixture,
  expectExpiry,
  expiryResponse,
  upstream,
} from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const fixture = createCodexExpiryFixture(context);

function controller() {
  const value = new AbortController();
  onTestFinished(() => {
    return value.abort();
  });
  return value;
}

describe("Codex expiry concurrent readers and cancellation", () => {
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
});
