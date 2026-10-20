import { command, computed } from "ccstate";
import { createElement } from "react";
import { createDesktopShellAuthorizationSignals } from "../chat-page/desktop-shell-authorization-block.ts";
import { DesktopShellAuthorizationCard } from "../../views/okou-page/desktop-shell-authorization-card.tsx";
import { pathParams$ } from "../route.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { i18n } from "../../i18n/index.ts";

const pageAuthorization$ = computed((get) => {
  const id = get(pathParams$)?.shellAuthorizationId;
  if (typeof id !== "string") {
    throw new Error("Shell authorization ID is missing");
  }
  return createDesktopShellAuthorizationSignals({
    id,
    originalUrl: `/computer-use/shell/authorize/${id}`,
  });
});

export const setupDesktopShellAuthorizationPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const signals = get(pageAuthorization$);
    set(
      updatePage$,
      createElement(
        "div",
        {
          className:
            "mx-auto flex w-full max-w-xl flex-col p-6 pt-safe-offset-8",
        },
        createElement(DesktopShellAuthorizationCard, {
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
        return $.desktopShellAuthorization.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
