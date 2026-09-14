import { feishuPlatform$ } from "./feishu.ts";
import { command } from "ccstate";
import { createElement } from "react";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";

import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { FeishuOAuthCallbackPage } from "../../views/okou-page/feishu-oauth-callback-page.tsx";
import { apiClient$ } from "../api-client.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";

function searchParam(
  searchParams: URLSearchParams,
  name: string,
): string | undefined {
  return searchParams.get(name) ?? undefined;
}

export const setupFeishuOAuthCallbackPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const searchParams = get(searchParams$);
    set(updatePage$, createElement(FeishuOAuthCallbackPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerConnect[get(feishuPlatform$)].connectTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);

    const client = get(apiClient$)(feishuOauthContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.callback({
        query: {
          code: searchParam(searchParams, "code"),
          error: searchParam(searchParams, "error"),
          error_description: searchParam(searchParams, "error_description"),
          responseMode: "json",
          state: searchParam(searchParams, "state"),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    window.location.assign(result.body.redirectUrl);
  },
);
