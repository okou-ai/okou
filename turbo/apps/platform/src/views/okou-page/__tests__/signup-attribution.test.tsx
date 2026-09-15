import { screen, waitFor } from "@testing-library/react";
import {
  acquisitionAttributionContract,
  type AdAttributionMetadata,
} from "@okouai/api-contracts/contracts/acquisition-attribution";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const SIGNUP_SEND_TO = "AW-18144854014/OlLBCNXGgqwcEP7_kcxD";
const ADSMARCH_SIGNUP_SEND_TO = "AW-18407336975/8mCZCLORrOccEI_YpslE";

type Gtag = (...args: unknown[]) => void;
type MarketingWindow = Window & {
  dataLayer?: unknown[][];
  gtag?: Gtag;
};

function installGtagMock(): ReturnType<typeof vi.fn<Gtag>> {
  const marketingWindow = window as MarketingWindow;
  const originalGtag = marketingWindow.gtag;
  const gtag = vi.fn<Gtag>();
  marketingWindow.gtag = gtag;
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalGtag) {
        marketingWindow.gtag = originalGtag;
      } else {
        Reflect.deleteProperty(marketingWindow, "gtag");
      }
    },
    { once: true },
  );
  return gtag;
}

function installQueuedGtag(): MarketingWindow {
  const marketingWindow = window as MarketingWindow;
  const originalDataLayer = marketingWindow.dataLayer;
  const originalGtag = marketingWindow.gtag;
  const dataLayer: unknown[][] = [];
  marketingWindow.dataLayer = dataLayer;
  marketingWindow.gtag = (...args: unknown[]) => {
    dataLayer.push(args);
  };
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalDataLayer) {
        marketingWindow.dataLayer = originalDataLayer;
      } else {
        Reflect.deleteProperty(marketingWindow, "dataLayer");
      }
      if (originalGtag) {
        marketingWindow.gtag = originalGtag;
      } else {
        Reflect.deleteProperty(marketingWindow, "gtag");
      }
    },
    { once: true },
  );
  return marketingWindow;
}

function setGoogleAnalyticsCookie(value: string): void {
  context.mocks.browser.cookie(`_ga=${encodeURIComponent(value)}`);
}

function setupAttributionPage(
  createdAt = new Date(NOW),
  paidAttribution = false,
): Promise<void> {
  mockNow(NOW, context.signal);
  const attribution = new URLSearchParams({
    source_type: "paid",
    gclid: "click-123",
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "signup-campaign",
    vm0_source: "homepage",
  });
  return setupPage({
    context,
    path: paidAttribution ? `/agents?${attribution.toString()}` : "/agents",
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Test User",
        email: "test@example.com",
        createdAt,
      },
    },
  });
}

async function waitForAgentsPage(): Promise<void> {
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
}

function getLinkByPath(path: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    const href = candidate.getAttribute("href");
    return href ? new URL(href, location.href).pathname === path : false;
  });
  if (!link) {
    throw new Error(`Expected link to ${path}`);
  }
  return link;
}

async function openWorksPage(): Promise<void> {
  click(getLinkByPath("/works"));
  await expect(
    screen.findByRole("heading", { name: /^Where .+ works$/u }),
  ).resolves.toBeInTheDocument();
}

test.each([
  {
    accountId: "1001302527",
    sendTo: SIGNUP_SEND_TO,
    otherSendTo: ADSMARCH_SIGNUP_SEND_TO,
  },
  {
    accountId: "7935750692",
    sendTo: ADSMARCH_SIGNUP_SEND_TO,
    otherSendTo: SIGNUP_SEND_TO,
  },
])(
  "A first-time sign-up queues only the verified $accountId action",
  async ({ accountId, sendTo, otherSendTo }) => {
    const marketingWindow = installQueuedGtag();
    context.mocks.api(
      acquisitionAttributionContract.recordSignup,
      ({ respond }) => {
        return respond(200, { recorded: true, googleAdsAccountId: accountId });
      },
    );

    await setupAttributionPage(new Date(NOW), true);
    await waitForAgentsPage();

    expect(marketingWindow.dataLayer).toContainEqual([
      "event",
      "conversion",
      expect.objectContaining({ send_to: sendTo }),
    ]);
    expect(marketingWindow.dataLayer).not.toContainEqual([
      "event",
      "conversion",
      expect.objectContaining({ send_to: otherSendTo }),
    ]);
  },
);

