import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import {
  billingCheckoutContract,
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import type {
  ModelProviderResponse,
  OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  modelProviderConnectionsByIdContract,
  modelProviderConnectionsMainContract,
  type CreateModelProviderConnectionRequest,
  type ModelProviderConnectionResponse,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function radioByName(
  name: string | RegExp,
  container: ParentNode = document.body,
): HTMLElement {
  const radio = queryAllByRoleFast("radio", container).find((candidate) => {
    const accessibleName =
      candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof name === "string"
      ? accessibleName.trim() === name
      : name.test(accessibleName);
  });
  if (!radio) {
    throw new Error(`Radio not found: ${String(name)}`);
  }
  return radio;
}

function staleCodexProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000201",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    selectedModel: null,
    workspaceName: "Acme ChatGPT",
    planType: "pro",
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function staleClaudeCodeProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000203",
    type: "claude-code-oauth-token",
    framework: "claude-code",
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function anthropicApiKeyProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000202",
    type: "anthropic-api-key",
    framework: "claude-code",
    secretName: "ANTHROPIC_API_KEY",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function builtInPolicy(
  id: string,
  model: OrgModelPolicy["model"],
  modelLabel: string,
  isDefault: boolean,
): OrgModelPolicy {
  return {
    id,
    model,
    modelLabel,
    isDefault,
    defaultProviderType: "built-in",
    credentialScope: "org",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  };
}

function claudeOpusApiKeyPolicy(): OrgModelPolicy {
  return {
    id: "00000000-0000-4000-a000-000000000212",
    model: "claude-opus-4-8",
    modelLabel: "Claude Opus 4.8",
    isDefault: false,
    defaultProviderType: "anthropic-api-key",
    credentialScope: "org",
    modelProviderId: anthropicApiKeyProvider().id,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  };
}

function missingOpenAiPolicy(): OrgModelPolicy {
  return {
    id: "00000000-0000-4000-a000-000000000213",
    model: "gpt-5.5",
    modelLabel: "GPT 5.5",
    isDefault: false,
    defaultProviderType: "openai-api-key",
    credentialScope: "org",
    modelProviderId: "00000000-0000-4000-a000-000000009999",
    routeStatus: "missing_provider",
    routeStatusReason: "Workspace OpenAI API key was removed",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  };
}

function mockStaleProviderStory(): void {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([staleCodexProvider()]);
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "mock-codex-device-session",
      type: "codex",
      status: "pending",
      scope: "org",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "WXYZ-1234",
      expiresIn: 30,
      interval: 1,
    });
  });
  context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
}

function mockApiKeyModelRouteStory(): void {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([anthropicApiKeyProvider()]);
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000211",
      "deepseek-v4-flash",
      "DeepSeek V4 Flash",
      true,
    ),
    claudeOpusApiKeyPolicy(),
  ]);
}

function mockAdminOrg(): void {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
}

function billingStatus(
  tier: string,
  modelCapabilities?: {
    readonly supportByok?: boolean;
    readonly restrictedBuiltInModels?: boolean;
    readonly restrictedVm0Models?: boolean;
  },
): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier,
    ...modelCapabilities,
    credits: 20_000,
    onboardingPaymentPending: false,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: {
      expiringNextCycle: 0,
      nextExpiryDate: null,
    },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

function mockBillingCapabilities(modelCapabilities: {
  readonly supportByok: boolean;
  readonly restrictedBuiltInModels: boolean;
}): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus("pro", modelCapabilities));
  });
}

/** Billing status as an API from before #33658 step 1 returns it. */
function mockLegacyBillingCapabilities(modelCapabilities: {
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
}): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus("pro", modelCapabilities));
  });
}

type GatewayConnectionInput = Pick<
  CreateModelProviderConnectionRequest,
  "displayName" | "surfaces"
>;

function gatewayConnectionResponse(
  input: GatewayConnectionInput,
): ModelProviderConnectionResponse {
  const now = "2026-07-30T00:00:00.000Z";
  return {
    id: "00000000-0000-4000-a000-000000000300",
    displayName: input.displayName,
    surfaces: input.surfaces.map((surface) => {
      return {
        ...surface,
        id:
          surface.protocol === "anthropic-messages"
            ? "00000000-0000-4000-a000-000000000301"
            : "00000000-0000-4000-a000-000000000302",
        createdAt: now,
        updatedAt: now,
      };
    }),
    createdAt: now,
    updatedAt: now,
  };
}

