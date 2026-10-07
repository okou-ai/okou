import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  findModelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockSubscriptionRunModel } from "../../../mocks/handlers/api-run-models.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import {
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
} from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const ACCOUNT_ID = "34240000-0000-4000-a000-000000000002";

function runModel(
  availability: AvailableRunModel["memberEffective"]["availability"],
): AvailableRunModel {
  return mockSubscriptionRunModel("gpt-5.6-sol", {
    modelLabel: "GPT 5.6 Sol",
    providerType: "codex-oauth-token",
    availability,
  });
}

test.each([
  { modelLabel: "GPT 5.6 Sol", source: "ChatGPT (Codex)" },
  { modelLabel: "Claude Sonnet 5", source: "Claude Code (OAuth Token)" },
])(
  "Shows $source in the model panel with personal subscription help",
  async ({ modelLabel, source }) => {
    const user = userEvent.setup({ delay: null });
    installRunChat({ selectedModel: "gpt-5.6-sol" });
    context.mocks.data.availableRunModels([
      runModel("available"),
      mockSubscriptionRunModel("claude-sonnet-5", {
        modelLabel: "Claude Sonnet 5",
        providerType: "claude-code-oauth-token",
      }),
    ]);
    await setupPage({
      context,
      path: NEW_CHAT_PATH,
    });
    await composerModelTrigger("GPT 5.6 Sol");
    const panel = await openModelPanel("GPT 5.6 Sol");

    const option = await findModelOption((name) => {
      return name.includes(modelLabel);
    }, panel);
    expect(option).not.toHaveAttribute("aria-disabled", "true");
    expect(option).not.toBeDisabled();
    expect(option).not.toHaveTextContent("$");
    expect(option).toHaveTextContent(source);
    const badge = within(option).getByText(source);
    await user.hover(badge);
    await expect(
      screen.findByText("Used only in your runs, with your own credentials."),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText(`${source}:`)).toBeInTheDocument();
  },
);

test("Uses the effective subscription for reasoning and Fast guidance", async () => {
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    codexServiceTier: "fast",
    modelSettings: { "gpt-5.6-sol": { effort: "max" } },
  });
  context.mocks.data.availableRunModels([runModel("available")]);
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });
  await screen.findByRole("textbox", { name: "Message" });
  const settings = await openModelPanel("GPT 5.6 Sol, Max, Fast");
  expect(
    within(settings).getByRole("slider", { name: "Effort" }),
  ).toHaveAttribute("aria-valuetext", "Max");
  expect(
    within(settings).getByRole("switch", { name: "Fast mode" }),
  ).toBeChecked();
  expect(within(settings).getByText("Lower usage")).toBeVisible();
  expect(within(settings).getByText("Higher usage")).toBeVisible();
  expect(
    within(settings).getByText("2.5× subscription usage"),
  ).toBeInTheDocument();
});

test("Reconnects the personal subscription used by the selected model", async () => {
  installRunChat({ selectedModel: "gpt-5.6-sol" });
  context.mocks.data.availableRunModels([runModel("reconnect_required")]);
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, {
      modelProviders: [
        {
          id: ACCOUNT_ID,
          type: "codex-oauth-token",
          framework: "codex",
          isActive: true,
          needsReconnect: true,
          lastRefreshErrorCode: "refresh_token_expired",
          createdAt: "2026-09-15T00:00:00.000Z",
          updatedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
    });
  });
  let requestedAccount: unknown;
  context.mocks.api(codexDeviceAuthContract.start, ({ body, respond }) => {
    requestedAccount = body;
    return respond(200, {
      sessionToken: "member-route-reconnect",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "C342-4000",
      expiresIn: 60,
      interval: 1,
    });
  });
  context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
  await setupPage({ context, path: NEW_CHAT_PATH });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, "Do not send until reconnected");
  await expect(findButton("Send")).resolves.toBeDisabled();
  click(await findButton("Configure model"));
  const dialog = await screen.findByRole("dialog", {
    name: "Re-connect Codex",
  });
  await expect(
    within(dialog).findByText("C342-4000"),
  ).resolves.toBeInTheDocument();
  expect(requestedAccount).toStrictEqual({
    scope: "personal",
    mode: "reconnect",
    modelProviderId: ACCOUNT_ID,
  });
  expect(composer).toHaveTextContent("Do not send until reconnected");
});

test("Refreshes the account target on explicit reconnect after a remote account switch", async () => {
  const secondAccountId = "34240000-0000-4000-a000-000000000003";
  let switched = false;
  let accountReads = 0;
  let requestedAccount: unknown;
  installRunChat({ selectedModel: "gpt-5.6-sol" });
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    const currentModel = runModel(
      switched ? "reconnect_required" : "available",
    );
    return respond(200, {
      defaultModel: "okou-1.0",
      models: [currentModel],
    });
  });
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    accountReads += 1;
    return respond(200, {
      modelProviders: [
        {
          id: switched ? secondAccountId : ACCOUNT_ID,
          type: "codex-oauth-token",
          framework: "codex",
          isActive: true,
          needsReconnect: switched,
          lastRefreshErrorCode: switched ? "refresh_token_expired" : null,
          createdAt: "2026-09-15T00:00:00.000Z",
          updatedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
    });
  });
  context.mocks.api(codexDeviceAuthContract.start, ({ body, respond }) => {
    requestedAccount = body;
    return respond(200, {
      sessionToken: "member-route-remote-reconnect",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "NEXT-3424",
      expiresIn: 60,
      interval: 1,
    });
  });
  context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, "Preserve this draft during reconnect");
  await waitFor(() => {
    expect(accountReads).toBeGreaterThan(0);
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "user:test-user-123",
        "runModelsChanged",
      ),
    ).toBeTruthy();
  });
  await expect(findButton("Send")).resolves.toBeEnabled();
  const initialAccountReads = accountReads;

  switched = true;
  act(() => {
    context.mocks.ably.triggerOnChannel(
      "user:test-user-123",
      "runModelsChanged",
      null,
    );
  });
  const configure = await findButton("Configure model");
  expect(accountReads).toBe(initialAccountReads);
  expect(requestedAccount).toBeUndefined();
  click(configure);
  const dialog = await screen.findByRole("dialog", {
    name: "Re-connect Codex",
  });
  await expect(
    within(dialog).findByText("NEXT-3424"),
  ).resolves.toBeInTheDocument();
  expect(requestedAccount).toStrictEqual({
    scope: "personal",
    mode: "reconnect",
    modelProviderId: secondAccountId,
  });
  expect(composer).toHaveTextContent("Preserve this draft during reconnect");
});
