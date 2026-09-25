import { useGet, useSet } from "ccstate-react";
import { ROUTES, type RoutePath } from "../../signals/route-paths.ts";
import { detachedNavigateTo$, searchParams$ } from "../../signals/route.ts";

interface NavigateOptions {
  readonly updates?: Readonly<Record<string, string | null | undefined>>;
  readonly remove?: readonly string[];
  readonly preserve?: boolean;
  readonly replace?: boolean;
}

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

function updatedSearchParams(
  current: URLSearchParams,
  options: NavigateOptions,
): URLSearchParams {
  const next =
    options.preserve === false
      ? new URLSearchParams()
      : new URLSearchParams(current);
  for (const key of options.remove ?? []) {
    next.delete(key);
  }
  for (const [key, value] of Object.entries(options.updates ?? {})) {
    if (value === null || value === undefined || value === "") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  return next;
}

export function useOnboardingNavigation(): {
  readonly navigateTo: (path: RoutePath, options?: NavigateOptions) => void;
  readonly runPrompt: (prompt: string, template?: string) => void;
} {
  const currentSearchParams = useGet(searchParams$);
  const navigate = useSet(detachedNavigateTo$);

  const navigateTo = (path: RoutePath, options: NavigateOptions = {}): void => {
    navigate(path, {
      searchParams: updatedSearchParams(currentSearchParams, options),
      ...(options.replace === undefined ? {} : { replace: options.replace }),
    });
  };

  const runPrompt = (prompt: string, template?: string): void => {
    navigateTo(ROUTES.prompt, {
      remove: [...ONBOARDING_STATE_PARAMS, "prompt", "template"],
      updates: {
        prompt,
        template,
      },
      replace: true,
    });
  };

  return { navigateTo, runPrompt };
}
