import { nowDate } from "../../lib/time.ts";
import {
  marketingShadowEnabled$,
  pendingMarketingEvents$,
} from "../bootstrap/marketing-events.ts";
import { capturePaidOnboardingStepViewed$ } from "../bootstrap/paid-funnel-telemetry.ts";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { setupPage } from "../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  mockAgent,
  mockOrgModelRoutes,
} from "../../views/okou-page/__tests__/chat-composer-test-helpers.ts";

const IFRAME_URL = "https://www.okou.ai/finish-onboarding";

test.each(["okou:acquisition:ready", "okou:impact:ready"])(
  "The app retains the Impact handoff with %s",
  async (readyType) => {
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    context.mocks.api(impactMarketingContract.handoff, ({ respond }) => {
      return respond(200, {
        handoff: {
          token: "dedicated-proof",
          nonce: "expected-nonce",
          iframeUrl: IFRAME_URL,
        },
      });
    });
    context.mocks.browser.cookie(
      `okou_impact=${encodeURIComponent(JSON.stringify({ clickId: "old-cookie", capturedAt: nowDate().toISOString() }))}`,
    );
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat?im_ref=ignored-query`,
    });
    await screen.findByRole("textbox", { name: "Message" });
    const frame = await waitFor(() => {
      const candidate = document.querySelector<HTMLIFrameElement>(
        `iframe[src="${IFRAME_URL}"]`,
      );
      expect(candidate).not.toBeNull();
      if (!candidate) {
        throw new Error("Expected the Marketing iframe");
      }
      return candidate;
    });
    expect(frame).not.toBeVisible();
    // The shared happy-dom setup disables iframe loading. Supply the browser
    // boundary here while exercising the real identity-only App handoff.
    vi.spyOn(frame, "contentWindow", "get").mockReturnValue(window);
    const posted = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: readyType },
        origin: "https://attacker.example",
        source: frame.contentWindow,
      }),
    );
    await Promise.resolve();
    expect(posted).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: readyType },
        origin: "https://www.okou.ai",
        source: frame.contentWindow,
      }),
    );
    await waitFor(() => {
      return expect(posted).toHaveBeenCalledWith(
        {
          type: "okou:impact:identify",
          token: "dedicated-proof",
          nonce: "expected-nonce",
        },
        "https://www.okou.ai",
      );
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "okou:acquisition:complete", nonce: "wrong" },
        origin: "https://www.okou.ai",
        source: frame.contentWindow,
      }),
    );
    await Promise.resolve();
    expect(posted).toHaveBeenCalledTimes(1);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "okou:acquisition:complete", nonce: "expected-nonce" },
        origin: "https://www.okou.ai",
        source: frame.contentWindow,
      }),
    );
    expect(
      screen.getByRole("textbox", { name: "Message" }),
    ).toBeInTheDocument();
    expect(posted).toHaveBeenCalledTimes(1);
  },
);

test("The app remains usable when the API has not enabled identity handoff", async () => {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await screen.findByRole("textbox", { name: "Message" });
  expect(document.querySelector(`iframe[src="${IFRAME_URL}"]`)).toBeNull();
});

test("The trusted Marketing switch controls observations without interrupting Impact", async () => {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  const requests: unknown[] = [];
  context.mocks.api(impactMarketingContract.handoff, ({ body, respond }) => {
    requests.push(body);
    return respond(200, {
      handoff: {
        token: "dedicated-proof",
        nonce: "expected-nonce",
        iframeUrl: IFRAME_URL,
      },
    });
  });
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });
  await screen.findByRole("textbox", { name: "Message" });
  const frame = await waitFor(() => {
    const candidate = document.querySelector<HTMLIFrameElement>(
      `iframe[src="${IFRAME_URL}"]`,
    );
    expect(candidate).not.toBeNull();
    if (!candidate) {
      throw new Error("Expected Marketing iframe");
    }
    return candidate;
  });
  vi.spyOn(frame, "contentWindow", "get").mockReturnValue(window);
  const posted = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  const announce = (
    enabled: boolean,
    origin = "https://www.okou.ai",
    source: Window | null = window,
  ) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "okou:acquisition:ready", shadowEnabled: enabled },
        origin,
        source,
      }),
    );
  };
  expect(requests).toStrictEqual([{}]);
  announce(false);
  await waitFor(() => {
    expect(posted).toHaveBeenCalledTimes(1);
  });
  expect(context.store.get(marketingShadowEnabled$)).toBeFalsy();
  announce(true, "https://attacker.example");
  announce(true, "https://www.okou.ai", null);
  expect(context.store.get(marketingShadowEnabled$)).toBeFalsy();
  await context.store.set(
    capturePaidOnboardingStepViewed$,
    "make",
    context.signal,
  );
  expect(context.store.get(pendingMarketingEvents$)).toHaveLength(0);

  announce(true);
  await waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  expect(requests[1]).toStrictEqual({
    acquisition: { version: 2, checkSignup: true, events: [] },
  });
  await waitFor(() => {
    expect(posted).toHaveBeenCalledTimes(2);
  });
  await context.store.set(
    capturePaidOnboardingStepViewed$,
    "make",
    context.signal,
  );
  expect(context.store.get(pendingMarketingEvents$)).toHaveLength(1);
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "okou:acquisition:complete", nonce: "expected-nonce" },
      origin: "https://www.okou.ai",
      source: window,
    }),
  );
  await waitFor(() => {
    expect(posted).toHaveBeenCalledTimes(3);
  });
  expect(requests[2]).toMatchObject({
    acquisition: { events: [{ name: "StepViewed" }] },
  });

  // Disable during an in-flight handoff. Unacknowledged observations must not
  // survive the pause, and a delayed completion must not restore them.
  announce(false);
  await waitFor(() => {
    expect(posted).toHaveBeenCalledTimes(4);
  });
  expect(requests[3]).toStrictEqual({});
  expect(context.store.get(pendingMarketingEvents$)).toHaveLength(0);
  await context.store.set(
    capturePaidOnboardingStepViewed$,
    "make",
    context.signal,
  );
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "okou:acquisition:complete", nonce: "expected-nonce" },
      origin: "https://www.okou.ai",
      source: window,
    }),
  );
  announce(true);
  await waitFor(() => {
    expect(requests).toHaveLength(5);
  });
  expect(requests[4]).toStrictEqual({
    acquisition: { version: 2, checkSignup: true, events: [] },
  });
  expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
});
