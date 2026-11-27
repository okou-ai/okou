import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  setupPage,
  startPage,
  type SetupPageAuth,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
const dev = "app.vm7.ai";
const user = { id: "mira", fullName: "Mira Han" } as const;
function destination(host: string) {
  const consent = new URL("https://" + host + "/oauth-consent");
  for (const [key, value] of [
    ["client_id", "journal-client"],
    ["response_type", "code"],
    ["state", "winter-31"],
    ["scope", "openid profile"],
    ["resource", "https://calendar.example"],
    ["resource", "https://journal.example"],
  ] as const) {
    consent.searchParams.append(key, value);
  }
  return consent.href;
}
function returning(to: string) {
  return new URLSearchParams({ redirect_url: to }).toString();
}
function visit(path: string, auth: SetupPageAuth = null, host = dev) {
  return setupPage({
    context,
    host,
    path,
    auth,
  });
}
test.each([
  ["001", dev],
  ["002", "app.okou.ai"],
] as const)(
  "auth-v1-oauth-%s Both login surfaces preserve the full consent request on %s",
  async (_id, host) => {
    const to = destination(host);
    await visit("/sign-in?" + returning(to), null, host);
    const form = await screen.findByTestId("clerk-sign-in");
    expect(form).toHaveAttribute("data-clerk-force-redirect-url", to);
    expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
      "data-sign-in-force-redirect-url",
      to,
    );
    expect(
      JSON.parse(
        screen.getByTestId("clerk-provider-config").dataset
          .clerkAllowedRedirectOrigins ?? "[]",
      ),
    ).toContain("https://" + host);
    const signup = new URL(form.dataset.clerkSignUpUrl ?? "", location.href);
    expect(signup.pathname).toBe("/sign-up");
    expect(signup.searchParams.get("redirect_url")).toBe(to);
  },
);
test.each([
  ["003", "sign-in", "sign-up"],
  ["004", "sign-up", "sign-in"],
] as const)(
  "auth-v1-oauth-%s A hash continuation on %s is offered on the opposite form",
  async (_id, mode, opposite) => {
    const to = destination(dev);
    await visit("/" + mode + "#/?" + returning(to));
    const form = await screen.findByTestId("clerk-" + mode);
    expect(form).toHaveAttribute("data-clerk-force-redirect-url", to);
    const link = new URL(
      form.getAttribute("data-clerk-" + opposite + "-url") ?? "",
      location.href,
    );
    expect(link.pathname).toBe("/" + opposite);
    expect(
      new URLSearchParams(link.hash.split("?")[1]).get("redirect_url"),
    ).toBe(to);
  },
);
test("auth-v1-oauth-015 A sibling path under consent stays a regular form return", async () => {
  const to = "https://app.vm7.ai/oauth-consent/other";
  await visit("/sign-in?" + returning(to));
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toHaveAttribute(
    "data-clerk-force-redirect-url",
    to,
  );
  expect(mockedClerk.redirectWithAuth).not.toHaveBeenCalled();
});
test.each([
  ["017", "sign-in"],
  ["018", "sign-up"],
] as const)(
  "auth-v1-oauth-%s An active session leaves %s for the SDK-decorated consent page",
  async (_id, mode) => {
    const to = destination(dev);
    const decorated = to + "&session_marker=issued-by-clerk";
    mockedClerk.buildUrlWithAuth.mockImplementation((uri) => {
      return uri + "&session_marker=issued-by-clerk";
    });
    await startPage({
      context,
      host: dev,
      path: "/" + mode + "?" + returning(to),
      auth: { user },
    });
    await waitFor(() => {
      expect(window.location.href).toBe(decorated);
    });
    expect(mockedClerk.redirectWithAuth.mock.calls).toStrictEqual([[to]]);
    expect(screen.queryByTestId("clerk-" + mode)).toBeNull();
  },
);
test.each([
  ["019", "/sign-in/tasks/choose-organization", ""],
  ["020", "/sign-in/factor-two", ""],
  ["022", "/sign-in", "&__clerk_ticket=invite-mira"],
  ["023", "/sign-in", "&prompt=login"],
] as const)(
  "auth-v1-oauth-%s Clerk retains the requested interactive step %s%s",
  async (_id, path, extra) => {
    await visit(path + "?" + returning(destination(dev)) + extra, { user });
    await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
    expect(mockedClerk.redirectWithAuth).not.toHaveBeenCalled();
  },
);
test.each([
  ["025", "prompt", "login"],
  ["027", "max_age", "0"],
] as const)(
  "auth-v1-oauth-%s A signed-out consent request with %s=%s shows sign-in",
  async (_id, key, value) => {
    const to = new URL(destination(dev));
    to.searchParams.set(key, value);
    await visit("/sign-in?" + returning(to.href));
    await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
    expect(mockedClerk.redirectWithAuth).not.toHaveBeenCalled();
  },
);
test("auth-v1-oauth-029 A pending organization task keeps the user at sign-in", async () => {
  await visit("/sign-in?" + returning(destination(dev)), {
    user: {
      ...user,
      clientSessions: [
        {
          id: "mira-pending",
          status: "pending",
          currentTask: { key: "choose-organization" },
        },
      ],
    },
  });
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  expect(mockedClerk.redirectWithAuth).not.toHaveBeenCalled();
});
