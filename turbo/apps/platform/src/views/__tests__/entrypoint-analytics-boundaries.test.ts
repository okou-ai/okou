// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { startPlatformEntrypoint } from "../../lib/platform-entrypoint.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { prepareSignedOutDocument } from "./entrypoint-fixture.ts";

const context = testContext();

test("platform-entrypoint-023 The application removes Discord approval data before either analytics provider initializes", async () => {
  const clean = "https://app.okou.ai/works?discord=pending";
  const { sentry, posthog, root } = prepareSignedOutDocument(
    context,
    clean +
      "#discord_oauth=approve&state=local-state&approval_proof=local-proof",
  );
  const seen = new Map<string, string>();
  vi.spyOn(sentry.initializations, "push").mockImplementation((...events) => {
    seen.set("Sentry", location.href);
    return Array.prototype.push.apply(sentry.initializations, events);
  });
  vi.spyOn(posthog.initializations, "push").mockImplementation((...events) => {
    seen.set("PostHog", location.href);
    return Array.prototype.push.apply(posthog.initializations, events);
  });
  startPlatformEntrypoint();
  expect(location.href).toBe(clean);
  expect(Object.fromEntries(seen)).toStrictEqual({
    Sentry: clean,
    PostHog: clean,
  });
  await waitFor(() => {
    return expect(root.childElementCount).toBeGreaterThan(0);
  });
});

test.each([
  ["sentry-reporting-003", "/connectors/slack/callback"],
  ["sentry-reporting-004", "/connectors/microsoft-365/callback"],
  ["sentry-reporting-005", "/connectors/github/callback"],
  ["sentry-reporting-007", "/api/integrations/teams/oauth/callback"],
  ["sentry-reporting-008", "/api/github/app/setup/callback"],
])(
  "%s The reporting SDK filters the callback %s from errors and navigation",
  async (_id, path) => {
    const { sentry } = prepareSignedOutDocument(
      context,
      "https://app.okou.ai/sign-in",
    );
    startPlatformEntrypoint();
    await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
    const handler = sentry.initializations[0]?.options;
    const callback = new URL(path, location.origin);
    callback.search = new URLSearchParams({
      integration: "workspace",
      code: "fixture-code-78",
      state: "fixture-state-78",
    }).toString();
    const signIn = new URL("/sign-in", location.origin);
    signIn.searchParams.set("redirect_url", callback.href);
    const event = await handler?.beforeSend?.(
      { type: undefined, request: { url: callback.href } },
      {},
    );
    const navigated = handler?.beforeBreadcrumb?.(
      {
        category: "navigation",
        data: {
          from: "/",
          to: callback.pathname + callback.search,
          status_code: 200,
        },
      },
      {},
    );
    const redirected = await handler?.beforeSend?.(
      {
        type: undefined,
        request: {
          url: signIn.href,
          headers: { Referer: callback.href, "User-Agent": "FixtureDesktop" },
        },
      },
      {},
    );
    expect(event?.request?.url).toContain(path);
    expect(navigated?.data).toMatchObject({
      status_code: 200,
      to: expect.stringContaining(path),
    });
    expect(redirected?.request).toMatchObject({
      url: expect.stringContaining("/sign-in"),
      headers: {
        "User-Agent": "FixtureDesktop",
        Referer: expect.stringContaining(path),
      },
    });
    for (const received of [event, navigated, redirected]) {
      expect(JSON.stringify(received)).not.toMatch(
        /fixture-(?:code|state)-78/u,
      );
    }
  },
);
