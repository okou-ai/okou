import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
import { HttpResponse } from "msw";
import { posthog } from "posthog-js/dist/module.slim";
import { vi } from "vitest";

import {
  clearMockedAuthOnAbort,
  emitMockedClerkEvent,
  mockClerkLoaded,
  mockClerkSessionSignedOut,
  mockedClerk,
  mockedClerkLoad,
  mockedClerkStatusListenerCount,
  mockOrganization,
  mockUser,
  type MockedClerkLoadOptions,
} from "../../__tests__/mock-auth.ts";
import {
  clerkLocalizationFixtureForRequest,
  type ClerkLocalizationLocale,
} from "../../mocks/handlers/clerk-localizations.ts";
import {
  resetMockClerkAuthComponentMounted,
  setMockClerkAuthComponentMounted,
} from "../../test/mocks/clerk-react.ts";
import { mockClerkResource } from "../../test/mocks/clerk-resource.ts";
import {
  mockSentry,
  type SentryMock,
} from "../../test/mocks/sentry-behavior.ts";
import {
  deferNextAblySubscribe,
  getAuthTokenHistory,
  hasChannelSubscription,
  hasChannelSubscriptionOnChannel,
  hasSharedDatabaseSubscription,
  hasSubscription,
  hasSubscriptionOnChannel,
  rejectAblySubscribe,
  rejectNextAblySubscribe,
  triggerAblyConnectionState,
  triggerAblyChannelEvent,
  triggerAblyConnectionClosed,
  triggerAblyEvent,
  triggerAblyFailure,
  triggerAblyReauth,
  triggerAblyReconnect,
  triggerAblyResume,
  triggerSharedWorkerAblyConnectionState,
  triggerSharedWorkerAblyFailure,
  triggerSharedWorkerAblyReconnect,
} from "../../mocks/ably.ts";
import { setMockAgents } from "../../mocks/handlers/api-agents.ts";
import { setMockRedeemResponse } from "../../mocks/handlers/api-billing.ts";
import { setMockConnectors } from "../../mocks/handlers/api-connectors.ts";
import { setMockAgentPhoneIntegration } from "../../mocks/handlers/api-integrations-agentphone.ts";
import {
  createDefaultMockGithubIntegration,
  setMockGithubIntegration,
} from "../../mocks/handlers/api-integrations-github.ts";
import { setMockTelegramIntegration } from "../../mocks/handlers/api-integrations-telegram.ts";
import { setMockOnboardingStatus } from "../../mocks/handlers/api-onboarding.ts";
import { setMockOrg } from "../../mocks/handlers/api-org.ts";
import { setMockOrgMembers } from "../../mocks/handlers/api-org-members.ts";
import { setMockOrgModelPolicies } from "../../mocks/handlers/api-org-model-policies.ts";
import { setMockOrgModelProviders } from "../../mocks/handlers/api-org-model-providers.ts";
import { setMockPersonalModelProviders } from "../../mocks/handlers/api-personal-model-providers.ts";
import { setMockUserModelPreference } from "../../mocks/handlers/api-user-model-preference.ts";
import { setMockUserPreferences } from "../../mocks/handlers/api-user-preferences.ts";
import {
  createMockApi,
  createMockHttp,
  type HttpResolverWithContext,
  type MockHandler,
  type SignalContextLike,
} from "../../mocks/msw-contract.ts";
import { server } from "../../mocks/server.ts";
import {
  mockUploadPending,
  mockUploadSuccess,
} from "../../mocks/upload-helpers.ts";
import { createDeferredPromise } from "../utils.ts";

interface WindowOpenCall {
  url: string | null;
  target: string | null;
  features: string | null;
}

interface BrowserOpenMock {
  calls: WindowOpenCall[];
  openedWindow: Window | null;
}

interface BrowserUrlOptions {
  readonly apiOriginMarker?: string | null;
}

interface CanvasRender {
  readonly background: string;
  readonly height: number;
  readonly width: number;
}

interface CanvasClipCircle {
  readonly centerX: number;
  readonly centerY: number;
  readonly endAngle: number;
  readonly radius: number;
  readonly startAngle: number;
}

interface CanvasImageDraw {
  readonly height: number | undefined;
  readonly width: number | undefined;
  readonly x: number;
  readonly y: number;
}

interface CanvasRenderingMock {
  readonly clipCircles: CanvasClipCircle[];
  readonly imageDraws: CanvasImageDraw[];
  readonly renders: CanvasRender[];
}

interface BrowserFedCmOptions {
  readonly credentials?: boolean;
  readonly identityCredential?: boolean;
  readonly secureContext?: boolean;
}

interface BrowserWebAuthnOptions {
  readonly credentials?: boolean;
  readonly platformAuthenticatorResult?: boolean | "error";
  readonly publicKeyCredential?: boolean;
  readonly secureContext?: boolean;
}

interface LocationAssignMock {
  calls: string[];
}

interface LocationReplaceMock {
  calls: string[];
}

interface ClipboardWriteMock {
  writes: string[];
}

interface ClipboardRichWriteMock {
  writes: ClipboardItem[][];
  rejectWith: (error: Error) => void;
}

interface ClipboardExecCommandMock {
  writes: Record<string, string>[];
}

interface BrowserDownload {
  readonly url: string;
  readonly filename: string;
  readonly blob: Blob | null;
}

