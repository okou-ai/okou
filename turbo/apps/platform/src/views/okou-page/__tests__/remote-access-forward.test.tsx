import {
  chatRemoteAccessContract,
  type ThreadRemoteHostAccess,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { selectPassage } from "./chat-capability-test-helpers.ts";
import {
  createMessageExperienceHelpers,
  findFastControl,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";
import { remoteId } from "./connectors-remote-control-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const SOURCE_THREAD = "b0000000-0000-4000-a000-000000000071";
const TARGET_THREAD = "b0000000-0000-4000-a000-000000000072";
const RUN_ID = "d0000000-0000-4000-a000-000000000071";
const HOST_ID = remoteId("b", 1);

function hostAccess(overrideEnabled: boolean | null): ThreadRemoteHostAccess {
  return {
    connectionId: HOST_ID,
    displayName: "Build box",
    defaultEnabled: false,
    overrideEnabled,
    enabled: overrideEnabled ?? false,
    source: overrideEnabled === null ? "default" : "override",
  };
}

function installChats(): void {
  const lifecycle = installMessageExperienceChat({
    threadId: SOURCE_THREAD,
    chatEvents: [
      {
        id: "rollout-question",
        role: "user",
        content: "Summarize the rollout",
        runId: RUN_ID,
        seqId: 1,
        createdAt: "2026-11-20T07:00:00.000Z",
      },
      {
        id: "rollout-answer",
        role: "assistant",
        content: "The rollout finished on the staging cluster.",
        runId: RUN_ID,
        seqId: 2,
        createdAt: "2026-11-20T07:00:01.000Z",
      },
    ],
  });
  lifecycle.setThreadList(
    [
      { id: SOURCE_THREAD, title: "Rollout notes", minute: 0 },
      { id: TARGET_THREAD, title: "Release review", minute: 1 },
    ].map(({ id, title, minute }) => {
      return {
        id,
        title,
        agent: { id: MESSAGE_EXPERIENCE_AGENT_ID, avatarUrl: null },
        createdAt: "2026-11-20T06:00:00.000Z",
        updatedAt: `2026-11-20T06:0${minute}:00.000Z`,
      };
    }),
  );
}

async function openRemoteAccess(container: ParentNode): Promise<HTMLElement> {
  click(await findFastControl("button", "Connectors", container));
  click(await findFastControl("button", /^Remote access/));
  return await screen.findByRole("dialog", { name: "Remote access" });
}

test("A forward to an existing chat keeps its own remote permissions and pending save across resize", async () => {
  const viewport = context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 768px)";
  });
  installChats();
  // The target chat enables the host explicitly; the source uses its default.
  const access = new Map([
    [SOURCE_THREAD, hostAccess(null)],
    [TARGET_THREAD, hostAccess(true)],
  ]);
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: [
        {
          connectionId: HOST_ID,
          displayName: "Build box",
          defaultEnabled: false,
        },
      ],
      vncHosts: [],
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ params, respond }) => {
      const host = access.get(params.threadId) ?? hostAccess(null);
      return respond(200, { ssh: [host], vnc: [] });
    },
  );
  const saveGate = context.mocks.deferred<void>();
  context.mocks.api(
    chatRemoteAccessContract.setThreadOverride,
    async ({ params, body, respond }) => {
      await saveGate.promise;
      const saved = hostAccess(body.enabled);
      access.set(params.threadId, saved);
      return respond(200, saved);
    },
  );
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${SOURCE_THREAD}` });
  await selectPassage("staging cluster");
  click(await findFastControl("button", /^Forward/));
  const picker = await screen.findByRole("dialog", { name: "Forward to" });
  click(within(picker).getByRole("option", { name: "Release review" }));
  const forward = await screen.findByRole("dialog", {
    name: "Release review",
  });
  const forwardConnectors = await findFastControl(
    "button",
    "Connectors",
    forward,
  );
  const target = await openRemoteAccess(forward);
  const choice = await within(target).findByRole("combobox", {
    name: "SSH Build box",
  });
  expect(choice).toHaveTextContent("On");

  await user.click(choice);
  click(await screen.findByRole("option", { name: "Off" }));
  await expect(
    within(target).findByText("Saving…"),
  ).resolves.toBeInTheDocument();

  viewport.setMatches(false);

  const resized = await waitFor(() => {
    const dialog = screen.getByRole("dialog", { name: "Remote access" });
    expect(within(dialog).getByText("Saving…")).toBeInTheDocument();
    return dialog;
  });
  const pending = within(resized).getByRole("combobox", {
    name: "SSH Build box",
  });
  expect(pending).toHaveAttribute("aria-readonly", "true");

  saveGate.resolve();

  const saved = await waitFor(() => {
    const dialog = screen.getByRole("dialog", { name: "Remote access" });
    expect(within(dialog).getByText("Saved for this chat")).toBeInTheDocument();
    return dialog;
  });
  expect(
    within(saved).getByRole("combobox", { name: "SSH Build box" }),
  ).toHaveTextContent("Off");

  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(forwardConnectors).toHaveFocus();
  });
  expect(screen.queryByRole("dialog", { name: "Remote access" })).toBeNull();

  click(await findFastControl("button", "Close", forward));
  await waitFor(() => {
    expect(forward).not.toBeInTheDocument();
  });
  const source = await openRemoteAccess(document.body);

  await expect(
    within(source).findByRole("combobox", { name: "SSH Build box" }),
  ).resolves.toHaveTextContent("Default (Off)");
});
