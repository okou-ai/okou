import { command, computed, state } from "ccstate";
import { buildSignupRedirectUrl, clerk$ } from "./auth.ts";
import { signupFriendReferralReady$ } from "./friend-referrals.ts";
import { detachedNavigateTo$ } from "./route.ts";
import type { RoutePath } from "./route-paths.ts";

type SignupInput =
  | {
      readonly kind: "email";
      readonly emailAddress: string;
      readonly password: string;
      readonly legalAccepted: boolean;
    }
  | {
      readonly kind: "oauth";
      readonly strategy: "oauth_google" | "oauth_apple";
    };

const passwordVisibleState$ = state(false);
export const signupPasswordVisible$ = computed((get) => {
  return get(passwordVisibleState$);
});
export const toggleSignupPassword$ = command(({ set }) => {
  set(passwordVisibleState$, (visible) => {
    return !visible;
  });
});
export const resetSignupStart$ = command(({ set }) => {
  set(passwordVisibleState$, false);
});

function signupStepUrl(step: string, redirectUrl: string): URL {
  const url = new URL(`/sign-up/${step}`, location.origin);
  url.searchParams.set("redirect_url", redirectUrl);
  return url;
}

/** Clerk owns the attempt and all subsequent verification, callback and task pages. */
export const startSignup$ = command(
  async ({ get, set }, input: SignupInput, signal: AbortSignal) => {
    if (!get(signupFriendReferralReady$)) {
      return;
    }
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const signup = clerk.client?.signUp;
    if (!signup) {
      throw new Error("Clerk sign-up is not ready");
    }
    const redirectUrl = buildSignupRedirectUrl(
      location.search,
      undefined,
      location.hash,
    );
    if (input.kind === "oauth") {
      await signup.authenticateWithRedirect({
        strategy: input.strategy,
        redirectUrl: signupStepUrl("sso-callback", redirectUrl).href,
        redirectUrlComplete: redirectUrl,
      });
      signal.throwIfAborted();
      return;
    }
    const attempt = await signup.create({
      emailAddress: input.emailAddress,
      password: input.password,
      legalAccepted: input.legalAccepted,
    });
    signal.throwIfAborted();
    if (attempt.status === "complete") {
      if (!attempt.createdSessionId) {
        throw new Error("Completed sign-up is missing its session");
      }
      await clerk.setActive({
        session: attempt.createdSessionId,
        navigate: ({ session, decorateUrl }) => {
          signal.throwIfAborted();
          const destination = session.currentTask
            ? signupStepUrl(`tasks/${session.currentTask.key}`, redirectUrl)
                .href
            : redirectUrl;
          window.location.assign(decorateUrl(destination));
        },
      });
      signal.throwIfAborted();
      return;
    }
    let step = "continue";
    if (attempt.protectCheck) {
      step = "protect-check";
    } else if (
      attempt.missingFields.length === 0 &&
      attempt.unverifiedFields.includes("email_address")
    ) {
      await signup.prepareEmailAddressVerification({
        strategy: "email_code",
      });
      signal.throwIfAborted();
      step = "verify-email-address";
    }
    const target = signupStepUrl(step, redirectUrl);
    set(detachedNavigateTo$, target.pathname as RoutePath, {
      searchParams: target.searchParams,
    });
  },
);
