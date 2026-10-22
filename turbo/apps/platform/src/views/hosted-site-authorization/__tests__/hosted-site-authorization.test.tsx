import { waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { startPage } from "../../../__tests__/page-helper.ts";

const context = testContext();
const siteId = "00000000-0000-4000-8000-000000000001";
const origin = "https://demo.okou.app";
const state = "a".repeat(43);
const codeChallenge = "b".repeat(43);
const path = `/hosted-site-authorize?${new URLSearchParams({ siteId, origin, state, codeChallenge })}`;

// The browser navigation is the external result; it must never carry a Clerk JWT.
test("the trusted App returns only a one-use authorization code to the exact site", async () => {
  const callbackUrl = `${origin}/.okou/auth/callback?code=${"c".repeat(64)}&state=${state}`;
  const redirect = vi
    .spyOn(window.location, "replace")
    .mockImplementation(() => {});
  context.mocks.api(
    hostContract.authorizeSiteSession,
    ({ body, params, respond }) => {
      expect(params.siteId).toBe(siteId);
      expect(body).toStrictEqual({ origin, state, codeChallenge });
      return respond(200, { callbackUrl });
    },
  );
  await startPage({ context, host: "app.okou.ai", path });
  await waitFor(() => {
    return expect(redirect).toHaveBeenCalledWith(callbackUrl);
  });
});

test("a denied website navigates to the dedicated access page", async () => {
  const redirect = vi
    .spyOn(window.location, "replace")
    .mockImplementation(() => {});
  context.mocks.api(hostContract.authorizeSiteSession, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Website access is unavailable" },
    });
  });
  await startPage({ context, host: "app.okou.ai", path });
  await waitFor(() => {
    expect(redirect).toHaveBeenCalledWith(
      `https://app.okou.ai/hosted-site-access?${new URLSearchParams({ url: `${origin}/`, reason: "denied" })}`,
    );
  });
});

test.each([401, 500] as const)(
  "authorization status %s preserves the website destination for recovery",
  async (status) => {
    const redirect = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {});
    context.mocks.api(hostContract.authorizeSiteSession, ({ respond }) => {
      return respond(status, {
        error: {
          code: status === 401 ? "UNAUTHORIZED" : "INTERNAL_SERVER_ERROR",
          message: "Authorization is unavailable",
        },
      });
    });
    await startPage({
      context,
      host: "app.okou.ai",
      path: `${path}&returnTo=${encodeURIComponent("/report?view=summary")}`,
    });
    await waitFor(() => {
      expect(redirect).toHaveBeenCalledWith(
        `https://app.okou.ai/hosted-site-access?${new URLSearchParams({ url: `${origin}/report?view=summary`, reason: status === 401 ? "authenticate" : "unavailable" })}`,
      );
    });
  },
);

test("sign-in returns to the trusted App bridge with the complete browser state", async () => {
  await startPage({ context, host: "app.okou.ai", path, auth: null });
  await waitFor(() => {
    return expect(window.location.pathname).toBe("/sign-in");
  });
  expect(
    new URL(window.location.href).searchParams.get("redirect_url") ??
      new URLSearchParams(new URL(window.location.href).hash.split("?")[1]).get(
        "redirect_url",
      ),
  ).toBe(`https://app.okou.ai${path}`);
});

test("organization selection preserves the bridge continuation", async () => {
  await startPage({
    context,
    host: "app.okou.ai",
    path,
    auth: {
      user: { id: "hosted-site-viewer", fullName: "Website Viewer" },
      organization: { activeOrg: null, memberships: [] },
    },
  });
  await waitFor(() => {
    return expect(window.location.pathname).toBe(
      "/sign-in/tasks/choose-organization",
    );
  });
  expect(
    new URL(window.location.href).searchParams.get("redirect_url") ??
      new URLSearchParams(new URL(window.location.href).hash.split("?")[1]).get(
        "redirect_url",
      ),
  ).toBe(`https://app.okou.ai${path}`);
});