function mockGatewayConnectionLifecycle(
  initialConnections: ModelProviderConnectionResponse[] = [],
) {
  let connections = initialConnections;
  let updateSecret: string | undefined;

  context.mocks.api(
    modelProviderConnectionsMainContract.list,
    ({ respond }) => {
      return respond(200, { connections });
    },
  );
  context.mocks.api(
    modelProviderConnectionsMainContract.create,
    ({ body, respond }) => {
      const connection = gatewayConnectionResponse(body);
      connections = [connection];
      return respond(201, connection);
    },
  );
  context.mocks.api(
    modelProviderConnectionsByIdContract.update,
    ({ body, respond }) => {
      updateSecret = body.secret;
      const connection = gatewayConnectionResponse(body);
      connections = [connection];
      return respond(200, connection);
    },
  );
  context.mocks.api(
    modelProviderConnectionsByIdContract.delete,
    ({ respond }) => {
      connections = [];
      return respond(204);
    },
  );

  return {
    updateSecret: () => {
      return updateSecret;
    },
  };
}

async function openExistingGateway(displayName: string, routed = false) {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000211",
      "gpt-5.6-luna",
      "GPT 5.6 Luna",
      true,
    ),
    ...(routed
      ? [
          {
            ...builtInPolicy(
              "00000000-0000-4000-a000-000000000212",
              "claude-sonnet-5",
              "Claude Sonnet 5",
              false,
            ),
            defaultProviderType: "custom-anthropic-messages" as const,
            modelProviderSurfaceId: "00000000-0000-4000-a000-000000000301",
          },
        ]
      : []),
  ]);
  const lifecycle = mockGatewayConnectionLifecycle([
    gatewayConnectionResponse({
      displayName,
      surfaces: [
        {
          protocol: "anthropic-messages",
          apiBaseUrl: "https://ai-gateway.vercel.sh",
          authHeaderName: "Authorization",
          authHeaderTemplate: "Bearer {{secret}}",
          modelMappings: { "claude-sonnet-5": "anthropic/claude-sonnet-5" },
        },
      ],
    }),
  ]);
  await openProvidersTab();
  const heading = await screen.findByRole("heading", {
    name: "Provider connections",
  });
  const section = heading.closest("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error("Provider connections section not found");
  }
  await expect(within(section).findByText(displayName)).resolves.toBeVisible();
  return { lifecycle, connectionsSection: section };
}

async function openProvidersTab(): Promise<void> {
  await setupPage({
    context,
    path: "/agents?settings=model",
  });
  await waitFor(() => {
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Models" })).toBeInTheDocument();
  });
}

async function openModelSettings(): Promise<void> {
  await setupPage({
    context,
    path: "/agents?settings=model",
  });
  await waitFor(() => {
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Models" })).toBeInTheDocument();
  });
}

async function openSettingsFromAccountMenu(): Promise<HTMLElement> {
  const accountButton = await waitFor(() => {
    return buttonByLabel("Test User");
  });
  click(accountButton);
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  return screen.findByRole("dialog", { name: "Settings" });
}

async function openAddApiKeyModelDialog(): Promise<void> {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  await openProvidersTab();

  click(screen.getByText("Add model"));
  await selectDialogModel("Claude Opus 4.8");
  click(radioByName(/API key/u));
  await waitFor(() => {
    expect(
      screen.getByPlaceholderText("Enter your API key"),
    ).toBeInTheDocument();
  });
}

