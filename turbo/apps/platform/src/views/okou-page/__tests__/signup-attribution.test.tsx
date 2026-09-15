import { expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  mockAgent,
  mockOrgModelRoutes,
} from "./chat-composer-test-helpers.ts";

test("App ignores legacy attribution and does not upload a signup conversion", async () => {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  const signup = vi.fn<() => void>();
  const tag = vi.fn<() => void>();
  vi.stubGlobal("gtag", tag);
  context.mocks.api(
    acquisitionAttributionContract.recordSignup,
    ({ respond }) => {
      signup();
      return respond(200, { recorded: true, googleAdsAccountId: "7935750692" });
    },
  );
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?gclid=legacy-click&utm_source=google`,
  });
  await screen.findByRole("textbox", { name: "Message" });
  expect(signup).not.toHaveBeenCalled();
  expect(tag).not.toHaveBeenCalled();
  expect(
    document.querySelector('script[src*="googletagmanager.com"]'),
  ).toBeNull();
});
