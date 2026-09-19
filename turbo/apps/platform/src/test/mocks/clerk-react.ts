// Mock for @clerk/react
import {
  createContext,
  createElement,
  Fragment,
  type ReactNode,
  useSyncExternalStore,
  useContext,
} from "react";
import { vi } from "vitest";
import type { BrowserClerk, ClerkOptions } from "@clerk/shared/types";

const MockClerkContext = createContext<BrowserClerk | null>(null);

type ClerkRouter = NonNullable<ClerkOptions["routerPush"]>;

export function useClerk(): BrowserClerk {
  const clerk = useContext(MockClerkContext);
  if (!clerk) {
    throw new Error("Clerk hook requires its provider");
  }
  return clerk;
}

export function Show({
  children,
  fallback = null,
  when,
}: {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
  readonly when: "signed-in" | "signed-out";
}) {
  const clerk = useClerk();
  const signedIn = Boolean(clerk.user);
  const visible = when === "signed-in" ? signedIn : !signedIn;
  return visible ? children : fallback;
}

const CLERK_AUTH_COMPONENT_MOUNT_EVENT = "okou:test-clerk-auth-component-mount";
const getClerkAuthComponentMounted = vi.fn<() => boolean>(() => {
  return true;
});

export function setMockClerkAuthComponentMounted(mounted: boolean): void {
  if (getClerkAuthComponentMounted() === mounted) {
    return;
  }
  getClerkAuthComponentMounted.mockReturnValue(mounted);
  window.dispatchEvent(new Event(CLERK_AUTH_COMPONENT_MOUNT_EVENT));
}

export function resetMockClerkAuthComponentMounted(): void {
  getClerkAuthComponentMounted.mockReturnValue(true);
}

function subscribeToClerkAuthComponent(listener: () => void): () => void {
  const handleMountChange = () => {
    listener();
  };
  window.addEventListener(CLERK_AUTH_COMPONENT_MOUNT_EVENT, handleMountChange);
  return () => {
    window.removeEventListener(
      CLERK_AUTH_COMPONENT_MOUNT_EVENT,
      handleMountChange,
    );
  };
}

interface ClerkProviderProps {
  Clerk: BrowserClerk;
  afterSignOutUrl?: string;
  children: ReactNode;
  allowedRedirectOrigins?: readonly (string | RegExp)[];
  localization?: {
    signIn?: {
      start?: { actionLink?: string; title?: string };
    };
  };
  routerPush?: ClerkRouter;
  routerReplace?: ClerkRouter;
  signInFallbackRedirectUrl?: string;
  signInUrl?: string;
  signUpFallbackRedirectUrl?: string;
  signUpUrl?: string;
}

export function ClerkProvider({
  Clerk,
  afterSignOutUrl,
  allowedRedirectOrigins,
  children,
  localization,
  routerPush,
  routerReplace,
  signInUrl,
  signUpUrl,
}: ClerkProviderProps) {
  const { signIn: { start = {} } = {} } = localization ?? {};
  return createElement(
    MockClerkContext.Provider,
    { value: Clerk },
    createElement("span", {
      "data-clerk-sign-in-start-action-link": start.actionLink,
      "data-clerk-after-sign-out-url": afterSignOutUrl,
      "data-clerk-allowed-redirect-origins": JSON.stringify(
        allowedRedirectOrigins?.map(String),
      ),
      "data-clerk-provider-router-push": typeof routerPush,
      "data-clerk-provider-router-replace": typeof routerReplace,
      "data-clerk-provider-sign-in-url": signInUrl,
      "data-clerk-provider-sign-up-url": signUpUrl,
      "data-testid": "clerk-provider-config",
      hidden: true,
    }),
    children,
  );
}

interface ClerkAuthComponentProps {
  appearance?: {
    options?: {
      logoImageUrl?: string;
      logoPlacement?: string;
    };
  };
  fallback?: ReactNode;
  fallbackRedirectUrl?: string;
  forceRedirectUrl?: string;
  path?: string;
  routing?: string;
  signInUrl?: string;
  signUpUrl?: string;
}

function ClerkAuthComponent({
  componentName,
  appearance,
  fallback,
  fallbackRedirectUrl,
  forceRedirectUrl,
  path,
  routing,
  signInUrl,
  signUpUrl,
  testId,
}: ClerkAuthComponentProps & {
  componentName: string;
  testId: string;
}) {
  const mounted = useSyncExternalStore(
    subscribeToClerkAuthComponent,
    getClerkAuthComponentMounted,
  );

  return createElement(
    Fragment,
    null,
    mounted ? null : fallback,
    createElement(
      "div",
      {
        "data-clerk-component": componentName,
        "data-clerk-fallback-redirect-url": fallbackRedirectUrl,
        "data-clerk-force-redirect-url": forceRedirectUrl,
        "data-clerk-logo-image-url": appearance?.options?.logoImageUrl,
        "data-clerk-logo-placement": appearance?.options?.logoPlacement,
        "data-clerk-routing": routing,
        "data-clerk-sign-in-url": signInUrl,
        "data-clerk-sign-up-url": signUpUrl,
        "data-testid": testId,
      },
      mounted ? createElement("span", null, path) : null,
    ),
  );
}

export function SignIn(props: ClerkAuthComponentProps) {
  return createElement(ClerkAuthComponent, {
    ...props,
    componentName: "SignIn",
    testId: "clerk-sign-in",
  });
}

export function SignUp(props: ClerkAuthComponentProps) {
  return createElement(ClerkAuthComponent, {
    ...props,
    componentName: "SignUp",
    testId: "clerk-sign-up",
  });
}

export function OAuthConsent({ fallback }: { fallback?: ReactNode }) {
  const mounted = useSyncExternalStore(
    subscribeToClerkAuthComponent,
    getClerkAuthComponentMounted,
  );
  return createElement(
    Fragment,
    null,
    mounted ? null : fallback,
    createElement("div", {
      "data-client-id": new URLSearchParams(location.search).get("client_id"),
      "data-testid": "clerk-oauth-consent",
      hidden: !mounted,
    }),
  );
}

interface GoogleOneTapProps {
  signInForceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

export function GoogleOneTap({
  signInForceRedirectUrl,
  signUpForceRedirectUrl,
}: GoogleOneTapProps) {
  return createElement("div", {
    "data-testid": "clerk-google-one-tap",
    "data-sign-in-force-redirect-url": signInForceRedirectUrl,
    "data-sign-up-force-redirect-url": signUpForceRedirectUrl,
  });
}
