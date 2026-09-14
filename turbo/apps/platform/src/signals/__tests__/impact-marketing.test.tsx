import { nowDate } from "../../lib/time.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { setupPage } from "../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  mockAgent,
  mockOrgModelRoutes,
} from "../../views/okou-page/__tests__/chat-composer-test-helpers.ts";

const retiredStorage = sessionStorageSignals("okou.impactAttribution");
const IFRAME_URL = "https://www.okou.ai/finish-onboarding";

test("The authenticated app remains usable while Marketing binds consented attribution", async () => {
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
    featureSwitches: { [FeatureSwitchKey.ImpactMarketingAttribution]: true },
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
  expect(context.store.get(retiredStorage.get$)).toBeNull();
  // The shared happy-dom setup disables iframe loading. Supply the browser
  // boundary here while exercising the real identity-only App handoff.
  const frameWindow = vi
    .spyOn(frame, "contentWindow", "get")
    .mockReturnValue(window);
  const posted = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "okou:impact:ready" },
      origin: "https://attacker.example",
      source: frame.contentWindow,
    }),
  );
  await Promise.resolve();
  expect(posted).not.toHaveBeenCalled();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "okou:impact:ready" },
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
      data: { type: "okou:impact:complete", nonce: "wrong" },
      origin: "https://www.okou.ai",
      source: frame.contentWindow,
    }),
  );
  await Promise.resolve();
  expect(posted).toHaveBeenCalledTimes(1);
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "okou:impact:complete", nonce: "expected-nonce" },
      origin: "https://www.okou.ai",
      source: frame.contentWindow,
    }),
  );
  expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  expect(posted).toHaveBeenCalledTimes(1);
  posted.mockRestore();
  frameWindow.mockRestore();
  context.mocks.browser.cookie("");
});

test("A disabled migration does not load the Marketing iframe", async () => {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ImpactMarketingAttribution]: false },
  });
  await screen.findByRole("textbox", { name: "Message" });
  expect(document.querySelector(`iframe[src="${IFRAME_URL}"]`)).toBeNull();
});
