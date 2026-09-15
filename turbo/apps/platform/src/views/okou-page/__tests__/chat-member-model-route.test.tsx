import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { fillComposer } from "./chat-test-helpers.ts";
import {
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
} from "./chat-run-test-fixtures.ts";

const ACCOUNT_ID = "34240000-0000-4000-a000-000000000002";

function policy(
  availability: NonNullable<OrgModelPolicy["memberEffective"]>["availability"],
): OrgModelPolicy {
  return {
    id: "34240000-0000-4000-a000-000000000001",
    model: "gpt-5.6-sol",
    modelLabel: "GPT 5.6 Sol",
    isDefault: true,
    defaultProviderType: "built-in",
    runtimeProviderType: "openai-api-key",
    credentialScope: "org",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    memberEffective: {
      providerType: "codex-oauth-token",
      runtimeProviderType: "codex-oauth-token",
      credentialScope: "member",
      availability,
      accountSelection: "capture_required",
    },
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
}

test.each(["select", "compact", "flyout"] as const)(
  "Shows the personal candidate in the %s picker without organization credit prices",
  async (layout) => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia((query) => {
      return query === "(min-width: 640px)" && layout !== "compact";
    });
    installRunChat({ selectedModel: "gpt-5.6-sol" });
    context.mocks.data.orgModelPolicies([
      {
        ...policy("available"),
        defaultProviderType: "openai-api-key",
        routeStatus: "missing_provider",
        routeStatusReason: "The selected workspace provider is missing.",
      },
    ]);
    await setupPage({
      context,
      path: NEW_CHAT_PATH,
      featureSwitches: {
        [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
        [FeatureSwitchKey.RefactorModelSelect]: layout === "compact",
        [FeatureSwitchKey.ModelPickerFlyout]: layout !== "select",
      },
    });
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await fillComposer(composer, "Keep this draft");

    if (layout === "select") {
      click(await screen.findByRole("combobox", { name: "GPT 5.6 Sol" }));
    } else {
      // The initial legacy Select has the same name while feature switches
      // load. Wait for the requested menu's accessible trigger before opening.
      const trigger = await waitFor(() => {
        const button = queryButton("GPT 5.6 Sol");
        if (button?.getAttribute("aria-haspopup") !== "dialog") {
          throw new Error("The model menu trigger is not ready");
        }
        return button;
      });
      click(trigger);
      if (layout === "compact") {
        const overview = await screen.findByRole("region", { name: "Models" });
        const changeModel = queryButton(
          "Change Chat model, GPT 5.6 Sol",
          overview,
        );
        if (!changeModel) {
          throw new Error("The Models menu has no Chat model navigation");
        }
        click(changeModel);
      }
    }

    await expect(
      screen.findByText("ChatGPT (Codex)"),
    ).resolves.toBeInTheDocument();
    const option =
      layout === "compact"
        ? queryButton(
            "GPT 5.6 Sol",
            await screen.findByRole("region", { name: "Chat models" }),
          )
        : screen.getByRole("option", { name: /GPT 5.6 Sol/u });
    expect(option).toBeInTheDocument();
    expect(option).not.toHaveAttribute("aria-disabled", "true");
    expect(option).not.toBeDisabled();
    expect(option).not.toHaveTextContent("$");
    await user.keyboard("{Escape}");
    expect(composer).toHaveTextContent("Keep this draft");
    await expect(findButton("Send")).resolves.toBeEnabled();
  },
);

test("Uses the effective subscription for reasoning and Fast guidance", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    codexServiceTier: "fast",
    modelSettings: { "gpt-5.6-sol": { effort: "max" } },
  });
  context.mocks.data.orgModelPolicies([policy("available")]);
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
      [FeatureSwitchKey.RefactorModelSelect]: true,
      [FeatureSwitchKey.PiLoop]: true,
    },
  });
  await screen.findByRole("textbox", { name: "Message" });
  click(await findButton("Effort, Max"));
  const settings = await screen.findByRole("dialog");
  expect(
    within(settings).getByRole("slider", { name: "Effort" }),
  ).toHaveAttribute("aria-valuetext", "Max");
  expect(within(settings).getByRole("switch", { name: "Fast" })).toBeChecked();
  await user.hover(within(settings).getByText("Fast"));
  await expect(
    screen.findByText("1.5× model speed · 2.5× ChatGPT usage"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(/2× Okou model credits/u)).not.toBeInTheDocument();
});

test("Reconnects the current personal candidate despite an organization API route", async () => {
  installRunChat({ selectedModel: "gpt-5.6-sol" });
  context.mocks.data.orgModelPolicies([policy("reconnect_required")]);
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, {
      modelProviders: [
        {
          id: ACCOUNT_ID,
          type: "codex-oauth-token",
          framework: "codex",
          secretName: null,
          authMethod: "auth_json",
          secretNames: ["CODEX_AUTH_JSON"],
          isDefault: false,
          selectedModel: null,
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

test("Keeps an unconverted missing subscription on Connect instead of Built-in", async () => {
  installRunChat({ selectedModel: "gpt-5.6-sol" });
  context.mocks.data.orgModelPolicies([
    {
      ...policy("unavailable"),
      defaultProviderType: "codex-oauth-token",
      runtimeProviderType: "codex-oauth-token",
      credentialScope: "member",
    },
  ]);
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, { modelProviders: [] });
  });
  context.mocks.api(codexDeviceAuthContract.start, ({ body, respond }) => {
    expect(body).toStrictEqual({ scope: "personal", mode: "add" });
    return respond(200, {
      sessionToken: "member-route-connect",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "CONN-3424",
      expiresIn: 60,
      interval: 1,
    });
  });
  context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
  await setupPage({ context, path: NEW_CHAT_PATH });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, "Keep the subscription route");
  await expect(findButton("Send")).resolves.toBeDisabled();
  click(await findButton("Configure model"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  await expect(
    within(dialog).findByText("CONN-3424"),
  ).resolves.toBeInTheDocument();
});

test("Refreshes the account target on explicit reconnect after a remote account switch", async () => {
  const secondAccountId = "34240000-0000-4000-a000-000000000003";
  let switched = false;
  let accountReads = 0;
  let requestedAccount: unknown;
  installRunChat({ selectedModel: "gpt-5.6-sol" });
  context.mocks.api(modelPoliciesMainContract.list, ({ respond }) => {
    const currentPolicy = policy(switched ? "reconnect_required" : "available");
    return respond(200, {
      policies: [
        {
          ...currentPolicy,
          defaultProviderType: "codex-oauth-token",
          runtimeProviderType: "codex-oauth-token",
          credentialScope: "member",
          // The initial old API response makes the current account read lazy.
          memberEffective: switched ? currentPolicy.memberEffective : undefined,
        },
      ],
      workspaceDefaultModel: "gpt-5.6-sol",
      workspaceDefaultPolicyId: currentPolicy.id,
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
          secretName: null,
          authMethod: "auth_json",
          secretNames: ["CODEX_AUTH_JSON"],
          isDefault: false,
          selectedModel: null,
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
    featureSwitches: {
      [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    },
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, "Preserve this draft during reconnect");
  await waitFor(() => {
    expect(accountReads).toBeGreaterThan(0);
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "user:test-user-123",
        "modelPoliciesChanged",
      ),
    ).toBeTruthy();
  });
  await expect(findButton("Send")).resolves.toBeEnabled();
  const initialAccountReads = accountReads;

  switched = true;
  act(() => {
    context.mocks.ably.triggerOnChannel(
      "user:test-user-123",
      "modelPoliciesChanged",
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
