import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  installation,
  providerContract,
  botWorkspace,
  visitProvider,
} from "./provider-bot-fixtures.ts";

const context = testContext();

async function press(name: string, scope: ParentNode = document.body) {
  click(await findAction("button", name, scope));
}

async function credentials(appId: string, secret: string) {
  await press("Next");
  await fill(
    await screen.findByLabelText("App ID", { selector: "input" }),
    appId,
  );
  await fill(
    screen.getByLabelText("App Secret", { selector: "input" }),
    secret,
  );
}

test("integrations-feishu-001 Works opens the bot creation guide before credentials or verification", async () => {
  botWorkspace(context, "feishu", true, () => {
    return [];
  });
  await visitProvider(context, "feishu", "/works");
  click(await screen.findByTestId("feishu-setup-button"));
  click(await findAction("link", "Add bot"));
  await expect(
    screen.findByText("Create an Agent app"),
  ).resolves.toBeInTheDocument();
  await expect(
    findAction("link", "Download the optional Okou icon"),
  ).resolves.toHaveAttribute("download", "okou-feishu-app-icon.png");
  await press("Next");
  expect(screen.getByLabelText("App ID", { selector: "input" })).toBeEnabled();
  expect(
    screen.getByLabelText("App Secret", { selector: "input" }),
  ).toBeEnabled();
  expect(screen.queryByLabelText("Verification Token")).toBeNull();
});

test("integrations-feishu-002 Enter holds credentials while availability is checked and Back preserves the draft", async () => {
  botWorkspace(context, "feishu", true, () => {
    return [];
  });
  const gate = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    providerContract("feishu").checkAppId,
    async ({ query, respond }) => {
      expect(query.appId).toBe("cli_coast");
      await gate.promise;
      return respond(200, { available: true });
    },
  );
  await visitProvider(context, "feishu", "/settings/feishu/setup");
  await credentials("cli_coast", "reef-secret");
  await userEvent.setup({ delay: null }).keyboard("{Enter}");
  await expect(findAction("button", "Checking…")).resolves.toBeDisabled();
  for (const label of ["App ID", "App Secret"]) {
    expect(screen.getByLabelText(label, { selector: "input" })).toBeDisabled();
  }
  await expect(findAction("button", "Back")).resolves.toBeDisabled();
  gate.resolve();
  await expect(
    screen.findByLabelText("Verification Token", { selector: "input" }),
  ).resolves.toBeInTheDocument();
  await expect(
    findAction("button", "Verify and continue"),
  ).resolves.toBeDisabled();
  await press("Back");
  expect(screen.getByLabelText("App ID", { selector: "input" })).toHaveValue(
    "cli_coast",
  );
  expect(
    screen.getByLabelText("App Secret", { selector: "input" }),
  ).toHaveValue("reef-secret");
  await press("Back");
  await expect(
    screen.findByText("Create an Agent app"),
  ).resolves.toBeInTheDocument();
  await press("Cancel");
  await expect(
    screen.findByRole("heading", { name: "Feishu bots" }),
  ).resolves.toBeInTheDocument();
});

test.each([
  ["feishu", "Feishu"],
  ["lark", "Lark"],
] as const)(
  "%s shows the workspace bot and connected account from Works",
  async (provider, brand) => {
    const bot = installation(provider, true);
    botWorkspace(context, provider, true, () => {
      return [bot];
    });
    await visitProvider(context, provider, "/works");
    const card = await screen.findByTestId(provider + "-setup-button");
    expect(card).toHaveTextContent(brand);
    click(card);
    await expect(
      screen.findByAltText("Harbor dispatch bot icon"),
    ).resolves.toHaveAttribute("src", bot.botAvatarUrl);
    expect(screen.getByText("Ada Shore", { exact: false })).toBeVisible();
    await press("More options for Harbor dispatch");
    await expect(findAction("button", "Uninstall")).resolves.toBeEnabled();
    expect(queryAction("link", "Manage")).toBeNull();
    expect(queryAction("link", "Add bot")).toBeNull();
  },
);

