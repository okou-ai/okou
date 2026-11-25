import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  SKILL_IMPORT_LIMITS,
  skillImportSessionsContract,
} from "@okouai/api-contracts/contracts/skill-import";
import type { WorkflowDetailResponse } from "@okouai/api-contracts/contracts/workflows";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import { salesWorkflow, serveWorkflows } from "./workflow-boundary.ts";

const context = testContext();
const route = "/workflows?source=skill-import";
async function workflowPage() {
  const uploads: WorkflowDetailResponse[] = [];
  serveWorkflows(context, () => {
    return uploads;
  });
  context.mocks.api(skillImportSessionsContract.create, ({ body, respond }) => {
    return respond(200, {
      sessionId: crypto.randomUUID(),
      token:
        "vm0_skillimport_" + body.provider + "_local_" + crypto.randomUUID(),
      uploadUrl: "https://api.okou.test/api/skill-import/skills",
      expiresAt: "2099-01-01T00:00:00.000Z",
      limits: SKILL_IMPORT_LIMITS,
    });
  });
  context.mocks.api(skillImportSessionsContract.listSkills, ({ respond }) => {
    return respond(200, uploads);
  });
  await setupPage({ context, path: route });
  const trigger = await findFastControl("button", "Import skills");
  return {
    trigger,
    upload: (name: string, displayName: string) => {
      uploads.push(
        salesWorkflow(context, {
          id: crypto.randomUUID(),
          name,
          displayName,
          importSource: "claudeCode",
        }),
      );
      act(() => {
        return context.mocks.ably.trigger("skillImportChanged");
      });
    },
  };
}
function show(trigger: HTMLElement) {
  click(trigger);
  return screen.findByRole("dialog", { name: "Import your skills" });
}
async function readyFeed() {
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("skillImportChanged"),
    ).toBeTruthy();
  });
}
test("skill-import-dialog-001 Import skills immediately precedes Create in chat on Workflows", async () => {
  const { trigger } = await workflowPage();
  const create = await findFastControl("button", "Create in chat");
  expect(trigger.nextElementSibling).toBe(create);
});
test("skill-import-dialog-002 An empty Claude Code import presents the instructions and a folded provider-specific prompt", async () => {
  const { trigger } = await workflowPage();
  const dialog = await show(trigger);
  const d = within(dialog);
  expect(d.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  await expect(
    d.findByText("Imported skills appear here as they arrive."),
  ).resolves.toBeVisible();
  expect(d.getByText("Paste the prompt and send it")).toBeVisible();
  const toggle = await findFastControl("button", "Show full prompt", dialog);
  expect(d.queryByRole("region", { name: "Skill import prompt" })).toBeNull();
  click(toggle);
  const prompt = await d.findByRole("region", { name: "Skill import prompt" });
  expect(prompt).toHaveTextContent("vm0_skillimport_claudeCode_local");
  expect(prompt).toHaveTextContent("~/.claude/skills/");
  expect(prompt).not.toHaveTextContent("~/.codex/skills/");
});
test("skill-import-dialog-005 Modified and auxiliary workflow-link activations preserve the live import session", async () => {
  const { trigger, upload } = await workflowPage();
  const dialog = await show(trigger);
  const d = within(dialog);
  const link = await findFastControl("link", "View workflows", dialog);
  expect(link).toHaveAttribute("href", "/workflows");
  await readyFeed();
  for (const gesture of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
    { button: 2 },
  ]) {
    const e = new MouseEvent("click", {
      ...gesture,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link, e);
    expect(e.defaultPrevented).toBeFalsy();
    expect(dialog).toBeVisible();
  }
  upload("evening-review", "Evening review");
  await d.findByText("Evening review");
  await expect(d.findByRole("status")).resolves.toHaveTextContent(
    "1 imported · listening for more",
  );
});
test.each([
  ["skill-import-dialog-006", "click"],
  ["skill-import-dialog-007", "keyboard"],
] as const)(
  "%s View workflows closes the import dialog and clears the source query via %s",
  async (_id, method) => {
    const { trigger } = await workflowPage();
    const dialog = await show(trigger);
    const link = await findFastControl("link", "View workflows", dialog);
    if (method === "keyboard") {
      link.focus();
      await userEvent.setup({ delay: null }).keyboard("{Enter}");
    } else {
      click(link);
    }
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
    expect(location.pathname + location.search).toBe("/workflows");
  },
);
test("skill-import-dialog-010 Reopening imports reconciles both uploads and retains the original session prompt", async () => {
  const { trigger, upload } = await workflowPage();
  const first = await show(trigger);
  const d = within(first);
  click(await findFastControl("button", "Show full prompt", first));
  const prompt = (await d.findByRole("region", { name: "Skill import prompt" }))
    .textContent;
  await readyFeed();
  upload("report-import", "Quarterly review");
  await d.findByText("Quarterly review");
  click(await findFastControl("button", "Close", first));
  await waitFor(() => {
    return expect(first).not.toBeInTheDocument();
  });
  await expect(screen.findByText("Quarterly review")).resolves.toBeVisible();
  upload("collection-import", "Studio collection");
  const second = await show(trigger);
  const reopened = within(second);
  await reopened.findByText("Studio collection");
  expect(reopened.getByText("Quarterly review")).toBeVisible();
  click(await findFastControl("button", "Show full prompt", second));
  expect(
    (await reopened.findByRole("region", { name: "Skill import prompt" }))
      .textContent,
  ).toBe(prompt);
});
test("skill-import-dialog-014 Escape returns focus to Import skills and releases its realtime subscription", async () => {
  const { trigger } = await workflowPage();
  trigger.focus();
  await userEvent.setup({ delay: null }).keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Import your skills",
  });
  await readyFeed();
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("skillImportChanged"),
    ).toBeFalsy();
  });
  expect(trigger).toHaveFocus();
});
