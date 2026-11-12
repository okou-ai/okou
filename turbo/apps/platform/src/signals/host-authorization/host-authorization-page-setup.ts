import { command, computed } from "ccstate";
import { createElement } from "react";
import { createHostAuthorizationSignals } from "../chat-page/host-authorization-block.ts";
import { HostAuthorizationCard } from "../../views/okou-page/host-authorization-card.tsx";
import { pathParams$ } from "../route.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { i18n } from "../../i18n/index.ts";
function createHostAuthorizationPageSetup(protocol: "ssh" | "vnc") {
  const pageAuthorization$ = computed((get) => {
    const params = get(pathParams$);
    const id =
      protocol === "ssh"
        ? params?.sshAuthorizationId
        : params?.vncAuthorizationId;
    if (typeof id !== "string") {
      throw new Error("Host authorization ID is missing");
    }
    return createHostAuthorizationSignals(protocol, {
      id,
      originalUrl: `/${protocol}/authorize/${id}`,
    });
  });
  return command(async ({ get, set }, signal: AbortSignal) => {
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
        createElement(HostAuthorizationCard, {
          key: `${protocol}:${signals.id}`,
          signals,
          standalone: true,
        }),
      ),
      "standalone",
    );
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return protocol === "ssh"
          ? $.sshAuthorization.title
          : $.vncAuthorization.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  });
}

export const setupSshAuthorizationPage$ =
  createHostAuthorizationPageSetup("ssh");
export const setupVncAuthorizationPage$ =
  createHostAuthorizationPageSetup("vnc");