async function selectDialogModel(modelName: string): Promise<void> {
  const dialog = screen.getByRole("dialog", { name: /Add model|Edit model/u });
  click(within(dialog).getByRole("combobox"));
  click(await screen.findByRole("option", { name: modelName }));
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((element) => {
    return element.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return element.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function menuItemByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((element) => {
    return element.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

function dialogContaining(element: HTMLElement): HTMLElement {
  const dialog = element.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Containing dialog not found");
  }
  return dialog;
}

test("Hide workspace provider connections from non-admin members", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([]);

  await openProvidersTab();

  expect(
    screen.queryByRole("heading", { name: "Provider connections" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Add provider")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Gateway actions")).not.toBeInTheDocument();
});

test("Show the default model and available routes before provider connections", async () => {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  const gateway = gatewayConnectionResponse({
    displayName: "Acme Gateway",
    surfaces: [
      {
        protocol: "anthropic-messages",
        apiBaseUrl: "https://gateway.example.com",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer {{secret}}",
        modelMappings: {
          "claude-opus-4-8": "anthropic/claude-opus-4.8",
        },
      },
    ],
  });
  context.mocks.api(
    modelProviderConnectionsMainContract.list,
    ({ respond }) => {
      return respond(200, { connections: [gateway] });
    },
  );
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000211",
      "gpt-5.6-luna",
      "GPT 5.6 Luna",
      true,
    ),
    {
      id: "00000000-0000-4000-a000-000000000212",
      model: "claude-opus-4-8",
      modelLabel: "Claude Opus 4.8",
      isDefault: false,
      defaultProviderType: "custom-anthropic-messages",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: gateway.surfaces[0]?.id,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    },
  ]);

  await openProvidersTab();

  const defaultModel = screen.getByTestId("default-model-row");
  const availableModels = screen.getByRole("heading", {
    name: "Available models",
  });
  const providerConnections = screen.getByRole("heading", {
    name: "Provider connections",
  });
  const claudeRow = screen.getByTestId("org-model-policy-row-claude-opus-4-8");

  expect(within(defaultModel).getByRole("combobox")).toHaveTextContent(
    "GPT 5.6 Luna",
  );
  expect(within(claudeRow).getByText("Acme Gateway")).toBeInTheDocument();
  expect(
    defaultModel.compareDocumentPosition(availableModels) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    claudeRow.compareDocumentPosition(providerConnections) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(screen.getByText("Runs through")).toBeInTheDocument();
  expect(screen.getByText("Pricing")).toBeInTheDocument();
});

test("Discard sensitive provider-connection drafts when Settings closes", async () => {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([]);
  mockGatewayConnectionLifecycle();

  await openProvidersTab();

  const connectionsHeading = await screen.findByRole("heading", {
    name: "Provider connections",
  });
  const connectionsSection = connectionsHeading.closest("section");
  if (!(connectionsSection instanceof HTMLElement)) {
    throw new Error("Provider connections section not found");
  }
  const settingsDialog = screen.getByRole("dialog", { name: "Settings" });

  click(within(connectionsSection).getByText("Add provider"));
  click(menuItemByText("Custom"));
  const addDialog = await screen.findByRole("dialog", {
    name: "Add model provider",
  });
  await fill(within(addDialog).getByLabelText("Name"), "Draft Gateway");
  await fill(
    within(addDialog).getByLabelText("API base URL"),
    "https://draft.example.com",
  );
  await fill(
    within(addDialog).getByLabelText("API key"),
    "vck-sensitive-draft",
  );

  click(within(settingsDialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Add model provider" }),
    ).not.toBeInTheDocument();
  });

  const reopenedSettingsDialog = await openSettingsFromAccountMenu();
  click(buttonByText("Models", reopenedSettingsDialog));
  await expect(
    screen.findByRole("heading", { name: "Models" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Add model provider" }),
  ).not.toBeInTheDocument();

  const reopenedConnectionsHeading = await screen.findByRole("heading", {
    name: "Provider connections",
  });
  const reopenedConnectionsSection =
    reopenedConnectionsHeading.closest("section");
  if (!(reopenedConnectionsSection instanceof HTMLElement)) {
    throw new Error("Provider connections section not found");
  }
  click(within(reopenedConnectionsSection).getByText("Add provider"));
  click(menuItemByText("Custom"));

  const reopenedAddDialog = await screen.findByRole("dialog", {
    name: "Add model provider",
  });
  expect(within(reopenedAddDialog).getByLabelText("Name")).toHaveValue("");
  expect(within(reopenedAddDialog).getByLabelText("API base URL")).toHaveValue(
    "",
  );
  expect(within(reopenedAddDialog).getByLabelText("API key")).toHaveValue("");
});

async function openAddGatewayDialog() {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000211",
      "gpt-5.6-luna",
      "GPT 5.6 Luna",
      true,
    ),
  ]);
  mockGatewayConnectionLifecycle();

  await openProvidersTab();

  const connectionsHeading = await screen.findByRole("heading", {
    name: "Provider connections",
  });
  const connectionsSection = connectionsHeading.closest("section");
  if (!(connectionsSection instanceof HTMLElement)) {
    throw new Error("Provider connections section not found");
  }

  click(within(connectionsSection).getByText("Add provider"));
  click(menuItemByText("Vercel AI Gateway"));
  const addDialog = await screen.findByRole("dialog", {
    name: "Add model provider",
  });
  return { addDialog, connectionsSection };
}

test("The workspace gateway form describes both supported request surfaces", async () => {
  const { addDialog } = await openAddGatewayDialog();
  expect(
    within(addDialog).getByText(
      "Requests: https://ai-gateway.vercel.sh/v1/messages",
    ),
  ).toBeInTheDocument();
  expect(
    within(addDialog).getByText(
      "Requests: https://ai-gateway.vercel.sh/v1/responses",
    ),
  ).toBeInTheDocument();
});

