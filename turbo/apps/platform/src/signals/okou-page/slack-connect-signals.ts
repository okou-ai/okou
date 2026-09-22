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
    const result = await accept(
      client.getLinkStatus({ query: { workspaceId, slackUserId } }),
      [200],
    );
    const { linkStatus, workspaceName } = result.body;
    const workspace = workspaceName === undefined ? {} : { workspaceName };
    if (linkStatus.kind === "connected") {
      return { kind: "success", ...workspace };
    }
    if (linkStatus.kind === "connect") {
      return { kind: "connect", ...workspace };
    }
    return { ...linkStatus, ...workspace };
  },
);

export const effectiveError$ = computed((get) => {
  const params = get(searchParams$);
  return params.get("error") ?? "";
});

// Init: handle the URL-driven redirect. The view owns status loading.
export const initSlackConnectPage$ = command(({ get }, signal: AbortSignal) => {
  signal.throwIfAborted();
  const params = get(searchParams$);
  if (params.get("status") === "connected") {
    window.location.href = "slack://open";
  }
});

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

    const requestUserScopes = true;
    const body = {
      workspaceId,
      slackUserId,
      requestUserScopes,
      ...(channelId ? { channelId } : {}),
      ...(threadTs ? { threadTs } : {}),
    } satisfies Parameters<typeof client.connect>[0]["body"];
    const request = { body, fetchOptions: { signal } };
    const result = await accept(
      intent === "switch"
        ? client.switchAccount(request)
        : client.connect(request),
      [202],
    );
    signal.throwIfAborted();

    window.location.href = result.body.authorizationUrl;
  },
);
