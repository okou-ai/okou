import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogAuthMethodDetail,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorOauthStartContract,
  builtinConnectorOauthDeviceAuthSessionContract,
} from "@okouai/api-contracts/contracts/connectors";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findButton,
  findEnabledButton,
  queryButton,
} from "./chat-run-test-fixtures.ts";
import { findNamedLink } from "./chat-attachment-test-helpers.ts";
import {
  publicStatusItem,
  mockPublicConnectorStatus,
  mockSavedConnectorAccounts,
} from "./connector-page-test-helpers.ts";
const context = testContext();

function catalog(
  slug: string,
  label: string,
  method: PublicConnectorCatalogAuthMethodDetail,
) {
  const item = publicStatusItem({
    connectorSlug: slug,
    label,
    authMethods: [method],
  });
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, { connector: item });
  });
  mockPublicConnectorStatus(context, [item]);
}
const manual = {
  id: "api-token",
  label: "Provider token",
  description: null,
  grantKind: "manual",
  supportsRefresh: false,
  startOptions: [],
  manualFields: [
    {
      id: "token",
      label: "Token",
      required: true,
      placeholder: null,
      inputType: "password",
    },
  ],
} as const;
test("connectors-auth-methods-003 Mercury identifies its banking partners on the card and inside the connect dialog", async () => {
  catalog("mercury", "Mercury", {
    ...manual,
    startOptions: [],
    manualFields: [...manual.manualFields],
  });
  await setupPage({ context, path: "/connectors" });
  const disclosure =
    "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.";
  const region = { name: "Mercury banking disclosure" };
  const card = await screen.findByRole("region", region);
  expect(card).toHaveTextContent(disclosure);
  await expect(
    findNamedLink("Powered by Mercury", card),
  ).resolves.toHaveAttribute("href", "https://mercury.com");
  click(await findButton("Connect Mercury"));
  const form = await screen.findByRole("dialog", { name: "Mercury" });
  const inside = within(form).getByRole("region", region);
  expect(inside).toHaveTextContent(disclosure);
  await expect(
    findNamedLink("Powered by Mercury", inside),
  ).resolves.toHaveAttribute("href", "https://mercury.com");
});

test("connectors-auth-methods-012 PlayStation presents the provider's instructions alongside code entry", async () => {
  const url = "https://playstation.example.test/authorize";
  catalog("playstation", "PlayStation", {
    id: "cli",
    grantKind: "external-code",
    label: "Console sign-in",
    description: `Follow [PlayStation instructions](${url}) to retrieve a code.`,
    supportsRefresh: true,
    startOptions: [],
    manualFields: [],
  });
  await setupPage({ context, path: "/connectors" });
  click(await findButton("Connect PlayStation"));
  click(await findButton("Start PlayStation sign-in"));
  const dialog = screen.getByRole("dialog", { name: "PlayStation" });
  await findEnabledButton("Open PlayStation sign-in", dialog);
  await expect(
    findNamedLink("PlayStation instructions", dialog),
  ).resolves.toHaveAttribute("href", url);
  expect(
    within(dialog).getByRole("textbox", { name: "Code" }),
  ).toBeInTheDocument();
});

test("connectors-auth-methods-017 Live mode submits the chosen Stripe device option and reports an unavailable poll", async () => {
  catalog("stripe", "Stripe", {
    id: "cli",
    grantKind: "device-auth",
    label: "Device",
    description: null,
    supportsRefresh: false,
    manualFields: [],
    startOptions: [
      {
        id: "mode",
        kind: "select",
        label: "Mode",
        required: true,
        defaultValue: null,
        options: [
          { label: "Test", value: "test" },
          { label: "Live", value: "live" },
        ],
      },
    ],
  });
  let selected: string | undefined;
  context.mocks.api(
    builtinConnectorOauthDeviceAuthSessionContract.create,
    ({ body, respond }) => {
      selected = body.options?.mode;
      return respond(200, {
        connectorSlug: "stripe",
        sessionId: crypto.randomUUID(),
        sessionToken: "fixture-session",
        status: "pending",
        userCode: "VERIFY",
        verificationUri: "https://stripe.example.test/device",
        expiresIn: 60,
        interval: 1,
      });
    },
  );
  context.mocks.api(
    builtinConnectorOauthDeviceAuthSessionContract.poll,
    ({ respond }) => {
      return respond(500, {
        error: {
          code: "UNAVAILABLE",
          message: "Stripe device authorization is unavailable",
        },
      });
    },
  );
  await setupPage({ context, path: "/connectors" });
  click(await findButton("Connect Stripe"));
  const form = await screen.findByRole("dialog", { name: "Stripe" });
  const action = queryButton("Connect Stripe", form);
  expect(action).toBeDisabled();
  click(within(form).getByRole("combobox"));
  click(await screen.findByRole("option", { name: "Live" }));
  expect(action).toBeEnabled();
  click(action!);
  await screen.findByText(/Stripe device authorization is unavailable/);
  expect(selected).toBe("live");
});

