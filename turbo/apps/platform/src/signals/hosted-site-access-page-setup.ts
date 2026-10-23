import { command } from "ccstate";
import { createElement } from "react";
import { hostedSiteAccessReasonSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import {
  hostedSiteAccessTitle,
  hostedSiteRecoveryTarget,
} from "../lib/hosted-site-access.ts";
import { HostedSiteAccessPage } from "../views/hosted-site-authorization/hosted-site-access-page.tsx";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { searchParams$ } from "./route.ts";
import { updatePage$ } from "./react-router.ts";

export const setupHostedSiteAccessPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const target = hostedSiteRecoveryTarget(params.get("url"));
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