test("Add a workspace gateway without exposing its private key", async () => {
  const { addDialog, connectionsSection } = await openAddGatewayDialog();
  await fill(within(addDialog).getByLabelText("API key"), "vck-test");
  click(buttonByText("Save changes", addDialog));

  await expect(
    within(connectionsSection).findByText("Vercel AI Gateway"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("vck-test")).not.toBeInTheDocument();
});

test("Rename a workspace gateway and rotate its private API key", async () => {
  const { lifecycle, connectionsSection } =
    await openExistingGateway("Vercel AI Gateway");
  click(within(connectionsSection).getByLabelText("Gateway actions"));
  click(menuItemByText("Edit"));
  const editDialog = await screen.findByRole("dialog", {
    name: "Edit model provider",
  });
  expect(
    within(editDialog).getByPlaceholderText(
      "Leave blank to keep the current key",
    ),
  ).toHaveValue("");
  await fill(within(editDialog).getByLabelText("Name"), "Vercel Edge Gateway");
  await fill(
    within(editDialog).getByPlaceholderText(
      "Leave blank to keep the current key",
    ),
    "vck-replacement",
  );
  click(buttonByText("Save changes", editDialog));

  await expect(
    within(connectionsSection).findByText("Vercel Edge Gateway"),
  ).resolves.toBeInTheDocument();
  expect(lifecycle.updateSecret()).toBe("vck-replacement");
  expect(
    screen.getByTestId("org-model-policy-row-gpt-5.6-luna"),
  ).toBeInTheDocument();
});

test("Route a workspace model through an existing custom gateway", async () => {
  await openExistingGateway("Vercel Edge Gateway");
  click(buttonByText("Add model"));
  await selectDialogModel("Claude Sonnet 5");
  const policyDialog = screen.getByRole("dialog", { name: "Add model" });
  click(radioByName(/Custom gateway/u, policyDialog));
  expect(
    within(policyDialog).getByText("Vercel Edge Gateway"),
  ).toBeInTheDocument();
  click(buttonByText("Add model", policyDialog));

  const policyRow = await screen.findByTestId(
    "org-model-policy-row-claude-sonnet-5",
  );
  await waitFor(() => {
    expect(
      within(policyRow).getByText("Vercel Edge Gateway"),
    ).toBeInTheDocument();
  });
});

test("Deleting a gateway removes it from an already routed workspace model", async () => {
  const { connectionsSection } = await openExistingGateway(
    "Vercel Edge Gateway",
    true,
  );
  const policyRow = await screen.findByTestId(
    "org-model-policy-row-claude-sonnet-5",
  );
  await within(policyRow).findByText("Vercel Edge Gateway");
  click(within(connectionsSection).getByLabelText("Gateway actions"));
  click(menuItemByText("Delete"));
  const deleteDialog = await screen.findByRole("dialog", {
    name: "Delete Vercel Edge Gateway?",
  });
  click(buttonByText("Delete", deleteDialog));

  await waitFor(() => {
    expect(
      within(connectionsSection).queryByText("Vercel Edge Gateway"),
    ).not.toBeInTheDocument();
    expect(
      within(connectionsSection).getByText(
        "No custom model providers configured.",
      ),
    ).toBeInTheDocument();
    expect(within(policyRow).queryByText("Vercel Edge Gateway")).toBeNull();
  });
});

test.each([
  { model: "GPT 5.6 Sol", active: true },
  { model: "GPT 5.5", active: true },
  { model: "Claude Sonnet 4.6", active: true },
  { model: "Claude Opus 4.8", active: true },
  { model: "DeepSeek V4 Flash", active: true },
  { model: "DeepSeek V4 Pro", active: true },
  { model: "Kimi K2.7 Code", active: false },
  { model: "Claude Opus 4.7", active: false },
])(
  "Offer $model only when active while adding a workspace route",
  async ({ model, active }) => {
    mockAdminOrg();
    context.mocks.data.orgModelProviders([]);
    context.mocks.data.orgModelPolicies([]);
    await openProvidersTab();

    click(buttonByText("Add model"));
    const dialog = screen.getByRole("dialog", { name: "Add model" });
    click(within(dialog).getByRole("combobox"));

    await screen.findByRole("option", { name: "GPT 5.6 Sol" });
    expect(screen.queryAllByRole("option", { name: model })).toHaveLength(
      active ? 1 : 0,
    );
  },
);

test("Limit free workspaces to eligible built-in models", async () => {
  mockAdminOrg();
  mockBillingCapabilities({
    supportByok: false,
    restrictedBuiltInModels: true,
  });
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000222",
      "gpt-5.6-luna",
      "GPT 5.6 Luna",
      true,
    ),
  ]);
  await openProvidersTab();

  click(buttonByText("Add model"));
  const dialog = screen.getByRole("dialog", { name: "Add model" });
  click(within(dialog).getByRole("combobox"));
  const deepSeekProOption = await screen.findByRole("option", {
    name: "DeepSeek V4 Pro",
  });
  expect(
    screen.getByRole("option", { name: "DeepSeek V4 Flash" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "GPT 6 Astra" }),
  ).not.toBeInTheDocument();
  click(deepSeekProOption);

  expect(within(dialog).queryByText("Upgrade to Pro")).toBeNull();
  click(buttonByText("Add model", dialog));

  const deepseekRow = await screen.findByTestId(
    "org-model-policy-row-deepseek-v4-pro",
  );
  expect(within(deepseekRow).getByText("DeepSeek V4 Pro")).toBeInTheDocument();
});

