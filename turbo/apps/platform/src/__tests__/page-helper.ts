import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@okouai/ui/components/ui/sonner";

import type { TestContext } from "../signals/__tests__/test-helpers";
import type { mockOrganization, mockUser } from "./mock-auth";
import { bootstrap$ } from "../signals/bootstrap";
import { setupRouter } from "../views/main";
import {
  mockPushState,
  mockReplaceState,
  setHash,
  setPathname,
  setSearch,
} from "../signals/location";
import { vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { setMockFeatureSwitches } from "../mocks/handlers/api-feature-switches.helpers";
import { setDebugLoggerLocalStorage$ } from "../signals/bootstrap/loggers";
import { createDeferredPromise, detach, Reason } from "../signals/utils";
import {
  setupSharedWorkerTestBootstrap$,
  type SharedWorkerTestTransport,
} from "../shared-database/test-bridge.ts";
import type { ChatThreadEventQueryResult } from "../shared-database/data-key.ts";
import { resolvePlatformRuntimeConfig } from "../lib/platform-host.ts";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "../i18n/resources.ts";
import {
  initializeI18nWithResources,
  loadInitialLocaleResources,
} from "../i18n/index.ts";

const TEST_APP_VERSION = "0.540.0";

function ensureTestLocalStorage(): void {
  const currentLocalStorage = globalThis.localStorage;
  if (
    typeof currentLocalStorage !== "undefined" &&
    typeof currentLocalStorage.getItem === "function" &&
    typeof currentLocalStorage.setItem === "function"
  ) {
    return;
  }
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => {
        values.clear();
      },
      getItem: (key: string) => {
        return values.get(key) ?? null;
      },
      key: (index: number) => {
        return Array.from(values.keys())[index] ?? null;
      },
      get length() {
        return values.size;
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    } satisfies Storage,
  });
}

type MockedUser = Exclude<Parameters<typeof mockUser>[0], null>;
type MockedSession = Exclude<Parameters<typeof mockUser>[1], null>;
type MockedOrganization = Parameters<typeof mockOrganization>[0];

export type SetupPageAuth = null | {
  readonly user: MockedUser;
  readonly organization?: MockedOrganization;
  readonly session?: MockedSession | null;
};

interface SetupPageOptions {
  readonly appVersion?: string;
  readonly context: TestContext;
  readonly path: string;
  readonly host?: string;
  /**
   * Pass `null` to omit the Clerk bootstrap object entirely, which is what a
   * page that never ran the inline bootstrap produces.
   */
  readonly clerkBootstrap?: null;
  readonly locale?: SupportedLocale;
  readonly auth?: SetupPageAuth;
  readonly debugLoggers?: string[];
  readonly env?: PageEnvironment;
  readonly featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  readonly sharedWorkerAppVersion?: string;
  /**
   * Supplies the shared worker's cache-only chat-thread projection to a
   * page-level story without coupling its UI assertion to IndexedDB startup.
   */
  readonly cachedChatThreadEvents?: ChatThreadEventQueryResult;
  readonly sharedWorkerTestTransport?: SharedWorkerTestTransport;
}

type EnvironmentValue = string | undefined;
type PageEnvironment = Readonly<Record<string, EnvironmentValue>>;

const originalEnvironmentBySignal = new WeakMap<
  AbortSignal,
  Map<string, EnvironmentValue>
>();

function applyPageEnvironment(
  env: PageEnvironment | undefined,
  signal: AbortSignal,
): void {
  if (!env) {
    return;
  }
  let originals = originalEnvironmentBySignal.get(signal);
  if (!originals) {
    const originalValues = new Map<string, EnvironmentValue>();
    originals = originalValues;
    originalEnvironmentBySignal.set(signal, originalValues);
    signal.addEventListener(
      "abort",
      () => {
        for (const [key, value] of originalValues) {
          vi.stubEnv(key, value);
        }
        originalEnvironmentBySignal.delete(signal);
      },
      { once: true },
    );
  }
  for (const [key, value] of Object.entries(env)) {
    if (!originals.has(key)) {
      const current: unknown = import.meta.env[key];
      originals.set(key, typeof current === "string" ? current : undefined);
    }
    vi.stubEnv(key, value);
  }
}

