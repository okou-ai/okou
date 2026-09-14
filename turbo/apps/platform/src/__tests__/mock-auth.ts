import type {
  BrowserClerk,
  CreateOrganizationParams,
} from "@clerk/react/types";
import type { ClerkOptions } from "@clerk/shared/types";
import type { ClerkUIConstructor } from "@clerk/shared/ui";
import { vi } from "vitest";
import { replaceState } from "../signals/location.ts";

type GetTokenImpl = (options?: {
  skipCache?: boolean;
}) => Promise<string | null>;

type SessionTouchImpl = (options?: { intent?: "focus" }) => Promise<void>;

interface MockedClerkSession {
  readonly id: string;
  readonly lastActiveOrganizationId: string | null;
  readonly getToken: GetTokenImpl;
  readonly touch: SessionTouchImpl;
}

interface MockedClerkResources {
  readonly session: MockedClerkSession | null | undefined;
}

type MockedClerkListener = (resources: MockedClerkResources) => void;

interface MockedClerkListenerOptions {
  readonly skipInitialEmit?: boolean;
}

interface MockedInvitation {
  id: string;
  accept?: () => Promise<unknown>;
  publicOrganizationData?: {
    id: string;
    name: string;
    imageUrl: string;
  };
}

export interface MockedMembership {
  id: string;
  role?: string;
  organization?: {
    id: string;
    name: string;
    imageUrl?: string | null;
  };
}

interface MockedClientSession {
  currentTask?: { readonly key: string };
  id: string;
  status?: string;
  user?: {
    fullName?: string | null;
    imageUrl?: string;
    primaryEmailAddress?: { emailAddress: string } | null;
  };
}

interface MockedUser {
  id: string;
  fullName: string;
  firstName?: string;
  imageUrl?: string;
  createdAt?: Date;
  primaryEmailAddress: { emailAddress: string } | null;
  createOrganizationEnabled: boolean;
  createOrganizationsLimit: number | null;
  organizationMemberships: MockedMembership[];
  getOrganizationMemberships: (params: {
    initialPage: number;
    pageSize: number;
  }) => Promise<{ data: MockedMembership[]; total_count: number }>;
  getOrganizationInvitations: (params?: {
    status?: string;
  }) => Promise<{ data: MockedInvitation[]; total_count: number }>;
}

let internalMockedUser: MockedUser | null = null;
let internalMockedSession: { token: string; id?: string } | null = null;
let internalMockedOrganization: {
  id: string;
  name: string;
  slug?: string;
  imageUrl?: string;
  hasImage?: boolean;
  reload: () => Promise<void>;
} | null = null;
let internalMockedInvitations: MockedInvitation[] = [];
let internalMockedMemberships: MockedMembership[] = [{ id: "org_default" }];
let internalMockedClientSessions: MockedClientSession[] = [];
let internalMockedClerkLoadOptions: MockedClerkLoadOptions = {};
let internalMockedClerkLoaded = true;
let internalMockedClerkSessionTransitioning = false;
let internalMockedClerkSessionSignedOut = false;

export function mockClerkLoaded(loaded: boolean): void {
  internalMockedClerkLoaded = loaded;
}

/**
 * Clerk's transitive state: while `setActive()` navigates it publishes
 * `session`, `user` and `organization` as `undefined` and emits the real
 * values only afterwards. `undefined` means unknown, not signed out.
 */
export function mockClerkSessionTransitioning(transitioning: boolean): void {
  internalMockedClerkSessionTransitioning = transitioning;
  emitMockedClerkEvent();
}

export function mockClerkSessionSignedOut(signedOut: boolean): void {
  internalMockedClerkSessionSignedOut = signedOut;
  emitMockedClerkEvent();
}

