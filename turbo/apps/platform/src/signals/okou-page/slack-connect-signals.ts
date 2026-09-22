import { command, computed } from "ccstate";
import { searchParams$ } from "../route.ts";
import {
  slackConnectContract,
  type SlackConnectLinkStatus,
} from "@okouai/api-contracts/contracts/slack-connect";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

interface SlackConnectWorkspaceStatus {
  readonly workspaceName?: string | null;
}

export type SlackConnectStatus =
  | ({ readonly kind: "connect" } & SlackConnectWorkspaceStatus)
  | ({ readonly kind: "success" } & SlackConnectWorkspaceStatus)
  | { readonly kind: "status_error"; readonly message: string }
  | (Exclude<
      SlackConnectLinkStatus,
      { readonly kind: "connect" | "connected" }
    > &
      SlackConnectWorkspaceStatus);

export const slackConnectStatus$ = computed(
  async (get): Promise<SlackConnectStatus> => {
    const params = get(searchParams$);
    const workspaceId = params.get("w");
    const slackUserId = params.get("u");
    const initialStatus = params.get("status");
    const initialError = params.get("error");

    if (initialStatus === "connected") {
      return { kind: "success" };
    }

    if (initialError || !workspaceId || !slackUserId) {
      return { kind: "connect" };
    }

    const client = get(apiClient$)(slackConnectContract);
    const [result] = await Promise.allSettled([
      accept(
        client.getLinkStatus({ query: { workspaceId, slackUserId } }),
        [200],
      ),
    ]);
    if (result?.status !== "fulfilled") {
      return {
        kind: "status_error",
        message: result?.reason instanceof Error ? result.reason.message : "",
      };
    }

    const { linkStatus, workspaceName } = result.value.body;
    const workspace = workspaceName === undefined ? {} : { workspaceName };
    if (linkStatus?.kind === "connected") {
      return { kind: "success", ...workspace };
    }
    if (linkStatus?.kind === "connect") {
      return { kind: "connect", ...workspace };
    }
    if (linkStatus) {
      return { ...linkStatus, ...workspace };
    }

    return result.value.body.isConnected
      ? { kind: "success", ...workspace }
      : { kind: "connect", ...workspace };
  },
);

export const effectiveError$ = computed((get) => {
  const params = get(searchParams$);
  return params.get("error") ?? "";
});

// Init: trigger connection status resolution and handle URL-driven redirect.
export const initSlackConnectPage$ = command(
  async ({ get }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const initialStatus = params.get("status");
    await get(slackConnectStatus$);
    signal.throwIfAborted();

    if (initialStatus === "connected") {
      window.location.href = "slack://open";
    }
  },
);

// Connect account
export const connectSlackAccount$ = command(
  async ({ get }, intent: "connect" | "switch", signal: AbortSignal) => {
    const params = get(searchParams$);
    const workspaceId = params.get("w");
    const slackUserId = params.get("u");
    if (!workspaceId || !slackUserId) {
      return;
    }

    const client = get(apiClient$)(slackConnectContract);
    const channelId = params.get("c");
    const threadTs = params.get("t");

    const result = await accept(
      client.connect({
        body: {
          workspaceId,
          slackUserId,
          requestUserScopes: true,
          intent,
          ...(channelId ? { channelId } : {}),
          ...(threadTs ? { threadTs } : {}),
        },
        fetchOptions: { signal },
      }),
      [202],
    );
    signal.throwIfAborted();

    window.location.href = result.body.authorizationUrl;
  },
);
