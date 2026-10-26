import { useMediaQuery } from "@okouai/ui";

/** Keep responsive content on the same breakpoint as the onboarding layout. */
export function useMobileOnboarding(): boolean {
  return useMediaQuery("(width < 640px)");
}
