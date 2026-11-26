import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { CapturedChatSend } from "./chat-capability-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";
import {
  chatListThread,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { project } from "./project-editor-fixtures.ts";
import {
  queryMenuItemByText,
  openThreadMenu,
} from "./sidebar-test-helpers.tsx";

const context = testContext();
const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const title = "Plan [v2]";

function auth(orgId: string) {
  return {
    user: { id: "fork-tester", fullName: "Test member" },
    organization: {
      activeOrg: { id: orgId, name: "Test workspace" },
      memberships: [{ id: orgId }],
    },
  };
}

test.each(["Home", "Project"] as const)(
  "Fork opens the %s composer for the selected chat and sends its reference only on submission",
  async (destination) => {
    const launch = project("Launch");
    const projectId = destination === "Project" ? launch.id : null;
    const source = chatListThread(14, title, { projectId });
    const current = chatListThread(15, "Other plans", { projectId: launch.id });
    const sent = context.mocks.deferred<CapturedChatSend>();
    const created = context.mocks.deferred<{
      id: string;
      projectId: string | null;
    }>();
    mockChatLifecycle(context, {
      threadId: current.id,
      onSendRequest: sent.resolve,
    });
    installChatListStream(context, { caseId: 14, snapshot: [source, current] });
    context.mocks.api(projectsContract.snapshot, ({ respond }) => {
      return respond(200, {
        projects: [launch],
        latestEventId: null,
        latestSeqId: 0,
      });
    });
    context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
      const id = body.clientThreadId!;
      created.resolve({ id, projectId: body.projectId ?? null });
      return respond(201, {
        id,
        title: null,
        projectId: body.projectId ?? null,
        createdAt: launch.createdAt,
        selectedModel: null,
        serviceTier: null,
      });
    });
    context.mocks.api(composerDraftContract.get, ({ respond }) => {
      return respond(200, textContinuityDraft("Existing notes."));
    });
    await setupPage({
      context,
      auth: auth(staffOrgId),
      path: projectId ? "/chats/" + current.id : "/projects/" + launch.id,
    });
    await findFastControl("link", title);
    openThreadMenu(title);
    click(await screen.findByText("Fork", { exact: true }));
    await waitFor(() => {
      expect(location.pathname).toBe(
        projectId ? "/projects/" + launch.id : "/",
      );
      const composer = screen.getByRole("textbox", { name: "Message" });
      expect(
        composer.querySelector(`[data-chat-thread-mention="${source.id}"]`),
      ).toHaveTextContent(title);
      expect(composer).toHaveTextContent("Existing notes.");
      expect(screen.queryByLabelText("Remove Launch") !== null).toBe(
        projectId !== null,
      );
      expect(composer).toHaveFocus();
    });
    expect(created.settled()).toBeFalsy();
    expect(sent.settled()).toBeFalsy();
    await userEvent.setup({ delay: null }).keyboard("Explore the risks.");
    click(await findEnabledButton("Send"));
    const newThread = await created.promise;
    expect(newThread.projectId).toBe(projectId);
    expect(newThread.id).not.toBe(source.id);
    const message = await sent.promise;
    expect(message.threadId ?? message.clientThreadId).toBe(newThread.id);
    expect(message.userMessage?.parts).toStrictEqual(
      expect.arrayContaining([
        { type: "chat_thread", threadId: source.id, titleSnapshot: title },
        { type: "text", text: expect.stringContaining("Explore the risks.") },
      ]),
    );
  },
);

test.each([
  {
    workspace: "staff with the switch disabled",
    orgId: staffOrgId,
    enabled: false,
  },
  {
    workspace: "non-staff with an override",
    orgId: "org_customer",
    enabled: true,
  },
])("Fork is hidden for $workspace", async ({ orgId, enabled }) => {
  installChatListStream(context, {
    caseId: 14,
    snapshot: [chatListThread(14, title)],
  });
  await setupPage({
    context,
    path: "/",
    auth: auth(orgId),
    featureSwitches: { [FeatureSwitchKey.ChatThreadFork]: enabled },
  });
  await findFastControl("link", title);
  openThreadMenu(title);
  await screen.findByText("Rename", { exact: true });
  expect(queryMenuItemByText("Fork")).toBeNull();
});

test("Fork opens the composer from the mobile chat list for an untitled chat", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(pointer: coarse)" || query === "(display-mode: standalone)"
    );
  });
  const source = chatListThread(18, "", { title: null });
  installChatListStream(context, { caseId: 18, snapshot: [source] });
  await setupPage({ context, path: "/", auth: auth(staffOrgId) });
  const list = await screen.findByLabelText("Chat threads");
  click(await within(list).findByLabelText("Open chat menu"));
  click(await screen.findByText("Fork", { exact: true }));
  const editor = await findComposerEditor();
  expect(
    editor.querySelector(`[data-chat-thread-mention="${source.id}"]`),
  ).toHaveTextContent("New chat");
});