test("Keep cloud onboarding hidden while native routes are supported", async () => {
  await openAddApiKeyModelDialog();
  const dialog = screen.getByRole("dialog", { name: "Add model" });
  const provider = within(dialog)
    .getAllByRole("combobox")
    .find((element) => {
      return element.textContent === "Anthropic";
    });
  if (!provider) {
    throw new Error("Expected the selected Anthropic provider");
  }
  click(provider);
  await expect(
    screen.findByRole("option", { name: "Anthropic" }),
  ).resolves.toBeVisible();
  expect(screen.getByRole("option", { name: "OpenRouter" })).toBeVisible();
  expect(
    screen.queryByRole("option", { name: /Bedrock|Foundry/u }),
  ).not.toBeInTheDocument();
});

test("Connect a workspace API key to a model route", async () => {
  await openAddApiKeyModelDialog();
  const dialog = screen.getByRole("dialog", { name: "Add model" });

  click(buttonByText("Add model", dialog));
  expect(screen.getByText("API key is required")).toBeInTheDocument();
  expect(
    screen.queryByTestId("org-model-policy-row-claude-opus-4-8"),
  ).not.toBeInTheDocument();

  await fill(
    screen.getByPlaceholderText("Enter your API key"),
    "  sk-ant-test  ",
  );
  click(buttonByText("Add model", dialog));

  const row = await screen.findByTestId("org-model-policy-row-claude-opus-4-8");
  expect(within(row).getByText("Claude Opus 4.8")).toBeInTheDocument();
  expect(within(row).getByText("Anthropic")).toBeInTheDocument();
});

test("Reject an empty workspace model API key without replacing its provider", async () => {
  mockApiKeyModelRouteStory();
  await openProvidersTab();

  const row = await screen.findByTestId("org-model-policy-row-claude-opus-4-8");
  expect(within(row).getByText("Claude Opus 4.8")).toBeInTheDocument();
  expect(within(row).getByText("Anthropic")).toBeInTheDocument();

  click(within(row).getByLabelText("Actions for Claude Opus 4.8"));
  click(menuItemByText("Edit model"));

  await waitFor(() => {
    expect(
      screen.getByRole("dialog", { name: "Edit model" }),
    ).toBeInTheDocument();
  });
  await fill(screen.getByPlaceholderText("Enter your API key"), " ");
  click(buttonByText("Save changes"));
  expect(screen.getByText("API key is required")).toBeInTheDocument();
  expect(within(row).getByText("Anthropic")).toBeInTheDocument();
});

test("Rotate a workspace model API key without exposing the new secret", async () => {
  mockApiKeyModelRouteStory();
  await openProvidersTab();

  const row = await screen.findByTestId("org-model-policy-row-claude-opus-4-8");
  expect(within(row).getByText("Claude Opus 4.8")).toBeInTheDocument();
  expect(within(row).getByText("Anthropic")).toBeInTheDocument();

  click(within(row).getByLabelText("Actions for Claude Opus 4.8"));
  click(menuItemByText("Edit model"));

  await waitFor(() => {
    expect(
      screen.getByRole("dialog", { name: "Edit model" }),
    ).toBeInTheDocument();
  });
  await fill(
    screen.getByPlaceholderText("Enter your API key"),
    "  sk-ant-rotated  ",
  );
  click(buttonByText("Save changes"));

  await waitFor(() => {
    expect(within(row).getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Model provider settings updated")).toBeVisible();
    expect(screen.queryByText("sk-ant-rotated")).not.toBeInTheDocument();
  });
});

test("Route a workspace model through a Claude subscription", async () => {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  await openProvidersTab();

  click(buttonByText("Add model"));
  await selectDialogModel("Claude Opus 4.8");
  click(radioByName(/Claude subscription/u));
  click(buttonByText("Add model"));

  const oauthRow = await screen.findByTestId(
    "org-model-policy-row-claude-opus-4-8",
  );
  expect(within(oauthRow).getByText("Claude Opus 4.8")).toBeInTheDocument();
  expect(
    within(oauthRow).getByText("Claude Code (OAuth token)"),
  ).toBeInTheDocument();
});

test("Route Claude Fable 5.1 through a workspace Claude subscription", async () => {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([]);
  await openProvidersTab();

  click(buttonByText("Add model"));
  await selectDialogModel("Claude Fable 5.1");
  click(radioByName(/Claude subscription/u));
  click(buttonByText("Add model"));

  const oauthRow = await screen.findByTestId(
    "org-model-policy-row-claude-fable-5-1",
  );
  expect(within(oauthRow).getByText("Claude Fable 5.1")).toBeInTheDocument();
  expect(
    within(oauthRow).getByText("Claude Code (OAuth token)"),
  ).toBeInTheDocument();
});

test("Add a Codex route and make it the workspace default", async () => {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000211",
      "deepseek-v4-flash",
      "DeepSeek V4 Flash",
      true,
    ),
  ]);
  await openProvidersTab();

  click(buttonByText("Add model"));
  const dialog = screen.getByRole("dialog", { name: "Add model" });
  click(within(dialog).getByRole("combobox"));
  click(await screen.findByRole("option", { name: "GPT 5.6 Sol" }));
  click(radioByName(/Codex subscription/u));
  click(buttonByText("Add model", dialog));

  const codexRow = await screen.findByTestId(
    "org-model-policy-row-gpt-5.6-sol",
  );
  expect(within(codexRow).getByText("GPT 5.6 Sol")).toBeInTheDocument();
  expect(within(codexRow).getByText("ChatGPT (Codex)")).toBeInTheDocument();
  const defaultRow = screen.getByTestId("default-model-row");
  expect(within(defaultRow).getByRole("combobox")).toHaveTextContent(
    "DeepSeek V4 Flash",
  );
  click(within(defaultRow).getByRole("combobox"));
  click(await screen.findByRole("option", { name: "GPT 5.6 Sol" }));

  await waitFor(() => {
    expect(within(defaultRow).getByRole("combobox")).toHaveTextContent(
      "GPT 5.6 Sol",
    );
  });
  expect(
    within(screen.getByTestId("default-model-row")).getByRole("combobox"),
  ).toHaveTextContent("GPT 5.6 Sol");
});

