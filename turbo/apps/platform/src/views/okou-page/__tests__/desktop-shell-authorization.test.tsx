import {
  desktopShellAuthorizationContract as contract,
  type DesktopShellAuthorization,
} from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const ID = "10000000-0000-4000-8000-000000000001";
const THREAD_ID = "20000000-0000-4000-8000-000000000001";
const PATH = `/computer-use/shell/authorize/${ID}`;
const URL = `https://app.okou.ai${PATH}`;

function findButton(card: HTMLElement, name: string) {
  return queryAllByRoleFast("button", card).find((element) => {
    return element.textContent?.trim() === name;
  });
}

function button(card: HTMLElement, name: string) {
  const element = findButton(card, name);
  if (!element) {
    throw new Error(`Missing button: ${name}`);
  }
  return element;
}

function authorization(
  overrides: Partial<DesktopShellAuthorization> = {},
): DesktopShellAuthorization {
  return {
    id: ID,
    chatThreadId: THREAD_ID,
    computerUseHostId: "30000000-0000-4000-8000-000000000001",
    requestedByRunId: "40000000-0000-4000-8000-000000000001",
    computerName: "Work Mac",
    reason: "Run the project tests",
    status: "pending",
    requestExpiresAt: "2099-10-20T11:00:00.000Z",
    approvedAt: null,
    grantExpiresAt: null,
    approvalBlockedReason: null,
    authorizationUrl: URL,
    ...overrides,
  };
}

async function setupChat(content: string) {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Shell approval",
    chatEvents: [
      {
        id: "shell-access-request",
        role: "assistant",
        runId: "request-run",
        content,
        createdAt: "2026-10-20T10:00:00.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
}

test("A trusted link becomes a persistent card and approval only uses the explicit action", async () => {
  let current = authorization();
  let approvals = 0;
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(contract.approve, ({ params, body, respond }) => {
    expect(params.id).toBe(ID);
    expect(body).toStrictEqual({});
    approvals++;
    current = authorization({
      status: "approved",
      approvedAt: "2099-10-20T10:00:00.000Z",
      grantExpiresAt: "2099-10-20T11:00:00.000Z",
    });
    return respond(200, current);
  });
  context.mocks.api(contract.revoke, ({ respond }) => {
    current = { ...current, status: "revoked" };
    return respond(200, current);
  });
  await setupChat(`[Allow Shell access](${URL})`);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    return expect(button(card, "Allow for 1 hour")).toBeEnabled();
  });
  expect(within(card).getByText("Work Mac")).toBeVisible();
  expect(within(card).getByText("Run the project tests")).toBeVisible();
  expect(approvals).toBe(0);
  await click(button(card, "Allow for 1 hour"));
  await waitFor(() => {
    return expect(button(card, "Revoke access")).toBeEnabled();
  });
  expect(screen.getByTestId("desktop-shell-authorization-card")).toBe(card);
  expect(approvals).toBe(1);
  await click(button(card, "Revoke access"));
  await waitFor(() => {
    return expect(within(card).getByText("Shell access revoked")).toBeVisible();
  });
  expect(screen.getByTestId("desktop-shell-authorization-card")).toBe(card);
});

test("The direct page waits for the requesting Run to end and never approves on navigation", async () => {
  let current = authorization({ approvalBlockedReason: "run_active" });
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, current);
  });
  await setupPage({ context, path: PATH, host: "app.okou.ai" });
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    return expect(button(card, "Allow for 1 hour")).toBeDisabled();
  });
  current = authorization();
  await click(button(card, "Refresh"));
  await waitFor(() => {
    return expect(button(card, "Allow for 1 hour")).toBeEnabled();
  });
  expect(screen.getByTestId("desktop-shell-authorization-card")).toBe(card);
});

test("A request for another chat stays unavailable in this transcript", async () => {
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(
      200,
      authorization({ chatThreadId: "50000000-0000-4000-8000-000000000001" }),
    );
  });
  await setupChat(URL);
  const card = await screen.findByTestId("desktop-shell-authorization-card");
  await waitFor(() => {
    return expect(
      within(card).getByText("Authorization unavailable"),
    ).toBeVisible();
  });
  expect(findButton(card, "Allow for 1 hour")).toBeUndefined();
});

test("An external URL with the same path remains an ordinary link", async () => {
  await setupChat(`[Shell access](https://untrusted.example${PATH})`);
  await waitFor(() => {
    expect(
      queryAllByRoleFast("link").find((element) => {
        return element.textContent?.trim() === "Shell access";
      }),
    ).toHaveAttribute("href", `https://untrusted.example${PATH}`);
  });
  expect(screen.queryByTestId("desktop-shell-authorization-card")).toBeNull();
});
