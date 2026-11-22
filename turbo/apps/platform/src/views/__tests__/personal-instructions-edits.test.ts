import { findFastControl } from "../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import { getButtonByName } from "../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import {
  instructionsContract,
  type InstructionsRequest,
} from "@okouai/api-contracts/contracts/instructions";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { setupPage, click, fill } from "../../__tests__/page-helper.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

function documentService() {
  let saved = {
    userId: "member-personal",
    orgId: "org_default",
    content: "Use concise updates.",
    version: "first-revision",
    updatedAt: "2026-07-15T09:00:00.000Z",
  };
  let failing = false;
  const updates: InstructionsRequest[] = [];
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, saved);
  });
  context.mocks.api(instructionsContract.update, ({ body, respond }) => {
    updates.push(body);
    if (failing) {
      return respond(500, {
        error: { message: "Unavailable", code: "INTERNAL_ERROR" },
      });
    }
    if (body.ifVersion !== saved.version) {
      return respond(409, {
        error: { message: "Revision changed", code: "CONFLICT" },
      });
    }
    saved = { ...saved, content: body.content, version: "member-revision" };
    return respond(200, saved);
  });
  return {
    updates,
    offline(value: boolean) {
      failing = value;
    },
    cliSave() {
      saved = {
        ...saved,
        content: "Use headings from the CLI.",
        version: "cli-revision",
      };
    },
  };
}
const editor = () => {
  return screen.getByLabelText("Instructions", {
    selector: "[contenteditable]",
  });
};
const action = (name: string) => {
  return getButtonByName(name);
};
async function openInstructions() {
  await setupPage({
    context,
    path: "/?settings=my-okou&focus=instructions",
    auth: { user: { id: "member-personal", fullName: "Ordinary Member" } },
  });
  await screen.findByText("Use concise updates.", { exact: true });
}
test("my-okou-001 Clearing personal Instructions saves an empty document at its original revision", async () => {
  const service = documentService();
  await openInstructions();
  await fill(editor(), "");
  await screen.findByText("Unsaved changes");
  click(action("Save"));
  await screen.findByText("Instructions saved");
  expect(service.updates).toStrictEqual([
    { content: "", ifVersion: "first-revision" },
  ]);
  expect(editor()).toHaveTextContent(/^$/);
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(
    screen.getByText(/Used the next time Okou starts working/),
  ).toBeVisible();
  expect(new URLSearchParams(location.search).get("settings")).toBe("my-okou");
});
test("my-okou-002 A discarded change restores the original and a failed change stays editable for retry", async () => {
  const service = documentService();
  await openInstructions();
  await fill(editor(), "To discard");
  click(action("Discard"));
  await waitFor(() => {
    return expect(editor()).toHaveTextContent("Use concise updates.");
  });
  service.offline(true);
  await fill(editor(), "Kept after failure");
  click(action("Save"));
  await screen.findByText(/Couldn’t save your instructions/);
  expect(editor()).toHaveTextContent("Kept after failure");
  expect(action("Save")).toBeEnabled();
  service.offline(false);
  click(action("Save"));
  await screen.findByText("Instructions saved");
  expect(editor()).toHaveTextContent("Kept after failure");
  expect(screen.queryByText("Unsaved changes")).toBeNull();
});
test("my-okou-003 A conflicting CLI revision protects the member's local edits until explicit reload", async () => {
  const service = documentService();
  await openInstructions();
  await fill(editor(), "Local unsaved revision");
  service.cliSave();
  click(action("Save"));
  const reload = await findFastControl("button", "Reload saved instructions");
  expect(service.updates).toStrictEqual([
    { content: "Local unsaved revision", ifVersion: "first-revision" },
  ]);
  expect(action("Save")).toBeDisabled();
  expect(editor()).toHaveTextContent("Local unsaved revision");
  click(reload);
  await waitFor(() => {
    return expect(editor()).toHaveTextContent("Use headings from the CLI.");
  });
  expect(screen.queryByText("Unsaved changes")).toBeNull();
});

test("my-okou-005 A CLI update announced during editing preserves the draft until the member reloads", async () => {
  const service = documentService();
  await openInstructions();
  await fill(editor(), "Draft to keep locally");
  await vi.waitUntil(() => {
    return context.mocks.ably.hasSubscription("personalInstructionsChanged");
  });
  service.cliSave();
  context.mocks.ably.trigger("personalInstructionsChanged", {});
  const reload = await findFastControl("button", "Reload saved instructions");
  expect(editor()).toHaveTextContent("Draft to keep locally");
  expect(action("Save")).toBeDisabled();
  click(reload);
  await waitFor(() => {
    return expect(editor()).toHaveTextContent("Use headings from the CLI.");
  });
  expect(screen.queryByText("Unsaved changes")).toBeNull();
});
