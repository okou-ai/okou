import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { createDeferredPromise, resetSignal } from "../../utils.ts";
import { recordSignupAttribution$ } from "../signup-attribution.ts";
import { bootstrapGoogleAdsConversionMilestones$ } from "../google-ads-conversion-milestones.ts";
import {
  capturePaidOnboardingRedirectToStripe$,
  capturePaidOnboardingStepViewed$,
} from "../paid-funnel-telemetry.ts";

const context = testContext();
const NOW = Date.parse("2026-09-16T09:00:00Z");
const NEW_ACCOUNT = "7935750692";
const OLD_ACCOUNT = "1001302527";
const resetCaller$ = resetSignal();

// Attribution request suppression and independently cancelled telemetry have
// no page-visible controls. Boot the production Router, navigate through links
// where available, and exercise its background entry points otherwise. The
// external request budget is the performance contract under test; no cache or
// internal state is inspected or installed.

function installGtag() {
  const gtag = vi.fn<(...args: unknown[]) => void>();
  vi.stubGlobal("gtag", gtag);
  return gtag;
}

async function openPage(path: string, heading: string | RegExp) {
  const link = queryAllByRoleFast("link").find((item) => {
    return item.getAttribute("href") === path;
  });
  if (!link) {
    throw new Error(`Missing navigation to ${path}`);
  }
  click(link);
  await expect(
    screen.findByRole("heading", { name: heading }),
  ).resolves.toBeInTheDocument();
}

test("Navigation reuses a successful signup no-op without granting a conversion", async () => {
  mockNow(NOW, context.signal);
  const gtag = installGtag();
  let signupReads = 0;
  let milestoneReads = 0;
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ respond }) => {
      signupReads += 1;
      return respond(200, { recorded: false, googleAdsAccountId: NEW_ACCOUNT });
    },
  );
  context.mocks.api(
    acquisitionAttributionContract.googleAdsMilestones,
    ({ respond }) => {
      milestoneReads += 1;
      return respond(200, { milestones: [], googleAdsAccountId: null });
    },
  );
  await setupPage({
    context,
    path: "/agents?gclid=first-touch",
    auth: {
      user: {
        id: "recent-user",
        fullName: "Recent User",
        createdAt: new Date(NOW),
      },
    },
  });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  await openPage("/works", /^Where .+ works$/u);
  // Milestone bootstrap follows the completed signup check in route setup.
  await waitFor(() => {
    expect(milestoneReads).toBe(2);
  });
  await openPage("/agents", "Agents");
  await waitFor(() => {
    expect(milestoneReads).toBe(3);
  });
  expect(signupReads).toBe(1);
  expect(gtag).not.toHaveBeenCalled();
});

test("Changed attribution and active organization remain eligible for signup checks", async () => {
  const received: (string | undefined)[] = [];
  const gtag = installGtag();
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ body, respond }) => {
      received.push(body.attribution.ga_client_id);
      return respond(200, { recorded: false, googleAdsAccountId: NEW_ACCOUNT });
    },
  );
  await setupPage({ context, path: "/agents?gclid=first-touch" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  context.mocks.browser.cookie("_ga=GA1.1.123.456");
  await context.store.set(recordSignupAttribution$, context.signal);
  context.mocks.clerk().organization({
    activeOrg: { id: "org_second", name: "Second Organization" },
  });
  context.mocks.clerk().stateChanged();
  await context.store.set(recordSignupAttribution$, context.signal);
  await context.store.set(recordSignupAttribution$, context.signal);
  expect(received).toStrictEqual([undefined, "123.456", "123.456"]);
  expect(gtag).not.toHaveBeenCalled();
});