const DEFAULT_USER: MockedUser = {
  id: "test-user-123",
  fullName: "Test User",
};

const DEFAULT_SESSION: MockedSession = { token: "test-token" };

const DEFAULT_ORGANIZATION: MockedOrganization = {
  activeOrg: { id: "org_default", name: "Default Org" },
  memberships: [{ id: "org_default" }],
};

function initialPageUrl(path: string, host: string): URL {
  const protocol = host === "localhost" ? "http" : "https";
  return new URL(path, `${protocol}://${host}`);
}

// Mirrors the inline Clerk bootstrap in index.html, which publishes the load
// options before the app module runs.
function installClerkBootstrap(
  pageUrl: URL,
  requestedBootstrap: null | undefined,
  signal: AbortSignal,
): void {
  // A test that installs its own bootstrap owns the whole object.
  if (requestedBootstrap === null || window.__okouClerkBootstrap) {
    return;
  }
  const authOrigin = pageUrl.origin;
  window.__okouClerkBootstrap = {
    loadOptions: {
      afterSignOutUrl: new URL("/sign-in", authOrigin).toString(),
      signInUrl: new URL("/sign-in", authOrigin).toString(),
      signUpUrl: new URL("/sign-up", authOrigin).toString(),
    },
    // The page selects the publishable key by hostname. Read the same source
    // the app reads so the two never disagree for a preview host.
    publishableKey: resolvePlatformRuntimeConfig().clerkPublishableKey,
    resolveClerkUI: () => {
      return;
    },
  };
  signal.addEventListener(
    "abort",
    () => {
      Reflect.deleteProperty(window, "__okouClerkBootstrap");
    },
    { once: true },
  );
}

function resolveAuth(options: SetupPageOptions): {
  readonly organization: MockedOrganization;
  readonly session: MockedSession | null;
  readonly signedOut: boolean;
  readonly user: MockedUser | null;
} {
  if (options.auth === null) {
    return {
      organization: { activeOrg: null, memberships: [] },
      session: null,
      signedOut: true,
      user: null,
    };
  }

  return {
    organization: options.auth?.organization ?? DEFAULT_ORGANIZATION,
    session:
      options.auth?.session === undefined
        ? DEFAULT_SESSION
        : options.auth.session,
    signedOut: false,
    user: options.auth?.user ?? DEFAULT_USER,
  };
}

