import { command } from "ccstate";
import { object, url, uuid } from "zod";
import { hostContract } from "@okouai/api-contracts/client/host";
import {
  HOSTED_SITE_AUTH_CALLBACK_PATH,
  hostedSiteAuthCodeSchema,
  hostedSiteAuthProofSchema,
  hostedSiteReturnPathSchema,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import {
  hostedSiteRecoveryTarget,
  hostedSiteRecoveryUrl,
} from "../lib/hosted-site-access.ts";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { searchParams$ } from "./route.ts";
import { settle } from "./utils.ts";

const requestSchema = object({
  siteId: uuid(),
  origin: url(),
  codeChallenge: hostedSiteAuthProofSchema,
  state: hostedSiteAuthProofSchema,
  returnTo: hostedSiteReturnPathSchema.optional(),
});

/** General Clerk credentials stay on the trusted App; only a one-use code leaves it. */
export const setupHostedSiteAuthorizationPage$ = command(
  async ({ get }, signal: AbortSignal) => {
    const input = requestSchema.safeParse(
      Object.fromEntries(get(searchParams$)),
    );
    const target =
      input.success && input.data.origin === new URL(input.data.origin).origin
        ? hostedSiteRecoveryTarget(
            new URL(input.data.returnTo ?? "/", input.data.origin).href,
          )
        : null;
    if (!input.success || !target) {
      window.location.replace(hostedSiteRecoveryUrl(null, "denied"));
      return;
    }
    const { siteId, origin, state, codeChallenge } = input.data;
    const body = { origin, state, codeChallenge };
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const result = await settle(
      accept(
        get(apiClient$)(hostContract).authorizeSiteSession({
          params: { siteId },
          body,
          fetchOptions: { signal },
        }),
        [200, 401, 403, 500],
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      window.location.replace(
        hostedSiteRecoveryUrl(target.href, "unavailable"),
      );
      return;
    }
    const response = result.value;
    if (response.status !== 200) {
      window.location.replace(
        hostedSiteRecoveryUrl(
          target.href,
          response.status === 401
            ? "authenticate"
            : response.status === 403
              ? "denied"
              : "unavailable",
        ),
      );
      return;
    }
    const callback = new URL(response.body.callbackUrl);
    if (
      callback.origin !== body.origin ||
      callback.pathname !== HOSTED_SITE_AUTH_CALLBACK_PATH ||
      callback.searchParams.get("state") !== body.state ||
      !hostedSiteAuthCodeSchema.safeParse(callback.searchParams.get("code"))
        .success
    ) {
      window.location.replace(
        hostedSiteRecoveryUrl(target.href, "unavailable"),
      );
      return;
    }
    window.location.replace(callback.href);
  },
);