test("Add a GPT 6 Astra Codex subscription model route", async () => {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([]);
  await openProvidersTab();

  click(buttonByText("Add model"));
  const dialog = screen.getByRole("dialog", { name: "Add model" });
  click(within(dialog).getByRole("combobox"));
  click(await screen.findByRole("option", { name: "GPT 6 Astra" }));
  click(radioByName(/Codex subscription/u));
  click(buttonByText("Add model", dialog));

  const codexRow = await screen.findByTestId(
    "org-model-policy-row-gpt-6-astra",
  );
  expect(within(codexRow).getByText("GPT 6 Astra")).toBeInTheDocument();
  expect(within(codexRow).getByText("ChatGPT (Codex)")).toBeInTheDocument();
});

test("Add DeepSeek V4.1 Flash as a built-in model", async () => {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([]);
  await openProvidersTab();

  click(buttonByText("Add model"));
  const dialog = screen.getByRole("dialog", { name: "Add model" });
  await selectDialogModel("DeepSeek V4.1 Flash");
  expect(radioByName(/Built-in/u, dialog)).toBeChecked();
  click(buttonByText("Add model", dialog));

  const modelRow = await screen.findByTestId(
    "org-model-policy-row-deepseek-v4.1-flash",
  );
  expect(within(modelRow).getByText("DeepSeek V4.1 Flash")).toBeInTheDocument();
  expect(within(modelRow).getByText("Built-in")).toBeInTheDocument();
});

test("Offer an upgrade for restricted Pro models", async () => {
  mockAdminOrg();
  mockBillingCapabilities({
    supportByok: false,
    restrictedBuiltInModels: true,
  });
  context.mocks.data.orgModelProviders([]);
  context.mocks.api(billingCheckoutContract.create, ({ body, respond }) => {
    return respond(200, {
      url: `https://checkout.stripe.com/model-upgrade?tier=${body.tier}`,
    });
  });
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000221",
      "claude-fable-5-1",
      "Claude Fable 5.1",
      false,
    ),
    builtInPolicy(
      "00000000-0000-4000-a000-000000000222",
      "gpt-5.6-luna",
      "GPT 5.6 Luna",
      true,
    ),
  ]);
  await openModelSettings();

  const defaultRow = screen.getByTestId("default-model-row");
  click(within(defaultRow).getByRole("combobox"));
  click(await screen.findByRole("option", { name: /Claude Fable 5.*Pro/u }));

  const planDialog = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  expect(
    within(planDialog).getByRole("heading", { name: "Choose a plan" }),
  ).toBeInTheDocument();
  click(within(planDialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();
    expect(buttonByText("Models")).toBeInTheDocument();
  });

  click(buttonByText("Models"));
  await expect(
    screen.findByRole("heading", { name: "Models" }),
  ).resolves.toBeInTheDocument();
  click(buttonByText("Add model"));
  const addDialog = screen.getByRole("dialog", { name: "Add model" });
  click(within(addDialog).getByRole("combobox"));
  click(
    await screen.findByRole("option", {
      name: /GPT 5\.6 Sol\s+Pro/u,
    }),
  );
  expect(screen.queryByRole("heading", { name: "Choose a plan" })).toBeNull();
  click(buttonByText("Upgrade to Pro", addDialog));

  await waitFor(() => {
    expect(window.location.href).toBe(
      "https://checkout.stripe.com/model-upgrade?tier=pro",
    );
  });
});

