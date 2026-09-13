import type { UserResource } from "@clerk/shared/types";
import { command, computed, state } from "ccstate";
import { normalizeGoogleAdsAttributionParams } from "@okouai/core/google-ads-attribution";
import { isDesktopAuthFlow } from "../lib/desktop-auth-flow.ts";
import {
  derivePlatformServiceOrigin,
  isOkouProductionHostname,
  type PlatformService,
} from "@okouai/core/platform-service-origin";
import { startClerkBrowserRuntime } from "../lib/clerk-runtime.ts";
import { clearSentryUser, setSentryUser } from "../lib/sentry.ts";
import {
  clearPostHogUser,
  setPostHogOrganization,
  setPostHogUser,
} from "../lib/posthog.ts";
import { appendCapturedPreviewBypassToUrl } from "../lib/preview-bypass-cookie.ts";
import {
  resolvePlatformEnvironment,
  resolvePlatformRuntimeConfig,
} from "../lib/platform-host.ts";
import { BRAND_NAME, type BrandName } from "./branding.ts";
import { rootSignal$ } from "./root-signal.ts";
import {
  bestEffort,
  createDeferredPromise,
  type DeferredPromise,
  NEVER_RESOLVED_PROMISE,
  onDomEventFn,
} from "./utils.ts";
import { writeConnectionDiagnostic$ } from "./connection-diagnostics.ts";
import { sessionStorageSignals } from "./external/session-storage.ts";

const reload$ = state(0);
const clerkVersion$ = state(0);

const ATTRIBUTION_SOURCE_PARAM = "vm0_source";
const HOMEPAGE_ATTRIBUTION_VALUE = "homepage";
const ONBOARDING_PATH = "/onboarding";
const PRODUCTION_AUTH_REDIRECT_ORIGIN_PATTERN =
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*okou\.ai(?::\d+)?$/i;

type AllowedAuthRedirectOrigin = string | RegExp;

export interface AuthBrandContext {
  readonly brandName: BrandName;
  readonly homeUrl: string;
}

const AD_ATTRIBUTION_PARAMS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "okou_campaign_id",
  "okou_ad_group_id",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
] as const;

const AD_TRAFFIC_MARKERS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_campaign",
  "okou_campaign_id",
  "okou_ad_group_id",
] as const;

const HTTP_URL_PREFIX_REGEX = /^https?:\/\//i;
const LEGACY_HTTP_URL_REGEX = /^https?:\/\/([^/?#\s]+)([/?#][^\s]*)?$/i;
const LEGACY_HOST_WITH_OPTIONAL_PORT_REGEX =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::(\d{1,5}))?$/i;
const MAX_URL_PORT = 65_535;

// Derive a sibling service origin from a public origin, keeping protocol and
// port: https://app.vm7.ai:8443 + "www" -> https://www.vm7.ai:8443. No
// environment fallback — a wrong-environment URL is silent and sticks, while
// an error here surfaces the actual bug.
function deriveServiceOrigin(
  currentOrigin: string,
  service: Extract<PlatformService, "www" | "app" | "api">,
): string {
  const currentUrl = new URL(currentOrigin);
  if (isOkouProductionHostname(currentUrl.hostname)) {
    currentUrl.hostname = `${service}.okou.ai`;
    return currentUrl.origin;
  }
  return derivePlatformServiceOrigin(currentOrigin, service);
}

function resolveAppOrigin(): string {
  const origin = location.origin;
  return !origin || origin === "null" ? "" : origin;
}

function resolveAuthOrigin(): string {
  return resolveAppOrigin();
}

function parseUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!HTTP_URL_PREFIX_REGEX.test(trimmed)) {
    return null;
  }

  if (typeof URL.canParse === "function") {
    return URL.canParse(trimmed) ? new URL(trimmed) : null;
  }

  const legacyMatch = LEGACY_HTTP_URL_REGEX.exec(trimmed);
  const host = legacyMatch?.[1];
  if (!host) {
    return null;
  }

  const hostMatch = LEGACY_HOST_WITH_OPTIONAL_PORT_REGEX.exec(host);
  const port = hostMatch?.[2];
  if (!hostMatch || (port && Number(port) > MAX_URL_PORT)) {
    return null;
  }

  return new URL(trimmed);
}

export function resolveAppUrl(): string {
  return resolveAppOrigin();
}

export function resolveAppAuthUrl(
  path: `/sign-${string}`,
  options: { redirectUrl?: string } = {},
): string {
  const appOrigin = resolveAuthOrigin();
  if (!appOrigin) {
    return path;
  }
  const url = new URL(path, appOrigin);
  if (options.redirectUrl) {
    url.searchParams.set("redirect_url", options.redirectUrl);
  }
  return url.toString();
}

