import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { platformOkouWordmarkLightImg } from "../../../lib/static-assets.ts";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  createSidebarAccountHelpers,
  openAccountMenu,
} from "./sidebar-account-test-helpers.ts";

const context = testContext();
const { prepareDefaultAgent, setupAddAccountPage } =
  createSidebarAccountHelpers(context);

test.each(["success", "failure", "pending task"])(
  "Switch accounts: %s",
  async (outcome) => {
    prepareDefaultAgent();
    const sentry = context.mocks.sentry();
    initSentry();

    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      auth: {
        user: {
          id: "test-user-123",
          fullName: "Alex Rivera",
          email: "alex.rivera@example.test",
          imageUrl: "https://cdn.okou.test/users/alex.png",
          clientSessions: [
            {
              id: "test-session-id",
              status: "active",
              user: {
                fullName: "Alex Rivera",
                imageUrl: "https://cdn.okou.test/users/alex.png",
                primaryEmailAddress: {
                  emailAddress: "alex.rivera@example.test",
                },
              },
            },
            {
              id: "session-jamie",
              status: "active",
              ...(outcome === "pending task"
                ? { currentTask: { key: "choose-organization" } }
                : {}),
              user: {
                fullName: "Jamie Chen",
                imageUrl: "https://cdn.okou.test/users/jamie.png",
                primaryEmailAddress: {
                  emailAddress: "jamie.chen@example.test",
                },
              },
            },
          ],
        },
      },
    });

    const finishSwitch = context.mocks.deferred<void>();
    const setActive = mockedClerk.setActive.getMockImplementation();
    if (!setActive) {
      throw new Error("Expected the Clerk setActive mock");
    }
    let appWasUnmounted = false;
    mockedClerk.setActive.mockImplementation(async (params) => {
      appWasUnmounted =
        document.querySelector('[data-slot="app-shell"]') === null;
      await finishSwitch.promise;
      await setActive(params);
    });
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {});
    const lifecycle = window._okou;
    expect(
      document.querySelector('[data-slot="app-shell"]'),
    ).toBeInTheDocument();

    const menu = await openAccountMenu();
    click(within(menu).getByText("Switch account"));

    await waitFor(() => {
      expect(screen.getByText("Jamie Chen")).toBeInTheDocument();
      expect(screen.getByText("jamie.chen@example.test")).toBeInTheDocument();
    });

    click(await screen.findByText("Jamie Chen"));

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledWith(
        expect.objectContaining({ session: "session-jamie" }),
      );
    });
    expect(appWasUnmounted).toBeTruthy();
    expect(lifecycle?.rootSignal.aborted).toBeTruthy();
    expect(window._okou).toBe(lifecycle);
    expect(context.signal.aborted).toBeFalsy();
    expect(replace).not.toHaveBeenCalled();

    const failure = new Error("Session switch failed");
    if (outcome === "failure") {
      finishSwitch.reject(failure);
    } else {
      finishSwitch.resolve();
    }
    const destination =
      outcome === "pending task" ? "/sign-in/tasks/choose-organization" : "/";
    await waitFor(() => {
      expect(replace.mock.calls).toStrictEqual(
        outcome === "failure" ? [] : [[destination]],
      );
      expect(
        sentry.reports.some((report) => {
          return report.type === "exception" && report.error === failure;
        }),
      ).toBe(outcome === "failure");
    });
    expect(
      document.querySelector('[data-slot="app-shell"]'),
    ).not.toBeInTheDocument();
  },
);

test("Add account opens the hosted Clerk account switcher with the shared appearance", async () => {
  context.mocks.browser.matchMedia(true);
  const clerk = context.mocks.clerk();
  await setupAddAccountPage();
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");

  const menu = await openAccountMenu();
  click(within(menu).getByText("Add account"));

  await waitFor(() => {
    expect(mockedClerk.openSignIn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        appearance: expect.objectContaining({
          theme: "simple",
          options: expect.objectContaining({
            logoImageUrl: platformOkouWordmarkLightImg,
            logoLinkUrl: "/",
          }),
          elements: expect.objectContaining({
            formButtonPrimary: expect.stringContaining("bg-primary"),
            formFieldInput: expect.stringContaining("bg-input"),
          }),
        }),
        fallbackRedirectUrl: "/",
        forceRedirectUrl: "/",
      }),
    );
  });
  expect(clerk.uiRequests).toStrictEqual([
    "https://app.example.test/assets/clerk-ui-test.js",
  ]);
});

test("Sign out from the account menu", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const menu = await openAccountMenu();
  click(within(menu).getByText("Sign out"));

  await waitFor(() => {
    expect(mockedClerk.signOut).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "test-session-id",
        redirectUrl: expect.stringMatching(
          /(?=.*\/sign-in#\/\?)(?=.*redirect_url=)/,
        ),
      }),
    );
  });
});