interface BrowserDownloadMock {
  readonly blobForUrl: (url: string) => Blob | null;
  readonly downloads: BrowserDownload[];
  readonly revokedUrls: string[];
}

interface BrowserServiceWorkerMock {
  readonly dispatchMessage: (data: unknown) => void;
}

interface BrowserMatchMediaMock {
  readonly setMatches: (
    matches: boolean | ((query: string) => boolean),
  ) => void;
}

interface BrowserVisibilityStateMock {
  readonly changeTo: (visibilityState: DocumentVisibilityState) => void;
}

interface ImageDimensionsMockValue {
  width: number;
  height: number;
}

type ImageDimensionsMockResult = ImageDimensionsMockValue | null | "pending";

interface ImageDimensionsMock {
  readonly createdUrls: string[];
  readonly revokedUrls: string[];
}

interface MockWindow extends Window {
  closed: boolean;
  close: () => void;
}

interface PostHogEvent {
  readonly name: Parameters<typeof posthog.capture>[0];
  readonly properties: Parameters<typeof posthog.capture>[1];
  readonly options: Parameters<typeof posthog.capture>[2];
}

interface PostHogInitialization {
  readonly key: Parameters<typeof posthog.init>[0];
  readonly config: Parameters<typeof posthog.init>[1];
}

interface PostHogIdentification {
  readonly distinctId: Parameters<typeof posthog.identify>[0];
  readonly properties: Parameters<typeof posthog.identify>[1];
  readonly propertiesOnce: Parameters<typeof posthog.identify>[2];
}

interface PostHogMock {
  readonly events: PostHogEvent[];
  readonly identifications: PostHogIdentification[];
  readonly initializations: PostHogInitialization[];
}

interface ClerkResourceRequest {
  readonly publishableKey: string;
}

interface ClerkMock {
  /**
   * Keeps the hosted Clerk components in their loading fallback until the
   * returned `mount` runs, the way a slow hosted UI script would.
   */
  readonly deferAuthComponentMount: () => { readonly mount: () => void };
  readonly loads: readonly (MockedClerkLoadOptions | undefined)[];
  readonly localizationRequests: ClerkLocalizationLocale[];
  readonly resourceRequests: ClerkResourceRequest[];
  /**
   * Hosted UI script requests; only auth pages and account switching add one.
   */
  readonly uiRequests: string[];
  /** Clerk `status` handlers the SDK still holds, so leaks stay observable. */
  readonly statusListenerCount: () => number;
  readonly loaded: (loaded: boolean) => void;
  readonly localizationUnavailable: (locale: ClerkLocalizationLocale) => void;
  readonly organization: (...args: Parameters<typeof mockOrganization>) => void;
  readonly resourcePending: () => ReturnType<
    typeof createDeferredPromise<void>
  >;
  readonly resourceUnavailable: (error?: Error) => void;
  readonly runtimePending: () => ReturnType<typeof createDeferredPromise<void>>;
  readonly stateChanged: () => void;
  readonly sessionSignedOut: (
    ...args: Parameters<typeof mockClerkSessionSignedOut>
  ) => void;
  readonly user: (...args: Parameters<typeof mockUser>) => void;
}

type OmitFirst<T extends readonly unknown[]> = T extends readonly [
  unknown,
  ...infer Rest,
]
  ? Rest
  : never;

/**
 * Every page test now runs on an okou.ai host, where the theme preference is
 * persisted in a cookie. happy-dom keeps cookies for the whole file, so clear
 * them whenever a test navigates to a new page.
 */
