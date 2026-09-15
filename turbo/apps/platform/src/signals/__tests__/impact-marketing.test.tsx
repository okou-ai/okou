import { nowDate } from "../../lib/time.ts";
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

test("The authenticated app binds consented Marketing attribution without a feature override", async () => {
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
      data: { type: "okou:acquisition:ready" },
      origin: "https://attacker.example",
      source: frame.contentWindow,
    }),
  );
  await Promise.resolve();
  expect(posted).not.toHaveBeenCalled();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "okou:acquisition:ready" },
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
  expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  expect(posted).toHaveBeenCalledTimes(1);
});

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