test("A malformed analytics cookie is ignored", async () => {
  const gtag = installGtagMock();
  let attributionRequests = 0;
  setGoogleAnalyticsCookie("not-a-ga-cookie");
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ respond }) => {
      attributionRequests += 1;
      return respond(200, { recorded: true, googleAdsAccountId: null });
    },
  );

  await setupAttributionPage(new Date(NOW - 31 * 60 * 1000));
  await waitForAgentsPage();

  expect(attributionRequests).toBe(0);
  expect(gtag).not.toHaveBeenCalled();
});

test("An older account does not trigger a new sign-up conversion", async () => {
  const gtag = installGtagMock();
  let attributionRequests = 0;
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ respond }) => {
      attributionRequests += 1;
      return respond(200, { recorded: true, googleAdsAccountId: null });
    },
  );

  await setupAttributionPage(new Date(NOW - 31 * 60 * 1000), true);
  await waitForAgentsPage();

  expect(attributionRequests).toBe(1);
  expect(gtag).not.toHaveBeenCalled();
});

test("A paid sign-up is attributed and converted once", async () => {
  const gtag = installGtagMock();
  let recordedAttribution: AdAttributionMetadata | undefined;
  let attributionRequests = 0;
  setGoogleAnalyticsCookie("GA1.1.123456789.987654321");
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ body, respond }) => {
      attributionRequests += 1;
      recordedAttribution = body.attribution;
      return respond(200, { recorded: true, googleAdsAccountId: "7935750692" });
    },
  );

  await setupAttributionPage(new Date(NOW), true);
  await waitForAgentsPage();
  expect(recordedAttribution).toStrictEqual({
    source_type: "paid",
    gclid: "click-123",
    gclid_present: "true",
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "signup-campaign",
    vm0_source: "homepage",
    ga_client_id: "123456789.987654321",
  });
  expect(gtag).toHaveBeenCalledWith(
    "event",
    "conversion",
    expect.objectContaining({
      send_to: ADSMARCH_SIGNUP_SEND_TO,
      value: 1,
      currency: "USD",
      transaction_id: "test-user-123",
    }),
  );

  await openWorksPage();
  expect(attributionRequests).toBe(1);
  expect(gtag).toHaveBeenCalledTimes(1);
});

test("A recent organic sign-up records its analytics client identifier", async () => {
  const gtag = installGtagMock();
  let recordedAttribution: AdAttributionMetadata | undefined;
  setGoogleAnalyticsCookie("GA1.1.123456789.987654321");
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ body, respond }) => {
      recordedAttribution = body.attribution;
      return respond(200, { recorded: true, googleAdsAccountId: null });
    },
  );

  await setupAttributionPage();
  await waitForAgentsPage();

  expect(recordedAttribution).toStrictEqual({
    ga_client_id: "123456789.987654321",
  });
  expect(gtag).not.toHaveBeenCalled();
});

test("Previously recorded server attribution prevents a duplicate conversion", async () => {
  const gtag = installGtagMock();
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ respond }) => {
      return respond(200, { recorded: false, googleAdsAccountId: null });
    },
  );

  await setupAttributionPage(new Date(NOW), true);
  await waitForAgentsPage();

  expect(gtag).not.toHaveBeenCalled();
});

