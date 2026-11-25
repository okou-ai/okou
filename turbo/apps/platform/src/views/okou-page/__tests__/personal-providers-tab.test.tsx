import { screen, within, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { personalModelProviderAccountsByIdContract as accounts } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  providerGroup,
  personalAccount,
  serveClaudeLogin,
  usageWindow,
} from "./personal-account-settings-fixtures.ts";
const context = testContext();
async function models() {
  await setupPage({ context, path: "/?settings=model" });
}

async function disconnect() {
  const section = await providerGroup("ChatGPT (Codex)");
  await section.findByText("member1@example.test");
  click(section.button("More options"));
  click(
    await within(await screen.findByRole("menu")).findByText(
      "Disconnect account",
      { exact: true },
    ),
  );
  return screen.findByRole("dialog", { name: /Disconnect member1/u });
}
test("personal-providers-tab-006 ChatGPT accounts occupy a labelled table before the empty Claude group", async () => {
  context.mocks.data.personalModelProviders([
    personalAccount("ChatGPT"),
    personalAccount("ChatGPT", 2),
  ]);
  await models();
  const codex = await providerGroup("ChatGPT (Codex)");
  const claude = await providerGroup("Claude");
  await codex.findByText("member2@example.test");
  const heading = codex.getByRole("heading", { name: "ChatGPT (Codex)" });
  expect(
    heading.compareDocumentPosition(claude.getByRole("heading")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const table = codex.getByRole("table", { name: "ChatGPT (Codex)" });
  expect(table).toHaveAttribute("aria-labelledby", heading.id);
  expect(within(table).getByText("member1@example.test")).toBeVisible();
  expect(within(table).getByText("member2@example.test")).toBeVisible();
  expect(claude.getByText("No accounts connected.")).toBeVisible();
  expect(claude.queryByRole("table")).toBeNull();
});
test("personal-providers-tab-008 removing a saved account explains the provider subscription and confirms disconnection", async () => {
  context.mocks.data.personalModelProviders([personalAccount("ChatGPT")]);
  await models();
  const dialog = await disconnect();
  expect(
    within(dialog).getByText(
      "This removes the account from Okou. It won’t cancel your subscription with the provider.",
    ),
  ).toBeVisible();
  click(getAction("button", "Disconnect account", dialog));
  await screen.findByText("Account disconnected");
  await (
    await providerGroup("ChatGPT (Codex)")
  ).findByText("No accounts connected.");
  expect(screen.queryByText("member1@example.test")).toBeNull();
  expect(dialog).not.toBeInTheDocument();
});
test("personal-providers-tab-009 a failed disconnection keeps the account available for a confirmed retry", async () => {
  const member = personalAccount("ChatGPT");
  context.mocks.data.personalModelProviders([member]);
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let failing = true;
  context.mocks.api(accounts.delete, async ({ params, respond }) => {
    if (failing) {
      started.resolve();
      await release.promise;
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Disconnect failed" },
      });
    }
    if (params.id === member.id) {
      context.mocks.data.personalModelProviders([]);
    }
    return respond(204);
  });
  await models();
  const dialog = await disconnect();
  click(getAction("button", "Disconnect account", dialog));
  await started.promise;
  expect(getAction("button", "Disconnecting…", dialog)).toBeDisabled();
  expect(getAction("button", "Cancel", dialog)).toBeDisabled();
  release.resolve();
  await screen.findByText("Disconnect failed");
  expect(dialog).toBeVisible();
  expect(screen.getByText("member1@example.test")).toBeInTheDocument();
  failing = false;
  click(getAction("button", "Disconnect account", dialog));
  await screen.findByText("Account disconnected");
  await (
    await providerGroup("ChatGPT (Codex)")
  ).findByText("No accounts connected.");
  expect(dialog).not.toBeInTheDocument();
  expect(screen.queryByText("member1@example.test")).toBeNull();
});
test("personal-providers-tab-010 switching ChatGPT accounts preserves both balances and opens exhausted usage", async () => {
  const usage = {
    fiveHour: usageWindow(0, 18_000),
    weekly: usageWindow(0, 604_800),
  };
  context.mocks.data.personalModelProviders([
    personalAccount("ChatGPT", 1, {
      subscriptionCredits: { balance: 1250.5, unlimited: false },
    }),
    personalAccount("ChatGPT", 2, {
      subscriptionCredits: { balance: 0, unlimited: false },
      subscriptionUsage: usage,
    }),
  ]);
  await models();
  const section = await providerGroup("ChatGPT (Codex)");
  await section.findByText("member2@example.test");
  const [a, b] = section.getAllByRole("row");
  const select = (row: HTMLElement) => {
    return within(row).getByLabelText(/^(Active|Use):/u, {
      selector: "button",
    });
  };
  expect(select(a!)).toHaveAttribute("aria-pressed", "true");
  click(select(b!));
  await waitFor(() => {
    return expect(select(b!)).toHaveAttribute("aria-pressed", "true");
  });
  expect(select(a!)).toHaveAttribute("aria-pressed", "false");
  expect(a).toHaveTextContent("1,250.5");
  expect(b).toHaveTextContent(/0 ChatGPT credits/u);
  await userEvent.setup().keyboard("{Escape}");
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).toBeNull();
  });
  click(
    await screen.findByLabelText(/^Subscription usage/u, {
      selector: "button",
    }),
  );
  await screen.findByText("Limit reached");
  expect(screen.getByText("Credits", { exact: true })).toBeVisible();
  expect(screen.getByText("0", { exact: true })).toBeVisible();
});
test("personal-providers-tab-011 an external workspace member can connect either empty personal group", async () => {
  const org = { id: "org_guest", name: "Partner team" };
  context.mocks.data.org({ ...org, role: "member" });
  await setupPage({
    context,
    path: "/?settings=model",
    auth: {
      user: { id: "member_guest", fullName: "Grace Park" },
      organization: { activeOrg: org, memberships: [{ id: org.id }] },
    },
  });
  for (const name of ["Claude", "ChatGPT (Codex)"]) {
    const section = await providerGroup(name);
    await section.findByText("No accounts connected.");
    expect(section.button("Connect account")).toBeEnabled();
  }
});
test("personal-providers-tab-012 Claude add mode is personal and cancellation restores the group action", async () => {
  const request = serveClaudeLogin(context);
  await models();
  const area = await providerGroup("Claude");
  await area.findByText("No accounts connected.");
  click(area.button("Connect account"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Claude" });
  await within(dialog).findByRole("textbox");
  expect(request()).toMatchObject({ scope: "personal", mode: "add" });
  expect(
    within(dialog).getByText(
      "Sign in with your Claude subscription to use Claude models with Claude Code-backed agents.",
    ),
  ).toBeVisible();
  click(getAction("button", "Close", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  expect(area.button("Connect account")).toBeEnabled();
});
test("personal-providers-tab-013 submitting the code adds the Pro identity and both usage windows", async () => {
  serveClaudeLogin(context);
  const member = personalAccount("Claude", 3, {
    subscriptionUsage: {
      fiveHour: usageWindow(88, 18_000),
      weekly: usageWindow(76, 604_800),
    },
  });
  context.mocks.api(
    claudeCodeDeviceAuthContract.complete,
    ({ body, respond }) => {
      if (body.authorizationCode === "local-approval") {
        context.mocks.data.personalModelProviders([member]);
      }
      return respond(200, {
        status: "complete",
        created: true,
        provider: member,
      });
    },
  );
  await models();
  const area = await providerGroup("Claude");
  await area.findByText("No accounts connected.");
  click(area.button("Connect account"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Claude" });
  await fill(await within(dialog).findByRole("textbox"), "local-approval");
  click(getAction("button", "Connect", dialog));
  await screen.findByText("Claude connected");
  await area.findByText("member3@example.test");
  const row = within(area.getByRole("row"));
  expect(row.getByText("Pro")).toBeVisible();
  expect(
    row.getByRole("progressbar", { name: /5h remaining/u }),
  ).toHaveAttribute("aria-valuenow", "88");
  expect(
    row.getByRole("progressbar", { name: /Week remaining/u }),
  ).toHaveAttribute("aria-valuenow", "76");
});