test("Offer an upgrade for restricted Pro models from an API before the rename", async () => {
  mockAdminOrg();
  mockLegacyBillingCapabilities({
    supportByok: false,
    restrictedVm0Models: true,
  });
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000221",
      "claude-fable-5-1",
      "Claude Fable 5.1",
      false,
    ),
    builtInPolicy(
      "00000000-0000-4000-a000-000000000222",
      "gpt-5.6-luna",
      "GPT 5.6 Luna",
      true,
    ),
  ]);
  await openModelSettings();

  const defaultRow = screen.getByTestId("default-model-row");
  click(within(defaultRow).getByRole("combobox"));

  // The restriction can only come from the retired alias, so seeing the Pro
  // affordance proves the page honored it.
  await expect(
    screen.findByRole("option", { name: /Claude Fable 5.*Pro/u }),
  ).resolves.toBeInTheDocument();
});

test("Offer a plan change when bring-your-own-key is unavailable", async () => {
  mockAdminOrg();
  mockBillingCapabilities({
    supportByok: false,
    restrictedBuiltInModels: false,
  });
  context.mocks.data.orgModelProviders([]);
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000222",
      "deepseek-v4-flash",
      "DeepSeek V4 Flash",
      true,
    ),
  ]);
  await openModelSettings();

  click(buttonByText("Add model"));
  await selectDialogModel("Claude Opus 4.8");

  const apiKeyRoute = radioByName(/API key/u);
  click(apiKeyRoute);

  await expect(
    screen.findByRole("heading", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
});

test("Repair a model route whose provider is missing", async () => {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([anthropicApiKeyProvider()]);
  context.mocks.data.orgModelPolicies([
    builtInPolicy(
      "00000000-0000-4000-a000-000000000211",
      "deepseek-v4-flash",
      "DeepSeek V4 Flash",
      true,
    ),
    claudeOpusApiKeyPolicy(),
    missingOpenAiPolicy(),
  ]);
  await openProvidersTab();

  const missingRow = await screen.findByTestId("org-model-policy-row-gpt-5.5");
  expect(within(missingRow).getByText("Missing provider")).toBeInTheDocument();
  expect(
    within(missingRow).getByText("Workspace OpenAI API key was removed"),
  ).toBeInTheDocument();

  click(within(missingRow).getByLabelText("Actions for GPT 5.5"));
  click(menuItemByText("Edit model"));
  const editDialog = await screen.findByRole("dialog", { name: "Edit model" });
  click(radioByName(/Built-in/u, editDialog));
  click(buttonByText("Save changes", editDialog));

  await waitFor(() => {
    const repairedRow = screen.getByTestId("org-model-policy-row-gpt-5.5");
    expect(within(repairedRow).getByText("Built-in")).toBeInTheDocument();
    expect(within(repairedRow).queryByText("Missing provider")).toBeNull();
    expect(
      within(repairedRow).queryByText("Workspace OpenAI API key was removed"),
    ).toBeNull();
  });

  const defaultRow = screen.getByTestId("default-model-row");
  click(within(defaultRow).getByRole("combobox"));
  click(await screen.findByRole("option", { name: "GPT 5.5" }));

  await waitFor(() => {
    expect(within(defaultRow).getByRole("combobox")).toHaveTextContent(
      "GPT 5.5",
    );
    expect(
      within(screen.getByTestId("org-model-policy-row-gpt-5.5")).queryByText(
        "Missing provider",
      ),
    ).toBeNull();
  });
});

test("Show Codex device authorization progress", async () => {
  mockStaleProviderStory();
  context.mocks.browser.open(context.mocks.browser.authWindow());
  context.mocks.browser.clipboardWriteText();
  await openProvidersTab();

  const alert = await screen.findByRole("alert");
  click(within(alert).getByText("Reconnect"));

  const code = await screen.findByTestId("codex-device-auth-code");
  const reconnectDialog = dialogContaining(code);
  click(within(reconnectDialog).getByTestId("codex-device-auth-open"));

  await waitFor(() => {
    expect(
      within(reconnectDialog).getByText(
        "Device code copied. Waiting for approval...",
      ),
    ).toBeInTheDocument();
    expect(code).toBeVisible();
    expect(code).toHaveTextContent("WXYZ-1234");
    expect(screen.queryByText("ChatGPT connected")).toBeNull();
  });
});

