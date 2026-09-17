import { command, computed, state } from "ccstate";
import {
  integrationsGithubContract,
  type GithubInstallationNotFoundResponse,
  type GithubInstallationResponse,
} from "@okouai/api-contracts/contracts/integrations-github";

import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { setAblyLoop$ } from "../realtime.ts";

interface GithubIntegrationMissingData extends GithubInstallationNotFoundResponse {
  readonly isInstalled: false;
  readonly installation: null;
  readonly isConnected: false;
  readonly connectedGithubUserId: null;
  readonly connectedGithubUsername: null;
  readonly connectUrl: string;
}

export type GithubIntegrationData =
  | (GithubInstallationResponse & { readonly isInstalled: true })
  | GithubIntegrationMissingData;

const internalReload$ = state(0);

export const githubIntegrationData$ = computed(
  async (get): Promise<GithubIntegrationData> => {
    get(internalReload$);
    const client = get(apiClient$)(integrationsGithubContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.getInstallation({ headers: {} }),
      [200, 404],
    );

    if (result.status === 404) {
      return {
        ...result.body,
        isInstalled: false,
        installation: null,
        isConnected: false,
        connectedGithubUserId: null,
        connectedGithubUsername: null,
        connectUrl: "https://github.com/login/oauth/authorize",
      };
    }

    return { ...result.body, isInstalled: true };
  },
);

export const reloadGithubIntegration$ = command(({ set }) => {
  set(internalReload$, (previous) => {
    return previous + 1;
  });
});

const refreshGithubIntegrationFromChange$ = command(
  ({ set }, signal: AbortSignal): boolean => {
    signal.throwIfAborted();
    set(reloadGithubIntegration$);
    return false;
  },
);

export const watchGithubIntegration$ = command(
  ({ set }, signal: AbortSignal): void => {
    set(
      setAblyLoop$,
      {
        topic: "github:changed",
        loopCommand$: refreshGithubIntegrationFromChange$,
      },
      signal,
    );
  },
);

function isStandaloneMode(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}

function openGithubOAuthWindow(): Pick<Window, "closed" | "location"> {
  const standalone = isStandaloneMode();
  const popupFeatures = standalone ? undefined : "width=600,height=700";
  const authWindow = window.open("about:blank", "_blank", popupFeatures);

  if (!authWindow && !standalone) {
    throw new Error(
      i18n.t(($) => {
        return $.connectors.providerSettings.errors.githubAuthorizationWindow;
      }),
    );
  }

  if (authWindow) {
    return authWindow;
  }

  return window;
}

export const connectGithubInstallation$ = command(
  (_ctx, connectUrl: string, signal: AbortSignal): void => {
    signal.throwIfAborted();
    const authWindow = openGithubOAuthWindow();
    const fresh = new URL(connectUrl, window.location.origin);
    fresh.searchParams.set("_t", String(now()));
    authWindow.location.href = fresh.toString();
  },
);