export function mockUser(
  user: {
    id: string;
    fullName: string;
    email?: string;
    firstName?: string;
    imageUrl?: string;
    createdAt?: Date;
    createOrganizationEnabled?: boolean;
    createOrganizationsLimit?: number | null;
    clientSessions?: MockedClientSession[];
  } | null,
  session: { token: string; id?: string } | null,
) {
  if (user) {
    internalMockedUser = {
      ...user,
      imageUrl: user.imageUrl,
      primaryEmailAddress: user.email ? { emailAddress: user.email } : null,
      createOrganizationEnabled: user.createOrganizationEnabled ?? false,
      createOrganizationsLimit: user.createOrganizationsLimit ?? null,
      get organizationMemberships() {
        return internalMockedMemberships;
      },
      getOrganizationMemberships: ({ initialPage, pageSize }) => {
        return Promise.resolve({
          data: internalMockedMemberships.slice(
            (initialPage - 1) * pageSize,
            initialPage * pageSize,
          ),
          total_count: internalMockedMemberships.length,
        });
      },
      getOrganizationInvitations: () => {
        return Promise.resolve({
          data: [...internalMockedInvitations],
          total_count: internalMockedInvitations.length,
        });
      },
    };
    internalMockedClientSessions = user.clientSessions ?? [
      {
        id: "test-session-id",
        status: "active",
        user: {
          fullName: user.fullName,
          imageUrl: user.imageUrl,
          primaryEmailAddress: user.email ? { emailAddress: user.email } : null,
        },
      },
    ];
  } else {
    internalMockedUser = null;
    internalMockedClientSessions = [];
  }
  internalMockedSession = session;
}

/**
 * Configure organization-related mock state for testing org selection.
 */
export function mockOrganization(options: {
  activeOrg?: {
    id: string;
    name: string;
    slug?: string;
    imageUrl?: string;
    hasImage?: boolean;
  } | null;
  memberships?: MockedMembership[];
  pendingInvitations?: MockedInvitation[];
}) {
  internalMockedOrganization = options.activeOrg
    ? {
        ...options.activeOrg,
        reload: () => {
          return Promise.resolve();
        },
      }
    : null;
  if (options.memberships) {
    internalMockedMemberships = options.memberships;
  }
  internalMockedInvitations = options.pendingInvitations ?? [];
}

function clearMockedAuth() {
  internalMockedUser = null;
  internalMockedSession = null;
  internalMockedOrganization = null;
  internalMockedInvitations = [];
  internalMockedMemberships = [{ id: "org_default" }];
  internalMockedClientSessions = [];
  internalMockedClerkLoadOptions = {};
  internalMockedClerkLoaded = true;
  internalMockedClerkSessionTransitioning = false;
  internalMockedClerkSessionSignedOut = false;
  clerkListeners.length = 0;
  clerkStatusListeners.clear();
  mockedClerk.on = defaultClerkStatusOn;
  mockedClerk.off = defaultClerkStatusOff;
  mockedClerk.openSignIn.mockReset();
  mockedClerk.openSignIn.mockResolvedValue(undefined);
  mockedClerk.signOut.mockReset();
  mockedClerk.setActive.mockReset();
  mockedClerk.setActive.mockImplementation(defaultSetActiveImpl);
  mockedClerk.createOrganization.mockReset();
  mockedClerk.sessionGetToken.mockReset();
  mockedClerk.sessionGetToken.mockImplementation(defaultGetTokenImpl);
  mockedClerk.sessionTouch.mockReset();
  mockedClerk.sessionTouch.mockImplementation(defaultSessionTouchImpl);
  mockedClerk.load = mockedClerkLoad;
  mockedClerkLoad.mockReset();
  mockedClerkLoad.mockImplementation(defaultLoadImpl);
  mockedClerk.clientSignInCreate.mockReset();
  mockedClerk.clientSignInCreate.mockImplementation(
    defaultClientSignInCreateImpl,
  );
  mockedClerk.buildUrlWithAuth.mockReset();
  mockedClerk.buildUrlWithAuth.mockImplementation(defaultBuildUrlWithAuthImpl);
  mockedClerk.buildUserProfileUrl.mockReset();
  mockedClerk.buildUserProfileUrl.mockImplementation(
    defaultBuildUserProfileUrlImpl,
  );
  mockedClerk.buildSignInUrl.mockReset();
  mockedClerk.buildSignInUrl.mockImplementation(defaultBuildSignInUrlImpl);
  mockedClerk.buildSignUpUrl.mockReset();
  mockedClerk.buildSignUpUrl.mockImplementation(defaultBuildSignUpUrlImpl);
  mockedClerk.navigate.mockReset();
  mockedClerk.navigate.mockImplementation(defaultNavigateImpl);
  mockedClerk.redirectToSignIn.mockReset();
  mockedClerk.redirectToSignIn.mockImplementation(defaultRedirectToSignInImpl);
  mockedClerk.redirectToSignUp.mockReset();
  mockedClerk.redirectToSignUp.mockImplementation(defaultRedirectToSignUpImpl);
}

