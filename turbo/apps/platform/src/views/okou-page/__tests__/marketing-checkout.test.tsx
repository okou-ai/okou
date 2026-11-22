import { mockNow } from "../../../lib/time.ts";
import { DetachedBrowserContext } from "happy-dom";
import { billingCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  billing,
  setBilling,
  openWorkspace,
} from "./workspace-billing-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  promptEvent,
  RUN_THREAD_ID,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
const context = testContext();
async function paywall() {
  const run = crypto.randomUUID();
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        seqId: 1,
        runId: run,
        text: "Prepare harbor notes",
      }),
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: null,
        error: "insufficient_credits",
        seqId: 2,
        createdAt: "2026-08-01T10:00:02Z",
        runId: run,
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: null,
        failureReason: "insufficient_credits",
        runLifecycleEvent: "failed",
        seqId: 3,
        createdAt: "2026-08-01T10:00:03Z",
        runId: run,
      },
    ],
  });
  setBilling(context, () => {
    return billing("limited-free-1", { credits: 0 });
  });
  await openWorkspace(context, RUN_PATH);
  return await findFastControl("button", "Upgrade to Pro");
}
test("marketing-checkout-001 Ctrl-click opens the Stripe checkout while its authenticated marketing receipt is still pending", async () => {
  const stripe = "https://checkout.example.test/stripe/harbor",
    event = context.mocks.deferred<{
      request: Request;
      body: { tag: string; eventId: string };
    }>(),
    gate = context.mocks.deferred<void>();
  context.mocks.http.get(stripe, () => {
    return new HttpResponse("<title>Harbor checkout</title>", {
      headers: { "Content-Type": "text/html" },
    });
  });
  context.mocks.http.post("*/api/events", async ({ request }) => {
    const body = (await request.json()) as { tag: string; eventId: string };
    if (body.tag === "checkout-start") {
      event.resolve({ request, body });
      await gate.promise;
    }
    return HttpResponse.json({ ok: true });
  });
  context.mocks.api(billingCheckoutContract.create, ({ respond }) => {
    return respond(200, { url: stripe });
  });
  const tabs = vi.spyOn(DetachedBrowserContext.prototype, "newPage"),
    upgrade = await paywall();
  fireEvent.click(upgrade, { ctrlKey: true });
  const { request, body } = await event.promise;
  expect(body.eventId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  expect(request.credentials).toBe("include");
  expect(request.headers.get("authorization")).toMatch(/^Bearer .+$/u);
  expect(request.headers.get("content-type")).toMatch(/application\/json/u);
  await waitFor(() => {
    expect(
      tabs.mock.results.some((r) => {
        return r.value.url === stripe;
      }),
    ).toBeTruthy();
  });
  expect(request.signal.aborted).toBeFalsy();
  expect(location.pathname).toBe(RUN_PATH);
  gate.resolve();
  for (const entry of tabs.mock.results) {
    await entry.value.close();
  }
});
test("marketing-checkout-003 confirming an expired Pro quote keeps both quoted amounts and the retry action visible", async () => {
  const expiry = context.mocks.deferred<string>();
  context.mocks.api(billingCheckoutContract.create, ({ body, respond }) => {
    if (body.previewToken) {
      expiry.resolve(body.previewToken);
      return respond(409, {
        error: {
          code: "BILLING_PREVIEW_EXPIRED",
          message: "The plan quote expired",
        },
      });
    }
    return respond(200, {
      status: "preview",
      tier: "pro",
      purchaseType: "plan",
      immediateAmountCents: 2000,
      nextRecurringAmountCents: 2000,
      currency: "usd",
      previewToken: "local-pro-quote",
      expiresAt: "2026-03-15T12:10:00Z",
    });
  });
  click(await paywall());
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    return expect(within(dialog).getAllByText("$20.00")).toHaveLength(2);
  });
  const confirm = await findFastControl("button", "Upgrade to Pro", dialog);
  mockNow(new Date("2026-03-15T12:11:00Z"), context.signal);
  click(confirm);
  await expect(expiry.promise).resolves.toBe("local-pro-quote");
  await within(dialog).findByText("Could not prepare the subscription change.");
  expect(within(dialog).getAllByText("$20.00")).toHaveLength(2);
  expect(confirm).toBeEnabled();
});