test("connectors-auth-methods-018 Notion launches the catalog OAuth method for the app callback", async () => {
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  const launch = context.mocks.browser.open(popup);
  const url = "https://notion.example.test/grant";
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ params, body, respond }) => {
      return respond(200, {
        authorizationUrl:
          params.connectorSlug === "notion" && body.callbackTarget === "app"
            ? url
            : "https://invalid.example.test/",
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  await setupPage({ context, path: "/connectors" });
  click(await findButton("Connect Notion"));
  await waitFor(() => {
    return expect(popup.location.href).toBe(url);
  });
  expect(launch.calls).toHaveLength(1);
  expect(
    screen.queryByRole("dialog", { name: "Notion" }),
  ).not.toBeInTheDocument();
  popup.close();
});

function ahrefsAccounts() {
  const saved: ReturnType<typeof connectorAccountFixture>[] = [];
  mockSavedConnectorAccounts(context, () => {
    return saved;
  });
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ params, body, respond }) => {
      const account = connectorAccountFixture(
        { kind: "builtin", connectorSlug: params.connectorSlug },
        { authMethod: body.authMethod, isDefault: saved.length === 0 },
      );
      saved.push(account);
      context.mocks.ably.trigger("connector:changed", {
        connectorSlug: params.connectorSlug,
      });
      return respond(200, { connectionId: account.id });
    },
  );
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const account = saved.find((item) => {
        return item.id === params.connectionId;
      });
      return account
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Unknown account" },
          });
    },
  );
  return saved;
}

test("connectors-auth-methods-015 retrying saves the same Ahrefs account with its trimmed name", async () => {
  const saved = ahrefsAccounts();
  let accountId: string | undefined;
  context.mocks.api(
    connectorAccountsContract.rename,
    ({ params, body, respond }) => {
      if (!accountId) {
        accountId = params.connectionId;
        return respond(400, {
          error: { code: "INVALID", message: "Rename failed" },
        });
      }
      if (accountId !== params.connectionId) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Another account" },
        });
      }
      const account = saved.find((item) => {
        return item.id === params.connectionId;
      })!;
      account.displayName = body.displayName;
      return respond(200, account);
    },
  );
  await setupPage({ context, path: "/connectors" });
  click(await findButton("Connect Ahrefs"));
  await fill(
    await screen.findByPlaceholderText("your-ahrefs-api-token"),
    "fixture-key-only",
  );
  click(await findButton("Save"));
  const naming = await screen.findByRole("dialog", {
    name: "Name your Ahrefs account",
  });
  const field = within(naming).getByRole("textbox", { name: "Account name" });
  await fill(field, " Work ");
  click(await findEnabledButton("Save", naming));
  await screen.findByText("Rename failed");
  expect(field).toHaveValue(" Work ");
  click(await findEnabledButton("Save", naming));
  await waitFor(() => {
    return expect(naming).not.toBeInTheDocument();
  });
  expect(saved[0]?.displayName).toBe("Work");
  click(await findButton("Manage Ahrefs accounts"));
  await screen.findByRole("group", { name: "Work" });
});

test("connectors-auth-methods-016 a pending save for the first Ahrefs account leaves the replacement naming prompt intact", async () => {
  const resume = context.mocks.deferred<void>();
  const started = context.mocks.deferred<void>();
  const saved = ahrefsAccounts();
  context.mocks.api(
    connectorAccountsContract.rename,
    async ({ params, body, respond }) => {
      started.resolve();
      await resume.promise;
      const account = saved.find((item) => {
        return item.id === params.connectionId;
      })!;
      account.displayName = body.displayName;
      return respond(200, account);
    },
  );
  async function submitCredentials(value: string) {
    await fill(
      await screen.findByPlaceholderText("your-ahrefs-api-token"),
      value,
    );
    click(await findButton("Save"));
    return screen.findByRole("dialog", { name: "Name your Ahrefs account" });
  }
  await setupPage({ context, path: "/connectors" });
  click(await findButton("Connect Ahrefs"));
  const first = await submitCredentials("first-fixture");
  await fill(within(first).getByLabelText("Account name"), "First account");
  click(await findEnabledButton("Save", first));
  await started.promise;
  click(await findButton("Skip"));
  click(await findButton("Manage Ahrefs accounts"));
  click(await findButton("Add account"));
  const second = await submitCredentials("second-fixture");
  const draft = within(second).getByLabelText("Account name");
  await fill(draft, "Second account draft");
  expect(queryButton("Save", second)).toBeDisabled();
  resume.resolve();

  await findEnabledButton("Save", second);
  expect(draft).toHaveValue("Second account draft");
  click(await findButton("Skip"));
  click(await findButton("Manage Ahrefs accounts"));
  await screen.findByRole("group", { name: "First account" });
  expect(
    saved.map((item) => {
      return item.displayName;
    }),
  ).toStrictEqual(["First account", null]);
});
