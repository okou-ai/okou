import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import {
  createCodexExpiryFixture,
  expectExpiry,
  upstream,
} from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const codexOwner = createCodexExpiryFixture(context);

/** The details endpoint fails with the given status while usage still reports two credits. */
async function failingDetailsOwner(status: 401 | 500) {
  const control = upstream();
  control.usage = () => {
    return HttpResponse.json({
      rate_limit_reset_credits: { available_count: 2 },
    });
  };
  control.details = () => {
    return HttpResponse.json({ error: "unexpected" }, { status });
  };
  const owner = await codexOwner();
  return { control, owner };
}

describe("Codex expiry metadata resilience", () => {
  it("codex-reset-credit-expiry-018 omits the expiry after an unexpected 401 failure and preserves the count", async () => {
    const { control, owner } = await failingDetailsOwner(401);

    const providers = await owner.list();

    expectExpiry(providers, null, 2);
    expect(control.detailsCalls).toBe(2);
  });

  it("codex-reset-credit-expiry-019 omits the expiry after an unexpected 500 failure and preserves the count", async () => {
    const { control, owner } = await failingDetailsOwner(500);

    const providers = await owner.list();

    expectExpiry(providers, null, 2);
    expect(control.detailsCalls).toBe(2);
  });

  it("codex-reset-credit-expiry-002 omits past expiry both on a cache hit and in upstream details", async () => {
    const start = now();
    mockNow(start);
    const control = upstream();
    const expiry = new Date(start + 1000).toISOString();
    control.expiry = expiry;
    const owner = await codexOwner();

    const fresh = await owner.list();
    mockNow(start + 1000);
    const atExpiry = await owner.list();
    mockNow(start + 1000 + 5 * 60_000);
    const later = await owner.list();

    expectExpiry(fresh, expiry);
    expectExpiry(atExpiry, null);
    expectExpiry(later, null);
    expect(control.detailsCalls).toBe(3);
  });
});
