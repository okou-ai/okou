import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  sharedThreadVisibilityContract,
  type SharedThreadAudience,
} from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen, waitFor } from "@testing-library/react";
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

test.each([403, 404] as const)(
  "An unavailable shared conversation uses the same access page (%s)",
  async (status) => {
    context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
      return respond(status, {
        error: { code: "NOT_FOUND", message: "Shared conversation not found" },
      });
    });

    await setupSharedThreadPage(context);

    await expect(
      screen.findByRole("heading", {
        name: "You can’t view this conversation",
      }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(/It may be private or no longer available\./),
    ).toBeInTheDocument();
    expect(getLinkByName("Sign in")).toBeInTheDocument();
  },
);

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

function getRadioByName(name: string): HTMLElement {
  const group = screen.getByRole("radiogroup", { name: "Who can access" });
  const radio = queryAllByRoleFast("radio", group).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!radio) {
    throw new Error(`Expected radio named "${name}"`);
  }
  return radio;
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

test("The creator can manage visibility after reopening a shared conversation", async () => {
  let audience: SharedThreadAudience = "organization";
  const revision = "30000000-0000-4000-8000-000000000703";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, sharedThread());
  });
  context.mocks.api(sharedThreadVisibilityContract.get, ({ respond }) => {
    return respond(200, {
      id: SHARED_THREAD_ID,
      audience,
      revision,
      organization: { id: "org_owner", name: "Original workspace" },
    });
  });
  context.mocks.api(
    sharedThreadVisibilityContract.update,
    ({ body, respond }) => {
      audience = body.audience;
      return respond(200, {
        id: SHARED_THREAD_ID,
        audience,
        revision,
        organization: { id: "org_owner", name: "Original workspace" },
      });
    },
  );
  await setupSharedThreadPage(context, {
    host: "app.okou.ai",
    auth: { user: { id: "user_owner", fullName: "Owner" } },
    featureSwitches: { [FeatureSwitchKey.SharedThreadVisibility]: true },
  });
  click(getButtonByName("Share"));
  await waitFor(() => {
    expect(getRadioByName("Anyone at Original workspace")).toBeChecked();
  });
  click(getRadioByName("Only me"));
  await waitFor(() => {
    expect(getRadioByName("Only me")).toBeChecked();
  });
  expect(audience).toBe("private");
});
