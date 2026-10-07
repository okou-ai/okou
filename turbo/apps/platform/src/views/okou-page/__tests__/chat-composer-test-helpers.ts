import {
  agentInstructionsContract,
  agentsByIdContract,
} from "@okouai/api-contracts/contracts/agents";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type {
  AvailableRunModel,
  ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import type { PresentationTemplateItem } from "@okouai/core";
import { screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import { MOCK_SYSTEM_DEFAULT_MODEL } from "../../../mocks/handlers/api-model-catalog.ts";
import {
  chatEventRowsResponse,
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

export const context = testContext();

export const AGENT_ID = "e0000000-0000-4000-a000-000000000010";

const OTHER_AGENT_ID = "e0000000-0000-4000-a000-000000000011";

export const THREAD_ID = "b1000000-0000-4000-a000-000000000101";

export const CLAUDE_SUBSCRIPTION_PROVIDER_ID =
  "00000000-0000-4000-a000-000000000002";

export function expectTextBefore(firstText: string, secondText: string): void {
  const first = screen.getByText(firstText);
  const second = screen.getByText(secondText);
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

function queryTabByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("tab").find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
    }) ?? null
  );
}

export function tabByText(text: string): HTMLElement {
  const tab = queryTabByText(text);
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
}

export function buttonContainingText(
  text: string,
  container: ParentNode = document.body,
) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim().includes(text);
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

export function buildProvider(
  overrides: Partial<ModelProviderResponse> & {
    id: string;
    type: ModelProviderResponse["type"];
  },
): ModelProviderResponse {
  return {
    framework: "claude-code",
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

export function buildRunModel(
  overrides: Partial<AvailableRunModel> & Pick<AvailableRunModel, "model">,
): AvailableRunModel {
  return {
    modelLabel: "Claude Opus 5.5",
    defaultProviderType: "claude-code-oauth-token",
    credentialScope: "member",
    modelProviderId: null,
    routeStatus: "valid",
    ...overrides,
  };
}

export function mockPersonalModelRoutes(): void {
  context.mocks.data.personalModelProviders([
    buildProvider({
      id: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      type: "claude-code-oauth-token",
    }),
  ]);
  context.mocks.data.availableRunModels([
    buildRunModel({
      model: "claude-fable-5-1",
      modelLabel: "Claude Fable 5.1",
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
    buildRunModel({
      model: "claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
    buildRunModel({
      model: "claude-opus-5-5",
      modelLabel: "Claude Opus 5.5",
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
    buildRunModel({
      model: "claude-opus-5",
      modelLabel: "Claude Opus 5",
      defaultProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
    buildRunModel({
      model: MOCK_SYSTEM_DEFAULT_MODEL,
      modelLabel: "Auto",
      defaultProviderType: "built-in",
      credentialScope: "org",
    }),
  ]);
}

function billingStatus(
  tier: string,
  modelCapabilities?: {
    readonly restrictedBuiltInModels?: boolean;
  },
): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier,
    ...billingPlanCapabilities(tier),
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

export function mockBillingCapabilities(
  modelCapabilities: {
    readonly restrictedBuiltInModels: boolean;
  },
  tier = "pro",
): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus(tier, modelCapabilities));
  });
}

export function mockAgent(options?: { includeOtherAgent?: boolean }): void {
  const agents = [
    {
      agentId: AGENT_ID,
      displayName: "Scout",
      description: null,
      sound: null,
      avatarUrl: null,
    },
    ...(options?.includeOtherAgent
      ? [
          {
            agentId: OTHER_AGENT_ID,
            displayName: "Other Agent",
            description: null,
            sound: null,
            avatarUrl: null,
          },
        ]
      : []),
  ];
  context.mocks.data.agents(agents);
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const isOtherAgent = params.id === OTHER_AGENT_ID;
    return respond(200, {
      isDefaultAgent: false,
      agentId: params.id,
      ownerId: "test-user-123",
      displayName: isOtherAgent ? "Other Agent" : "Scout",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    });
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
}

export function mockThread(options?: {
  selectedModel?: string | null;
  activeRunIds?: string[];
  messages?: MockChatEventInput[];
}): void {
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: [
          {
            id: THREAD_ID,
            agentId: AGENT_ID,
            title: "My thread",
            sortAt: "2026-03-10T00:00:00Z",
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            pinnedAt: null,
            archived: false,
            renamedAt: null,
            selectedModel: options?.selectedModel ?? null,
            serviceTier: null,
            computerUseHostId: null,
          },
        ],
        latestEventId: null,
        latestSeqId: null,
      }),
    );
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads:
        options?.activeRunIds && options.activeRunIds.length > 0
          ? { [THREAD_ID]: "active" }
          : {},
      unreadAt: {},
    });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(
      200,
      chatEventRowsResponse(
        mockChatEventRows(
          normalizeMockChatEvents(options?.messages ?? [], THREAD_ID),
        ).filter((row) => {
          return row.seqId > query.sinceSeqId;
        }),
        query,
      ),
    );
  });
}