export function clearMockedAuthOnAbort(signal: AbortSignal): void {
  signal.addEventListener("abort", clearMockedAuth, { once: true });
}

const clerkListeners: MockedClerkListener[] = [];
// Status subscriptions the SDK is still holding. A route that subscribes must
// release its handler through `off`, so tests can observe the leak directly.
const clerkStatusListeners = new Set<unknown>();
const defaultClerkStatusOn: BrowserClerk["on"] = (
  event,
  handler,
  options,
): void => {
  if (event !== "status") {
    return;
  }
  clerkStatusListeners.add(handler);
  if (options?.notify) {
    handler(internalMockedClerkLoaded ? "ready" : "loading");
  }
};
const defaultClerkStatusOff: BrowserClerk["off"] = (event, handler): void => {
  if (event === "status" && handler) {
    clerkStatusListeners.delete(handler);
  }
};

export function mockedClerkStatusListenerCount(): number {
  return clerkStatusListeners.size;
}

export function emitMockedClerkEvent(): void {
  const resources = { session: mockedClerk.session };
  for (const listener of clerkListeners.slice()) {
    listener(resources);
  }
}

const defaultGetTokenImpl: GetTokenImpl = () => {
  return Promise.resolve(internalMockedSession?.token ?? "");
};

const sessionGetToken = vi.fn<GetTokenImpl>(defaultGetTokenImpl);
const defaultSessionTouchImpl: SessionTouchImpl = () => {
  return Promise.resolve();
};
const sessionTouch = vi.fn<SessionTouchImpl>(defaultSessionTouchImpl);

function defaultClientSignInCreateImpl(_params: {
  strategy: "ticket";
  ticket: string;
}) {
  return Promise.resolve({
    status: "complete",
    createdSessionId: "test-created-session-id",
  });
}

const clientSignInCreate = vi.fn<typeof defaultClientSignInCreateImpl>(
  defaultClientSignInCreateImpl,
);

const defaultBuildUrlWithAuthImpl = (to: string) => {
  return to;
};

const defaultBuildUserProfileUrlImpl = () => {
  return "https://accounts.example.test/user";
};

export interface MockedClerkLoadOptions {
  afterSignOutUrl?: string;
  routerPush?: NonNullable<ClerkOptions["routerPush"]>;
  routerReplace?: NonNullable<ClerkOptions["routerReplace"]>;
  signInUrl?: string;
  signUpUrl?: string;
  ui?: unknown;
}

interface MockedSignInRedirectOptions {
  redirectUrl?: string | null;
}

function defaultBuildAuthUrl(
  configuredUrl: string | undefined,
  fallbackPath: "/sign-in" | "/sign-up",
  options?: MockedSignInRedirectOptions,
): string {
  if (!internalMockedClerkLoaded) {
    return "";
  }

  const authUrl = new URL(
    configuredUrl ?? fallbackPath,
    window.location.origin,
  );
  const redirectUrl = new URL(
    options?.redirectUrl ?? window.location.href,
    window.location.origin,
  );
  // Clerk serializes redirect options into the auth route's fragment.
  const authHashParams = new URLSearchParams();
  authHashParams.set("redirect_url", redirectUrl.toString());
  authUrl.hash = `/?${authHashParams.toString()}`;
  return authUrl.toString();
}

