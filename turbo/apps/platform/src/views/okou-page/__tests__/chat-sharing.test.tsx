import { sharedThreadVisibilityContract } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import {
  selectPassage,
  setPassageSelection,
} from "./chat-capability-test-helpers.ts";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  RUN_PATH,
  publishRunUpdate,
  findWorkHistoryToggle,
  assistantEvent,
  promptEvent,
  completedEvent,
} from "./chat-run-test-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function conversation(answer: string, refreshed = false) {
  const runId = crypto.randomUUID();
  const promptId = crypto.randomUUID();
  const answerId = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: promptId,
        runId,
        seqId: 1,
        text: "Inspect inventory",
      }),
      assistantEvent({
        id: answerId,
        runId,
        seqId: 2,
        text: answer,
      }),
      completedEvent({ id: crypto.randomUUID(), runId, seqId: 3 }),
    ],
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatShareRefresh]: refreshed },
  });
  return [promptId, answerId];
}

test("chat-sharing-001 toggling the prompt from its row label updates the selection once", async () => {
  await conversation("Inventory checked");
  click(await findFastControl("button", "Share messages"));
  const prompt = await screen.findByText("Inspect inventory");
  const share = await findFastControl("button", "Share");
  expect(share).toBeDisabled();
  const row = within(
    prompt.closest<HTMLElement>("[data-chat-share-selectable-group]")!,
  );
  click(row.getByText("Select message group"));
  await screen.findAllByText("1 selected");
  expect(row.getByRole("checkbox")).toBeChecked();
  expect(share).toBeEnabled();
  click(row.getByText("Deselect message group"));
  await waitFor(() => {
    return expect(share).toBeDisabled();
  });
  expect(row.getByRole("checkbox")).not.toBeChecked();
  await screen.findAllByText("0 selected");
});

test("chat-sharing-005 copying code and clicking the answer preserve the intended message selection", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await conversation(
    "Inventory checked. [Catalog](https://example.test/catalog)\n\n```sh\necho inventory\n```",
  );
  click(await findFastControl("button", "Share messages"));
  const share = await findFastControl("button", "Share");
  const link = await findFastControl("link", "Catalog");
  const row = within(
    link.closest<HTMLElement>("[data-chat-share-selectable-group]")!,
  );
  click(row.getByLabelText("Copy to clipboard"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual(["echo inventory\n"]);
  });
  expect(row.getByRole("checkbox")).not.toBeChecked();
  expect(share).toBeDisabled();
  click(row.getByText("Select message group"));
  expect(share).toBeEnabled();
  click(row.getByText(/Inventory checked\./));
  expect(row.getByRole("checkbox")).toBeChecked();
  expect(share).toBeEnabled();
});

test("chat-sharing-020 Escape dismisses the message audience menu and returns to Share", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await conversation("Inventory checked", true);
  const composer = await screen.findByRole("textbox", { name: /message/i });
  const share = await findFastControl("button", "Share message");
  click(share);
  await screen.findByRole("menu");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(share).toHaveFocus();
  });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([]);
  expect(composer).toBeInTheDocument();
});
function messageGroup(text: string) {
  return within(
    screen
      .getByText(text)
      .closest<HTMLElement>("[data-chat-share-selectable-group]")!,
  );
}

test("chat-sharing-007 public selection copies the snapshot and locks the answer group", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const snapshot = crypto.randomUUID();
  let submitted: unknown;
  context.mocks.api(
    sharedThreadVisibilityContract.create,
    ({ body, respond }) => {
      submitted = body;
      return respond(201, { id: snapshot });
    },
  );
  const ids = await conversation("Dispatch complete");
  click(await findFastControl("button", "Share messages"));
  for (const text of ["Inspect inventory", "Dispatch complete"]) {
    click(messageGroup(text).getByText("Select message group"));
  }
  click(await findFastControl("button", "Share"));
  const link = await screen.findByRole("textbox", { name: "Shared chat link" });
  expect(link).toHaveValue(location.origin + "/share/threads/" + snapshot);
  expect(submitted).toMatchObject({ eventIds: ids, audience: "public" });
  expect(clipboard.writes).toContain(
    location.origin + "/share/threads/" + snapshot,
  );
  const selection = messageGroup("Dispatch complete").getByRole("checkbox");
  click(selection);
  expect(selection).toBeChecked();
  expect(selectionPopup()).not.toBeInTheDocument();
});

