import { createStore, state } from "ccstate";

import { mockedClerk } from "../../__tests__/mock-auth.ts";
import { CLERK_UI_VERSION } from "../../lib/clerk-versions.ts";
import { createDeferredPromise } from "../../signals/utils.ts";

interface ClerkResourceOptions {
  readonly publishableKey: string;
}

interface ClerkResourceRequest {
  readonly publishableKey: string;
}

interface ClerkResourceMock {
  readonly requests: ClerkResourceRequest[];
  readonly uiRequests: string[];
  readonly pending: () => ReturnType<typeof createDeferredPromise<void>>;
  readonly unavailable: (error?: Error) => void;
}

interface ClerkResourceBehavior {
  failure: Error | null;
  gate: Promise<void>;
  readonly requests: ClerkResourceRequest[];
  readonly uiRequests: string[];
}

const CLERK_UI_GLOBAL = "__okouClerkUI";

function MockClerkUI(): void {
  return;
}

const activeBehavior$ = state<ClerkResourceBehavior | null>(null);
const behaviorStore = createStore();

export function mockClerkResource(signal: AbortSignal): ClerkResourceMock {
  const behavior: ClerkResourceBehavior = {
    failure: null,
    gate: Promise.resolve(),
    requests: [],
    uiRequests: [],
  };
  behaviorStore.set(activeBehavior$, behavior);
  signal.addEventListener(
    "abort",
    () => {
      if (behaviorStore.get(activeBehavior$) === behavior) {
        behaviorStore.set(activeBehavior$, null);
      }
      Reflect.deleteProperty(globalThis, "Clerk");
      Reflect.deleteProperty(window, CLERK_UI_GLOBAL);
    },
    { once: true },
  );

  return {
    requests: behavior.requests,
    uiRequests: behavior.uiRequests,
    pending() {
      const deferred = createDeferredPromise<void>(signal);
      behavior.gate = deferred.promise;
      return deferred;
    },
    unavailable(error = new Error("Clerk resource is unavailable")): void {
      behavior.failure = error;
    },
  };
}

export async function loadClerkJSScript(
  options: ClerkResourceOptions,
): Promise<null> {
  if (Reflect.has(globalThis, "Clerk")) {
    return null;
  }
  const behavior = behaviorStore.get(activeBehavior$);
  if (!behavior) {
    throw new Error("Clerk resource behavior was not configured");
  }
  behavior.requests.push({
    publishableKey: options.publishableKey,
  });
  await behavior.gate;
  if (behavior.failure) {
    throw behavior.failure;
  }
  Reflect.set(globalThis, "Clerk", mockedClerk);
  return null;
}

export async function loadScript(src: string): Promise<null> {
  if (Reflect.has(window, CLERK_UI_GLOBAL)) {
    return null;
  }
  const behavior = behaviorStore.get(activeBehavior$);
  if (!behavior) {
    throw new Error("Clerk resource behavior was not configured");
  }
  behavior.uiRequests.push(src);
  await behavior.gate;
  if (behavior.failure) {
    throw behavior.failure;
  }
  Reflect.set(window, CLERK_UI_GLOBAL, {
    ClerkUI: MockClerkUI,
    version: CLERK_UI_VERSION,
  });
  return null;
}
