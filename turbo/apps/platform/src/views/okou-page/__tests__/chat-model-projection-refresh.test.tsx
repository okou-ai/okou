import type {
  AvailableRunModel,
  ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import {
  closeModelPanel,
  findModelOption,
  modelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
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
  });
  await expect(
    composerModelTrigger("GPT 5.6 Sol"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "user:test-user-123",
        "runModelsChanged",
      ),
    ).toBeTruthy();
  });
}

async function personalOption(): Promise<HTMLElement> {
  return await waitFor(() => {
    const option = modelOption(/GPT 5\.6 Sol/u);
    expect(within(option).getByText("ChatGPT (Codex)")).toBeInTheDocument();
    return option;
  });
}

function notice(): void {
  act(() => {
    context.mocks.ably.triggerOnChannel(
      "user:test-user-123",
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
  const panel = await openModelPanel("GPT 5.6 Sol, Max");
  const slider = within(panel).getByRole("slider", { name: "Effort" });
  slider.focus();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Home}");
  await expect(findButton("GPT 5.6 Sol, Low")).resolves.toBeInTheDocument();
  click(within(panel).getByRole("switch", { name: "Fast mode" }));
  await expect(
    findButton("GPT 5.6 Sol, Low, Fast"),
  ).resolves.toBeInTheDocument();
  await personalOption();

  failRefresh = true;
  notice();
  await started.promise;
  return { composer, release };
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
  await expect(
    composerModelTrigger("GPT 5.6 Sol, Low"),
  ).resolves.toBeInTheDocument();
  await finishFailedProjectionRefresh(release);
  await expect(
    composerModelTrigger("GPT 5.6 Sol, Low"),
  ).resolves.toBeInTheDocument();
});

test("Keep Fast through a failed projection refresh", async () => {
  const { release } = await setupHeldProjectionRefresh();
  await finishFailedProjectionRefresh(release);
  await expect(
    findButton("GPT 5.6 Sol, Low, Fast"),
  ).resolves.toBeInTheDocument();
  await closeModelPanel();
  const panel = await openModelPanel("GPT 5.6 Sol, Low, Fast");
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toBeChecked();
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
  const initialPanel = await openModelPanel("GPT 5.6 Sol");
  const initial = await findModelOption(/GPT 5\.6 Sol/u, initialPanel);
  expect(within(initial).getByText("ChatGPT (Codex)")).toBeInTheDocument();
  await closeModelPanel();
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
  const panel = await openModelPanel("GPT 5.6 Sol");
  await personalOption();
  const slider = within(panel).getByRole("slider", { name: "Effort" });
  slider.focus();
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Home}{ArrowRight}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "High");
  });
});