function clearBrowserCookies(): void {
  const domainAttributes = new Set<string>([""]);
  const labels = window.location.hostname.split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    domainAttributes.add(`; Domain=.${labels.slice(index).join(".")}`);
  }
  for (const entry of document.cookie.split(";")) {
    const name = entry.split("=")[0]?.trim();
    if (!name) {
      continue;
    }
    for (const domainAttribute of domainAttributes) {
      // oxlint-disable-next-line unicorn/no-document-cookie -- expiring a cookie requires the document setter.
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure${domainAttribute}`;
    }
  }
}

export function createTestMocks(getSignal: () => AbortSignal) {
  let originalBrowserUrl: string | null = null;
  let ownedApiOriginMarker: HTMLMetaElement | null = null;
  let clerkMock: ClerkMock | null = null;
  let postHogMock: PostHogMock | null = null;
  let sentryMock: SentryMock | null = null;
  const signalContext: SignalContextLike = {
    get signal() {
      return getSignal();
    },
  };
  const mockApi = createMockApi(signalContext);
  const mockHttp = createMockHttp(signalContext);

  return {
    api: <R extends AppRoute>(route: R, handler: MockHandler<R>) => {
      server.use(mockApi(route, handler));
    },
    http: {
      get: (
        path: Parameters<typeof mockHttp.get>[0],
        resolver: HttpResolverWithContext,
      ) => {
        server.use(mockHttp.get(path, resolver));
      },
      post: (
        path: Parameters<typeof mockHttp.post>[0],
        resolver: HttpResolverWithContext,
      ) => {
        server.use(mockHttp.post(path, resolver));
      },
      put: (
        path: Parameters<typeof mockHttp.put>[0],
        resolver: HttpResolverWithContext,
      ) => {
        server.use(mockHttp.put(path, resolver));
      },
      patch: (
        path: Parameters<typeof mockHttp.patch>[0],
        resolver: HttpResolverWithContext,
      ) => {
        server.use(mockHttp.patch(path, resolver));
      },
      delete: (
        path: Parameters<typeof mockHttp.delete>[0],
        resolver: HttpResolverWithContext,
      ) => {
        server.use(mockHttp.delete(path, resolver));
      },
    },
    data: {
      agents: (...args: Parameters<typeof setMockAgents>) => {
        setMockAgents(...args);
      },
      org: (...args: Parameters<typeof setMockOrg>) => {
        setMockOrg(...args);
      },
      orgMembers: (...args: Parameters<typeof setMockOrgMembers>) => {
        setMockOrgMembers(...args);
      },
      connectors: (...args: Parameters<typeof setMockConnectors>) => {
        setMockConnectors(...args);
      },
      userPreferences: (...args: Parameters<typeof setMockUserPreferences>) => {
        setMockUserPreferences(...args);
      },
      userModelPreference: (
        ...args: Parameters<typeof setMockUserModelPreference>
      ) => {
        setMockUserModelPreference(...args);
      },
      redeemResponse: (...args: Parameters<typeof setMockRedeemResponse>) => {
        setMockRedeemResponse(...args);
      },
      githubIntegration: (
        ...args: Parameters<typeof setMockGithubIntegration>
      ) => {
        setMockGithubIntegration(...args);
      },
      defaultGithubIntegration: createDefaultMockGithubIntegration,
      agentPhoneIntegration: (
        ...args: Parameters<typeof setMockAgentPhoneIntegration>
      ) => {
        setMockAgentPhoneIntegration(...args);
      },
      telegramIntegration: (
        ...args: Parameters<typeof setMockTelegramIntegration>
      ) => {
        setMockTelegramIntegration(...args);
      },
      orgModelProviders: (
        ...args: Parameters<typeof setMockOrgModelProviders>
      ) => {
        setMockOrgModelProviders(...args);
      },
      orgModelPolicies: (
        ...args: Parameters<typeof setMockOrgModelPolicies>
      ) => {
        setMockOrgModelPolicies(...args);
      },
      personalModelProviders: (
        ...args: Parameters<typeof setMockPersonalModelProviders>
      ) => {
        setMockPersonalModelProviders(...args);
      },
      onboardingStatus: (
        ...args: Parameters<typeof setMockOnboardingStatus>
      ) => {
        setMockOnboardingStatus(...args);
      },
    },
    browser: {
      url: (url: string, options: BrowserUrlOptions = {}): void => {
        if (originalBrowserUrl === null) {
          originalBrowserUrl = window.location.href;
          restoreOnAbort(getSignal(), () => {
            ownedApiOriginMarker?.remove();
            ownedApiOriginMarker = null;
            if (originalBrowserUrl !== null) {
              window.location.href = originalBrowserUrl;
              originalBrowserUrl = null;
            }
          });
        }
        window.location.href = url;
        clearBrowserCookies();
        ownedApiOriginMarker?.remove();
        ownedApiOriginMarker = null;

        const markerContent =
          options.apiOriginMarker === undefined
            ? productionApiOriginForUrl(url)
            : options.apiOriginMarker;
        if (markerContent !== null) {
          ownedApiOriginMarker = document.createElement("meta");
          ownedApiOriginMarker.name = "okou-api-origin";
          ownedApiOriginMarker.content = markerContent;
          document.head.append(ownedApiOriginMarker);
        }
      },
      open: (openedWindow: Window | null = null): BrowserOpenMock => {
        return mockWindowOpen(openedWindow);
      },
      locationAssign: (): LocationAssignMock => {
        return mockLocationAssign();
      },
      locationReplace: (): LocationReplaceMock => {
        return mockLocationReplace();
      },
      authWindow: (): MockWindow => {
        return createMockWindow();
      },
      matchMedia: (
        matches: boolean | ((query: string) => boolean),
      ): BrowserMatchMediaMock => {
        return mockMatchMedia(matches);
      },
      standaloneDisplayMode: (enabled: boolean): void => {
        mockMatchMedia((query) => {
          return query === "(display-mode: standalone)" ? enabled : false;
        });
      },
      serviceWorker: (): BrowserServiceWorkerMock => {
        return mockServiceWorker(getSignal());
      },
      userAgent: (ua: string): void => {
        vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
      },
      fedCm: (options: BrowserFedCmOptions = {}): void => {
        const secureContextDescriptor = defineWindowProperty(
          window,
          "isSecureContext",
          options.secureContext ?? true,
        );
        const credentialsDescriptor = defineWindowProperty(
          navigator,
          "credentials",
          options.credentials === false
            ? undefined
            : {
                get: () => {
                  return Promise.resolve(null);
                },
              },
        );
        const identityCredentialDescriptor = defineWindowProperty(
          window,
          "IdentityCredential",
          options.identityCredential === false
            ? undefined
            : class TestIdentityCredential {},
        );
        restoreOnAbort(getSignal(), () => {
          restoreWindowProperty(
            window,
            "isSecureContext",
            secureContextDescriptor,
          );
          restoreWindowProperty(
            navigator,
            "credentials",
            credentialsDescriptor,
          );
          restoreWindowProperty(
            window,
            "IdentityCredential",
            identityCredentialDescriptor,
          );
        });
      },
      webAuthn: (options: BrowserWebAuthnOptions = {}): void => {
        const platformAuthenticatorResult = options.platformAuthenticatorResult;
        const secureContextDescriptor = defineWindowProperty(
          window,
          "isSecureContext",
          options.secureContext ?? true,
        );
        const credentialsDescriptor = defineWindowProperty(
          navigator,
          "credentials",
          options.credentials === false
            ? undefined
            : {
                get: () => {
                  return Promise.resolve(null);
                },
              },
        );
        const publicKeyCredential =
          options.publicKeyCredential === false
            ? undefined
            : platformAuthenticatorResult === undefined
              ? class TestPublicKeyCredential {}
              : class TestPublicKeyCredential {
                  static isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean> {
                    return platformAuthenticatorResult === "error"
                      ? Promise.reject(
                          new Error("Platform authenticator check failed"),
                        )
                      : Promise.resolve(platformAuthenticatorResult);
                  }
                };
        const publicKeyCredentialDescriptor = defineWindowProperty(
          window,
          "PublicKeyCredential",
          publicKeyCredential,
        );
        restoreOnAbort(getSignal(), () => {
          restoreWindowProperty(
            window,
            "isSecureContext",
            secureContextDescriptor,
          );
          restoreWindowProperty(
            navigator,
            "credentials",
            credentialsDescriptor,
          );
          restoreWindowProperty(
            window,
            "PublicKeyCredential",
            publicKeyCredentialDescriptor,
          );
        });
      },
      platform: (platform: string): void => {
        vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      },
      maxTouchPoints: (maxTouchPoints: number): void => {
        vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(
          maxTouchPoints,
        );
      },
      language: (language: string): void => {
        vi.spyOn(navigator, "language", "get").mockReturnValue(language);
        vi.spyOn(navigator, "languages", "get").mockReturnValue([language]);
      },
      languages: (languages: readonly string[]): void => {
        vi.spyOn(navigator, "languages", "get").mockReturnValue([...languages]);
      },
      visibilityState: (
        visibilityState: DocumentVisibilityState,
      ): BrowserVisibilityStateMock => {
        const descriptor = defineWindowProperty(
          document,
          "visibilityState",
          visibilityState,
        );
        restoreOnAbort(getSignal(), () => {
          restoreWindowProperty(document, "visibilityState", descriptor);
        });
        return {
          changeTo(nextVisibilityState): void {
            defineWindowProperty(
              document,
              "visibilityState",
              nextVisibilityState,
            );
            document.dispatchEvent(new Event("visibilitychange"));
          },
        };
      },
      cookie: (cookie: string): void => {
        vi.spyOn(document, "cookie", "get").mockReturnValue(cookie);
      },
      clipboardWriteText: (): ClipboardWriteMock => {
        return mockClipboardWriteText();
      },
      clipboardWrite: (): ClipboardRichWriteMock => {
        return mockClipboardWrite();
      },
      clipboardExecCommand: (): ClipboardExecCommandMock => {
        return mockClipboardExecCommand(getSignal());
      },
      blobDownload: (): BrowserDownloadMock => {
        return mockBlobDownload(getSignal());
      },
      audioContext: (): void => {
        mockAudioContext(getSignal());
      },
      voiceInput: (options?: VoiceInputMockOptions): void => {
        mockVoiceInput(getSignal(), options);
      },
      imageDimensions: (
        results:
          | ImageDimensionsMockResult
          | readonly ImageDimensionsMockResult[],
      ): ImageDimensionsMock => {
        return mockImageDimensions(getSignal(), results);
      },
      requestCacheMode: (): void => {
        mockRequestCacheMode(getSignal());
      },
      canvasRendering: (): CanvasRenderingMock => {
        return mockCanvasRendering(getSignal());
      },
      indexedDbUnavailable: (): void => {
        const open = vi
          .spyOn(globalThis.indexedDB, "open")
          .mockImplementation(() => {
            throw new DOMException(
              "IndexedDB is unavailable",
              "InvalidStateError",
            );
          });
        restoreOnAbort(getSignal(), () => {
          open.mockRestore();
        });
      },
    },
    clerk: (): ClerkMock => {
      clerkMock ??= mockClerk(getSignal(), mockHttp);
      return clerkMock;
    },
    posthog: (): PostHogMock => {
      postHogMock ??= mockPostHog(getSignal());
      return postHogMock;
    },
    sentry: (): SentryMock => {
      sentryMock ??= mockSentry(getSignal());
      return sentryMock;
    },
    upload: {
      success: (...args: Parameters<typeof mockUploadSuccess>) => {
        server.use(...mockUploadSuccess(...args));
      },
      pending: (...args: OmitFirst<Parameters<typeof mockUploadPending>>) => {
        server.use(...mockUploadPending(signalContext, ...args));
      },
    },
    ably: {
      deferNextSubscribe: () => {
        return deferNextAblySubscribe(getSignal());
      },
      trigger: triggerAblyEvent,
      triggerOnChannel: triggerAblyChannelEvent,
      triggerConnectionState: triggerAblyConnectionState,
      triggerFailure: triggerAblyFailure,
      triggerReconnect: triggerAblyReconnect,
      triggerResume: triggerAblyResume,
      triggerSharedWorkerConnectionState:
        triggerSharedWorkerAblyConnectionState,
      triggerSharedWorkerFailure: triggerSharedWorkerAblyFailure,
      triggerSharedWorkerReconnect: triggerSharedWorkerAblyReconnect,
      triggerReauth: triggerAblyReauth,
      triggerConnectionClosed: triggerAblyConnectionClosed,
      rejectSubscribe: (topic: string, message: string) => {
        return rejectAblySubscribe(topic, message, getSignal());
      },
      rejectNextSubscribe: rejectNextAblySubscribe,
      hasChannelSubscription,
      hasChannelSubscriptionOnChannel,
      hasSharedDatabaseSubscription,
      hasSubscription,
      hasSubscriptionOnChannel,
      getAuthTokenHistory,
    },
    deferred: <T>() => {
      return createDeferredPromise<T>(getSignal());
    },
  };
}

export type TestMocks = ReturnType<typeof createTestMocks>;

function mockClerk(
  signal: AbortSignal,
  mockHttp: ReturnType<typeof createMockHttp>,
): ClerkMock {
  const localizationRequests: ClerkLocalizationLocale[] = [];
  const unavailableLocalizations = new Set<ClerkLocalizationLocale>();
  const resource = mockClerkResource(signal);
  const originalClerk = Reflect.get(globalThis, "Clerk");
  const hadOriginalClerk = Reflect.has(globalThis, "Clerk");

  server.use(
    mockHttp.get(/\/clerk-localizations\/[^/]+\.json$/u, ({ request }) => {
      const fixture = clerkLocalizationFixtureForRequest(request.url);
      if (!fixture) {
        return new HttpResponse(null, { status: 404 });
      }
      localizationRequests.push(fixture.locale);
      if (unavailableLocalizations.has(fixture.locale)) {
        return new HttpResponse(null, { status: 503 });
      }
      return HttpResponse.json(fixture.localization);
    }),
  );

  clearMockedAuthOnAbort(signal);
  restoreOnAbort(signal, () => {
    if (hadOriginalClerk && originalClerk !== mockedClerk) {
      Reflect.set(globalThis, "Clerk", originalClerk);
    } else {
      Reflect.deleteProperty(globalThis, "Clerk");
    }
  });

  return {
    deferAuthComponentMount() {
      setMockClerkAuthComponentMounted(false);
      restoreOnAbort(signal, resetMockClerkAuthComponentMounted);
      return {
        mount: () => {
          setMockClerkAuthComponentMounted(true);
        },
      };
    },
    get loads() {
      return mockedClerkLoad.mock.calls.map(([options]) => {
        if (!options) {
          return options;
        }
        // The hosted UI handle is a pending promise; `uiRequests` reports
        // whether the UI script itself was requested.
        const loadOptions: MockedClerkLoadOptions = { ...options };
        delete loadOptions.routerPush;
        delete loadOptions.routerReplace;
        delete loadOptions.ui;
        return loadOptions;
      });
    },
    localizationRequests,
    resourceRequests: resource.requests,
    uiRequests: resource.uiRequests,
    statusListenerCount: mockedClerkStatusListenerCount,
    loaded: mockClerkLoaded,
    localizationUnavailable(locale): void {
      unavailableLocalizations.add(locale);
    },
    organization: mockOrganization,
    resourcePending() {
      return resource.pending();
    },
    resourceUnavailable(
      error = new Error("Clerk resource is unavailable"),
    ): void {
      resource.unavailable(error);
    },
    runtimePending() {
      const deferred = createDeferredPromise<void>(signal);
      mockedClerkLoad.mockReturnValue(deferred.promise);
      return deferred;
    },
    sessionSignedOut: mockClerkSessionSignedOut,
    stateChanged: emitMockedClerkEvent,
    user: mockUser,
  };
}

function mockPostHog(signal: AbortSignal): PostHogMock {
  const events: PostHogEvent[] = [];
  const identifications: PostHogIdentification[] = [];
  const initializations: PostHogInitialization[] = [];
  const capture = vi
    .spyOn(posthog, "capture")
    .mockImplementation((name, properties, options) => {
      events.push({ name, properties, options });
      return undefined;
    });
  const identify = vi
    .spyOn(posthog, "identify")
    .mockImplementation((distinctId, properties, propertiesOnce) => {
      identifications.push({ distinctId, properties, propertiesOnce });
    });
  const init = vi.spyOn(posthog, "init").mockImplementation((key, config) => {
    initializations.push({ key, config });
    return posthog;
  });
  const register = vi.spyOn(posthog, "register").mockImplementation(() => {});
  const reset = vi.spyOn(posthog, "reset").mockImplementation(() => {});
  const unregister = vi
    .spyOn(posthog, "unregister")
    .mockImplementation(() => {});

  restoreOnAbort(signal, () => {
    capture.mockRestore();
    identify.mockRestore();
    init.mockRestore();
    register.mockRestore();
    reset.mockRestore();
    unregister.mockRestore();
  });

  return { events, identifications, initializations };
}

function mockWindowOpen(openedWindow: Window | null): BrowserOpenMock {
  const calls: WindowOpenCall[] = [];
  vi.spyOn(window, "open").mockImplementation((url, target, features) => {
    calls.push({
      url: url === undefined ? null : String(url),
      target: target === undefined ? null : target,
      features: features === undefined ? null : features,
    });
    return openedWindow;
  });
  return { calls, openedWindow };
}

function mockLocationAssign(): LocationAssignMock {
  const calls: string[] = [];
  vi.spyOn(window.location, "assign").mockImplementation((url) => {
    calls.push(String(url));
  });
  return { calls };
}

function mockLocationReplace(): LocationReplaceMock {
  const calls: string[] = [];
  vi.spyOn(window.location, "replace").mockImplementation((url) => {
    calls.push(String(url));
  });
  return { calls };
}

function createMockWindow(): MockWindow {
  const mockWindow = {
    closed: false,
    close: () => {
      mockWindow.closed = true;
    },
  } as MockWindow;
  return mockWindow;
}

function mockMatchMedia(
  initialMatches: boolean | ((query: string) => boolean),
): BrowserMatchMediaMock {
  let resolveMatches = (query: string): boolean => {
    return typeof initialMatches === "function"
      ? initialMatches(query)
      : initialMatches;
  };
  const entries = new Set<{
    readonly query: string;
    readonly update: (matches: boolean) => void;
  }>();

  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    let currentMatches = resolveMatches(query);
    const eventTarget = new EventTarget();
    const mediaQueryList: MediaQueryList = {
      get matches() {
        return currentMatches;
      },
      media: query,
      onchange: null,
      addListener: vi.fn<MediaQueryList["addListener"]>(),
      removeListener: vi.fn<MediaQueryList["removeListener"]>(),
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    };
    entries.add({
      query,
      update(matches) {
        if (matches === currentMatches) {
          return;
        }
        currentMatches = matches;
        const event = new MediaQueryListEvent("change", {
          matches,
          media: query,
        });
        mediaQueryList.dispatchEvent(event);
        mediaQueryList.onchange?.call(mediaQueryList, event);
      },
    });
    return mediaQueryList;
  });

  return {
    setMatches(matches) {
      resolveMatches = (query: string): boolean => {
        return typeof matches === "function" ? matches(query) : matches;
      };
      for (const entry of entries) {
        entry.update(resolveMatches(entry.query));
      }
    },
  };
}

function mockServiceWorker(signal: AbortSignal): BrowserServiceWorkerMock {
  const serviceWorker = new EventTarget();
  const descriptor = defineWindowProperty(
    navigator,
    "serviceWorker",
    serviceWorker,
  );
  restoreOnAbort(signal, () => {
    restoreWindowProperty(navigator, "serviceWorker", descriptor);
  });

  return {
    dispatchMessage(data: unknown): void {
      serviceWorker.dispatchEvent(new MessageEvent("message", { data }));
    },
  };
}

function mockClipboardWriteText(): ClipboardWriteMock {
  const writes: string[] = [];
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation((text) => {
    writes.push(text);
    return Promise.resolve();
  });
  return { writes };
}

function mockClipboardWrite(): ClipboardRichWriteMock {
  const writes: ClipboardItem[][] = [];
  let rejection: Error | null = null;
  vi.spyOn(navigator.clipboard, "write").mockImplementation((items) => {
    writes.push(items);
    if (rejection !== null) {
      return Promise.reject(new Error(rejection.message, { cause: rejection }));
    }
    return Promise.resolve();
  });
  return {
    writes,
    rejectWith(error: Error) {
      rejection = error;
    },
  };
}

function mockClipboardExecCommand(
  signal: AbortSignal,
): ClipboardExecCommandMock {
  const writes: Record<string, string>[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string) => {
      if (command !== "copy") {
        return false;
      }
      if (document.getSelection()?.rangeCount === 0) {
        return false;
      }
      const data: Record<string, string> = {};
      const event = new Event("copy", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "clipboardData", {
        value: {
          setData(type: string, value: string) {
            data[type] = value;
          },
        },
      });
      const handled = !document.dispatchEvent(event);
      if (handled) {
        writes.push(data);
      }
      return handled;
    },
  });
  restoreOnAbort(signal, () => {
    if (descriptor) {
      Object.defineProperty(document, "execCommand", descriptor);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
  });
  return { writes };
}

function mockBlobDownload(signal: AbortSignal): BrowserDownloadMock {
  const downloads: BrowserDownload[] = [];
  const revokedUrls: string[] = [];
  const blobs = new Map<string, Blob>();
  let objectUrlIndex = 0;

  const createObjectUrlDescriptor = defineWindowProperty(
    URL,
    "createObjectURL",
    (object: Blob | MediaSource) => {
      objectUrlIndex += 1;
      const url = `blob:mock-download-${objectUrlIndex}`;
      if (object instanceof Blob) {
        blobs.set(url, object);
      }
      return url;
    },
  );
  const revokeObjectUrlDescriptor = defineWindowProperty(
    URL,
    "revokeObjectURL",
    (url: string) => {
      revokedUrls.push(url);
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({
      url: this.href,
      filename: this.download,
      blob: blobs.get(this.href) ?? null,
    });
  });

  restoreOnAbort(signal, () => {
    restoreWindowProperty(URL, "createObjectURL", createObjectUrlDescriptor);
    restoreWindowProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
  });

  return {
    blobForUrl: (url) => {
      return blobs.get(url) ?? null;
    },
    downloads,
    revokedUrls,
  };
}

function mockAudioContext(signal: AbortSignal): void {
  class TestAudioBuffer {
    readonly duration: number;
    private readonly channelData: Float32Array;

    constructor(length: number, sampleRate: number) {
      this.duration = length / sampleRate;
      this.channelData = new Float32Array(length);
    }

    getChannelData(_channel: number): Float32Array {
      return this.channelData;
    }
  }

  class TestAudioBufferSource {
    buffer: AudioBuffer | null = null;

    connect(_destination: AudioDestinationNode): void {}

    start(_when?: number): void {}
  }

  class TestAudioContext {
    readonly currentTime = 0;
    readonly destination = {} as AudioDestinationNode;

    resume(): Promise<void> {
      return Promise.resolve();
    }

    close(): Promise<void> {
      return Promise.resolve();
    }

    createBuffer(
      _numberOfChannels: number,
      length: number,
      sampleRate: number,
    ): AudioBuffer {
      return new TestAudioBuffer(length, sampleRate) as unknown as AudioBuffer;
    }

    createBufferSource(): AudioBufferSourceNode {
      return new TestAudioBufferSource() as unknown as AudioBufferSourceNode;
    }
  }

  const descriptor = defineWindowProperty(
    window,
    "AudioContext",
    TestAudioContext,
  );

  restoreOnAbort(signal, () => {
    restoreWindowProperty(window, "AudioContext", descriptor);
  });
}

interface VoiceInputMockOptions {
  readonly onPcmCapture?: (emit: (samples: Float32Array) => void) => void;
  readonly onPcmPortClose?: () => void;
  readonly onPcmDisconnect?: () => void;
  readonly finalPcmSamples?: Float32Array;
  readonly pcmWorkletReady?: () => Promise<void>;
  readonly audioContextReady?: Promise<void>;
  readonly durationSeconds?: number;
  readonly getUserMediaReady?: Promise<void>;
  readonly onAudioContextClose?: () => void;
  readonly onTrackStop?: () => void;
  readonly rms?: number | readonly number[] | (() => number);
}

function mockVoiceInput(
  signal: AbortSignal,
  options: VoiceInputMockOptions = {},
): void {
  const stream = {
    getTracks: () => {
      return [
        {
          stop: () => {
            options.onTrackStop?.();
          },
        },
      ];
    },
  } as unknown as MediaStream;

  class TestMediaStreamAudioSource {
    connect(destination: AnalyserNode | TestVoiceAudioWorkletNode): void {
      if (destination instanceof TestVoiceAudioWorkletNode) {
        destination.port.startCapture();
      }
    }

    disconnect(destination?: TestVoiceAudioWorkletNode): void {
      if (destination instanceof TestVoiceAudioWorkletNode) {
        options.onPcmDisconnect?.();
      }
    }
  }

  let sampleIndex = 0;

  function nextRms(): number {
    const rms = options.rms;
    if (typeof rms === "function") {
      return rms();
    }
    if (typeof rms === "number") {
      return rms;
    }
    if (rms) {
      const index = Math.min(sampleIndex, rms.length - 1);
      sampleIndex += 1;
      return rms[index] ?? 0;
    }
    return 0;
  }

  class TestAnalyser {
    fftSize = 1024;

    getFloatTimeDomainData(samples: Float32Array<ArrayBuffer>): void {
      samples.fill(nextRms());
    }

    disconnect(): void {}
  }

  class TestVoiceAudioContext {
    readonly audioWorklet = {
      addModule(): Promise<void> {
        return options.pcmWorkletReady?.() ?? Promise.resolve();
      },
    };

    resume(): Promise<void> {
      return options.audioContextReady ?? Promise.resolve();
    }

    close(): Promise<void> {
      options.onAudioContextClose?.();
      return Promise.resolve();
    }

    createMediaStreamSource(_stream: MediaStream): MediaStreamAudioSourceNode {
      return new TestMediaStreamAudioSource() as unknown as MediaStreamAudioSourceNode;
    }

    createAnalyser(): AnalyserNode {
      return new TestAnalyser() as unknown as AnalyserNode;
    }
  }

  class TestVoicePcmPort extends EventTarget {
    private closed = false;

    start(): void {}

    startCapture(): void {
      const emit = (samples: Float32Array) => {
        if (!this.closed) {
          this.dispatchEvent(
            new MessageEvent("message", { data: samples.slice().buffer }),
          );
        }
      };
      if (options.onPcmCapture) {
        options.onPcmCapture(emit);
      } else {
        emit(new Float32Array(4096).fill(0.1));
      }
    }

    close(): void {
      this.closed = true;
      options.onPcmPortClose?.();
    }

    postMessage(message: unknown): void {
      if (message !== "stop" || this.closed) {
        return;
      }
      const samples =
        options.finalPcmSamples ??
        new Float32Array(
          Math.max(
            0,
            Math.round(16_000 * (options.durationSeconds ?? 1)) - 4096,
          ),
        );
      if (!options.finalPcmSamples) {
        samples.fill(0.1);
      }
      this.dispatchEvent(new MessageEvent("message", { data: samples.buffer }));
      this.dispatchEvent(new MessageEvent("message", { data: "done" }));
    }
  }

  class TestVoiceAudioWorkletNode {
    readonly port = new TestVoicePcmPort();
  }

  const mediaDevicesDescriptor = defineWindowProperty(
    navigator,
    "mediaDevices",
    {
      enumerateDevices: () => {
        return Promise.resolve([] as MediaDeviceInfo[]);
      },
      getUserMedia: () => {
        return (options.getUserMediaReady ?? Promise.resolve()).then(() => {
          return stream;
        });
      },
    },
  );
  const audioWorkletDescriptor = defineWindowProperty(
    window,
    "AudioWorkletNode",
    TestVoiceAudioWorkletNode as unknown as typeof AudioWorkletNode,
  );
  const audioContextDescriptor =
    options.rms === undefined
      ? undefined
      : defineWindowProperty(
          window,
          "AudioContext",
          TestVoiceAudioContext as unknown as typeof AudioContext,
        );

  restoreOnAbort(signal, () => {
    restoreWindowProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
    restoreWindowProperty(window, "AudioWorkletNode", audioWorkletDescriptor);
    if (audioContextDescriptor !== undefined) {
      restoreWindowProperty(window, "AudioContext", audioContextDescriptor);
    }
  });
}

function mockImageDimensions(
  signal: AbortSignal,
  results: ImageDimensionsMockResult | readonly ImageDimensionsMockResult[],
): ImageDimensionsMock {
  const pendingResults = Array.isArray(results) ? [...results] : [results];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  let objectUrlIndex = 0;

  class TestImage extends EventTarget {
    naturalWidth = 0;
    naturalHeight = 0;
    private source: string | undefined;

    set src(value: string) {
      this.source = value;
      const result =
        pendingResults.length > 1
          ? pendingResults.shift()
          : (pendingResults[0] ?? null);
      if (result === "pending") {
        return;
      }
      if (result) {
        this.naturalWidth = result.width;
        this.naturalHeight = result.height;
      }
      queueMicrotask(() => {
        if (this.source) {
          this.dispatchEvent(new Event(result ? "load" : "error"));
        }
      });
    }

    removeAttribute(name: string): void {
      if (name === "src") {
        this.source = undefined;
      }
    }
  }

  const createObjectUrlDescriptor = defineWindowProperty(
    URL,
    "createObjectURL",
    (_object: Blob | MediaSource) => {
      objectUrlIndex += 1;
      const url = `blob:mock-image-${objectUrlIndex}`;
      createdUrls.push(url);
      return url;
    },
  );
  const revokeObjectUrlDescriptor = defineWindowProperty(
    URL,
    "revokeObjectURL",
    (url: string) => {
      revokedUrls.push(url);
    },
  );
  const imageDescriptor = defineWindowProperty(
    window,
    "Image",
    TestImage as unknown as typeof Image,
  );

  restoreOnAbort(signal, () => {
    restoreWindowProperty(URL, "createObjectURL", createObjectUrlDescriptor);
    restoreWindowProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
    restoreWindowProperty(window, "Image", imageDescriptor);
  });

  return { createdUrls, revokedUrls };
}

function mockCanvasRendering(signal: AbortSignal): CanvasRenderingMock {
  const clipCircles: CanvasClipCircle[] = [];
  const imageDraws: CanvasImageDraw[] = [];
  const renders: CanvasRender[] = [];
  const context = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    arc(
      centerX: number,
      centerY: number,
      radius: number,
      startAngle: number,
      endAngle: number,
    ) {
      clipCircles.push({
        centerX,
        centerY,
        radius,
        startAngle,
        endAngle,
      });
    },
    arcTo() {},
    beginPath() {},
    clip() {},
    closePath() {},
    drawImage(
      _image: CanvasImageSource,
      x: number,
      y: number,
      width?: number,
      height?: number,
    ) {
      imageDraws.push({ height, width, x, y });
    },
    fill() {},
    fillRect() {},
    fillText() {},
    lineTo() {},
    measureText() {
      return { width: 80 } as TextMetrics;
    },
    moveTo() {},
    restore() {},
    roundRect() {},
    save() {},
    stroke() {},
    strokeText() {},
  } as unknown as CanvasRenderingContext2D;

  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function getContext(contextId: string) {
      return contextId === "2d" ? context : null;
    } as typeof HTMLCanvasElement.prototype.getContext);
  const toDataURL = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockImplementation(function toDataURL(this: HTMLCanvasElement) {
      renders.push({
        background: String(context.fillStyle),
        height: this.height,
        width: this.width,
      });
      return renders.length === 1
        ? "data:image/png;base64,AAAA"
        : "data:image/png;base64,AAAB";
    });
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) => {
      callback(new Blob(["mock canvas"], { type: "image/png" }));
    });

  restoreOnAbort(signal, () => {
    getContext.mockRestore();
    toDataURL.mockRestore();
    toBlob.mockRestore();
  });

  return { clipCircles, imageDraws, renders };
}

function mockRequestCacheMode(signal: AbortSignal): void {
  const NativeRequest = window.Request;
  class RequestWithCacheMode extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init);
      Object.defineProperty(this, "cache", {
        configurable: true,
        enumerable: true,
        value:
          init?.cache ??
          (input instanceof NativeRequest ? input.cache : "default"),
      });
    }
  }

  // Happy DOM does not expose Request.cache yet. Preserve it so HTTP boundary
  // mocks can cover cache-sensitive browser behavior without mocking fetch.
  const descriptor = defineWindowProperty(
    window,
    "Request",
    RequestWithCacheMode,
  );
  restoreOnAbort(signal, () => {
    restoreWindowProperty(window, "Request", descriptor);
  });
}

function defineWindowProperty(
  target: object,
  property: string,
  value: unknown,
): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  Object.defineProperty(target, property, {
    configurable: true,
    value,
  });
  return descriptor;
}

function restoreWindowProperty(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }
  Reflect.deleteProperty(target, property);
}

function restoreOnAbort(signal: AbortSignal, restore: () => void): void {
  signal.addEventListener("abort", restore, { once: true });
}

function productionApiOriginForUrl(url: string): string | null {
  const hostname = new URL(url, window.location.href).hostname;
  if (hostname === "app.okou.ai") {
    return "https://api.okou.ai";
  }
  return null;
}