async function setupPageAsync(
  options: SetupPageOptions,
  signal: AbortSignal,
  pageRendered: () => void,
): Promise<void> {
  ensureTestLocalStorage();
  applyPageEnvironment(options.env, signal);
  await initializeI18nWithResources(
    await loadInitialLocaleResources(options.locale ?? DEFAULT_LOCALE, signal),
    signal,
  );
  signal.throwIfAborted();
  // setupPage exercises the shared MSW fixture data even when a test does not
  // customize a handler. Start the lazy mock lifecycle so abort resets any
  // fixture mutations made by the application during this test.
  const { mocks, store, workerStore } = options.context;
  if (options.locale) {
    mocks.data.userPreferences({
      locale: options.locale,
      supportedLocales: [...SUPPORTED_LOCALES],
    });
  }
  const initialUrl = initialPageUrl(options.path, options.host ?? "localhost");
  mocks.browser.url(initialUrl.toString());
  // Browser navigation and Clerk outlive the app during an account switch.
  createPushStateMock(options.context.signal, initialUrl);
  installClerkBootstrap(
    initialUrl,
    options.clerkBootstrap,
    options.context.signal,
  );

  if (options.debugLoggers) {
    store.set(
      setDebugLoggerLocalStorage$,
      JSON.stringify(options.debugLoggers ?? []),
    );
  }

  const auth = resolveAuth(options);
  const clerk = mocks.clerk();
  const activeOrgId = auth.organization.activeOrg?.id ?? null;
  const featureSwitchOverrides = { ...options.featureSwitches };
  if (options.featureSwitches) {
    setMockFeatureSwitches(featureSwitchOverrides);
  }
  clerk.sessionSignedOut(auth.signedOut);
  clerk.user(auth.user, auth.session);
  clerk.organization(auth.organization);
  const user = auth.user;
  if (user) {
    mocks.api(authContract.me, ({ respond }) => {
      return respond(200, {
        userId: user.id,
        email: user.email ?? "test@example.com",
        orgId: activeOrgId ?? null,
      });
    });
  }
  store.set(
    setupSharedWorkerTestBootstrap$,
    {
      appVersion: options.sharedWorkerAppVersion ?? TEST_APP_VERSION,
      workerStore,
      cachedChatThreadEvents: options.cachedChatThreadEvents,
      identity:
        auth.user && activeOrgId
          ? { userId: auth.user.id, orgId: activeOrgId }
          : null,
      transport: options.sharedWorkerTestTransport ?? "direct",
    },
    signal,
  );
  signal.addEventListener(
    "abort",
    () => {
      toast.dismiss();
    },
    { once: true },
  );

  // Not wrapped in act() — background polling loops would cause act() to
  // hang indefinitely waiting for them to settle. React "not wrapped in
  // act" warnings are suppressed in setup.ts.
  signal.throwIfAborted();
  const runtime = store.set(
    bootstrap$,
    options.appVersion ?? TEST_APP_VERSION,
    () => {
      setupRouter(store, (element) => {
        const { unmount } = render(element);
        pageRendered();
        signal.addEventListener("abort", unmount, {
          once: true,
        });
      });
    },
    signal,
  );
  detach(
    runtime.sharedDatabaseDaemon,
    Reason.Daemon,
    "test shared database daemon",
  );
  detach(
    runtime.authenticatedRealtimeDaemon,
    Reason.Daemon,
    "test authenticated realtime daemon",
  );
  detach(runtime.clerkIdentityDaemon, Reason.Daemon, "test clerk identity");
  detach(runtime.ready, Reason.Entrance, "test page readiness");
}