const defaultBuildSignInUrlImpl = (
  options?: MockedSignInRedirectOptions,
): string => {
  return defaultBuildAuthUrl(
    internalMockedClerkLoadOptions.signInUrl,
    "/sign-in",
    options,
  );
};

const defaultBuildSignUpUrlImpl = (
  options?: MockedSignInRedirectOptions,
): string => {
  return defaultBuildAuthUrl(
    internalMockedClerkLoadOptions.signUpUrl,
    "/sign-up",
    options,
  );
};

const defaultNavigateImpl: BrowserClerk["navigate"] = (to) => {
  replaceState(null, "", to);
  return Promise.resolve();
};

const defaultRedirectToSignInImpl: BrowserClerk["redirectToSignIn"] = async (
  options,
): Promise<void> => {
  await defaultNavigateImpl(defaultBuildSignInUrlImpl(options));
};

const defaultRedirectToSignUpImpl: BrowserClerk["redirectToSignUp"] = async (
  options,
): Promise<void> => {
  await defaultNavigateImpl(defaultBuildSignUpUrlImpl(options));
};

const defaultLoadImpl = (options?: MockedClerkLoadOptions) => {
  internalMockedClerkLoadOptions = options ?? {};
  return Promise.resolve();
};
export const mockedClerkLoad = vi.fn<typeof defaultLoadImpl>(defaultLoadImpl);

interface MockedSetActiveParams {
  organization?: string | null;
  session?: string | null;
  navigate?: (params: {
    session: {
      currentTask?: {
        key: string;
      };
    };
    decorateUrl: (url: string) => string;
  }) => void | Promise<unknown>;
}

async function defaultSetActiveImpl(
  params: MockedSetActiveParams,
): Promise<void> {
  let navigatedTo: string | null = null;
  const selectedSession = internalMockedClientSessions.find((session) => {
    return session.id === params.session;
  });
  const activeSession = internalMockedClientSessions.find((session) => {
    return session.status === "pending" || session.status === "active";
  });
  const sourceSession = selectedSession ?? activeSession;
  const session =
    !params.organization && sourceSession?.currentTask
      ? { currentTask: sourceSession.currentTask }
      : {};
  await params.navigate?.({
    session,
    decorateUrl: (url) => {
      navigatedTo = defaultBuildUrlWithAuthImpl(url);
      return navigatedTo;
    },
  });
  if (navigatedTo) {
    replaceState(null, "", navigatedTo);
  }
}

type MockedCreateOrganization = (
  params: CreateOrganizationParams,
) => Promise<{ readonly id: string }>;