test("Reconnect a stale workspace Claude account", async () => {
  mockAdminOrg();
  context.mocks.data.orgModelProviders([staleClaudeCodeProvider()]);
  context.mocks.data.orgModelPolicies([
    {
      id: "00000000-0000-4000-a000-000000000231",
      model: "claude-opus-4-8",
      modelLabel: "Claude Opus 4.8",
      isDefault: true,
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
      modelProviderSurfaceId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    },
  ]);
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "mock-workspace-claude-code-session",
      type: "claude-code",
      status: "pending",
      scope: "org",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });
  context.mocks.api(claudeCodeDeviceAuthContract.complete, ({ respond }) => {
    context.mocks.data.orgModelProviders([
      {
        ...staleClaudeCodeProvider(),
        needsReconnect: false,
        lastRefreshErrorCode: null,
      },
    ]);
    return respond(200, {
      status: "complete",
      provider: {
        ...staleClaudeCodeProvider(),
        needsReconnect: false,
        lastRefreshErrorCode: null,
      },
      created: false,
    });
  });

  await openProvidersTab();

  const alert = await screen.findByRole("alert");
  expect(
    within(alert).getByText("Claude Code session needs reconnection"),
  ).toBeInTheDocument();
  expect(
    within(alert).getByText(
      "Your Claude Code session expired. Re-connect to continue.",
    ),
  ).toBeInTheDocument();
  click(within(alert).getByText("Reconnect"));

  const codeInput = await screen.findByTestId("claude-code-device-auth-code");
  const reconnectDialog = codeInput.closest('[role="dialog"]');
  if (!(reconnectDialog instanceof HTMLElement)) {
    throw new Error("Claude Code reconnect dialog not found");
  }
  expect(
    within(reconnectDialog).getByText("Re-connect Claude Code"),
  ).toBeInTheDocument();

  await fill(codeInput, "workspace-claude-code");
  click(within(reconnectDialog).getByTestId("claude-code-device-auth-submit"));

  await waitFor(() => {
    expect(screen.getByText("Claude Code connected")).toBeInTheDocument();
    expect(screen.queryByText("Re-connect Claude Code")).toBeNull();
    expect(
      screen.queryByText("Claude Code session needs reconnection"),
    ).toBeNull();
    const routeRow = screen.getByTestId("org-model-policy-row-claude-opus-4-8");
    expect(
      within(routeRow).getByText("Claude Code (OAuth token)"),
    ).toBeInTheDocument();
  });
});

test("Complete a stale workspace Codex reconnection", async () => {
  mockStaleProviderStory();
  context.mocks.data.orgModelPolicies([
    {
      id: "00000000-0000-4000-a000-000000000232",
      model: "gpt-5.6-sol",
      modelLabel: "GPT 5.6 Sol",
      isDefault: true,
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
      modelProviderSurfaceId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    },
  ]);
  context.mocks.browser.open(context.mocks.browser.authWindow());
  context.mocks.browser.clipboardWriteText();
  context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
    context.mocks.data.orgModelProviders([
      {
        ...staleCodexProvider(),
        needsReconnect: false,
        lastRefreshErrorCode: null,
      },
    ]);
    return respond(200, {
      status: "complete",
      provider: {
        ...staleCodexProvider(),
        needsReconnect: false,
        lastRefreshErrorCode: null,
      },
      created: false,
    });
  });

  await openProvidersTab();

  const alert = await screen.findByRole("alert");
  click(within(alert).getByText("Reconnect"));

  await waitFor(() => {
    expect(screen.getByText("ChatGPT connected")).toBeInTheDocument();
    expect(screen.queryByText("Re-connect Codex")).toBeNull();
    expect(screen.queryByText("ChatGPT session needs reconnection")).toBeNull();
    const routeRow = screen.getByTestId("org-model-policy-row-gpt-5.6-sol");
    expect(within(routeRow).getByText("ChatGPT (Codex)")).toBeInTheDocument();
  });
});

test("Cancel an unfinished workspace Codex reconnection when Settings closes", async () => {
  mockStaleProviderStory();
  context.mocks.api(codexDeviceAuthContract.cancel, ({ respond }) => {
    return respond(200, { status: "cancelled" });
  });
  await openProvidersTab();

  const alert = await screen.findByRole("alert");
  click(within(alert).getByText("Reconnect"));

  const code = await screen.findByTestId("codex-device-auth-code");
  const deviceDialog = dialogContaining(code);
  click(within(deviceDialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("codex-device-auth-code")).toBeNull();
    expect(within(alert).getByText("Reconnect")).toBeInTheDocument();
  });

  const settingsDialog = screen.getByRole("dialog", { name: "Settings" });
  click(within(settingsDialog).getByLabelText("Close"));

  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  const reopenedSettings = await openSettingsFromAccountMenu();
  click(buttonByText("Models", reopenedSettings));
  const reopenedAlert = await screen.findByRole("alert");
  expect(within(reopenedAlert).getByText("Reconnect")).toBeInTheDocument();
  click(within(reopenedAlert).getByText("Reconnect"));
  await expect(
    screen.findByTestId("codex-device-auth-code"),
  ).resolves.toHaveTextContent("WXYZ-1234");
});
