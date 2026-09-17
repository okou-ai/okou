import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getLinkByName,
  linksByName,
  setupSharedThreadPage,
  sharedThread,
  SHARED_THREAD_ID,
} from "./shared-thread-test-helpers.ts";

const context = testContext();

function getButtonByName(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

test("A visitor can continue a shared idea in Platform", async () => {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, sharedThread());
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByText("Make this conversation yours"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Try it yourself")).toBeInTheDocument();

  const handoffLink = getLinkByName("Try it yourself");
  const handoffUrl = new URL(handoffLink.getAttribute("href") ?? "");
  expect(handoffUrl.origin).toBe("https://app.okou.ai");
  expect(handoffUrl.pathname).toBe("/");
  expect(handoffUrl.searchParams.get("prompt")).toContain(
    `/share/threads/${SHARED_THREAD_ID}`,
  );

  const signInLinks = linksByName("Sign in");
  expect(signInLinks).toHaveLength(2);
  for (const signInLink of signInLinks) {
    const signInUrl = new URL(signInLink.getAttribute("href") ?? "");
    expect(signInUrl.pathname).toBe("/sign-in");
    expect(signInUrl.searchParams.get("redirect_url")).toBe(
      handoffUrl.toString(),
    );
  }
  const signUpUrl = new URL(
    getLinkByName("Sign up").getAttribute("href") ?? "",
  );
  expect(signUpUrl.pathname).toBe("/sign-up");
  expect(signUpUrl.searchParams.get("redirect_url")).toBe(
    handoffUrl.toString(),
  );
});

test("A signed-in viewer is not asked to sign in or sign up", async () => {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, sharedThread());
  });

  await setupSharedThreadPage(context, {
    host: "app.okou.ai",
    auth: { user: { id: "user_shared_thread_viewer", fullName: "Viewer" } },
  });

  await expect(
    screen.findByText("Make this conversation yours"),
  ).resolves.toBeInTheDocument();
  // The handoff itself stays: it carries this conversation into a new chat,
  // which is exactly what an account holder can act on.
  expect(getLinkByName("Try it yourself")).toBeInTheDocument();
  await waitFor(() => {
    expect(linksByName("Sign in")).toHaveLength(0);
    expect(linksByName("Sign up")).toHaveLength(0);
  });

  // Clerk republishes on every session-token refresh without the account
  // changing, and the viewer is the same member on the other side of it. The
  // prompts must not come back in the window the re-read is open.
  act(() => {
    context.mocks.clerk().stateChanged();
  });
  expect(linksByName("Sign in")).toHaveLength(0);
  expect(linksByName("Sign up")).toHaveLength(0);

  // ...nor once it closes.
  await act(async () => {
    await Promise.resolve();
  });
  expect(linksByName("Sign in")).toHaveLength(0);
  expect(linksByName("Sign up")).toHaveLength(0);
  expect(getLinkByName("Try it yourself")).toBeInTheDocument();
});

test("A visitor can copy complete public message content", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, {
      ...sharedThread(),
      messages: [
        {
          messageIndex: 0,
          role: "user",
          content: "What should we launch?",
          runIndex: 0,
        },
        {
          messageIndex: 1,
          role: "assistant",
          content: "The plain status is ready.",
          runIndex: 0,
        },
        {
          messageIndex: 2,
          role: "assistant",
          content: "Primary\n=\n\nLaunch the **public preview**.",
          runIndex: 0,
        },
        {
          messageIndex: 3,
          role: "assistant",
          content: "Secondary\n--",
          runIndex: 0,
        },
      ],
    });
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Public launch plan" }),
  ).resolves.toBeInTheDocument();
  const copyButtons = await waitFor(() => {
    const buttons = queryAllByRoleFast("button").filter((candidate) => {
      return candidate.getAttribute("aria-label") === "Copy message";
    });
    expect(buttons).toHaveLength(2);
    return buttons;
  });
  const userMessageCopy = copyButtons[0];
  const assistantResponseCopy = copyButtons[1];
  if (!userMessageCopy || !assistantResponseCopy) {
    throw new Error("Expected copy actions for both public messages");
  }

  click(userMessageCopy);

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual(["What should we launch?"]);
  });
  await expect(screen.findByText("Copied!")).resolves.toBeInTheDocument();

  click(assistantResponseCopy);

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([
      "What should we launch?",
      [
        "The plain status is ready.",
        "Primary\n=\n\nLaunch the **public preview**.",
        "Secondary\n--",
      ].join("\n\n"),
    ]);
  });
});

test("A visitor can copy the public conversation link", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, sharedThread());
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Public launch plan" }),
  ).resolves.toBeInTheDocument();
  const shareButton = getButtonByName("Share");

  click(shareButton);

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([
      `https://app.okou.ai/share/threads/${SHARED_THREAD_ID}`,
    ]);
  });
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
});