test("chat-sharing-016 a group above the snapshot limit stays unselected", async () => {
  const serials = "01234567,89012345,".repeat(90_000);
  await conversation(
    ["Serial export", "", "~~~text", serials, "~~~"].join("\n"),
  );
  click(await findFastControl("button", "Share messages"));
  const group = messageGroup("Serial export");
  click(group.getByRole("checkbox"));
  await screen.findByText("Select fewer messages to share");
  expect(group.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByText("Inspect inventory")).toBeInTheDocument();
});

test("chat-sharing-009 consecutive prompts retain the action rows in classic sharing", async () => {
  const runId = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    chatEvents: ["North manifest", "South manifest"].map((text, i) => {
      return promptEvent({
        text,
        runId,
        seqId: i + 1,
        id: crypto.randomUUID(),
      });
    }),
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatShareRefresh]: false,
      [FeatureSwitchKey.ChatReplyNameLine]: false,
    },
  });
  click(await findFastControl("button", "Share messages"));
  await findFastControl("button", "Share");
  for (const text of ["North manifest", "South manifest"]) {
    const row = screen.getByText(text).closest('[data-role="user"]');
    expect(
      row?.querySelector("[data-chat-user-message-actions]"),
    ).toBeInTheDocument();
  }
  expect(
    screen.getByText("South manifest").closest('[data-role="user"]'),
  ).toHaveAttribute("data-chat-user-message-stacked");
  expect(screen.queryByLabelText("Copy message")).not.toBeInTheDocument();
});

test.each([
  ["022", "Everyone", "The shared link could not be created."],
  ["026", "Organization", "Could not copy the link"],
] as const)(
  "chat-sharing-%s restores the composer actions after sharing with %s fails",
  async (id, audience, error) => {
    context.mocks.browser.clipboardWriteText();
    if (id === "026") {
      vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
        new DOMException("Clipboard denied", "NotAllowedError"),
      );
    }
    const release = context.mocks.deferred<void>();
    context.mocks.api(
      sharedThreadVisibilityContract.create,
      async ({ body, respond }) => {
        await release.promise;
        return id === "022"
          ? respond(403, { error: { code: "FORBIDDEN", message: "Denied" } })
          : respond(201, { id: body.id! });
      },
    );
    await conversation("Dispatch complete", true);
    const composer = await screen.findByRole("textbox", { name: /message/i });
    click(await findFastControl("button", "Share message"));
    const menu = await screen.findByRole("menu");
    click(within(menu).getByText(audience));
    await screen.findAllByText("Copied");
    release.resolve();
    await screen.findByText(error);
    expect(screen.queryAllByText("Copied")).toHaveLength(0);
    await expect(
      findFastControl("button", "Share message"),
    ).resolves.toBeEnabled();
    expect(composer).toBeEnabled();
    expect(
      screen.queryByRole("textbox", { name: "Shared chat link" }),
    ).not.toBeInTheDocument();
  },
);

test("chat-sharing-006 a new prompt makes the previously selected group mixed", async () => {
  const runId = crypto.randomUUID(),
    first = crypto.randomUUID(),
    second = crypto.randomUUID();
  const events = [
    promptEvent({ id: first, runId, seqId: 1, text: "April count" }),
  ];
  createChatRunFixtures(context).installRunChat({ chatEvents: events });
  const payload = context.mocks.deferred<string[]>();
  const snapshot = crypto.randomUUID();
  context.mocks.api(
    sharedThreadVisibilityContract.create,
    ({ body, respond }) => {
      payload.resolve(body.eventIds);
      return respond(201, { id: snapshot });
    },
  );
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatShareRefresh]: false },
  });
  click(await findFastControl("button", "Share messages"));
  click(messageGroup("April count").getByText("Select message group"));
  expect(messageGroup("April count").getByRole("checkbox")).toBeChecked();
  events.push(promptEvent({ id: second, runId, seqId: 2, text: "May count" }));
  publishRunUpdate();
  await screen.findByText("May count");
  const group = messageGroup("May count"),
    box = group.getByRole("checkbox");
  expect(box).toBePartiallyChecked();
  click(box);
  expect(box).toBeChecked();
  click(box);
  expect(box).not.toBeChecked();
  click(box);
  click(await findFastControl("button", "Share"));
  await screen.findByDisplayValue(
    location.origin + "/share/threads/" + snapshot,
  );
  await expect(payload.promise).resolves.toStrictEqual([first, second]);
});
function selectionPopup() {
  return document.querySelector<HTMLElement>(
    "[data-chat-selection-interaction]",
  );
}
function expectSelectionCommands() {
  const popup = selectionPopup();
  expect(popup).toBeInTheDocument();
  for (const label of ["Copy", "Quote", "Fork"]) {
    expect(within(popup!).getByText(label)).toBeInTheDocument();
  }
}

