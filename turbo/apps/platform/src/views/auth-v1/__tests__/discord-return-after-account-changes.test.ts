import { inspect } from "node:util";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import { startPage, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import { installPlatformLifecycle } from "../../../test/platform-lifecycle.ts";
import { findFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import {
  statusService,
  harbor,
} from "../../okou-page/__tests__/discord-consent-fixtures.ts";
const context = testContext();
const guild = "1000000000000045312",
  state = "D".repeat(43),
  proof = "P".repeat(43);
const pending = "/settings/discord?status=pending&guild_id=" + guild;
const entry =
  pending +
  "#" +
  new URLSearchParams({
    discord_oauth: "approve",
    state,
    approval_proof: proof,
  });
function browserRecords() {
  const messages: unknown[][] = [];
  for (const level of [
    "log",
    "info",
    "debug",
    "warn",
    "error",
    "trace",
    "table",
    "group",
    "groupCollapsed",
  ] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      messages.push(args);
    });
  }
  const storage = vi.spyOn(Storage.prototype, "setItem");
  return () => {
    return inspect(
      [
        messages,
        storage.mock.calls,
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ],
      { depth: null },
    );
  };
}
test.each([
  ["integration-continuation-034", "/sign-in"],
  ["integration-continuation-036", "/sign-in/tasks/choose-organization"],
] as const)(
  "%s Discord preserves only public callback context when routing to %s",
  async (_id, destination) => {
    const records = browserRecords();
    const auth =
      destination === "/sign-in"
        ? null
        : {
            user: { id: "visiting-member", fullName: "Studio member" },
            organization: {
              activeOrg: null,
              memberships: [{ id: "org_studio" }, { id: "org_guest" }],
            },
          };
    await startPage({ context, host: "app.okou.ai", path: entry, auth });
    await waitFor(() => {
      return expect(location.pathname).toBe(destination);
    });
    const outer = new URL(location.href);
    const back = outer.searchParams.get("redirect_url");
    expect(back).toBeTruthy();
    const target = new URL(back!);
    expect(target.origin).toBe("https://app.okou.ai");
    expect(target.pathname + target.search).toBe(pending);
    expect(target.hash).toBe("");
    expect(outer.href).not.toContain(proof);
    expect(outer.hash).toBe("");
    expect(records()).not.toContain(proof);
  },
);
test("integration-continuation-038 A replacement user opening the sanitized callback sees the interrupted result and can return to Works", async () => {
  const leaving = createTestRuntime(context);
  installPlatformLifecycle(leaving.signal);
  await startPage({
    context: leaving,
    host: "app.okou.ai",
    auth: null,
    path: entry,
  });
  await waitFor(() => {
    return expect(location.pathname).toBe("/sign-in");
  });
  const redirect = new URL(location.href).searchParams.get("redirect_url");
  expect(redirect).toBeTruthy();
  cleanup();
  vi.mocked(history.replaceState).mockRestore();
  leaving.dispose();
  const replacement = createTestRuntime(context);
  installPlatformLifecycle(replacement.signal);
  statusService(replacement, () => {
    return { isAvailable: true, isConnected: false };
  });
  await setupPage({
    context: replacement,
    host: "app.okou.ai",
    auth: harbor.auth,
    path: redirect!,
  });
  await screen.findByText("Connection failed");
  await screen.findByText("This authorization was interrupted or refreshed.");
  await expect(
    findFastControl("link", "Back to settings"),
  ).resolves.toHaveAttribute("href", "/works");
  expect(location.hash).toBe("");
});
