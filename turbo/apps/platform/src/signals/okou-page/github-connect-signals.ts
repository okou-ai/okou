import { command, computed, state } from "ccstate";
import { integrationsGithubContract } from "@okouai/api-contracts/client/integrations-github";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { parseGithubConnectParams } from "./github-connect-params.ts";
import { reloadGithubIntegration$ } from "./github.ts";

type GithubConnectLinkStatus =
  | { kind: "ready" }
  | { kind: "already_connected"; githubUsername?: string }
  | { kind: "not_installed" }
  | { kind: "wrong_organization" };

const internalGithubConnectLinkStatusReload$ = state(0);

export const githubConnectLinkStatus$ = computed(
  async (get): Promise<GithubConnectLinkStatus | null> => {
    get(internalGithubConnectLinkStatusReload$);
    const parsed = parseGithubConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }

    const client = get(apiClient$)(integrationsGithubContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.getInstallation({ headers: {} }),
      [200, 404],
    );

    if (result.status === 404) {
      return { kind: "not_installed" };
    }

    if (
      result.body.installation.installationId !== parsed.params.installationId
    ) {
      return { kind: "wrong_organization" };
    }

    if (
      result.body.isConnected &&
      result.body.connectedGithubUserId === parsed.params.githubUserId
    ) {
      return {
        kind: "already_connected",
        ...(result.body.connectedGithubUsername
          ? { githubUsername: result.body.connectedGithubUsername }
          : {}),
      };
    }

    return { kind: "ready" };
  },
);

const reloadGithubConnectLinkStatus$ = command(({ set }) => {
  set(internalGithubConnectLinkStatusReload$, (prev) => {
    return prev + 1;
  });
});

export const connectGithubMentionAccount$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const parsed = parseGithubConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }

    const client = get(apiClient$)(integrationsGithubContract, {
      apiBase: "api",
    });
    await accept(
      client.connectUser({
        headers: {},
        fetchOptions: { signal },
        body: {
          connectSignature: {
            installationId: parsed.params.installationId,
            githubUserId: parsed.params.githubUserId,
            ...(parsed.params.githubUsername
              ? { githubUsername: parsed.params.githubUsername }
              : {}),
            timestamp: parsed.params.timestamp,
            signature: parsed.params.signature,
          },
        },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(reloadGithubIntegration$);
    set(reloadGithubConnectLinkStatus$);

    return {
      githubUsername: parsed.params.githubUsername,
    };
  },
);
