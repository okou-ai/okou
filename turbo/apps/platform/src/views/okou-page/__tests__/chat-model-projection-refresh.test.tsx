import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import type {
  ModelProviderResponse,
  OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
} from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const POLICY_ID = "e7000000-0000-4000-a000-000000000001";
const MODEL = "gpt-5.6-sol";

function modelPolicy(personal: boolean, restricted = false): OrgModelPolicy {
  return {
    id: POLICY_ID,
    model: MODEL,
    modelLabel: "GPT 5.6 Sol",
    isDefault: true,
    defaultProviderType: "built-in",
    runtimeProviderType: "openai-api-key",
    credentialScope: "org",
    modelProviderId: null,
    modelProviderSurfaceId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    memberEffective: personal
      ? {
          providerType: "codex-oauth-token",
          runtimeProviderType: "codex-oauth-token",
          credentialScope: "member",
          availability: restricted ? "plan_restricted" : "available",
          accountSelection: "capture_required",
        }
      : {
          providerType: "built-in",
          runtimeProviderType: "openai-api-key",
          credentialScope: "org",
          availability: restricted ? "plan_restricted" : "available",
          accountSelection: "not_applicable",
        },
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
}

async function openChat(
  transport: "direct" | "message-port" = "direct",
): Promise<void> {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 640px)";
  });
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    sharedWorkerTestTransport: transport,
    featureSwitches: {
      [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
      [FeatureSwitchKey.RefactorModelSelect]: true,
      [FeatureSwitchKey.ModelPickerFlyout]: true,
      [FeatureSwitchKey.CodexFastMode]: true,
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  await expect(findButton("GPT 5.6 Sol")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "user:test-user-123",
        "modelPoliciesChanged",
      ),
    ).toBeTruthy();
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "org:org_default",
        "modelPoliciesChanged",
      ),
    ).toBeTruthy();
  });
}

async function personalOption(): Promise<HTMLElement> {
  return await waitFor(() => {
    const option = screen.getByRole("option", { name: /GPT 5\.6 Sol/u });
    expect(within(option).getByText("ChatGPT (Codex)")).toBeInTheDocument();
    return option;
  });
}

function notice(scope: "user" | "org"): void {
  act(() => {
    context.mocks.ably.triggerOnChannel(
      scope === "user" ? "user:test-user-123" : "org:org_default",
      "modelPoliciesChanged",
      null,
    );
  });
}

test("Refresh member source after personal, organization, billing and reconnect notices", async () => {
  let personal = false;
  let restricted = false;
  installRunChat({ selectedModel: MODEL });
  context.mocks.api(modelPoliciesMainContract.list, ({ respond }) => {
    return respond(200, {
      policies: [modelPolicy(personal, restricted)],
      workspaceDefaultModel: MODEL,
      workspaceDefaultPolicyId: POLICY_ID,
    });
  });
  // Continuity callbacks belong to the real MessagePort protocol; the direct
  // page transport intentionally forwards named events only.
  await openChat("message-port");
  click(await findButton("GPT 5.6 Sol"));
  const initial = await screen.findByRole("option", { name: /GPT 5\.6 Sol/u });
  expect(
    within(initial).queryByText("ChatGPT (Codex)"),
  ).not.toBeInTheDocument();

  personal = true;
  notice("user");
  await personalOption();

  personal = false;
  notice("org");
  await waitFor(() => {
    const option = screen.getByRole("option", { name: /GPT 5\.6 Sol/u });
    expect(
      within(option).queryByText("ChatGPT (Codex)"),
    ).not.toBeInTheDocument();
  });

  personal = true;
  act(() => {
    context.mocks.ably.triggerSharedWorkerConnectionState("suspended", {
      code: 80_003,
      message: "Network unavailable",
    });
    context.mocks.ably.triggerSharedWorkerConnectionState("connected");
  });
  await personalOption();

  restricted = true;
  act(() => {
    context.mocks.ably.trigger("billing:changed");
  });
  await waitFor(() => {
    const option = screen.getByRole("option", { name: /GPT 5\.6 Sol/u });
    expect(within(option).getByText("ChatGPT (Codex)")).toBeInTheDocument();
    expect(within(option).getByText("Pro")).toBeInTheDocument();
  });

  restricted = false;
  act(() => {
    context.mocks.ably.trigger("billing:changed");
  });
  await waitFor(() => {
    const option = screen.getByRole("option", { name: /GPT 5\.6 Sol/u });
    expect(within(option).queryByText("Pro")).not.toBeInTheDocument();
  });
});

