// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { waitFor, screen, cleanup } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import { startPage, setupPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { initPostHog } from "../../../lib/posthog.ts";
const context = testContext();
const host = "app.okou.ai";
const markers = {
  tgUser: "79000888",
  tgUserName: "river_private",
  tgDisplayName: "MorganPrivate",
  ts: "1795059444",
  sig: "68".repeat(32),
} as const;
function destination(path: string, privateFields: Record<string, string>) {
  const url = new URL(path, "https://" + host);
  url.searchParams.append("context", "desktop");
  for (const [key, value] of Object.entries(privateFields)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.append("context", "follow-up");
  url.hash = "#public-notes";
  return url;
}
async function redirect(url: URL) {
  await startPage({
    context,
    auth: null,
    host,
    path: url.pathname + url.search + url.hash,
  });
  await waitFor(() => {
    expect(location.pathname).toBe("/sign-in");
  });
  const signin = new URL(location.href);
  expect(signin.searchParams.get("redirect_url")).toBe(url.href);
  cleanup();
  return signin;
}
function publicContext(value: unknown, path: string) {
  if (typeof value !== "string") {
    throw new Error("Expected a diagnostic URL");
  }
  const parsed = new URL(value);
  expect(parsed.pathname).toBe(path);
  expect(parsed.searchParams.getAll("context")).toStrictEqual([
    "desktop",
    "follow-up",
  ]);
  expect(parsed.hash).toBe("#public-notes");
}
test.each([
  ["002", "/settings/telegram"],
  ["003", "/telegram/connect"],
  ["004", "/SETTINGS/telegram/"],
])(
  "integration-url-diagnostics-%s %s preserves the signed sign-in return while protecting its diagnostic copies",
  async (_id, path) => {
    const original = destination(path, markers);
    const info = vi.spyOn(console, "info");
    await redirect(original);
    const records = info.mock.calls.flat().filter(
      (
        value,
      ): value is {
        currentUrl: string;
        signInUrl: string;
        redirectUrl: string;
      } => {
        return (
          typeof value === "object" && value !== null && "signInUrl" in value
        );
      },
    );
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      publicContext(record.currentUrl, path);
      publicContext(record.redirectUrl, path);
      publicContext(
        new URL(record.signInUrl).searchParams.get("redirect_url"),
        path,
      );
    }
    for (const privateValue of Object.values(markers)) {
      expect(JSON.stringify(info.mock.calls)).not.toContain(privateValue);
    }
  },
);
const phoneFields = {
  handle: "15558884731",
  agent: "private-assistant-argos",
  ts: "1795059555",
  sig: "92".repeat(32),
} as const;
const callbackFields = {
  code: "local-slack-response",
  state: "local-consent-state",
} as const;
const analyticsRoutes: readonly [string, string, Record<string, string>][] = [
  ["009", "/settings/agentphone", phoneFields],
  ["010", "/settings/telegram", markers],
  ["011", "/telegram/connect", markers],
  ["012", "/SETTINGS/telegram/", markers],
  ["013", "/connectors/slack/callback", callbackFields],
];
test.each(analyticsRoutes)(
  "integration-url-diagnostics-%s %s keeps private analytics fields out of the event while preserving the browser return",
  async (_id, path, fields) => {
    const original = destination(path, fields);
    if (path === "/connectors/slack/callback") {
      original.searchParams.set("integration", "slack");
    }
    const analytics = context.mocks.posthog();
    const signin = await redirect(original);
    await setupPage({
      context: createTestRuntime(context),
      auth: null,
      host: signin.host,
      path: signin.pathname + signin.search + signin.hash,
    });
    await screen.findByTestId("clerk-sign-in");
    // Page setup starts the Router. The deployed document initializes the SDK separately.
    initPostHog();
    const process = analytics.initializations.at(-1)?.config?.before_send;
    if (typeof process !== "function") {
      throw new Error("Sign-in did not initialize the analytics event filter");
    }
    const other = "https://docs.example.org/channels?source=phone";
    const plain = "Opened channel preferences";
    const event = {
      uuid: crypto.randomUUID(),
      event: "channel continuation",
      properties: {
        $current_url: signin.href,
        $referrer: original.href,
        $initial_referrer: original.href,
        $set: { $last_current_url: original.href },
        $set_once: { $initial_referrer: original.href },
        help: other,
        note: plain,
      },
      $set: { $referrer: original.href },
      $set_once: { $initial_current_url: signin.href },
    };
    const before = structuredClone(event);
    const filtered = process(event);
    expect(event).toStrictEqual(before);
    if (!filtered) {
      throw new Error("Expected an analytics event");
    }
    expect(filtered.properties).toMatchObject({ help: other, note: plain });
    for (const privateValue of Object.values(fields)) {
      expect(JSON.stringify(filtered)).not.toContain(privateValue);
    }
    const direct = [
      filtered.properties.$referrer,
      filtered.properties.$initial_referrer,
      filtered.properties.$set?.$last_current_url,
      filtered.properties.$set_once?.$initial_referrer,
      filtered.$set?.$referrer,
    ];
    for (const value of direct) {
      publicContext(value, original.pathname);
    }
    for (const wrapped of [
      filtered.properties.$current_url,
      filtered.$set_once?.$initial_current_url,
    ]) {
      publicContext(
        new URL(String(wrapped)).searchParams.get("redirect_url"),
        original.pathname,
      );
    }
    expect(new URL(location.href).searchParams.get("redirect_url")).toBe(
      original.href,
    );
  },
);