export function mockActiveTemplateThread(): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "msg-template-active-user",
        role: "user",
        content: "Start an active deck run",
        runId: "run-template-active",
        createdAt: "2026-06-09T10:00:00Z",
      },
    ],
    activeRunIds: ["run-template-active"],
  });
}

export function trackTemplatePreviewImagePreloads(): {
  readonly srcs: readonly string[];
} {
  const srcs: string[] = [];

  class TestImagePreload {
    decoding = "";
    loading = "";
    fetchPriority = "";
    #src = "";

    decode(): Promise<void> {
      return Promise.resolve();
    }

    get src(): string {
      return this.#src;
    }

    set src(value: string) {
      this.#src = value;
      srcs.push(value);
    }
  }

  const imageConstructor = TestImagePreload as unknown as typeof Image;
  vi.stubGlobal("Image", imageConstructor);

  return { srcs };
}

/**
 * The composer's model control. Its name lists the model, then the effort and
 * Fast it runs with ("GPT 5.6 Sol, Max, Fast"); a label naming only the model
 * matches whatever effort it carries.
 */
export function queryComposerModelTrigger(label: string): HTMLElement | null {
  return (
    queryAllByRoleFast("button").find((button) => {
      const name = button.getAttribute("aria-label");
      return (
        name === label ||
        name?.startsWith(`${label}, `) === true ||
        button.textContent?.replace(/\s+/gu, " ").trim() === label
      );
    }) ?? null
  );
}

export async function composerModelTrigger(
  label: string,
): Promise<HTMLElement> {
  return await findComposerModel(label);
}

async function findComposerModel(label: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const trigger = queryComposerModelTrigger(label);
    if (!trigger) {
      throw new Error(`The composer model trigger for ${label} is not visible`);
    }
    return trigger;
  });
}

export function composerInlineTemplates(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll("[data-composer-inline-template]"),
  ).filter((element): element is HTMLElement => {
    return element instanceof HTMLElement;
  });
}

// Selecting a template inserts an inline node into the composer document, so
// the permanent signal is the node itself rather than a picker selection.
export async function expectInlineTemplateInComposer(
  title: string,
): Promise<void> {
  await waitFor(() => {
    expect(
      composerInlineTemplates().map((node) => {
        return node.textContent;
      }),
    ).toContain(title);
  });
}

export async function selectTemplate(
  template: PresentationTemplateItem,
): Promise<void> {
  click(
    await waitFor(() => {
      return screen.getByLabelText("Template");
    }),
  );
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  click(screen.getByLabelText(`Select template ${template.title}`));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await expectInlineTemplateInComposer(template.title);
}

// The slash-workflow composer renders a TipTap contenteditable instead of a
// textarea, so locate it directly rather than by placeholder.
export async function findComposerEditor(): Promise<HTMLElement> {
  return await waitFor(() => {
    const editor = document.querySelector(
      '[data-slot="chat-composer-card"] [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer editor not found");
    }
    return editor;
  });
}

export function composerWorkflow(
  name: string,
  description: string | null,
): ComposerWorkflow {
  return {
    id: crypto.randomUUID(),
    name,
    displayName: null,
    description,
  };
}
