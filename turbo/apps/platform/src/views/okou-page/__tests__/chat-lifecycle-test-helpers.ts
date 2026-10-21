import { vi, type Mock } from "vitest";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  queryAllByRoleFast,
  setupPage as baseSetupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

export function setupPage(
  options: Parameters<typeof baseSetupPage>[0],
): Promise<void> {
  return baseSetupPage(options);
}

export const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

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

export function createChatLifecycleHelpers(context: TestContext) {
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

  function mockMacUserAgentData(architecture: string): void {
    replaceNavigatorProperty("userAgentData", {
      platform: "macOS",
      getHighEntropyValues: () => {
        return Promise.resolve({ architecture, platform: "macOS" });
      },
    });
  }

  function mockPushBrowserSupport(): PushBrowserMock {
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

  function mockChatLifecycleWithoutBrowserSession(
    options?: Parameters<typeof mockChatLifecycle>[1],
  ): ReturnType<typeof mockChatLifecycle> {
    mockNoBrowserSession();
    return mockChatLifecycle(context, options);
  }

  return {
    mockMacUserAgentData,
    mockPushBrowserSupport,
    mockChatLifecycleWithoutBrowserSession,
  };
}