test("A known other-account milestone bootstrap completes while unknown ownership can resolve later", async () => {
  let milestoneReads = 0;
  let accountId: string | null = null;
  context.mocks.api(
    acquisitionAttributionContract.googleAdsMilestones,
    ({ respond }) => {
      milestoneReads += 1;
      return respond(200, { milestones: [], googleAdsAccountId: accountId });
    },
  );
  await setupPage({ context, path: "/agents" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  accountId = OLD_ACCOUNT;
  await context.store.set(
    bootstrapGoogleAdsConversionMilestones$,
    context.signal,
  );
  await openPage("/works", /^Where .+ works$/u);
  await context.store.set(
    bootstrapGoogleAdsConversionMilestones$,
    context.signal,
  );
  expect(milestoneReads).toBe(2);
});

test("Concurrent onboarding and checkout lookups share work without sharing caller cancellation", async () => {
  const gate = createDeferredPromise<void>(context.signal);
  let accountReads = 0;
  const gtag = installGtag();
  context.mocks.api(
    acquisitionAttributionContract.resolveGoogleAdsAccount,
    async ({ respond }) => {
      accountReads += 1;
      await gate.promise;
      return respond(200, { googleAdsAccountId: NEW_ACCOUNT });
    },
  );
  await setupPage({ context, path: "/agents" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  const caller = context.store.set(resetCaller$, context.signal);
  const outcomes = Promise.allSettled([
    context.store.set(capturePaidOnboardingStepViewed$, "make", caller),
    context.store.set(
      capturePaidOnboardingRedirectToStripe$,
      "test",
      context.signal,
    ),
  ]);
  await waitFor(() => {
    expect(accountReads).toBe(1);
  });
  context.store.set(resetCaller$);
  gate.resolve();
  const results = await outcomes;
  expect(results[0]).toMatchObject({
    status: "rejected",
    reason: { name: "AbortError" },
  });
  expect(results[1]).toStrictEqual({ status: "fulfilled", value: undefined });
  expect(accountReads).toBe(1);
  expect(gtag.mock.calls).toStrictEqual([
    [
      "event",
      "conversion",
      expect.objectContaining({
        send_to: "AW-18407336975/hWi8CPWRrOccEI_YpslE",
      }),
    ],
  ]);
});

test("Unresolved ownership retries and known ownership serves subsequent telemetry", async () => {
  let accountReads = 0;
  const gtag = installGtag();
  context.mocks.api(
    acquisitionAttributionContract.resolveGoogleAdsAccount,
    ({ respond }) => {
      accountReads += 1;
      return respond(200, {
        googleAdsAccountId: accountReads === 1 ? null : NEW_ACCOUNT,
      });
    },
  );
  await setupPage({ context, path: "/agents" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  await context.store.set(
    capturePaidOnboardingStepViewed$,
    "make",
    context.signal,
  );
  expect(gtag).not.toHaveBeenCalled();
  await context.store.set(
    capturePaidOnboardingRedirectToStripe$,
    "test",
    context.signal,
  );
  await context.store.set(
    capturePaidOnboardingStepViewed$,
    "make",
    context.signal,
  );
  expect(accountReads).toBe(2);
  expect(gtag).toHaveBeenCalledTimes(2);
});

test("Failed ownership work is released for a later caller", async () => {
  let accountReads = 0;
  const gtag = installGtag();
  context.mocks.api(
    acquisitionAttributionContract.resolveGoogleAdsAccount,
    ({ respond }) => {
      accountReads += 1;
      return accountReads === 1
        ? respond(500, {
            error: { code: "INTERNAL_SERVER_ERROR", message: "Unavailable" },
          })
        : respond(200, { googleAdsAccountId: NEW_ACCOUNT });
    },
  );
  await setupPage({ context, path: "/agents" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  await expect(
    context.store.set(capturePaidOnboardingStepViewed$, "make", context.signal),
  ).rejects.toBeDefined();
  await context.store.set(
    capturePaidOnboardingStepViewed$,
    "make",
    context.signal,
  );
  expect(accountReads).toBe(2);
  expect(gtag).toHaveBeenCalledTimes(1);
});

test("An old identity response cannot deliver a conversion after account switching", async () => {
  const gate = createDeferredPromise<void>(context.signal);
  let accountReads = 0;
  const gtag = installGtag();
  context.mocks.api(
    acquisitionAttributionContract.resolveGoogleAdsAccount,
    async ({ respond }) => {
      accountReads += 1;
      if (accountReads === 1) {
        await gate.promise;
        return respond(200, { googleAdsAccountId: NEW_ACCOUNT });
      }
      return respond(200, { googleAdsAccountId: OLD_ACCOUNT });
    },
  );
  await setupPage({ context, path: "/agents" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  const first = Promise.allSettled([
    context.store.set(capturePaidOnboardingStepViewed$, "make", context.signal),
  ]);
  await waitFor(() => {
    expect(accountReads).toBe(1);
  });
  context.mocks
    .clerk()
    .user(
      { id: "second-user", fullName: "Second User" },
      { id: "second-session", token: "second-token" },
    );
  context.mocks.clerk().stateChanged();
  gate.resolve();
  await expect(first).resolves.toMatchObject([
    { status: "rejected", reason: { name: "AbortError" } },
  ]);
  await context.store.set(
    capturePaidOnboardingStepViewed$,
    "make",
    context.signal,
  );
  expect(gtag.mock.calls).toStrictEqual([
    [
      "event",
      "conversion",
      expect.objectContaining({
        send_to: "AW-18144854014/GVKdCLbQ9LscEP7_kcxD",
      }),
    ],
  ]);
});

test("A signup check invalidates an earlier account decision", async () => {
  let accountReads = 0;
  const gtag = installGtag();
  context.mocks.api(
    acquisitionAttributionContract.resolveGoogleAdsAccount,
    ({ respond }) => {
      accountReads += 1;
      return respond(200, {
        googleAdsAccountId: accountReads === 1 ? OLD_ACCOUNT : NEW_ACCOUNT,
      });
    },
  );
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ respond }) => {
      return respond(200, { recorded: false, googleAdsAccountId: NEW_ACCOUNT });
    },
  );
  await setupPage({ context, path: "/agents" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  context.mocks.browser.cookie("_ga=GA1.1.123.456");
  await context.store.set(
    capturePaidOnboardingStepViewed$,
    "make",
    context.signal,
  );
  await context.store.set(recordSignupAttribution$, context.signal);
  await context.store.set(
    capturePaidOnboardingRedirectToStripe$,
    "test",
    context.signal,
  );
  expect(accountReads).toBe(2);
  expect(gtag.mock.calls).toStrictEqual([
    [
      "event",
      "conversion",
      expect.objectContaining({
        send_to: "AW-18144854014/GVKdCLbQ9LscEP7_kcxD",
      }),
    ],
    [
      "event",
      "conversion",
      expect.objectContaining({
        send_to: "AW-18407336975/hWi8CPWRrOccEI_YpslE",
      }),
    ],
  ]);
});
