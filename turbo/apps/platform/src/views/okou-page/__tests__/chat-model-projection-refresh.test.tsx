import type {
  AvailableRunModel,
  ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
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
  findModelMenuOption,
  modelMenuOption,
} from "./chat-model-menu-test-helpers.ts";
import {
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
} from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";
const MODEL = "gpt-5.6-sol";

function runModelFixture(
  personal: boolean,
  restricted = false,
): AvailableRunModel {
  return {
    model: MODEL,
    modelLabel: "GPT 5.6 Sol",
    defaultProviderType: "codex-oauth-token",
    runtimeProviderType: "codex-oauth-token",
    credentialScope: "member",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    memberEffective: {
      providerType: "codex-oauth-token",
      runtimeProviderType: "codex-oauth-token",
      credentialScope: "member",
      availability: restricted ? "reconnect_required" : "available",
      accountSelection: "capture_required",
    },
    subscriptionOptions: {
      efforts: personal
        ? ["low", "high", "max"]
        : ["low", "medium", "high", "xhigh", "max"],
      serviceTier: "priority",
    },
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
      [FeatureSwitchKey.ComposerModelPanel]: false,
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  await expect(findButton("GPT 5.6 Sol")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "user:test-user-123",
        "runModelsChanged",
      ),
    ).toBeTruthy();
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "org:org_default",
        "runModelsChanged",
      ),
    ).toBeTruthy();
  });
}

async function personalOption(): Promise<HTMLElement> {
  return await waitFor(() => {
    const option = modelMenuOption(/GPT 5\.6 Sol/u);
    expect(within(option).getByText("ChatGPT (Codex)")).toBeInTheDocument();
    return option;
  });
}

function notice(scope: "user" | "org"): void {
  act(() => {
    context.mocks.ably.triggerOnChannel(
      scope === "user" ? "user:test-user-123" : "org:org_default",
      "runModelsChanged",
      null,
    );
  });
}

async function setupHeldProjectionRefresh() {
  let failRefresh = false;
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  installRunChat({ selectedModel: MODEL });
  context.mocks.api(
    runModelsMainContract.list,
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
        defaultModel: "okou-1.0",
        models: [runModelFixture(false)],
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
  click(screen.getByRole("switch", { name: "Fast mode" }));
  await expect(findButton("GPT 5.6 Sol Fast")).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  click(await findButton("GPT 5.6 Sol Fast"));
  await personalOption();

  failRefresh = true;
  notice("user");
  await started.promise;
  return { composer, release, user };
}

async function finishFailedProjectionRefresh(release: {
  readonly resolve: () => void;
}): Promise<void> {
  release.resolve();
  await expect(
    screen.findByText("Routing refresh unavailable"),
  ).resolves.toBeInTheDocument();
}

test("Keep provider choices through a held and failed projection refresh", async () => {
  const { release } = await setupHeldProjectionRefresh();
  await expect(personalOption()).resolves.toBeInTheDocument();
  await finishFailedProjectionRefresh(release);
  await expect(personalOption()).resolves.toBeInTheDocument();
});

test("Keep the draft through a held and failed projection refresh", async () => {
  const { composer, release } = await setupHeldProjectionRefresh();
  expect(composer).toHaveTextContent("Keep this unsent draft");
  await finishFailedProjectionRefresh(release);
  expect(composer).toHaveTextContent("Keep this unsent draft");
});

test("Keep effort through a held and failed projection refresh", async () => {
  const { release } = await setupHeldProjectionRefresh();
  await expect(findButton("Effort, Low")).resolves.toBeInTheDocument();
  await finishFailedProjectionRefresh(release);
  await expect(findButton("Effort, Low")).resolves.toBeInTheDocument();
});

test("Keep Fast through a failed projection refresh", async () => {
  const { release, user } = await setupHeldProjectionRefresh();
  await finishFailedProjectionRefresh(release);
  await expect(findButton("GPT 5.6 Sol Fast")).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  click(await findButton("Effort, Low"));
  await expect(
    screen.findByRole("switch", { name: "Fast mode" }),
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
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    return respond(200, {
      defaultModel: "okou-1.0",
      models: [runModelFixture(personal)],
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
  const initial = await findModelMenuOption(/GPT 5\.6 Sol/u);
  expect(within(initial).getByText("ChatGPT (Codex)")).toBeInTheDocument();
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
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Use more models" }),
    ).toBeInTheDocument();
  });
  const row = await screen.findByTestId(`oauth-account-${secondId}`);
  const activate = queryAllByRoleFast("button", row).find((button) => {
    return button.getAttribute("aria-label")?.startsWith("Use:");
  });
  expect(activate).toBeDefined();
  click(activate!);
  await waitFor(() => {
    expect(
      queryAllByRoleFast("button", row).find((button) => {
        return button.getAttribute("aria-label")?.startsWith("Active:");
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });
  click(within(settings).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
  click(await findButton("GPT 5.6 Sol"));
  await personalOption();
  await user.keyboard("{Escape}");
  const effortTrigger = queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label")?.startsWith("Effort,");
  });
  expect(effortTrigger).toBeDefined();
  click(effortTrigger!);
  const slider = await screen.findByRole("slider", { name: "Effort" });
  slider.focus();
  await user.keyboard("{Home}{ArrowRight}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "High");
  });
});
