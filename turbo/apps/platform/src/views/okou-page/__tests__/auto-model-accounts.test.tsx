import { screen, within, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";
import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import {
  providerGroup,
  personalAccount,
  serveClaudeLogin,
  serveCodexLogin,
} from "./personal-account-settings-fixtures.ts";
const context = testContext();
async function models() {
  await setupPage({ context, path: "/?settings=model" });
}

test("auto-model-accounts-001 each empty provider opens its own authorization and accepts cancellation", async () => {
  serveClaudeLogin(context);
  serveCodexLogin(context);
  await models();
  for (const [provider, title] of [
    ["Claude", "Connect Claude"],
    ["ChatGPT (Codex)", "Connect Codex"],
  ] as const) {
    const section = await providerGroup(provider);
    await section.findByText("No accounts connected.");
    const connect = section.button("Connect account");
    expect(connect).toBeEnabled();
    click(connect);
    const login = await screen.findByRole("dialog", { name: title });
    expect(screen.queryByRole("menu")).toBeNull();
    if (provider === "Claude") {
      await findAction("link", "Open Claude approval page", login);
    } else {
      await within(login).findByText("PLAN-8261");
    }
    click(getAction("button", "Close", login));
    await waitFor(() => {
      return expect(login).not.toBeInTheDocument();
    });
    expect(connect).toBeEnabled();
  }
});
test("auto-model-accounts-002 the confirmed list publishes the Claude identity after authorization", async () => {
  const member = personalAccount("Claude");
  const release = context.mocks.deferred<void>();
  const reading = context.mocks.deferred<void>();
  let authorized = false;
  serveClaudeLogin(context);
  context.mocks.api(
    claudeCodeDeviceAuthContract.complete,
    ({ respond, body }) => {
      authorized = body.authorizationCode === "user-proof";
      return respond(200, {
        created: true,
        status: "complete",
        provider: member,
      });
    },
  );
  context.mocks.api(
    thirdPartySubscriptionsMainContract.list,
    async ({ respond }) => {
      if (authorized) {
        if (!reading.settled()) {
          reading.resolve();
        }
        await release.promise;
      }
      return respond(200, { subscriptions: authorized ? [member] : [] });
    },
  );
  await models();
  const section = await providerGroup("Claude");
  await section.findByText("No accounts connected.");
  click(section.button("Connect account"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Claude" });
  await fill(await within(dialog).findByRole("textbox"), "user-proof");
  click(getAction("button", "Connect", dialog));
  await reading.promise;
  expect(screen.queryByText("member1@example.test")).toBeNull();
  release.resolve();
  await screen.findByText("member1@example.test");
  const confirmed = await providerGroup("Claude");
  expect(confirmed.getByText("member1@example.test")).toBeVisible();
  expect(confirmed.getByText("Connected")).toBeVisible();
  expect(confirmed.button("Connect account")).toBeEnabled();
  const other = await providerGroup("ChatGPT (Codex)");
  expect(other.getByText("No accounts connected.")).toBeVisible();
  expect(other.button("Connect account")).toBeEnabled();
});
test("auto-model-accounts-005 the Codex section directly displays the device code", async () => {
  serveCodexLogin(context);
  await models();
  const section = await providerGroup("ChatGPT (Codex)");
  await section.findByText("No accounts connected.");
  click(section.button("Connect account"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  await expect(within(dialog).findByText("PLAN-8261")).resolves.toBeVisible();
  expect(screen.queryByRole("menu")).toBeNull();
});
test("auto-model-accounts-006 a full Claude group leaves room to connect a ChatGPT account", async () => {
  context.mocks.data.personalModelProviders(
    Array.from({ length: 10 }, (_, i) => {
      return personalAccount("Claude", i + 1);
    }),
  );
  await models();
  const full = await providerGroup("Claude");
  await full.findByText("member10@example.test");
  expect(full.button("Connect account")).toBeDisabled();
  const empty = await providerGroup("ChatGPT (Codex)");
  expect(empty.getByText("No accounts connected.")).toBeVisible();
  expect(empty.button("Connect account")).toBeEnabled();
});
