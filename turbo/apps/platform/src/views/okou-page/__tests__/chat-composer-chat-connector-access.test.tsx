import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  chatConnectorAccessContract,
  type ChatConnectorAccess,
} from "@okouai/api-contracts/contracts/chat-connector-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  builtinConnector,
  connectorAccount,
  createComposerConnectorHelpers,
  permissionDetail,
  SCOUT_THREAD_ID,
  chatConnectorOverviewFixture,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  findComposer,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);
const target = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "github",
});
const work = connectorAccount({
  id: "f0000000-0000-4000-a000-000000000091",
  target,
  displayName: "Work",
  isDefault: true,
});
const personal = connectorAccount({
  id: "f0000000-0000-4000-a000-000000000092",
  target,
  displayName: "Personal",
  isDefault: false,
});

function installAccounts(personalEnabled: boolean): ChatConnectorAccess {
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: "github",
        label: "GitHub",
        hasPermissions: true,
      }),
    ],
    accounts: [work, personal],
    permissionDetails: new Map([
      [
        "github",
        permissionDetail("github", "GitHub", ["repos|read", "repos|write"]),
      ],
    ]),
  });
  return {
    target,
    currentConnectionId: work.id,
    available: true,
    accounts: [work, personal].map((account) => {
      const enabled = account.id === work.id || personalEnabled;
      return {
        connectionId: account.id,
        displayName: account.displayName,
        isDefault: account.isDefault,
        defaultEnabled: enabled,
        enabled,
        overrideEnabled: null,
      };
    }),
  };
}
async function openMenu(label = "GitHub") {
  click(await findFastControl("button", "Connectors"));
  return await waitFor(() => {
    const row = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes(label);
    });
    if (!row) {
      throw new Error(`${label} account row not found`);
    }
    return row;
  });
}

test("Edit member account policy in Composer and send the first message without Chat overrides", async () => {
  const user = userEvent.setup({ delay: null });
  const access = installAccounts(false);
  let personalPolicy = {
    connectionId: personal.id,
    allowed: false,
    enabled: false,
    expiresAt: null,
  };
  context.mocks.api(
    chatConnectorAccessContract.accountPolicies,
    ({ respond }) => {
      return respond(200, [
        {
          connectionId: work.id,
          allowed: true,
          enabled: true,
          expiresAt: null,
        },
        personalPolicy,
      ]);
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.updateAccountPolicy,
    ({ params, body, respond }) => {
      expect(params.connectionId).toBe(personal.id);
      expect(body.target).toStrictEqual(target);
      expect(body.policy).toBe("allow-always");
      personalPolicy = { ...personalPolicy, allowed: true, enabled: true };
      return respond(200, personalPolicy);
    },
  );
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    const overview = chatConnectorOverviewFixture({
      target,
      label: "GitHub",
      accounts: [work, personal],
      access,
      hasPermissions: true,
    });
    return respond(200, [
      {
        ...overview,
        accounts: overview.accounts.map((account) => {
          return {
            ...account,
            defaultEnabled: true,
            enabled:
              account.connectionId === personal.id
                ? personalPolicy.enabled
                : account.enabled,
          };
        }),
      },
    ]);
  });
  context.mocks.api(
    chatConnectorAccessContract.setThreadOverride,
    ({ respond }) => {
      return respond(400, {
        error: {
          code: "BAD_REQUEST",
          message: "Legacy overrides are disabled",
        },
      });
    },
  );
  await setupPage({
    context,
    path: "/",
    locale: "en-US",
    featureSwitches: { [FeatureSwitchKey.MemberConnectorAccountAccess]: true },
  });
  const editor = await findComposer();
  await user.click(await openMenu());
  const panel = await screen.findByRole("group", { name: "GitHub" });
  expect(within(panel).queryByRole("switch")).toBeNull();
  await user.click(
    await findFastControl("button", "Personal access, Deny", panel),
  );
  await user.click(
    within(await screen.findByRole("menu")).getByText("Allow always"),
  );
  await expect(
    findFastControl("button", "Personal access, Allow, Always", panel),
  ).resolves.toBeEnabled();
  await user.keyboard("{Escape}{Escape}");
  await fill(editor, "Use my GitHub account");
  click(await findFastControl("button", "Send"));
  await waitFor(() => {
    expect(window.location.pathname).toMatch(/^\/chats\//u);
  });
});

test("Refresh Composer eligibility when a member policy save finishes after closing the account manager", async () => {
  const user = userEvent.setup({ delay: null });
  const committed = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  const chat = installAccounts(true);
  let workPolicy = {
    connectionId: work.id,
    allowed: true,
    enabled: true,
    expiresAt: null,
  };
  context.mocks.api(
    chatConnectorAccessContract.accountPolicies,
    ({ respond }) => {
      return respond(200, [
        workPolicy,
        {
          connectionId: personal.id,
          allowed: true,
          enabled: true,
          expiresAt: null,
        },
      ]);
    },
  );
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    const overview = chatConnectorOverviewFixture({
      target,
      label: "GitHub",
      accounts: [work, personal],
      access: {
        ...chat,
        accounts: chat.accounts.map((account) => {
          return account.connectionId === work.id
            ? { ...account, enabled: workPolicy.enabled }
            : account;
        }),
        currentConnectionId: workPolicy.enabled ? work.id : personal.id,
      },
      hasPermissions: true,
    });
    return respond(200, [overview]);
  });
  context.mocks.api(
    chatConnectorAccessContract.updateAccountPolicy,
    async ({ params, body, respond }) => {
      expect(params.connectionId).toBe(work.id);
      expect(body.policy).toBe("deny");
      committed.resolve();
      await response.promise;
      workPolicy = { ...workPolicy, allowed: false, enabled: false };
      return respond(200, workPolicy);
    },
  );
  await setupPage({
    context,
    path: `/chats/${SCOUT_THREAD_ID}`,
    locale: "en-US",
    featureSwitches: { [FeatureSwitchKey.MemberConnectorAccountAccess]: true },
  });
  await user.click(await openMenu());
  await user.click(await findFastControl("button", "Manage accounts"));
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  await user.click(
    await findFastControl("button", "Work access, Allow, Always", manager),
  );
  await user.click(within(await screen.findByRole("menu")).getByText("Deny"));
  await committed.promise;
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Manage GitHub accounts" }),
    ).toBeNull();
  });
  await user.click(await openMenu());
  const accounts = within(await screen.findByRole("group", { name: "GitHub" }));
  await expect(accounts.findAllByText("Allow")).resolves.toHaveLength(2);
  response.resolve();
  await expect(accounts.findByText("Deny")).resolves.toBeInTheDocument();
});
