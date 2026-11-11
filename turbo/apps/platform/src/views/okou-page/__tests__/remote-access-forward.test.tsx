import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  CAPABILITY_AGENT_ID,
  completedConversation,
  RUN_PATH,
  RUN_THREAD_ID,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import {
  createChatRunFixtures,
  findEnabledButton,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const TARGET_THREAD_ID = "b0000000-0000-4000-a000-000000000062";
const PASSAGE = "Review this remote workspace before forwarding.";

function installForwardRemoteAccess() {
  const { installRunChat } = createChatRunFixtures(context);
  const lifecycle = installRunChat({
    chatEvents: completedConversation(PASSAGE),
  });
  lifecycle.setThreadList(
    [
      { id: RUN_THREAD_ID, title: "Source chat" },
      { id: TARGET_THREAD_ID, title: "Forward target" },
    ].map((thread) => {
      return {
        ...thread,
        agent: { id: CAPABILITY_AGENT_ID, avatarUrl: null },
        createdAt: "2026-11-11T00:00:00.000Z",
        updatedAt: "2026-11-11T00:00:00.000Z",
      };
    }),
  );
  const host = {
    connectionId: "b0000000-0000-4000-8000-000000000001",
    displayName: "Forward workstation",
    defaultEnabled: false,
  };
  const overrides = new Map([[TARGET_THREAD_ID, true]]);
  const read = (threadId: string) => {
    const overrideEnabled = overrides.get(threadId) ?? null;
    return {
      ...host,
      overrideEnabled,
      enabled: overrideEnabled ?? host.defaultEnabled,
      source:
        overrideEnabled === null ? ("default" as const) : ("override" as const),
    };
  };
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: false,
      sshHosts: [host],
      vncHosts: [],
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ params, respond }) => {
      return respond(200, { ssh: [read(params.threadId)], vnc: [] });
    },
  );
  const saved = context.mocks.deferred<void>();
  context.mocks.api(
    chatRemoteAccessContract.setThreadOverride,
    async ({ params, body, respond }) => {
      await saved.promise;
      overrides.set(params.threadId, body.enabled);
      return respond(200, read(params.threadId));
    },
  );
  return saved;
}

test("A forward to an existing chat keeps its own remote permissions and pending save across resize", async () => {
  const saved = installForwardRemoteAccess();
  const media = context.mocks.browser.matchMedia(true);
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: false },
  });
  await screen.findByText(PASSAGE);
  await selectPassage(PASSAGE);
  click(await findEnabledButton("Forward"));
  const picker = await screen.findByRole("dialog", { name: "Forward to" });
  click(await within(picker).findByRole("option", { name: "Forward target" }));
  const forward = await screen.findByRole("dialog", { name: "Forward target" });
  await within(forward).findByRole("textbox", { name: "Add a message" });
  const connectorTrigger = await findFastControl(
    "button",
    "Connectors",
    forward,
  );
  click(connectorTrigger);
  click(await screen.findByText("Remote access"));

  const remote = await screen.findByRole("dialog", { name: "Remote access" });
  const choice = await within(remote).findByRole("combobox", {
    name: "SSH Forward workstation",
  });
  expect(choice).toHaveTextContent("On");
  click(choice);
  click(await screen.findByRole("option", { name: "Off" }));
  await within(remote).findByText("Saving…");
  act(() => {
    media.setMatches(false);
  });
  const resized = await screen.findByRole("dialog", { name: "Remote access" });
  const pendingChoice = await within(resized).findByRole("combobox", {
    name: "SSH Forward workstation",
  });
  expect(pendingChoice).toHaveAttribute("aria-readonly", "true");
  saved.resolve();
  await within(resized).findByText("Saved for this chat");
  expect(pendingChoice).toHaveTextContent("Off");

  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(connectorTrigger).toHaveFocus();
  });
  const restoredForward = screen.getByRole("dialog", {
    name: "Forward target",
  });
  click(await findFastControl("button", "Close", restoredForward));
  await waitFor(() => {
    expect(restoredForward).not.toBeInTheDocument();
  });
  click(await findFastControl("button", "Connectors"));
  click(await screen.findByText("Remote access"));
  const source = await screen.findByRole("dialog", { name: "Remote access" });
  expect(
    within(source).getByRole("combobox", { name: "SSH Forward workstation" }),
  ).toHaveTextContent("Default (Off)");
});