function waitForFirstPageContent(signal: AbortSignal): {
  readonly pageRendered: () => void;
  readonly ready: Promise<void>;
} {
  let pageHasRendered = false;
  let skeletonHasMounted = false;
  // Some startPage callers inspect blocked startup without awaiting ready.
  // The deferred owns their cancellation rejection as well as awaited ones.
  const ready = createDeferredPromise<void>(signal);

  const observer = new MutationObserver(checkPageContent);

  function dispose(): void {
    observer.disconnect();
    signal.removeEventListener("abort", dispose);
  }

  function checkPageContent(): void {
    if (ready.settled()) {
      return;
    }
    const skeleton = document.querySelector('[data-testid="app-skeleton"]');
    skeletonHasMounted ||= skeleton !== null;
    if (
      pageHasRendered &&
      skeletonHasMounted &&
      (skeleton === null || skeleton.getAttribute("aria-hidden") === "true")
    ) {
      dispose();
      ready.resolve();
    }
  }

  observer.observe(document.body, {
    attributeFilter: ["aria-hidden"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  signal.addEventListener("abort", dispose, { once: true });
  checkPageContent();

  return {
    pageRendered: () => {
      pageHasRendered = true;
      checkPageContent();
    },
    ready: ready.promise,
  };
}

interface StartedPage {
  readonly ready: Promise<void>;
}

export async function startPage(
  options: SetupPageOptions,
): Promise<StartedPage> {
  // testContext rotates its signal at teardown; async startup belongs to the
  // lifetime that initiated it, never the next test's context.
  const rootSignal = window._okou?.rootSignal;
  if (!rootSignal) {
    throw new Error("Platform lifecycle was not initialized");
  }
  const signal = AbortSignal.any([options.context.signal, rootSignal]);
  signal.throwIfAborted();
  const content = waitForFirstPageContent(signal);
  await setupPageAsync(options, signal, content.pageRendered);
  signal.throwIfAborted();
  return { ready: content.ready };
}

export async function setupPage(options: SetupPageOptions): Promise<void> {
  const signal = options.context.signal;
  const page = await startPage(options);
  await page.ready;
  signal.throwIfAborted();
}

// Helper to create a browser history mock that updates mockLocation.
function createPushStateMock(signal: AbortSignal, initialUrl: URL): void {
  interface HistoryEntry {
    readonly data: unknown;
    readonly url: URL;
  }

  const entries: HistoryEntry[] = [{ data: null, url: initialUrl }];
  let currentEntryIndex = 0;
  let currentUrl = initialUrl;
  const replaceBrowserUrl = window.history.replaceState.bind(window.history);

  const resolveUrl = (url?: string | URL | null) => {
    return url === undefined || url === null
      ? currentUrl
      : new URL(url.toString(), currentUrl);
  };

  const updateLocation = (entry: HistoryEntry) => {
    currentUrl = entry.url;
    if (entry.url.origin === window.location.origin) {
      replaceBrowserUrl(entry.data, "", entry.url);
    } else {
      window.location.href = entry.url.toString();
    }
    setPathname(entry.url.pathname, signal);
    setSearch(entry.url.search, signal);
    setHash(entry.url.hash, signal);
  };

  updateLocation(entries[0]);

  const fn = vi
    .spyOn(window.history, "pushState")
    .mockImplementation(
      (data: unknown, _unused: string, url?: string | URL | null) => {
        const entry = { data, url: resolveUrl(url) };
        entries.splice(currentEntryIndex + 1);
        entries.push(entry);
        currentEntryIndex = entries.length - 1;
        updateLocation(entry);
      },
    );
  mockPushState(fn, signal);

  const replaceFn = vi
    .spyOn(window.history, "replaceState")
    .mockImplementation(
      (data: unknown, _unused: string, url?: string | URL | null) => {
        const entry = { data, url: resolveUrl(url) };
        if (currentEntryIndex === -1) {
          entries.push(entry);
          currentEntryIndex = 0;
        } else {
          entries[currentEntryIndex] = entry;
        }
        updateLocation(entry);
      },
    );
  mockReplaceState(replaceFn, signal);

  vi.spyOn(window.history, "back").mockImplementation(() => {
    if (currentEntryIndex <= 0) {
      return;
    }
    currentEntryIndex -= 1;
    const entry = entries[currentEntryIndex];
    if (!entry) {
      return;
    }
    updateLocation(entry);
    window.dispatchEvent(new PopStateEvent("popstate", { state: entry.data }));
  });
}

/**
 * Fast input helper: selects all existing content then types the new value.
 * Uses `delay: null` to skip per-keystroke timeouts — same events, zero delay.
 * Use this instead of `user.clear() + user.type()`.
 */
export async function fill(element: Element, value: string): Promise<void> {
  const fastUser = userEvent.setup({ delay: null });
  const editableElement =
    element.getAttribute("contenteditable") === "true"
      ? element
      : (element.querySelector('[contenteditable="true"]') ?? element);
  await fastUser.click(editableElement);
  await fastUser.keyboard("{Control>}a{/Control}");
  if (value) {
    await fastUser.paste(value);
  } else {
    await fastUser.keyboard("{Backspace}");
  }
}

/**
 * Fire a click on `element` that works for both regular buttons and headless UI
 * triggers (Dropdown/Select/Popover open on `pointerdown`, not `click`).
 *
 * Roughly 3x faster than `userEvent.click(el)` in happy-dom because it skips
 * the full pointer-event simulation (pointermove, hover, focus tracking)
 * that userEvent runs. Dispatches `pointerdown` + `click` only.
 */
export function click(element: Element): void {
  fireEvent.pointerDown(element, { button: 0 });
  fireEvent.click(element);
}

/**
 * Keep a rendered element's CSS transition or animation pending until the
 * returned callback runs. happy-dom does not implement Web Animations, so Base
 * UI otherwise completes exits immediately instead of retaining visible content.
 */
export function holdElementAnimations(element: Element): () => void {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  Object.defineProperty(element, "getAnimations", {
    configurable: true,
    value: () => {
      return [{ finished }];
    },
  });
  return finish;
}

/**
 * Text-content ARIA roles — roles whose accessible name is derived from a
 * subtree text walk, so `*ByRole(role)` from @testing-library pays for an
 * O(documentSize) ARIA tree traversal even without `{ name }`. Profiling
 * showed `screen.getAllByRole("button")` taking ~360ms on the /connectors
 * page with only 5 buttons rendered.
 */
type TextContentRole =
  | "button"
  | "combobox"
  | "link"
  | "menuitem"
  | "menuitemcheckbox"
  | "menuitemradio"
  | "radio"
  | "option"
  | "tab"
  | "cell"
  | "columnheader"
  | "rowheader"
  | "gridcell";

const ROLE_SELECTORS: Record<TextContentRole, string> = {
  button: 'button, [role="button"]',
  combobox: 'select, [role="combobox"]',
  link: 'a[href], [role="link"]',
  menuitem: '[role="menuitem"]',
  menuitemcheckbox: '[role="menuitemcheckbox"]',
  menuitemradio: '[role="menuitemradio"]',
  // Base UI's Radio puts the role on the visible element and renders a
  // separate 1x1 input for form submission, so the role selector alone is
  // the visible control.
  radio: '[role="radio"]',
  option: 'option, [role="option"]',
  tab: '[role="tab"]',
  cell: 'td, [role="cell"]',
  // Plain <th> inside <thead> has implicit role="columnheader"; a <th
  // scope="row"> is a rowheader, so exclude it here to match
  // @testing-library/dom's role disambiguation.
  columnheader: 'th:not([scope="row"]), [role="columnheader"]',
  rowheader: 'th[scope="row"], [role="rowheader"]',
  gridcell: '[role="gridcell"]',
};

/**
 * Element is hidden from the accessibility tree — used to match the default
 * `getAllByRole(role, { hidden: false })` behaviour from
 * `@testing-library/dom`, which excludes ancestors flagged with
 * `aria-hidden="true"`, the `hidden` attribute, or `inert`. Modal overlays
 * commonly leave background portals mounted with `aria-hidden`; matching
 * those would inflate counts vs. the original role queries.
 */
function isAccessibilityHidden(element: Element): boolean {
  return element.closest('[aria-hidden="true"], [hidden], [inert]') !== null;
}

/**
 * Fast role lookup that returns the same elements as
 * `getAllByRole(role)` for text-content roles, without the ARIA tree walk
 * `@testing-library/dom` performs. Use this anywhere you'd otherwise call
 * `screen.getAllByRole("button").find(el => /label/.test(el.textContent))`
 * or `within(container).getAllByRole("link")`.
 *
 * The native tag is the primary lookup; the `[role="…"]` fallback covers
 * elements that override their role explicitly. Elements inside an
 * `aria-hidden`, `hidden`, or `inert` subtree are filtered out to match the
 * default `getAllByRole` visibility semantics.
 */
export function queryAllByRoleFast(
  role: TextContentRole,
  container: ParentNode = document.body,
): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(ROLE_SELECTORS[role]),
  ).filter((el) => {
    return !isAccessibilityHidden(el);
  });
}
