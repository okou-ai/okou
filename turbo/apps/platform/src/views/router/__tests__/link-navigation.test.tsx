import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockAPIs(): void {
  context.mocks.data.agents([
    {
      agentId: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
    },
  ]);
}

test("An unknown route offers both of its destinations", async () => {
  mockAPIs();
  await setupPage({ context, path: "/missing-platform-route" });

  const homeLink = await waitFor(() => {
    const links = queryAllByRoleFast("link");
    const homeLink = links.find((link) => {
      return link.textContent?.trim() === "Back to home";
    });
    const workflowsLink = links.find((link) => {
      return link.textContent?.trim() === "Browse workflows";
    });
    if (!homeLink || !workflowsLink) {
      throw new Error("Not-found destinations not found");
    }

    expect(
      screen.getByRole("heading", { name: "That page isn't here." }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "It may have moved, or the link may be old. Everything else is where you left it.",
      ),
    ).toBeInTheDocument();
    expect(homeLink).toHaveAttribute("href", "/");
    expect(workflowsLink).toHaveAttribute("href", "/workflows");
    return homeLink;
  });

  fireEvent.click(homeLink);

  await waitFor(() => {
    expect(
      screen.queryByRole("heading", { name: "That page isn't here." }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("labeled-nav-rail")).getByText("Agents"),
    ).toBeInTheDocument();
  });
});

test("The Okou error page uses Okou support", async () => {
  await setupPage({
    context,
    path: "/_/error",
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(screen.getByText("support")).toHaveAttribute(
      "href",
      "mailto:contact@okou.ai",
    );
  });
});

test("Modified clicks open internal destinations in a new tab", async () => {
  mockAPIs();
  const openedTargets = context.mocks.browser.open();

  await setupPage({ context, path: "/" });

  const link = await waitFor(() => {
    const rail = screen.getByTestId("labeled-nav-rail");
    return within(rail).getByText("Agents").closest("a");
  });
  if (!link) {
    throw new Error("Agents link not found");
  }

  fireEvent.click(link);

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { level: 1, name: /agents/i }),
    ).toBeInTheDocument();
  });
  expect(openedTargets.calls).toStrictEqual([]);

  fireEvent.click(link, { metaKey: true });

  await waitFor(() => {
    expect(openedTargets.calls).toStrictEqual([
      expect.objectContaining({
        target: "_blank",
        url: expect.stringContaining("/agents"),
      }),
    ]);
  });
});

test("A valid sign-in ticket returns the user home", async () => {
  mockAPIs();

  await startPage({
    context,
    path: "/sign-in-token?token=clerk-ticket",
    auth: null,
  });

  await waitFor(() => {
    expect(pathname()).toBe("/");
  });
  expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
    strategy: "ticket",
    ticket: "clerk-ticket",
  });
  expect(mockedClerk.setActive).toHaveBeenCalledWith({
    navigate: expect.any(Function),
    session: "test-created-session-id",
  });
});

test("A valid sign-in ticket returns to its trusted Okou destination", async () => {
  const returnUrl = "https://app.okou.ai/agents?source=sign-in-ticket";
  mockAPIs();

  await startPage({
    context,
    host: "app.okou.ai",
    path: `/sign-in-token?token=clerk-ticket&redirect_url=${encodeURIComponent(
      returnUrl,
    )}`,
    auth: null,
  });

  await waitFor(() => {
    expect(location.href).toBe(returnUrl);
  });
  expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
    strategy: "ticket",
    ticket: "clerk-ticket",
  });
});