test("Keep choices, draft, effort and Fast through a held and failed projection refresh", async () => {
  let failRefresh = false;
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  installRunChat({ selectedModel: MODEL });
  context.mocks.api(
    modelPoliciesMainContract.list,
    async ({ respond, withSignal }) => {
      if (failRefresh) {
        started.resolve();
        await withSignal(release.promise);
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Routing refresh unavailable",
          },
        });
      }
      return respond(200, {
        policies: [modelPolicy(true)],
        workspaceDefaultModel: MODEL,
        workspaceDefaultPolicyId: POLICY_ID,
      });
    },
  );
  await openChat();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, "Keep this unsent draft");
  click(await findButton("Effort, Max"));
  const slider = await screen.findByRole("slider", { name: "Effort" });
  slider.focus();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Home}");
  await expect(findButton("Effort, Low")).resolves.toBeInTheDocument();
  click(screen.getByRole("switch", { name: "Fast" }));
  await expect(findButton("GPT 5.6 Sol Fast")).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  click(await findButton("GPT 5.6 Sol Fast"));
  await personalOption();

  failRefresh = true;
  notice("user");
  await started.promise;
  await personalOption();
  expect(composer).toHaveTextContent("Keep this unsent draft");
  await expect(findButton("Effort, Low")).resolves.toBeInTheDocument();

  release.resolve();
  await expect(
    screen.findByText("Routing refresh unavailable"),
  ).resolves.toBeInTheDocument();
  await personalOption();
  expect(composer).toHaveTextContent("Keep this unsent draft");
  await expect(findButton("Effort, Low")).resolves.toBeInTheDocument();
  await expect(findButton("GPT 5.6 Sol Fast")).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  click(await findButton("Effort, Low"));
  await expect(
    screen.findByRole("switch", { name: "Fast" }),
  ).resolves.toBeChecked();
});

test("A local active-account change refreshes the member projection", async () => {
  let personal = false;
  installRunChat({ selectedModel: MODEL });
  const account = (id: string, active: boolean): ModelProviderResponse => {
    return {
      id,
      modelProviderId: "e7000000-0000-4000-a000-000000000002",
      type: "codex-oauth-token",
      framework: "codex",
      isActive: active,
      isDefault: false,
      selectedModel: null,
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
      accountEmail: `${id.endsWith("3") ? "first" : "second"}@example.com`,
      needsReconnect: false,
      lastRefreshErrorCode: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    };
  };
  const firstId = "e7000000-0000-4000-a000-000000000003";
  const secondId = "e7000000-0000-4000-a000-000000000004";
  context.mocks.api(modelPoliciesMainContract.list, ({ respond }) => {
    return respond(200, {
      policies: [modelPolicy(personal)],
      workspaceDefaultModel: MODEL,
      workspaceDefaultPolicyId: POLICY_ID,
    });
  });
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, {
      modelProviders: [
        account(firstId, !personal),
        account(secondId, personal),
      ],
    });
  });
  context.mocks.api(
    personalModelProviderAccountsByIdContract.activate,
    ({ params, respond }) => {
      expect(params.id).toBe(secondId);
      personal = true;
      return respond(200, account(secondId, true));
    },
  );
  await openChat();
  click(await findButton("GPT 5.6 Sol"));
  const initial = await screen.findByRole("option", { name: /GPT 5\.6 Sol/u });
  expect(
    within(initial).queryByText("ChatGPT (Codex)"),
  ).not.toBeInTheDocument();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Escape}");
  const rail = screen.queryByTestId("labeled-nav-rail");
  const trigger = rail
    ? within(rail).getByLabelText("Test User")
    : (await screen.findByText("Test User")).closest("button");
  expect(trigger).not.toBeNull();
  click(trigger!);
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(await findButton("Models"));
  await expect(
    screen.findByRole("heading", { name: "Models" }),
  ).resolves.toBeInTheDocument();
  const row = await screen.findByTestId(`oauth-account-${secondId}`);
  const activate = queryAllByRoleFast("radio", row).find((radio) => {
    return radio.getAttribute("aria-label") === "Use";
  });
  expect(activate).toBeDefined();
  click(activate!);
  await waitFor(() => {
    expect(
      queryAllByRoleFast("radio", row).find((radio) => {
        return radio.getAttribute("aria-label") === "Active";
      }),
    ).toHaveAttribute("aria-checked", "true");
  });
  click(within(settings).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
  click(await findButton("GPT 5.6 Sol"));
  await personalOption();
});