test.each([
  ["integrations-feishu-006", "feishu"],
  ["integrations-feishu-019", "lark"],
] as const)(
  "%s a failed uninstall can be retried for the same installation",
  async (_id, provider) => {
    const bot = installation(provider, true);
    let present = true;
    let failed = false;
    botWorkspace(context, provider, true, () => {
      return present ? [bot] : [];
    });
    const gate = createDeferredPromise<void>(context.signal);
    context.mocks.api(
      providerContract(provider).removeInstallation,
      async ({ params, respond }) => {
        expect(params.installationId).toBe(bot.id);
        if (!failed) {
          await gate.promise;
          failed = true;
          return respond(403, {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Harbor uninstall unavailable",
            },
          });
        }
        present = false;
        return respond(200, { success: true });
      },
    );
    await visitProvider(context, provider, "/settings/" + provider);
    await press("More options for Harbor dispatch");
    await press("Uninstall");
    const dialog = await screen.findByRole("dialog");
    await press("Uninstall", dialog);
    await userEvent.setup({ delay: null }).keyboard("{Escape}");
    expect(dialog).toBeVisible();
    await expect(
      findAction("button", "Cancel", dialog),
    ).resolves.toBeDisabled();
    await expect(
      findAction("button", "Uninstalling...", dialog),
    ).resolves.toBeDisabled();
    gate.resolve();
    await expect(
      screen.findByText("Harbor uninstall unavailable"),
    ).resolves.toBeInTheDocument();
    await expect(
      findAction("button", "Uninstall", dialog),
    ).resolves.toBeEnabled();
    await press("Uninstall", dialog);
    await expect(findAction("link", "Add bot")).resolves.toHaveAttribute(
      "href",
      "/settings/" + provider + "/setup",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

test.each([
  ["integrations-feishu-007", "feishu", "Feishu"],
  ["integrations-feishu-020", "lark", "Lark"],
] as const)(
  "%s reviewing the completed installation returns without connecting the account",
  async (_id, provider, brand) => {
    const browser = context.mocks.browser.open();
    const bot = installation(provider);
    botWorkspace(context, provider, true, () => {
      return [bot];
    });
    await visitProvider(context, provider, "/settings/" + provider);
    await press("More options for Harbor dispatch");
    click(await findAction("link", "Review guide"));
    await expect(
      screen.findByText("Create an Agent app"),
    ).resolves.toBeInTheDocument();
    await press("Next");
    const app = screen.getByLabelText("App ID", { selector: "input" });
    expect(app).toHaveValue(bot.appId);
    expect(app).toBeDisabled();
    const secret = screen.getByLabelText("App Secret", { selector: "input" });
    expect(secret).toBeDisabled();
    expect(secret).toHaveAttribute("placeholder", "Configured");
    for (const title of [
      "Add the event verification tokens",
      "Configure the OAuth redirect URL",
      "Import app and user scopes",
      "Configure event delivery",
      "Publish the app",
    ]) {
      await press("Next");
      await expect(screen.findByText(title)).resolves.toBeInTheDocument();
    }
    await press("Done");
    await expect(
      screen.findByRole("heading", { name: brand + " bots" }),
    ).resolves.toBeInTheDocument();
    await expect(findAction("button", "Connect")).resolves.toBeEnabled();
    expect(browser.calls).toStrictEqual([]);
  },
);

test("integrations-feishu-008 a connected member can disconnect their identity from the bot", async () => {
  const member = installation("feishu", true);
  botWorkspace(context, "feishu", false, () => {
    return [member];
  });
  await visitProvider(context, "feishu", "/settings/feishu", "member");
  await press("More options for Harbor dispatch");
  await expect(findAction("button", "Disconnect")).resolves.toBeEnabled();
  expect(queryAction("link", "Review guide")).toBeNull();
  expect(queryAction("link", "Manage")).toBeNull();
  expect(queryAction("button", "Uninstall")).toBeNull();
});

test("integrations-feishu-009 a disabled settings route takes the user to their home chat", async () => {
  await setupPage({
    context,
    path: "/settings/feishu",
    featureSwitches: { [FeatureSwitchKey.FeishuIntegration]: false },
  });
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  await expect(screen.findByRole("textbox")).resolves.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Feishu bots" })).toBeNull();
});

test.each([
  ["integrations-feishu-012", "feishu"],
  ["integrations-feishu-025", "lark"],
] as const)(
  "%s opens the member connection in a separate tab for the selected bot",
  async (_id, provider) => {
    const bot = installation(provider);
    botWorkspace(context, provider, false, () => {
      return [bot];
    });
    const browser = context.mocks.browser.open();
    await visitProvider(context, provider, "/settings/" + provider, "member");
    await press("Connect");
    const url = new URL(bot.connectUrl!);
    url.searchParams.set("callbackTarget", "app");
    expect(browser.calls).toContainEqual(
      expect.objectContaining({ url: url.href, target: "_blank" }),
    );
    expect(
      queryAction("button", "More options for Harbor dispatch"),
    ).toBeNull();
  },
);

test("integrations-feishu-013 replacing a registered App ID advances the current draft", async () => {
  botWorkspace(context, "feishu", true, () => {
    return [];
  });
  context.mocks.api(
    providerContract("feishu").checkAppId,
    ({ query, respond }) => {
      return query.appId === "cli_vacant"
        ? respond(200, { available: true })
        : respond(409, {
            error: {
              code: "CONFLICT",
              message: "This Feishu App ID is already registered in Okou",
            },
          });
    },
  );
  await visitProvider(context, "feishu", "/settings/feishu");
  click(await findAction("link", "Add bot"));
  await credentials("cli_occupied", "survey-key");
  await press("Next");
  await expect(
    screen.findByText("This Feishu App ID is already registered in Okou"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByLabelText("Verification Token")).toBeNull();
  await fill(
    screen.getByLabelText("App ID", { selector: "input" }),
    "cli_vacant",
  );
  await press("Next");
  await expect(
    screen.findByLabelText("Verification Token", { selector: "input" }),
  ).resolves.toBeInTheDocument();
});