// Clerk allowedRedirectOrigins for the current host: this app plus its www
// and api siblings. Production also includes the okou.ai family so Clerk can
// safely return between those services.
function getAllowedAuthRedirectOrigins(): AllowedAuthRedirectOrigin[] {
  const self = resolveAppOrigin();
  if (!self) {
    return [];
  }
  const productionOrigins =
    resolvePlatformEnvironment() === "production"
      ? [PRODUCTION_AUTH_REDIRECT_ORIGIN_PATTERN]
      : [];
  return [
    ...new Set([
      self,
      deriveServiceOrigin(self, "www"),
      deriveServiceOrigin(self, "api"),
      ...productionOrigins,
    ]),
  ];
}

export function getAllowedAuthRedirectOriginsForCurrentPage(): AllowedAuthRedirectOrigin[] {
  return getAllowedAuthRedirectOrigins();
}

function hasAdTraffic(params: URLSearchParams): boolean {
  const normalized = normalizeGoogleAdsAttributionParams(params);
  return AD_TRAFFIC_MARKERS.some((param) => {
    return normalized.has(param);
  });
}

function appendHomepageAttributionParams(
  url: URLSearchParams,
  landingSearch: string,
): void {
  const landingParams = normalizeGoogleAdsAttributionParams(
    new URLSearchParams(landingSearch),
  );
  url.set(ATTRIBUTION_SOURCE_PARAM, HOMEPAGE_ATTRIBUTION_VALUE);
  for (const param of AD_ATTRIBUTION_PARAMS) {
    for (const value of landingParams.getAll(param)) {
      url.append(param, value);
    }
  }
}

function setCurrentLandingContext(params: URLSearchParams): void {
  if (!params.has("landing_host")) {
    params.set("landing_host", location.hostname);
  }
  if (!params.has("landing_path")) {
    params.set("landing_path", location.pathname);
  }
}

function buildOnboardingEntryUrl(paramsInit?: URLSearchParams): string {
  const params = normalizeGoogleAdsAttributionParams(
    new URLSearchParams(paramsInit),
  );
  setCurrentLandingContext(params);
  const url = new URL(ONBOARDING_PATH, resolveAppOrigin());
  url.search = params.toString();
  appendCapturedPreviewBypassToUrl(url);
  return url.toString();
}

function isAllowedRedirectOrigin(
  redirectUrl: URL,
  allowedRedirectOrigins: readonly AllowedAuthRedirectOrigin[],
): boolean {
  return allowedRedirectOrigins.some((allowedOrigin) => {
    if (allowedOrigin instanceof RegExp) {
      return allowedOrigin.test(redirectUrl.origin);
    }
    const url = parseUrl(allowedOrigin);
    if (!url) {
      return false;
    }
    return url.origin === redirectUrl.origin;
  });
}

function readAllowedRedirectUrl(
  params: URLSearchParams,
  allowedRedirectOrigins: readonly AllowedAuthRedirectOrigin[],
): URL | null {
  const rawRedirectUrl = params.get("redirect_url");
  if (!rawRedirectUrl) {
    return null;
  }

  const redirectUrl = parseUrl(rawRedirectUrl);
  if (!redirectUrl) {
    return null;
  }
  return isAllowedRedirectOrigin(redirectUrl, allowedRedirectOrigins)
    ? redirectUrl
    : null;
}

function readAuthRedirectParams(
  authSearch: string,
  authHash: string,
): URLSearchParams {
  const searchParams = new URLSearchParams(authSearch);
  if (searchParams.has("redirect_url")) {
    return searchParams;
  }

  const hashQueryIndex = authHash.indexOf("?");
  if (hashQueryIndex === -1) {
    return searchParams;
  }

  const hashParams = new URLSearchParams(authHash.slice(hashQueryIndex + 1));
  const hashRedirectUrl = hashParams.get("redirect_url");
  if (hashRedirectUrl) {
    searchParams.set("redirect_url", hashRedirectUrl);
  }
  return searchParams;
}

export function resolveAuthBrandContext(): AuthBrandContext {
  return { brandName: BRAND_NAME, homeUrl: "/" };
}