export const mockedClerk = {
  get loaded() {
    return internalMockedClerkLoaded;
  },
  get status() {
    return internalMockedClerkLoaded ? "ready" : "loading";
  },
  get user() {
    if (internalMockedClerkSessionTransitioning) {
      return undefined;
    }
    return internalMockedUser;
  },
  get organization() {
    if (internalMockedClerkSessionTransitioning) {
      return undefined;
    }
    return internalMockedOrganization;
  },
  get session() {
    if (internalMockedClerkSessionTransitioning) {
      return undefined;
    }
    if (internalMockedClerkSessionSignedOut) {
      return null;
    }
    if (!internalMockedSession) {
      return null;
    }
    const recoverableSession = internalMockedClientSessions.find((session) => {
      return session.status === "pending";
    });
    if (recoverableSession) {
      return {
        ...recoverableSession,
        get lastActiveOrganizationId() {
          return internalMockedOrganization?.id ?? null;
        },
        getToken: sessionGetToken,
        touch: sessionTouch,
      };
    }
    return {
      id: internalMockedSession.id ?? "test-session-id",
      get lastActiveOrganizationId() {
        return internalMockedOrganization?.id ?? null;
      },
      getToken: sessionGetToken,
      touch: sessionTouch,
    };
  },
  sessionGetToken,
  sessionTouch,
  clientSignInCreate,
  client: {
    get sessions() {
      return internalMockedClientSessions;
    },
    signIn: {
      create: clientSignInCreate,
    },
  },
  openSignIn: vi.fn<
    (...args: Parameters<BrowserClerk["openSignIn"]>) => Promise<void>
  >(() => Promise.resolve()),
  signOut: vi.fn<BrowserClerk["signOut"]>(() => {
    return Promise.resolve();
  }),
  load: mockedClerkLoad,
  on: defaultClerkStatusOn,
  off: defaultClerkStatusOff,
  addListener: (
    cb: MockedClerkListener,
    _options?: MockedClerkListenerOptions,
  ) => {
    clerkListeners.push(cb);
    return () => {
      const idx = clerkListeners.indexOf(cb);
      if (idx !== -1) {
        clerkListeners.splice(idx, 1);
      }
    };
  },
  navigate: vi.fn<BrowserClerk["navigate"]>(defaultNavigateImpl),
  redirectToSignIn: vi.fn<BrowserClerk["redirectToSignIn"]>(
    defaultRedirectToSignInImpl,
  ),
  redirectToSignUp: vi.fn<BrowserClerk["redirectToSignUp"]>(
    defaultRedirectToSignUpImpl,
  ),
  buildSignInUrl: vi.fn<typeof defaultBuildSignInUrlImpl>(
    defaultBuildSignInUrlImpl,
  ),
  buildSignUpUrl: vi.fn<typeof defaultBuildSignUpUrlImpl>(
    defaultBuildSignUpUrlImpl,
  ),
  // Production-instance behavior: the URL passes through unchanged. Dev
  // instances append the __clerk_db_jwt session handoff parameter.
  buildUrlWithAuth: vi.fn<typeof defaultBuildUrlWithAuthImpl>(
    defaultBuildUrlWithAuthImpl,
  ),
  buildUserProfileUrl: vi.fn<typeof defaultBuildUserProfileUrlImpl>(
    defaultBuildUserProfileUrlImpl,
  ),
  setActive: vi.fn<typeof defaultSetActiveImpl>(defaultSetActiveImpl),
  createOrganization: vi.fn<MockedCreateOrganization>(() => {
    return Promise.resolve({ id: "new-org-id" });
  }),
};

type MockedClerkBootstrapLoadOptions = MockedClerkLoadOptions & {
  readonly afterSignOutUrl: string;
  readonly signInUrl: string;
  readonly signUpUrl: string;
};

/** Publishes the same single Clerk runtime that the inline page bootstrap owns. */
export function installMockedClerkBootstrap(
  signal: AbortSignal,
  options: {
    readonly coreReady?: Promise<unknown>;
    readonly loadOptions?: MockedClerkBootstrapLoadOptions;
  } = {},
): void {
  const loadOptions = options.loadOptions ?? {
    afterSignOutUrl: "/sign-in",
    signInUrl: "/sign-in",
    signUpUrl: "/sign-up",
  };
  const originalBootstrap = window.__okouClerkBootstrap;
  const clerkUI = Promise.withResolvers<ClerkUIConstructor>();
  const bootstrap: NonNullable<Window["__okouClerkBootstrap"]> = {
    resolveClerkUI: clerkUI.resolve,
    runtime: (async () => {
      await options.coreReady;
      const loaded = mockedClerk.load({
        ...loadOptions,
        ui: { ClerkUI: clerkUI.promise },
      });
      return { clerk: mockedClerk, loaded };
    })(),
  };
  window.__okouClerkBootstrap = bootstrap;
  signal.addEventListener(
    "abort",
    () => {
      if (window.__okouClerkBootstrap !== bootstrap) {
        return;
      }
      if (originalBootstrap) {
        window.__okouClerkBootstrap = originalBootstrap;
      } else {
        Reflect.deleteProperty(window, "__okouClerkBootstrap");
      }
    },
    { once: true },
  );
}
