import { isClerkAPIResponseError } from "@clerk/shared/error";
import { Button, Card, Checkbox, Input } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolveAuthBrandContext } from "../../signals/auth.ts";
import { signupFriendReferralReady$ } from "../../signals/friend-referrals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  signupPasswordVisible$,
  startSignup$,
  toggleSignupPassword$,
} from "../../signals/signup-start.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { clerkSignupProviderIcons } from "../../lib/static-assets.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { SignupFriendReferral } from "./signup-friend-referral.tsx";

type SignupProvider = "oauth_google" | "oauth_apple";

export function SignupStart({ signInUrl }: { readonly signInUrl: string }) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const referralReady = useGet(signupFriendReferralReady$);
  const [signup, start] = useLoadableSet(startSignup$);
  const busy = signup.state === "loading";
  const error =
    signup.state === "hasError"
      ? isClerkAPIResponseError(signup.error)
        ? (signup.error.errors[0]?.longMessage ??
          signup.error.errors[0]?.message)
        : t(($) => {
            return $.auth.signup.failed;
          })
      : null;

  return (
    <Card data-testid="signup-start">
      <div className="space-y-6 px-[var(--okou-auth-card-padding-inline)] py-[var(--okou-auth-card-padding-block)]">
        <SignupHeader />
        <SignupSocialButtons
          disabled={busy || !referralReady}
          onStart={(strategy) => {
            detach(
              start({ kind: "oauth", strategy }, signal),
              Reason.DomCallback,
            );
          }}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            detach(
              start(
                {
                  kind: "email",
                  emailAddress: String(fields.get("emailAddress") ?? ""),
                  password: String(fields.get("password") ?? ""),
                  legalAccepted: fields.get("legalAccepted") === "on",
                },
                signal,
              ),
              Reason.DomCallback,
            );
          }}
        >
          <fieldset disabled={busy} className="space-y-5">
            <SignupFields />
            <SignupFriendReferral />
            <SignupLegal />
            <div id="clerk-captcha" />
            <Button
              type="submit"
              className="w-full"
              disabled={busy || !referralReady}
            >
              {busy && (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              )}
              {t(($) => {
                return $.auth.signup.continue;
              })}
            </Button>
          </fieldset>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <footer className="border-t border-border bg-nested-fill p-5 text-center text-sm text-muted-foreground">
        {t(($) => {
          return $.auth.signup.alreadyHaveAccount;
        })}{" "}
        <a href={signInUrl} className="text-brand-text hover:underline">
          {t(($) => {
            return $.auth.signup.signIn;
          })}
        </a>
      </footer>
    </Card>
  );
}

function SignupHeader() {
  const { t } = useTranslation();
  const authBrand = resolveAuthBrandContext();
  return (
    <header className="space-y-2 text-center">
      <a
        href={authBrand.homeUrl}
        aria-label={authBrand.brandName}
        className="mx-auto mb-6 flex w-fit hover:opacity-75"
      >
        <ProductBrandMark decorative size="compact" />
      </a>
      <h1 className="text-lg font-semibold">
        {t(($) => {
          return $.auth.signup.title;
        })}
      </h1>
      <p className="text-sm text-muted-foreground">
        {t(
          ($) => {
            return $.auth.signup.subtitle;
          },
          { applicationName: authBrand.brandName },
        )}
      </p>
    </header>
  );
}

function SignupSocialButtons({
  disabled,
  onStart,
}: {
  readonly disabled: boolean;
  readonly onStart: (provider: SignupProvider) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            onStart("oauth_apple");
          }}
        >
          <img
            src={clerkSignupProviderIcons.apple}
            alt=""
            className="size-4 dark:invert"
          />
          {t(($) => {
            return $.auth.signup.apple;
          })}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            onStart("oauth_google");
          }}
        >
          <img
            src={clerkSignupProviderIcons.google}
            alt=""
            className="size-4"
          />
          {t(($) => {
            return $.auth.signup.google;
          })}
        </Button>
      </div>
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        {t(($) => {
          return $.auth.signup.or;
        })}
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}

function SignupFields() {
  const { t } = useTranslation();
  const passwordVisible = useGet(signupPasswordVisible$);
  const togglePassword = useSet(toggleSignupPassword$);
  return (
    <>
      <div className="space-y-2">
        <label htmlFor="signup-email" className="block text-sm font-medium">
          {t(($) => {
            return $.auth.signup.email;
          })}
        </label>
        <Input
          id="signup-email"
          name="emailAddress"
          type="email"
          required
          autoComplete="email"
          placeholder={t(($) => {
            return $.auth.signup.emailPlaceholder;
          })}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="signup-password" className="block text-sm font-medium">
          {t(($) => {
            return $.auth.signup.password;
          })}
        </label>
        <div className="relative">
          <Input
            id="signup-password"
            name="password"
            type={passwordVisible ? "text" : "password"}
            required
            autoComplete="new-password"
            className="pr-10"
            placeholder={t(($) => {
              return $.auth.signup.passwordPlaceholder;
            })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
            onClick={togglePassword}
            aria-label={
              passwordVisible
                ? t(($) => {
                    return $.auth.signup.hidePassword;
                  })
                : t(($) => {
                    return $.auth.signup.showPassword;
                  })
            }
          >
            {passwordVisible ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </Button>
        </div>
      </div>
    </>
  );
}

function SignupLegal() {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 text-sm">
      <Checkbox
        id="signup-legal"
        name="legalAccepted"
        value="on"
        required
        className="mt-0.5"
      />
      <label htmlFor="signup-legal">
        {t(($) => {
          return $.auth.signup.legalPrefix;
        })}{" "}
        <a
          href="https://www.okou.ai/terms-of-use"
          target="_blank"
          rel="noreferrer"
          className="text-brand-text underline underline-offset-4"
        >
          {t(($) => {
            return $.auth.signup.terms;
          })}
        </a>{" "}
        {t(($) => {
          return $.auth.signup.legalAnd;
        })}{" "}
        <a
          href="https://www.okou.ai/privacy-policy"
          target="_blank"
          rel="noreferrer"
          className="text-brand-text underline underline-offset-4"
        >
          {t(($) => {
            return $.auth.signup.privacy;
          })}
        </a>
      </label>
    </div>
  );
}