export function buildSignupRedirectUrl(
  signUpSearch: string,
  allowedRedirectOrigins: readonly AllowedAuthRedirectOrigin[] = getAllowedAuthRedirectOriginsForCurrentPage(),
  signUpHash = "",
): string {
  const appUrl = resolveAppUrl();
  const params = readAuthRedirectParams(signUpSearch, signUpHash);
  const redirectUrl = readAllowedRedirectUrl(params, allowedRedirectOrigins);
  if (redirectUrl) {
    return redirectUrl.toString();
  }

  if (!hasAdTraffic(params)) {
    return new URL(ONBOARDING_PATH, appUrl).toString();
  }

  const redirectParams = new URLSearchParams();
  appendHomepageAttributionParams(redirectParams, params.toString());
  return buildOnboardingEntryUrl(redirectParams);
}

export function buildSignInRedirectUrl(
  signInSearch: string,
  allowedRedirectOrigins: readonly AllowedAuthRedirectOrigin[] = getAllowedAuthRedirectOriginsForCurrentPage(),
  signInHash = "",
): string {
  const params = readAuthRedirectParams(signInSearch, signInHash);
  const redirectUrl = readAllowedRedirectUrl(params, allowedRedirectOrigins);

  return redirectUrl?.toString() ?? resolveAppUrl();
}

export function buildAuthModeSwitchUrl(
  path: "/sign-in" | "/sign-up",
  authSearch: string,
  allowedRedirectOrigins: readonly AllowedAuthRedirectOrigin[] = getAllowedAuthRedirectOriginsForCurrentPage(),
  authHash = "",
): string {
  const redirectUrl = readAllowedRedirectUrl(
    readAuthRedirectParams(authSearch, authHash),
    allowedRedirectOrigins,
  );
  const searchParams = new URLSearchParams(authSearch);
  if (searchParams.has("redirect_url")) {
    if (redirectUrl) {
      searchParams.set("redirect_url", redirectUrl.toString());
    } else {
      searchParams.delete("redirect_url");
    }
  }

  const hashQueryIndex = authHash.indexOf("?");
  let hash = authHash;
  if (hashQueryIndex !== -1) {
    const hashParams = new URLSearchParams(authHash.slice(hashQueryIndex + 1));
    if (hashParams.has("redirect_url")) {
      if (redirectUrl) {
        hashParams.set("redirect_url", redirectUrl.toString());
      } else {
        hashParams.delete("redirect_url");
      }
      const hashPath = authHash.slice(0, hashQueryIndex);
      const hashSearch = hashParams.toString();
      hash = hashSearch ? `${hashPath}?${hashSearch}` : hashPath;
    }
  }

  const search = searchParams.toString();
  return `${path}${search ? `?${search}` : ""}${hash}`;
}

// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
const clerkRuntime$ = computed(async (get) => {
  const { clerkPublishableKey } = resolvePlatformRuntimeConfig();
  return await startClerkBrowserRuntime(
    {
      loadOptions: {
        afterSignOutUrl: resolveAppAuthUrl("/sign-in"),
        signInUrl: resolveAppAuthUrl("/sign-in"),
        signUpUrl: resolveAppAuthUrl("/sign-up"),
      },
      publishableKey: clerkPublishableKey,
    },
    get(rootSignal$),
  );
});

/** Loaded Clerk instance for consumers that need authentication state. */
export const clerk$ = computed(async (get) => {
  const runtime = await get(clerkRuntime$);
  await runtime.loaded;

  return runtime.clerk;
});

const internalClerkUser$ = state<Promise<UserResource | null>>(
  NEVER_RESOLVED_PROMISE,
);

/**
 * The settled Clerk user: `null` when signed out, never the transitive
 * `undefined`.
 *
 * Clerk publishes `session`, `user` and `organization` as `undefined` while
 * `setActive()` navigates and emits the real values only once that navigation
 * resolves. A direct `clerk.user` read inside that window reports a signed-out
 * user, so every transition swaps in a fresh promise that settles with the
 * value Clerk publishes next.
 */
export const clerkUser$ = computed((get): Promise<UserResource | null> => {
  return get(internalClerkUser$);
});

/**
 * Owns the Clerk listener behind {@link clerkUser$}. `bootstrap$` starts it in
 * its synchronous prologue, before the daemons and route setups that read the
 * signal; without an owner `clerkUser$` never settles.
 */
