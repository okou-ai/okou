import { computed } from "ccstate";
import { resolveOAuthApiBase } from "./api-base.ts";

/**
 * OAuth navigation uses the direct API in preview/development so those
 * environments do not depend on a WWW proxy. Production keeps the canonical
 * WWW route registered with providers.
 */
export const oauthBaseForNavigation$ = computed(() => {
  return resolveOAuthApiBase();
});
