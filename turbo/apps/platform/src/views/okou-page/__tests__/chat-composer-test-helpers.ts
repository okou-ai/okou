import { screen, waitFor } from "@testing-library/react";
import type { PresentationTemplateItem } from "@okouai/core";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type {
  ModelProviderResponse,
  OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";
import {
  agentsByIdContract,
  agentInstructionsContract,
} from "@okouai/api-contracts/contracts/agents";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { expect, vi } from "vitest";
import {
  testContext,
  chatEventRowsResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";

export const context = testContext();

export const AGENT_ID = "e0000000-0000-4000-a000-000000000010";

const OTHER_AGENT_ID = "e0000000-0000-4000-a000-000000000011";

export const THREAD_ID = "b1000000-0000-4000-a000-000000000101";

const ANTHROPIC_PROVIDER_ID = "00000000-0000-4000-a000-000000000001";

export const OPENROUTER_PROVIDER_ID = "00000000-0000-4000-a000-000000000002";

const VERCEL_PROVIDER_ID = "00000000-0000-4000-a000-000000000003";

const NOW = "2026-05-08T00:00:00.000Z";

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

export function linkByText(text: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!link) {
    throw new Error(`${text} link not found`);
  }
  return link;
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
    secretName: "ANTHROPIC_API_KEY",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

export function buildModelPolicy(
  overrides: Partial<OrgModelPolicy> & Pick<OrgModelPolicy, "model">,
): OrgModelPolicy {
  return {
    id: "00000000-0000-4000-a000-000000000101",
    modelLabel: "Claude Opus 4.8",
    isDefault: false,
    defaultProviderType: "claude-code-oauth-token",
    credentialScope: "member",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function mockOrgModelRoutes(defaultSelectedModel: string): void {
  context.mocks.data.orgModelProviders([
    buildProvider({
      id: OPENROUTER_PROVIDER_ID,
      type: "openrouter-api-key",
      secretName: "OPENROUTER_API_KEY",
    }),
    buildProvider({
      id: ANTHROPIC_PROVIDER_ID,
      type: "anthropic-api-key",
      secretName: "ANTHROPIC_API_KEY",
    }),
    buildProvider({
      id: VERCEL_PROVIDER_ID,
      type: "vercel-ai-gateway",
      secretName: "VERCEL_AI_GATEWAY_API_KEY",
    }),
  ]);
  context.mocks.data.orgModelPolicies([
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000201",
      model: "claude-fable-5-1",
      modelLabel: "Claude Fable 5.1",
      isDefault: defaultSelectedModel === "claude-fable-5-1",
      defaultProviderType: "openrouter-api-key",
      credentialScope: "org",
      modelProviderId: OPENROUTER_PROVIDER_ID,
    }),
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000202",
      model: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
      isDefault: defaultSelectedModel === "claude-sonnet-4-6",
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: ANTHROPIC_PROVIDER_ID,
    }),
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000203",
      model: "claude-opus-4-8",
      modelLabel: "Claude Opus 4.8",
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: ANTHROPIC_PROVIDER_ID,
    }),
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000204",
      model: "claude-opus-5",
      modelLabel: "Claude Opus 5",
      isDefault: defaultSelectedModel === "claude-opus-5",
      defaultProviderType: "vercel-ai-gateway",
      credentialScope: "org",
      modelProviderId: VERCEL_PROVIDER_ID,
    }),
  ]);
}

function billingStatus(
  tier: string,
  modelCapabilities?: {
    readonly supportByok?: boolean;
    readonly restrictedBuiltInModels?: boolean;
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

export function mockBillingCapabilities(
  modelCapabilities: {
    readonly supportByok: boolean;
    readonly restrictedBuiltInModels: boolean;
  },
  tier = "pro",
): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus(tier, modelCapabilities));
  });
}

export function mockAgent(options?: {
  selectedModel?: string | null;
  modelProviderId?: string | null;
  includeOtherAgent?: boolean;
}): void {
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
      modelProviderId: isOtherAgent ? null : (options?.modelProviderId ?? null),
      selectedModel: isOtherAgent ? null : (options?.selectedModel ?? null),
      preferPersonalProvider: false,
      visibility: "public",
    });
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
}

export function mockThread(options?: {
  selectedModel?: string | null;
  selectedVideoModel?: string | null;
  selectedImageModel?: string | null;
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
    return respond(200, {
      chatThreads: [
        {
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "My thread",
          sortAt: "2026-03-10T00:00:00Z",
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          pinnedAt: null,
          renamedAt: null,
          selectedModel: options?.selectedModel ?? null,
          serviceTier: null,
          computerUseHostId: null,
          selectedVideoModel: options?.selectedVideoModel ?? null,
          selectedImageModel: options?.selectedImageModel ?? null,
        },
      ],
      latestEventId: null,
      latestSeqId: null,
    });
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

export function mockComposerThreadSnapshot(
  threads: readonly {
    readonly id: string;
    readonly agentId: string;
    readonly title: string | null;
    readonly selectedModel?: string | null;
    readonly selectedImageModel?: string | null;
  }[],
): void {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threads.map((thread, index) => {
        const timestamp = new Date(
          Date.parse("2026-03-10T00:00:00Z") + index * 1000,
        ).toISOString();
        return {
          ...thread,
          sortAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
          pinnedAt: null,
          renamedAt: null,
          selectedModel: thread.selectedModel ?? null,
          serviceTier: null,
          computerUseHostId: null,
          selectedVideoModel: null,
          selectedImageModel: thread.selectedImageModel ?? null,
        };
      }),
      latestEventId: null,
      latestSeqId: null,
    });
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
      {
        id: "msg-template-active-assistant",
        role: "assistant",
        content: null,
        runId: "run-template-active",
        createdAt: "2026-06-09T10:00:01Z",
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

export function mockUrlObjectMethods(
  createObjectURLImplementation: (blob: Blob) => string,
) {
  const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(
    URL,
    "revokeObjectURL",
  );
  const createObjectURL = vi.fn<typeof URL.createObjectURL>(
    createObjectURLImplementation,
  );
  const revokeObjectURL = vi.fn<typeof URL.revokeObjectURL>();
  Object.defineProperties(URL, {
    createObjectURL: {
      configurable: true,
      value: createObjectURL,
    },
    revokeObjectURL: {
      configurable: true,
      value: revokeObjectURL,
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (createObjectURLDescriptor) {
        Object.defineProperty(
          URL,
          "createObjectURL",
          createObjectURLDescriptor,
        );
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeObjectURLDescriptor) {
        Object.defineProperty(
          URL,
          "revokeObjectURL",
          revokeObjectURLDescriptor,
        );
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    },
    { once: true },
  );

  return { createObjectURL, revokeObjectURL };
}

async function findComposerModel(label: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const combobox = screen.getByRole("combobox", { name: label });
    expect(combobox).toBeInTheDocument();
    return combobox;
  });
}

export async function expectComposerModel(label: string): Promise<void> {
  await expect(findComposerModel(label)).resolves.toBeInTheDocument();
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

export function workflowSummary({
  name,
  displayName,
  description,
  agentId = OTHER_AGENT_ID,
}: {
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly agentId?: string;
}): WorkflowSummary {
  return {
    id: crypto.randomUUID(),
    agentId,
    agentName: null,
    agentDisplayName: agentId === AGENT_ID ? "Scout" : "Other Agent",
    name,
    displayName,
    description,
    visibility: "public" as const,
    ownerUserId: "user-1",
    createdAt: "2026-06-01T00:00:00.000Z",
    canManage: true,
    canPublish: false,
    official: null,
    shadowedBy: null,
  };
}
