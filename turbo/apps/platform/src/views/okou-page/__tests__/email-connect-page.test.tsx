import { integrationsEmailContract } from "@okouai/api-contracts/contracts/integrations-email";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const OKOU_ADDRESS = "okou@okou.io";
const LOGIN_EMAIL = "test@example.com";
const LINK_MESSAGE_ID = "e0000000-0000-4000-a000-000000000e01";
const LINK_EXPIRES = 1_900_000_000;
const LINK_SIGNATURE = "a".repeat(64);

interface LinkProof {
  readonly messageId: string;
  readonly expires: number;
  readonly signature: string;
}

interface EmailServer {
  emails: string[];
  codes: string[];
  codeAvailable: boolean;
  /** The latest connection link proof the API received. */
  connected?: LinkProof;
}

/** The member's email integration as the API reports it. */
function mockEmailIntegration(initial: Partial<EmailServer> = {}): EmailServer {
  const server: EmailServer = {
    emails: [],
    codes: ["11112222"],
    codeAvailable: true,
    ...initial,
  };
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: OKOU_ADDRESS,
      configured: true,
      emails: [...server.emails],
      availableEmails: [],
      emailSources: {},
    });
  });
  context.mocks.api(integrationsEmailContract.createLinkCode, ({ respond }) => {
    if (!server.codeAvailable) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Code service is busy" },
      });
    }
    const code = server.codes.shift() ?? "99990000";
    return respond(200, { code, expiresAt: "2026-11-20T09:00:00.000Z" });
  });
  context.mocks.api(integrationsEmailContract.connect, ({ body, respond }) => {
    server.connected = body;
    return respond(200, { emailAddress: "verified@example.com" });
  });
  return server;
}

function control(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement | undefined {
  return queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
}

async function findEnabled(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = control(role, name, container);
    expect(found).toBeEnabled();
    return found as HTMLElement;
  });
}

test("connects in the active workspace without asking a multi-workspace user to choose again", async () => {
  const server = mockEmailIntegration();
  const query = new URLSearchParams({
    message: LINK_MESSAGE_ID,
    expires: String(LINK_EXPIRES),
    signature: LINK_SIGNATURE,
  });

  await setupPage({
    context,
    path: `/settings/email?${query.toString()}`,
    auth: {
      user: { id: "email-member", fullName: "Email Member" },
      organization: {
        activeOrg: { id: "org_email_active", name: "Active workspace" },
        memberships: [{ id: "org_email_active" }, { id: "org_email_other" }],
      },
    },
    featureSwitches: { [FeatureSwitchKey.EmailIntegration]: true },
  });

  await expect(
    screen.findByRole("heading", { name: "Email connected" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "verified@example.com is connected. Your original request will be answered in the same email conversation.",
    ),
  ).toBeInTheDocument();
  // The success notification names the verified sender.
  expect(
    within(document.body).getAllByText("verified@example.com"),
  ).not.toHaveLength(0);
  expect(server.connected).toStrictEqual({
    messageId: LINK_MESSAGE_ID,
    expires: LINK_EXPIRES,
    signature: LINK_SIGNATURE,
  });
  expect(window.location.pathname).toBe("/settings/email");
  expect(control("link", "Open email")).toHaveAttribute(
    "href",
    `mailto:${OKOU_ADDRESS}`,
  );
  // The active workspace is used; no workspace choice is offered.
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(control("button", "Switch workspace")).toBeUndefined();
});

test("opens unsigned email settings with the login email connected", async () => {
  mockEmailIntegration({ emails: [LOGIN_EMAIL] });

  await setupPage({
    context,
    path: "/settings/email",
    featureSwitches: { [FeatureSwitchKey.EmailIntegration]: true },
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Email connections",
  });
  expect(window.location.pathname).toBe("/works");
  await expect(
    within(dialog).findByRole("row", { name: LOGIN_EMAIL }),
  ).resolves.toBeInTheDocument();
  await expect(
    findEnabled("button", "Add email", dialog),
  ).resolves.toBeInTheDocument();

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(document.activeElement).toBe(control("button", "Email options"));
});

async function openEmailConnections(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.EmailIntegration]: true },
  });
  click(await findEnabled("button", "Email options"));
  click(await findEnabled("button", "Manage"));
  return await screen.findByRole("dialog", { name: "Email connections" });
}

test("adds an email from the Works card with a short code and updates the open dialog", async () => {
  const server = mockEmailIntegration({
    emails: [LOGIN_EMAIL],
    codes: ["11112222", "33334444"],
  });
  const dialog = await openEmailConnections();
  click(await findEnabled("button", "Add email", dialog));
  await expect(
    within(dialog).findByText("11112222"),
  ).resolves.toBeInTheDocument();
  const user = userEvent.setup({ delay: null });
  const clipboard = context.mocks.browser.clipboardWriteText();

  await user.click(
    await findEnabled("button", "Copy connection code 11112222", dialog),
  );
  await waitFor(() => {
    expect(clipboard.writes.at(-1)).toBe("11112222");
  });
  click(await findEnabled("button", "Generate new code", dialog));

  await expect(
    within(dialog).findByText("33334444"),
  ).resolves.toBeInTheDocument();
  expect(control("link", "Open email", dialog)).toHaveAttribute(
    "href",
    `mailto:${OKOU_ADDRESS}?subject=33334444&body=33334444`,
  );

  // The member sends the code, and the API announces the new sender.
  server.emails = [LOGIN_EMAIL, "new.sender@example.com"];
  context.mocks.ably.trigger("email:changed");

  await expect(
    within(dialog).findByRole("row", { name: "new.sender@example.com" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/works");
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(document.activeElement).toBe(control("button", "Email options"));
});

test("keeps a failed code request in the dialog and lets the user retry", async () => {
  const server = mockEmailIntegration({
    emails: [LOGIN_EMAIL],
    codes: ["12345678"],
    codeAvailable: false,
  });
  const dialog = await openEmailConnections();

  click(await findEnabled("button", "Add email", dialog));

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Could not create a connection code. Try again.",
  );
  expect(screen.getByRole("dialog", { name: "Email connections" })).toBe(
    dialog,
  );

  server.codeAvailable = true;
  click(await findEnabled("button", "Add email", dialog));

  await expect(
    within(dialog).findByText("12345678"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
});
