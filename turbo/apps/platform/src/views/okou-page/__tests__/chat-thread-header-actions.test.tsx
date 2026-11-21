import {
  chatThreadArchiveContract,
  chatThreadMuteContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { act, screen } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  RUN_PATH,
  promptEvent,
  findButton,
  queryButton,
} from "./chat-run-test-fixtures.ts";
import { findNamedMenuItem } from "./chat-attachment-test-helpers.ts";

const context = testContext();
const subject = "Check the revised shipping date";

async function openMobile() {
  const viewport = context.mocks.browser.matchMedia(false);
  const runId = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    threadTitle: "Cargo review",
    chatEvents: [promptEvent({ id: runId, runId, seqId: 1, text: subject })],
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await screen.findByText(subject);
  return viewport;
}

async function action(name: string) {
  click(await findButton("More actions"));
  const menu = await screen.findByRole("menu");
  return findNamedMenuItem(name, menu);
}

test("chat-thread-header-actions-006 undoing archive returns to the original mobile conversation", async () => {
  context.mocks.api(chatThreadArchiveContract.archive, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadArchiveContract.unarchive, ({ respond }) => {
    return respond(204);
  });
  await openMobile();
  click(await action("Archive chat"));
  const undo = await findButton("Undo");
  expect(location.pathname).toBe("/");
  click(undo);
  await screen.findByText(subject);
  expect(location.pathname).toBe(RUN_PATH);
  await expect(action("Archive chat")).resolves.not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("chat-thread-header-actions-007 unmuting from the desktop header clears the mobile mute", async () => {
  context.mocks.api(chatThreadMuteContract.mute, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadMuteContract.unmute, ({ respond }) => {
    return respond(204);
  });
  const viewport = await openMobile();
  click(await action("Mute chat"));
  await screen.findByText(/Chat muted\./);
  expect(location.pathname).toBe(RUN_PATH);
  const unmute = await action("Unmute chat");
  expect(unmute).toBeInTheDocument();
  act(() => {
    viewport.setMatches((query) => {
      return query.startsWith("(min-width:");
    });
  });
  const button = await findButton("Unmute chat");
  expect(button.closest("header")).toHaveTextContent("Cargo review");
  click(button);
  await screen.findByText("Chat unmuted");
  expect(queryButton("Unmute chat")).toBeNull();
});

test("chat-thread-header-actions-014 both failed pin changes release the next mobile action", async () => {
  const first = context.mocks.deferred<void>();
  const second = context.mocks.deferred<void>();
  context.mocks.api(chatThreadPinContract.pin, async ({ respond }) => {
    await first.promise;
    return respond(400, {
      error: { code: "BAD_REQUEST", message: "Pin rejected for cargo review" },
    });
  });
  context.mocks.api(chatThreadUnpinContract.unpin, async ({ respond }) => {
    await second.promise;
    return respond(400, {
      error: {
        code: "BAD_REQUEST",
        message: "Unpin rejected for cargo review",
      },
    });
  });
  await openMobile();
  click(await action("Pin chat"));
  click(await action("Unpin chat"));
  first.resolve();
  await screen.findByText(/Pin rejected for cargo review/);
  second.resolve();
  await screen.findByText(/Unpin rejected for cargo review/);
  await expect(action("Pin chat")).resolves.not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});
