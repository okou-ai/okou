import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  findButton,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

test("Open empty email and automation lists in a desktop chat", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  installCapabilityChat({ events: completedConversation("Ready to help.") });
  context.mocks.api(mailContract.listThreadMail, ({ respond }) => {
    return respond(200, { mails: [] });
  });
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ respond }) => {
      return respond(200, []);
    },
  );
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const more = await findButton("More actions");
  await waitFor(() => {
    expect(more).not.toHaveAttribute("aria-disabled", "true");
  });

  click(more);
  click(await screen.findByRole("menuitem", { name: "Manage emails" }));
  const emails = within(await screen.findByRole("dialog", { name: "Emails" }));
  await expect(emails.findByText("No emails yet")).resolves.toBeInTheDocument();
  expect(
    emails.getByText(
      "Email drafts and sent emails from this chat will show up here.",
    ),
  ).toBeInTheDocument();
  expect(
    emails.queryByLabelText("Search by subject or sender"),
  ).not.toBeInTheDocument();
  click(emails.getByRole("button", { name: "Close emails" }));
  await waitFor(() => {
    expect(more).toHaveFocus();
  });

  click(more);
  click(await screen.findByRole("menuitem", { name: "Automations" }));
  const automations = within(
    await screen.findByRole("complementary", { name: "Automations" }),
  );
  await expect(
    automations.findByText("No automations yet"),
  ).resolves.toBeInTheDocument();
  expect(
    automations.getByText(
      "Automations that run in this chat will show up here.",
    ),
  ).toBeInTheDocument();
});
