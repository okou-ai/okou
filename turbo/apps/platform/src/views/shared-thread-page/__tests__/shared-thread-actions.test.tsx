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
  setupSharedThreadPage,
  sharedThread,
  SHARED_THREAD_ID,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
const shareUrl = `https://app.okou.ai/share/threads/${SHARED_THREAD_ID}`;

function getButtonByName(name: string): HTMLElement {
  const button = queryAllByRoleFast("button", document.body).find(
    (candidate) => {
      return (
        candidate.textContent?.trim() === name ||
        candidate.getAttribute("aria-label") === name
      );
    },
  );
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

function accessChoices(): HTMLElement {
  return screen.getByRole("radiogroup", { name: "Who can access" });
}

function getRadioByName(name: string): HTMLElement {
  const radio = queryAllByRoleFast("radio", accessChoices()).find(
    (candidate) => {
      return (
        candidate.textContent?.trim() === name ||
        candidate.getAttribute("aria-label") === name
      );
    },
  );
  if (!radio) {
    throw new Error(`Expected radio named "${name}"`);
  }
  return radio;
}

function mockPublicConversation() {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, sharedThread());
  });
}

test("An unavailable shared conversation with status 404 offers sign-in", async () => {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Shared conversation not found" },
    });
  });

  await setupSharedThreadPage(context);

  await expect(
    screen.findByRole("heading", { name: "You can’t view this chat" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("main")).toHaveTextContent(
    "It may be private or no longer available.",
  );
  expect(getLinkByName("Sign in")).toBeInTheDocument();
});

test("A visitor copies a complete user message and assistant response", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
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
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const [userMessageCopy, assistantResponseCopy] = await waitFor(() => {
    const buttons = queryAllByRoleFast("button", document.body).filter(
      (candidate) => {
        return candidate.getAttribute("aria-label") === "Copy message";
      },
    );
    expect(buttons).toHaveLength(2);
    return buttons;
  });
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

test("A visitor copies the public conversation link from Share", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockPublicConversation();

  await setupSharedThreadPage(context, { host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Public launch plan" }),
  ).resolves.toBeInTheDocument();

  click(getButtonByName("Share"));
  await waitFor(() => {
    expect(getButtonByName("Copy link")).toBeEnabled();
  });
  click(getButtonByName("Copy link"));

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([shareUrl]);
  });
  await waitFor(() => {
    expect(getButtonByName("Copied")).toBeInTheDocument();
  });
});

test("The creator can copy the link and change workspace visibility to anyone with the link", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const update = context.mocks.deferred<void>();
  const refreshRequested = context.mocks.deferred<void>();
  const refresh = context.mocks.deferred<void>();
  let audience: SharedThreadAudience = "organization";
  let revision = "30000000-0000-4000-8000-000000000703";
  mockPublicConversation();
  context.mocks.api(sharedThreadVisibilityContract.get, async ({ respond }) => {
    if (audience === "private") {
      refreshRequested.resolve();
      await refresh.promise;
    }
    return respond(200, {
      id: SHARED_THREAD_ID,
      audience,
      revision,
      organization: { id: "org_owner", name: "Original workspace" },
    });
  });
  context.mocks.api(
    sharedThreadVisibilityContract.update,
    async ({ body, respond }) => {
      if (body.audience === "private") {
        await update.promise;
      }
      audience = body.audience;
      revision = "30000000-0000-4000-8000-000000000704";
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
  });

  click(getButtonByName("Share"));
  await waitFor(() => {
    expect(getRadioByName("Anyone at Original workspace")).toBeChecked();
  });
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([shareUrl]);
  });

  click(getRadioByName("Only me"));
  const choices = accessChoices();
  expect(choices).toHaveAttribute("aria-busy", "true");
  const options = queryAllByRoleFast("radio", choices);
  expect(options).toHaveLength(3);
  for (const option of options) {
    expect(option).not.toBeChecked();
    expect(option).toBeEnabled();
  }

  click(getRadioByName("Anyone with the link"));
  update.resolve();
  await refreshRequested.promise;
  expect(getRadioByName("Anyone at Original workspace")).toBeInTheDocument();
  expect(choices).toHaveAttribute("aria-busy", "true");
  expect(
    screen.queryByRole("status", { name: "Loading permissions" }),
  ).not.toBeInTheDocument();

  refresh.resolve();
  await waitFor(() => {
    expect(getRadioByName("Anyone with the link")).toBeChecked();
  });
  expect(choices).toHaveAttribute("aria-busy", "false");
});

test("A signed-in recipient copies the shared link without access controls", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockPublicConversation();
  context.mocks.api(sharedThreadVisibilityContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Shared conversation not found" },
    });
  });
  await setupSharedThreadPage(context, {
    host: "app.okou.ai",
    auth: { user: { id: "user_recipient", fullName: "Recipient" } },
  });

  click(getButtonByName("Share"));
  await waitFor(() => {
    expect(getButtonByName("Copy link")).toBeEnabled();
  });
  click(getButtonByName("Copy link"));

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([shareUrl]);
  });
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
});
