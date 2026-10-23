// @vitest-environment-options {"url":"https://app.okou.ai/"}

import { waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { CaptureResult } from "posthog-js/dist/module.slim";

import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { initPostHog } from "../../../lib/posthog.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

const context = testContext();
const PROOF_PATHS = [
  "/settings/telegram",
  "/telegram/connect",
  "/SETTINGS/telegram/",
  "/connectors/slack/callback",
  "/connectors/microsoft-365/callback",
  "/connectors/github/callback",
] as const;

function signedEntry(path: string): string {
  if (path.startsWith("/connectors/")) {
    return `https://app.okou.ai${path}?integration=${path.includes("microsoft-365") ? "teams" : path.includes("github") ? "github" : "slack"}&code=private-code&state=private-state&context=one&context=two#public-context`;
  }
  return `https://app.okou.ai${path}?bot=official&tgUser=99001&ts=1700000000&sig=private-signature-fixture&tgUserName=private-name&tgDisplayName=Private+Display&context=one&context=two#public-context`;
}

function expectRedacted(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const secret of [
    "99001",
    "1700000000",
    "private-signature-fixture",
    "private-name",
    "Private",
    "private-code",
    "private-state",
  ]) {
    // Boolean assertions avoid printing even fixture proof URLs on failure.
    expect(serialized.includes(secret)).toBeFalsy();
  }
}

test.each(PROOF_PATHS)(
  "%s redacts actual auth diagnostics while keeping signed browser navigation",
  async (path) => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const target = signedEntry(path);
    await startPage({ context, host: "app.okou.ai", path: target, auth: null });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/sign-in");
    });
    expect(logs.mock.calls.length).toBeGreaterThan(0);
    expectRedacted(logs.mock.calls);
    const authParams = new URLSearchParams(window.location.hash.split("?")[1]);
    expect(authParams.get("redirect_url") === target).toBeTruthy();
    expect(JSON.stringify(logs.mock.calls)).toContain(
      "context=one&context=two",
    );
  },
);

test("Query-form Clerk redirects redact the emitted redirectUrl diagnostic too", async () => {
  context.mocks.clerk();
  mockedClerk.buildSignInUrl.mockImplementation((options) => {
    const url = new URL("/sign-in", "https://app.okou.ai");
    url.searchParams.set("redirect_url", options?.redirectUrl ?? "");
    return url.href;
  });
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const target = signedEntry("/settings/telegram");
  await startPage({ context, host: "app.okou.ai", path: target, auth: null });
  await waitFor(() => {
    expect(window.location.pathname).toBe("/sign-in");
  });
  expectRedacted(logs.mock.calls);
  expect(
    new URL(window.location.href).searchParams.get("redirect_url") === target,
  ).toBeTruthy();
});

test.each(PROOF_PATHS)(
  "%s proofs stay out of PostHog URL, referrer and person properties",
  async (path) => {
    const posthog = context.mocks.posthog();
    const target = signedEntry(path);
    await setupPage({
      context,
      host: "app.okou.ai",
      path: `/sign-in#/?redirect_url=${encodeURIComponent(target)}`,
      auth: null,
      env: { VITE_POSTHOG_KEY: "phc_platform_test" },
    });
    initPostHog();
    const beforeSend = posthog.initializations.at(-1)?.config?.before_send;
    if (typeof beforeSend !== "function") {
      throw new Error("PostHog before_send was not configured");
    }
    const queryAuth = `https://app.okou.ai/sign-in/tasks/choose-organization?redirect_url=${encodeURIComponent(target)}`;
    // These are the installed SDK's event, attribution and person envelopes.
    const event: CaptureResult = {
      event: "$pageview",
      uuid: "public-event-id",
      properties: {
        $current_url: window.location.href,
        $referrer: queryAuth,
        $initial_current_url: target,
        $initial_referrer: target,
        $session_entry_url: queryAuth,
        $session_entry_referrer: target,
        return_url: target,
        $set: { $current_url: target },
        $set_once: { $initial_referrer: queryAuth },
        unrelated_url:
          "https://app.okou.ai/settings/slack?sig=public&context=one&context=two",
        label: "ordinary text",
      },
      $set: { $referrer: target },
      $set_once: { $initial_current_url: window.location.href },
    };
    const output = beforeSend(event);
    expectRedacted(output);
    const publicUrl = new URL(String(output?.properties.$initial_current_url));
    expect(publicUrl.searchParams.get("bot")).toBe(
      new URL(target).searchParams.get("bot"),
    );
    expect(publicUrl.searchParams.getAll("context")).toStrictEqual([
      "one",
      "two",
    ]);
    expect(publicUrl.hash).toBe("#public-context");
    expect(output?.properties.unrelated_url).toBe(
      event.properties.unrelated_url,
    );
    expect(output?.properties.label).toBe("ordinary text");
    expect(event.properties.$initial_current_url === target).toBeTruthy();
    expect(
      new URLSearchParams(window.location.hash.split("?")[1]).get(
        "redirect_url",
      ) === target,
    ).toBeTruthy();
  },
);
