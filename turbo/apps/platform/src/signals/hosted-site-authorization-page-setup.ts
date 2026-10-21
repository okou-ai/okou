import { command } from "ccstate";
import { createElement } from "react";
import { z } from "zod";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import {
  HOSTED_SITE_AUTH_CALLBACK_PATH,
  hostedSiteAuthCodeSchema,
  hostedSiteAuthProofSchema,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import { AuthV1LoadError } from "../views/auth-v1/auth-v1-load-error.tsx";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { updatePage$ } from "./react-router.ts";
import { searchParams$ } from "./route.ts";

const requestSchema = z.object({
  siteId: z.uuid(),
  origin: z.url(),
  codeChallenge: hostedSiteAuthProofSchema,
  state: hostedSiteAuthProofSchema,
});

/** General Clerk credentials stay on the trusted App; only a one-use code leaves it. */
export const setupHostedSiteAuthorizationPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const input = requestSchema.safeParse(
      Object.fromEntries(get(searchParams$)),
    );
    if (!input.success) {
      set(updatePage$, createElement(AuthV1LoadError));
      return;
    }
    const { siteId, ...body } = input.data;
    const response = await accept(
      get(apiClient$)(hostContract).authorizeSiteSession({
        params: { siteId },
        body,
        fetchOptions: { signal },
      }),
      [200, 401, 403],
    );
    signal.throwIfAborted();
    if (response.status !== 200) {
      set(updatePage$, createElement(AuthV1LoadError));
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
      throw new Error("Invalid website authorization callback");
    }
    window.location.replace(callback.href);
  },
);
