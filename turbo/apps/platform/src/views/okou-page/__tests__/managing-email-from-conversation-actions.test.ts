import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  mockAttachmentChat,
  ATTACHMENT_THREAD_ID,
} from "./chat-attachment-test-helpers.ts";
const context = testContext();
const threadPath = "/chats/" + ATTACHMENT_THREAD_ID;
function mailId(n: number) {
  return "88999999-0000-4000-8000-" + String(n).padStart(12, "0");
}
async function launch(forbidden = false) {
  mockAttachmentChat(context);
  context.mocks.api(mailContract.listThreadMail, ({ params, respond }) => {
    if (forbidden || params.threadId !== ATTACHMENT_THREAD_ID) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Mail access denied" },
      });
    }
    return respond(200, {
      mails: [1, 2, 3, 4].map((n) => {
        return {
          mailDraftId: mailId(n),
          subject: "Proposal " + n,
          status: n <= 2 ? ("draft" as const) : ("sent" as const),
          from: "studio@example.invalid",
          createdAt: "2026-10-19T12:30:00Z",
        };
      }),
    });
  });
  await setupPage({ context, path: threadPath });
  const user = userEvent.setup({ delay: null });
  await user.click(await findFastControl("button", "More actions"));
  const item = await waitFor(() => {
    const found = queryAllByRoleFast("menuitem").find((el) => {
      return el.textContent?.includes("Manage emails");
    });
    expect(found).toBeDefined();
    return found!;
  });
  await user.click(item);
  return screen.findByRole("dialog", { name: "Emails" });
}
test("thread-mail-003 Draft selection shows mixed and complete bulk actions, clears on a second selection and excludes sent mail", async () => {
  const box = await launch(),
    view = within(box),
    user = userEvent.setup({ delay: null });
  const one = await view.findByRole("checkbox", {
    name: "Select email: Proposal 1",
  });
  expect(view.getAllByRole("checkbox")).toHaveLength(3);
  expect(queryFastControl("button", "Send", box)).toBeNull();
  await user.click(one);
  const all = view.getByRole("checkbox", { name: "Select all" });
  expect(all).toHaveAttribute("aria-checked", "mixed");
  await expect(
    view.findByText("Actions apply to selected drafts"),
  ).resolves.toBeVisible();
  await user.click(view.getByText("Select all"));
  await expect(view.findByText("2 selected")).resolves.toBeVisible();
  expect(all).toBeChecked();
  await expect(findFastControl("button", "Send", box)).resolves.toBeEnabled();
  await expect(findFastControl("button", "Delete", box)).resolves.toBeEnabled();
  await user.click(view.getByText("Select all"));
  await expect(view.findByText("0 selected")).resolves.toBeVisible();
  expect(queryFastControl("button", "Send", box)).toBeNull();
  click(await findFastControl("button", "Sent", box));
  await expect(view.findByText("Proposal 3")).resolves.toBeVisible();
  expect(view.queryAllByRole("checkbox")).toHaveLength(0);
  expect(queryFastControl("button", "Send", box)).toBeNull();
  expect(queryFastControl("button", "Delete", box)).toBeNull();
});
test("thread-mail-008 Ctrl activation leaves the thread email list open and preserves the browser's original detail destination", async () => {
  const box = await launch(),
    link = await findFastControl("link", "Open email: Proposal 2", box);
  const dest = new URL(link.getAttribute("href")!, location.origin);
  expect(dest.pathname).toBe(threadPath);
  expect(Object.fromEntries(dest.searchParams)).toMatchObject({
    mailThread: ATTACHMENT_THREAD_ID,
    mailView: "detail",
    mailFrom: "list",
    mailId: mailId(2),
  });
  const activation = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
  });
  let intercepted: boolean | undefined;
  document.addEventListener(
    "click",
    (event) => {
      intercepted = event.defaultPrevented;
      event.preventDefault();
    },
    { once: true },
  );
  link.dispatchEvent(activation);
  expect(intercepted).toBeFalsy();
  expect(box).toBeVisible();
  expect(new URL(location.href).searchParams.get("mailView")).toBe("list");
  expect(link).toHaveAttribute("href", dest.pathname + dest.search);
});
test("thread-mail-011 A forbidden conversation email list stays open and announces the load failure", async () => {
  const box = await launch(true);
  const alert = await within(box).findByRole("alert");
  expect(alert).toHaveTextContent("Unable to load emails");
  expect(box).toBeVisible();
  await expect(
    findFastControl("button", "Close emails", box),
  ).resolves.toBeEnabled();
});