test("A temporary attribution failure does not block Platform", async () => {
  let attributionRequests = 0;
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ respond }) => {
      attributionRequests += 1;
      if (attributionRequests === 1) {
        return respond(401, {
          error: { code: "UNAUTHORIZED", message: "Not authenticated" },
        });
      }
      return respond(200, { recorded: true, googleAdsAccountId: null });
    },
  );

  await setupAttributionPage(new Date(NOW), true);
  await waitForAgentsPage();
  expect(attributionRequests).toBe(1);

  click(getLinkByPath("/works"));

  await waitFor(() => {
    expect(attributionRequests).toBe(2);
  });
  await expect(
    screen.findByRole("heading", { name: /^Where .+ works$/u }),
  ).resolves.toBeInTheDocument();
});

test.each([
  { source: "url", brand: "okou" },
  { source: "cookie", brand: "okou" },
  { source: "url", brand: "vm0" },
  { source: "cookie", brand: "vm0" },
])(
  "$brand campaign IDs from the $source reach signup in the canonical API fields",
  async ({ source, brand }) => {
    mockNow(NOW, context.signal);
    let recordedAttribution: AdAttributionMetadata | undefined;
    context.mocks.api(
      acquisitionAttributionContract.recordSignup,
      ({ body, respond }) => {
        recordedAttribution = body.attribution;
        return respond(200, { recorded: true, googleAdsAccountId: null });
      },
    );
    const attribution = `gclid=original-click&${brand}_campaign_id=24220469665&${brand}_ad_group_id=123456`;
    if (source === "cookie") {
      context.mocks.browser.cookie(
        `vm0_attribution=${encodeURIComponent(attribution)}`,
      );
    }
    await setupPage({
      context,
      path: source === "url" ? `/agents?${attribution}` : "/agents",
      auth: {
        user: {
          id: "test-user-123",
          fullName: "Test User",
          email: "test@example.com",
          createdAt: new Date(NOW),
        },
      },
    });
    await waitForAgentsPage();
    expect(recordedAttribution).toMatchObject({
      gclid: "original-click",
      okou_campaign_id: "24220469665",
      okou_ad_group_id: "123456",
    });
  },
);

test("An unresolved signup can be sent after its account is verified", async () => {
  const gtag = installGtagMock();
  let accountId: string | null = null;
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ respond }) => {
      return respond(200, { recorded: true, googleAdsAccountId: null });
    },
  );
  context.mocks.api(
    acquisitionAttributionContract.resolveGoogleAdsAccount,
    ({ respond }) => {
      return respond(200, { googleAdsAccountId: accountId });
    },
  );
  await setupAttributionPage(new Date(NOW), true);
  await waitForAgentsPage();
  expect(gtag).not.toHaveBeenCalled();
  accountId = "7935750692";
  await openWorksPage();
  await waitFor(() => {
    return expect(gtag).toHaveBeenCalledTimes(1);
  });
  expect(gtag).toHaveBeenCalledWith(
    "event",
    "conversion",
    expect.objectContaining({
      send_to: ADSMARCH_SIGNUP_SEND_TO,
      transaction_id: "test-user-123",
    }),
  );
});

test("A returning user records Google Ads campaign context while Marketing owns the referral", async () => {
  mockNow(NOW, context.signal);
  const gtag = installGtagMock();
  let receivedSignup: unknown;
  context.mocks.browser.cookie(
    `okou_impact=${encodeURIComponent(JSON.stringify({ clickId: "shared-partner", capturedAt: new Date(NOW).toISOString() }))}`,
  );
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ body, respond }) => {
      receivedSignup = body;
      return respond(200, { recorded: false, googleAdsAccountId: null });
    },
  );
  await setupPage({
    context,
    path: "/agents?im_ref=partner-click&gclid=original-click&okou_campaign_id=24220469665&okou_ad_group_id=123456",
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Test User",
        email: "test@example.com",
        createdAt: new Date(NOW - 86_400_000),
      },
    },
  });
  await waitForAgentsPage();
  await waitFor(() => {
    expect(receivedSignup).toStrictEqual({
      attribution: {
        gclid: "original-click",
        gclid_present: "true",
        okou_campaign_id: "24220469665",
        okou_ad_group_id: "123456",
      },
    });
  });
  expect(gtag).not.toHaveBeenCalled();
});