export const setupClerkUser$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    // Claim the signal before the first await. Daemons and route setups started
    // in the same synchronous pass then read a promise this command resolves,
    // instead of the module sentinel that nothing settles.
    let pending: DeferredPromise<UserResource | null> | null =
      createDeferredPromise<UserResource | null>(signal);
    set(internalClerkUser$, pending.promise);

    const clerk = await get(clerk$);
    signal.throwIfAborted();

    let publishedUserId: string | null | undefined;

    // Token, profile and session refreshes all emit here, often with a fresh
    // `UserResource` for the same account. Compare the account instead of the
    // object so they do not republish and re-run every consumer of
    // `clerkUser$`; `clerkVersion$` already covers mutable Clerk state.
    const publish = (): void => {
      const user = clerk.user;
      if (user === undefined) {
        if (pending) {
          return;
        }
        pending = createDeferredPromise<UserResource | null>(signal);
        set(internalClerkUser$, pending.promise);
        return;
      }
      publishedUserId = user?.id ?? null;
      if (pending) {
        const deferred = pending;
        pending = null;
        deferred.resolve(user);
        return;
      }
      set(internalClerkUser$, Promise.resolve(user));
    };

    const unsubscribe = clerk.addListener(() => {
      if (
        clerk.user !== undefined &&
        (clerk.user?.id ?? null) === publishedUserId &&
        !pending
      ) {
        return;
      }
      publish();
    });
    signal.addEventListener("abort", unsubscribe, { once: true });
    // Close the race between the current value and listener registration
    // instead of relying on Clerk's emit-on-subscribe behavior.
    publish();
  },
);

/** Load Clerk's optional hosted UI for auth pages and account switching. */
export const ensureClerkUiLoaded$ = command(
  async ({ get }, signal: AbortSignal) => {
    const runtime = await get(clerkRuntime$);
    signal.throwIfAborted();
    const ui = await runtime.ensureUiLoaded();
    signal.throwIfAborted();
    return ui;
  },
);

/** Open Clerk's hosted account switcher without leaving the active app page. */
export const openClerkAddAccount$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await set(ensureClerkUiLoaded$, signal);
    signal.throwIfAborted();
    await clerk.openSignIn({
      fallbackRedirectUrl: "/",
      forceRedirectUrl: "/",
    });
    signal.throwIfAborted();
  },
);

/**
 * Command to setup Clerk authentication listeners.
 * The runtime starts during bootstrap; this command waits for it and installs
 * authentication state listeners.
 */
export const setupClerk$ = command(
  async ({ set, get }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    // Set initial Sentry user context
    if (clerk.user) {
      setSentryUser(clerk.user.id);
      setPostHogUser({
        id: clerk.user.id,
        email: clerk.user.primaryEmailAddress?.emailAddress,
        name: clerk.user.fullName ?? undefined,
      });
    }
    setPostHogOrganization(clerk.organization?.id);

    // Track the user ID so we only trigger a reload on actual auth state
    // changes (sign-in / sign-out), not on token refreshes which fire the
    // Clerk listener but don't change the user.
    let prevUserId = clerk.user?.id ?? null;
    const unsubscribe = clerk.addListener(() => {
      if (clerk.user === undefined) {
        // Clerk's transitive state while `setActive()` navigates: the identity
        // is unknown, not signed out, and the next emit carries the real value.
        return;
      }
      // Update Sentry user context on auth state change
      if (clerk.user) {
        setSentryUser(clerk.user.id);
        setPostHogUser({
          id: clerk.user.id,
          email: clerk.user.primaryEmailAddress?.emailAddress,
          name: clerk.user.fullName ?? undefined,
        });
        setPostHogOrganization(clerk.organization?.id);
      } else {
        clearSentryUser();
        clearPostHogUser();
      }
      // Bump on every clerk event so signals tracking mutable clerk state
      // (e.g. current org's imageUrl after reload()) re-compute and their
      // subscribers re-render.
      set(clerkVersion$, (x) => {
        return x + 1;
      });
      const currentUserId = clerk.user?.id ?? null;
      if (currentUserId !== prevUserId) {
        prevUserId = currentUserId;
        set(writeConnectionDiagnostic$, { action: "clear" });
        set(reload$, (x) => {
          return x + 1;
        });
      }
    });
    signal.addEventListener("abort", unsubscribe);
  },
);

/**
 * User signal that provides the current authenticated user from Clerk.
 * Returns undefined if no user is authenticated.
 */
const ORG_ID_KEY = "clerk-active-org-id";
const activeOrgIdStorage = sessionStorageSignals(ORG_ID_KEY);

const persistOrgId$ = command(({ set }, orgId: string | undefined) => {
  if (orgId) {
    set(activeOrgIdStorage.set$, orgId);
  } else {
    set(activeOrgIdStorage.clear$);
  }
});

/**
 * Command that monitors the active Clerk organization and reloads
 * the page when it changes. Persists the active org ID to session storage.
 */
