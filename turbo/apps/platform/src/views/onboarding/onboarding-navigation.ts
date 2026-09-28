import { useGet, useSet } from "ccstate-react";
import { ROUTES } from "../../signals/route-paths.ts";
import { detachedNavigateTo$, searchParams$ } from "../../signals/route.ts";

const ONBOARDING_STATE_PARAMS = [
  "choice",
  "category",
  "workflow",
  "onboarding_billing",
  "onboarding_billing_session_id",
  "onboarding_note",
  "onboarding_template",
  "redeemCode",
] as const;

export function useOnboardingNavigation(): {
  readonly runPrompt: (prompt: string, template?: string) => void;
} {
  const currentSearchParams = useGet(searchParams$);
  const navigate = useSet(detachedNavigateTo$);

  const runPrompt = (prompt: string, template?: string): void => {
    const searchParams = new URLSearchParams(currentSearchParams);
    for (const key of [...ONBOARDING_STATE_PARAMS, "prompt", "template"]) {
      searchParams.delete(key);
    }
    if (prompt) {
      searchParams.set("prompt", prompt);
    }
    if (template) {
      searchParams.set("template", template);
    }
    navigate(ROUTES.prompt, { searchParams, replace: true });
  };

  return { runPrompt };
}
