import { cardClassName, cn } from "@okouai/ui";
import type { SignIn } from "@clerk/react";
import type { ComponentProps } from "react";
import { platformOkouWordmarkLightImg } from "../../lib/static-assets.ts";

type ClerkAppearance = NonNullable<ComponentProps<typeof SignIn>["appearance"]>;

const CLERK_AUTH_PRIMARY_ACTION_CLASS =
  "border-transparent bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed";

// Clerk owns the field geometry and behavior. Keep the public input slot on
// the application's standard control boundary so fields remain distinguishable
// from the card surface in every theme.
const CLERK_AUTH_TEXT_INPUT_CLASS =
  "border border-[hsl(var(--gray-400))] bg-input shadow-none focus:border-primary focus:ring-[3px] focus:ring-primary/10 aria-invalid:border-destructive aria-invalid:focus:border-destructive";

// Clerk's OTP slots are visual divs; its accessible textbox owns focus. Match
// the shared Input boundary while adapting focus and error states through the
// public attributes that Clerk exposes on each slot.
const CLERK_AUTH_OTP_INPUT_CLASS =
  "border border-[hsl(var(--gray-400))] bg-input shadow-none data-[focus-within=true]:border-primary data-[focus-within=true]:ring-[3px] data-[focus-within=true]:ring-primary/10 aria-invalid:border-destructive data-[focus-within=true]:aria-invalid:border-destructive";

const CLERK_AUTH_APPEARANCE_BASE = {
  theme: "simple",
  options: {
    elevation: "raised",
    socialButtonsPlacement: "top",
    socialButtonsVariant: "blockButton",
  },
  elements: {
    rootBox:
      "mx-auto flex w-full max-w-[var(--okou-auth-card-max-width)] flex-col",
    cardBox: cn(cardClassName, "w-full shadow-none"),
    card: "m-0 w-full rounded-none border-0 bg-card px-[var(--okou-auth-card-padding-inline)] py-[var(--okou-auth-card-padding-block)] shadow-none",
    // Clerk owns the header rhythm; only the wordmark keeps its brand width.
    logoImage: "h-auto w-[76px]",
    // Clerk shares colorPrimary between links and filled controls. Keep the
    // accessible link color at provider level, then give only the CTA the
    // application's semantic filled-action colors.
    formButtonPrimary: CLERK_AUTH_PRIMARY_ACTION_CLASS,
    formFieldInput: CLERK_AUTH_TEXT_INPUT_CLASS,
    otpCodeFieldInput: CLERK_AUTH_OTP_INPUT_CLASS,
  },
} satisfies ClerkAppearance;

/** Keep every hosted auth entry point on one Clerk appearance contract. */
export function getClerkAuthAppearance(
  homeUrl: string,
  theme: "light" | "dark",
): ClerkAppearance {
  return {
    ...CLERK_AUTH_APPEARANCE_BASE,
    options: {
      ...CLERK_AUTH_APPEARANCE_BASE.options,
      logoImageUrl: theme === "dark" ? platformOkouWordmarkLightImg : undefined,
      logoLinkUrl: homeUrl,
    },
  };
}
