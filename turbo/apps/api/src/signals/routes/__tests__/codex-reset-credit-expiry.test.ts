import { describe, expect, it } from "vitest";
import { HttpResponse } from "msw";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import {
  createCodexExpiryFixture,
  expectExpiry,
  expiryResponse,
  upstream,
} from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const fixture = createCodexExpiryFixture(context);

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
});
