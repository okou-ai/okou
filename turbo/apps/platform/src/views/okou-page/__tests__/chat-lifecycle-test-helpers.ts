import { waitFor } from "@testing-library/react";
import { expect, vi, type Mock } from "vitest";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  queryAllByRoleFast,
  setupPage as baseSetupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

export const context = testContext();

export function setupPage(
  options: Parameters<typeof baseSetupPage>[0],
): Promise<void> {
  return baseSetupPage(options);
}

export const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function replaceNavigatorProperty(property: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, property);
  Object.defineProperty(navigator, property, {
    configurable: true,
    value,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(navigator, property, descriptor);
        return;
      }
      Reflect.deleteProperty(navigator, property);
    },
    { once: true },
  );
}

export function mockMacUserAgentData(architecture: string): void {
  replaceNavigatorProperty("userAgentData", {
    platform: "macOS",
    getHighEntropyValues: () => {
      return Promise.resolve({ architecture, platform: "macOS" });
    },
  });
}

export function computerUsePermissions() {
  return {
    accessibility: true,
    screenRecording: true,
    automation: {
      chrome: { status: "unknown" as const, updatedAt: null, reason: null },
      safari: { status: "unknown" as const, updatedAt: null, reason: null },
    },
  };
}

interface PushBrowserMock {
  readonly register: Mock<TestServiceWorkerContainer["register"]>;
}

type TestPushManager = Pick<PushManager, "getSubscription" | "subscribe">;

interface TestServiceWorkerRegistration {
  readonly pushManager: TestPushManager;
}

interface TestServiceWorkerContainer {
  readonly addEventListener: ServiceWorkerContainer["addEventListener"];
  readonly register: () => Promise<TestServiceWorkerRegistration>;
}

export async function readSingleRichClipboardWrite(clipboard: {
  readonly writes: ClipboardItem[][];
}): Promise<ClipboardItem> {
  await waitFor(() => {
    expect(clipboard.writes).toHaveLength(1);
    expect(clipboard.writes[0]).toHaveLength(1);
  });
  const item = clipboard.writes[0]?.[0];
  if (!item) {
    throw new Error("clipboard item not found");
  }
  return item;
}

export async function readClipboardItemText(
  item: ClipboardItem,
  type: string,
): Promise<string> {
  const blob = await item.getType(type);
  return await blob.text();
}

export function parseChatClipboardPayload(html: string): {
  text: string;
  attachments: {
    id: string | null;
    url: string;
    filename: string;
    contentType: string;
    size: number;
  }[];
  userMessage?: UserMessageDocument;
} {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const encoded = doc.querySelector<HTMLElement>("[data-okou-chat-message]")
    ?.dataset.okouChatMessage;
  if (!encoded) {
    throw new Error("chat clipboard payload not found");
  }
  return JSON.parse(decodeURIComponent(encoded)) as {
    text: string;
    attachments: {
      id: string | null;
      url: string;
      filename: string;
      contentType: string;
      size: number;
    }[];
    userMessage?: UserMessageDocument;
  };
}

export function mockPushBrowserSupport(): PushBrowserMock {
  vi.stubGlobal("PushManager", class TestPushManager {});
  let notificationPermission: NotificationPermission = "default";
  vi.stubGlobal("Notification", {
    get permission() {
      return notificationPermission;
    },
    requestPermission: vi.fn<typeof Notification.requestPermission>(() => {
      notificationPermission = "granted";
      return Promise.resolve(notificationPermission);
    }),
  });

  const subscriptionKeys: Record<PushEncryptionKeyName, ArrayBuffer> = {
    p256dh: new Uint8Array([1, 2, 3]).buffer,
    auth: new Uint8Array([4, 5, 6]).buffer,
  };
  const subscription = {
    endpoint: "https://push.example.test/subscriptions/chat-send",
    getKey: (name: PushEncryptionKeyName) => {
      return subscriptionKeys[name] ?? null;
    },
  } satisfies Pick<PushSubscription, "endpoint" | "getKey">;
  const pushManager: TestPushManager = {
    getSubscription: vi.fn<PushManager["getSubscription"]>(() => {
      return Promise.resolve(null);
    }),
    subscribe: vi.fn<PushManager["subscribe"]>(() => {
      return Promise.resolve(subscription as PushSubscription);
    }),
  };
  const registration = {
    pushManager,
  } satisfies TestServiceWorkerRegistration;
  const register = vi.fn<TestServiceWorkerContainer["register"]>(() => {
    return Promise.resolve(registration);
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "serviceWorker",
  );
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: vi.fn<ServiceWorkerContainer["addEventListener"]>(),
      register,
    } satisfies TestServiceWorkerContainer,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(navigator, "serviceWorker", descriptor);
        return;
      }
      Reflect.deleteProperty(navigator, "serviceWorker");
    },
    { once: true },
  );

  return { register };
}

export function makeRunGroupMessages(params: {
  readonly label: string;
  readonly count: number;
  readonly runGroupId: string;
  readonly startMinute: number;
}): MockChatEventInput[] {
  return Array.from({ length: params.count }, (_, index) => {
    const itemNumber = index + 1;
    const runId = `${params.runGroupId}-run-${itemNumber}`;
    const createdAt = new Date(
      Date.UTC(2026, 7, 1, 12, params.startMinute + index, 0),
    ).toISOString();
    const assistantCreatedAt = new Date(
      Date.UTC(2026, 7, 1, 12, params.startMinute + index, 30),
    ).toISOString();
    return [
      {
        id: `msg-${params.label.toLowerCase()}-${itemNumber}-user`,
        role: "user" as const,
        eventType: "input.automation" as const,
        content: null,
        userMessage: {
          version: 1 as const,
          parts: [
            {
              type: "automation" as const,
              workflowName: params.label.toLowerCase().replaceAll(" ", "-"),
              automationBrief: params.label,
            },
          ],
        },
        runId,
        runGroupId: params.runGroupId,
        createdAt,
      },
      {
        id: `msg-${params.label.toLowerCase()}-${itemNumber}-assistant`,
        role: "assistant" as const,
        content: `${params.label} reply ${itemNumber}`,
        runId,
        runGroupId: params.runGroupId,
        createdAt: assistantCreatedAt,
      },
    ];
  }).flat();
}

function mockNoBrowserSession(): void {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
}

export function mockChatLifecycleWithoutBrowserSession(
  options?: Parameters<typeof mockChatLifecycle>[1],
): ReturnType<typeof mockChatLifecycle> {
  mockNoBrowserSession();
  return mockChatLifecycle(context, options);
}
export function buttonByText(
  text: string,
  container?: ParentNode,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

export function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

export function chatScrollContainer(): HTMLElement {
  const element = document.querySelector("[data-scroll-container]");
  if (!(element instanceof HTMLElement)) {
    throw new Error("Chat scroll container not found");
  }
  return element;
}

export function chatComposerTextarea(): HTMLElement {
  const element = document.querySelector(
    '[data-chat-composer] [contenteditable="true"]',
  );
  if (!(element instanceof HTMLElement)) {
    throw new Error("Chat composer input not found");
  }
  return element;
}

export function activeElementIsInside(element: HTMLElement): boolean {
  return (
    document.activeElement === element ||
    (document.activeElement instanceof Node &&
      element.contains(document.activeElement))
  );
}

export function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
  });
}
