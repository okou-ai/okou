import { command } from "ccstate";

import { requiredAuthContext$ } from "../auth/auth-context";
import { authorization$, cookie$ } from "../context/hono";

/** Provider callbacks may be anonymous, but an authenticated actor must agree. */
export const checkOAuthCallbackActor$ = command(
  async (
    { get, set },
    identity: { readonly userId: string; readonly orgId: string },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const authorization = get(authorization$);
    if (!authorization && !get(cookie$)) {
      return null;
    }
    const auth = await set(
      requiredAuthContext$,
      { requireOrganization: true },
      signal,
    );
    if ("status" in auth) {
      // Unrelated browser cookies do not establish an authenticated actor.
      return auth.status === 401 && !authorization
        ? null
        : auth.body.error.message;
    }
    return auth.userId === identity.userId && auth.orgId === identity.orgId
      ? null
      : "The active account or organization changed. Please reconnect from settings.";
  },
);
