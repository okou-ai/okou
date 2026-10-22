import { command } from "ccstate";
import { createElement } from "react";
import { hostedSiteAccessReasonSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import { hostedSiteRecoveryTarget } from "../lib/hosted-site-access.ts";
import { i18n } from "../i18n/index.ts";
import { HostedSiteAccessPage } from "../views/hosted-site-authorization/hosted-site-access-page.tsx";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { searchParams$ } from "./route.ts";
import { updatePage$ } from "./react-router.ts";

export const setupHostedSiteAccessPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const target = hostedSiteRecoveryTarget(params.get("url"));
    const reason = hostedSiteAccessReasonSchema.safeParse(params.get("reason"));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.artifacts.access.websiteTitle;
      }),
    );
    set(
      updatePage$,
      createElement(HostedSiteAccessPage, {
        target,
        reason: reason.success ? reason.data : "denied",
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
