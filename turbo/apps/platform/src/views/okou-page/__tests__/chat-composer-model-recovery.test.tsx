import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  setupPage,
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockSubscriptionRunModel } from "../../../mocks/handlers/api-run-models.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  findEnabledButton,
  queryButton,
} from "./chat-run-test-fixtures.ts";
import { buildProvider } from "./chat-model-builders.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";

const context = testContext();
const account = buildProvider({
  type: "codex-oauth-token",
  framework: "codex",
  id: "0207463a-8a96-4f33-a03f-f59846061a4d",
  isActive: true,
});
const approvalUrl = "https://auth.example.test/device";
function deviceSession(code: string) {
  return {
    sessionToken: "local-device-session",
    scope: "personal" as const,
    type: "codex" as const,
    status: "pending" as const,
    verificationCode: code,
    browserUrl: approvalUrl,
    interval: 1,
    expiresIn: 600,
  };
}

test("chat-composer-model-recovery-001 restores the drafted chat after approving the Codex device code", async () => {
  createChatRunFixtures(context).installRunChat({
    selectedModel: "gpt-5.6-luna",
  });
  context.mocks.data.personalModelProviders([]);
  context.mocks.data.availableRunModels([
    mockSubscriptionRunModel("gpt-5.6-luna", {
      availability: "reconnect_required",
    }),
  ]);
  const approve = context.mocks.deferred<void>();
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, deviceSession("ABCD-EFGH"));
  });
  context.mocks.api(codexDeviceAuthContract.complete, async ({ respond }) => {
    await approve.promise;
    context.mocks.data.personalModelProviders([account]);
    context.mocks.data.availableRunModels([
      mockSubscriptionRunModel("gpt-5.6-luna", { modelProviderId: account.id }),
    ]);
    context.mocks.ably.trigger("runModelsChanged");
    return respond(200, {
      status: "complete",
      provider: account,
      created: true,
    });
  });
  await setupPage({ context, path: "/" });
  await composerModelTrigger("GPT 5.6 Luna");
  await fill(screen.getByRole("textbox", { name: "Message" }), "Hello.");
  const send = await screen.findByLabelText("Send");
  expect(send).toBeDisabled();
  click(send);
  click(await findEnabledButton("Configure model"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  await within(dialog).findByText("ABCD-EFGH");
  expect(
    queryAllByRoleFast("link", dialog).find((link) => {
      return link.textContent === "Open approval page";
    }),
  ).toHaveAttribute("href", approvalUrl);
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(await findEnabledButton("Copy to clipboard", dialog));
  await waitFor(() => {
    return expect(clipboard.writes).toContain("ABCD-EFGH");
  });
  approve.resolve();
  await screen.findByText("ChatGPT connected");
  await findEnabledButton("Send");
  expect(queryButton("Configure model")).not.toBeInTheDocument();
});

test("chat-composer-model-recovery-003 starts device authorization for the active matching subscription", async () => {
  const inactive = {
    ...account,
    id: "14be7243-4a6b-49e4-8084-4055c0acdd78",
    accountEmail: "previous@example.test",
    isActive: false,
  };
  const active = {
    ...account,
    accountEmail: "current@example.test",
    needsReconnect: true,
  };
  createChatRunFixtures(context).installRunChat({
    selectedModel: "gpt-5.6-sol",
  });
  context.mocks.data.personalModelProviders([inactive, active]);
  context.mocks.data.availableRunModels([
    mockSubscriptionRunModel("gpt-5.6-sol", {
      modelProviderId: active.id,
      availability: "reconnect_required",
    }),
  ]);
  context.mocks.api(codexDeviceAuthContract.start, ({ body, respond }) => {
    return respond(
      200,
      deviceSession(
        body.mode === "reconnect" && body.modelProviderId === active.id
          ? "ACTIVE-PAIR"
          : "OTHER-PAIR",
      ),
    );
  });
  context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
  await setupPage({ context, path: "/" });
  await composerModelTrigger("GPT 5.6 Sol");
  click(await findEnabledButton("Configure model"));
  const dialog = await screen.findByRole("dialog", {
    name: "Re-connect Codex",
  });
  await within(dialog).findByText("ACTIVE-PAIR");
  expect(dialog).not.toHaveTextContent("previous@example.test");
});