export const watchOrgSwitch$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    let prevOrgId = clerk.organization?.id ?? undefined;
    set(persistOrgId$, prevOrgId);
    setPostHogOrganization(prevOrgId);

    // Listener stays `() => void`: Clerk's `ListenerCallback` signature
    // is not awaited, and returning a promise from it would trip
    // `typescript/no-misused-promises`. `onDomEventFn` detaches the async
    // work, and `bestEffort` keeps reload behavior even when token rotation
    // rejects.
    const unsubscribe = clerk.addListener(
      onDomEventFn(async () => {
        if (clerk.user === null) {
          // Signed out: any organization that follows belongs to a new session
          // and activates rather than switches.
          prevOrgId = undefined;
          return;
        }
        const newOrgId = clerk.organization?.id ?? undefined;
        // Clerk clears the organization while `setActive()` navigates, and on
        // mobile it can also clear it during a background token refresh. Keep
        // the previous concrete org so that restoration is recognized as
        // unchanged rather than as an org switch.
        if (!newOrgId || newOrgId === prevOrgId) {
          return;
        }
        // The first organization a session activates is not a switch. Reloading
        // there would discard the destination the sign-in flow navigates to.
        const isFirstActivation = prevOrgId === undefined;
        prevOrgId = newOrgId;
        set(persistOrgId$, newOrgId);
        setPostHogOrganization(newOrgId);
        if (isFirstActivation) {
          return;
        }

        // Desktop owns navigation until fresh-token IPC and handoff acknowledgement.
        // Check both sides of the token wait: a route can change while it is pending.
        if (signal.aborted || isDesktopAuthFlow()) {
          return;
        }
        await bestEffort(
          (async () => {
            return await clerk.session?.getToken({ skipCache: true });
          })(),
        );
        if (!signal.aborted && !isDesktopAuthFlow()) {
          location.href = "/";
        }
      }),
    );
    signal.addEventListener("abort", unsubscribe);
  },
);

export const user$ = computed(async (get) => {
  get(reload$);
  return (await get(clerkUser$)) ?? undefined;
});

export const authenticatedIdentity$ = computed(async (get) => {
  const user = await get(clerkUser$);
  const clerk = await get(clerk$);
  if (!user || !clerk.organization) {
    throw new Error("Authenticated user and organization are required");
  }
  return {
    userId: user.id,
    orgId: clerk.organization.id,
    email: user.primaryEmailAddress?.emailAddress,
  };
});

/**
 * Stable cache ownership for authenticated pages.
 *
 * Route setup guarantees both values before page data is loaded. Keeping this
 * invariant here prevents cache-backed data sources from independently
 * treating a missing Clerk value as an empty cache or a remote-only mode.
 */
export const currentUserInfo$ = computed(async (get) => {
  get(clerkVersion$);
  const settled = await get(clerkUser$);
  if (!settled) {
    return undefined;
  }
  // `clerkUser$` only republishes when the account changes, so read the live
  // resource for field values: `clerkVersion$` drives the refresh when Clerk
  // replaces the same account's profile.
  const clerk = await get(clerk$);
  const user = clerk.user ?? settled;
  return {
    id: user.id,
    fullName: user.fullName,
    firstName: user.firstName,
    imageUrl: user.imageUrl,
    primaryEmailAddress: user.primaryEmailAddress
      ? {
          emailAddress: user.primaryEmailAddress.emailAddress,
        }
      : null,
  };
});

/**
 * Snapshot of the Clerk active organization, re-emitted on every clerk
 * event (via clerkVersion$). Read this instead of `clerk.organization.*`
 * directly when you want the UI to react to in-place mutations such as
 * `clerk.organization.reload()` after a logo or name update.
 */
export const currentOrgInfo$ = computed(async (get) => {
  get(clerkVersion$);
  const clerk = await get(clerk$);
  const org = clerk.organization;
  if (!org) {
    return null;
  }
  return {
    id: org.id,
    name: org.name,
    imageUrl: org.imageUrl,
    hasImage: org.hasImage,
  };
});

/**
 * Determines whether the current user needs to select an organization
 * before entering the platform.
 *
 * Returns true when ALL of:
 * - No active organization is set in the Clerk session
 * - AND at least one of:
 *   - User belongs to more than 1 organization
 *   - User has pending organization invitations
 *
 */
export const needsOrgSelection$ = computed(async (get) => {
  get(reload$);
  const clerk = await get(clerk$);
  const user = clerk.user;
  if (!user) {
    return false;
  }

  // If an active organization is already set, no selection needed
  if (clerk.organization) {
    return false;
  }

  // No active organization — user must select or create one
  return true;
});
