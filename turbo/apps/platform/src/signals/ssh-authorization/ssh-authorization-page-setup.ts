import { command, computed } from "ccstate";
import { createElement } from "react";
import { createSshAuthorizationSignals } from "../chat-page/ssh-authorization-block.ts";
import { SshAuthorizationCard } from "../../views/okou-page/ssh-authorization-card.tsx";
import { pathParams$ } from "../route.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { i18n } from "../../i18n/index.ts";
const pageAuthorization$ = computed((get) => {
  const id = get(pathParams$)?.sshAuthorizationId;
  if (typeof id !== "string") {
    throw new Error("SSH authorization ID is missing");
  }
  return createSshAuthorizationSignals({
    id,
    originalUrl: `/ssh/authorize/${id}`,
  });
});
export const setupSshAuthorizationPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const signals = get(pageAuthorization$);
    set(signals.subscribe$, signal);
    set(
      updatePage$,
      createElement(
        "div",
        {
          className:
            "mx-auto flex w-full max-w-xl flex-col p-6 pt-safe-offset-8",
        },
        createElement(SshAuthorizationCard, {
          key: signals.id,
          signals,
          standalone: true,
        }),
      ),
      "standalone",
    );
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.sshAuthorization.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
