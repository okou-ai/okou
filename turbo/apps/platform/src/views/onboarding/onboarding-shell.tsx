/**
 * Onboarding uses a softer, larger surface than the rest of the app: a wider
 * radius, the plain border token, and a looser focus ring. Every onboarding
 * `Textarea` opts into it through this one constant so the deviation from the
 * shared field style stays a single deliberate decision.
 */
export const ONBOARDING_TEXTAREA_CLASS =
  "rounded-xl border border-border bg-background focus:ring-2 focus:ring-primary/15";
