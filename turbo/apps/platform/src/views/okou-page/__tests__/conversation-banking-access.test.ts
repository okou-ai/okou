import {
  bankingWorkspaceContract,
  type BankingWorkspaceStatus,
} from "@okouai/api-contracts/contracts/banking";
import { screen, within, waitFor } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { bankingActionUrl } from "./chat-capability-connector-test-helpers.ts";
import {
  RUN_PATH,
  createChatCapabilityHelpers,
  completedConversation,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const reason = "Review recent cash-flow activity";
const resume = "Continue the cash-flow review";
const provider = "https://bank.example.test/member/sign-in";
const sessionId = "bf790000-0000-4000-a000-000000000001";
const accountId = "bf790000-0000-4000-a000-000000000002";
function connected(): BankingWorkspaceStatus["connection"] {
  return {
    id: "bf790000-0000-4000-a000-000000000003",
    status: "active",
    accounts: [
      {
        id: accountId,
        name: "Operating account",
        institutionName: "Example Bank",
        type: "checking",
        last4: "0284",
        repairRequired: false,
      },
    ],
    repairInstitutions: [],
  };
}
async function request(status: BankingWorkspaceStatus) {
  const sends: CapturedChatSend[] = [];
  const revocations: unknown[] = [];
  const link = bankingActionUrl({ reason, callbackPrompt: resume });
  createChatCapabilityHelpers(context).installCapabilityChat({
    events: completedConversation(
      "Please review this request. [Banking access](" + link + ")",
    ),
    onSend: (s) => {
      sends.push(s);
    },
  });
  context.mocks.api(
    bankingWorkspaceContract.accessRequestStatus,
    ({ respond }) => {
      return respond(200, status);
    },
  );
  context.mocks.api(
    bankingWorkspaceContract.createConnectSession,
    ({ body, respond }) => {
      status.session = {
        id: sessionId,
        mode: body.mode,
        status: "pending",
        institutionLoginId: null,
      };
      return respond(200, { sessionId, url: provider });
    },
  );
  context.mocks.api(
    bankingWorkspaceContract.revokeGrant,
    ({ body, respond }) => {
      revocations.push(body);
      status.grant = null;
      return respond(200, status);
    },
  );
  await setupPage({ context, path: RUN_PATH });
  const card = await screen.findByTestId("banking-action-card");
  click(await findFastControl("button", "View details", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Banking access request",
  });
  return { dialog, sends, revocations };
}
test("chat-capability-connectors-001 Bank sign-in redirects the opened window and a completed connection exposes the operating account", async () => {
  const status: BankingWorkspaceStatus = {
    connection: null,
    session: null,
    grant: null,
  };
  const popup = context.mocks.browser.authWindow();
  const replace = vi.fn<(url: string) => void>();
  Object.defineProperty(popup, "location", { value: { replace } });
  const open = context.mocks.browser.open(popup);
  const { dialog } = await request(status);
  await within(dialog).findByText(reason);
  click(await findFastControl("button", "Connect a bank", dialog));
  await waitFor(() => {
    return expect(replace).toHaveBeenCalledWith(provider);
  });
  expect(open.calls).toStrictEqual([
    { url: "about:blank", target: "_blank", features: null },
  ]);
  await within(dialog).findByText(/Finish there, then return to Chat/);
  expect(
    within(dialog).queryByRole("checkbox", { name: /Operating account/ }),
  ).toBeNull();
  status.connection = connected();
  status.session = null;
  context.mocks.ably.trigger("bankingAccessChanged", {});
  await expect(
    within(dialog).findByRole("checkbox", { name: /Operating account/ }),
  ).resolves.toBeVisible();
});
test("chat-capability-connectors-003 Repeated continuations share both event identifiers and confirmed revocation reopens account selection", async () => {
  const status: BankingWorkspaceStatus = {
    connection: connected(),
    session: null,
    grant: {
      status: "active",
      accountIds: [accountId],
      purpose: reason,
      expiresAt: null,
    },
  };
  const { dialog, sends, revocations } = await request(status);
  const proceed = await findFastControl("button", "Continue", dialog);
  click(proceed);
  await waitFor(() => {
    return expect(sends[0]?.prompt).toBe(resume);
  });
  await waitFor(() => {
    return expect(proceed).toBeEnabled();
  });
  click(proceed);
  await waitFor(() => {
    return expect(sends[1]?.prompt).toBe(resume);
  });
  const first = sends[0];
  expect(first?.clientEventId).toStrictEqual(expect.any(String));
  expect(first?.chatThreadSortEventId).toStrictEqual(expect.any(String));
  expect(sends[1]?.clientEventId).toBe(first?.clientEventId);
  expect(sends[1]?.chatThreadSortEventId).toBe(first?.chatThreadSortEventId);
  click(await findFastControl("button", "Revoke", dialog));
  await within(dialog).findByText("Revoke banking access for this workspace?");
  click(await findFastControl("button", "Revoke", dialog));
  await expect(
    within(dialog).findByRole("checkbox", { name: /Operating account/ }),
  ).resolves.not.toBeChecked();
  await expect(
    findFastControl("button", "Grant access", dialog),
  ).resolves.toBeDisabled();
  expect(revocations).toStrictEqual([{}]);
});
