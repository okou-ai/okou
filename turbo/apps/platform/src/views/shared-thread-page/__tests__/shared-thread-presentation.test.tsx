import { setupPage } from "../../../__tests__/page-helper.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  okouMessageAvatarStill,
  okouMessageAvatarAnimated,
  platformOkouWordmarkLightImg,
} from "../../../lib/static-assets.ts";
import {
  SHARED_THREAD_ID,
  setupSharedThreadPage,
  sharedThread,
  getLinkByName,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
const host = "app.okou.ai";

test("shared-thread-presentation-001 lets the signed-out reader return to a missing conversation after sign-in", async () => {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Unknown share" },
    });
  });
  await setupSharedThreadPage(context, { host });
  await expect(
    screen.findByText("You can’t view this chat"),
  ).resolves.toBeInTheDocument();
  const header = screen.getByRole("banner");
  expect(getLinkByName("Okou", header)).toHaveAttribute(
    "href",
    "https://app.okou.ai",
  );
  const back = new URL("https://app.okou.ai/sign-in");
  back.searchParams.set("redirect_url", location.href);
  expect(getLinkByName("Sign in", header)).toHaveAttribute("href", back.href);
  const recovery = screen.getByRole("main");
  expect(getLinkByName("Sign in", recovery)).toHaveAttribute("href", back.href);
  back.pathname = "/sign-up";
  expect(getLinkByName("Sign up", header)).toHaveAttribute("href", back.href);
});

test("shared-thread-presentation-002 reads the published heading hierarchy and emphasis in dark mode", async () => {
  context.mocks.browser.matchMedia((q) => {
    return q === "(prefers-color-scheme: dark)";
  });
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        title: "Public launch plan",
        messages: [
          {
            role: "user",
            messageIndex: 0,
            content: "Which phase ships first?",
          },
          {
            role: "assistant",
            messageIndex: 1,
            content:
              "# Primary\n\n## Secondary\n\nStart with the **public preview**.",
          },
        ],
      }),
    );
  });
  await setupSharedThreadPage(context, { host });
  await expect(
    screen.findByRole("heading", { level: 2, name: "Secondary" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { level: 1, name: "Primary" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("public preview", { selector: "strong" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Which phase ships first?")).toBeInTheDocument();
  const header = screen.getByRole("banner");
  expect(within(header).getByText("Public launch plan")).toBeInTheDocument();
  const home = getLinkByName("Okou", header);
  expect(home).toHaveAttribute("href", "https://app.okou.ai");
  expect(home.querySelector("img")).toHaveAttribute(
    "src",
    platformOkouWordmarkLightImg,
  );
  expect(screen.queryByTestId("rich-content-loading")).not.toBeInTheDocument();
});

test("shared-thread-presentation-005 keeps literal prompt emphasis beside a safe external link", async () => {
  const url = "https://example.com/report";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            role: "user",
            messageIndex: 0,
            content: `Compare ${url} with **bold** notes.`,
          },
        ],
      }),
    );
  });
  await setupSharedThreadPage(context, { host });
  const urlText = await screen.findByText(url, { selector: "a" });
  expect(urlText.parentElement).toBeVisible();
  expect(urlText.parentElement).toHaveTextContent(
    `Compare ${url} with **bold** notes.`,
  );
  expect(urlText).toHaveAttribute("href", url);
  expect(urlText).toHaveAttribute("target", "_blank");
  expect(urlText.getAttribute("rel")?.split(/\s+/u)).toStrictEqual(
    expect.arrayContaining(["noopener", "noreferrer"]),
  );
});

test.each([false, true])(
  "only the newest shared reply offers motion (name line: %s)",
  async (nameLine) => {
    context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
      return respond(
        200,
        sharedThread({
          messages: [
            {
              role: "assistant",
              messageIndex: 0,
              content: "First reply",
              runIndex: 0,
            },
            {
              role: "assistant",
              messageIndex: 1,
              content: "Latest reply",
              runIndex: 1,
            },
            { role: "user", messageIndex: 2, content: "One more question" },
          ],
        }),
      );
    });
    await setupPage({
      context,
      path: "/share/threads/" + SHARED_THREAD_ID,
      host,
      featureSwitches: {
        [FeatureSwitchKey.OkouAnimatedAvatar]: true,
        [FeatureSwitchKey.ChatReplyNameLine]: nameLine,
      },
    });
    const first = (await screen.findByText("First reply")).closest(
      '[data-role="assistant"]',
    );
    const latest = (await screen.findByText("Latest reply")).closest(
      '[data-role="assistant"]',
    );
    await waitFor(() => {
      expect(
        latest?.querySelector(
          'source[media="(prefers-reduced-motion: no-preference)"]',
        ),
      ).toHaveAttribute("srcset", okouMessageAvatarAnimated);
    });
    expect(first?.querySelector("img")).toHaveAttribute(
      "src",
      okouMessageAvatarStill,
    );
    expect(first?.querySelector("picture")).toBeNull();
    expect(latest?.querySelector("img")).toHaveAttribute(
      "src",
      okouMessageAvatarStill,
    );
  },
);