test("chat-sharing-008 passage controls return only after closing the shared selection", async () => {
  const text = "Shipment estimate";
  context.mocks.api(sharedThreadVisibilityContract.create, ({ respond }) => {
    return respond(201, { id: crypto.randomUUID() });
  });
  await conversation(text);
  await selectPassage(text);
  expectSelectionCommands();
  click(await findFastControl("button", "Share messages"));
  const share = await findFastControl("button", "Share");
  expect(selectionPopup()).not.toBeInTheDocument();
  setPassageSelection(text);
  expect(window.getSelection()?.toString()).toBe(text);
  expect(selectionPopup()).not.toBeInTheDocument();
  click(messageGroup(text).getByText("Select message group"));
  click(share);
  await screen.findByRole("textbox", { name: "Shared chat link" });
  expect(selectionPopup()).not.toBeInTheDocument();
  click(await findFastControl("button", "Close"));
  await screen.findByRole("textbox", { name: /message/i });
  await selectPassage(text);
  expectSelectionCommands();
});

test.each(["013", "014"] as const)(
  "chat-sharing-%s isolates the last answer and restores its open history",
  async (id) => {
    const runId = crypto.randomUUID();
    const texts = ["Reading backlog", "Checking stock", "Shipment estimate"];
    const messages = texts.map((text, i) => {
      return assistantEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: i + 2,
        text,
      });
    });
    const final = messages[2]!.id;
    const failed = id === "014";
    createChatRunFixtures(context).installRunChat({
      activeRunIds: failed ? [] : [runId],
      chatEvents: [
        promptEvent({
          id: crypto.randomUUID(),
          runId,
          text: "Check backlog",
          seqId: 1,
        }),
        ...messages,
        ...(failed
          ? [
              {
                ...completedEvent({ id: crypto.randomUUID(), runId, seqId: 5 }),
                runLifecycleEvent: "failed" as const,
              },
            ]
          : []),
      ],
    });
    const snapshot = crypto.randomUUID();
    const payload = context.mocks.deferred<string[]>();
    context.mocks.api(
      sharedThreadVisibilityContract.create,
      ({ body, respond }) => {
        payload.resolve(body.eventIds);
        return respond(201, { id: snapshot });
      },
    );
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.ChatShareRefresh]: false },
    });
    click(await findWorkHistoryToggle("collapsed"));
    await screen.findByText(texts[0]!);
    const status = () => {
      return failed
        ? screen.queryByText("This run couldn't finish")
        : document.querySelector("[data-thinking-indicator]");
    };
    expect(status()).toBeVisible();
    await selectPassage(texts[2]!);
    click(await findFastControl("button", "Share messages"));
    const row = messageGroup(texts[2]!);
    for (const earlier of texts.slice(0, 2)) {
      expect(screen.queryByText(earlier)).not.toBeInTheDocument();
    }
    expect(status()).not.toBeInTheDocument();
    expect(selectionPopup()).not.toBeInTheDocument();
    click(row.getByText("Select message group"));
    click(await findFastControl("button", "Share"));
    await screen.findByDisplayValue(
      location.origin + "/share/threads/" + snapshot,
    );
    await expect(payload.promise).resolves.toStrictEqual([final]);
    click(await findFastControl("button", "Close"));
    await findWorkHistoryToggle("expanded");
    for (const text of texts) {
      await screen.findByText(text);
    }
    expect(status()).toBeVisible();
    await selectPassage(texts[2]!);
    expectSelectionCommands();
  },
);
