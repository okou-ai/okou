import { command } from "ccstate";
import { createElement } from "react";
import { hostContract } from "@okouai/api-contracts/client/host";
import { hostedSiteAccessReasonSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import {
  hostedSiteAccessTitle,
  hostedSiteRecoveryCandidate,
  hostedSiteRecoveryTarget,
} from "../lib/hosted-site-access.ts";
import { accept } from "../lib/accept.ts";
import { HostedSiteAccessPage } from "../views/hosted-site-authorization/hosted-site-access-page.tsx";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { searchParams$ } from "./route.ts";
import { updatePage$ } from "./react-router.ts";
import { apiClient$ } from "./api-client.ts";

const resolveRecoveryTarget$ = command(
  async ({ get }, value: string | null, signal: AbortSignal) => {
    const platform = hostedSiteRecoveryTarget(value);
    if (platform) {
      return platform;
    }
    const candidate = hostedSiteRecoveryCandidate(value);
    if (!candidate) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(hostContract).resolveCustomDomain({
        params: { hostname: candidate.hostname },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    return response.body ? candidate : null;
  },
);

export const setupHostedSiteAccessPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const target = await set(resolveRecoveryTarget$, params.get("url"), signal);
    const parsed = hostedSiteAccessReasonSchema.safeParse(params.get("reason"));
    const reason = parsed.success ? parsed.data : "denied";
    set(updateDocumentTitle$, hostedSiteAccessTitle(reason));
    set(
      updatePage$,
      createElement(HostedSiteAccessPage, {
        target,
        reason,
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
